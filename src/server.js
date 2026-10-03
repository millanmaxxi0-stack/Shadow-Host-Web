import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import AdmZip from 'adm-zip';
import mime from 'mime-types';
import path from 'path';
import { fileURLToPath } from 'url';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { pool } from './db.js';
import { s3, BUCKET } from './storage.js';

const { JWT_SECRET, BASE_DOMAIN, NODE_ENV } = process.env;
if (!JWT_SECRET || !BASE_DOMAIN) { console.error('JWT_SECRET and BASE_DOMAIN are required'); process.exit(1); }

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// ---- Hosted sites (<slug>.BASE_DOMAIN) ----
const cache = new Map();
async function currentDeploy(slug) {
  const hit = cache.get(slug);
  if (hit && hit.exp > Date.now()) return hit.v;
  const { rows } = await pool.query('SELECT current_deployment AS d FROM projects WHERE slug=$1', [slug]);
  const v = rows[0]?.d ?? null;
  cache.set(slug, { v, exp: Date.now() + 15000 });
  return v;
}
async function fetchObj(key) {
  try { return await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key })); } catch { return null; }
}
app.use(wrap(async (req, res, next) => {
  const host = (req.hostname || '').toLowerCase();
  if (!host.endsWith('.' + BASE_DOMAIN)) return next();
  const slug = host.slice(0, -(BASE_DOMAIN.length + 1));
  if (!/^[a-z0-9-]+$/.test(slug) || slug === 'app' || slug === 'www') return next();
  const dep = await currentDeploy(slug);
  if (!dep) return res.status(404).send('Site not found');
  let p = path.posix.normalize('/' + decodeURIComponent(req.path)).replace(/^(\/\.\.)+/, '');
  if (p.endsWith('/')) p += 'index.html';
  const base = `sites/${slug}/${dep}/`;
  let obj = await fetchObj(base + p.replace(/^\//, ''));
  if (!obj && !path.posix.extname(p)) obj = await fetchObj(base + p.replace(/^\//, '') + '/index.html');
  if (!obj) return res.status(404).send('Not found');
  res.type(mime.lookup(p) || 'text/html').set('Cache-Control', 'public, max-age=60');
  obj.Body.pipe(res);
}));

// ---- Dashboard + API ----
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), '../public')));

app.get('/api/health', wrap(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

const sign = (res, u) => res.cookie('token', jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '7d' }), {
  httpOnly: true, sameSite: 'lax', secure: NODE_ENV === 'production', maxAge: 7 * 864e5,
});
const auth = (req, res, next) => {
  try { req.uid = jwt.verify(req.cookies.token, JWT_SECRET).id; next(); }
  catch { res.status(401).json({ error: 'Unauthorized' }); }
};

app.post('/api/auth/register', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 8) return res.status(400).json({ error: 'Valid email and 8+ char password required' });
  try {
    const { rows } = await pool.query('INSERT INTO users(email,password_hash) VALUES($1,$2) RETURNING id', [email.toLowerCase(), await bcrypt.hash(password, 12)]);
    sign(res, rows[0]); res.json({ ok: true });
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'Email already registered' : 'Error' }); }
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [(email || '').toLowerCase()]);
  if (!rows[0] || !(await bcrypt.compare(password || '', rows[0].password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  sign(res, rows[0]); res.json({ ok: true });
}));
app.post('/api/auth/logout', (_req, res) => { res.clearCookie('token'); res.json({ ok: true }); });

app.get('/api/projects', auth, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id,name,slug,current_deployment FROM projects WHERE user_id=$1 ORDER BY id DESC', [req.uid]);
  res.json({ baseDomain: BASE_DOMAIN, projects: rows });
}));
app.post('/api/projects', auth, wrap(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const slug = String(req.body?.slug || '').toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]{1,40}[a-z0-9]$/.test(slug) || ['app', 'www', 'api'].includes(slug)) return res.status(400).json({ error: 'Invalid name or subdomain' });
  try {
    const { rows } = await pool.query('INSERT INTO projects(user_id,name,slug) VALUES($1,$2,$3) RETURNING id,name,slug', [req.uid, name, slug]);
    res.json(rows[0]);
  } catch (e) { res.status(e.code === '23505' ? 409 : 500).json({ error: 'Subdomain taken' }); }
}));

app.post('/api/projects/:id/deploy', auth, upload.single('zip'), wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id,slug FROM projects WHERE id=$1 AND user_id=$2', [req.params.id, req.uid]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'zip file required' });
  const entries = new AdmZip(req.file.buffer).getEntries().filter(e => !e.isDirectory && !e.entryName.includes('__MACOSX'));
  if (!entries.length || entries.length > 2000) return res.status(400).json({ error: 'Zip empty or too many files (max 2000)' });
  const names = entries.map(e => e.entryName.replace(/\\/g, '/'));
  if (names.some(n => n.split('/').includes('..') || n.startsWith('/'))) return res.status(400).json({ error: 'Unsafe paths' });
  const root = names[0].includes('/') ? names[0].split('/')[0] + '/' : '';
  const strip = root && names.every(n => n.startsWith(root)) ? root.length : 0;
  if (!names.some(n => n.slice(strip) === 'index.html')) return res.status(400).json({ error: 'index.html missing at site root' });
  const dep = (await pool.query('INSERT INTO deployments(project_id,file_count) VALUES($1,$2) RETURNING id', [rows[0].id, entries.length])).rows[0].id;
  for (let i = 0; i < entries.length; i += 10) {
    await Promise.all(entries.slice(i, i + 10).map((e, j) => {
      const rel = names[i + j].slice(strip);
      return s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `sites/${rows[0].slug}/${dep}/${rel}`, Body: e.getData(), ContentType: mime.lookup(rel) || 'application/octet-stream' }));
    }));
  }
  await pool.query('UPDATE projects SET current_deployment=$1 WHERE id=$2', [dep, rows[0].id]);
  cache.delete(rows[0].slug);
  res.json({ deployment: dep, url: `https://${rows[0].slug}.${BASE_DOMAIN}` });
}));

app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ error: 'Server error' }); });
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('listening'));
