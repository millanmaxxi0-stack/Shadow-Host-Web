import fs from 'fs';
import { pool } from '../src/db.js';
await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY)');
for (const f of fs.readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) {
  const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name=$1', [f]);
  if (rowCount) continue;
  await pool.query(fs.readFileSync(`migrations/${f}`, 'utf8'));
  await pool.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]);
  console.log('migrated', f);
}
await pool.end();
