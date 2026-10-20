import { readdir, readFile } from 'node:fs/promises';
import { pool } from '../src/mysql.js';

export async function migrate() {
  const conn = await pool.getConnection();
  const name = `retail-schema:${process.env.DB_NAME || 'retail'}`.slice(0,64);
  try {
    const [lock] = await conn.query('SELECT GET_LOCK(?, 30) AS ok', [name]);
    if (lock[0].ok !== 1) throw new Error('Schema locked');
    await conn.query('CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(191) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
    for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(x => x.endsWith('.sql')).sort()) {
      const [done] = await conn.query('SELECT version FROM schema_migrations WHERE version=?', [file]);
      if (done.length) continue;
      const sql = await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8');
      // DDL commits implicitly. Never silently continue a partially applied migration.
      for (const statement of sql.split(';').map(x => x.trim()).filter(Boolean)) await conn.query(statement);
      await conn.query('INSERT INTO schema_migrations(version) VALUES(?)', [file]);
      console.log(`Applied ${file}`);
    }
  } finally { await conn.query('SELECT RELEASE_LOCK(?)', [name]); conn.release(); }
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { await migrate(); } finally { await pool.end(); }
}
