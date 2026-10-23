import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import assert from 'node:assert/strict';
import pg from 'pg';
const settings = parseEnv(await readFile(process.argv[2], 'utf8'));
const pool = new pg.Pool({ connectionString: settings.DATABASE_URL, max: 1 });
const result = {};
try {
  for (const table of [
    'users',
    'annual_goals',
    'monthly_goals',
    'weekly_tasks',
    'daily_tasks',
    'period_snapshots',
    'period_snapshot_items',
    'schedule_history',
    'data_backups',
  ]) {
    const order =
      table === 'period_snapshot_items' ? 't.snapshot_id,t.item_type,t.item_id' : 't.id';
    const row = await pool.query(
      `SELECT count(*)::int count,md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY ${order}),'')) fingerprint FROM ${table} t`,
    );
    result[table] = row.rows[0];
  }
  if (process.argv[4])
    assert.deepEqual(
      result,
      JSON.parse(await readFile(process.argv[4], 'utf8')),
      'Business database changed',
    );
  await writeFile(process.argv[3], JSON.stringify(result, null, 2));
  console.log(process.argv[4] ? '完整业务数据及历史指纹一致。' : '已记录业务数据及历史指纹。');
} finally {
  await pool.end();
}
