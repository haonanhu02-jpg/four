import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile, mkdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import dotenv from 'dotenv';
import pg from 'pg';
import { hashPassword } from '../apps/api/dist/crypto.js';
import { adminUsernameSchema, passwordSchema } from '../packages/contracts/dist/index.js';
dotenv.config({ quiet: true });
const username = adminUsernameSchema.parse(process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin');
const password = passwordSchema.parse(
  process.env.BOOTSTRAP_ADMIN_PASSWORD || randomBytes(12).toString('base64url'),
);
const output = resolve(process.env.ADMIN_CREDENTIALS_FILE || '.local/admin-credentials.txt');
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();
let wrote = false;
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-roster',0))");
  const existing = await client.query(
    "SELECT id FROM users WHERE role='admin' AND disabled_at IS NULL AND deleted_at IS NULL LIMIT 1",
  );
  if (existing.rowCount) {
    await client.query('COMMIT');
    console.log('已有可用管理员，未创建或修改任何账号。');
  } else {
    if ((await client.query('SELECT id FROM users WHERE username=$1', [username])).rowCount)
      throw Error('管理员工号已被占用，请通过 BOOTSTRAP_ADMIN_USERNAME 指定其他工号');
    await mkdir(dirname(output), { recursive: true });
    await writeFile(
      output,
      `管理员工号：${username}\n初始密码：${password}\n登录后可在账号管理中重置密码。\n`,
      { flag: 'wx', mode: 0o600 },
    );
    wrote = true;
    const user = (
      await client.query(
        "INSERT INTO users(username,password_hash,role) VALUES($1,$2,'admin') RETURNING *",
        [username, await hashPassword(password)],
      )
    ).rows[0];
    const state = {
      id: user.id,
      username: user.username,
      role: user.role,
      disabledAt: null,
      deletedAt: null,
      createdAt: user.created_at.toISOString(),
      updatedAt: user.updated_at.toISOString(),
    };
    await client.query(
      "INSERT INTO admin_audit_logs(actor_id,actor_username,target_id,target_username,action,after_state,request_id,ip) VALUES($1,$2,$1,$2,'bootstrap',$3,$4,'local-cli')",
      [user.id, username, state, randomUUID()],
    );
    await client.query('COMMIT');
    wrote = false;
    console.log('管理员已创建；凭据仅保存到 ' + output + '，未输出密码。');
  }
} catch (error) {
  await client.query('ROLLBACK');
  if (wrote) await unlink(output);
  console.error(error instanceof Error ? error.message : '管理员创建失败');
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
