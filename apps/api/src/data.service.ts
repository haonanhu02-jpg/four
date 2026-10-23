import { Inject, Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  dataKinds,
  normalizeDocument,
  documentCounts,
  sampleDocument,
  type ImportPreview,
  type ImportResult,
  type TransferDocument,
  type WorkItem,
  type WorkItemType,
  type BackupList,
} from '@workbench/contracts';
import { DatabaseService } from './database.service';
import { RolloverService } from './rollover.service';
import { RolloverClock } from './rollover-clock';
import { DEFINITIONS, item } from './work-item-model';
import { ApiException } from './http';
@Injectable()
export class DataService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RolloverService) private readonly rollover: RolloverService,
    @Inject(RolloverClock) private readonly clock: RolloverClock,
  ) {}
  private normalize(raw: unknown) {
    try {
      return normalizeDocument(raw);
    } catch (error) {
      throw new ApiException(
        'VALIDATION_ERROR',
        error instanceof Error ? error.message : '文件内容无效',
        400,
      );
    }
  }
  private async revision(client: PoolClient, userId: string): Promise<string> {
    const rows = await client.query(
      `SELECT md5(coalesce(string_agg(token,',' ORDER BY token),'')) AS revision FROM (
      ${dataKinds.map((type) => `SELECT '${type}:'||id::text||':'||version::text AS token FROM ${DEFINITIONS[type].table} WHERE user_id=$1`).join(' UNION ALL ')}
    ) items`,
      [userId],
    );
    return rows.rows[0].revision as string;
  }
  private async exportIn(client: PoolClient, userId: string): Promise<TransferDocument> {
    const items: Record<WorkItemType, WorkItem[]> = {
      annual: [],
      monthly: [],
      weekly: [],
      daily: [],
    };
    for (const type of dataKinds) {
      const rows = await client.query(
        `SELECT * FROM ${DEFINITIONS[type].table} WHERE user_id=$1 ORDER BY created_at,id`,
        [userId],
      );
      items[type] = rows.rows.map((r) => item(type, r));
    }
    return {
      format: 'four-layer-workbench',
      version: 3,
      exportedAt: new Date().toISOString(),
      items,
    };
  }
  export(userId: string) {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return this.exportIn(client, userId);
    });
  }
  cache(userId: string) {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const state = await client.query(
        'SELECT cache_generation FROM deployment_state WHERE singleton',
      );
      return {
        generation: state.rows[0].cache_generation as string,
        document: await this.exportIn(client, userId),
      };
    });
  }
  state(userId: string) {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const doc = await this.exportIn(client, userId);
      return { revision: await this.revision(client, userId), counts: documentCounts(doc) };
    });
  }
  sample(userId: string) {
    return this.db.withTransaction(async (client) =>
      sampleDocument(await this.clock.today(client, userId)),
    );
  }
  preview(
    userId: string,
    raw: unknown,
    mode: 'append' | 'replace',
    restoreIds = false,
  ): Promise<ImportPreview> {
    const parsed = this.normalize(raw);
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const current = await this.exportIn(client, userId),
        revision = await this.revision(client, userId),
        today = await this.clock.today(client, userId);
      const rows = await client.query(
        'INSERT INTO data_previews(user_id,mode,document,revision,restore_ids) VALUES ($1,$2,$3,$4,$5) RETURNING id,expires_at',
        [userId, mode, parsed.document, revision, restoreIds],
      );
      const pastItems = [
        ...parsed.document.items.daily.filter((v) => !v.done && !v.deletedAt && v.date! < today),
        ...parsed.document.items.weekly.filter(
          (v) => v.status !== 'done' && !v.deletedAt && v.endDate! < today,
        ),
        ...parsed.document.items.monthly.filter(
          (v) => v.progress !== 100 && !v.deletedAt && v.month! < today.slice(0, 7),
        ),
      ].length;
      return {
        id: rows.rows[0].id,
        mode,
        counts: documentCounts(parsed.document),
        current: documentCounts(current),
        warnings: parsed.warnings,
        titles: dataKinds.flatMap((t) =>
          parsed.document.items[t].slice(0, 3).map((v) => v.title || '未命名事项'),
        ),
        expiresAt: new Date(rows.rows[0].expires_at).toISOString(),
        pastItems,
      };
    });
  }
  private async backup(
    client: PoolClient,
    userId: string,
    reason: 'clear' | 'replace' | 'restore',
  ) {
    const document = await this.exportIn(client, userId);
    if (Object.values(document.items).reduce((sum, rows) => sum + rows.length, 0) > 10000)
      throw new ApiException(
        'VALIDATION_ERROR',
        '备份超过单次恢复上限 10000 条，请先导出并分批归档，暂不执行清空或替换',
        400,
      );
    const rows = await client.query(
      'INSERT INTO data_backups(user_id,reason,document) VALUES ($1,$2,$3) RETURNING id',
      [userId, reason, document],
    );
    return rows.rows[0].id as string;
  }
  private async hideAll(client: PoolClient, userId: string) {
    for (const type of dataKinds)
      await client.query(
        `UPDATE ${DEFINITIONS[type].table} SET deleted_at=now() WHERE user_id=$1 AND deleted_at IS NULL`,
        [userId],
      );
  }
  private async writeDocument(
    client: PoolClient,
    userId: string,
    document: TransferDocument,
    restoreIds: boolean,
  ) {
    const mapping = new Map(
      dataKinds.flatMap((type) =>
        document.items[type].map((v) => [v.id, restoreIds ? v.id : randomUUID()] as const),
      ),
    );
    for (const type of dataKinds) {
      for (const value of document.items[type]) {
        const id = mapping.get(value.id)!;
        if (restoreIds && !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id))
          throw new ApiException('VALIDATION_ERROR', '备份事项编号无效', 400);
        const columns: Record<string, unknown> = {
          id,
          user_id: userId,
          title: value.title,
          deleted_at: value.deletedAt,
          archived_at: value.archivedAt ?? null,
        };
        if (type !== 'daily') columns.note = value.note;
        if (type === 'annual')
          Object.assign(columns, {
            year: value.year,
            progress: value.progress,
            weight: value.weight,
          });
        if (type === 'monthly')
          Object.assign(columns, {
            annual_goal_id: value.parentId ? (mapping.get(value.parentId) ?? null) : null,
            current_month: `${value.month}-01`,
            original_month: `${value.originalMonth ?? value.month}-01`,
            due_date: value.dueDate ?? null,
            progress: value.progress,
            weight: value.weight,
            rollover_count: value.rolloverCount ?? 0,
          });
        if (type === 'weekly')
          Object.assign(columns, {
            monthly_goal_id: value.parentId ? (mapping.get(value.parentId) ?? null) : null,
            current_start: value.startDate,
            current_end: value.endDate,
            original_start: value.originalStartDate ?? value.startDate,
            original_end: value.originalEndDate ?? value.endDate,
            priority: value.priority,
            status: value.status,
            rollover_count: value.rolloverCount ?? 0,
          });
        if (type === 'daily')
          Object.assign(columns, {
            weekly_task_id: value.parentId ? (mapping.get(value.parentId) ?? null) : null,
            scheduled_date: value.date,
            original_date: value.originalDate ?? value.date,
            minutes: value.minutes,
            done: value.done,
            completed_at: value.done ? (value.completedAt ?? new Date()) : null,
            rollover_count: value.rolloverCount ?? 0,
          });
        const keys = Object.keys(columns);
        const conflict = restoreIds
          ? `ON CONFLICT(id) DO UPDATE SET ${keys
              .filter((k) => !['id', 'user_id'].includes(k))
              .map((k) => `${k}=EXCLUDED.${k}`)
              .join(',')} WHERE ${DEFINITIONS[type].table}.user_id=EXCLUDED.user_id RETURNING id`
          : 'RETURNING id';
        const rows = await client.query(
          `INSERT INTO ${DEFINITIONS[type].table}(${keys.join(',')},created_at) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')},clock_timestamp()) ${conflict}`,
          Object.values(columns),
        );
        if (!rows.rowCount)
          throw new ApiException('FORBIDDEN', '备份中存在不属于当前账号的事项', 403);
      }
    }
  }
  private async replay<T>(
    client: PoolClient,
    userId: string,
    operationId: string,
    payload: unknown,
    work: () => Promise<T>,
  ): Promise<T> {
    const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const previous = await client.query(
      'SELECT * FROM idempotency_keys WHERE user_id=$1 AND operation_id=$2',
      [userId, operationId],
    );
    if (previous.rows[0]) {
      if (previous.rows[0].request_hash !== hash)
        throw new ApiException('IDEMPOTENCY_CONFLICT', '操作编号内容已变化', 409);
      return previous.rows[0].response_body as T;
    }
    const result = await work();
    await client.query(
      'INSERT INTO idempotency_keys(user_id,operation_id,request_hash,response_status,response_body) VALUES ($1,$2,$3,200,$4)',
      [userId, operationId, hash, result],
    );
    return result;
  }
  async commit(userId: string, previewId: string, operationId: string): Promise<ImportResult> {
    const result = await this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `work-items:${userId}`,
      ]);
      return this.replay(client, userId, operationId, { action: 'import', previewId }, async () => {
        const rows = await client.query(
          'SELECT * FROM data_previews WHERE id=$1 AND user_id=$2 FOR UPDATE',
          [previewId, userId],
        );
        const p = rows.rows[0];
        if (!p) throw new ApiException('NOT_FOUND', '导入预览不存在', 404);
        if (p.committed_at || new Date(p.expires_at).getTime() < Date.now())
          throw new ApiException('IDEMPOTENCY_CONFLICT', '预览已使用或已过期，请重新预检', 409);
        if ((await this.revision(client, userId)) !== p.revision)
          throw new ApiException('VERSION_CONFLICT', '预览后数据已发生变化，请重新预检再提交', 409);
        const document = p.document as TransferDocument;
        const backupId =
          p.mode === 'replace'
            ? await this.backup(client, userId, p.restore_ids ? 'restore' : 'replace')
            : null;
        if (p.mode === 'replace') await this.hideAll(client, userId);
        await this.writeDocument(client, userId, document, p.restore_ids as boolean);
        await client.query('UPDATE data_previews SET committed_at=now() WHERE id=$1', [previewId]);
        return { previewId, counts: documentCounts(document), backupId, requiresReconcile: true };
      });
    });
    await this.rollover.reconcile(userId, 'import').catch(() => undefined);
    return result;
  }
  clear(userId: string, revision: string, operationId: string) {
    return this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `work-items:${userId}`,
      ]);
      return this.replay(client, userId, operationId, { action: 'clear', revision }, async () => {
        if ((await this.revision(client, userId)) !== revision)
          throw new ApiException('VERSION_CONFLICT', '清空前数据已变化，请刷新预览后重试', 409);
        const backupId = await this.backup(client, userId, 'clear');
        await this.hideAll(client, userId);
        return { backupId };
      });
    });
  }
  backups(userId: string, q: { limit: number; offset: number }): Promise<BackupList> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const total = await client.query(
        'SELECT count(*)::int AS n FROM data_backups WHERE user_id=$1',
        [userId],
      );
      const rows = await client.query(
        'SELECT id,reason,created_at,document FROM data_backups WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3',
        [userId, q.limit, q.offset],
      );
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          reason: r.reason,
          createdAt: new Date(r.created_at).toISOString(),
          counts: documentCounts(r.document),
        })),
        total: total.rows[0].n,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }
  async restorePreview(userId: string, id: string) {
    const rows = await this.db.pool.query(
      'SELECT document FROM data_backups WHERE user_id=$1 AND id=$2',
      [userId, id],
    );
    if (!rows.rows[0]) throw new ApiException('NOT_FOUND', '备份不存在', 404);
    return this.preview(userId, rows.rows[0].document, 'replace', true);
  }
}
