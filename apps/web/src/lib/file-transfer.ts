import {
  normalizeDocument,
  documentRows,
  documentText,
  documentFromText,
  documentFromTables,
  columnKey,
  levelNames,
  type TransferDocument,
  type WorkItemType,
} from '@workbench/contracts';
import { todayIn } from './dates';
export type FileFormat = 'json' | 'xlsx' | 'docx' | 'txt';
const maxFile = 5 * 1024 * 1024;
// Check declared expansion before passing an Office ZIP to a document parser.
function officeSize(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  let end = -1;
  for (let p = buffer.byteLength - 22; p >= Math.max(0, buffer.byteLength - 65557); p--) {
    if (view.getUint32(p, true) === 0x06054b50) {
      end = p;
      break;
    }
  }
  if (end < 0) throw Error('Office 文件损坏或不是有效的 docx/xlsx 文件');
  const count = view.getUint16(end + 10, true),
    offset = view.getUint32(end + 16, true);
  if (count === 65535 || offset === 0xffffffff || count > 5000)
    throw Error('Office 文件过于复杂，请精简后导入');
  let p = offset,
    size = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.byteLength || view.getUint32(p, true) !== 0x02014b50)
      throw Error('Office 文件目录损坏');
    if (view.getUint16(p + 8, true) & 1) throw Error('请先解除文件密码保护');
    size += view.getUint32(p + 24, true);
    if (size > 20 * 1024 * 1024) throw Error('Office 文件解压后不能超过 20 MiB');
    p +=
      46 +
      view.getUint16(p + 28, true) +
      view.getUint16(p + 30, true) +
      view.getUint16(p + 32, true);
  }
}
const toBuffer = (value: unknown): ArrayBuffer => {
  const bytes = new Uint8Array(value as ArrayBuffer);
  return bytes.slice().buffer;
};
export async function readTransferFile(file: File, today: string): Promise<TransferDocument> {
  if (file.size > maxFile) throw Error('文件不能超过 5 MiB');
  const ext = file.name.split('.').pop()?.toLowerCase();
  if (ext === 'json') {
    let raw;
    try {
      raw = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
    } catch {
      throw Error('文件不是有效的 JSON');
    }
    return normalizeDocument(raw).document;
  }
  if (ext === 'txt') {
    const buffer = await file.arrayBuffer();
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    } catch {
      text = new TextDecoder('gb18030', { fatal: true }).decode(buffer);
    }
    return documentFromText(text, today);
  }
  if (ext === 'doc' || ext === 'xls')
    throw Error('请先用 Word / Excel 将旧版文件另存为 .docx / .xlsx，再选择导入');
  if (ext !== 'xlsx' && ext !== 'docx')
    throw Error('请选择 Word（.docx）、Excel（.xlsx）、TXT 或 JSON 文件');
  const buffer = await file.arrayBuffer();
  officeSize(buffer);
  if (ext === 'xlsx') {
    const Excel = await import('exceljs'),
      workbook = new Excel.Workbook();
    await workbook.xlsx.load(buffer);
    const tables: { name: string; rows: unknown[][] }[] = [];
    for (const sheet of workbook.worksheets) {
      if (sheet.rowCount > 10001 || sheet.columnCount > 100)
        throw Error('Excel 行列过多，单次最多 10000 条事项、100 列');
      const rows: unknown[][] = [];
      sheet.eachRow((row) => {
        const cells: unknown[] = [];
        for (let i = 1; i <= sheet.columnCount; i++) {
          const cell = row.getCell(i),
            value = cell.value;
          if (value && typeof value === 'object' && !(value instanceof Date)) {
            if ('richText' in value) cells.push(value.richText.map((v) => v.text).join(''));
            else if ('text' in value) cells.push(value.text);
            else if ('result' in value && value.result !== undefined) cells.push(value.result);
            else throw Error('Excel 公式没有已计算的结果，请在 Excel 中计算并保存后导入');
          } else if (
            typeof value === 'number' &&
            (cell.numFmt ?? '').includes('%') &&
            ['progress', 'weight'].includes(columnKey(rows[0]?.[i - 1]) ?? '')
          )
            cells.push(value * 100);
          else cells.push(value);
        }
        rows.push(cells);
      });
      if (rows.length) tables.push({ name: sheet.name, rows });
    }
    return documentFromTables(tables, today);
  }
  const mammoth = await import('mammoth'),
    result = await mammoth.convertToHtml({ arrayBuffer: buffer });
  const html = new DOMParser().parseFromString(result.value, 'text/html');
  html.querySelectorAll('br').forEach((br) => br.replaceWith(html.createTextNode('\n')));
  const cellText = (cell: Element) => {
    const blocks = [...cell.querySelectorAll('p')];
    return blocks.length
      ? blocks.map((v) => v.textContent ?? '').join('\n')
      : (cell.textContent ?? '');
  };
  const tables = [...html.querySelectorAll('table')].map((table, index) => {
    const rows = [...table.querySelectorAll('tr')].map((row) => [...row.children].map(cellText));
    if (rows[0]?.[0] === '字段' && rows[0]?.[1] === '内容')
      return {
        name: 'Word',
        rows: [rows.slice(1).map((r) => r[0]), rows.slice(1).map((r) => r[1])],
      };
    return { name: 'Word 表格 ' + (index + 1), rows };
  });
  if (tables.length) return documentFromTables(tables, today);
  const blocks = [...html.querySelectorAll('p,h1,h2,h3,h4,h5,h6,li')]
    .filter((v) => !v.querySelector('p,h1,h2,h3,h4,h5,h6,li'))
    .map((v) => v.textContent ?? '')
    .filter((v) => v.trim());
  const headings = new Set(['四层工作对齐工作台', ...Object.values(levelNames)]);
  if (blocks[0] === '四层工作对齐工作台' && blocks.every((v) => headings.has(v)))
    throw Error('Word 文件没有可导入的事项');
  return documentFromText(blocks.join('\n'), today);
}
export async function transferBlob(doc: TransferDocument, format: FileFormat): Promise<Blob> {
  if (format === 'json')
    return new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  if (format === 'txt') return new Blob([documentText(doc)], { type: 'text/plain;charset=utf-8' });
  if (format === 'xlsx') {
    const Excel = await import('exceljs'),
      workbook = new Excel.Workbook();
    for (const type of ['annual', 'monthly', 'weekly', 'daily'] as const) {
      const sheet = workbook.addWorksheet(levelNames[type]);
      const rows = documentRows({
        ...doc,
        items: { annual: [], monthly: [], weekly: [], daily: [], [type]: doc.items[type] },
      });
      rows.forEach((row) => sheet.addRow(row));
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.columns.forEach((c, index) => {
        c.width = index === 3 ? 38 : index === 4 ? 58 : 20;
      });
      sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
      sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4361EE' } };
      sheet.eachRow((row) => {
        row.alignment = { vertical: 'top', wrapText: true };
      });
      sheet.autoFilter = { from: 'A1', to: { row: rows.length, column: rows[0]!.length } };
    }
    return new Blob([toBuffer(await workbook.xlsx.writeBuffer())], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
  }
  const d = await import('docx'),
    children: (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] = [
      new d.Paragraph({ text: '四层工作对齐工作台', heading: d.HeadingLevel.TITLE }),
    ];
  for (const type of ['annual', 'monthly', 'weekly', 'daily'] as WorkItemType[]) {
    children.push(new d.Paragraph({ text: levelNames[type], heading: d.HeadingLevel.HEADING_1 }));
    const rows = documentRows({
        ...doc,
        items: { annual: [], monthly: [], weekly: [], daily: [], [type]: doc.items[type] },
      }),
      headers = rows[0]!;
    for (const row of rows.slice(1)) {
      children.push(
        new d.Paragraph({ text: row[3] || '未命名事项', heading: d.HeadingLevel.HEADING_2 }),
      );
      const pairs: [string, string][] = [
        ['字段', '内容'],
        ...row.map((v, i) => [headers[i]!, v] as [string, string]).filter((v) => v[1] !== ''),
      ];
      children.push(
        new d.Table({
          width: { size: 100, type: d.WidthType.PERCENTAGE },
          rows: pairs.map(
            (pair, index) =>
              new d.TableRow({
                tableHeader: index === 0,
                children: pair.map(
                  (text) =>
                    new d.TableCell({
                      children: [
                        new d.Paragraph({
                          children: text
                            .split('\n')
                            .flatMap((line, i) => [
                              new d.TextRun({ text: line, break: i ? 1 : 0, bold: index === 0 }),
                            ]),
                        }),
                      ],
                    }),
                ),
              }),
          ),
        }),
      );
    }
  }
  return d.Packer.toBlob(new d.Document({ sections: [{ children }] }));
}
export async function downloadTransfer(doc: TransferDocument, label: string, format: FileFormat) {
  const blob = await transferBlob(doc, format),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = `四层工作台-${label}-${todayIn()}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
