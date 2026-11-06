import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  effectiveProgress,
  weightedProgress,
  itemComplete,
  normalizeDocument,
  documentRows,
  documentFromTables,
  documentText,
  documentFromText,
  parseWorkMinutes,
  sampleDocument,
} from '../packages/contracts/dist/index.js';
import { planTree } from '../apps/web/src/lib/plan-tree.ts';
import { localInsights } from '../apps/web/src/lib/local-insights.ts';

const annual = {
  id: 'a',
  type: 'annual',
  year: 2026,
  progress: 37,
  weight: 100,
  progressMode: 'auto',
  title: '根目标',
  note: '',
  parentId: null,
};
const monthly = {
  id: 'm',
  type: 'monthly',
  month: '2026-11',
  progress: 100,
  weight: 25,
  parentId: 'a',
  title: '月目标',
  note: '',
};
test('auto progress keeps the manual value, spans child periods and ignores zero/deleted/archived weights', () => {
  const other = { ...monthly, id: 'm2', month: '2027-01', progress: 20, weight: 75 };
  const rows = [
    annual,
    monthly,
    other,
    { ...monthly, id: 'zero', progress: 99, weight: 0 },
    { ...monthly, id: 'deleted', deletedAt: '2026-01-01', weight: 100 },
    { ...monthly, id: 'archived', archivedAt: '2026-01-01', weight: 100 },
  ];
  assert.equal(effectiveProgress(annual, rows), 40);
  assert.equal(annual.progress, 37);
  assert.equal(effectiveProgress({ ...annual, progressMode: 'manual' }, rows), 37);
  assert.equal(effectiveProgress(annual, []), 0);
  assert.equal(effectiveProgress({ ...annual, calculatedProgress: 100 }, []), 100);
  assert.equal(effectiveProgress(annual, [{ ...monthly, weight: 0 }]), 0);
  assert.equal(weightedProgress([{ ...annual, weight: 0 }]), null);
  assert.equal(itemComplete(annual, [monthly]), true);
});
test('local overview and charts use the same weighted effective annual progress', () => {
  const q = {
    year: 2026,
    month: '2026-11',
    start: '2026-11-02',
    end: '2026-11-08',
    date: '2026-11-04',
  };
  const rows = [
    annual,
    monthly,
    { ...annual, id: 'b', progress: 50, progressMode: 'manual', weight: 50 },
  ];
  const result = localInsights(rows, q, '2026-11-04');
  assert.equal(
    result.overview.annual.value,
    weightedProgress(
      rows.filter((v) => v.type === 'annual'),
      (v) => effectiveProgress(v, rows),
    ),
  );
  assert.equal(result.overview.annual.completed, 1);
});
test('tree keeps cross-year descendants and unlinked current-year work, filtering retains ancestor paths', () => {
  const week = {
    id: 'w',
    type: 'weekly',
    startDate: '2027-01-01',
    endDate: '2027-01-07',
    parentId: 'm',
    status: 'doing',
    title: '周任务',
  };
  const day = {
    id: 'd',
    type: 'daily',
    date: '2027-01-02',
    parentId: 'w',
    done: true,
    title: '叶子',
    note: '唯一搜索词',
  };
  const orphan = {
    ...day,
    id: 'orphan',
    date: '2026-11-04',
    parentId: 'missing',
    done: false,
    title: '游离待办',
    note: '',
  };
  const rows = [
    annual,
    { ...monthly, month: '2027-01' },
    week,
    day,
    orphan,
    { ...day, id: 'deleted', deletedAt: 'x' },
  ];
  const tree = planTree(rows, 2026);
  assert.equal(tree.roots[0].children[0].children[0].children[0].item.id, 'd');
  assert.equal(tree.extra[0].item.id, 'orphan');
  const filtered = planTree(rows, 2026, 'complete', '唯一搜索词');
  assert.equal(filtered.roots[0].children[0].children[0].children[0].item.id, 'd');
  assert.equal(filtered.extra.length, 0);
  const missingParent = planTree([orphan], 2026);
  assert.equal(missingParent.extra.length, 1);
});
test('all transfer formats retain mode, annual deadline, daily time and work notes', () => {
  const doc = sampleDocument('2026-11-04');
  Object.assign(doc.items.annual[0], { progressMode: 'auto', dueDate: '2026-12-31' });
  Object.assign(doc.items.daily[0], { time: '09:30–11:00', note: '第一行\n第二行\t工作情况' });
  const normalized = normalizeDocument(doc).document;
  assert.deepEqual(
    documentFromTables([{ name: '工作台', rows: documentRows(doc) }], '2026-11-04').items,
    normalized.items,
  );
  assert.deepEqual(documentFromText(documentText(doc), '2026-11-04').items, normalized.items);
  const old = {
    version: 2,
    years: [{ id: 'a', year: 2026, due: '2026-12-31' }],
    months: [],
    weeks: [],
    days: [{ id: 'd', date: '2026-11-04', time: '1.5h', note: '工作情况' }],
  };
  const result = normalizeDocument(old).document;
  assert.equal(result.items.annual[0].dueDate, '2026-12-31');
  assert.equal(result.items.daily[0].time, '1.5h');
  assert.equal(result.items.daily[0].note, '工作情况');
});
test('time text parsing does not accept invalid or negative clock ranges', () => {
  for (const [text, expected] of [
    ['09:30–11:00', 90],
    ['1.5h', 90],
    ['90分钟', 90],
    ['60', 60],
    ['25:00–26:00', null],
    ['11:00–09:00', null],
    ['随时', null],
    ['1500分钟', null],
  ])
    assert.equal(parseWorkMinutes(text), expected);
});
