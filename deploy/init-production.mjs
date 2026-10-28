import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve(process.argv[2] || '.env.production');
const template = await readFile(new URL('./production.env.example', import.meta.url), 'utf8');
await writeFile(
  destination,
  template
    .replaceAll('replace-with-random-hex-password', randomBytes(24).toString('hex'))
    .replace('replace-with-at-least-32-random-characters', randomBytes(32).toString('hex')),
  { flag: 'wx', mode: 0o600 },
);
console.log('已生成生产配置；填写域名及 HTTPS 配置后启动。已有文件不会被覆盖。');
