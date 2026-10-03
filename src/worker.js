// Background worker: deletes files of old deployments (keeps latest 3 per project).
import { ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { pool } from './db.js';
import { s3, BUCKET } from './storage.js';

async function clean() {
  const { rows } = await pool.query(`
    SELECT d.id, p.slug FROM deployments d JOIN projects p ON p.id=d.project_id
    WHERE NOT d.cleaned AND d.id <> COALESCE(p.current_deployment,0)
      AND d.id NOT IN (SELECT id FROM deployments x WHERE x.project_id=d.project_id ORDER BY id DESC LIMIT 3)`);
  for (const r of rows) {
    let token;
    do {
      const l = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: `sites/${r.slug}/${r.id}/`, ContinuationToken: token }));
      if (l.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: l.Contents.map(o => ({ Key: o.Key })) } }));
      token = l.NextContinuationToken;
    } while (token);
    await pool.query('UPDATE deployments SET cleaned=true WHERE id=$1', [r.id]);
    console.log('cleaned deployment', r.id);
  }
}
for (;;) {
  try { await clean(); } catch (e) { console.error(e); }
  await new Promise(r => setTimeout(r, 10 * 60 * 1000));
}
