import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv, promisify } from 'node:util';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
const execAsync = promisify(execFile);
import pg from 'pg';
import assert from 'node:assert/strict';
import { hashPassword } from '../apps/api/dist/crypto.js';
const settings = parseEnv(await readFile(process.argv[2] || '.local/stage6-host.env', 'utf8'));
const url = new URL(settings.DATABASE_URL);
if (url.pathname !== '/workbench_capacity')
  throw new Error('容量脚本仅允许专用 workbench_capacity 数据库');
const origin = settings.APP_ORIGIN || 'http://localhost:18080',
  pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
const report = {
  startedAt: new Date().toISOString(),
  origin,
  accounts: 1000,
  itemsPerAccount: 445,
  concurrency: { normal: 25, burst: 100, rollover: 10 },
  authModel: '1000 seeded sessions; real employee-number registration/password tested separately',
  notes: [
    'Dedicated empty database only',
    '365 days per account; reads include full workspace cache',
    'Offline phase measures server replay; real IndexedDB/offline browser flow tested separately',
  ],
  phases: {},
  resources: [],
  invariants: {},
};
const metrics = new Map(),
  users = [];
let sampler;
const output = 'artifacts/stage6';
await mkdir(output, { recursive: true });
const cpus = JSON.parse(
  execFileSync('docker', ['info', '--format', '{{json .}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }),
);
report.host = {
  os: cpus.OSType,
  architecture: cpus.Architecture,
  cpus: cpus.NCPU,
  memoryBytes: cpus.MemTotal,
};
async function sample() {
  try {
    const { stdout } = await execAsync(
      'docker',
      ['stats', '--no-stream', '--format', '{{json .}}'],
      { encoding: 'utf8', windowsHide: true },
    );
    const rows = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((row) => JSON.parse(row))
      .filter((row) => row.Name?.startsWith('workbench-capacity-stage6-'));
    report.resources.push({ at: new Date().toISOString(), rows });
  } catch {
    /* Resource sampling must not change request results. */
  }
}
async function measure(name, user, path, body, method) {
  const began = performance.now();
  let status = 0,
    result;
  try {
    const response = await fetch(origin + '/api' + path, {
      method: method || (body ? 'POST' : 'GET'),
      headers: {
        Origin: origin,
        Cookie: `workbench_session=${user.token}`,
        'X-Workbench-Account': user.id,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90000),
    });
    status = response.status;
    result = await response.json();
    if (!response.ok) throw new Error(`${name}: HTTP ${status} ${result.error?.code}`);
    return result;
  } finally {
    const list = metrics.get(name) || [];
    list.push({ ms: performance.now() - began, status, at: began, until: performance.now() });
    metrics.set(name, list);
  }
}
async function parallel(concurrency, work) {
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < users.length) {
        const index = next++;
        await work(users[index], index);
      }
    }),
  );
}
try {
  assert.equal(
    (await pool.query('SELECT count(*)::int n FROM users')).rows[0].n,
    0,
    'Refusing to seed an existing database',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL statement_timeout=120000');
    await client.query('CREATE TEMP TABLE seed_users(n int,id uuid)');
    const hash = await hashPassword(randomBytes(32).toString('hex'));
    for (let n = 0; n < 1000; n++) {
      const id = randomUUID(),
        token = randomBytes(32).toString('base64url');
      users.push({ id, token });
      await client.query('INSERT INTO seed_users VALUES ($1,$2)', [n, id]);
    }
    await client.query(
      "INSERT INTO users(id,username,password_hash) SELECT id,'capacity-'||id,$1 FROM seed_users",
      [hash],
    );
    await client.query(
      "INSERT INTO auth_sessions(user_id,token_hash,expires_at) SELECT x.user_id,x.token_hash,now()+interval '1 day' FROM jsonb_to_recordset($1::jsonb) AS x(user_id uuid,token_hash text)",
      [
        JSON.stringify(
          users.map((u) => ({
            user_id: u.id,
            token_hash: createHash('sha256').update(u.token).digest('hex'),
          })),
        ),
      ],
    );
    await client.query(
      'CREATE TEMP TABLE seed_annual AS SELECT id user_id,k,gen_random_uuid() id FROM seed_users CROSS JOIN generate_series(0,3) k',
    );
    await client.query(
      "INSERT INTO annual_goals(id,user_id,title,year,progress,weight) SELECT id,user_id,'容量年度 '||k,extract(year FROM (now() AT TIME ZONE 'Asia/Shanghai'))::int-CASE WHEN k<2 THEN 0 ELSE 1 END,40,25 FROM seed_annual",
    );
    await client.query(
      'CREATE TEMP TABLE seed_monthly AS SELECT id user_id,k,gen_random_uuid() id FROM seed_users CROSS JOIN generate_series(0,23) k',
    );
    await client.query(
      "INSERT INTO monthly_goals(id,user_id,annual_goal_id,title,original_month,current_month,progress,weight) SELECT m.id,m.user_id,a.id,'容量月度 '||m.k,(date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai')-(m.k/2)*interval '1 month')::date,(date_trunc('month',now() AT TIME ZONE 'Asia/Shanghai')-(m.k/2)*interval '1 month')::date,CASE WHEN m.k<=2 THEN 40 ELSE 100 END,50 FROM seed_monthly m JOIN seed_annual a ON a.user_id=m.user_id AND a.k=CASE WHEN m.k<2 THEN m.k ELSE 2+m.k%2 END",
    );
    await client.query(
      'CREATE TEMP TABLE seed_weekly AS SELECT id user_id,k,gen_random_uuid() id FROM seed_users CROSS JOIN generate_series(0,51) k',
    );
    await client.query(
      "INSERT INTO weekly_tasks(id,user_id,monthly_goal_id,title,original_start,original_end,current_start,current_end,status) SELECT w.id,w.user_id,m.id,'容量周任务 '||w.k,date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date-w.k*7,date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date-w.k*7+6,date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date-w.k*7,date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date-w.k*7+6,CASE WHEN w.k<2 THEN 'doing' ELSE 'done' END FROM seed_weekly w JOIN seed_monthly m ON m.user_id=w.user_id AND m.k=least(23,(w.k/4)*2)",
    );
    await client.query(
      "INSERT INTO daily_tasks(user_id,weekly_task_id,title,original_date,scheduled_date,done,completed_at,minutes) SELECT u.id,w.id,'容量日待办 '||day_no,(now() AT TIME ZONE 'Asia/Shanghai')::date-day_no,(now() AT TIME ZONE 'Asia/Shanghai')::date-day_no,day_no>=7,CASE WHEN day_no>=7 THEN now() ELSE NULL END,30 FROM seed_users u CROSS JOIN generate_series(0,364) day_no JOIN seed_weekly w ON w.user_id=u.id AND w.k=least(51,day_no/7)",
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  for (const table of [
    'users',
    'auth_sessions',
    'annual_goals',
    'monthly_goals',
    'weekly_tasks',
    'daily_tasks',
  ])
    await pool.query(`ANALYZE ${table}`);
  const dates = (
    await pool.query(
      "SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text today,date_trunc('week',now() AT TIME ZONE 'Asia/Shanghai')::date::text monday",
    )
  ).rows[0];
  const end = new Date(dates.monday + 'T12:00:00Z');
  end.setUTCDate(end.getUTCDate() + 6);
  const q = new URLSearchParams({
    year: dates.today.slice(0, 4),
    month: dates.today.slice(0, 7),
    start: dates.monday,
    end: end.toISOString().slice(0, 10),
    date: dates.today,
  });
  const targets = await pool.query(
    "SELECT d.user_id,d.id item_id,d.version,d.weekly_task_id FROM daily_tasks d WHERE scheduled_date=(now() AT TIME ZONE 'Asia/Shanghai')::date",
  );
  const map = new Map(targets.rows.map((row) => [row.user_id, row]));
  for (const u of users) {
    Object.assign(u, map.get(u.id));
  }
  report.databaseBefore = (
    await pool.query(
      'SELECT pg_database_size(current_database())::text bytes,(SELECT count(*) FROM daily_tasks)::int daily,(SELECT count(*) FROM users)::int users',
    )
  ).rows[0];
  await sample();
  sampler = setInterval(() => void sample(), 15000);
  console.log('Seeded 1000 accounts and 445000 work items; starting isolated HTTP load.');
  await parallel(25, async (user) => {
    for (const [name, path] of [
      ['workspace', '/data/export'],
      ['overview', '/overview?' + q],
      ['execution', '/annual-execution?year=' + dates.today.slice(0, 4)],
      ['alignment', '/alignment-check?' + q],
    ])
      await measure(name, user, path);
  });
  console.log('Read scenarios completed.');
  await parallel(100, (user) => measure('burst-overview', user, '/overview?' + q));
  await parallel(25, async (user) => {
    for (let n = 0; n < 3; n++) {
      const result = await measure(
        'autosave',
        user,
        '/work-items/daily/' + user.item_id,
        {
          operationId: randomUUID(),
          baseVersion: user.version,
          values: { title: '连续自动保存 ' + n },
        },
        'PATCH',
      );
      user.version = result.item.version;
    }
  });
  await parallel(25, async (user, index) => {
    const id = randomUUID(),
      create = {
        operationId: randomUUID(),
        itemId: id,
        values: {
          title: '离线队列新增',
          date: dates.today,
          parentId: user.weekly_task_id,
          minutes: 30,
        },
      };
    const created = await measure('offline-create', user, '/work-items/daily', create);
    if (index % 10 === 0)
      assert.deepEqual(await measure('offline-replay', user, '/work-items/daily', create), created);
    let version = 1;
    for (let n = 0; n < 3; n++) {
      const body = {
        operationId: randomUUID(),
        baseVersion: version,
        values: { title: '离线队列回放 ' + n },
      };
      const updated = await measure(
        'offline-update',
        user,
        '/work-items/daily/' + id,
        body,
        'PATCH',
      );
      version = updated.item.version;
      if (index % 10 === 0)
        assert.deepEqual(
          await measure('offline-replay', user, '/work-items/daily/' + id, body, 'PATCH'),
          updated,
        );
    }
  });
  console.log('Autosave and ordered offline replay completed.');
  let moved = 0;
  await parallel(10, async (user) => {
    const result = await measure('rollover', user, '/rollover/reconcile', {});
    moved += Object.values(result.changed).reduce((sum, v) => sum + v, 0);
    assert.equal(result.remaining, 0);
  });
  await parallel(10, async (user) => {
    const result = await measure('rollover-repeat', user, '/rollover/reconcile', {});
    assert.ok(Object.values(result.changed).every((v) => v === 0));
  });
  assert.equal(moved, 8000);
  assert.equal((await pool.query('SELECT count(*)::int n FROM daily_tasks')).rows[0].n, 366000);
  assert.equal(
    (
      await pool.query(
        "SELECT count(*)::int n FROM daily_tasks WHERE title='离线队列回放 2' AND version=4",
      )
    ).rows[0].n,
    1000,
  );
  report.invariants = {
    ownerIsolation: 'each request carries its seeded account header and session',
    duplicateCreates: 0,
    queuedRowsAtExpectedVersion: 1000,
    rolloverMoved: moved,
    repeatRolloverChanged: 0,
  };
  report.databaseAfter = (
    await pool.query(
      'SELECT pg_database_size(current_database())::text bytes,(SELECT count(*) FROM period_snapshots)::int snapshots,(SELECT count(*) FROM period_snapshot_items)::int frozenItems,(SELECT count(*) FROM schedule_history)::int history',
    )
  ).rows[0];
  report.success = true;
} catch (error) {
  report.success = false;
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  clearInterval(sampler);
  await sample();
  await pool.end();
  for (const [name, list] of metrics) {
    const sorted = list.map((v) => v.ms).sort((a, b) => a - b),
      p = (f) =>
        Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * f) - 1)] * 100) /
        100;
    report.phases[name] = {
      requests: list.length,
      errors: list.filter((v) => v.status < 200 || v.status >= 300).length,
      elapsedSeconds:
        Math.round(
          (Math.max(...list.map((v) => v.until)) - Math.min(...list.map((v) => v.at))) / 10,
        ) / 100,
      p50Ms: p(0.5),
      p95Ms: p(0.95),
      p99Ms: p(0.99),
      maxMs: p(1),
    };
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(output + '/capacity.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      success: report.success,
      phases: report.phases,
      invariants: report.invariants,
      failure: report.failure,
    }),
  );
}
