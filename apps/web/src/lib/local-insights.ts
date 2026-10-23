import {
  alignmentCodes,
  type WorkItem,
  type WorkbenchQuery,
  type Overview,
  type Metric,
  type ExecutionList,
  type AlignmentList,
  type AlignmentCode,
} from '@workbench/contracts';
const complete = (v: WorkItem) =>
  v.type === 'daily'
    ? Boolean(v.done)
    : v.type === 'weekly'
      ? v.status === 'done'
      : v.progress === 100;
const count = (rows: WorkItem[]) => ({
  total: rows.length,
  completed: rows.filter(complete).length,
});
const weighted = (rows: WorkItem[]): Metric => {
  const weight = rows.reduce((s, v) => s + (v.weight ?? 0), 0);
  return {
    ...count(rows),
    totalWeight: weight,
    value: weight
      ? Math.round(rows.reduce((s, v) => s + (v.progress ?? 0) * (v.weight ?? 0), 0) / weight)
      : null,
  };
};
export function localInsights(records: WorkItem[], q: WorkbenchQuery, today: string) {
  const all = records.filter((v) => !v.deletedAt && !v.archivedAt),
    map = new Map(all.map((v) => [v.id, v]));
  const ancestors = (v: WorkItem) => {
    const chain: WorkItem[] = [];
    let p = v;
    for (let i = 0; i < 3 && p.parentId; i++) {
      const next = map.get(p.parentId);
      if (!next) break;
      chain.push(next);
      p = next;
    }
    return chain;
  };
  const annual = all.filter((v) => v.type === 'annual' && v.year === q.year),
    monthly = all.filter((v) => v.type === 'monthly' && v.month === q.month),
    weekly = all.filter(
      (v) => v.type === 'weekly' && v.startDate! <= q.end && v.endDate! >= q.start,
    ),
    daily = all.filter((v) => v.type === 'daily' && v.date === q.date);
  const executionItems = all.flatMap((v) => {
    const root = ancestors(v).find((p) => p.type === 'annual' && p.year === q.year);
    return root
      ? [{ item: v, annualId: root.id, annualTitle: root.title, completed: complete(v) }]
      : [];
  });
  const annualGroups = annual.map((v) => {
    const rows = executionItems.filter((x) => x.annualId === v.id).map((x) => x.item);
    return {
      annualId: v.id,
      title: v.title,
      ...count(rows),
      byType: {
        monthly: count(rows.filter((v) => v.type === 'monthly')),
        weekly: count(rows.filter((v) => v.type === 'weekly')),
        daily: count(rows.filter((v) => v.type === 'daily')),
      },
    };
  });
  const focus = daily.find((v) => !v.done) ?? null;
  const overview: Overview = {
    asOfDate: today,
    annual: weighted(annual),
    monthly: weighted(monthly),
    weekly: {
      ...count(weekly),
      value: weekly.length
        ? Math.round(
            weekly.reduce(
              (sum, v) => sum + { todo: 0, doing: 50, block: 15, done: 100 }[v.status ?? 'todo'],
              0,
            ) / weekly.length,
          )
        : null,
    },
    daily: {
      ...count(daily),
      value: daily.length ? Math.round((daily.filter(complete).length / daily.length) * 100) : null,
      minutes: daily.reduce((s, v) => s + (v.minutes ?? 0), 0),
    },
    focus,
    ancestors: focus ? ancestors(focus) : [],
    annualGroups,
    monthlyGroups: monthly.map((v) => {
      const rows = all.filter((x) => ancestors(x).some((p) => p.id === v.id));
      return {
        monthlyId: v.id,
        ...count(rows),
        byType: {
          weekly: count(rows.filter((v) => v.type === 'weekly')),
          daily: count(rows.filter((v) => v.type === 'daily')),
        },
      };
    }),
    execution: count(executionItems.map((v) => v.item)),
  };
  const issues: { code: AlignmentCode; item: WorkItem }[] = [];
  const add = (code: AlignmentCode, item: WorkItem) => issues.push({ code, item });
  for (const v of [...annual, ...monthly, ...weekly, ...daily]) {
    const children = all.filter((c) => c.parentId === v.id),
      parent = v.parentId ? map.get(v.parentId) : undefined;
    if (v.type === 'annual' && !children.length) add('annual_without_monthly', v);
    if (v.type === 'monthly') {
      if (!parent) add('monthly_without_annual', v);
      if (!children.some((c) => c.startDate! <= q.end && c.endDate! >= q.start))
        add('monthly_without_weekly', v);
    }
    if (v.type === 'weekly') {
      if (!parent) add('weekly_without_monthly', v);
      if (!complete(v) && !children.some((c) => c.date! >= q.start && c.date! <= q.end))
        add('weekly_without_daily', v);
    }
    if (v.type === 'daily' && !parent) add('daily_without_weekly', v);
    if (parent && complete(parent) && !complete(v)) add('parent_complete', v);
    const due =
      v.type === 'monthly'
        ? v.dueDate
        : v.type === 'weekly'
          ? v.endDate
          : v.type === 'daily'
            ? v.date
            : undefined;
    if (due && due < today && !complete(v)) add('overdue', v);
  }
  const counts = Object.fromEntries(
    alignmentCodes.map((code) => [code, issues.filter((v) => v.code === code).length]),
  ) as Record<AlignmentCode, number>;
  return {
    overview,
    execution(
      filters: { annualId: string; type: string; completion: string },
      offset: number,
    ): ExecutionList {
      const rows = executionItems.filter(
        (v) =>
          (!filters.annualId || v.annualId === filters.annualId) &&
          (!filters.type || v.item.type === filters.type) &&
          (filters.completion === 'all' || v.completed === (filters.completion === 'complete')),
      );
      return {
        items: rows.slice(offset, offset + 20),
        ancestors: all,
        total: rows.length,
        offset,
        limit: 20,
      };
    },
    alignment(rule: string, offset: number): AlignmentList {
      const rows = issues.filter((v) => !rule || v.code === rule);
      return {
        items: rows.slice(offset, offset + 20),
        ancestors: all,
        total: rows.length,
        overallTotal: issues.length,
        affectedItems: new Set(issues.map((v) => v.item.id)).size,
        counts,
        offset,
        limit: 20,
        asOfDate: today,
      };
    },
  };
}
