import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const origin = process.argv[2] || 'http://localhost:8080',
  url = new URL(process.env.DATABASE_URL),
  web = new URL(origin);
const local = (host) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
if (
  !local(url.hostname) ||
  !local(web.hostname) ||
  (process.env.CI !== 'true' && url.pathname !== '/workbench_qa_admin')
)
  throw Error('Feature browser tests require an isolated local QA database (or a CI runner).');
const password = randomBytes(16).toString('base64url');
const env = {
  ...process.env,
  BOOTSTRAP_ADMIN_USERNAME: 'qa-admin',
  BOOTSTRAP_ADMIN_PASSWORD: password,
  ADMIN_CREDENTIALS_FILE: '.local/features-admin-credentials.txt',
  TEST_ADMIN_USERNAME: 'qa-admin',
  TEST_ADMIN_PASSWORD: password,
};
for (const args of [['scripts/bootstrap-admin.mjs'], ['tests/browser-features.mjs', origin]]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
