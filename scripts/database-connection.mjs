import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function rolePasswordSQL(username, password) {
  // Generated deployment secrets are printable ASCII. Do not silently change
  // an existing password that would require additional SASLprep handling.
  if (!/^[\x21-\x7e]+$/.test(password)) throw Error('unsupported password format');
  const salt = randomBytes(16),
    iterations = 4096;
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  const verifier = `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${stored}:${server}`;
  return `ALTER ROLE "${username.replaceAll('"', '""')}" WITH PASSWORD '${verifier}';\n`;
}

export async function checkConnection(connectionString) {
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const connection = process.env.DATABASE_URL;
    if (!connection) throw Error('missing connection');
    if (process.argv[2] === 'check') {
      await checkConnection(connection);
      console.log('数据库 TCP 凭据校验通过。');
    } else if (process.argv[2] === 'repair-sql') {
      const url = new URL(connection);
      process.stdout.write(
        rolePasswordSQL(decodeURIComponent(url.username), decodeURIComponent(url.password)),
      );
    } else throw Error('unknown command');
  } catch (error) {
    console.error(`数据库连接检查失败：${error.code || 'CONFIG_ERROR'}（未输出连接串或密码）。`);
    process.exitCode = error.code === '28P01' ? 28 : 1;
  }
}
