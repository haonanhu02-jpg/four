import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  ChangeList,
  FrozenItem,
  PeriodDefinition,
  PeriodDetail,
  PeriodList,
  PeriodRecord,
  WorkItem,
  WorkItemType,
} from '@workbench/contracts';
import { DatabaseService } from './database.service';
import { RolloverClock } from './rollover-clock';
import { DEFINITIONS, item } from './work-item-model';
import { ApiException } from './http';

export const addDate = (value: string, days: number) => {
  const d = new Date(`${value}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
export const mondayOf = (value: string) =>
  addDate(value, -((new Date(`${value}T12:00:00Z`).getUTCDay() + 6) % 7));
export const monthEnd = (value: string) =>
  new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(5, 7)), 0, 12))
    .toISOString()
    .slice(0, 10);
export function periodFor(value: WorkItem): Record<string, string> {
  if (value.type === 'annual') return { year: String(value.year) };
  if (value.type === 'monthly') return { month: value.month! };
  if (value.type === 'weekly') return { start: value.startDate!, end: value.endDate! };
  return { date: value.date! };
}
export function periodsForItem(value: WorkItem): PeriodDefinition[] {
  const date =
    value.type === 'annual'
      ? `${value.year}-01-01`
      : value.month
        ? `${value.month}-01`
        : (value.date ?? value.startDate!);
  const year = date.slice(0, 4),
    month = date.slice(0, 7);
  const result: PeriodDefinition[] = [
    { periodType: 'year', start: `${year}-01-01`, end: `${year}-12-31` },
  ];
  if (value.type === 'monthly')
    result.push({ periodType: 'month', start: `${month}-01`, end: monthEnd(month) });
  if (value.type === 'weekly')
    result.push({ periodType: 'week', start: value.startDate!, end: value.endDate! });
  if (value.type === 'daily')
    result.push({ periodType: 'day', start: value.date!, end: value.date! });
  if (value.type === 'daily')
    result.push({ periodType: 'week', start: mondayOf(date), end: addDate(mondayOf(date), 6) });
  if (value.type === 'daily' || value.type === 'weekly')
    result.push({ periodType: 'month', start: `${month}-01`, end: monthEnd(month) });
  if (value.type === 'weekly' && value.endDate!.slice(0, 7) !== month) {
    const endMonth = value.endDate!.slice(0, 7);
    result.push({ periodType: 'month', start: `${endMonth}-01`, end: monthEnd(endMonth) });
  }
  return result;
}
interface RawFrozen {
  record: Record<string, unknown>;
  ancestors: { type: WorkItemType; record: Record<string, unknown> }[];
}

@Injectable()
export class HistoryService {
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(RolloverClock) private readonly clock: RolloverClock,
  ) {}
  async frozen(client: PoolClient, userId: string, value: WorkItem): Promise<FrozenItem> {
    const ancestors: WorkItem[] = [];
    let current = value;
    for (let depth = 0; depth < 3 && current.parentId; depth++) {
      const parent = DEFINITIONS[current.type].parent;
      if (!parent) break;
      const result = await client.query(
        `SELECT * FROM ${DEFINITIONS[parent].table} WHERE user_id=$1 AND id=$2`,
        [userId, current.parentId],
      );
      if (!result.rows[0]) break;
      current = item(parent, result.rows[0]);
      ancestors.push(current);
    }
    return { item: value, ancestors };
  }
  private key(p: PeriodDefinition) {
    return p.periodType === 'year'
      ? p.start.slice(0, 4)
      : p.periodType === 'month'
        ? p.start.slice(0, 7)
        : p.periodType === 'day'
          ? p.start
          : `${p.start}/${p.end}`;
  }
  async capture(
    client: PoolClient,
    userId: string,
    p: PeriodDefinition,
    reason: string,
  ): Promise<string> {
    // An empty automatic check is not a historical plan. Explicitly sealed empty
    // cycles are retained; later imports/restore can still capture other cycles.
    await client.query(
      `DELETE FROM period_snapshots p WHERE p.user_id=$1 AND p.period_type=$2 AND p.period_key=$3
      AND p.payload->>'reason'<>'manual_seal' AND NOT EXISTS(SELECT 1 FROM period_snapshot_items i WHERE i.snapshot_id=p.id)`,
      [userId, p.periodType, this.key(p)],
    );
    const inserted = await client.query(
      `INSERT INTO period_snapshots(user_id,period_type,period_key,payload) VALUES ($1,$2,$3,$4)
      ON CONFLICT(user_id,period_type,period_key) DO NOTHING RETURNING id`,
      [userId, p.periodType, this.key(p), { ...p, reason, format: 1 }],
    );
    if (!inserted.rows[0])
      return (
        await client.query(
          'SELECT id FROM period_snapshots WHERE user_id=$1 AND period_type=$2 AND period_key=$3',
          [userId, p.periodType, this.key(p)],
        )
      ).rows[0].id as string;
    const id = inserted.rows[0].id as string;
    for (const type of ['annual', 'monthly', 'weekly', 'daily'] as const) {
      if (type === 'annual' && p.periodType !== 'year') continue;
      if (type === 'monthly' && !['year', 'month'].includes(p.periodType)) continue;
      if (type === 'weekly' && p.periodType === 'day') continue;
      const def = DEFINITIONS[type];
      const joins =
        type === 'annual'
          ? ''
          : type === 'monthly'
            ? `LEFT JOIN annual_goals a ON a.id=t.annual_goal_id AND a.user_id=t.user_id`
            : type === 'weekly'
              ? `LEFT JOIN monthly_goals m ON m.id=t.monthly_goal_id AND m.user_id=t.user_id LEFT JOIN annual_goals a ON a.id=m.annual_goal_id AND a.user_id=t.user_id`
              : `LEFT JOIN weekly_tasks w ON w.id=t.weekly_task_id AND w.user_id=t.user_id LEFT JOIN monthly_goals m ON m.id=w.monthly_goal_id AND m.user_id=t.user_id LEFT JOIN annual_goals a ON a.id=m.annual_goal_id AND a.user_id=t.user_id`;
      const ancestors =
        type === 'annual'
          ? `'[]'::jsonb`
          : type === 'monthly'
            ? `jsonb_build_array(CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('type','annual','record',to_jsonb(a)) END)`
            : type === 'weekly'
              ? `jsonb_build_array(CASE WHEN m.id IS NOT NULL THEN jsonb_build_object('type','monthly','record',to_jsonb(m)) END,CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('type','annual','record',to_jsonb(a)) END)`
              : `jsonb_build_array(CASE WHEN w.id IS NOT NULL THEN jsonb_build_object('type','weekly','record',to_jsonb(w)) END,CASE WHEN m.id IS NOT NULL THEN jsonb_build_object('type','monthly','record',to_jsonb(m)) END,CASE WHEN a.id IS NOT NULL THEN jsonb_build_object('type','annual','record',to_jsonb(a)) END)`;
      const condition =
        type === 'annual'
          ? `t.year=extract(year FROM $3::date) AND $4::date>=$3::date`
          : type === 'monthly'
            ? `t.current_month BETWEEN $3::date AND $4::date`
            : type === 'weekly'
              ? `t.current_start<=$4::date AND t.current_end>=$3::date`
              : `t.scheduled_date BETWEEN $3::date AND $4::date`;
      const done =
        type === 'daily' ? 't.done' : type === 'weekly' ? `t.status='done'` : 't.progress=100';
      await client.query(
        `INSERT INTO period_snapshot_items(snapshot_id,user_id,item_type,item_id,title,completed,data)
        SELECT $1,t.user_id,'${type}',t.id,t.title,${done},jsonb_build_object('record',to_jsonb(t),'ancestors',${ancestors})
        FROM ${def.table} t ${joins} WHERE t.user_id=$2 AND t.deleted_at IS NULL AND t.archived_at IS NULL AND ${condition}`,
        [id, userId, p.start, p.end],
      );
    }
    if (reason !== 'manual_seal')
      await client.query(
        `DELETE FROM period_snapshots p WHERE p.id=$1 AND p.user_id=$2
      AND NOT EXISTS(SELECT 1 FROM period_snapshot_items i WHERE i.snapshot_id=p.id)`,
        [id, userId],
      );
    return id;
  }
  async captureBefore(
    client: PoolClient,
    userId: string,
    value: WorkItem,
    reason: string,
    today?: string,
  ) {
    const now = today ?? (await this.clock.today(client, userId));
    for (const p of periodsForItem(value))
      if (p.end < now) await this.capture(client, userId, p, reason);
  }
  async scheduleChange(
    client: PoolClient,
    userId: string,
    before: WorkItem,
    after: WorkItem,
    reason: string,
    batchId: string,
    frozenBefore?: FrozenItem,
  ) {
    const from = periodFor(before),
      to = periodFor(after);
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    await client.query(
      `INSERT INTO schedule_history(user_id,item_type,item_id,from_version,original_period,target_period,new_period,reason,snapshot,batch_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [
        userId,
        before.type,
        before.id,
        before.version,
        from,
        JSON.stringify(to),
        to,
        reason,
        frozenBefore ?? (await this.frozen(client, userId, before)),
        batchId,
      ],
    );
  }
  async seal(userId: string, p: PeriodDefinition): Promise<string> {
    return this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `work-items:${userId}`,
      ]);
      const today = await this.clock.today(client, userId);
      const days = (Date.parse(p.end) - Date.parse(p.start)) / 86400000;
      const canonical = periodsForItem(
        p.periodType === 'year'
          ? ({ type: 'annual', year: Number(p.start.slice(0, 4)) } as WorkItem)
          : ({ type: 'monthly', month: p.start.slice(0, 7) } as WorkItem),
      ).find((v) => v.periodType === p.periodType);
      if (
        p.end >= today ||
        days > 365 ||
        (p.periodType === 'day' && p.start !== p.end) ||
        (canonical && (canonical.start !== p.start || canonical.end !== p.end))
      )
        throw new ApiException(
          'VALIDATION_ERROR',
          '只能封存已结束的周期；年、月需要完整自然周期，周区间最长 366 天',
          400,
        );
      return this.capture(client, userId, p, 'manual_seal');
    });
  }
  private period(row: Record<string, unknown>): PeriodRecord {
    const payload = row.payload as PeriodDefinition & { reason: string };
    return {
      ...payload,
      id: row.id as string,
      key: row.period_key as string,
      capturedAt: new Date(row.created_at as string).toISOString(),
      reason: payload.reason,
      total: Number(row.total),
      completed: Number(row.completed),
    };
  }
  list(
    userId: string,
    q: { periodType?: string; limit: number; offset: number },
  ): Promise<PeriodList> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const args = [userId, q.periodType ?? null];
      const total = await client.query(
        'SELECT count(*)::int AS total FROM period_snapshots WHERE user_id=$1 AND ($2::text IS NULL OR period_type=$2)',
        args,
      );
      const rows = await client.query(
        `SELECT p.*,count(i.item_id)::int AS total,count(i.item_id) FILTER(WHERE i.completed)::int AS completed FROM period_snapshots p LEFT JOIN period_snapshot_items i ON i.snapshot_id=p.id AND i.user_id=p.user_id
        WHERE p.user_id=$1 AND ($2::text IS NULL OR p.period_type=$2) GROUP BY p.id ORDER BY p.payload->>'end' DESC,p.created_at DESC,p.id LIMIT $3 OFFSET $4`,
        [...args, q.limit, q.offset],
      );
      return {
        items: rows.rows.map((r) => this.period(r)),
        total: total.rows[0].total,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }
  detail(
    userId: string,
    id: string,
    q: { type?: WorkItemType; completion: string; limit: number; offset: number },
  ): Promise<PeriodDetail> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const p = await client.query(
        `SELECT p.*,count(i.item_id)::int AS total,count(i.item_id) FILTER(WHERE i.completed)::int AS completed FROM period_snapshots p LEFT JOIN period_snapshot_items i ON i.snapshot_id=p.id AND i.user_id=p.user_id WHERE p.user_id=$1 AND p.id=$2 GROUP BY p.id`,
        [userId, id],
      );
      if (!p.rows[0]) throw new ApiException('NOT_FOUND', '封存周期不存在', 404);
      const where = `user_id=$1 AND snapshot_id=$2 AND ($3::text IS NULL OR item_type=$3) AND ($4='all' OR completed=($4='complete'))`;
      const args = [userId, id, q.type ?? null, q.completion];
      const total = await client.query(
        `SELECT count(*)::int AS total FROM period_snapshot_items WHERE ${where}`,
        args,
      );
      const rows = await client.query(
        `SELECT * FROM period_snapshot_items WHERE ${where} ORDER BY item_type,item_id LIMIT $5 OFFSET $6`,
        [...args, q.limit, q.offset],
      );
      return {
        period: this.period(p.rows[0]),
        items: rows.rows.map((r) => {
          const data = r.data as RawFrozen;
          return {
            item: item(r.item_type, data.record),
            ancestors: data.ancestors.filter(Boolean).map((v) => item(v.type, v.record)),
          };
        }),
        total: total.rows[0].total,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }
  changes(
    userId: string,
    q: { itemType?: WorkItemType; itemId?: string; limit: number; offset: number },
  ): Promise<ChangeList> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const args = [userId, q.itemType ?? null, q.itemId ?? null];
      const where =
        'user_id=$1 AND ($2::text IS NULL OR item_type=$2) AND ($3::uuid IS NULL OR item_id=$3)';
      const total = await client.query(
        `SELECT count(*)::int AS total FROM schedule_history WHERE ${where}`,
        args,
      );
      const rows = await client.query(
        `SELECT * FROM schedule_history WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $4 OFFSET $5`,
        [...args, q.limit, q.offset],
      );
      return {
        items: rows.rows.map((r) => ({
          id: r.id,
          itemType: r.item_type,
          itemId: r.item_id,
          from: r.original_period,
          to: r.new_period,
          reason: r.reason,
          createdAt: new Date(r.created_at).toISOString(),
          snapshot: r.snapshot,
        })),
        total: total.rows[0].total,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }
}
