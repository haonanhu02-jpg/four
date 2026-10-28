import { readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import pg from 'pg';
import assert from 'node:assert/strict';
const e = parseEnv(await readFile('.local/stage6-host.env', 'utf8'));
if (new URL(e.DATABASE_URL).pathname !== '/workbench_capacity')
  throw new Error('Isolated capacity database required');
const pool = new pg.Pool({ connectionString: e.DATABASE_URL });
const users = (
  await pool.query("SELECT id FROM users WHERE username LIKE 'capacity-%' ORDER BY id")
).rows;
assert.equal(users.length, 1000);
const samples = { identity: [], cache: [] },
  began = Date.now();
let index = 0;
try {
  for (const user of users) {
    user.token = randomBytes(32).toString('base64url');
    await pool.query(
      "INSERT INTO auth_sessions(user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '1 day')",
      [user.id, createHash('sha256').update(user.token).digest('hex')],
    );
  }
  await Promise.all(
    Array.from({ length: 25 }, async () => {
      while (index < users.length) {
        const user = users[index++];
        let generation;
        for (const [name, path] of [
          ['identity', '/api/auth/me'],
          ['cache', '/api/data/cache'],
        ]) {
          const start = performance.now(),
            response = await fetch(e.APP_ORIGIN + path, {
              headers: {
                Cookie: 'workbench_session=' + user.token,
                'X-Workbench-Account': user.id,
              },
            }),
            data = await response.json();
          assert.ok(response.ok);
          samples[name].push(performance.now() - start);
          if (name === 'identity') {
            assert.equal(data.user.id, user.id);
            generation = data.cacheGeneration;
          } else {
            assert.equal(data.generation, generation);
            assert.equal(data.document.items.daily.length, 366);
          }
        }
      }
    }),
  );
  const results = {
    accounts: 1000,
    concurrency: 25,
    requests: 2000,
    errors: 0,
    elapsedSeconds: (Date.now() - began) / 1000,
    phases: {},
  };
  for (const [name, list] of Object.entries(samples)) {
    list.sort((a, b) => a - b);
    results.phases[name] = {
      p50Ms: list[499],
      p95Ms: list[949],
      p99Ms: list[989],
      maxMs: list[999],
    };
  }
  await writeFile('artifacts/stage6/cache-capacity.json', JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results));
} finally {
  await pool.end();
}
