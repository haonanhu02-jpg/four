import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const root = fileURLToPath(new URL('../', import.meta.url));
dotenv.config({ path: path.join(root, '.env'), quiet: true });

export async function migrate(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error('缺少 DATABASE_URL，请先配置 .env');
  const pool = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 10000 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(74621021)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const directory = path.join(root, 'database/migrations');
    const files = (await readdir(directory)).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
    const applied = await client.query('SELECT filename, checksum FROM schema_migrations');
    const existing = new Map(applied.rows.map((r) => [r.filename, r.checksum]));
    const migrations = await Promise.all(
      files.map(async (filename) => {
        const sql = await readFile(path.join(directory, filename), 'utf8');
        const checksum = createHash('sha256').update(sql).digest('hex');
        if (existing.has(filename) && existing.get(filename) !== checksum) {
          throw new Error(`已执行的迁移被修改：${filename}。请新增迁移文件。`);
        }
        return { filename, sql, checksum };
      }),
    );
    for (const migration of migrations) {
      if (existing.has(migration.filename)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations(filename, checksum) VALUES ($1, $2)', [
          migration.filename,
          migration.checksum,
        ]);
        await client.query('COMMIT');
        console.log(`Applied ${migration.filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log(`Database ready (${files.length} migration${files.length === 1 ? '' : 's'}).`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(74621021)').catch(() => {});
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  migrate().catch((error) => {
    console.error('Migration failed:', error instanceof Error ? error.message : '未知错误');
    process.exitCode = 1;
  });
}
