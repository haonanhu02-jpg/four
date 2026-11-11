import assert from 'node:assert/strict';
import { randomUUID, createHmac, createHash, pbkdf2Sync } from 'node:crypto';
import { test } from 'node:test';
import dotenv from 'dotenv';
import pg from 'pg';
import { checkConnection, rolePasswordSQL } from '../scripts/database-connection.mjs';
dotenv.config({ quiet: true });

test('repair SQL quotes identifiers and transmits a SCRAM verifier instead of plaintext', () => {
  const password = "kept@:#/secret'123";
  const sql = rolePasswordSQL('quote"role', password);
  assert.ok(sql.startsWith('ALTER ROLE "quote""role"'));
  assert.ok(!sql.includes(password));
  const match = sql.match(/SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):([^']+)/);
  assert.ok(match);
  const salted = pbkdf2Sync(
    password,
    Buffer.from(match[2], 'base64'),
    Number(match[1]),
    32,
    'sha256',
  );
  const client = createHmac('sha256', salted).update('Client Key').digest();
  assert.equal(createHash('sha256').update(client).digest('base64'), match[3]);
  assert.equal(createHmac('sha256', salted).update('Server Key').digest('base64'), match[4]);
});

test('real PostgreSQL accepts repaired credentials without modifying business rows', async () => {
  assert.ok(process.env.DATABASE_URL);
  const role = 'repair_' + randomUUID().replaceAll('-', '');
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await admin.connect();
  const url = new URL(process.env.DATABASE_URL);
  url.username = role;
  url.password = "correct@:#/secret'123";
  try {
    await admin.query(`CREATE ROLE "${role}" LOGIN PASSWORD 'old-password'`);
    const before = await admin.query('SELECT count(*)::int AS count FROM users');
    await assert.rejects(checkConnection(url.toString()), (error) => error.code === '28P01');
    await admin.query(rolePasswordSQL(role, decodeURIComponent(url.password)));
    await checkConnection(url.toString());
    const after = await admin.query('SELECT count(*)::int AS count FROM users');
    assert.deepEqual(after.rows, before.rows);
  } finally {
    await admin.query(`DROP ROLE IF EXISTS "${role}"`);
    await admin.end();
  }
});
