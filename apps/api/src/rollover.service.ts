import { Inject, Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  CarryoverList,
  ReconcileResult,
  WorkItem,
  WorkItemResult,
} from '@workbench/contracts';
import { DatabaseService } from './database.service';
import { HistoryService, addDate, mondayOf, periodsForItem } from './history.service';
import { RolloverClock } from './rollover-clock';
import { DEFINITIONS, item } from './work-item-model';
import { ApiException } from './http';

const expired = `SELECT 'monthly' AS type,id FROM monthly_goals WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated AND monthly_progress_value(user_id,id,progress)<100 AND current_month<date_trunc('month',$2::date)::date
 UNION ALL SELECT 'weekly',id FROM weekly_tasks WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated AND weekly_progress_value(user_id,id,coalesce(progress,CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END))<100 AND current_end<$2::date
 UNION ALL SELECT 'daily',id FROM daily_tasks WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated AND NOT done AND scheduled_date<$2::date`;
@Injectable()
export class RolloverService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private cursor = '00000000-0000-0000-0000-000000000000';
  constructor(
    @Inject(DatabaseService) private readonly db: DatabaseService,
    @Inject(HistoryService) private readonly history: HistoryService,
    @Inject(RolloverClock) private readonly clock: RolloverClock,
  ) {}
  onApplicationBootstrap() {
    if (process.env.NODE_ENV === 'test' || process.env.ROLLOVER_SCHEDULE_ENABLED === 'false')
      return;
    this.timer = setInterval(
      () =>
        void this.sweep().catch(() => console.error('周期顺延检查暂未完成，下次定时或访问时重试')),
      15000,
    );
    this.timer.unref();
  }
  onApplicationShutdown() {
    if (this.timer) clearInterval(this.timer);
  }
  async sweep(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const rows = await this.db.pool.query(
        `SELECT u.id FROM users u LEFT JOIN rollover_state s ON s.user_id=u.id
        WHERE u.id>$1 AND (s.checked_date IS NULL OR s.checked_date<>(CURRENT_TIMESTAMP AT TIME ZONE u.timezone)::date
          OR EXISTS(SELECT 1 FROM monthly_goals m WHERE m.user_id=u.id AND m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT m.terminated AND monthly_progress_value(m.user_id,m.id,m.progress)<100 AND m.current_month<date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE u.timezone)::date)
          OR EXISTS(SELECT 1 FROM weekly_tasks w WHERE w.user_id=u.id AND w.deleted_at IS NULL AND w.archived_at IS NULL AND NOT w.terminated AND weekly_progress_value(w.user_id,w.id,coalesce(w.progress,CASE w.status WHEN 'todo' THEN 0 WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END))<100 AND w.current_end<(CURRENT_TIMESTAMP AT TIME ZONE u.timezone)::date)
          OR EXISTS(SELECT 1 FROM annual_goals a WHERE a.user_id=u.id AND a.updated_at>s.checked_at)
          OR EXISTS(SELECT 1 FROM monthly_goals m WHERE m.user_id=u.id AND m.updated_at>s.checked_at)
          OR EXISTS(SELECT 1 FROM daily_tasks d WHERE d.user_id=u.id AND d.deleted_at IS NULL AND d.archived_at IS NULL AND NOT d.terminated AND NOT d.done AND d.scheduled_date<(CURRENT_TIMESTAMP AT TIME ZONE u.timezone)::date))
        ORDER BY u.id LIMIT 50`,
        [this.cursor],
      );
      if (!rows.rows.length) this.cursor = '00000000-0000-0000-0000-000000000000';
      for (const row of rows.rows) {
        this.cursor = row.id;
        await this.reconcile(row.id, 'scheduled', true);
      }
    } finally {
      this.running = false;
    }
  }
  reconcile(userId: string, reason = 'access', tryLock = false): Promise<ReconcileResult> {
    return this.db.withTransaction(async (client) => {
      if (tryLock) {
        const lock = await client.query(
          'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',
          [`work-items:${userId}`],
        );
        if (!lock.rows[0].locked)
          return {
            asOfDate: '',
            changed: { monthly: 0, weekly: 0, daily: 0 },
            remaining: 0,
            pendingCarryovers: 0,
          };
      } else
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `work-items:${userId}`,
        ]);
      const today = await this.clock.today(client, userId);
      const monday = mondayOf(today),
        month = today.slice(0, 7),
        year = Number(today.slice(0, 4));
      const selected = await client.query(
        `SELECT * FROM (${expired}) candidates ORDER BY type,id LIMIT 100`,
        [userId, today],
      );
      const records: WorkItem[] = [];
      for (const type of ['monthly', 'weekly', 'daily'] as const) {
        const ids = selected.rows.filter((r) => r.type === type).map((r) => r.id);
        if (!ids.length) continue;
        const rows = await client.query(
          `SELECT * FROM ${DEFINITIONS[type].table} WHERE user_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE`,
          [userId, ids],
        );
        records.push(...rows.rows.map((r) => item(type, r)));
      }
      // Seal all source periods before changing any level, preserving old ancestry.
      for (const value of records)
        await this.history.captureBefore(client, userId, value, 'before_rollover', today);
      const prior = await client.query('SELECT checked_date FROM rollover_state WHERE user_id=$1', [
        userId,
      ]);
      const previous = prior.rows[0]?.checked_date as string | undefined;
      if (previous !== today) {
        const yesterday = addDate(today, -1),
          lastWeekEnd = addDate(monday, -1),
          lastMonthEnd = addDate(`${month}-01`, -1);
        const periods = [
          { periodType: 'day' as const, start: yesterday, end: yesterday },
          { periodType: 'week' as const, start: addDate(lastWeekEnd, -6), end: lastWeekEnd },
          {
            periodType: 'month' as const,
            start: `${lastMonthEnd.slice(0, 7)}-01`,
            end: lastMonthEnd,
          },
          { periodType: 'year' as const, start: `${year - 1}-01-01`, end: `${year - 1}-12-31` },
        ];
        if (previous && previous < today)
          for (const p of periodsForItem({ type: 'daily', date: previous } as WorkItem))
            if (p.end < today) periods.push(p);
        for (const p of periods)
          if (p.start >= '1970-01-01')
            await this.history.capture(client, userId, p, 'period_closed');
      }
      const batchId = randomUUID(),
        changed = { monthly: 0, weekly: 0, daily: 0 };
      const frozenBefore = [];
      for (const before of records)
        frozenBefore.push(await this.history.frozen(client, userId, before));
      for (const [index, before] of records.entries()) {
        const type = before.type as 'monthly' | 'weekly' | 'daily';
        const table = DEFINITIONS[type].table;
        const assignment =
          type === 'monthly'
            ? 'current_month=$4::date'
            : type === 'weekly'
              ? 'current_start=$4::date,current_end=$5::date'
              : 'scheduled_date=$4::date';
        const target = type === 'monthly' ? `${month}-01` : type === 'weekly' ? monday : today;
        const args =
          type === 'weekly'
            ? [before.id, userId, before.version, target, addDate(monday, 6)]
            : [before.id, userId, before.version, target];
        const result = await client.query(
          `UPDATE ${table} SET ${assignment},rollover_count=rollover_count+1 WHERE id=$1 AND user_id=$2 AND version=$3 RETURNING *`,
          args,
        );
        if (!result.rows[0]) continue;
        const after = item(type, result.rows[0]);
        await this.history.scheduleChange(
          client,
          userId,
          before,
          after,
          `rollover_${reason}`,
          batchId,
          frozenBefore[index],
        );
        // An ended custom interval can fall inside this natural week. Moving its
        // end to Sunday makes the condition false after exactly one change.
        changed[type]++;
        if (type === 'monthly' && Number(before.month!.slice(0, 4)) < year)
          await this.ensureCarryover(client, userId, before, after, year);
      }
      const generated = await this.fillMissingPlans(client, userId, today);
      // Detect older annual sources even if their current month was already moved.
      const carryCandidates = await client.query(
        `SELECT m.* FROM monthly_goals m LEFT JOIN annual_goals a ON a.id=m.annual_goal_id AND a.user_id=m.user_id
        WHERE m.user_id=$1 AND m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT m.terminated AND monthly_progress_value(m.user_id,m.id,m.progress)<100
          AND extract(year FROM m.current_month)=$2 AND ((a.year IS NOT NULL AND a.year<$2) OR extract(year FROM m.original_month)<$2)
          AND NOT EXISTS(SELECT 1 FROM year_carryovers c WHERE c.user_id=m.user_id AND c.monthly_goal_id=m.id AND c.target_year=$2) ORDER BY m.id LIMIT 100`,
        [userId, year],
      );
      for (const row of carryCandidates.rows) {
        const value = item('monthly', row);
        await this.ensureCarryover(client, userId, value, value, year);
      }
      await client.query(
        `UPDATE year_carryovers SET decision='superseded',resolved_at=now() WHERE user_id=$1 AND decision='pending' AND target_year<$2`,
        [userId, year],
      );
      // Choosing a new parent directly in the card is also an explicit re-link.
      await client.query(
        `UPDATE year_carryovers c SET decision='relink',resolved_at=now(),resolved_annual_id=m.annual_goal_id FROM monthly_goals m
        WHERE c.user_id=$1 AND c.decision='pending' AND m.user_id=c.user_id AND m.id=c.monthly_goal_id
          AND m.annual_goal_id IS DISTINCT FROM c.source_annual_id AND m.annual_goal_id IS NOT NULL`,
        [userId],
      );
      await client.query(
        `INSERT INTO rollover_state(user_id,checked_date) VALUES ($1,$2) ON CONFLICT(user_id) DO UPDATE SET checked_date=EXCLUDED.checked_date,checked_at=now()`,
        [userId, today],
      );
      const remaining = await client.query(
        `SELECT count(*)::int AS count FROM (${expired}) pending`,
        [userId, today],
      );
      const pending = await client.query(
        `SELECT count(*)::int AS count FROM year_carryovers c JOIN monthly_goals m ON m.id=c.monthly_goal_id AND m.user_id=c.user_id WHERE c.user_id=$1 AND c.decision='pending' AND c.target_year=$2 AND m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT m.terminated`,
        [userId, year],
      );
      return {
        asOfDate: today,
        changed,
        remaining: remaining.rows[0].count,
        pendingCarryovers: pending.rows[0].count,
        generated,
      };
    });
  }
  private async fillMissingPlans(client: PoolClient, userId: string, today: string) {
    const month = `${today.slice(0, 7)}-01`,
      start = mondayOf(today),
      end = addDate(start, 6);
    const generated = { monthly: 0, weekly: 0 };
    // Account advisory lock held by reconcile serializes these checks with edits.
    for (const type of ['annual', 'monthly'] as const) {
      const period = type === 'annual' ? month : start;
      const parents = await client.query(
        type === 'annual'
          ? `SELECT a.* FROM annual_goals a WHERE a.user_id=$1 AND a.year=extract(year FROM $2::date)
            AND a.deleted_at IS NULL AND a.archived_at IS NULL AND NOT a.terminated
            AND annual_progress_value(a.user_id,a.id,a.progress_mode,a.progress)<100
            AND NOT EXISTS(SELECT 1 FROM monthly_goals m WHERE m.user_id=a.user_id AND m.annual_goal_id=a.id AND m.current_month=$2::date AND m.deleted_at IS NULL AND m.archived_at IS NULL)
            AND NOT EXISTS(SELECT 1 FROM rollover_generation g WHERE g.user_id=a.user_id AND g.parent_type='annual' AND g.parent_id=a.id AND g.period=$2::date) ORDER BY a.id`
          : `SELECT m.* FROM monthly_goals m WHERE m.user_id=$1 AND m.current_month=$2::date
            AND m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT m.terminated
            AND monthly_progress_value(m.user_id,m.id,m.progress)<100
            AND NOT EXISTS(SELECT 1 FROM weekly_tasks w WHERE w.user_id=m.user_id AND w.monthly_goal_id=m.id AND w.current_start<=$4::date AND w.current_end>=$3::date AND w.deleted_at IS NULL AND w.archived_at IS NULL)
            AND NOT EXISTS(SELECT 1 FROM rollover_generation g WHERE g.user_id=m.user_id AND g.parent_type='monthly' AND g.parent_id=m.id AND g.period=$3::date) ORDER BY m.id`,
        type === 'annual' ? [userId, month] : [userId, month, start, end],
      );
      for (const parent of parents.rows) {
        const id = randomUUID();
        const reservation = await client.query(
          `INSERT INTO rollover_generation(user_id,parent_type,parent_id,period,item_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING item_id`,
          [userId, type, parent.id, period, id],
        );
        if (!reservation.rowCount) continue;
        const childType = type === 'annual' ? 'monthly' : 'weekly';
        const inserted =
          type === 'annual'
            ? await client.query(
                `INSERT INTO monthly_goals(id,user_id,annual_goal_id,title,note,original_month,current_month,progress,weight) VALUES($1,$2,$3,$4,$5,$6,$6,0,0) RETURNING *`,
                [
                  id,
                  userId,
                  parent.id,
                  parent.title,
                  '自动补建 · 年度目标尚未完成，请分配本月权重',
                  month,
                ],
              )
            : await client.query(
                `INSERT INTO weekly_tasks(id,user_id,monthly_goal_id,title,note,original_start,current_start,original_end,current_end,progress,status,priority) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$7,0,'todo','P1') RETURNING *`,
                [
                  id,
                  userId,
                  parent.id,
                  parent.title,
                  '自动补建 · 月目标尚未完成，可继续细化本周动作',
                  start,
                  end,
                ],
              );
        await client.query(
          `INSERT INTO activity_logs(user_id,item_type,item_id,action,after_value) VALUES($1,$2,$3,'rollover_auto_create',$4)`,
          [userId, childType, id, { item: item(childType, inserted.rows[0]) }],
        );
        generated[childType]++;
      }
    }
    return generated;
  }
  private async ensureCarryover(
    client: PoolClient,
    userId: string,
    before: WorkItem,
    after: WorkItem,
    targetYear: number,
  ) {
    const source = await this.history.frozen(client, userId, before);
    const annual = source.ancestors.find((v) => v.type === 'annual');
    const fromYear = annual?.year ?? Number((before.originalMonth ?? before.month!).slice(0, 4));
    if (fromYear >= targetYear) return;
    await client.query(
      `INSERT INTO year_carryovers(user_id,monthly_goal_id,from_year,target_year,source_annual_id,source) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [userId, after.id, fromYear, targetYear, before.parentId, source],
    );
  }
  carryovers(userId: string, q: { limit: number; offset: number }): Promise<CarryoverList> {
    return this.db.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const today = await this.clock.today(client, userId);
      const args = [userId, Number(today.slice(0, 4))];
      const where = `c.user_id=$1 AND c.target_year=$2 AND c.decision='pending' AND m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT m.terminated`;
      const count = await client.query(
        `SELECT count(*)::int AS total FROM year_carryovers c JOIN monthly_goals m ON m.id=c.monthly_goal_id AND m.user_id=c.user_id WHERE ${where}`,
        args,
      );
      const rows = await client.query(
        `SELECT c.*,to_jsonb(m) AS current_record FROM year_carryovers c JOIN monthly_goals m ON m.id=c.monthly_goal_id AND m.user_id=c.user_id WHERE ${where} ORDER BY c.created_at,c.id LIMIT $3 OFFSET $4`,
        [...args, q.limit, q.offset],
      );
      const items = [];
      for (const row of rows.rows) {
        const current = item('monthly', row.current_record);
        items.push({
          id: row.id,
          fromYear: row.from_year,
          targetYear: row.target_year,
          source: row.source,
          current,
          ancestors: (await this.history.frozen(client, userId, current)).ancestors,
        });
      }
      return { items, total: count.rows[0].total, limit: q.limit, offset: q.offset };
    });
  }
  resolve(
    userId: string,
    id: string,
    body: {
      operationId: string;
      baseVersion: number;
      choice: 'keep' | 'relink';
      annualId?: string;
    },
  ): Promise<WorkItemResult> {
    return this.db.withTransaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `work-items:${userId}`,
      ]);
      const hash = createHash('sha256')
        .update(JSON.stringify({ action: 'carryover', id, ...body }))
        .digest('hex');
      const replay = await client.query(
        'SELECT * FROM idempotency_keys WHERE user_id=$1 AND operation_id=$2',
        [userId, body.operationId],
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== hash)
          throw new ApiException('IDEMPOTENCY_CONFLICT', '操作编号内容已变化', 409);
        return replay.rows[0].response_body as WorkItemResult;
      }
      const rows = await client.query(
        `SELECT c.*,to_jsonb(m) AS current_record FROM year_carryovers c JOIN monthly_goals m ON m.id=c.monthly_goal_id AND m.user_id=c.user_id WHERE c.user_id=$1 AND c.id=$2 AND m.deleted_at IS NULL AND m.archived_at IS NULL AND NOT m.terminated FOR UPDATE OF c,m`,
        [userId, id],
      );
      if (!rows.rows[0]) throw new ApiException('NOT_FOUND', '承接事项不存在', 404);
      const carry = rows.rows[0],
        before = item('monthly', carry.current_record);
      const today = await this.clock.today(client, userId);
      if (
        carry.decision !== 'pending' ||
        carry.target_year !== Number(today.slice(0, 4)) ||
        before.version !== body.baseVersion
      )
        throw new ApiException('VERSION_CONFLICT', '承接事项已变化，请刷新后确认', 409, {
          currentVersion: before.version,
          currentRecord: before,
        });
      if (body.choice === 'relink') {
        const parent = await client.query(
          'SELECT id FROM annual_goals WHERE user_id=$1 AND id=$2 AND year=$3 AND deleted_at IS NULL AND archived_at IS NULL AND NOT terminated FOR UPDATE',
          [userId, body.annualId, carry.target_year],
        );
        if (!parent.rowCount)
          throw new ApiException('VALIDATION_ERROR', '请选择本账号目标年份内的有效年度目标', 400);
      }
      const source = await this.history.frozen(client, userId, before);
      const result = await client.query(
        'UPDATE monthly_goals SET annual_goal_id=$4 WHERE user_id=$1 AND id=$2 AND version=$3 RETURNING *',
        [
          userId,
          before.id,
          body.baseVersion,
          body.choice === 'relink' ? body.annualId : before.parentId,
        ],
      );
      const after = item('monthly', result.rows[0]);
      await client.query(
        'UPDATE year_carryovers SET decision=$3,resolved_annual_id=$4,resolved_at=now() WHERE user_id=$1 AND id=$2',
        [userId, id, body.choice, after.parentId],
      );
      await client.query(
        `INSERT INTO activity_logs(user_id,item_type,item_id,action,before_value,after_value,operation_id) VALUES ($1,'monthly',$2,$3,$4,$5,$6)`,
        [
          userId,
          before.id,
          `carryover_${body.choice}`,
          source,
          await this.history.frozen(client, userId, after),
          body.operationId,
        ],
      );
      const response = { item: after, detachedChildren: 0 };
      await client.query(
        'INSERT INTO idempotency_keys(user_id,operation_id,request_hash,response_status,response_body) VALUES ($1,$2,$3,200,$4)',
        [userId, body.operationId, hash, response],
      );
      return response;
    });
  }
}
