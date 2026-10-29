import { Inject, Injectable } from '@nestjs/common';
import type {
  ManagedAccount,
  ManagedAccounts,
  AdminAuditList,
  adminCreateSchema,
  adminUpdateSchema,
  adminListSchema,
  adminLogSchema,
} from '@workbench/contracts';
import type { z } from 'zod';
import type { PoolClient } from 'pg';
import { DatabaseService } from './database.service';
import { hashPassword } from './crypto';
import { ApiException } from './http';
interface AccountRow {
  id: string;
  username: string;
  role: 'user' | 'admin';
  disabled_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
const account = (r: AccountRow): ManagedAccount => ({
  id: r.id,
  username: r.username,
  role: r.role,
  disabledAt: r.disabled_at?.toISOString() ?? null,
  deletedAt: r.deleted_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
});
export interface AdminActor {
  id: string;
  requestId: string;
  ip: string;
}
@Injectable()
export class AdminService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}
  private async actor(client: PoolClient, actor: AdminActor) {
    const r = await client.query<AccountRow>(
      "SELECT * FROM users WHERE id=$1 AND role='admin' AND disabled_at IS NULL AND deleted_at IS NULL",
      [actor.id],
    );
    if (!r.rows[0]) throw new ApiException('FORBIDDEN', '仅管理员可以管理账号', 403);
    return r.rows[0];
  }
  private async log(
    client: PoolClient,
    actor: AdminActor,
    who: AccountRow,
    before: ManagedAccount | null,
    after: ManagedAccount,
    action: string,
  ) {
    await client.query(
      `INSERT INTO admin_audit_logs(actor_id,actor_username,target_id,target_username,action,before_state,after_state,request_id,ip) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        actor.id,
        who.username,
        after.id,
        after.username,
        action,
        before,
        after,
        actor.requestId,
        actor.ip,
      ],
    );
  }
  list(actor: AdminActor, q: z.infer<typeof adminListSchema>): Promise<ManagedAccounts> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await this.actor(client, actor);
      const where = `strpos(lower(username),lower($1))>0 AND CASE $2 WHEN 'active' THEN disabled_at IS NULL AND deleted_at IS NULL WHEN 'disabled' THEN disabled_at IS NOT NULL AND deleted_at IS NULL WHEN 'deleted' THEN deleted_at IS NOT NULL ELSE deleted_at IS NULL END`;
      const args = [q.search, q.status],
        total = await client.query(`SELECT count(*)::int n FROM users WHERE ${where}`, args);
      const rows = await client.query<AccountRow>(
        `SELECT * FROM users WHERE ${where} ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,
        [...args, q.limit, q.offset],
      );
      return {
        items: rows.rows.map(account),
        total: total.rows[0].n,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }
  async create(
    actor: AdminActor,
    input: z.infer<typeof adminCreateSchema>,
  ): Promise<ManagedAccount> {
    const hash = await hashPassword(input.password);
    return this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-roster',0))");
      const who = await this.actor(client, actor);
      const r = await client.query<AccountRow>(
        'INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING *',
        [input.username, hash, input.role],
      );
      if (!r.rows[0]) throw new ApiException('USERNAME_IN_USE', '这个工号已存在', 409);
      const result = account(r.rows[0]);
      await this.log(client, actor, who, null, result, 'create');
      return result;
    });
  }
  async change(
    actor: AdminActor,
    id: string,
    action: 'update' | 'reset_password' | 'disable' | 'enable' | 'delete' | 'restore',
    input: z.infer<typeof adminUpdateSchema> & { password?: string } = {},
  ): Promise<ManagedAccount> {
    const hash = input.password ? await hashPassword(input.password) : undefined;
    return this.db.withTransaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('admin-roster',0))");
      const who = await this.actor(client, actor);
      const r = await client.query<AccountRow>('SELECT * FROM users WHERE id=$1 FOR UPDATE', [id]),
        row = r.rows[0];
      if (!row) throw new ApiException('NOT_FOUND', '账号不存在', 404);
      if (row.deleted_at && action !== 'restore')
        throw new ApiException('VERSION_CONFLICT', '账号已删除，请先恢复', 409);
      const losesAdmin =
        action === 'disable' ||
        action === 'delete' ||
        (action === 'update' && input.role === 'user');
      if (row.role === 'admin' && !row.disabled_at && !row.deleted_at && losesAdmin) {
        const other = await client.query(
          "SELECT id FROM users WHERE id<>$1 AND role='admin' AND disabled_at IS NULL AND deleted_at IS NULL LIMIT 1",
          [id],
        );
        if (!other.rowCount)
          throw new ApiException('VERSION_CONFLICT', '至少需要保留一个可用管理员', 409);
      }
      if (action === 'update' && input.username && input.username !== row.username) {
        const exists = await client.query('SELECT id FROM users WHERE username=$1 AND id<>$2', [
          input.username,
          id,
        ]);
        if (exists.rowCount) throw new ApiException('USERNAME_IN_USE', '这个工号已存在', 409);
      }
      const sets = ['updated_at=now()'],
        args: unknown[] = [id];
      const set = (key: string, value: unknown) => {
        args.push(value);
        sets.push(`${key}=$${args.length}`);
      };
      if (action === 'update') {
        if (input.username !== undefined) set('username', input.username);
        if (input.role !== undefined) set('role', input.role);
      }
      if (action === 'reset_password') set('password_hash', hash);
      if (action === 'disable') sets.push('disabled_at=now()');
      if (action === 'enable') sets.push('disabled_at=NULL');
      if (action === 'delete') sets.push('deleted_at=now()');
      if (action === 'restore') sets.push('deleted_at=NULL');
      let updated;
      try {
        updated = await client.query<AccountRow>(
          `UPDATE users SET ${sets.join(',')} WHERE id=$1 RETURNING *`,
          args,
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
          throw new ApiException('USERNAME_IN_USE', '这个工号已存在', 409);
        throw error;
      }
      if (['reset_password', 'disable', 'delete'].includes(action))
        await client.query(
          'UPDATE auth_sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL',
          [id],
        );
      const result = account(updated.rows[0]!);
      await this.log(client, actor, who, account(row), result, action);
      return result;
    });
  }
  logs(actor: AdminActor, q: z.infer<typeof adminLogSchema>): Promise<AdminAuditList> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await this.actor(client, actor);
      const where =
          "(strpos(lower(actor_username),lower($1))>0 OR strpos(lower(target_username),lower($1))>0) AND ($2='all' OR action=$2)",
        args = [q.search, q.action];
      const total = await client.query(
        `SELECT count(*)::int n FROM admin_audit_logs WHERE ${where}`,
        args,
      );
      const rows = await client.query(
        `SELECT * FROM admin_audit_logs WHERE ${where} ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,
        [...args, q.limit, q.offset],
      );
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          actorId: r.actor_id,
          actorUsername: r.actor_username,
          targetId: r.target_id,
          targetUsername: r.target_username,
          action: r.action,
          before: r.before_state,
          after: r.after_state,
          requestId: r.request_id,
          ip: r.ip,
          createdAt: r.created_at.toISOString(),
        })),
        total: total.rows[0].n,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }
}
