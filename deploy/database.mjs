import { spawn } from 'node:child_process';
import { parseArgs, parseEnv } from 'node:util';
import { readFile, writeFile, rename, access, mkdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
const image =
  'postgres:18-alpine@sha256:d3e1620b530c944afa6e887d22eb899824da68e19c52024bf98f5220c88a65b2';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { env: { type: 'string' }, network: { type: 'string' }, file: { type: 'string' } },
});
const action = positionals[0];
if (!['backup', 'restore'].includes(action) || !values.env || !values.file)
  throw new Error(
    '用法：node deploy/database.mjs backup|restore --env ENV_FILE --file DUMP_FILE [--network COMPOSE_NETWORK]',
  );
const settings = parseEnv(await readFile(resolve(values.env), 'utf8'));
if (!settings.DATABASE_URL) throw new Error('配置缺少 DATABASE_URL');
const path = resolve(values.file),
  network = values.network ? ['--network', values.network] : [];
function run(command, input, output) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '-i',
        ...network,
        '--env',
        'WORKBENCH_DATABASE_URL',
        settings.POSTGRES_IMAGE || image,
        'sh',
        '-c',
        command,
      ],
      {
        env: { ...process.env, WORKBENCH_DATABASE_URL: settings.DATABASE_URL },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    let stderr = '',
      stdout = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const streams = [];
    if (input) streams.push(pipeline(input, child.stdin));
    else child.stdin.end();
    if (output) streams.push(pipeline(child.stdout, output));
    else
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
    for (const stream of streams) void stream.catch(() => undefined);
    child.on('error', reject);
    child.on('close', (code) => {
      void Promise.all(streams).then(() => {
        if (code === 0) resolveRun(stdout);
        else reject(new Error(redact(stderr) || '数据库工具执行失败'));
      }, reject);
    });
  });
}
function redact(message) {
  const password = decodeURIComponent(new URL(settings.DATABASE_URL).password);
  let clean = message.replaceAll(settings.DATABASE_URL, '[database]');
  if (password) clean = clean.replaceAll(password, '[redacted]');
  return clean;
}
async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
if (action === 'backup') {
  await mkdir(dirname(path), { recursive: true });
  if (
    await access(path).then(
      () => true,
      () => false,
    )
  )
    throw new Error('备份目标已存在，拒绝覆盖');
  const partial = path + '.partial';
  await run(
    'exec pg_dump --dbname="$WORKBENCH_DATABASE_URL" --format=custom --no-owner --no-acl',
    undefined,
    createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
  );
  await rename(partial, path);
  await writeFile(path + '.sha256', (await digest(path)) + '\n', { flag: 'wx', mode: 0o600 });
  console.log('数据库备份完成，已生成 SHA-256 校验文件。');
} else {
  const expected = (await readFile(path + '.sha256', 'utf8')).trim();
  if (expected !== (await digest(path))) throw new Error('备份校验不匹配，未执行恢复');
  const count = await run(
    `exec psql --dbname="$WORKBENCH_DATABASE_URL" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'"`,
  );
  if (count.trim() !== '0')
    throw new Error(
      '恢复仅允许写入空数据库。请新建数据库，恢复验证后再切换应用连接；现有数据库未改动。',
    );
  await run(
    'exec pg_restore --dbname="$WORKBENCH_DATABASE_URL" --exit-on-error --single-transaction --no-owner --no-acl',
    createReadStream(path),
  );
  await run(
    'exec psql --dbname="$WORKBENCH_DATABASE_URL" -v ON_ERROR_STOP=1',
    Readable.from(
      "BEGIN; TRUNCATE auth_sessions,auth_codes,auth_rate_limits; DO $$ BEGIN IF to_regclass('public.deployment_state') IS NOT NULL THEN UPDATE deployment_state SET cache_generation=gen_random_uuid(),changed_at=now() WHERE singleton; END IF; END $$; COMMIT;",
    ),
  );
  console.log('已恢复到空数据库，业务数据保留；恢复的登录会话与验证码已撤销，请重新登录。');
}
