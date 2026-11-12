// Real image regression: a private Git checkout must still allow bootstrap
// under a different host UID, without making its credentials public.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { verifyPassword } from '../apps/api/dist/crypto.js';

dotenv.config({ quiet: true });
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
const database = `bootstrap_${randomUUID().replaceAll('-', '')}`;
const directory = await mkdtemp(path.join(tmpdir(), 'four-bootstrap-'));
await chmod(directory, 0o700);
const hostURL = new URL(process.env.DATABASE_URL);
hostURL.pathname = '/' + database;
const containerURL = new URL(hostURL);
containerURL.hostname = 'db';
containerURL.port = '5432';
const username = 'bootstrap-regression';
const env = {
  ...process.env,
  DATABASE_URL: containerURL.href,
  BOOTSTRAP_ADMIN_USERNAME: username,
  ADMIN_CREDENTIALS_FILE: '/admin-credentials/admin.txt',
};
delete env.BOOTSTRAP_ADMIN_PASSWORD;
const compose = (args) => {
  const result = spawnSync('docker', ['compose', 'run', '-T', '--rm', '--no-deps', ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000,
    encoding: 'utf8',
  });
  // Container output contains no credentials, but never forward it on failure.
  assert.equal(result.status, 0, `Container check failed (${result.status}): ${args.at(-1)}`);
};
let client;
let connected = false;
try {
  await admin.connect();
  connected = true;
  await admin.query(`CREATE DATABASE "${database}"`);
  compose(['-e', 'DATABASE_URL', 'api', 'node', 'scripts/migrate.mjs']);
  // Root with cap_drop: ALL must be able to read every imported code file too.
  compose([
    '--user',
    '0:0',
    'api',
    'node',
    '-e',
    "const fs=require('node:fs'); for (const p of ['package.json','apps/api/package.json','packages/contracts/package.json','scripts/bootstrap-admin.mjs','scripts/migrate.mjs','scripts/database-connection.mjs']) fs.accessSync(p,fs.constants.R_OK); require('dotenv'); require('pg'); import('./apps/api/dist/crypto.js'); import('./packages/contracts/dist/index.js');",
  ]);
  assert.notEqual(
    process.getuid(),
    1000,
    'Run this regression under a UID other than image node (1000)',
  );
  const bootstrap = () =>
    compose([
      '--user',
      `${process.getuid()}:${process.getgid()}`,
      '-v',
      `${directory}:/admin-credentials`,
      '-e',
      'DATABASE_URL',
      '-e',
      'BOOTSTRAP_ADMIN_USERNAME',
      '-e',
      'ADMIN_CREDENTIALS_FILE',
      'api',
      'node',
      'scripts/bootstrap-admin.mjs',
    ]);
  bootstrap();
  const file = path.join(directory, 'admin.txt');
  const credentials = await readFile(file, 'utf8');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const password = credentials.match(/^初始密码：(.+)$/m)?.[1];
  assert.ok(password);
  client = new pg.Client({ connectionString: hostURL.href });
  await client.connect();
  const user = (await client.query('SELECT * FROM users WHERE username=$1', [username])).rows[0];
  assert.equal(user.role, 'admin');
  assert.ok(await verifyPassword(password, user.password_hash));
  assert.equal(
    (await client.query("SELECT count(*)::int AS n FROM admin_audit_logs WHERE action='bootstrap'"))
      .rows[0].n,
    1,
  );
  bootstrap();
  assert.ok((await readFile(file, 'utf8')) === credentials, 'Rerun changed initial credentials');
  assert.equal(
    (await client.query('SELECT password_hash FROM users WHERE id=$1', [user.id])).rows[0]
      .password_hash,
    user.password_hash,
  );
  console.log(
    'Container bootstrap passed: restricted source modes, root without capabilities, host UID, private credentials, audit log and safe rerun.',
  );
} finally {
  if (client) await client.end();
  if (connected) await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
