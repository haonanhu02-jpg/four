import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { execFileSync } from 'node:child_process';
await mkdir('.local', { recursive: true });
const action = process.argv[2],
  file = '.local/stage6-capacity.env';
if (action === 'init') {
  const password = randomBytes(24).toString('hex');
  await writeFile(
    file,
    `COMPOSE_PROJECT_NAME=workbench-capacity-stage6\nPOSTGRES_USER=workbench\nPOSTGRES_PASSWORD=${password}\nPOSTGRES_DB=workbench_capacity\nDATABASE_URL=postgresql://workbench:${password}@db:5432/workbench_capacity\nAUTH_TOKEN_SECRET=${randomBytes(32).toString('hex')}\nAPP_ORIGIN=http://localhost:18080\nCOOKIE_SECURE=false\nWEB_PORT=18080\nTRUST_PROXY_HOPS=1\nSMTP_HOST=mailpit\nSMTP_PORT=1025\nSMTP_SECURE=false\nSMTP_FROM=Workbench <noreply@capacity.test>\nROLLOVER_SCHEDULE_ENABLED=false\n`,
    { flag: 'wx', mode: 0o600 },
  );
  console.log('已生成独立容量环境配置，不覆盖现有配置。');
} else if (action === 'connect') {
  const settings = parseEnv(await readFile(file, 'utf8'));
  const port = (service) =>
    execFileSync(
      'docker',
      [
        'compose',
        '--env-file',
        file,
        '-f',
        'compose.production.yaml',
        '-f',
        'compose.capacity.yaml',
        '--profile',
        'database',
        'port',
        service,
        service === 'db' ? '5432' : '8025',
      ],
      { encoding: 'utf8', windowsHide: true },
    )
      .trim()
      .split(':')
      .at(-1);
  const url = new URL(settings.DATABASE_URL);
  url.hostname = '127.0.0.1';
  url.port = port('db');
  await writeFile(
    '.local/stage6-host.env',
    `DATABASE_URL=${url}\nAPP_ORIGIN=${settings.APP_ORIGIN}\nCOMPOSE_PROJECT_NAME=${settings.COMPOSE_PROJECT_NAME}\nTEST_MAILPIT_URL=http://127.0.0.1:${port('mailpit')}\n`,
    { mode: 0o600 },
  );
  console.log('已连接独立测试库及邮件收件箱，凭据仅保存到忽略目录。');
} else throw new Error('用法：node scripts/prepare-capacity.mjs init|connect');
