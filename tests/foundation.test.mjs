import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { migrate } from '../scripts/migrate.mjs';
import { seedReferencePlan } from './fixtures/reference-plan.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { hashPassword } from '../apps/api/dist/crypto.js';
import { normalizeDocument, sampleDocument } from '../packages/contracts/dist/index.js';

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
const origin = 'http://127.0.0.1:5173';
const databaseName = `workbench_test_${Date.now()}_${process.pid}`;
let admin;
let pool;
let app;
let api;
const users = new Map();
const legacy = {
  id: randomUUID(),
  email: `legacy-${randomUUID()}@example.test`,
  password: '123456',
  goalId: randomUUID(),
};

before(
  async () => {
    assert.ok(process.env.DATABASE_URL, 'Integration tests require PostgreSQL DATABASE_URL');
    const adminUrl = new URL(process.env.DATABASE_URL);
    adminUrl.pathname = '/postgres';
    admin = new pg.Pool({ connectionString: adminUrl.toString(), max: 2 });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const testUrl = new URL(process.env.DATABASE_URL);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    process.env.APP_ORIGIN = origin;
    process.env.COOKIE_SECURE = 'false';
    process.env.NODE_ENV = 'test';
    pool = new pg.Pool({ connectionString: testUrl.toString(), max: 4 });
    // Start at the released schema and seed an existing account before upgrading.
    await pool.query(
      'CREATE TABLE schema_migrations (filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const directory = new URL('../database/migrations/', import.meta.url);
    for (const filename of (await readdir(directory)).filter((f) => /^000[1-4]_/.test(f)).sort()) {
      const sql = await readFile(new URL(filename, directory), 'utf8');
      await pool.query(sql);
      await pool.query('INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)', [
        filename,
        createHash('sha256').update(sql).digest('hex'),
      ]);
    }
    await pool.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
      legacy.id,
      legacy.email,
      await hashPassword(legacy.password),
    ]);
    await pool.query(
      "INSERT INTO annual_goals(id,user_id,title,year) VALUES($1,$2,'旧账号保留的目标',2026)",
      [legacy.goalId, legacy.id],
    );
    await migrate(testUrl.toString());
    const { createApp } = await import('../apps/api/dist/bootstrap.js');
    app = await createApp();
    await app.listen(0, '127.0.0.1');
    api = await app.getUrl();
  },
  { timeout: 60000 },
);

after(async () => {
  if (app) await app.close();
  if (pool) await pool.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});

async function request(route, { method = 'GET', body, cookie, requestOrigin = origin } = {}) {
  const response = await fetch(`${api}/api${route}`, {
    method,
    headers: {
      Origin: requestOrigin,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { response, body: await response.json() };
}

async function register(label) {
  const username = `${label}-${randomUUID()}`;
  const password = 'Test-password-123!';
  const result = await request('/auth/register', {
    method: 'POST',
    body: { username, password },
  });
  assert.ok(result.response.ok, `Registration failed: ${result.body.error?.code}`);
  const setCookie = result.response.headers.get('set-cookie');
  assert.ok(setCookie?.includes('HttpOnly'));
  assert.ok(setCookie?.includes('SameSite=Lax'));
  const account = {
    username,
    password,
    cookie: setCookie.split(';')[0],
    id: result.body.user.id,
  };
  users.set(label, account);
  return account;
}

test('database readiness and error envelopes', async () => {
  const health = await request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.database, 'connected');
  const denied = await request('/auth/me');
  assert.equal(denied.response.status, 401);
  assert.equal(denied.body.error.code, 'UNAUTHENTICATED');
  assert.equal(typeof denied.body.error.requestId, 'string');
  const missing = await request('/does-not-exist');
  assert.equal(missing.response.status, 404);
  assert.ok(missing.body.error.requestId);
  const invalid = await request('/auth/login', {
    method: 'POST',
    body: { username: 'invalid', password: 'short', userId: randomUUID() },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
  const malformed = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: origin, 'content-type': 'application/json' },
    body: '{invalid json',
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).error.code, 'VALIDATION_ERROR');
});

test('employee registration, hashed credentials, cookie session and logout', async () => {
  const alice = await register('alice');
  const me = await request('/auth/me', { cookie: alice.cookie });
  assert.equal(me.response.status, 200);
  assert.equal(me.body.user.username, alice.username);
  assert.ok(!('passwordHash' in me.body.user));
  const stored = await pool.query('SELECT password_hash FROM users WHERE id=$1', [alice.id]);
  assert.notEqual(stored.rows[0].password_hash, alice.password);
  const sessions = await pool.query('SELECT token_hash FROM auth_sessions WHERE user_id=$1', [
    alice.id,
  ]);
  assert.notEqual(sessions.rows[0].token_hash, alice.cookie.split('=')[1]);
  const logout = await request('/auth/logout', { method: 'POST', cookie: alice.cookie });
  assert.ok(logout.response.ok);
  assert.equal((await request('/auth/me', { cookie: alice.cookie })).response.status, 401);
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: alice.username, password: alice.password },
  });
  assert.ok(login.response.ok);
  alice.cookie = login.response.headers.get('set-cookie').split(';')[0];
});

test('employee-login migration preserves existing identities, credentials and goals', async () => {
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: legacy.email, password: legacy.password },
  });
  assert.equal(login.response.status, 201);
  assert.equal(login.body.user.id, legacy.id);
  assert.equal(login.body.user.username, legacy.email);
  const goal = await pool.query('SELECT user_id,title FROM annual_goals WHERE id=$1', [
    legacy.goalId,
  ]);
  assert.equal(goal.rows[0].user_id, legacy.id);
  assert.equal(goal.rows[0].title, '旧账号保留的目标');
});

test('account summaries and parent links cannot cross account boundaries', async () => {
  const alice = users.get('alice');
  const bob = await register('bob');
  const goal = await pool.query(
    'INSERT INTO annual_goals(user_id,title,year) VALUES ($1,$2,2026) RETURNING id',
    [alice.id, 'Alice private goal'],
  );
  await pool.query(
    'INSERT INTO annual_goals(user_id,title,year) VALUES ($1,$2,2026),($1,$3,2026)',
    [bob.id, 'Bob private goal A', 'Bob private goal B'],
  );
  const aliceSummary = await request(`/account/summary?userId=${bob.id}`, { cookie: alice.cookie });
  const bobSummary = await request('/account/summary', { cookie: bob.cookie });
  assert.equal(aliceSummary.body.user.id, alice.id);
  assert.equal(aliceSummary.body.counts.annualGoals, 1);
  assert.equal(bobSummary.body.counts.annualGoals, 2);
  await assert.rejects(
    pool.query(
      "INSERT INTO monthly_goals(user_id,annual_goal_id,original_month,current_month) VALUES ($1,$2,'2026-10-01','2026-10-01')",
      [bob.id, goal.rows[0].id],
    ),
    { code: '23503' },
  );
  await pool.query('UPDATE annual_goals SET deleted_at=now() WHERE id=$1', [goal.rows[0].id]);
  assert.equal(
    (await request('/account/summary', { cookie: alice.cookie })).body.counts.annualGoals,
    0,
  );
});

test('version guards, field constraints and operation uniqueness are enforced by PostgreSQL', async () => {
  const alice = users.get('alice');
  const inserted = await pool.query(
    'INSERT INTO annual_goals(user_id,title,year) VALUES ($1,$2,2026) RETURNING id,version',
    [alice.id, 'Concurrency fixture'],
  );
  const record = inserted.rows[0];
  const results = await Promise.all(
    ['device A', 'device B'].map((title) =>
      pool.query(
        'UPDATE annual_goals SET title=$1 WHERE id=$2 AND user_id=$3 AND version=$4 RETURNING version',
        [title, record.id, alice.id, record.version],
      ),
    ),
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.rowCount, 0),
    1,
  );
  assert.equal(results.flatMap((result) => result.rows)[0].version, 2);
  await assert.rejects(
    pool.query('INSERT INTO annual_goals(user_id,year,progress) VALUES ($1,2026,101)', [alice.id]),
    { code: '23514' },
  );
  await assert.rejects(
    pool.query(
      "INSERT INTO weekly_tasks(user_id,original_start,original_end,current_start,current_end) VALUES ($1,'2026-10-22','2026-10-21','2026-10-22','2026-10-21')",
      [alice.id],
    ),
    { code: '23514' },
  );
  const operation = randomUUID();
  await pool.query(
    'INSERT INTO idempotency_keys(user_id,operation_id,request_hash) VALUES ($1,$2,$3)',
    [alice.id, operation, 'fixture-hash'],
  );
  await assert.rejects(
    pool.query(
      'INSERT INTO idempotency_keys(user_id,operation_id,request_hash) VALUES ($1,$2,$3)',
      [alice.id, operation, 'fixture-hash'],
    ),
    { code: '23505' },
  );
});

test('origin checks reject cross-site writes and wrong passwords fail', async () => {
  const alice = users.get('alice');
  const forged = await request('/auth/logout', {
    method: 'POST',
    cookie: alice.cookie,
    requestOrigin: 'https://untrusted.example',
  });
  assert.equal(forged.response.status, 403);
  const wrong = await request('/auth/login', {
    method: 'POST',
    body: { username: alice.username, password: 'Wrong-password-123!' },
  });
  assert.equal(wrong.response.status, 401);
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
});

test('employee registration accepts six-digit passwords and rejects shorter passwords', async () => {
  for (const password of ['', '12345']) {
    const result = await request('/auth/register', {
      method: 'POST',
      body: { username: 'short-' + randomUUID(), password },
    });
    assert.equal(result.response.status, 400);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR');
  }
  const username = '00' + Date.now();
  const registered = await request('/auth/register', {
    method: 'POST',
    body: { username, password: '123456' },
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.body.user.username, username, 'leading zeroes must survive');
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username, password: '123456' },
  });
  assert.equal(login.response.status, 201);
  assert.equal(login.body.user.id, registered.body.user.id);
  assert.equal(
    (await pool.query('SELECT email FROM users WHERE id=$1', [registered.body.user.id])).rows[0]
      .email,
    null,
  );
  for (const invalid of ['', '   ', 'a b', 'x'.repeat(255)]) {
    assert.equal(
      (
        await request('/auth/register', {
          method: 'POST',
          body: { username: invalid, password: '123456' },
        })
      ).response.status,
      400,
    );
  }
});

test('duplicate employee numbers are normalized and concurrent registration is atomic', async () => {
  const username = 'EMP-' + randomUUID();
  const results = await Promise.all(
    [username.toLowerCase(), ' ' + username + ' '].map((name) =>
      request('/auth/register', { method: 'POST', body: { username: name, password: '123456' } }),
    ),
  );
  assert.deepEqual(results.map((r) => r.response.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.response.status === 409).body.error.code, 'USERNAME_IN_USE');
  assert.equal(
    (
      await pool.query('SELECT count(*)::int n FROM users WHERE username=$1', [
        username.toLowerCase(),
      ])
    ).rows[0].n,
    1,
  );
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: ' ' + username + ' ', password: '123456' },
  });
  assert.equal(login.response.status, 201);
});

test('email login, verification-code and unverified password-reset paths are retired', async () => {
  for (const route of ['/auth/code', '/auth/login/otp', '/auth/password/reset']) {
    assert.equal(
      (
        await request(route, {
          method: 'POST',
          body: { email: 'any@example.test', code: '123456', password: '123456' },
        })
      ).response.status,
      404,
    );
  }
  assert.equal(
    (
      await request('/auth/login', {
        method: 'POST',
        body: { email: 'any@example.test', password: '123456' },
      })
    ).response.status,
    400,
  );
});

test('repeated wrong passwords are throttled by employee number and IP', async () => {
  const username = 'unknown-' + randomUUID();
  for (let attempt = 0; attempt < 15; attempt++) {
    assert.equal(
      (await request('/auth/login', { method: 'POST', body: { username, password: '123456' } }))
        .response.status,
      401,
    );
  }
  const limited = await request('/auth/login', {
    method: 'POST',
    body: { username, password: '123456' },
  });
  assert.equal(limited.response.status, 429);
  assert.ok(Number(limited.response.headers.get('retry-after')) > 0);
});

test('database migrations can be run repeatedly without duplicating schema', async () => {
  await migrate(process.env.DATABASE_URL);
  const applied = await pool.query('SELECT count(*)::integer AS count FROM schema_migrations');
  assert.equal(applied.rows[0].count, 5);
});

const chain = {};
async function createItem(
  type,
  values,
  cookie = users.get('alice').cookie,
  operationId = randomUUID(),
) {
  const result = await request(`/work-items/${type}`, {
    method: 'POST',
    cookie,
    body: { operationId, values },
  });
  assert.ok(result.response.ok, `Create ${type}: ${JSON.stringify(result.body)}`);
  return result.body.item;
}
async function updateItem(
  value,
  values,
  cookie = users.get('alice').cookie,
  operationId = randomUUID(),
) {
  const result = await request(`/work-items/${value.type}/${value.id}`, {
    method: 'PATCH',
    cookie,
    body: { operationId, baseVersion: value.version, values },
  });
  assert.ok(result.response.ok, `Update ${value.type}: ${JSON.stringify(result.body)}`);
  return result.body.item;
}

test('stage2: create, edit and complete the full four-level chain with exact business dates', async () => {
  const alice = users.get('alice');
  const login = await request('/auth/login', {
    method: 'POST',
    body: { username: alice.username, password: alice.password },
  });
  alice.cookie = login.response.headers.get('set-cookie').split(';')[0];
  chain.annual = await createItem('annual', {
    year: 2026,
    title: "年度：O'Hara <script> literal",
    note: '年度衡量标准',
    progress: 35,
    weight: 0,
  });
  assert.equal(chain.annual.weight, 0);
  chain.monthly = await createItem('monthly', {
    month: '2026-10',
    title: '十月交付',
    note: '月度交付物',
    parentId: chain.annual.id,
    dueDate: '2026-12-31',
    progress: 60,
    weight: 20,
  });
  chain.weekly = await createItem('weekly', {
    startDate: '2026-10-19',
    endDate: '2026-11-04',
    title: '跨月区间推进',
    parentId: chain.monthly.id,
    priority: 'P0',
    status: 'doing',
  });
  chain.daily = await createItem('daily', {
    date: '2026-10-21',
    title: '今日第一件事',
    parentId: chain.weekly.id,
    minutes: 45,
  });
  assert.equal(chain.monthly.month, '2026-10');
  assert.equal(chain.monthly.dueDate, '2026-12-31');
  assert.equal(chain.weekly.startDate, '2026-10-19');
  assert.equal(chain.daily.date, '2026-10-21');
  chain.daily = await updateItem(chain.daily, { done: true, minutes: 60 });
  assert.equal(chain.daily.done, true);
  assert.ok(chain.daily.completedAt);
  chain.monthly = await updateItem(chain.monthly, {
    note: '已更新交付物',
    progress: 86,
    dueDate: null,
  });
  assert.equal(chain.monthly.progress, 86);
  assert.equal(chain.monthly.dueDate, null);
  assert.equal(chain.weekly.status, 'doing');
  const board = await request(
    '/workbench?year=2026&month=2026-10&start=2026-10-19&end=2026-10-25&date=2026-10-21',
    { cookie: alice.cookie },
  );
  assert.equal(board.response.status, 200);
  assert.equal(board.body.daily.items.find((v) => v.id === chain.daily.id).done, true);
  assert.deepEqual(
    new Set(board.body.daily.ancestors.map((v) => v.id)),
    new Set([chain.weekly.id, chain.monthly.id, chain.annual.id]),
  );
});

test('stage2: period queries use interval overlap, retain out-of-period ancestors and paginate', async () => {
  const cookie = users.get('alice').cookie;
  const overlap = await request('/work-items/weekly?start=2026-10-25&end=2026-11-01', { cookie });
  assert.ok(overlap.body.items.some((v) => v.id === chain.weekly.id));
  const outside = await request('/work-items/weekly?start=2026-11-05&end=2026-11-07', { cookie });
  assert.ok(!outside.body.items.some((v) => v.id === chain.weekly.id));
  const board = await request(
    '/workbench?year=2027&month=2026-11&start=2026-11-01&end=2026-11-07&date=2026-10-21',
    { cookie },
  );
  assert.ok(!board.body.annual.items.some((v) => v.id === chain.annual.id));
  assert.ok(!board.body.monthly.items.some((v) => v.id === chain.monthly.id));
  assert.ok(board.body.daily.ancestors.some((v) => v.id === chain.annual.id));
  const page = await request('/work-items/annual?year=2026&limit=1&offset=0', { cookie });
  const next = await request('/work-items/annual?year=2026&limit=1&offset=1', { cookie });
  assert.equal(page.body.items.length, 1);
  assert.notEqual(page.body.items[0].id, next.body.items[0].id);
  const literal = await request(
    `/work-items/annual?search=${encodeURIComponent("O'Hara <script>")}`,
    { cookie },
  );
  assert.equal(literal.body.items[0].id, chain.annual.id);
});

test('stage2: all resource writes and associations enforce account isolation', async () => {
  const bob = users.get('bob');
  const result = await request(`/work-items/annual/${chain.annual.id}`, {
    method: 'PATCH',
    cookie: bob.cookie,
    body: {
      operationId: randomUUID(),
      baseVersion: chain.annual.version,
      values: { title: 'forged' },
    },
  });
  assert.equal(result.response.status, 404);
  const crossParent = await request('/work-items/monthly', {
    method: 'POST',
    cookie: bob.cookie,
    body: { operationId: randomUUID(), values: { month: '2026-10', parentId: chain.annual.id } },
  });
  assert.equal(crossParent.response.status, 400);
  const bobList = await request('/work-items/annual', { cookie: bob.cookie });
  assert.ok(!bobList.body.items.some((v) => v.id === chain.annual.id));
  const switched = await fetch(`${api}/api/work-items/annual`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Cookie: users.get('alice').cookie,
      'Content-Type': 'application/json',
      'X-Workbench-Account': bob.id,
    },
    body: JSON.stringify({ operationId: randomUUID(), values: { year: 2026 } }),
  });
  assert.equal(switched.status, 403);
  assert.equal((await request('/work-items/daily')).response.status, 401);
});

test('stage2: same-operation retries are idempotent and stale concurrent edits return the current version', async () => {
  const cookie = users.get('alice').cookie;
  const operationId = randomUUID();
  const values = { year: 2026, title: '幂等创建' };
  const first = await createItem('annual', values, cookie, operationId);
  const retry = await createItem('annual', values, cookie, operationId);
  assert.equal(first.id, retry.id);
  const duplicate = await pool.query(
    "SELECT count(*)::int AS n FROM activity_logs WHERE operation_id=$1 AND action='create'",
    [operationId],
  );
  assert.equal(duplicate.rows[0].n, 1);
  const mismatched = await request('/work-items/annual', {
    method: 'POST',
    cookie,
    body: { operationId, values: { ...values, title: 'different' } },
  });
  assert.equal(mismatched.response.status, 409);
  assert.equal(mismatched.body.error.code, 'IDEMPOTENCY_CONFLICT');
  const results = await Promise.all(
    ['页面A修改', '页面B修改'].map((title) =>
      request(`/work-items/annual/${first.id}`, {
        method: 'PATCH',
        cookie,
        body: { operationId: randomUUID(), baseVersion: first.version, values: { title } },
      }),
    ),
  );
  assert.deepEqual(results.map((v) => v.response.status).sort(), [200, 409]);
  const conflict = results.find((v) => v.response.status === 409);
  assert.equal(conflict.body.error.code, 'VERSION_CONFLICT');
  assert.equal(conflict.body.error.details.currentVersion, 2);
  assert.ok(['页面A修改', '页面B修改'].includes(conflict.body.error.details.currentRecord.title));
});

test('stage2: deleting a parent preserves and unlinks children, logs history and supports restore', async () => {
  const cookie = users.get('alice').cookie;
  const operationId = randomUUID();
  const body = { operationId, baseVersion: chain.annual.version };
  const removed = await request(`/work-items/annual/${chain.annual.id}/delete`, {
    method: 'POST',
    cookie,
    body,
  });
  assert.ok(removed.response.ok);
  assert.equal(removed.body.detachedChildren, 1);
  const replay = await request(`/work-items/annual/${chain.annual.id}/delete`, {
    method: 'POST',
    cookie,
    body,
  });
  assert.ok(replay.response.ok);
  const monthly = await request('/work-items/monthly?month=2026-10', { cookie });
  assert.equal(monthly.body.items.find((v) => v.id === chain.monthly.id).parentId, null);
  const daily = await request('/work-items/daily?date=2026-10-21', { cookie });
  assert.equal(daily.body.items.find((v) => v.id === chain.daily.id).parentId, chain.weekly.id);
  const logs = await pool.query(
    "SELECT before_value,after_value FROM activity_logs WHERE item_id=$1 AND action='unlink_deleted_parent'",
    [chain.monthly.id],
  );
  assert.equal(logs.rows[0].before_value.item.parentId, chain.annual.id);
  assert.ok(logs.rows[0].before_value.ancestors.some((v) => v.id === chain.annual.id));
  assert.equal(logs.rows[0].after_value.item.parentId, null);
  const recycled = await request('/work-items/annual?deleted=true', { cookie });
  assert.ok(recycled.body.items.some((v) => v.id === chain.annual.id));
  const restored = await request(`/work-items/annual/${chain.annual.id}/restore`, {
    method: 'POST',
    cookie,
    body: { operationId: randomUUID(), baseVersion: removed.body.item.version },
  });
  assert.ok(restored.response.ok);
  assert.equal(restored.body.item.deletedAt, null);
  const stillUnlinked = await request('/work-items/monthly?month=2026-10', { cookie });
  assert.equal(stillUnlinked.body.items.find((v) => v.id === chain.monthly.id).parentId, null);
});

test('stage2: moving schedule keeps original dates and invalid changes cannot damage saved data', async () => {
  const cookie = users.get('alice').cookie;
  chain.daily = await updateItem(chain.daily, { date: '2026-11-02', done: false });
  assert.equal(chain.daily.originalDate, '2026-10-21');
  assert.equal(chain.daily.date, '2026-11-02');
  assert.equal(chain.daily.completedAt, null);
  const old = await request('/work-items/daily?date=2026-10-21', { cookie });
  assert.ok(!old.body.items.some((v) => v.id === chain.daily.id));
  const current = await request('/work-items/daily?date=2026-11-02', { cookie });
  assert.ok(current.body.items.some((v) => v.id === chain.daily.id));
  for (const values of [
    { date: '2026-02-30' },
    { minutes: -1 },
    { userId: users.get('bob').id },
    { originalDate: '2026-01-01' },
  ]) {
    const result = await request(`/work-items/daily/${chain.daily.id}`, {
      method: 'PATCH',
      cookie,
      body: { operationId: randomUUID(), baseVersion: chain.daily.version, values },
    });
    assert.equal(result.response.status, 400);
  }
  const badRange = await request(`/work-items/weekly/${chain.weekly.id}`, {
    method: 'PATCH',
    cookie,
    body: {
      operationId: randomUUID(),
      baseVersion: chain.weekly.version,
      values: { endDate: '2026-10-01' },
    },
  });
  assert.equal(badRange.response.status, 400);
  const reloaded = await request('/work-items/daily?date=2026-11-02', { cookie });
  assert.equal(
    reloaded.body.items.find((v) => v.id === chain.daily.id).version,
    chain.daily.version,
  );
});

let reference;
const scopeQuery = (selection) =>
  new URLSearchParams(Object.entries(selection).map(([k, v]) => [k, String(v)])).toString();
async function insight(
  route,
  selection = reference.selection,
  cookie = users.get('insights').cookie,
) {
  const result = await request(`${route}?${scopeQuery(selection)}`, { cookie });
  assert.equal(result.response.status, 200, JSON.stringify(result.body));
  return result.body;
}

test('stage3: supplied sample produces 31/66/50, 0/7, 235 minutes and 20 execution records', async () => {
  const account = await register('insights');
  reference = await seedReferencePlan(pool, account.id);
  const data = await insight('/overview');
  assert.deepEqual(
    [data.annual.total, data.monthly.total, data.weekly.total, data.daily.total],
    [4, 6, 7, 7],
  );
  assert.deepEqual(
    [
      data.annual.value,
      data.monthly.value,
      data.weekly.value,
      data.daily.completed,
      data.daily.minutes,
    ],
    [31, 66, 50, 0, 235],
  );
  assert.equal(data.daily.value, 0);
  assert.equal(data.focus.id, reference.daily[0].id);
  assert.equal(data.ancestors.length, 3);
  assert.deepEqual(data.execution, { total: 20, completed: 0 });
  assert.equal(data.annualGroups.length, 4);
  assert.equal(data.monthlyGroups.length, 6);
  assert.deepEqual(data.monthlyGroups.find((g) => g.monthlyId === reference.monthly[0].id).byType, {
    weekly: { total: 1, completed: 0 },
    daily: { total: 1, completed: 0 },
  });
  assert.equal(
    data.annualGroups.reduce((n, g) => n + g.byType.daily.total, 0),
    7,
  );
  const execution = await insight('/annual-execution', { year: 2026 });
  assert.equal(execution.total, 20);
  assert.equal(new Set(execution.items.map((r) => r.item.id)).size, 20);
  assert.ok(execution.items.every((r) => r.item.type !== 'annual'));
});

test('stage3: completing daily work moves focus, increases execution counts and leaves manual progress intact', async () => {
  const cookie = users.get('insights').cookie;
  let first = (await request(`/work-items/daily/${reference.daily[0].id}`, { cookie })).body.item;
  first = await updateItem(first, { done: true }, cookie);
  const changed = await insight('/overview');
  assert.equal(changed.daily.value, 14);
  assert.equal(changed.focus.id, reference.daily[1].id);
  assert.equal(changed.execution.completed, 1);
  assert.equal(
    changed.monthlyGroups.find((g) => g.monthlyId === reference.monthly[0].id).completed,
    1,
  );
  assert.equal(changed.annual.value, 31);
  assert.equal(changed.monthly.value, 66);
  assert.equal(changed.weekly.value, 50);
  const completed = await insight('/annual-execution', {
    year: 2026,
    type: 'daily',
    completion: 'complete',
  });
  assert.equal(completed.total, 1);
  assert.equal(completed.items[0].item.id, first.id);
  assert.equal(completed.items[0].item.originalDate, '2026-10-21');
  await pool.query('UPDATE daily_tasks SET done=true,completed_at=now() WHERE user_id=$1', [
    users.get('insights').id,
  ]);
  const allDone = await insight('/overview');
  assert.equal(allDone.daily.value, 100);
  assert.equal(allDone.focus, null);
  await pool.query('UPDATE daily_tasks SET done=false,completed_at=NULL WHERE user_id=$1', [
    users.get('insights').id,
  ]);
});

test('stage3: empty scopes and all-zero weights are distinct, zero-weight completed items are excluded from weighting', async () => {
  const cookie = users.get('insights').cookie;
  const period = {
    year: 2040,
    month: '2040-06',
    start: '2040-06-04',
    end: '2040-06-10',
    date: '2040-06-06',
  };
  const empty = await insight('/overview', period);
  assert.equal(empty.annual.value, null);
  assert.equal(empty.weekly.value, null);
  assert.equal(empty.daily.value, null);
  await createItem(
    'annual',
    { year: 2040, title: '零权重已完成', progress: 100, weight: 0 },
    cookie,
  );
  await createItem(
    'annual',
    { year: 2040, title: '零权重未完成', progress: 20, weight: 0 },
    cookie,
  );
  await createItem(
    'monthly',
    { month: '2040-06', progress: 100, weight: 0, parentId: null },
    cookie,
  );
  const zero = await insight('/overview', period);
  assert.equal(zero.annual.total, 2);
  assert.equal(zero.annual.completed, 1);
  assert.equal(zero.annual.totalWeight, 0);
  assert.equal(zero.annual.value, null);
  assert.equal(zero.monthly.value, null);
  await createItem('annual', { year: 2040, progress: 25, weight: 2 }, cookie);
  await createItem(
    'monthly',
    { month: '2040-06', progress: 50, weight: 1, parentId: null },
    cookie,
  );
  const positive = await insight('/overview', period);
  assert.equal(positive.annual.value, 25);
  assert.equal(positive.monthly.value, 50);
});

test('stage3: aggregates cover unloaded records, interval intersections count once and execution pages do not overlap', async () => {
  const owner = users.get('insights').id;
  const inserted = await pool.query(
    `INSERT INTO daily_tasks(user_id,weekly_task_id,title,original_date,scheduled_date,minutes)
    SELECT $1,$2,'分页待办 '||n,'2026-10-21','2026-10-21',1 FROM generate_series(1,55) n RETURNING id`,
    [owner, reference.weekly[0].id],
  );
  await pool.query(
    "UPDATE weekly_tasks SET current_start='2026-10-10',current_end='2026-11-10' WHERE id=$1",
    [reference.weekly[0].id],
  );
  const scope = await insight('/overview');
  assert.equal(scope.daily.total, 62);
  assert.equal(scope.daily.minutes, 290);
  assert.equal(scope.weekly.total, 7);
  assert.equal(scope.execution.total, 75);
  const board = await insight('/workbench');
  assert.equal(board.daily.items.length, 50);
  assert.equal(board.daily.total, 62);
  const seen = new Set();
  for (let offset = 0; offset < 75; offset += 13) {
    const page = await insight('/annual-execution', { year: 2026, limit: 13, offset });
    assert.equal(page.total, 75);
    for (const row of page.items) {
      assert.ok(!seen.has(row.item.id));
      seen.add(row.item.id);
    }
  }
  assert.equal(seen.size, 75);
  const filtered = await insight('/annual-execution', {
    year: 2026,
    annualId: reference.annual[0].id,
    type: 'daily',
  });
  assert.equal(filtered.total, 56);
  const crossing = await insight('/overview', {
    ...reference.selection,
    start: '2026-10-25',
    end: '2026-11-01',
  });
  assert.equal(crossing.weekly.total, 7);
  await pool.query('DELETE FROM daily_tasks WHERE user_id=$1 AND id=ANY($2::uuid[])', [
    owner,
    inserted.rows.map((r) => r.id),
  ]);
});

test('stage3: alignment identifies every rule, keeps issue and affected-item counts separate, and repair removes issues', async () => {
  const cookie = users.get('insights').cookie;
  const period = {
    year: 2001,
    month: '2001-03',
    start: '2001-03-05',
    end: '2001-03-11',
    date: '2001-03-07',
  };
  const root = await createItem('annual', { year: 2001, progress: 100 }, cookie);
  await createItem('annual', { year: 2001, title: '没有月目标' }, cookie);
  const month = await createItem(
    'monthly',
    { month: '2001-03', progress: 10, parentId: root.id, dueDate: '2001-03-01' },
    cookie,
  );
  const completeMonth = await createItem(
    'monthly',
    { month: '2001-03', progress: 100, parentId: root.id, dueDate: '2001-03-01' },
    cookie,
  );
  const orphanMonth = await createItem('monthly', { month: '2001-03', parentId: null }, cookie);
  const orphanWeek = await createItem(
    'weekly',
    { startDate: period.start, endDate: period.end, parentId: null },
    cookie,
  );
  await createItem(
    'weekly',
    { startDate: period.start, endDate: period.end, parentId: completeMonth.id },
    cookie,
  );
  const completeWeek = await createItem(
    'weekly',
    { startDate: period.start, endDate: period.end, parentId: month.id, status: 'done' },
    cookie,
  );
  const outsideActionWeek = await createItem(
    'weekly',
    { startDate: period.start, endDate: period.end, parentId: month.id },
    cookie,
  );
  await createItem('daily', { date: '2001-03-01', parentId: outsideActionWeek.id }, cookie);
  await createItem('daily', { date: period.date, parentId: completeWeek.id }, cookie);
  const orphanDay = await createItem('daily', { date: period.date, parentId: null }, cookie);
  const all = await insight('/alignment-check', { ...period, limit: 100 });
  for (const code of [
    'annual_without_monthly',
    'monthly_without_annual',
    'monthly_without_weekly',
    'weekly_without_monthly',
    'weekly_without_daily',
    'daily_without_weekly',
    'parent_complete',
    'overdue',
  ])
    assert.ok(all.counts[code] > 0, code);
  assert.ok(all.overallTotal > all.affectedItems);
  assert.equal(all.total, all.items.length);
  assert.equal(
    all.total,
    Object.values(all.counts).reduce((a, b) => a + b, 0),
  );
  assert.ok(
    !all.items.some(
      (i) => i.code === 'overdue' && [completeMonth.id, completeWeek.id].includes(i.item.id),
    ),
  );
  assert.ok(
    all.items.some((i) => i.code === 'weekly_without_daily' && i.item.id === outsideActionWeek.id),
    'Actions outside interval must not hide missing current actions',
  );
  assert.ok(
    !all.items.some((i) => i.code === 'weekly_without_daily' && i.item.id === completeWeek.id),
  );
  assert.ok(all.items.some((i) => i.code === 'parent_complete' && i.item.id === month.id));
  const filtered = await insight('/alignment-check', {
    ...period,
    rule: 'monthly_without_annual',
    limit: 1,
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].item.id, orphanMonth.id);
  assert.equal(filtered.overallTotal, all.total);
  const pages = [];
  for (let offset = 0; offset < all.total; offset += 3) {
    const page = await insight('/alignment-check', { ...period, limit: 3, offset });
    pages.push(...page.items.map((i) => `${i.code}:${i.item.id}`));
  }
  assert.equal(new Set(pages).size, all.total);
  await updateItem(orphanDay, { parentId: completeWeek.id }, cookie);
  await createItem('daily', { date: period.date, parentId: orphanWeek.id }, cookie);
  const fixed = await insight('/alignment-check', { ...period, limit: 100 });
  assert.equal(fixed.counts.daily_without_weekly, 0);
  assert.ok(
    !fixed.items.some((i) => i.code === 'weekly_without_daily' && i.item.id === orphanWeek.id),
  );
});

test('stage3: annual attribution includes cross-year descendants, deletion unlinks attribution and archived/deleted work is excluded', async () => {
  const cookie = users.get('insights').cookie;
  const month = await createItem(
    'monthly',
    { month: '2027-01', parentId: reference.annual[0].id, progress: 100 },
    cookie,
  );
  const week = await createItem(
    'weekly',
    { startDate: '2027-01-04', endDate: '2027-01-10', parentId: month.id, status: 'done' },
    cookie,
  );
  const day = await createItem(
    'daily',
    { date: '2027-01-05', parentId: week.id, done: true },
    cookie,
  );
  const all = await insight('/annual-execution', { year: 2026, limit: 100 });
  assert.equal(all.total, 23);
  assert.equal(all.items.find((r) => r.item.id === day.id).item.date, '2027-01-05');
  assert.equal(new Set(all.items.map((r) => r.item.id)).size, 23);
  const overview = await insight('/overview');
  assert.equal(overview.monthly.total, 6);
  assert.equal(overview.execution.completed, 3);
  await pool.query('UPDATE daily_tasks SET archived_at=now() WHERE id=$1', [day.id]);
  const archived = await insight('/annual-execution', { year: 2026 });
  assert.equal(archived.total, 22);
  const removed = await request(`/work-items/monthly/${month.id}/delete`, {
    method: 'POST',
    cookie,
    body: { operationId: randomUUID(), baseVersion: month.version },
  });
  assert.equal(removed.response.status, 201);
  assert.equal(removed.body.detachedChildren, 1);
  const after = await insight('/annual-execution', { year: 2026 });
  assert.equal(after.total, 20);
  const saved = await pool.query(
    'SELECT monthly_goal_id,deleted_at FROM weekly_tasks WHERE id=$1',
    [week.id],
  );
  assert.equal(saved.rows[0].monthly_goal_id, null);
  assert.equal(saved.rows[0].deleted_at, null);
});

test('stage3: analytics, detail and filters enforce sessions, owners, schemas and server-side timezone', async () => {
  const bob = users.get('bob');
  for (const route of ['/overview', '/alignment-check']) {
    const denied = await request(`${route}?${scopeQuery(reference.selection)}`);
    assert.equal(denied.response.status, 401);
    const other = await insight(route, reference.selection, bob.cookie);
    if (route === '/overview') {
      assert.equal(other.monthly.total, 0);
      assert.equal(other.daily.total, 0);
      assert.equal(other.execution.total, 0);
    } else assert.ok(!other.items.some((r) => reference.annual.some((a) => a.id === r.item.id)));
  }
  const foreign = await insight(
    '/annual-execution',
    { year: 2026, annualId: reference.annual[0].id },
    bob.cookie,
  );
  assert.equal(foreign.total, 0);
  const detail = await request(`/work-items/daily/${reference.daily[0].id}`, {
    cookie: bob.cookie,
  });
  assert.equal(detail.response.status, 404);
  const ownDetail = await request(`/work-items/daily/${reference.daily[0].id}`, {
    cookie: users.get('insights').cookie,
  });
  assert.equal(ownDetail.response.status, 200);
  assert.equal(ownDetail.body.ancestors.length, 3);
  for (const path of [
    '/annual-execution?year=2026&annualId=invalid',
    '/annual-execution?year=2026&completion=wrong',
    '/annual-execution?year=2026&limit=101',
    `/alignment-check?${scopeQuery(reference.selection)}&rule=unknown`,
    `/overview?${scopeQuery(reference.selection)}&userId=${bob.id}`,
  ])
    assert.equal((await request(path, { cookie: bob.cookie })).response.status, 400, path);
  const stale = await fetch(`${api}/api/overview?${scopeQuery(reference.selection)}`, {
    headers: { Cookie: users.get('insights').cookie, 'X-Workbench-Account': bob.id },
  });
  assert.equal(stale.status, 403);
  const owner = users.get('insights').id;
  for (const timezone of ['Pacific/Kiritimati', 'Etc/GMT+12']) {
    await pool.query('UPDATE users SET timezone=$1 WHERE id=$2', [timezone, owner]);
    const expected = await pool.query(
      "SELECT to_char((CURRENT_TIMESTAMP AT TIME ZONE $1)::date,'YYYY-MM-DD') AS today",
      [timezone],
    );
    const summary = await insight('/overview');
    const check = await insight('/alignment-check');
    assert.equal(summary.asOfDate, expected.rows[0].today);
    assert.equal(check.asOfDate, expected.rows[0].today);
  }
  await pool.query("UPDATE users SET timezone='Asia/Shanghai' WHERE id=$1", [owner]);
});

let rolloverClock;
async function atTime(instant, work) {
  if (!rolloverClock) {
    const { RolloverClock } = await import('../apps/api/dist/rollover-clock.js');
    rolloverClock = app.get(RolloverClock);
  }
  const original = rolloverClock.now;
  rolloverClock.now = () => new Date(instant);
  try {
    return await work();
  } finally {
    rolloverClock.now = original;
  }
}
async function reconcileAccount(account) {
  const r = await request('/rollover/reconcile', {
    method: 'POST',
    cookie: account.cookie,
    body: {},
  });
  assert.ok(r.response.ok, JSON.stringify(r.body));
  return r.body;
}
async function currentItem(value, cookie) {
  const r = await request(`/work-items/${value.type}/${value.id}`, { cookie });
  assert.equal(r.response.status, 200, JSON.stringify(r.body));
  return r.body.item;
}
let rolloverFixture;

test('stage4: concurrent year-boundary reconciliation moves identities once, preserving originals, due date, status and source', async () =>
  atTime('2026-12-31T16:30:00Z', async () => {
    const account = await register('rollover');
    const annual = await createItem('annual', { year: 2026, title: '原年度方向' }, account.cookie);
    const month = await createItem(
      'monthly',
      {
        month: '2026-12',
        title: '跨年项目',
        progress: 35,
        weight: 20,
        dueDate: '2026-12-15',
        parentId: annual.id,
      },
      account.cookie,
    );
    const week = await createItem(
      'weekly',
      {
        startDate: '2026-12-28',
        endDate: '2026-12-31',
        title: '受阻仍承接',
        status: 'block',
        priority: 'P0',
        parentId: month.id,
      },
      account.cookie,
    );
    const day = await createItem(
      'daily',
      { date: '2026-12-31', title: '保留来源的动作', minutes: 45, parentId: week.id },
      account.cookie,
    );
    const done = await createItem(
      'daily',
      { date: '2026-12-31', done: true, title: '已完成不动' },
      account.cookie,
    );
    const archived = await createItem(
      'daily',
      { date: '2026-12-30', title: '归档不动' },
      account.cookie,
    );
    const deleted = await createItem(
      'daily',
      { date: '2026-12-30', title: '已删除不动' },
      account.cookie,
    );
    await pool.query('UPDATE daily_tasks SET archived_at=now() WHERE id=$1', [archived.id]);
    await pool.query('UPDATE daily_tasks SET deleted_at=now() WHERE id=$1', [deleted.id]);
    const responses = await Promise.all(Array.from({ length: 4 }, () => reconcileAccount(account)));
    assert.deepEqual(
      responses.reduce(
        (s, r) => ({
          monthly: s.monthly + r.changed.monthly,
          weekly: s.weekly + r.changed.weekly,
          daily: s.daily + r.changed.daily,
        }),
        { monthly: 0, weekly: 0, daily: 0 },
      ),
      { monthly: 1, weekly: 1, daily: 1 },
    );
    assert.ok(responses.every((r) => r.asOfDate === '2027-01-01'));
    const movedMonth = await currentItem(month, account.cookie),
      movedWeek = await currentItem(week, account.cookie),
      movedDay = await currentItem(day, account.cookie);
    assert.equal(movedMonth.month, '2027-01');
    assert.equal(movedMonth.originalMonth, '2026-12');
    assert.equal(movedMonth.dueDate, '2026-12-15');
    assert.equal(movedMonth.progress, 35);
    assert.equal(movedMonth.parentId, annual.id);
    assert.deepEqual(
      [
        movedWeek.startDate,
        movedWeek.endDate,
        movedWeek.originalEndDate,
        movedWeek.priority,
        movedWeek.status,
      ],
      ['2026-12-28', '2027-01-03', '2026-12-31', 'P0', 'block'],
    );
    assert.deepEqual(
      [movedDay.date, movedDay.originalDate, movedDay.minutes, movedDay.done],
      ['2027-01-01', '2026-12-31', 45, false],
    );
    for (const v of [movedMonth, movedWeek, movedDay]) {
      assert.equal(v.rolloverCount, 1);
      assert.equal(v.version, 2);
    }
    assert.equal((await currentItem(done, account.cookie)).date, '2026-12-31');
    const untouched = await pool.query(
      'SELECT scheduled_date::text,rollover_count FROM daily_tasks WHERE id=ANY($1::uuid[])',
      [[archived.id, deleted.id]],
    );
    assert.ok(
      untouched.rows.every((r) => r.scheduled_date === '2026-12-30' && r.rollover_count === 0),
    );
    const histories = await pool.query(
      "SELECT count(*)::int AS n FROM schedule_history WHERE user_id=$1 AND reason LIKE 'rollover_%'",
      [account.id],
    );
    assert.equal(histories.rows[0].n, 3);
    const dayLog = await pool.query(
      'SELECT snapshot FROM schedule_history WHERE user_id=$1 AND item_id=$2',
      [account.id, day.id],
    );
    assert.equal(
      dayLog.rows[0].snapshot.ancestors[0].endDate,
      '2026-12-31',
      'Daily source week must reflect the state before any level moved',
    );
    assert.equal(dayLog.rows[0].snapshot.ancestors[1].month, '2026-12');
    const stale = await request(`/work-items/daily/${day.id}`, {
      method: 'PATCH',
      cookie: account.cookie,
      body: { operationId: randomUUID(), baseVersion: day.version, values: { title: '旧页面' } },
    });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.body.error.details.currentRecord.date, '2027-01-01');
    rolloverFixture = { account, annual, month: movedMonth, week: movedWeek, day: movedDay };
  }));

test('stage4: sealed cycle retains original title, completion and ancestry after edits, parent deletion and further rollover', async () =>
  atTime('2027-01-01T17:00:00Z', async () => {
    const { account, day, annual } = rolloverFixture;
    const periods = await request('/history/periods?periodType=day&limit=100', {
      cookie: account.cookie,
    });
    assert.equal(periods.response.status, 200);
    const old = periods.body.items.find((p) => p.key === '2026-12-31');
    assert.ok(old);
    assert.equal(old.completed, 1);
    assert.equal(old.total, 2);
    const before = (await request(`/history/periods/${old.id}`, { cookie: account.cookie })).body;
    const frozen = before.items.find((r) => r.item.id === day.id);
    assert.equal(frozen.item.date, '2026-12-31');
    assert.equal(frozen.item.rolloverCount, 0);
    assert.equal(frozen.ancestors.at(-1).title, '原年度方向');
    const result = await reconcileAccount(account);
    assert.equal(result.changed.daily, 1);
    const moved = await currentItem(day, account.cookie);
    assert.equal(moved.rolloverCount, 2);
    assert.equal(moved.originalDate, '2026-12-31');
    assert.equal(moved.date, '2027-01-02');
    rolloverFixture.day = await updateItem(moved, { title: '当前标题已改' }, account.cookie);
    const root = await currentItem(annual, account.cookie);
    const removed = await request(`/work-items/annual/${annual.id}/delete`, {
      method: 'POST',
      cookie: account.cookie,
      body: { operationId: randomUUID(), baseVersion: root.version },
    });
    assert.ok(removed.response.ok);
    const after = (await request(`/history/periods/${old.id}`, { cookie: account.cookie })).body;
    assert.deepEqual(after, before);
    const history = await request(`/history/changes?itemId=${day.id}`, { cookie: account.cookie });
    assert.equal(history.body.total, 2);
    assert.ok(history.body.items.every((r) => r.snapshot.item.originalDate === '2026-12-31'));
  }));

test('stage4: ended custom ranges inside this week and leap-month transitions reconcile correctly', async () =>
  atTime('2028-03-01T02:00:00Z', async () => {
    const account = await register('ranges');
    const month = await createItem(
      'monthly',
      { month: '2028-02', dueDate: '2028-02-29', progress: 44 },
      account.cookie,
    );
    const week = await createItem(
      'weekly',
      {
        startDate: '2028-02-28',
        endDate: '2028-02-29',
        status: 'doing',
        priority: 'P2',
        parentId: month.id,
      },
      account.cookie,
    );
    const day = await createItem(
      'daily',
      { date: '2028-02-29', parentId: week.id },
      account.cookie,
    );
    const result = await reconcileAccount(account);
    assert.deepEqual(result.changed, { monthly: 1, weekly: 1, daily: 1 });
    const w = await currentItem(week, account.cookie);
    assert.equal(w.startDate, '2028-02-28');
    assert.equal(w.endDate, '2028-03-05');
    assert.equal(w.status, 'doing');
    assert.equal(w.priority, 'P2');
    const m = await currentItem(month, account.cookie);
    assert.equal(m.month, '2028-03');
    assert.equal(m.dueDate, '2028-02-29');
    assert.equal(m.progress, 44);
    assert.equal((await currentItem(day, account.cookie)).date, '2028-03-01');
    assert.deepEqual((await reconcileAccount(account)).changed, {
      monthly: 0,
      weekly: 0,
      daily: 0,
    });
    const sealed = await request('/history/periods?periodType=month', { cookie: account.cookie });
    assert.ok(sealed.body.items.some((p) => p.start === '2028-02-01' && p.end === '2028-02-29'));
  }));

test('stage4: carryover decisions are explicit, version guarded, owner scoped and idempotent without copying descendants', async () =>
  atTime('2026-12-31T18:00:00Z', async () => {
    const account = await register('carry');
    const old = await createItem('annual', { year: 2026, title: '旧年度来源' }, account.cookie);
    const fresh = await createItem('annual', { year: 2027, title: '新年度方向' }, account.cookie);
    const keep = await createItem(
      'monthly',
      { month: '2026-12', parentId: old.id, title: '继续旧来源' },
      account.cookie,
    );
    const relink = await createItem(
      'monthly',
      { month: '2026-12', parentId: old.id, title: '显式承接' },
      account.cookie,
    );
    const child = await createItem(
      'weekly',
      { startDate: '2026-12-28', endDate: '2027-01-03', parentId: relink.id },
      account.cookie,
    );
    await reconcileAccount(account);
    const pending = (await request('/rollover/carryovers', { cookie: account.cookie })).body;
    assert.equal(pending.total, 2);
    const k = pending.items.find((r) => r.current.id === keep.id),
      r = pending.items.find((r) => r.current.id === relink.id);
    assert.equal(r.source.ancestors[0].title, '旧年度来源');
    assert.equal(r.current.parentId, old.id);
    const deny = await request(`/rollover/carryovers/${r.id}/resolve`, {
      method: 'POST',
      cookie: users.get('bob').cookie,
      body: { operationId: randomUUID(), baseVersion: r.current.version, choice: 'keep' },
    });
    assert.equal(deny.response.status, 404);
    const invalid = await request(`/rollover/carryovers/${r.id}/resolve`, {
      method: 'POST',
      cookie: account.cookie,
      body: {
        operationId: randomUUID(),
        baseVersion: r.current.version,
        choice: 'relink',
        annualId: old.id,
      },
    });
    assert.equal(invalid.response.status, 400);
    const stale = await request(`/rollover/carryovers/${r.id}/resolve`, {
      method: 'POST',
      cookie: account.cookie,
      body: { operationId: randomUUID(), baseVersion: 1, choice: 'keep' },
    });
    assert.equal(stale.response.status, 409);
    const kept = await request(`/rollover/carryovers/${k.id}/resolve`, {
      method: 'POST',
      cookie: account.cookie,
      body: { operationId: randomUUID(), baseVersion: k.current.version, choice: 'keep' },
    });
    assert.ok(kept.response.ok);
    assert.equal(kept.body.item.parentId, old.id);
    const body = {
      operationId: randomUUID(),
      baseVersion: r.current.version,
      choice: 'relink',
      annualId: fresh.id,
    };
    const moved = await request(`/rollover/carryovers/${r.id}/resolve`, {
      method: 'POST',
      cookie: account.cookie,
      body,
    });
    assert.ok(moved.response.ok);
    const replay = await request(`/rollover/carryovers/${r.id}/resolve`, {
      method: 'POST',
      cookie: account.cookie,
      body,
    });
    assert.deepEqual(replay.body, moved.body);
    const collision = await request(`/rollover/carryovers/${r.id}/resolve`, {
      method: 'POST',
      cookie: account.cookie,
      body: { ...body, choice: 'keep', annualId: undefined },
    });
    assert.equal(collision.response.status, 409);
    assert.equal((await request('/rollover/carryovers', { cookie: account.cookie })).body.total, 0);
    const detail = (await request(`/work-items/weekly/${child.id}`, { cookie: account.cookie }))
      .body;
    assert.equal(detail.ancestors.at(-1).id, fresh.id);
    const count = await pool.query('SELECT count(*)::int AS n FROM weekly_tasks WHERE user_id=$1', [
      account.id,
    ]);
    assert.equal(count.rows[0].n, 1);
    const logs = await pool.query(
      "SELECT count(*)::int AS n FROM activity_logs WHERE user_id=$1 AND action='carryover_relink'",
      [account.id],
    );
    assert.equal(logs.rows[0].n, 1);
  }));

test('stage4: bounded batches preserve all old-period rows and expose paginated frozen items and changes', async () =>
  atTime('2027-04-02T00:00:00Z', async () => {
    const account = await register('batches');
    await reconcileAccount(account);
    assert.equal(
      (await request('/history/periods', { cookie: account.cookie })).body.total,
      0,
      'Empty automatic checks must not seal away later recovered plans',
    );
    await pool.query(
      "INSERT INTO monthly_goals(user_id,title,original_month,current_month,progress) VALUES ($1,'离线前已完成的月目标','2027-01-01','2027-01-01',100)",
      [account.id],
    );
    await pool.query("UPDATE rollover_state SET checked_date='2027-01-03' WHERE user_id=$1", [
      account.id,
    ]);
    await pool.query(
      "INSERT INTO daily_tasks(user_id,title,original_date,scheduled_date) SELECT $1,'批量动作 '||n,'2027-03-31','2027-03-31' FROM generate_series(1,105) n",
      [account.id],
    );
    const first = await reconcileAccount(account);
    assert.equal(first.changed.daily, 100);
    assert.equal(first.remaining, 5);
    const second = await reconcileAccount(account);
    assert.equal(second.changed.daily, 5);
    assert.equal(second.remaining, 0);
    assert.equal((await reconcileAccount(account)).changed.daily, 0);
    const periods = (await request('/history/periods?periodType=day', { cookie: account.cookie }))
      .body;
    const p = periods.items.find((v) => v.key === '2027-03-31');
    assert.equal(p.total, 105);
    const months = (await request('/history/periods?periodType=month', { cookie: account.cookie }))
      .body;
    assert.equal(
      months.items.find((v) => v.key === '2027-01').completed,
      1,
      'Previous checkpoint month must seal even when all its goals are complete',
    );
    const seen = new Set();
    for (let offset = 0; offset < 105; offset += 20) {
      const page = await request(
        `/history/periods/${p.id}?limit=20&offset=${offset}&completion=incomplete`,
        { cookie: account.cookie },
      );
      assert.equal(page.body.total, 105);
      for (const row of page.body.items) {
        assert.ok(!seen.has(row.item.id));
        seen.add(row.item.id);
        assert.equal(row.item.date, '2027-03-31');
        assert.equal(row.item.rolloverCount, 0);
      }
    }
    assert.equal(seen.size, 105);
    const complete = await request(`/history/periods/${p.id}?completion=complete`, {
      cookie: account.cookie,
    });
    assert.equal(complete.body.total, 0);
    const changes = await request('/history/changes?limit=10&offset=100', {
      cookie: account.cookie,
    });
    assert.equal(changes.body.total, 105);
    assert.equal(changes.body.items.length, 5);
  }));

test('stage4: failed transactions roll back movement, counters, history and sealing together', async () =>
  atTime('2027-05-02T00:00:00Z', async () => {
    const account = await register('atomic');
    const value = await createItem('daily', { date: '2027-05-01' }, account.cookie);
    await pool.query(
      `CREATE FUNCTION reject_rollover_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${account.id}'::uuid AND NEW.rollover_count>OLD.rollover_count THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER reject_rollover_fixture BEFORE UPDATE ON daily_tasks FOR EACH ROW EXECUTE FUNCTION reject_rollover_fixture()',
    );
    try {
      const result = await request('/rollover/reconcile', {
        method: 'POST',
        cookie: account.cookie,
        body: {},
      });
      assert.equal(result.response.ok, false);
      assert.equal((await currentItem(value, account.cookie)).date, '2027-05-01');
      for (const table of ['schedule_history', 'period_snapshots', 'rollover_state']) {
        const count = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE user_id=$1`, [
          account.id,
        ]);
        assert.equal(count.rows[0].n, 0, table);
      }
    } finally {
      await pool.query('DROP TRIGGER reject_rollover_fixture ON daily_tasks');
      await pool.query('DROP FUNCTION reject_rollover_fixture()');
    }
    assert.equal((await reconcileAccount(account)).changed.daily, 1);
  }));

test('stage4: server timezone controls dates, scheduled lock contention skips safely and restore compensation reuses the same identity', async () =>
  atTime('2027-06-01T00:30:00Z', async () => {
    const account = await register('zones');
    await pool.query("UPDATE users SET timezone='Etc/GMT+12' WHERE id=$1", [account.id]);
    const value = await createItem('daily', { date: '2027-05-31' }, account.cookie);
    assert.equal((await reconcileAccount(account)).asOfDate, '2027-05-31');
    assert.equal((await currentItem(value, account.cookie)).rolloverCount, 0);
    await pool.query("UPDATE users SET timezone='Pacific/Kiritimati' WHERE id=$1", [account.id]);
    const lock = await pool.connect();
    const { RolloverService } = await import('../apps/api/dist/rollover.service.js');
    try {
      await lock.query('BEGIN');
      await lock.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `work-items:${account.id}`,
      ]);
      const skipped = await app.get(RolloverService).reconcile(account.id, 'scheduled', true);
      assert.equal(skipped.changed.daily, 0);
    } finally {
      await lock.query('ROLLBACK');
      lock.release();
    }
    const scheduled = await app.get(RolloverService).reconcile(account.id, 'scheduled');
    assert.equal(scheduled.asOfDate, '2027-06-01');
    assert.equal(scheduled.changed.daily, 1);
    const old = await createItem('daily', { date: '2027-05-30' }, account.cookie);
    const del = await request(`/work-items/daily/${old.id}/delete`, {
      method: 'POST',
      cookie: account.cookie,
      body: { operationId: randomUUID(), baseVersion: old.version },
    });
    assert.ok(del.response.ok);
    await request(`/work-items/daily/${old.id}/restore`, {
      method: 'POST',
      cookie: account.cookie,
      body: { operationId: randomUUID(), baseVersion: del.body.item.version },
    });
    await reconcileAccount(account);
    const restored = await currentItem(old, account.cookie);
    assert.equal(restored.id, old.id);
    assert.equal(restored.date, '2027-06-01');
    assert.equal(restored.originalDate, '2027-05-30');
    const log = await request(`/history/changes?itemId=${value.id}`, { cookie: account.cookie });
    assert.equal(log.body.items[0].reason, 'rollover_scheduled');
  }));

test('stage4: history sealing is immutable and scoped, manual rescheduling is logged and unsafe time overrides are rejected', async () =>
  atTime('2027-07-03T01:00:00Z', async () => {
    const account = users.get('zones');
    const value = await createItem(
      'daily',
      { date: '2027-07-01', title: '封存时标题' },
      account.cookie,
    );
    const sealed = await request('/history/periods', {
      method: 'POST',
      cookie: account.cookie,
      body: { periodType: 'day', start: '2027-07-01', end: '2027-07-01' },
    });
    assert.ok(sealed.response.ok);
    const changed = await updateItem(
      value,
      { date: '2027-07-04', title: '当前新标题' },
      account.cookie,
    );
    assert.equal(changed.originalDate, '2027-07-01');
    const again = await request('/history/periods', {
      method: 'POST',
      cookie: account.cookie,
      body: { periodType: 'day', start: '2027-07-01', end: '2027-07-01' },
    });
    assert.equal(again.body.id, sealed.body.id);
    const frozen = await request(`/history/periods/${sealed.body.id}`, { cookie: account.cookie });
    assert.equal(frozen.body.items[0].item.title, '封存时标题');
    const manual = await request(`/history/changes?itemId=${value.id}`, { cookie: account.cookie });
    assert.equal(manual.body.items[0].reason, 'manual_edit');
    assert.equal(manual.body.items[0].from.date, '2027-07-01');
    assert.equal(
      (await request(`/history/periods/${sealed.body.id}`, { cookie: users.get('bob').cookie }))
        .response.status,
      404,
    );
    for (const body of [
      { periodType: 'day', start: '2027-07-04', end: '2027-07-04' },
      { periodType: 'month', start: '2027-06-02', end: '2027-06-30' },
      { periodType: 'week', start: '2025-01-01', end: '2026-12-31' },
    ])
      assert.equal(
        (await request('/history/periods', { method: 'POST', cookie: account.cookie, body }))
          .response.status,
        400,
      );
    assert.equal(
      (
        await request('/rollover/reconcile', {
          method: 'POST',
          cookie: account.cookie,
          body: { today: '2099-01-01' },
        })
      ).response.status,
      400,
    );
    assert.equal(
      (await request('/history/periods?limit=101', { cookie: account.cookie })).response.status,
      400,
    );
    assert.equal(
      (await request('/rollover/reconcile', { method: 'POST', body: {} })).response.status,
      401,
    );
    const stale = await fetch(`${api}/api/history/periods`, {
      headers: { Cookie: account.cookie, 'X-Workbench-Account': users.get('bob').id },
    });
    assert.equal(stale.status, 403);
  }));

async function previewData(account, document, mode = 'append') {
  const result = await request('/data/preview', {
    method: 'POST',
    cookie: account.cookie,
    body: { document, mode },
  });
  assert.ok(result.response.ok, JSON.stringify(result.body));
  return result.body;
}
async function commitData(account, preview, operationId = randomUUID()) {
  return request('/data/commit', {
    method: 'POST',
    cookie: account.cookie,
    body: { previewId: preview.id, operationId },
  });
}
test('stage5: real prototype export validates, preserving 4/6/7/7 records, all links and strict field types', async () => {
  const legacy = JSON.parse(
    await readFile(new URL('./fixtures/legacy-v2.json', import.meta.url), 'utf8'),
  );
  const { document, warnings } = normalizeDocument(legacy);
  assert.deepEqual(
    Object.values(document.items).map((rows) => rows.length),
    [4, 6, 7, 7],
  );
  assert.equal(warnings.length, 0);
  const ids = new Set(
    Object.values(document.items)
      .flat()
      .map((v) => v.id),
  );
  for (const row of [...document.items.monthly, ...document.items.weekly, ...document.items.daily])
    assert.ok(ids.has(row.parentId));
  assert.deepEqual(normalizeDocument(document).document.items, document.items);
  for (const mutate of [
    (doc) => {
      doc.items.annual[0].progress = '35';
    },
    (doc) => {
      doc.items.daily[0].done = 'false';
    },
    (doc) => {
      doc.items.daily[0].date = '2026-02-30';
    },
    (doc) => {
      doc.items.daily[0].parentId = doc.items.annual[0].id;
    },
    (doc) => {
      doc.items.daily[0].id = doc.items.annual[0].id;
    },
    (doc) => {
      doc.items.annual[0].userId = randomUUID();
    },
    (doc) => {
      doc.items.weekly[0].endDate = '2026-10-01';
    },
  ]) {
    const copy = structuredClone(document);
    mutate(copy);
    assert.throws(() => normalizeDocument(copy));
  }
  const missing = structuredClone(document);
  missing.items.daily[0].parentId = 'missing-parent';
  const repaired = normalizeDocument(missing);
  assert.equal(repaired.document.items.daily[0].parentId, null);
  assert.equal(repaired.warnings.length, 1);
});
test('stage5: offline client IDs replay once and cannot overwrite an existing identity', async () => {
  const account = await register('offline-id'),
    id = randomUUID(),
    operationId = randomUUID();
  const payload = { itemId: id, operationId, values: { year: 2035, title: '离线新增' } };
  const results = await Promise.all(
    [1, 2].map(() =>
      request('/work-items/annual', { method: 'POST', cookie: account.cookie, body: payload }),
    ),
  );
  for (const r of results) {
    assert.equal(r.response.status, 201);
    assert.equal(r.body.item.id, id);
  }
  assert.deepEqual(results[0].body, results[1].body);
  const collision = await request('/work-items/annual', {
    method: 'POST',
    cookie: account.cookie,
    body: { ...payload, operationId: randomUUID() },
  });
  assert.equal(collision.response.status, 409);
  const child = await createItem('monthly', { month: '2035-01', parentId: id }, account.cookie);
  assert.equal(child.parentId, id);
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM annual_goals WHERE user_id=$1', [account.id]))
      .rows[0].n,
    1,
  );
});
test('stage5: transactional legacy import, v3 roundtrip and sample metrics match the original board', async () =>
  atTime('2026-10-21T03:00:00Z', async () => {
    const account = await register('migration');
    const legacy = JSON.parse(
      await readFile(new URL('./fixtures/legacy-v2.json', import.meta.url), 'utf8'),
    );
    legacy.years[0].note = '迁移'.repeat(5000); // Exercise the dedicated larger JSON parser.
    const preview = await previewData(account, legacy);
    assert.deepEqual(preview.counts, { annual: 4, monthly: 6, weekly: 7, daily: 7 });
    const op = randomUUID(),
      imported = await commitData(account, preview, op);
    assert.ok(imported.response.ok, JSON.stringify(imported.body));
    assert.deepEqual((await commitData(account, preview, op)).body, imported.body);
    assert.equal((await commitData(account, preview)).response.status, 409);
    const exported = await request('/data/export', { cookie: account.cookie });
    assert.equal(exported.body.version, 3);
    assert.deepEqual(
      Object.values(exported.body.items).map((rows) => rows.length),
      [4, 6, 7, 7],
    );
    assert.ok(exported.body.items.annual.every((v) => !legacy.years.some((s) => s.id === v.id)));
    const normalized = normalizeDocument(exported.body);
    assert.equal(normalized.warnings.length, 0);
    const overview = await request(
      '/overview?year=2026&month=2026-10&start=2026-10-19&end=2026-10-25&date=2026-10-21',
      { cookie: account.cookie },
    );
    assert.deepEqual(
      [
        overview.body.annual.value,
        overview.body.monthly.value,
        overview.body.weekly.value,
        overview.body.daily.completed,
        overview.body.daily.total,
      ],
      [31, 66, 50, 0, 7],
    );
    const sample = await request('/data/sample', { cookie: account.cookie });
    assert.deepEqual(
      Object.values(sample.body.items).map((rows) => rows.length),
      [4, 6, 7, 7],
    );
    const bad = structuredClone(exported.body);
    bad.items.daily[0].minutes = -1;
    const before = JSON.stringify(exported.body.items);
    assert.equal(
      (
        await request('/data/preview', {
          method: 'POST',
          cookie: account.cookie,
          body: { document: bad, mode: 'replace' },
        })
      ).response.status,
      400,
    );
    assert.equal(
      JSON.stringify((await request('/data/export', { cookie: account.cookie })).body.items),
      before,
    );
  }));
test('stage5: previews are revision/expiry/owner guarded; clear and backup restore preserve identities and links', async () =>
  atTime('2026-10-21T03:00:00Z', async () => {
    const account = await register('backup'),
      other = users.get('bob');
    const doc = sampleDocument('2026-10-21'),
      preview = await previewData(account, doc);
    assert.equal((await commitData(other, preview)).response.status, 404);
    const prior = await createItem('annual', { year: 2026, title: '变更预览' }, account.cookie);
    assert.equal((await commitData(account, preview)).response.status, 409);
    const expired = await previewData(account, doc);
    await pool.query("UPDATE data_previews SET expires_at=now()-interval '1 second' WHERE id=$1", [
      expired.id,
    ]);
    assert.equal((await commitData(account, expired)).response.status, 409);
    const valid = await previewData(account, doc, 'replace');
    assert.ok((await commitData(account, valid)).response.ok);
    const before = (await request('/data/export', { cookie: account.cookie })).body;
    const state = (await request('/data/state', { cookie: account.cookie })).body;
    const operationId = randomUUID(),
      payload = { operationId, revision: state.revision };
    const clear = await request('/data/clear', {
      method: 'POST',
      cookie: account.cookie,
      body: payload,
    });
    assert.ok(clear.response.ok);
    assert.deepEqual(
      (await request('/data/clear', { method: 'POST', cookie: account.cookie, body: payload }))
        .body,
      clear.body,
    );
    const hidden = (await request('/data/export', { cookie: account.cookie })).body;
    assert.ok(
      Object.values(hidden.items)
        .flat()
        .every((v) => v.deletedAt),
    );
    assert.equal(
      (
        await request('/data/backups/' + clear.body.backupId + '/preview', {
          method: 'POST',
          cookie: other.cookie,
          body: {},
        })
      ).response.status,
      404,
    );
    const restore = await request('/data/backups/' + clear.body.backupId + '/preview', {
      method: 'POST',
      cookie: account.cookie,
      body: {},
    });
    assert.ok(restore.response.ok, JSON.stringify(restore.body));
    assert.ok((await commitData(account, restore.body)).response.ok);
    const after = (await request('/data/export', { cookie: account.cookie })).body;
    for (const type of ['annual', 'monthly', 'weekly', 'daily']) {
      assert.deepEqual(
        after.items[type].map((v) => v.id).sort(),
        before.items[type].map((v) => v.id).sort(),
      );
      for (const row of before.items[type]) {
        const restored = after.items[type].find((v) => v.id === row.id);
        assert.equal(restored.deletedAt, row.deletedAt);
        assert.equal(restored.parentId, row.parentId);
        assert.ok(restored.version > row.version);
      }
    }
    assert.equal(after.items.annual.find((v) => v.id === prior.id).deletedAt !== null, true);
    const backups = await request('/data/backups?limit=20&offset=0', { cookie: account.cookie });
    assert.deepEqual(
      new Set(backups.body.items.map((v) => v.reason)),
      new Set(['clear', 'replace', 'restore']),
    );
    assert.equal(
      (
        await request('/data/clear', {
          method: 'POST',
          cookie: account.cookie,
          body: { operationId: randomUUID(), revision: state.revision },
        })
      ).response.status,
      409,
    );
  }));
test('stage5: failed replacement rolls back new items, old visibility, backup, preview and operation receipt', async () =>
  atTime('2026-10-21T03:00:00Z', async () => {
    const account = await register('import-atomic'),
      prior = await createItem('annual', { year: 2026, title: '必须保留' }, account.cookie);
    const preview = await previewData(account, sampleDocument('2026-10-21'), 'replace'),
      op = randomUUID();
    await pool.query(
      `CREATE FUNCTION reject_import_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${account.id}'::uuid THEN RAISE EXCEPTION 'fixture rejection'; END IF; RETURN NEW; END $$`,
    );
    await pool.query(
      'CREATE TRIGGER reject_import_fixture BEFORE INSERT ON monthly_goals FOR EACH ROW EXECUTE FUNCTION reject_import_fixture()',
    );
    try {
      assert.equal((await commitData(account, preview, op)).response.status, 500);
      assert.equal((await currentItem(prior, account.cookie)).deletedAt, null);
      for (const table of ['data_backups', 'idempotency_keys'])
        assert.equal(
          (
            await pool.query(
              `SELECT count(*)::int n FROM ${table} WHERE user_id=$1${table === 'idempotency_keys' ? ' AND operation_id=$2' : ''}`,
              table === 'idempotency_keys' ? [account.id, op] : [account.id],
            )
          ).rows[0].n,
          0,
        );
      assert.equal(
        (await pool.query('SELECT committed_at FROM data_previews WHERE id=$1', [preview.id]))
          .rows[0].committed_at,
        null,
      );
      assert.equal(
        (
          await pool.query('SELECT count(*)::int n FROM annual_goals WHERE user_id=$1', [
            account.id,
          ])
        ).rows[0].n,
        1,
      );
    } finally {
      await pool.query('DROP TRIGGER reject_import_fixture ON monthly_goals');
      await pool.query('DROP FUNCTION reject_import_fixture()');
    }
    assert.ok((await commitData(account, preview, op)).response.ok);
  }));
test('stage5: imported unfinished past work is reconciled once, retaining original dates and frozen ancestry', async () =>
  atTime('2027-01-02T03:00:00Z', async () => {
    const account = await register('import-rollover'),
      doc = sampleDocument('2026-12-31');
    const preview = await previewData(account, doc);
    assert.equal(preview.pastItems, 13);
    assert.ok((await commitData(account, preview)).response.ok);
    const exported = (await request('/data/export', { cookie: account.cookie })).body;
    assert.ok(
      exported.items.daily.every(
        (v) => v.date === '2027-01-02' && v.originalDate === '2026-12-31' && v.rolloverCount === 1,
      ),
    );
    assert.ok(
      exported.items.monthly.every(
        (v) => v.month === '2027-01' && v.originalMonth === '2026-12' && v.rolloverCount === 1,
      ),
    );
    assert.equal((await reconcileAccount(account)).changed.daily, 0);
    assert.ok(
      (await request('/history/periods?limit=100', { cookie: account.cookie })).body.items.length >
        0,
    );
  }));

test('stage6: cache snapshots and verified sessions expose a stable deployment generation that changes on restore', async () => {
  const account = await register('cache-generation');
  const record = await createItem('annual', { year: 2035, title: '备份内容' }, account.cookie);
  const snapshot = await request('/data/cache', { cookie: account.cookie });
  assert.equal(snapshot.response.status, 200);
  assert.match(snapshot.body.generation, /^[0-9a-f-]{36}$/);
  assert.equal(snapshot.body.document.items.annual[0].id, record.id);
  const me = await request('/auth/me', { cookie: account.cookie });
  assert.equal(me.body.cacheGeneration, snapshot.body.generation);
  await pool.query(
    'UPDATE deployment_state SET cache_generation=gen_random_uuid(),changed_at=now() WHERE singleton',
  );
  const restored = await request('/data/cache', { cookie: account.cookie });
  assert.notEqual(restored.body.generation, snapshot.body.generation);
  assert.deepEqual(restored.body.document.items, snapshot.body.document.items);
  const other = await request('/data/cache', { cookie: users.get('bob').cookie });
  assert.ok(!other.body.document.items.annual.some((v) => v.id === record.id));
  assert.equal((await request('/data/cache')).response.status, 401);
});
