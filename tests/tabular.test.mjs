import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  sampleDocument,
  documentRows,
  documentFromTables,
  documentText,
  documentFromText,
  normalizeDocument,
} from '../packages/contracts/dist/index.js';
const today = '2026-10-28';
test('Office/tabular representations retain hierarchy, multiline notes and scheduling metadata', () => {
  const doc = sampleDocument(today);
  doc.items.annual[0].title = '=literal formula-like title';
  doc.items.weekly[0].note = '第一行\n第二行\t制表符 "引号"';
  const restored = documentFromTables([{ name: '工作台', rows: documentRows(doc) }], today);
  assert.deepEqual(restored.items, normalizeDocument(doc).document.items);
  const text = documentText(doc),
    fromText = documentFromText(text, today);
  assert.deepEqual(fromText.items, normalizeDocument(doc).document.items);
});
test('ordinary text imports one task per line and table defaults only missing dates', () => {
  const text = documentFromText('检查发票\n跟进进度', today);
  assert.equal(text.items.daily.length, 2);
  assert.equal(text.items.daily[0].date, today);
  const table = documentFromTables(
    [
      {
        name: '月度目标',
        rows: [
          ['编号', '标题', '月份'],
          ['M1', '月度目标', '2026/09'],
        ],
      },
    ],
    today,
  );
  assert.equal(table.items.monthly[0].month, '2026-09');
  assert.throws(
    () => documentFromTables([{ name: '测试', rows: [['备注'], ['无标题列']] }], today),
    /标题/,
  );
  assert.throws(
    () =>
      documentFromTables(
        [
          {
            name: '周任务',
            rows: [
              ['标题', '优先级'],
              ['测试', 'P9'],
            ],
          },
        ],
        today,
      ),
    /priority/,
  );
  assert.throws(() => documentFromText('标题\t说明\n测试\t"未闭合', today), /引号/);
  assert.throws(
    () =>
      documentFromTables(
        [
          {
            name: '测试',
            rows: [
              ['标题', '进度'],
              ['测试', '不是数字'],
            ],
          },
        ],
        today,
      ),
    /数字/,
  );
});
