import assert from 'node:assert/strict';
import { test } from 'node:test';
import { annualDeletionPlan } from '../apps/web/src/lib/deletion-plan.ts';

test('annual deletion follows current links across periods, includes stopped/archived items and preserves independent trees', () => {
  const root = { id: 'a', type: 'annual' };
  const rows = [
    root,
    { id: 'm', type: 'monthly', parentId: 'a', month: '2030-01' },
    { id: 'w', type: 'weekly', parentId: 'm', archivedAt: '2029-12-31' },
    { id: 'd', type: 'daily', parentId: 'w', terminated: true },
    { id: 'gone', type: 'monthly', parentId: 'a', deletedAt: '2026-01-01' },
    { id: 'retained', type: 'weekly', parentId: 'gone' },
    { id: 'independent', type: 'monthly', parentId: null },
    { id: 'other', type: 'annual' },
    { id: 'other-month', type: 'monthly', parentId: 'other' },
  ];
  const plan = annualDeletionPlan(root, rows);
  assert.deepEqual(plan.counts, { monthly: 1, weekly: 1, daily: 1 });
  assert.deepEqual(
    plan.descendants.map((v) => v.id),
    ['d', 'w', 'm'],
  );
  assert.equal(plan.total, 3);
  assert.equal(annualDeletionPlan(rows[1], rows).total, 0);
  rows[1].parentId = null;
  assert.equal(annualDeletionPlan(root, rows).total, 0);
});
