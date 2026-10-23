import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const example = new URL('../.env.example', import.meta.url);
const destination = new URL('../.env', import.meta.url);
const databasePassword = randomBytes(24).toString('hex');
const tokenSecret = randomBytes(32).toString('hex');

try {
  const template = await readFile(example, 'utf8');
  const contents = template
    .replaceAll('local-development-only', databasePassword)
    .replace(/^AUTH_TOKEN_SECRET=.*$/m, `AUTH_TOKEN_SECRET=${tokenSecret}`);
  await writeFile(destination, contents, { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env 和随机开发密钥；已有文件不会被覆盖。');
} catch (error) {
  if (error?.code === 'EEXIST') {
    console.error('.env 已存在，未作修改。请保留现有配置，或另行备份后再初始化。');
  } else {
    console.error('生成 .env 失败：', error instanceof Error ? error.message : '未知错误');
  }
  process.exitCode = 1;
}
