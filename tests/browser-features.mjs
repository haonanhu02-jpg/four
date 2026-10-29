import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
dotenv.config({ quiet: true });
const origin = process.argv[2] || 'http://localhost:8080';
const output = path.resolve(process.env.BROWSER_ARTIFACT_DIR || 'artifacts/admin-formats/browser');
const username = `browser-${randomUUID()}`;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await fs.mkdir(output, { recursive: true });
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-browser-'));
  const chrome = spawn(
    process.env.CHROME_PATH ||
      (process.platform === 'win32'
        ? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
        : '/usr/bin/chromium'),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--window-size=1440,1000',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
  let ws;
  try {
    let port;
    for (let i = 0; i < 150; i++) {
      try {
        port = +(await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(
          '\n',
        )[0];
        break;
      } catch {
        /* Chrome startup is asynchronous. */
      }
      await delay(100);
    }
    if (!port) throw new Error('Browser startup failed');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let sequence = 0;
    const pending = new Map();
    const browserErrors = [];
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      if (m.id) {
        const p = pending.get(m.id);
        if (p) {
          pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) p.reject(new Error(JSON.stringify(m.error)));
          else p.resolve(m.result);
        }
      } else if (m.method === 'Runtime.exceptionThrown') {
        browserErrors.push(m.params.exceptionDetails.text);
      }
    };
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('CDP timeout ' + method));
        }, 30000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails)
        throw new Error(expression + ' => ' + JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    const waitFor = async (expression, label) => {
      for (let i = 0; i < 160; i++) {
        if (await evaluate(expression)) return;
        await delay(125);
      }
      throw new Error('Timed out: ' + label + '; ' + (await evaluate('document.body.innerText')));
    };
    const clickText = async (text) => {
      await waitFor(
        `[...document.querySelectorAll('button')].some(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`,
        `button ready: ${text}`,
      );
      return evaluate(
        `(()=>{const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('missing button');e.click();})()`,
      );
    };
    const screenshot = async (name, full = true) => {
      const shot = await call('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: full,
      });
      await fs.writeFile(path.join(output, name), Buffer.from(shot.data, 'base64'));
    };
    await call('Runtime.enable');
    await call('Page.enable');
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const set = (selector, value) =>
      evaluate(
        '(()=>{const e=document.querySelector(' +
          JSON.stringify(selector) +
          ');if(!e)throw Error("missing field");e.value=' +
          JSON.stringify(value) +
          ';e.dispatchEvent(new Event("input",{bubbles:true}));})()',
      );
    const ready = () =>
      waitFor(
        '!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
        'board ready',
      );
    const persisted = () =>
      waitFor(
        '!document.querySelector(".wb-cloud")?.textContent.includes("本机保存未完成")',
        'local persisted',
      );
    const expose = async () => {
      await waitFor(
        '!!document.querySelector("#app")?.__vue_app__?.config.globalProperties.$pinia?._s.get("workbench")',
        'mounted workbench store',
      );
      return evaluate(
        'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
      );
    };
    await call('Page.navigate', { url: origin });
    await waitFor('!!document.querySelector("#username")', 'login');
    await evaluate(
      '(()=>{const e=document.querySelector("select");e.value="dark";e.dispatchEvent(new Event("change",{bubbles:true}));})()',
    );
    await clickText('先以访客使用（仅本机保存）');
    await ready();
    await expose();
    const fixtures = path.join(output, 'fixtures'),
      downloads = await fs.mkdtemp(path.join(output, 'downloads-'));
    await fs.mkdir(fixtures, { recursive: true });
    await fs.mkdir(downloads, { recursive: true });
    await call('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    const contracts = await import('../packages/contracts/dist/index.js');
    const source = contracts.sampleDocument(today);
    for (const type of ['annual', 'monthly', 'weekly', 'daily'])
      source.items[type] = source.items[type].slice(0, 1);
    source.items.monthly[0].parentId = source.items.annual[0].id;
    source.items.weekly[0].parentId = source.items.monthly[0].id;
    source.items.daily[0].parentId = source.items.weekly[0].id;
    source.items.monthly[0].month = today.slice(0, 7);
    source.items.weekly[0].startDate = today;
    source.items.weekly[0].endDate = today;
    source.items.daily[0].date = today;
    source.items.weekly[0].note = '多行说明\n第二行\t带制表符 "引号"';
    const Excel = (await import('exceljs')).default,
      workbook = new Excel.Workbook();
    const sheet = workbook.addWorksheet('工作台');
    contracts.documentRows(source).forEach((row) => sheet.addRow(row));
    const percentage = sheet
      .getRow(3)
      .getCell(contracts.transferColumns.findIndex((c) => c.key === 'progress') + 1);
    percentage.value = source.items.monthly[0].progress / 100;
    percentage.numFmt = '0.0%';
    sheet
      .getRow(2)
      .getCell(contracts.transferColumns.findIndex((c) => c.key === 'year') + 1).value = Number(
      today.slice(0, 4),
    );
    await workbook.xlsx.writeFile(path.join(fixtures, '任务.xlsx'));
    await fs.writeFile(path.join(fixtures, '普通待办.txt'), '文本待办一\n文本待办二');
    const d = await import('docx');
    await fs.writeFile(
      path.join(fixtures, '普通文档.docx'),
      await d.Packer.toBuffer(
        new d.Document({
          sections: [
            { children: [new d.Paragraph('Word 待办一'), new d.Paragraph('Word 待办二')] },
          ],
        }),
      ),
    );
    await fs.writeFile(path.join(fixtures, '损坏.xlsx'), 'not a zip');
    await fs.writeFile(
      path.join(fixtures, '空工作台.docx'),
      await d.Packer.toBuffer(
        new d.Document({
          sections: [
            {
              children: ['四层工作对齐工作台', ...Object.values(contracts.levelNames)].map(
                (v) => new d.Paragraph(v),
              ),
            },
          ],
        }),
      ),
    );
    await fs.writeFile(path.join(fixtures, '超限.txt'), Buffer.alloc(5 * 1024 * 1024 + 1, 65));
    const chooseFile = async (filename) => {
      const root = await call('DOM.getDocument');
      const node = await call('DOM.querySelector', {
        nodeId: root.root.nodeId,
        selector: '.wb-data-dialog input[type=file]',
      });
      await call('DOM.setFileInputFiles', { nodeId: node.nodeId, files: [filename] });
    };
    const importFile = async (filename, mode = 'replace') => {
      await clickText('数据管理');
      await waitFor('!!document.querySelector(".wb-data-dialog[open]")', 'data dialog');
      await evaluate(
        '(()=>{const e=document.querySelector(".wb-data-dialog select");e.value=' +
          JSON.stringify(mode) +
          ';e.dispatchEvent(new Event("change",{bubbles:true}));})()',
      );
      await chooseFile(filename);
      await waitFor('!!document.querySelector(".wb-data-preview")', 'file preview');
      await clickText(mode === 'replace' ? '确认替换' : '确认追加');
      await waitFor('!document.querySelector(".wb-data-dialog[open]")', 'import completed');
      await ready();
    };
    await clickText('数据管理');
    const closePosition = await evaluate(
      '(()=>{const h=document.querySelector(".wb-data-dialog h2").getBoundingClientRect(),b=document.querySelector(\'[aria-label="关闭数据管理"]\').getBoundingClientRect();return {right:b.left>=h.right,aligned:Math.abs(h.top-b.top)<12};})()',
    );
    if (!closePosition.right || !closePosition.aligned) throw Error('Data dialog close position');
    await screenshot('data-dialog-dark.png');
    await clickText('×');
    await importFile(path.join(fixtures, '任务.xlsx'));
    await persisted();
    const expected = await evaluate('board.localDocument()');
    assert.equal(
      expected.items.monthly[0].progress,
      source.items.monthly[0].progress,
      'Excel percentage cell',
    );
    const semantic = (doc) =>
      Object.fromEntries(
        ['annual', 'monthly', 'weekly', 'daily'].map((type) => [
          type,
          doc.items[type]
            .map((item) => ({
              ...item,
              id: undefined,
              parentId: item.parentId
                ? Object.values(doc.items)
                    .flat()
                    .find((p) => p.id === item.parentId)?.title
                : null,
              version: undefined,
            }))
            .sort((a, b) => a.title.localeCompare(b.title)),
        ]),
      );
    const exported = {};
    for (const format of ['xlsx', 'txt', 'docx', 'json']) {
      await clickText('导出数据');
      await evaluate(
        'document.querySelector(\'input[name="export-format"][value="' + format + '"]\').click()',
      );
      await clickText('下载文件');
      await waitFor(
        '!document.querySelector(".wb-export-dialog[open]")',
        'export finished ' + format,
      );
      let filename;
      for (let i = 0; i < 100; i++) {
        filename = (await fs.readdir(downloads)).find((n) => n.endsWith('.' + format));
        if (filename) break;
        await delay(100);
      }
      if (!filename) throw Error('Download missing ' + format);
      exported[format] = path.join(downloads, filename);
    }
    for (const format of ['xlsx', 'txt', 'docx', 'json']) {
      await importFile(exported[format]);
      const actual = await evaluate('board.localDocument()');
      assert.deepEqual(semantic(actual), semantic(expected), 'Roundtrip changed data: ' + format);
    }
    await importFile(path.join(fixtures, '普通待办.txt'), 'append');
    await importFile(path.join(fixtures, '普通文档.docx'), 'append');
    if ((await evaluate('board.localDocument().items.daily.length')) !== 5)
      throw Error('Unstructured text/Word not imported');
    for (const [name, message] of [
      ['损坏.xlsx', '文件'],
      ['空工作台.docx', '没有可导入'],
      ['超限.txt', '5 MiB'],
    ]) {
      await clickText('数据管理');
      await chooseFile(path.join(fixtures, name));
      await waitFor(
        'document.querySelector(".wb-data-dialog [role=alert]")?.textContent.includes(' +
          JSON.stringify(message) +
          ')',
        'invalid file rejected',
      );
      await evaluate('document.querySelector(\'[aria-label="关闭数据管理"]\').click()');
    }
    const contrast = async () =>
      evaluate(
        String.raw`(()=>{const lum=c=>{const v=c.match(/[\d.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*v[0]+.7152*v[1]+.0722*v[2]};return [...document.querySelectorAll('.wb-choice-option')].map(e=>{const s=getComputedStyle(e),a=lum(s.color),b=lum(s.backgroundColor);return(Math.max(a,b)+.05)/(Math.min(a,b)+.05)});})()`,
      );
    for (const label of ['周任务优先级', '周任务状态']) {
      await evaluate(
        'document.querySelector(\'[aria-label="' + label + '"]\').scrollIntoView({block:"center"})',
      );
      await evaluate('document.querySelector(\'[aria-label="' + label + '"]\').click()');
      await waitFor('!!document.querySelector(".wb-choice-menu")', 'custom menu');
      if ((await contrast()).some((r) => r < 4.5)) throw Error('Dark option contrast ' + label);
      await screenshot(label === '周任务优先级' ? 'priority-dark.png' : 'status-dark.png', false);
      await evaluate('document.querySelector(".wb-choice-option").click()');
    }
    await call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await clickText('数据管理');
    const mobileClose = await evaluate(
      '(()=>{const h=document.querySelector(".wb-data-dialog h2").getBoundingClientRect(),b=document.querySelector(\'[aria-label="关闭数据管理"]\').getBoundingClientRect();return b.left>=h.right&&Math.abs(h.top-b.top)<12;})()',
    );
    if (!mobileClose) throw Error('Mobile close position');
    await screenshot('data-mobile.png', false);
    await evaluate('document.querySelector(\'[aria-label="关闭数据管理"]\').click()');
    if (await evaluate('document.documentElement.scrollWidth>innerWidth+1'))
      throw Error('Mobile horizontal overflow');
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (!process.env.TEST_ADMIN_USERNAME || !process.env.TEST_ADMIN_PASSWORD)
      throw Error('Admin browser verification requires isolated TEST_ADMIN credentials');
    await clickText('登录同步');
    await waitFor('!!document.querySelector("#username")', 'admin login');
    await set('#username', process.env.TEST_ADMIN_USERNAME);
    await set('#password', process.env.TEST_ADMIN_PASSWORD);
    await evaluate('document.querySelector("form").requestSubmit()');
    await ready();
    await expose();
    await clickText('账号管理');
    await waitFor('!!document.querySelector(".wb-admin-table tbody tr")', 'admin accounts');
    await screenshot('admin-accounts.png');
    await clickText('新建账号');
    await set('[aria-label="管理账号工号"]', username);
    await set('[aria-label="管理账号密码"]', '123456');
    await clickText('确认保存');
    await waitFor('!document.querySelector(".wb-admin-editor")', 'admin create');
    const targetId = await evaluate(
      '[...document.querySelectorAll("tr[data-account-id]")].find(e=>e.textContent.includes(' +
        JSON.stringify(username) +
        ')).dataset.accountId',
    );
    const targetButton = async (text) =>
      evaluate(
        '[...document.querySelectorAll(\'tr[data-account-id="' +
          targetId +
          '"] button\')].find(e=>e.textContent.trim()===' +
          JSON.stringify(text) +
          ').click()',
      );
    await targetButton('修改');
    await set('[aria-label="管理账号工号"]', username + '-renamed');
    await clickText('确认保存');
    await waitFor('!document.querySelector(".wb-admin-editor")', 'admin rename');
    await targetButton('重置密码');
    await set('[aria-label="管理账号密码"]', '654321');
    await clickText('确认保存');
    await waitFor('!document.querySelector(".wb-admin-editor")', 'admin password');
    for (const text of ['停用', '启用', '删除']) {
      await targetButton(text);
      await clickText('确认保存');
      await waitFor('!document.querySelector(".wb-admin-editor")', 'admin ' + text);
    }
    await evaluate(
      '(()=>{const e=document.querySelector(\'[aria-label="账号状态筛选"]\');e.value="deleted";e.dispatchEvent(new Event("change",{bubbles:true}));})()',
    );
    await clickText('查询');
    await waitFor(
      '!!document.querySelector(\'tr[data-account-id="' + targetId + '"]\')',
      'deleted account visible',
    );
    await targetButton('恢复');
    await clickText('确认保存');
    await waitFor('!document.querySelector(".wb-admin-editor")', 'admin restore');
    await clickText('管理日志');
    await waitFor(
      'document.querySelector(".wb-admin-table")?.textContent.includes("恢复账号")',
      'admin audit logs',
    );
    await screenshot('admin-logs.png');
    const audit = await evaluate('document.querySelector(".wb-admin-table").textContent');
    for (const text of [
      '新建账号',
      '修改账号',
      '重置密码',
      '停用账号',
      '启用账号',
      '删除账号',
      '恢复账号',
    ])
      if (!audit.includes(text)) throw Error('Missing audit action ' + text);
    if (audit.includes('654321') || audit.includes('123456'))
      throw Error('Password leaked in audit');
    if (browserErrors.length) throw Error('Browser errors ' + JSON.stringify(browserErrors));
    const result = {
      origin,
      closeTopRight: true,
      mobileCloseTopRight: true,
      darkPriorityAndStatusContrast: true,
      formats: ['xlsx', 'docx', 'txt', 'json'],
      fourLevelRoundtrips: true,
      plainTextAndWord: true,
      malformedAndOversizeRejected: true,
      adminCrudAndAuditUi: true,
      passwordNotInAudit: true,
      browserErrors,
    };
    await fs.writeFile(path.join(output, 'browser-check.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (ws) ws.close();
    chrome.kill();
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
