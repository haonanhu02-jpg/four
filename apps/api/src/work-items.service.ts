import { Inject, Injectable } from '@nestjs/common';
import {
  workItemCreateSchemas,
  workItemValueSchemas,
  type WorkItem,
  type WorkItemList,
  type WorkItemQuery,
  type WorkItemResult,
  type WorkItemType,
  type WorkItemValues,
  type WorkbenchQuery,
  type WorkbenchResponse,
  type WorkItemDetail,
} from '@workbench/contracts';
import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { DatabaseService } from './database.service';
import { ApiException } from './http';
import { HistoryService } from './history.service';

import { DEFINITIONS, item } from './work-item-model';
export { item } from './work-item-model';

@Injectable()
export class WorkItemsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HistoryService) private readonly history: HistoryService,
  ) {}

  async ancestors(client: PoolClient, userId: string, values: WorkItem[]): Promise<WorkItem[]> {
    const found = new Map<string, WorkItem>();
    let level = values;
    for (let depth = 0; depth < 3; depth++) {
      const next: WorkItem[] = [];
      for (const parentType of ['annual', 'monthly', 'weekly'] as const) {
        const ids = [
          ...new Set(
            level
              .filter((v) => DEFINITIONS[v.type].parent === parentType && v.parentId)
              .map((v) => v.parentId),
          ),
        ];
        if (!ids.length) continue;
        const rows = await client.query(
          `SELECT * FROM ${DEFINITIONS[parentType].table} WHERE user_id=$1 AND id=ANY($2::uuid[])`,
          [userId, ids],
        );
        for (const row of rows.rows) {
          const parent = item(parentType, row);
          if (!found.has(parent.id)) {
            found.set(parent.id, parent);
            next.push(parent);
          }
        }
      }
      level = next;
      if (!level.length) break;
    }
    return [...found.values()];
  }

  private async query(
    client: PoolClient,
    userId: string,
    type: WorkItemType,
    q: WorkItemQuery,
  ): Promise<WorkItemList> {
    const parameters: unknown[] = [userId];
    const conditions = ['user_id=$1', `deleted_at IS ${q.deleted === 'true' ? 'NOT ' : ''}NULL`];
    const add = (expression: string, value: unknown) => {
      parameters.push(value);
      conditions.push(expression.replace('?', `$${parameters.length}`));
    };
    if (q.search) add("title ILIKE ? ESCAPE '!'", `%${q.search.replace(/[!%_]/g, '!$&')}%`);
    if (type === 'annual' && q.year) add('year=?', q.year);
    if (type === 'monthly' && q.month) add('current_month=?::date', `${q.month}-01`);
    if (type === 'weekly' && q.start && q.end) {
      add('current_end>=?::date', q.start);
      add('current_start<=?::date', q.end);
    }
    if (type === 'daily' && q.date) add('scheduled_date=?::date', q.date);
    const where = conditions.join(' AND ');
    const total = await client.query(
      `SELECT count(*)::int AS count FROM ${DEFINITIONS[type].table} WHERE ${where}`,
      parameters,
    );
    const rows = await client.query(
      `SELECT * FROM ${DEFINITIONS[type].table} WHERE ${where} ORDER BY created_at ASC,id ASC LIMIT $${parameters.length + 1} OFFSET $${parameters.length + 2}`,
      [...parameters, q.limit, q.offset],
    );
    const items = rows.rows.map((r) => item(type, r));
    return {
      items,
      ancestors: await this.ancestors(client, userId, items),
      total: total.rows[0].count as number,
      limit: q.limit,
      offset: q.offset,
    };
  }

  list(userId: string, type: WorkItemType, query: WorkItemQuery): Promise<WorkItemList> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      return this.query(client, userId, type, query);
    });
  }

  detail(userId: string, type: WorkItemType, id: string): Promise<WorkItemDetail> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const rows = await client.query(
        `SELECT * FROM ${DEFINITIONS[type].table} WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`,
        [userId, id],
      );
      if (!rows.rows[0]) throw new ApiException('NOT_FOUND', '事项不存在或已被删除，请刷新', 404);
      const value = item(type, rows.rows[0]);
      return { item: value, ancestors: await this.ancestors(client, userId, [value]) };
    });
  }

  workbench(userId: string, q: WorkbenchQuery): Promise<WorkbenchResponse> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const common = { limit: 50, offset: 0 };
      return {
        annual: await this.query(client, userId, 'annual', { ...common, year: q.year }),
        monthly: await this.query(client, userId, 'monthly', { ...common, month: q.month }),
        weekly: await this.query(client, userId, 'weekly', {
          ...common,
          start: q.start,
          end: q.end,
        }),
        daily: await this.query(client, userId, 'daily', { ...common, date: q.date }),
      };
    });
  }

  private async owned(
    client: PoolClient,
    userId: string,
    type: WorkItemType,
    id: string,
    deleted = false,
  ): Promise<WorkItem> {
    const result = await client.query(
      `SELECT * FROM ${DEFINITIONS[type].table} WHERE id=$1 AND user_id=$2 AND deleted_at IS ${deleted ? 'NOT ' : ''}NULL FOR UPDATE`,
      [id, userId],
    );
    if (!result.rows[0])
      throw new ApiException('NOT_FOUND', '事项不存在或已被删除，请刷新列表', 404);
    return item(type, result.rows[0]);
  }

  private validate(type: WorkItemType, values: unknown, partial: boolean): WorkItemValues {
    const parsed = (
      partial ? workItemValueSchemas[type].partial() : workItemCreateSchemas[type]
    ).safeParse(values);
    if (!parsed.success)
      throw new ApiException('VALIDATION_ERROR', '请检查事项内容', 400, {
        fields: parsed.error.issues.map((v) => ({ path: v.path.join('.'), message: v.message })),
      });
    if (partial && !Object.keys(parsed.data).length)
      throw new ApiException('VALIDATION_ERROR', '请提供需要修改的字段', 400);
    return parsed.data;
  }

  private async validateParent(
    client: PoolClient,
    userId: string,
    type: WorkItemType,
    parentId?: string | null,
  ): Promise<void> {
    const parentType = DEFINITIONS[type].parent;
    if (!parentType || !parentId) return;
    const result = await client.query(
      `SELECT id FROM ${DEFINITIONS[parentType].table} WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`,
      [parentId, userId],
    );
    if (!result.rowCount)
      throw new ApiException(
        'VALIDATION_ERROR',
        '上级目标不存在、已删除或不属于当前账号，请重新关联',
        400,
      );
  }

  private columns(type: WorkItemType, values: WorkItemValues): Record<string, unknown> {
    const map: Record<string, string> = {
      title: 'title',
      note: 'note',
      year: 'year',
      progress: 'progress',
      weight: 'weight',
      month: 'current_month',
      dueDate: 'due_date',
      startDate: 'current_start',
      endDate: 'current_end',
      priority: 'priority',
      status: 'status',
      date: 'scheduled_date',
      minutes: 'minutes',
      done: 'done',
    };
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      if (key === 'parentId') {
        const column = DEFINITIONS[type].parentColumn;
        if (column) result[column] = value;
      } else if (map[key]) result[map[key]] = key === 'month' && value ? `${value}-01` : value;
    }
    if (type === 'daily' && values.done !== undefined)
      result.completed_at = values.done ? new Date() : null;
    return result;
  }

  private async log(
    client: PoolClient,
    userId: string,
    type: WorkItemType,
    id: string,
    action: string,
    before: WorkItem | null,
    after: WorkItem,
    operationId: string,
  ): Promise<void> {
    const snapshot = async (value: WorkItem | null) =>
      value ? { item: value, ancestors: await this.ancestors(client, userId, [value]) } : null;
    await client.query(
      'INSERT INTO activity_logs(user_id,item_type,item_id,action,before_value,after_value,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [userId, type, id, action, await snapshot(before), await snapshot(after), operationId],
    );
  }

  private mutation(
    userId: string,
    operationId: string,
    request: unknown,
    action: (client: PoolClient) => Promise<WorkItemResult>,
  ): Promise<WorkItemResult> {
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.database.withTransaction(async (client) => {
      // One account's mutations are short and serialized, keeping parent deletion/relinking atomic.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `work-items:${userId}`,
      ]);
      const previous = await client.query(
        'SELECT * FROM idempotency_keys WHERE user_id=$1 AND operation_id=$2',
        [userId, operationId],
      );
      const stored = previous.rows[0];
      if (stored) {
        if (stored.request_hash !== hash)
          throw new ApiException('IDEMPOTENCY_CONFLICT', '重试操作内容已变化，请重新提交', 409);
        return stored.response_body as WorkItemResult;
      }
      const response = await action(client);
      await client.query(
        'INSERT INTO idempotency_keys(user_id,operation_id,request_hash,response_status,response_body) VALUES ($1,$2,$3,200,$4)',
        [userId, operationId, hash, response],
      );
      return response;
    });
  }

  create(
    userId: string,
    type: WorkItemType,
    operationId: string,
    rawValues: unknown,
    itemId?: string,
  ): Promise<WorkItemResult> {
    const values = this.validate(type, rawValues, false);
    if (type === 'weekly' && values.startDate! > values.endDate!)
      throw new ApiException('VALIDATION_ERROR', '结束日期不能早于开始日期', 400);
    return this.mutation(
      userId,
      operationId,
      { action: 'create', type, values, ...(itemId ? { itemId } : {}) },
      async (client) => {
        await this.validateParent(client, userId, type, values.parentId);
        if (itemId) {
          const used = await client.query(`SELECT id FROM ${DEFINITIONS[type].table} WHERE id=$1`, [
            itemId,
          ]);
          if (used.rowCount)
            throw new ApiException(
              'IDEMPOTENCY_CONFLICT',
              '事项编号已存在，请保留草稿并另存为新事项',
              409,
            );
        }
        const columns = {
          user_id: userId,
          ...(itemId ? { id: itemId } : {}),
          ...this.columns(type, values),
        };
        if (type === 'monthly') Object.assign(columns, { original_month: `${values.month}-01` });
        if (type === 'weekly')
          Object.assign(columns, {
            original_start: values.startDate,
            original_end: values.endDate,
          });
        if (type === 'daily') Object.assign(columns, { original_date: values.date });
        const keys = Object.keys(columns);
        const result = await client.query(
          `INSERT INTO ${DEFINITIONS[type].table}(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
          Object.values(columns),
        );
        const created = item(type, result.rows[0]);
        await this.log(client, userId, type, created.id, 'create', null, created, operationId);
        return { item: created, detachedChildren: 0 };
      },
    );
  }

  update(
    userId: string,
    type: WorkItemType,
    id: string,
    operationId: string,
    baseVersion: number,
    rawValues: unknown,
  ): Promise<WorkItemResult> {
    const values = this.validate(type, rawValues, true);
    return this.mutation(
      userId,
      operationId,
      { action: 'update', type, id, baseVersion, values },
      async (client) => {
        const before = await this.owned(client, userId, type, id);
        this.checkVersion(before, baseVersion);
        await this.history.captureBefore(client, userId, before, 'before_edit');
        const merged = { ...before, ...values };
        if (type === 'weekly' && merged.startDate! > merged.endDate!)
          throw new ApiException('VALIDATION_ERROR', '结束日期不能早于开始日期', 400);
        await this.validateParent(client, userId, type, merged.parentId);
        const columns = this.columns(type, values);
        const keys = Object.keys(columns);
        const result = await client.query(
          `UPDATE ${DEFINITIONS[type].table} SET ${keys.map((key, i) => `${key}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} AND user_id=$${keys.length + 2} AND version=$${keys.length + 3} RETURNING *`,
          [...Object.values(columns), id, userId, baseVersion],
        );
        const updated = item(type, result.rows[0]);
        await this.history.scheduleChange(
          client,
          userId,
          before,
          updated,
          'manual_edit',
          operationId,
        );
        await this.log(client, userId, type, id, 'update', before, updated, operationId);
        return { item: updated, detachedChildren: 0 };
      },
    );
  }

  private checkVersion(current: WorkItem, expected: number): void {
    if (current.version !== expected)
      throw new ApiException(
        'VERSION_CONFLICT',
        '这条事项已在其它页面更新，请选择保留的内容',
        409,
        { currentVersion: current.version, currentRecord: current },
      );
  }

  remove(
    userId: string,
    type: WorkItemType,
    id: string,
    operationId: string,
    baseVersion: number,
  ): Promise<WorkItemResult> {
    return this.mutation(
      userId,
      operationId,
      { action: 'delete', type, id, baseVersion },
      async (client) => {
        const before = await this.owned(client, userId, type, id);
        this.checkVersion(before, baseVersion);
        const childType = DEFINITIONS[type].child;
        await this.history.captureBefore(client, userId, before, 'before_delete');
        let detached = 0;
        if (childType) {
          const childDefinition = DEFINITIONS[childType];
          const children = await client.query(
            `SELECT * FROM ${childDefinition.table} WHERE user_id=$1 AND ${childDefinition.parentColumn}=$2 AND deleted_at IS NULL FOR UPDATE`,
            [userId, id],
          );
          for (const row of children.rows) {
            const oldChild = item(childType, row);
            const childAncestors = await this.ancestors(client, userId, [oldChild]);
            const changed = await client.query(
              `UPDATE ${childDefinition.table} SET ${childDefinition.parentColumn}=NULL WHERE id=$1 AND user_id=$2 RETURNING *`,
              [oldChild.id, userId],
            );
            await client.query(
              'INSERT INTO activity_logs(user_id,item_type,item_id,action,before_value,after_value,operation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [
                userId,
                childType,
                oldChild.id,
                'unlink_deleted_parent',
                { item: oldChild, ancestors: childAncestors },
                { item: item(childType, changed.rows[0]), ancestors: [] },
                operationId,
              ],
            );
            detached++;
          }
        }
        const result = await client.query(
          `UPDATE ${DEFINITIONS[type].table} SET deleted_at=now() WHERE id=$1 AND user_id=$2 RETURNING *`,
          [id, userId],
        );
        const deleted = item(type, result.rows[0]);
        await this.log(client, userId, type, id, 'delete', before, deleted, operationId);
        return { item: deleted, detachedChildren: detached };
      },
    );
  }

  restore(
    userId: string,
    type: WorkItemType,
    id: string,
    operationId: string,
    baseVersion: number,
  ): Promise<WorkItemResult> {
    return this.mutation(
      userId,
      operationId,
      { action: 'restore', type, id, baseVersion },
      async (client) => {
        const before = await this.owned(client, userId, type, id, true);
        this.checkVersion(before, baseVersion);
        const parent = DEFINITIONS[type];
        let clearParent = false;
        if (parent.parent && before.parentId) {
          const existing = await client.query(
            `SELECT id FROM ${DEFINITIONS[parent.parent].table} WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`,
            [before.parentId, userId],
          );
          clearParent = !existing.rowCount;
        }
        const result = await client.query(
          `UPDATE ${parent.table} SET deleted_at=NULL${clearParent ? `,${parent.parentColumn}=NULL` : ''} WHERE id=$1 AND user_id=$2 RETURNING *`,
          [id, userId],
        );
        const restored = item(type, result.rows[0]);
        await this.log(client, userId, type, id, 'restore', before, restored, operationId);
        return { item: restored, detachedChildren: 0 };
      },
    );
  }
}
