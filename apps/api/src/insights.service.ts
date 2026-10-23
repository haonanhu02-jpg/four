import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  alignmentCodes,
  type AlignmentCode,
  type AlignmentList,
  type AlignmentQuery,
  type AnnualGroup,
  type ExecutionList,
  type ExecutionQuery,
  type Metric,
  type Overview,
  type WorkbenchQuery,
  type WorkItemType,
} from '@workbench/contracts';
import { DatabaseService } from './database.service';
import { WorkItemsService, item } from './work-items.service';

// Every level joins on owner as well as ID. Descendants are attributed by current
// association, including work scheduled outside the root goal's calendar year.
const executionTree = `WITH roots AS (
  SELECT * FROM annual_goals WHERE user_id=$1 AND year=$2 AND deleted_at IS NULL AND archived_at IS NULL
), months AS (
  SELECT m.*,r.id AS root_id,r.title AS root_title FROM monthly_goals m
  JOIN roots r ON r.id=m.annual_goal_id AND r.user_id=m.user_id
  WHERE m.deleted_at IS NULL AND m.archived_at IS NULL
), weeks AS (
  SELECT w.*,m.root_id,m.root_title FROM weekly_tasks w
  JOIN months m ON m.id=w.monthly_goal_id AND m.user_id=w.user_id
  WHERE w.deleted_at IS NULL AND w.archived_at IS NULL
), days AS (
  SELECT d.*,w.root_id,w.root_title FROM daily_tasks d
  JOIN weeks w ON w.id=d.weekly_task_id AND w.user_id=d.user_id
  WHERE d.deleted_at IS NULL AND d.archived_at IS NULL
), execution AS (
  SELECT id,'monthly' AS type,root_id,root_title,progress=100 AS completed,
    current_month AS period,created_at,to_jsonb(months) AS data FROM months
  UNION ALL
  SELECT id,'weekly',root_id,root_title,status='done',current_start,created_at,to_jsonb(weeks) FROM weeks
  UNION ALL
  SELECT id,'daily',root_id,root_title,done,scheduled_date,created_at,to_jsonb(days) FROM days
)`;

// Scope follows the selected year/month/intersecting interval/day. A missing
// weekly/daily breakdown is tested inside the selected interval, not all time.
const alignmentTree = `WITH a AS (
  SELECT * FROM annual_goals WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL
), m AS (
  SELECT * FROM monthly_goals WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL
), w AS (
  SELECT * FROM weekly_tasks WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL
), d AS (
  SELECT * FROM daily_tasks WHERE user_id=$1 AND deleted_at IS NULL AND archived_at IS NULL
), scoped AS (
  SELECT id,'annual' AS type,created_at,to_jsonb(a) AS data FROM a WHERE year=$2
  UNION ALL SELECT id,'monthly',created_at,to_jsonb(m) FROM m WHERE current_month=$3::date
  UNION ALL SELECT id,'weekly',created_at,to_jsonb(w) FROM w WHERE current_end >= $4::date AND current_start <= $5::date
  UNION ALL SELECT id,'daily',created_at,to_jsonb(d) FROM d WHERE scheduled_date=$6::date
), issues AS (
  SELECT 'annual_without_monthly' AS code,s.* FROM scoped s
    WHERE type='annual' AND NOT EXISTS (SELECT 1 FROM m WHERE m.annual_goal_id=s.id)
  UNION ALL SELECT 'monthly_without_annual',s.* FROM scoped s
    WHERE type='monthly' AND NOT EXISTS (SELECT 1 FROM a WHERE a.id=(s.data->>'annual_goal_id')::uuid)
  UNION ALL SELECT 'monthly_without_weekly',s.* FROM scoped s
    WHERE type='monthly' AND NOT EXISTS (SELECT 1 FROM w WHERE w.monthly_goal_id=s.id AND w.current_end >= $4::date AND w.current_start <= $5::date)
  UNION ALL SELECT 'weekly_without_monthly',s.* FROM scoped s
    WHERE type='weekly' AND NOT EXISTS (SELECT 1 FROM m WHERE m.id=(s.data->>'monthly_goal_id')::uuid)
  UNION ALL SELECT 'weekly_without_daily',s.* FROM scoped s
    WHERE type='weekly' AND s.data->>'status'<>'done' AND NOT EXISTS (SELECT 1 FROM d WHERE d.weekly_task_id=s.id AND d.scheduled_date BETWEEN $4::date AND $5::date)
  UNION ALL SELECT 'daily_without_weekly',s.* FROM scoped s
    WHERE type='daily' AND NOT EXISTS (SELECT 1 FROM w WHERE w.id=(s.data->>'weekly_task_id')::uuid)
  UNION ALL SELECT 'parent_complete',s.* FROM scoped s WHERE
    (type='monthly' AND (s.data->>'progress')::numeric<100 AND EXISTS (SELECT 1 FROM a WHERE a.id=(s.data->>'annual_goal_id')::uuid AND a.progress=100)) OR
    (type='weekly' AND s.data->>'status'<>'done' AND EXISTS (SELECT 1 FROM m WHERE m.id=(s.data->>'monthly_goal_id')::uuid AND m.progress=100)) OR
    (type='daily' AND NOT (s.data->>'done')::boolean AND EXISTS (SELECT 1 FROM w WHERE w.id=(s.data->>'weekly_task_id')::uuid AND w.status='done'))
  UNION ALL SELECT 'overdue',s.* FROM scoped s WHERE
    (type='monthly' AND (s.data->>'progress')::numeric<100 AND (s.data->>'due_date')::date<$7::date) OR
    (type='weekly' AND s.data->>'status'<>'done' AND (s.data->>'current_end')::date<$7::date) OR
    (type='daily' AND NOT (s.data->>'done')::boolean AND (s.data->>'scheduled_date')::date<$7::date)
)`;

@Injectable()
export class InsightsService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(WorkItemsService) private readonly workItems: WorkItemsService,
  ) {}

  private async asOf(client: PoolClient, userId: string): Promise<string> {
    const result = await client.query(
      'SELECT (CURRENT_TIMESTAMP AT TIME ZONE timezone)::date AS today FROM users WHERE id=$1',
      [userId],
    );
    return result.rows[0].today as string;
  }

  overview(userId: string, q: WorkbenchQuery): Promise<Overview> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const weighted = async (
        table: 'annual_goals' | 'monthly_goals',
        period: number | string,
      ): Promise<Metric> => {
        const column = table === 'annual_goals' ? 'year' : 'current_month';
        const result = await client.query(
          `SELECT count(*)::int AS total,
          count(*) FILTER (WHERE progress=100)::int AS completed, coalesce(sum(weight),0) AS weight,
          round(sum(progress*weight) / nullif(sum(weight),0)) AS value
          FROM ${table} WHERE user_id=$1 AND ${column}=$2 AND deleted_at IS NULL AND archived_at IS NULL`,
          [userId, period],
        );
        const r = result.rows[0];
        return {
          total: r.total,
          completed: r.completed,
          totalWeight: Number(r.weight),
          value: r.value === null ? null : Number(r.value),
        };
      };
      const annual = await weighted('annual_goals', q.year);
      const monthly = await weighted('monthly_goals', `${q.month}-01`);
      const weeklyRows = await client.query(
        `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE status='done')::int AS completed,
        round(avg(CASE status WHEN 'todo' THEN 0 WHEN 'doing' THEN 50 WHEN 'block' THEN 15 ELSE 100 END)) AS value
        FROM weekly_tasks WHERE user_id=$1 AND current_start<=$3::date AND current_end>=$2::date
          AND deleted_at IS NULL AND archived_at IS NULL`,
        [userId, q.start, q.end],
      );
      const wr = weeklyRows.rows[0];
      const weekly: Metric = {
        total: wr.total,
        completed: wr.completed,
        value: wr.value === null ? null : Number(wr.value),
      };
      const dailyRows = await client.query(
        `SELECT count(*)::int AS total,
        count(*) FILTER (WHERE done)::int AS completed, coalesce(sum(minutes),0)::int AS minutes,
        round(100.0 * count(*) FILTER (WHERE done) / nullif(count(*),0)) AS value
        FROM daily_tasks WHERE user_id=$1 AND scheduled_date=$2 AND deleted_at IS NULL AND archived_at IS NULL`,
        [userId, q.date],
      );
      const dr = dailyRows.rows[0];
      const daily: Metric = {
        total: dr.total,
        completed: dr.completed,
        minutes: dr.minutes,
        value: dr.value === null ? null : Number(dr.value),
      };
      const focusRows = await client.query(
        `SELECT * FROM daily_tasks WHERE user_id=$1 AND scheduled_date=$2
        AND NOT done AND deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at,id LIMIT 1`,
        [userId, q.date],
      );
      const focus = focusRows.rows[0] ? item('daily', focusRows.rows[0]) : null;
      const summaries = await client.query(
        `${executionTree}
        SELECT r.id,r.title,count(e.id)::int AS total,count(e.id) FILTER (WHERE e.completed)::int AS completed,
          count(e.id) FILTER (WHERE e.type='monthly')::int AS monthly_total,
          count(e.id) FILTER (WHERE e.type='monthly' AND e.completed)::int AS monthly_completed,
          count(e.id) FILTER (WHERE e.type='weekly')::int AS weekly_total,
          count(e.id) FILTER (WHERE e.type='weekly' AND e.completed)::int AS weekly_completed,
          count(e.id) FILTER (WHERE e.type='daily')::int AS daily_total,
          count(e.id) FILTER (WHERE e.type='daily' AND e.completed)::int AS daily_completed
        FROM roots r LEFT JOIN execution e ON e.root_id=r.id GROUP BY r.id,r.title,r.created_at ORDER BY r.created_at,r.id`,
        [userId, q.year],
      );
      const annualGroups: AnnualGroup[] = summaries.rows.map((r) => ({
        annualId: r.id,
        title: r.title,
        total: r.total,
        completed: r.completed,
        byType: {
          monthly: { total: r.monthly_total, completed: r.monthly_completed },
          weekly: { total: r.weekly_total, completed: r.weekly_completed },
          daily: { total: r.daily_total, completed: r.daily_completed },
        },
      }));
      const monthlyCounts = await client.query(
        `WITH m AS (
        SELECT id,user_id FROM monthly_goals WHERE user_id=$1 AND current_month=$2::date AND deleted_at IS NULL AND archived_at IS NULL
      ), w AS (
        SELECT w.* FROM weekly_tasks w JOIN m ON m.id=w.monthly_goal_id AND m.user_id=w.user_id
          WHERE w.deleted_at IS NULL AND w.archived_at IS NULL
      ), children AS (
        SELECT id,monthly_goal_id AS root,'weekly' AS type,status='done' AS completed FROM w
        UNION ALL SELECT d.id,w.monthly_goal_id,'daily',d.done FROM daily_tasks d JOIN w ON w.id=d.weekly_task_id AND w.user_id=d.user_id
          WHERE d.deleted_at IS NULL AND d.archived_at IS NULL
      ) SELECT m.id,count(c.id)::int AS total,count(c.id) FILTER (WHERE c.completed)::int AS completed,
        count(c.id) FILTER (WHERE c.type='weekly')::int AS weekly_total,
        count(c.id) FILTER (WHERE c.type='weekly' AND c.completed)::int AS weekly_completed,
        count(c.id) FILTER (WHERE c.type='daily')::int AS daily_total,
        count(c.id) FILTER (WHERE c.type='daily' AND c.completed)::int AS daily_completed
        FROM m LEFT JOIN children c ON c.root=m.id GROUP BY m.id`,
        [userId, `${q.month}-01`],
      );
      return {
        asOfDate: await this.asOf(client, userId),
        annual,
        monthly,
        weekly,
        daily,
        focus,
        ancestors: focus ? await this.workItems.ancestors(client, userId, [focus]) : [],
        annualGroups,
        monthlyGroups: monthlyCounts.rows.map((r) => ({
          monthlyId: r.id,
          total: r.total,
          completed: r.completed,
          byType: {
            weekly: { total: r.weekly_total, completed: r.weekly_completed },
            daily: { total: r.daily_total, completed: r.daily_completed },
          },
        })),
        execution: annualGroups.reduce(
          (sum, g) => ({ total: sum.total + g.total, completed: sum.completed + g.completed }),
          { total: 0, completed: 0 },
        ),
      };
    });
  }

  execution(userId: string, q: ExecutionQuery): Promise<ExecutionList> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const where = `($3::uuid IS NULL OR root_id=$3) AND ($4::text IS NULL OR type=$4)
        AND ($5='all' OR completed=($5='complete'))`;
      const args = [userId, q.year, q.annualId ?? null, q.type ?? null, q.completion];
      const count = await client.query(
        `${executionTree} SELECT count(*)::int AS total FROM execution WHERE ${where}`,
        args,
      );
      const rows = await client.query(
        `${executionTree} SELECT e.* FROM execution e JOIN roots r ON r.id=e.root_id WHERE ${where}
        ORDER BY r.created_at,r.id,CASE e.type WHEN 'monthly' THEN 0 WHEN 'weekly' THEN 1 ELSE 2 END,
          e.period,e.created_at,e.id LIMIT $6 OFFSET $7`,
        [...args, q.limit, q.offset],
      );
      const items = rows.rows.map((r) => ({
        item: item(r.type as WorkItemType, r.data),
        annualId: r.root_id as string,
        annualTitle: r.root_title as string,
        completed: r.completed as boolean,
      }));
      return {
        items,
        ancestors: await this.workItems.ancestors(
          client,
          userId,
          items.map((v) => v.item),
        ),
        total: count.rows[0].total,
        limit: q.limit,
        offset: q.offset,
      };
    });
  }

  alignment(userId: string, q: AlignmentQuery): Promise<AlignmentList> {
    return this.database.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const asOfDate = await this.asOf(client, userId);
      const args = [userId, q.year, `${q.month}-01`, q.start, q.end, q.date, asOfDate];
      const summary = await client.query(
        `${alignmentTree} SELECT count(*)::int AS total,
        count(DISTINCT (type,id))::int AS affected FROM issues`,
        args,
      );
      const grouped = await client.query(
        `${alignmentTree} SELECT code,count(*)::int AS total FROM issues GROUP BY code`,
        args,
      );
      const counts = Object.fromEntries(alignmentCodes.map((code) => [code, 0])) as Record<
        AlignmentCode,
        number
      >;
      for (const row of grouped.rows) counts[row.code as AlignmentCode] = row.total;
      const rows = await client.query(
        `${alignmentTree} SELECT * FROM issues WHERE ($8::text IS NULL OR code=$8)
        ORDER BY code,created_at,type,id LIMIT $9 OFFSET $10`,
        [...args, q.rule ?? null, q.limit, q.offset],
      );
      const items = rows.rows.map((r) => ({
        code: r.code as AlignmentCode,
        item: item(r.type as WorkItemType, r.data),
      }));
      return {
        items,
        ancestors: await this.workItems.ancestors(
          client,
          userId,
          items.map((v) => v.item),
        ),
        total: q.rule ? counts[q.rule] : summary.rows[0].total,
        overallTotal: summary.rows[0].total,
        affectedItems: summary.rows[0].affected,
        counts,
        limit: q.limit,
        offset: q.offset,
        asOfDate,
      };
    });
  }
}
