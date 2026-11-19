import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { effectiveProgress, weightedProgress } from '../packages/contracts/dist/index.js';

const origin = process.argv[2] || 'http://localhost:8080';
const output = path.resolve(process.env.BROWSER_ARTIFACT_DIR || 'artifacts/five-views/ui');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const privateHttp = process.env.BROWSER_PRIVATE_HTTP_TEST === '1';
await fs.mkdir(output, { recursive: true });
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'five-views-browser-'));
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
      port = +(await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0];
      break;
    } catch {
      await delay(100);
    }
  }
  if (!port) throw Error('Browser startup failed');
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let sequence = 0;
  const pending = new Map(),
    errors = [];
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.id) {
      const p = pending.get(m.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(m.id);
        if (m.error) p.reject(Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
      }
    } else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails);
  };
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error('CDP timeout ' + method));
      }, 30000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = async (expression, label) => {
    for (let i = 0; i < 200; i++) {
      try {
        if (await evaluate(expression)) return;
      } catch (error) {
        // A reload replaces the execution context before the new page is ready.
        if (
          !/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(
            error.message,
          )
        )
          throw error;
      }
      await delay(100);
    }
    throw Error('Timed out ' + label + ' ' + (await evaluate('document.body.innerText')));
  };
  const click = async (selector) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`, selector);
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const reloadPage = async () => {
    await evaluate('window.__viewReloadPending=true');
    await call('Page.reload');
    await wait(
      '!window.__viewReloadPending&&!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
      'new document and view initialized',
    );
  };
  const clickText = async (text) => {
    const expression = `[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}&&!e.disabled)`;
    await wait(`!!(${expression})`, text);
    await evaluate(`(${expression}).click()`);
  };
  const input = async (selector, value) => {
    await evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  };
  const shot = async (name) => {
    const r = await call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    await fs.writeFile(path.join(output, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const view = async (name) => {
    await click(`[data-view=${name}]`);
    await delay(100);
  };
  const theme = async (name) => {
    await evaluate(
      `(()=>{const e=document.querySelector('[aria-label="外观主题"]');e.value=${JSON.stringify(name)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  };
  await call('Runtime.enable');
  await call('Page.enable');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call('Page.navigate', { url: origin });
  if (privateHttp) {
    await wait('!!document.querySelector("#username")', 'private HTTP login page');
    assert.equal(await evaluate('window.isSecureContext'), false);
    assert.equal(await evaluate('typeof crypto.randomUUID'), 'undefined');
    const username = `lan-${randomUUID()}`;
    await clickText('注册');
    await input('#username', username);
    await input('#password', '123456');
    await evaluate('document.querySelector("form").requestSubmit()');
    await wait(
      '!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
      'private HTTP registration',
    );
    await clickText('退出登录');
    await wait('!!document.querySelector("#username")', 'private HTTP logout');
    await input('#username', username);
    await input('#password', '123456');
    await evaluate('document.querySelector("form").requestSubmit()');
    await wait(
      '!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
      'private HTTP password login',
    );
    assert.equal(await evaluate('fetch("/api/auth/me").then(r=>r.status)'), 200);
    const savedId = await evaluate(
      'document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench").add("daily",undefined,{title:"私有 HTTP 保存验证"}).then(item=>item.id)',
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.daily.some(item=>item.id===${JSON.stringify(savedId)}))`,
      'private HTTP authenticated task persisted to server',
    );
    const projectId = await evaluate(
      'document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench").add("annual",undefined,{title:"年初项目验证",note:"初始交付物",weight:100}).then(item=>item.id)',
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.annual.some(item=>item.id===${JSON.stringify(projectId)}))`,
      'annual project synced',
    );
    await view('annual');
    await wait(
      'document.querySelector(".wb-project-changes")?.textContent.includes("最早留存记录")',
      'cloud change history visible',
    );
    await evaluate('window.confirm=()=>true;true');
    await clickText('记录年初计划基线');
    await wait(
      'document.querySelector(".wb-project-changes")?.textContent.includes("年初计划基线记录于")',
      'annual baseline recorded',
    );
    await evaluate(
      `(()=>{const b=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('workbench');b.edit(b.records[${JSON.stringify(projectId)}],{title:'变更后项目验证'});return b.save(${JSON.stringify(projectId)});})()`,
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.annual.some(item=>item.id===${JSON.stringify(projectId)}&&item.title==='变更后项目验证'))`,
      'changed project synced',
    );
    await clickText('刷新变动');
    await wait(
      'document.querySelector(".wb-project-changes")?.textContent.includes("变更后项目验证")',
      'current plan refreshed',
    );
    await click('.wb-project-comparison summary');
    assert.ok(
      await evaluate(
        'document.querySelector(".wb-project-columns").textContent.includes("年初项目验证")',
      ),
    );
    await clickText('退出登录');
    await wait('!!document.querySelector("#username")', 'return to guest entry');
  }
  await clickText('先以访客使用（仅本机保存）');
  await wait(
    '!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
    'guest ready',
  );
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  assert.deepEqual(
    await evaluate('[...document.querySelectorAll(".wb-view-tabs button")].map(e=>e.dataset.view)'),
    ['annual', 'monthly', 'weekly', 'charts', 'tree'],
  );
  await clickText('数据管理');
  await clickText('载入示例并预览');
  await wait('!!document.querySelector(".wb-data-preview")', 'preview');
  await clickText('确认追加');
  await wait('Object.values(board.records).filter(v=>v.type==="daily").length===7', 'sample');
  if (await evaluate('!!document.querySelector(".wb-data-dialog[open]")'))
    await click('[aria-label="关闭数据管理"]');
  for (const type of ['annual', 'monthly']) {
    await view(type);
    const original = await evaluate(
      'document.querySelector(".wb-goals-table tbody tr").dataset.itemId',
    );
    const originalWeight = await evaluate(`board.records[${JSON.stringify(original)}].weight`);
    const weightInput = `[data-item-id="${original}"] input[aria-label$="权重"]`;
    await input(weightInput, String(originalWeight + 10));
    await wait(
      'document.querySelector(".wb-weight-summary.over")?.textContent.includes("已超出 10%")',
      'overweight warning',
    );
    await shot(`weight-${type}-over`);
    await input(weightInput, String(originalWeight - 10));
    await wait(
      'document.querySelector(".wb-weight-summary.under")?.textContent.includes("尚差 10%")',
      'underweight reminder',
    );
    await input(weightInput, String(originalWeight));
    await wait('!!document.querySelector(".wb-weight-summary.balanced")', 'weights balanced');
    const height = await evaluate(
      'document.querySelector(".wb-goals-table tbody tr").getBoundingClientRect().height',
    );
    assert.ok(height < 130, `Goal row should be compact: ${height}`);
    await input(
      `[aria-label="搜索${type === 'annual' ? '年度目标' : '月度目标'}"]`,
      'no matching goal',
    );
    await wait('!document.querySelector(".wb-goals-table")', 'search has no matches');
    await click(`[data-add-type="${type}"]`);
    await wait(
      `!!document.querySelector('.wb-goals-table tbody tr')&&document.querySelector('.wb-goals-table tbody tr').dataset.itemId!==${JSON.stringify(original)}`,
      'new goal first',
    );
    const added = await evaluate(
      'document.querySelector(".wb-goals-table tbody tr").dataset.itemId',
    );
    await wait(
      `document.activeElement.dataset.titleId===${JSON.stringify(added)}`,
      'new goal focused',
    );
    await wait('!board.hasUnpersisted', 'new goal persisted');
    await reloadPage();
    await wait(
      '!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
      'new order after reload',
    );
    await evaluate(
      'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
    );
    await view(type);
    assert.equal(
      await evaluate('document.querySelector(".wb-goals-table tbody tr").dataset.itemId'),
      added,
    );
    await evaluate(`board.remove(board.records[${JSON.stringify(added)}])`);
  }
  await view('annual');
  assert.equal(await evaluate('document.querySelectorAll(".wb-goals-table tbody tr").length'), 4);
  assert.ok(
    await evaluate(
      'document.querySelector(".site-header").contains(document.querySelector(".workspace-heading"))',
    ),
    'Workspace context belongs beside the site brand',
  );
  assert.ok(
    await evaluate(
      'document.querySelector(".wb-section[aria-label=年度目标]").getBoundingClientRect().top<560',
    ),
    'Goal section should appear higher in the desktop viewport',
  );
  const summaryGoal = await evaluate(
    'board.add("annual",undefined,{title:"月度汇总与开始操作验证",progress:0}).then(v=>v.id)',
  );
  const summaryRow = `[data-item-id="${summaryGoal}"]`;
  await wait(`!!document.querySelector('${summaryRow}')`, 'summary test goal');
  assert.equal(
    await evaluate('document.querySelectorAll(".wb-goals-table.is-annual thead th").length'),
    7,
    'annual actions and progress mode share existing columns',
  );
  assert.ok(
    await evaluate(
      `!!document.querySelector('${summaryRow} .wb-table-title [aria-label="删除年度目标"]')`,
    ),
    'annual actions are grouped beside the title',
  );
  assert.ok(
    await evaluate(
      `!!document.querySelector('${summaryRow} .wb-table-progress [aria-label="年度进度模式"]')`,
    ),
    'progress mode is grouped with annual progress',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-month-progress="${summaryGoal}"] strong').textContent`,
    ),
    '—',
  );
  assert.ok(
    await evaluate(
      `document.querySelector('${summaryRow} [aria-label="年度目标执行状态"]').textContent.includes('未开始')`,
    ),
  );
  await click(`${summaryRow} [aria-label="年度目标执行状态"]`);
  await clickText('开始执行（1%）');
  await wait(`board.records['${summaryGoal}'].progress===1`, 'start goal at one percent');
  assert.ok(
    await evaluate(
      `document.querySelector('${summaryRow} [aria-label="年度目标执行状态"]').textContent.includes('进行中')`,
    ),
  );
  await click(`${summaryRow} [aria-label="年度目标执行状态"]`);
  await clickText('标记完成（100%）');
  await wait(`board.records['${summaryGoal}'].progress===100`, 'complete goal');
  await click(`${summaryRow} [aria-label="年度目标执行状态"]`);
  await clickText('重置为未开始（0%）');
  await click(`${summaryRow} [aria-label="年度进度模式"]`);
  await clickText('月目标自动汇总');
  await click(`${summaryRow} [aria-label="年度目标执行状态"]`);
  await clickText('切换手动并开始（1%）');
  await wait(
    `board.records['${summaryGoal}'].progressMode==='manual'&&board.records['${summaryGoal}'].progress===1`,
    'automatic goal only switches mode through explicit manual action',
  );
  await evaluate(`board.edit(board.records['${summaryGoal}'],{progressMode:'auto'})`);
  const selectedMonth = await evaluate('board.selection.month');
  const otherMonth = selectedMonth.endsWith('-01')
    ? `${selectedMonth.slice(0, 4)}-02`
    : `${selectedMonth.slice(0, 4)}-01`;
  const summaryMonths = await evaluate(`(async()=>{
    const values=[
      {title:'本月完成',month:${JSON.stringify(selectedMonth)},progress:100,weight:20},
      {title:'本月进行中',month:${JSON.stringify(selectedMonth)},progress:50,weight:80},
      {title:'其他月份',month:${JSON.stringify(otherMonth)},progress:0,weight:100},
      {title:'终止月目标',month:${JSON.stringify(selectedMonth)},progress:100,weight:100,terminated:true},
      {title:'删除月目标',month:${JSON.stringify(selectedMonth)},progress:100,weight:100}
    ];
    const ids=[];for(const value of values)ids.push((await board.add('monthly','${summaryGoal}',value)).id);
    await board.remove(board.records[ids[4]]);return ids;
  })()`);
  const monthProgressSelector = `[data-month-progress="${summaryGoal}"] strong`;
  const completionSelector = `[data-month-completion="${summaryGoal}"]`;
  await wait(
    `document.querySelector('${monthProgressSelector}').textContent==='60%'`,
    'current month weighted progress excludes other months, terminated and deleted goals',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-auto-progress="${summaryGoal}"]').textContent.trim()`,
    ),
    '30%',
  );
  for (const label of ['已完成 1 项月目标', '未完成 2 项月目标', '已终止 1 项月目标'])
    assert.equal(
      await evaluate(
        `document.querySelector('${completionSelector} [aria-label="${label}"]').textContent.trim()`,
      ),
      label.replace('月目标', ''),
      'Monthly counts use explicit visible labels: ' + label,
    );
  await evaluate(`board.edit(board.records['${summaryMonths[1]}'],{progress:100})`);
  await wait(
    `document.querySelector('${monthProgressSelector}').textContent==='100%'&&!!document.querySelector('${completionSelector} [aria-label="已完成 2 项月目标"]')`,
    'monthly completion updates without completing other months',
  );
  assert.equal(
    await evaluate(
      `document.querySelector('[data-auto-progress="${summaryGoal}"]').textContent.trim()`,
    ),
    '50%',
  );
  await evaluate(`board.edit(board.records['${summaryMonths[2]}'],{progress:100})`);
  await wait(
    `document.querySelector('${summaryRow} [aria-label="年度目标执行状态"]').textContent.includes('已完成')`,
    'automatic goal completes when all weighted months complete',
  );
  await evaluate(
    `board.edit(board.records['${summaryMonths[1]}'],{progress:50});board.edit(board.records['${summaryMonths[2]}'],{progress:0})`,
  );
  await evaluate(`board.selection.month=${JSON.stringify(otherMonth)}`);
  await wait(
    `document.querySelector('${monthProgressSelector}').textContent==='0%'`,
    'monthly column follows selected month',
  );
  await evaluate(
    `board.selection.month=${JSON.stringify(selectedMonth)};board.edit(board.records['${summaryMonths[0]}'],{weight:0});board.edit(board.records['${summaryMonths[1]}'],{weight:0})`,
  );
  await wait(
    `document.querySelector('${monthProgressSelector}').textContent==='—'`,
    'zero monthly weights do not imply progress',
  );
  await evaluate(
    `board.edit(board.records['${summaryMonths[0]}'],{weight:20});board.edit(board.records['${summaryMonths[1]}'],{weight:80})`,
  );
  await wait('!board.hasUnpersisted', 'summary edits persisted');
  await reloadPage();
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  await wait(
    `document.querySelector('${monthProgressSelector}').textContent==='60%'`,
    'monthly summary survives reload',
  );
  await evaluate(
    `(async()=>{for(const id of ${JSON.stringify(summaryMonths.slice(0, 4))})await board.remove(board.records[id]);await board.remove(board.records['${summaryGoal}']);})()`,
  );
  const goal = await evaluate(
    'JSON.parse(JSON.stringify(Object.values(board.records).find(v=>v.type==="annual"&&!v.deletedAt&&!v.archivedAt)))',
  );
  await click(`[data-item-id="${goal.id}"] [aria-label="年度目标执行状态"]`);
  await clickText('已终止');
  await wait(`board.records[${JSON.stringify(goal.id)}].terminated===true`, 'goal terminated');
  await input(`[data-item-id="${goal.id}"] [aria-label="终止原因"]`, '方向调整，保留历史');
  const goalFilter = async (label) =>
    evaluate(
      `[...document.querySelectorAll('[aria-label="年度目标完成筛选"] button')].find(e=>e.textContent.trim().startsWith(${JSON.stringify(label)})).click()`,
    );
  await goalFilter('未完成');
  await wait(
    `!document.querySelector('[data-item-id="${goal.id}"]')`,
    'terminated excluded from unfinished',
  );
  await goalFilter('已终止');
  await click(`[data-item-id="${goal.id}"] [aria-label="年度目标执行状态"]`);
  await clickText('恢复执行');
  await goalFilter('全部');
  await wait(`!!document.querySelector('[data-item-id="${goal.id}"]')`, 'goal resumed');
  await click(`[data-item-id="${goal.id}"] [aria-label="年度进度模式"]`);
  await clickText('月目标自动汇总');
  await wait(`!!document.querySelector('[data-auto-progress="${goal.id}"]')`, 'auto mode');
  const records = await evaluate('JSON.parse(JSON.stringify(Object.values(board.records)))');
  const expected = effectiveProgress({ ...goal, progressMode: 'auto' }, records);
  assert.equal(
    await evaluate(
      `document.querySelector('[data-auto-progress="${goal.id}"]').textContent.trim()`,
    ),
    `${expected}%`,
  );
  await wait(
    `document.querySelector('[data-metric="annual"] strong').textContent.trim()===${JSON.stringify(
      `${weightedProgress(
        records.filter((v) => v.type === 'annual' && !v.deletedAt && !v.archivedAt),
        (v) => effectiveProgress(v, records),
      )}%`,
    )}`,
    'updated summary',
  );
  await click(`[data-item-id="${goal.id}"] [aria-label="年度进度模式"]`);
  await clickText('手动填写');
  assert.equal(await evaluate(`board.records[${JSON.stringify(goal.id)}].progress`), goal.progress);
  await click(`[data-item-id="${goal.id}"] [aria-label="年度进度模式"]`);
  await clickText('月目标自动汇总');
  await view('weekly');
  const month = await evaluate(
    'board.add("monthly",undefined,{title:"待排本周的月目标"}).then(v=>v.id)',
  );
  await wait(
    `!!document.querySelector('[data-unplanned-month="${month}"]')`,
    'monthly goal automatically in week view',
  );
  const plannedWeek = await evaluate(
    `board.add('weekly',${JSON.stringify(month)},{title:'为月目标安排本周'}).then(v=>v.id)`,
  );
  await wait(
    `!document.querySelector('[data-unplanned-month="${month}"]')`,
    'scheduled monthly goal leaves reminder',
  );
  await evaluate(
    `board.remove(board.records[${JSON.stringify(plannedWeek)}]).then(()=>board.remove(board.records[${JSON.stringify(month)}]))`,
  );
  const orphan = await evaluate(
    'board.add("daily",undefined,{parentId:null,title:"未挂周任务验证"}).then(v=>v.id)',
  );
  await wait(
    'document.querySelector(".wb-unlinked-days h3")?.textContent.includes("未挂周任务的待办 1 条")',
    'orphan count',
  );
  await click('.wb-unlinked-days button');
  await wait(
    `!!document.querySelector('.wb-unlinked-days [data-item-id="${orphan}"]')`,
    'orphan expands',
  );
  await evaluate(`board.remove(board.records[${JSON.stringify(orphan)}])`);
  await clickText('全部收起');
  assert.equal(await evaluate('document.querySelectorAll(".wb-embedded-days").length'), 0);
  await clickText('全部展开');
  assert.equal(await evaluate('document.querySelectorAll(".wb-daily-compact").length'), 7);
  const day = await evaluate(
    'JSON.parse(JSON.stringify(Object.values(board.records).find(v=>v.type==="daily")))',
  );
  await input(`[data-item-id="${day.id}"] [aria-label="每日工作时间"]`, '09:30–11:00');
  await input(
    `[data-item-id="${day.id}"] [aria-label="每日工作情况"]`,
    '保留工作情况，跨视图可查看',
  );
  await wait('!board.hasUnpersisted', 'durable work notes');
  await view('tree');
  await clickText('日');
  await wait('document.querySelectorAll(".wb-tree-leaf").length===7', 'expanded daily leaves');
  await input('[aria-label="搜索层级清单"]', '保留工作情况');
  await wait('document.querySelectorAll(".wb-tree-leaf").length===1', 'tree search and path');
  await click(`[data-tree-id="${day.id}"]`);
  await wait('!!document.querySelector(".wb-detail-dialog[open]")', 'tree opens editable detail');
  assert.equal(
    await evaluate('document.querySelector(".wb-detail-dialog [aria-label=每日工作情况]").value'),
    '保留工作情况，跨视图可查看',
  );
  await click('[aria-label="关闭事项详情"]');
  await input('[aria-label="搜索层级清单"]', '');
  await view('charts');
  const finalRecords = await evaluate('JSON.parse(JSON.stringify(Object.values(board.records)))');
  assert.equal(
    await evaluate('document.querySelector("[data-chart-metric=annual]").textContent'),
    `${weightedProgress(
      finalRecords.filter((v) => v.type === 'annual' && !v.deletedAt && !v.archivedAt),
      (v) => effectiveProgress(v, finalRecords),
    )}%`,
  );
  const outsideWeek = await evaluate(
    `board.add('weekly',undefined,{startDate:'2000-01-01',endDate:'2000-01-07',title:'区间外来源'}).then(item=>item.id)`,
  );
  const outsideDay = await evaluate(
    `board.add('daily',${JSON.stringify(outsideWeek)},{date:board.selection.date,title:'本区间不能遗漏的待办'}).then(item=>item.id)`,
  );
  await view('weekly');
  await wait(
    `!!document.querySelector('[data-week-group="${outsideWeek}"] .wb-external-week-source')`,
    'out-of-range source is retained',
  );
  await wait(
    `!!document.querySelector('[data-item-id="${outsideDay}"]')`,
    'current-period daily item remains visible',
  );
  const layouts = [];
  for (const width of [1440, 1024, 390]) {
    await call('Emulation.setDeviceMetricsOverride', {
      width,
      height: width === 390 ? 844 : 1000,
      deviceScaleFactor: 1,
      mobile: width === 390,
    });
    for (const color of ['light', 'dark']) {
      await theme(color);
      for (const name of ['annual', 'monthly', 'weekly', 'charts', 'tree']) {
        await view(name);
        const size = await evaluate(
          '({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,inner:innerWidth})',
        );
        layouts.push({ width, theme: color, view: name, ...size });
        assert.ok(
          size.scroll <= width + 1,
          `Horizontal overflow ${JSON.stringify(layouts.at(-1))}`,
        );
        assert.equal(size.inner, width, 'Viewport expanded to fit overflowing content');
        if (name === 'annual' && width >= 1024) {
          const overflowingControls = await evaluate(`
            [...document.querySelectorAll('.wb-goals-table.is-annual td input, .wb-goals-table.is-annual td .wb-choice-trigger, .wb-month-counts > span')]
              .filter(e=>{const r=e.getBoundingClientRect(),c=e.closest('td').getBoundingClientRect();return r.left<c.left-1||r.right>c.right+1;})
              .map(e=>e.getAttribute('aria-label')||e.textContent.trim())
          `);
          assert.deepEqual(overflowingControls, [], 'Annual controls fit their columns');
        }
        await shot(`${name}-${color}-${width}`);
      }
    }
  }
  await view('weekly');
  await wait('!board.hasUnpersisted', 'persist before reload');
  await reloadPage();
  await wait(
    '!!document.querySelector(".workbench")&&!document.querySelector(".wb-loading")',
    'reloaded',
  );
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  assert.equal(await evaluate('board.view'), 'weekly');
  assert.equal(await evaluate(`board.records[${JSON.stringify(day.id)}].time`), '09:30–11:00');
  assert.equal(await evaluate(`board.records[${JSON.stringify(goal.id)}].progressMode`), 'auto');
  assert.equal(await evaluate(`board.records[${JSON.stringify(goal.id)}].progress`), goal.progress);
  assert.deepEqual(errors, []);
  const report = {
    passed: true,
    newGoalsFirstAfterReload: true,
    goalWeightWarnings: true,
    compactGoalRows: true,
    privateHttp,
    fiveViews: true,
    autoModePreservesManual: true,
    nestedDays: true,
    timeAndNotesPersist: true,
    treeSearchAndDetail: true,
    matchingWeightedMetrics: true,
    outOfRangeWeeklySourceRetained: true,
    layouts,
    browserErrors: errors,
  };
  await fs.writeFile(path.join(output, 'browser-check.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  ws?.close();
  chrome.kill();
}
