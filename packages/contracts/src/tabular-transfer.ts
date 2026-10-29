import { normalizeDocument, type TransferDocument } from './data-transfer';
import type { WorkItem } from './work-items';
import type { WorkItemType } from './index';
export const transferColumns: readonly { key: keyof WorkItem; label: string }[] = [
  { key: 'type', label: '层级' },
  { key: 'id', label: '编号' },
  { key: 'parentId', label: '上级编号' },
  { key: 'title', label: '标题' },
  { key: 'note', label: '说明' },
  { key: 'year', label: '年度' },
  { key: 'month', label: '月份' },
  { key: 'startDate', label: '开始日期' },
  { key: 'endDate', label: '结束日期' },
  { key: 'date', label: '执行日期' },
  { key: 'dueDate', label: '截止日期' },
  { key: 'progress', label: '进度' },
  { key: 'weight', label: '权重' },
  { key: 'priority', label: '优先级' },
  { key: 'status', label: '状态' },
  { key: 'minutes', label: '预计分钟' },
  { key: 'done', label: '完成' },
  { key: 'originalMonth', label: '原月份' },
  { key: 'originalStartDate', label: '原开始日期' },
  { key: 'originalEndDate', label: '原结束日期' },
  { key: 'originalDate', label: '原执行日期' },
  { key: 'rolloverCount', label: '顺延次数' },
  { key: 'createdAt', label: '创建时间' },
  { key: 'updatedAt', label: '更新时间' },
  { key: 'deletedAt', label: '删除时间' },
  { key: 'archivedAt', label: '归档时间' },
  { key: 'completedAt', label: '完成时间' },
  { key: 'version', label: '版本' },
];
export const levelNames: Record<WorkItemType, string> = {
  annual: '年度目标',
  monthly: '月度目标',
  weekly: '周任务',
  daily: '日待办',
};
const types: Record<string, WorkItemType> = {
  annual: 'annual',
  年度目标: 'annual',
  年度: 'annual',
  年: 'annual',
  monthly: 'monthly',
  月度目标: 'monthly',
  月目标: 'monthly',
  月: 'monthly',
  weekly: 'weekly',
  周任务: 'weekly',
  周: 'weekly',
  daily: 'daily',
  日待办: 'daily',
  每日待办: 'daily',
  待办: 'daily',
  日: 'daily',
};
const aliases: Record<string, string> = {
  类型: 'type',
  层级: 'type',
  目标: 'title',
  任务: 'title',
  事项: 'title',
  名称: 'title',
  内容: 'title',
  备注: 'note',
  衡量标准: 'note',
  上级: 'parentId',
  所属月份: 'month',
  日期: 'date',
  预计耗时: 'minutes',
};
const numberKeys = new Set(['year', 'progress', 'weight', 'minutes', 'version', 'rolloverCount']);
const nullableKeys = new Set(['parentId', 'dueDate', 'deletedAt', 'archivedAt', 'completedAt']);
const dates = new Set([
  'month',
  'date',
  'startDate',
  'endDate',
  'dueDate',
  'originalMonth',
  'originalDate',
  'originalStartDate',
  'originalEndDate',
]);
export function columnKey(label: unknown): string | undefined {
  const text = String(label ?? '')
    .replace(/^\uFEFF/, '')
    .trim();
  return transferColumns.find((c) => c.label === text || c.key === text)?.key ?? aliases[text];
}
export function documentRows(doc: TransferDocument): string[][] {
  return [
    transferColumns.map((c) => c.label),
    ...(['annual', 'monthly', 'weekly', 'daily'] as const).flatMap((type) =>
      doc.items[type].map((item) =>
        transferColumns.map((c) => {
          const value = item[c.key];
          if (value == null) return '';
          if (c.key === 'type') return levelNames[type];
          if (c.key === 'done') return value ? '是' : '否';
          if (c.key === 'status')
            return (
              (
                { todo: '未开始', doing: '进行中', block: '受阻', done: '已完成' } as Record<
                  string,
                  string
                >
              )[String(value)] ?? String(value)
            );
          return String(value);
        }),
      ),
    ),
  ];
}
export function documentFromTables(
  tables: { name: string; rows: unknown[][] }[],
  today: string,
): TransferDocument {
  const items: Record<WorkItemType, Record<string, unknown>[]> = {
    annual: [],
    monthly: [],
    weekly: [],
    daily: [],
  };
  let total = 0;
  for (const table of tables) {
    const rows = table.rows.filter((row) => row.some((c) => String(c ?? '').trim()));
    if (!rows.length) continue;
    const header = rows[0]!.map(columnKey),
      hasHeader = header.includes('title');
    if (!hasHeader) throw Error(`${table.name || '表格'} 缺少“标题”列，请使用导出文件作为模板`);
    if (new Set(header.filter(Boolean)).size !== header.filter(Boolean).length)
      throw Error('表头包含重复字段');
    for (const [index, values] of rows.slice(1).entries()) {
      if (++total > 10000) throw Error('单次最多导入 10000 条事项');
      const record: Record<string, unknown> = {};
      values.forEach((cell, i) => {
        const key = header[i];
        if (!key) return;
        let value = cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? '');
        if (key !== 'note' && key !== 'title') value = value.trim();
        if (value === '') {
          if (nullableKeys.has(key)) record[key] = null;
          return;
        }
        if (numberKeys.has(key)) {
          const number = Number(value.replace(/%$/, ''));
          if (!Number.isFinite(number))
            throw Error(
              `${table.name} 第 ${index + 2} 行的 ${transferColumns.find((c) => c.key === key)?.label} 不是数字`,
            );
          record[key] = number;
        } else if (key === 'done') {
          if (!['是', '否', 'true', 'false', '1', '0', '已完成', '未完成'].includes(value))
            throw Error('完成列请填写“是”或“否”');
          record[key] = ['是', 'true', '1', '已完成'].includes(value);
        } else if (key === 'status')
          record[key] =
            (
              { 未开始: 'todo', 进行中: 'doing', 受阻: 'block', 已完成: 'done' } as Record<
                string,
                string
              >
            )[value] ?? value;
        else if (key === 'priority') record[key] = value.split(/[ ·]/)[0];
        else if (dates.has(key)) {
          record[key] = value
            .replaceAll('/', '-')
            .replace(
              /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/,
              (_, y, m, d) => `${y}-${m.padStart(2, '0')}${d ? '-' + d.padStart(2, '0') : ''}`,
            );
        } else record[key] = value;
      });
      const raw = String(record.type ?? table.name).trim(),
        type = types[raw];
      if (record.type && !type) throw Error(`${table.name} 第 ${index + 2} 行层级无法识别`);
      const level = type ?? 'daily';
      record.type = level;
      record.id ??= crypto.randomUUID();
      record.title ??= '';
      if (level !== 'monthly' && record.dueDate === null) delete record.dueDate;
      if (level !== 'daily' && record.completedAt === null) delete record.completedAt;
      if (level === 'annual') record.year ??= Number(today.slice(0, 4));
      if (level === 'monthly') record.month ??= today.slice(0, 7);
      if (level === 'weekly') {
        record.startDate ??= today;
        record.endDate ??= record.startDate;
      }
      if (level === 'daily') record.date ??= today;
      // Do not copy irrelevant empty columns into strict level-specific schemas.
      items[level].push(record);
    }
  }
  if (!total) throw Error('文件中没有可导入的事项');
  return normalizeDocument({
    format: 'four-layer-workbench',
    version: 3,
    exportedAt: new Date().toISOString(),
    items,
  }).document;
}
export function delimitedRows(text: string, separator = '\t'): string[][] {
  const rows: string[][] = [],
    row: string[] = [];
  let cell = '',
    quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!cell || quoted) quoted = !quoted;
      else cell += c;
    } else if (c === separator && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((c === '\n' || c === '\r') && !quoted) {
      row.push(cell);
      rows.push(row.splice(0));
      cell = '';
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else cell += c;
  }
  if (quoted) throw Error('TXT 表格的引号未闭合');
  row.push(cell);
  rows.push(row);
  return rows;
}
export function documentText(doc: TransferDocument): string {
  return (
    '\uFEFF' +
    documentRows(doc)
      .map((row) =>
        row.map((v) => (/["\t\r\n]/.test(v) ? '"' + v.replaceAll('"', '""') + '"' : v)).join('\t'),
      )
      .join('\r\n')
  );
}
export function documentFromText(source: string, today: string): TransferDocument {
  const text = source.replace(/^\uFEFF/, '').trim();
  if (!text) throw Error('TXT 文件为空');
  const first = text.split(/\r?\n/)[0]!,
    separator = first.includes('\t') ? '\t' : ',';
  if (first.split(separator).some((v) => columnKey(v) === 'title'))
    return documentFromTables([{ name: 'TXT', rows: delimitedRows(text, separator) }], today);
  const lines = text
    .split(/\r?\n/)
    .map((v) => v.trim())
    .filter(Boolean);
  if (lines.length > 10000) throw Error('单次最多导入 10000 条事项');
  return documentFromTables(
    [{ name: '日待办', rows: [['标题'], ...lines.map((v) => [v])] }],
    today,
  );
}
