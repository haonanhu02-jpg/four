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
  const shot = async (name, selector) => {
    const clip = selector
      ? await evaluate(
          `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height,scale:1};})()`,
        )
      : undefined;
    const r = await call('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      ...(clip ? { clip } : {}),
    });
    await fs.writeFile(path.join(output, name + '.png'), Buffer.from(r.data, 'base64'));
  };
  const view = async (name) => {
    await click(`[data-view=${name}]`);
    await delay(100);
  };
  const removeGeneratedWeeks = (monthId) =>
    evaluate(
      `(async()=>{for(const w of Object.values(board.records).filter(v=>v.type==='weekly'&&v.parentId===${JSON.stringify(monthId)}&&!v.deletedAt))await board.remove(w);})()`,
    );
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
    const cloudMonth = await evaluate(
      `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('workbench').add('monthly','${projectId}',{title:'自动生成周任务云端验证'}).then(item=>item.id)`,
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.weekly.filter(w=>w.parentId==='${cloudMonth}'&&w.title==='自动生成周任务云端验证').length===1)`,
      'monthly and generated weekly task both sync to server',
    );
    await evaluate(
      `(()=>{const b=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('workbench');b.edit(b.records['${cloudMonth}'],{title:'月目标更新同步周标题'});return b.persistAll();})()`,
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.weekly.some(w=>w.parentId==='${cloudMonth}'&&w.title==='月目标更新同步周标题'))`,
      'automatic weekly title sync reaches server',
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
    const cloudCascadeDay = await evaluate(
      `(async()=>{const b=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('workbench');const w=Object.values(b.records).find(v=>v.type==='weekly'&&v.parentId==='${cloudMonth}'&&!v.deletedAt);return (await b.add('daily',w.id,{title:'级联删除云端日待办'})).id})()`,
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.daily.some(v=>v.id==='${cloudCascadeDay}'))`,
      'cascade child reaches cloud',
    );
    await evaluate(
      `(()=>{const b=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('workbench');return b.remove(b.records['${projectId}'],true)})()`,
    );
    await wait(
      `fetch('/api/data/export').then(r=>r.json()).then(d=>d.items.annual.some(v=>v.id==='${projectId}'&&v.deletedAt)&&d.items.monthly.some(v=>v.id==='${cloudMonth}'&&v.deletedAt)&&d.items.weekly.filter(v=>v.parentId==='${cloudMonth}').every(v=>v.deletedAt)&&d.items.daily.some(v=>v.id==='${cloudCascadeDay}'&&v.deletedAt)&&d.items.daily.some(v=>v.id==='${savedId}'&&!v.deletedAt))`,
      'cascade sync deletes linked tree while preserving independent daily item',
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
    ['annual', 'monthly', 'weekly', 'daily', 'charts', 'tree'],
  );
  // Follow the same UI path as an annual goal that has not started yet.
  await view('annual');
  await click('[data-add-type="annual"]');
  await wait('!!document.querySelector(".wb-goals-table tbody tr")', 'new annual goal');
  const inactiveAnnual = await evaluate(
    'document.querySelector(".wb-goals-table tbody tr").dataset.itemId',
  );
  await input(`[data-title-id="${inactiveAnnual}"]`, '未开始年度目标拆月验证');
  await click(`[data-item-id="${inactiveAnnual}"] [aria-label="年度进度模式"]`);
  await clickText('月目标自动汇总');
  await click(`[data-item-id="${inactiveAnnual}"] .wb-annual-row-actions .wb-link`);
  await wait(
    'board.view==="monthly"&&!!document.querySelector(".wb-goals-table tbody tr")',
    'annual goal split into monthly goal',
  );
  const splitMonth = await evaluate(
    'document.querySelector(".wb-goals-table tbody tr").dataset.itemId',
  );
  await input(`[data-title-id="${splitMonth}"]`, '从未开始年度拆出的月目标');
  assert.equal(await evaluate(`board.records['${splitMonth}'].parentId`), inactiveAnnual);
  assert.equal(await evaluate(`board.records['${inactiveAnnual}'].progress`), 0);
  assert.equal(await evaluate(`board.records['${splitMonth}'].progress`), 0);
  await view('weekly');
  const automaticWeek = await evaluate(
    `Object.values(board.records).find(v=>v.type==='weekly'&&v.parentId==='${splitMonth}'&&!v.deletedAt).id`,
  );
  await wait(
    `document.querySelector('[data-title-id="${automaticWeek}"]')?.value==='从未开始年度拆出的月目标'`,
    'monthly creation generates a named weekly task',
  );
  await input(`[data-item-id="${automaticWeek}"] [aria-label="周任务进度"]`, '37');
  await wait(
    `board.records['${automaticWeek}'].progress===37&&board.records['${automaticWeek}'].status==='doing'`,
    'weekly numeric progress derives doing state',
  );
  await wait(
    'document.querySelector("[data-metric=weekly] strong").textContent.trim()==="37%"',
    'weekly metric uses actual percentage',
  );
  await input(`[data-item-id="${automaticWeek}"] [aria-label="周任务进度"]`, '100');
  await wait(
    `document.querySelector('[data-item-id="${automaticWeek}"]').classList.contains('is-complete')&&board.records['${automaticWeek}'].status==='done'`,
    'one hundred percent completes weekly task',
  );
  await input(`[data-item-id="${automaticWeek}"] [aria-label="周任务进度"]`, '0');
  await wait(
    `board.records['${automaticWeek}'].status==='todo'`,
    'zero progress resets weekly state',
  );
  assert.equal(
    await evaluate(
      'Object.values(board.records).filter(v=>v.type==="weekly"&&!v.deletedAt).length',
    ),
    1,
    'monthly creation generates exactly one weekly task',
  );
  const cascadeDay = await evaluate(
    `board.add('daily','${automaticWeek}',{title:'日完成驱动四层验证',done:false}).then(v=>v.id)`,
  );
  await evaluate(
    `board.edit(board.records['${inactiveAnnual}'],{progressMode:'auto'});board.edit(board.records['${cascadeDay}'],{done:true})`,
  );
  await wait(
    `document.querySelector('[data-item-id="${automaticWeek}"] .wb-progress strong').textContent.trim()==='100%'`,
    'daily completion immediately completes weekly progress',
  );
  await view('monthly');
  await wait(
    `document.querySelector('[data-item-id="${splitMonth}"] .wb-table-progress strong').textContent.trim()==='100%'`,
    'weekly completion immediately completes monthly progress',
  );
  await view('annual');
  await wait(
    `document.querySelector('[data-auto-progress="${inactiveAnnual}"]').textContent.trim()==='100%'`,
    'daily completion reaches weighted annual progress',
  );
  await wait('!board.hasUnpersisted', 'cascade completion persisted');
  await reloadPage();
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  await wait(
    `document.querySelector('[data-auto-progress="${inactiveAnnual}"]').textContent.trim()==='100%'`,
    'cascade survives reload',
  );
  await evaluate(`board.edit(board.records['${cascadeDay}'],{done:false})`);
  await wait(
    `document.querySelector('[data-auto-progress="${inactiveAnnual}"]').textContent.trim()==='0%'`,
    'undo daily completion updates ancestors',
  );
  await evaluate(`board.remove(board.records['${cascadeDay}'])`);
  await view('weekly');
  await shot('unstarted-annual-split-month-in-week', `[data-week-group="${automaticWeek}"]`);
  await input(`[data-title-id="${automaticWeek}"]`, '周任务独立改名');
  await view('monthly');
  await input(`[data-title-id="${splitMonth}"]`, '月目标再次改名');
  await wait('!board.hasUnpersisted', 'automatic creation and renaming persisted');
  await reloadPage();
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  assert.equal(await evaluate(`board.records['${automaticWeek}'].title`), '周任务独立改名');
  assert.equal(
    await evaluate(
      'Object.values(board.records).filter(v=>v.type==="weekly"&&!v.deletedAt).length',
    ),
    1,
  );
  await removeGeneratedWeeks(splitMonth);
  await evaluate(
    `board.remove(board.records['${splitMonth}']).then(()=>board.remove(board.records['${inactiveAnnual}']))`,
  );
  const failedPair = await evaluate(`(async()=>{
    const original=IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put=function(row,...args){if(this.name==='items'&&row.item?.type==='weekly')throw new DOMException('test quota failure','QuotaExceededError');return original.call(this,row,...args);};
    try{const m=await board.add('monthly',undefined,{title:'原子保存失败重试验证'});return {month:m.id,week:Object.values(board.records).find(w=>w.type==='weekly'&&w.parentId===m.id).id};}
    finally{IDBObjectStore.prototype.put=original;}
  })()`);
  assert.equal(await evaluate('board.hasUnpersisted'), true);
  const cachedPair = () =>
    evaluate(
      `new Promise((resolve,reject)=>{const r=indexedDB.open('four-layer-workbench');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result,q=db.transaction('items').objectStore('items').getAll();q.onsuccess=()=>{db.close();resolve(q.result.filter(v=>[${JSON.stringify(failedPair.month)},${JSON.stringify(failedPair.week)}].includes(v.item.id)).length);};};})`,
    );
  assert.equal(
    await cachedPair(),
    0,
    'failure writing generated week rolls back monthly creation too',
  );
  await evaluate('board.retryLocal()');
  assert.equal(await evaluate('board.hasUnpersisted'), false);
  assert.equal(await cachedPair(), 2, 'retry saves the complete monthly-weekly pair');
  await removeGeneratedWeeks(failedPair.month);
  await evaluate(`board.remove(board.records['${failedPair.month}']);board.error='';true`);
  await clickText('数据管理');
  await clickText('载入示例并预览');
  await wait('!!document.querySelector(".wb-data-preview")', 'preview');
  await clickText('确认追加');
  await wait(
    'Object.values(board.records).filter(v=>v.type==="daily"&&!v.deletedAt).length===7',
    'sample',
  );
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
    if (type === 'monthly') await removeGeneratedWeeks(added);
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
    await board.remove(board.records[ids[4]]);for(const w of Object.values(board.records).filter(v=>v.type==='weekly'&&ids.includes(v.parentId)&&!v.deletedAt))await board.remove(w);return ids;
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
  for (const id of summaryMonths) await removeGeneratedWeeks(id);
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
  const weeklyTotal = () =>
    evaluate(
      'Object.values(board.records).filter(v=>v.type==="weekly"&&!v.deletedAt&&!v.archivedAt).length',
    );
  const initialWeekCount = await weeklyTotal();
  const month = await evaluate(
    'board.add("monthly",undefined,{title:"待排本周的月目标"}).then(v=>v.id)',
  );
  await removeGeneratedWeeks(month);
  await wait(
    `!!document.querySelector('[data-unplanned-month="${month}"]')`,
    'monthly goal automatically in week view',
  );
  assert.ok(
    await evaluate(
      `document.querySelector('[data-unplanned-month="${month}"]').getClientRects().length>0`,
    ),
    'unplanned monthly goal is expanded by default',
  );
  assert.equal(
    await weeklyTotal(),
    initialWeekCount,
    'showing monthly reminders does not create weekly records',
  );
  await click('[data-generate-unplanned]');
  await wait(
    `!document.querySelector('[data-unplanned-month="${month}"]')`,
    'scheduled monthly goal leaves reminder',
  );
  const plannedWeek = await evaluate(
    `Object.values(board.records).find(v=>v.type==='weekly'&&v.parentId==='${month}'&&!v.deletedAt).id`,
  );
  assert.equal(await weeklyTotal(), initialWeekCount + 1);
  await evaluate('Promise.all([board.arrangeUnplannedMonths(),board.arrangeUnplannedMonths()])');
  assert.equal(
    await weeklyTotal(),
    initialWeekCount + 1,
    'repeated backfill skips existing weekly tasks',
  );
  await input(`[data-item-id="${plannedWeek}"] [aria-label="周任务标题"]`, '为月目标安排本周');
  await view('monthly');
  await view('weekly');
  assert.equal(
    await weeklyTotal(),
    initialWeekCount + 1,
    'revisiting weekly view does not create duplicates',
  );
  const pendingMonth = await evaluate(
    'board.add("monthly",undefined,{title:"仍待安排的月目标"}).then(v=>v.id)',
  );
  await removeGeneratedWeeks(pendingMonth);
  const orphans = await evaluate(`(async()=>{
    const ids=[];
    for(const [title,done] of [['未挂周任务验证一',false],['未挂周任务验证二',false],['已完成的未挂待办',true]])
      ids.push((await board.add('daily',undefined,{parentId:null,title,done})).id);
    return ids;
  })()`);
  await wait(
    'document.querySelector(".wb-unlinked-days h3")?.textContent.includes("未挂周任务的日待办 3 条")',
    'three orphan daily tasks counted',
  );
  assert.ok(
    await evaluate(
      'document.querySelector(".wb-weekly-execution").lastElementChild.classList.contains("wb-unlinked-days")',
    ),
    'unlinked daily tasks stay at the bottom after monthly reminders',
  );
  assert.equal(
    await evaluate('document.querySelector(".wb-unlinked-toggle").getAttribute("aria-expanded")'),
    'false',
  );
  assert.ok(
    await evaluate(
      'document.querySelector(".wb-unlinked-toggle").textContent.includes("今日剩 2")',
    ),
  );
  await shot('weekly-unlinked-three-collapsed', '.wb-unlinked-days');
  await shot('weekly-unplanned-months', '.wb-unplanned-months');
  await click('[aria-label="展开未挂周任务的日待办"]');
  await wait(
    'document.querySelectorAll(".wb-unlinked-days .wb-daily-compact").length===3',
    'all three orphan contents expand',
  );
  for (const [i, title] of ['未挂周任务验证一', '未挂周任务验证二', '已完成的未挂待办'].entries())
    assert.equal(
      await evaluate(
        `document.querySelector('.wb-unlinked-days [data-title-id="${orphans[i]}"]').value`,
      ),
      title,
    );
  await shot('weekly-unlinked-three-expanded', '.wb-unlinked-days');
  await call('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  for (const color of ['light', 'dark']) {
    await theme(color);
    assert.ok(
      await evaluate('document.documentElement.scrollWidth<=390'),
      'expanded orphan panel fits mobile width',
    );
    await shot(`weekly-unlinked-expanded-${color}-390`, '.wb-unlinked-days');
  }
  await call('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await theme('light');
  await click(`.wb-unlinked-days [data-item-id="${orphans[0]}"] [aria-label="关联周任务"]`);
  const weekOption = `[...document.querySelectorAll('.wb-unlinked-days [data-item-id="${orphans[0]}"] .wb-option-list button')].find(e=>e.querySelector('span')?.textContent==='为月目标安排本周')`;
  await wait(`!!(${weekOption})`, 'weekly parent option available');
  await evaluate(`(${weekOption}).click()`);
  await wait(
    `board.records['${orphans[0]}'].parentId==='${plannedWeek}'&&document.querySelector('.wb-unlinked-days h3').textContent.includes('2 条')`,
    'linking a daily task updates orphan count',
  );
  assert.ok(
    await evaluate(
      'document.querySelector(".wb-unlinked-toggle").textContent.includes("今日剩 1")',
    ),
  );
  await click(`.wb-unlinked-days [data-item-id="${orphans[1]}"] [aria-label="日待办完成状态"]`);
  await clickText('已完成');
  await wait(
    'document.querySelector(".wb-unlinked-toggle").textContent.includes("今日剩 0")',
    'completing a task updates remaining count',
  );
  await wait('!board.hasUnpersisted', 'weekly planning and links persisted');
  await reloadPage();
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  assert.equal(await weeklyTotal(), initialWeekCount + 1);
  assert.equal(await evaluate(`board.records['${orphans[0]}'].parentId`), plannedWeek);
  assert.ok(
    await evaluate('document.querySelector(".wb-unlinked-days h3").textContent.includes("2 条")'),
  );
  await evaluate(`(async()=>{
    for(const id of ${JSON.stringify(orphans)})await board.remove(board.records[id]);
    for(const id of ${JSON.stringify([plannedWeek, month, pendingMonth])})await board.remove(board.records[id]);
  })()`);
  if (
    !(await evaluate(
      '[...document.querySelectorAll("button")].some(e=>e.textContent.trim()==="全部收起")',
    ))
  )
    await clickText('全部展开');
  await clickText('全部收起');
  assert.equal(await evaluate('document.querySelectorAll(".wb-embedded-days").length'), 0);
  await clickText('全部展开');
  assert.equal(await evaluate('document.querySelectorAll(".wb-daily-compact").length'), 7);
  const day = await evaluate(
    'JSON.parse(JSON.stringify(board.records[document.querySelector(".wb-daily-compact").dataset.itemId]))',
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
  const previousDate = await evaluate('board.selection.date');
  await view('daily');
  await evaluate(
    `(()=>{const e=document.querySelector('[aria-label="查看日期"]');e.value=${JSON.stringify(day.date)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(
    `!!document.querySelector('.wb-daily-execution [data-item-id="${day.id}"]')`,
    'daily view follows selected date',
  );
  const sources = await evaluate(
    `board.lineage(board.records['${day.id}']).map(v=>({id:v.id,type:v.type,title:v.title}))`,
  );
  assert.equal(sources.length, 3, 'daily source includes weekly, monthly and annual levels');
  for (const parent of sources) {
    const source = `.wb-daily-execution [data-item-id="${day.id}"] [data-source-type="${parent.type}"]`;
    assert.equal(
      await evaluate(`document.querySelector(${JSON.stringify(source)}).textContent.trim()`),
      parent.title,
    );
    await click(source);
    await wait(
      `!!document.querySelector('.wb-detail-dialog[open] [data-item-id="${parent.id}"]')`,
      'source opens original editable record',
    );
    await evaluate('document.querySelector(".wb-detail-dialog").dispatchEvent(new Event("close"))');
    assert.ok(
      await evaluate(
        `!!document.querySelector('.wb-detail-dialog[open] [data-item-id="${parent.id}"]')`,
      ),
      'a delayed close event from an earlier source must not clear the reopened detail',
    );
    await click('[aria-label="关闭事项详情"]');
  }
  await input('[aria-label="搜索日待办"]', sources[2].title);
  assert.ok(
    await evaluate(`!!document.querySelector('.wb-daily-execution [data-item-id="${day.id}"]')`),
  );
  await input('[aria-label="搜索日待办"]', 'no matching daily item');
  await wait(
    '!document.querySelector(".wb-daily-execution .wb-item")',
    'daily search filters records',
  );
  await click('.wb-daily-execution [data-add-type="daily"]');
  await wait(
    'board.view==="daily"&&!!document.activeElement.dataset.titleId&&document.querySelector(".wb-daily-execution").contains(document.activeElement)',
    'daily creation stays in daily view',
  );
  const newDaily = await evaluate('document.activeElement.dataset.titleId');
  assert.ok(newDaily);
  await input(`[data-title-id="${newDaily}"]`, '日待办独立视图创建');
  await evaluate(`board.edit(board.records['${newDaily}'],{parentId:null})`);
  await wait(
    `document.querySelectorAll('.wb-daily-execution [data-item-id="${newDaily}"] .wb-daily-sources .wb-unlinked').length===3`,
    'missing sources are explicitly labelled',
  );
  await wait('!board.hasUnpersisted', 'daily view changes persisted');
  await reloadPage();
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  assert.equal(await evaluate('board.view'), 'daily');
  assert.equal(await evaluate(`board.records['${newDaily}'].title`), '日待办独立视图创建');
  // Selection resets to today on startup; explicitly revisit the fixture date.
  await evaluate(
    `(()=>{const e=document.querySelector('[aria-label="查看日期"]');e.value=${JSON.stringify(day.date)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(
    `!!document.querySelector('.wb-daily-execution [data-item-id="${newDaily}"]')`,
    'saved daily item visible on its date',
  );
  await click(`.wb-daily-execution [data-item-id="${newDaily}"] [aria-label="日待办完成状态"]`);
  await clickText('已完成');
  await wait(`board.records['${newDaily}'].done===true`, 'daily completion updates shared data');
  await view('weekly');
  assert.ok(
    await evaluate(
      'document.querySelector(".wb-unlinked-days h3").textContent.includes("未挂周任务的日待办")',
    ),
  );
  await evaluate(`board.remove(board.records['${newDaily}'])`);
  await view('daily');
  await evaluate(
    `(()=>{const e=document.querySelector('[aria-label="查看日期"]');e.value=${JSON.stringify(previousDate)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
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
  // Annual deletion choices operate on actual linked descendants, across dates.
  const deletionFixture = await evaluate(`(async()=>{
    const a=await board.add('annual',undefined,{title:'年度删除确认验证'});
    const m=await board.add('monthly',a.id,{title:'跨年月目标',month:'2031-01'});
    const w=Object.values(board.records).find(v=>v.type==='weekly'&&v.parentId===m.id&&!v.deletedAt);
    const d=await board.add('daily',w.id,{title:'跨年日待办',date:'2031-01-02'});
    const independent=await board.add('monthly',undefined,{title:'独立月目标保留验证',parentId:null,progress:100});
    return {a:a.id,m:m.id,w:w.id,d:d.id,independent:independent.id};
  })()`);
  await view('annual');
  const deleteAnnual = `[data-item-id="${deletionFixture.a}"] [aria-label="删除年度目标"]`;
  await click(deleteAnnual);
  await wait('!!document.querySelector("[data-delete-counts]")', 'annual deletion counts');
  assert.match(
    await evaluate('document.querySelector("[data-delete-counts]").textContent'),
    /月目标 1 项、周任务 1 项、日待办 1 条/,
  );
  await clickText('取消');
  assert.equal(await evaluate(`!!board.records['${deletionFixture.a}'].deletedAt`), false);
  await click(deleteAnnual);
  await clickText('仅删除年度目标');
  await wait(
    `!!board.records['${deletionFixture.a}'].deletedAt&&board.records['${deletionFixture.m}'].parentId===null`,
    'keep descendants and detach monthly',
  );
  for (const key of ['m', 'w', 'd', 'independent'])
    assert.equal(await evaluate(`!!board.records['${deletionFixture[key]}'].deletedAt`), false);
  assert.equal(await evaluate(`board.records['${deletionFixture.w}'].parentId`), deletionFixture.m);
  assert.equal(await evaluate(`board.records['${deletionFixture.d}'].parentId`), deletionFixture.w);
  await evaluate(
    `(async()=>{await board.restore(board.records['${deletionFixture.a}']);board.edit(board.records['${deletionFixture.m}'],{parentId:'${deletionFixture.a}'});await board.persistAll()})()`,
  );
  await click(deleteAnnual);
  await clickText('删除年度目标及关联内容');
  await wait(
    `['${deletionFixture.a}','${deletionFixture.m}','${deletionFixture.w}','${deletionFixture.d}'].every(id=>!!board.records[id].deletedAt)`,
    'cascade moves every linked item to trash',
  );
  assert.equal(
    await evaluate(`!!board.records['${deletionFixture.independent}'].deletedAt`),
    false,
  );
  await wait('!board.hasUnpersisted', 'cascade deletion persisted');
  await reloadPage();
  await evaluate(
    'window.board=document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("workbench");true',
  );
  for (const key of ['a', 'm', 'w', 'd'])
    assert.equal(await evaluate(`!!board.records['${deletionFixture[key]}'].deletedAt`), true);
  assert.equal(await evaluate(`board.records['${deletionFixture.independent}'].parentId`), null);

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
      for (const name of ['annual', 'monthly', 'weekly', 'daily', 'charts', 'tree']) {
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
    sixViews: true,
    dailyViewWithSources: true,
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
