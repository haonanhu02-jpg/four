import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
dotenv.config({ quiet: true });
const origin = process.argv[2] || 'http://localhost:8080';
const output = path.resolve(process.env.BROWSER_ARTIFACT_DIR || 'artifacts/stage5');
const username = `browser-${randomUUID()}`;
const password = '123456';
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
    const fill = (id, value) =>
      evaluate(
        `(()=>{const e=document.getElementById(${JSON.stringify(id)});if(!e)throw Error('missing input');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
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

    async function registerAccount(targetEmail = username) {
      await clickText('注册');
      await fill('username', targetEmail);
      await fill('password', '12345');
      await evaluate('document.querySelector("form").requestSubmit()');
      await waitFor(
        'document.querySelector("#password-error")?.textContent.includes("6")',
        'short password rejected',
      );
      await fill('password', password);
      await evaluate('document.querySelector("form").requestSubmit()');
      await waitFor(
        'document.body.innerText.includes("退出登录") && !document.body.innerText.includes("正在连接工作台")',
        'registration success',
      );
    }
    const click = async (selector) => {
      await waitFor(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled;})()`,
        `element ready: ${selector}`,
      );
      return evaluate(
        '(()=>{const e=document.querySelector(' +
          JSON.stringify(selector) +
          ');if(!e)throw Error("missing element");e.click();})()',
      );
    };
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
    const saved = () =>
      waitFor(
        'document.querySelector(".wb-cloud")?.textContent.includes("所有更改已保存")&&!document.querySelector(".wb-loading")',
        'cloud saved',
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
    const reload = async () => {
      await evaluate('window.__workbenchBeforeReload = true');
      await call('Page.reload');
      await waitFor(
        '!window.__workbenchBeforeReload && document.readyState === "complete"',
        'replacement document loaded',
      );
    };
    const toggleOffline = async (offline) => {
      await call('Network.enable');
      await call('Network.emulateNetworkConditions', {
        offline,
        latency: 0,
        downloadThroughput: offline ? 0 : -1,
        uploadThroughput: offline ? 0 : -1,
      });
    };
    async function closeAndReopenOffline() {
      const previous = await call('Target.getTargetInfo');
      const created = await call('Target.createTarget', { url: 'about:blank' });
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const replacement = new WebSocket(
        pages.find((page) => page.id === created.targetId).webSocketDebuggerUrl,
      );
      await new Promise((resolve, reject) => {
        replacement.onopen = resolve;
        replacement.onerror = reject;
      });
      replacement.onmessage = ws.onmessage;
      ws.close();
      ws = replacement;
      await call('Runtime.enable');
      await call('Page.enable');
      await toggleOffline(true);
      await call('Target.closeTarget', { targetId: previous.targetInfo.targetId });
      await call('Page.navigate', { url: origin });
    }
    await call('Page.navigate', { url: origin });
    await waitFor('!!document.querySelector("#username")', 'login ready');
    if ((await evaluate('document.querySelector("#username").placeholder')) !== '请输入您的工号')
      throw Error('Employee number placeholder');
    if ((await evaluate('document.querySelector("#password").minLength')) !== 6)
      throw Error('Password minimum');
    if (
      await evaluate(
        '!!document.querySelector("input[type=email]") || document.body.innerText.includes("验证码") || document.body.innerText.includes("忘记密码")',
      )
    )
      throw Error('Email authentication still visible');
    await clickText('先以访客使用（仅本机保存）');
    await ready();
    await expose();
    await clickText('数据管理');
    await waitFor(
      '[...document.querySelectorAll(".wb-data-dialog button")].some(e=>e.textContent.trim()==="载入示例并预览"&&!e.disabled)',
      'data tools ready',
    );
    await clickText('载入示例并预览');
    await waitFor('!!document.querySelector(".wb-data-preview")', 'sample preview');
    await clickText('确认追加');
    await waitFor('document.querySelectorAll(".wb-item-daily").length===7', 'guest sample');
    await click('[aria-label="关闭数据管理"]');
    await waitFor(
      'document.querySelector("[data-metric=weekly] strong")?.textContent.includes("50")',
      'guest consistent weekly metric',
    );
    await screenshot('guest-desktop.png');
    await reload();
    await ready();
    await expose();
    if ((await evaluate('document.querySelectorAll(".wb-item-daily").length')) !== 7)
      throw Error('Guest reload lost sample');
    await clickText('登录同步');
    await waitFor('!!document.querySelector("#username")', 'guest login');
    await registerAccount();
    await ready();
    await expose();
    await waitFor(
      'document.body.innerText.includes("本机还有访客数据")',
      'explicit migration banner',
    );
    if (await evaluate('document.querySelectorAll(".wb-item-daily").length'))
      throw Error('Guest silently imported');
    await clickText('预览迁移');
    await waitFor('!!document.querySelector(".wb-data-preview")', 'guest migration preview');
    await clickText('确认追加');
    await waitFor('document.querySelectorAll(".wb-item-daily").length===7', 'migrated data');
    await saved();
    await evaluate('navigator.serviceWorker?.ready.then(()=>true)');
    await waitFor('!!navigator.serviceWorker?.controller', 'offline shell controlled');
    const firstId = await evaluate(
      'document.querySelector(".wb-item-daily [data-title-id]").getAttribute("data-title-id")',
    );
    await toggleOffline(true);
    await set('[data-title-id="' + firstId + '"]', '离线修改，关闭重开保留');
    await persisted();
    await delay(1000);
    if (!(await evaluate('board.pendingCount>0'))) throw Error('No durable queue');
    await closeAndReopenOffline();
    await ready();
    await expose();
    if (
      (await evaluate('board.records[' + JSON.stringify(firstId) + '].title')) !==
      '离线修改，关闭重开保留'
    )
      throw Error('Offline reload lost edit');
    // Add an entire linked chain while offline; IDs must stay stable through upload.
    await click('.wb-view-tabs button:first-child');
    await waitFor('!!document.querySelector("[data-add-type=annual]")', 'annual view');
    await click('[data-add-type=annual]');
    await waitFor(
      'document.querySelectorAll(".wb-item-annual").length===5',
      'offline annual created',
    );
    await persisted();
    const annual = await evaluate(
      'document.querySelectorAll(".wb-item-annual [data-title-id]")[4].getAttribute("data-title-id")',
    );
    await set('[data-title-id="' + annual + '"]', '离线新增年度');
    await persisted();
    await click('.wb-item-annual:last-child .wb-item-footer .wb-link');
    await waitFor(
      'document.querySelectorAll(".wb-item-monthly").length===7',
      'offline month created',
    );
    await persisted();
    const monthly = await evaluate(
      'Object.values(board.records).find(v=>v.type==="monthly"&&v.parentId===' +
        JSON.stringify(annual) +
        ').id',
    );
    await set('[data-title-id="' + monthly + '"]', '离线新增月度');
    await persisted();
    await click('[data-item-id="' + monthly + '"] .wb-item-footer .wb-link');
    await waitFor(
      'document.querySelectorAll(".wb-item-weekly").length===8',
      'offline week created',
    );
    await persisted();
    const weekly = await evaluate(
      'Object.values(board.records).find(v=>v.type==="weekly"&&v.parentId===' +
        JSON.stringify(monthly) +
        ').id',
    );
    await set('[data-title-id="' + weekly + '"]', '离线新增周任务');
    await persisted();
    await evaluate(
      'Promise.all([board.add("daily",' +
        JSON.stringify(weekly) +
        '),board.save(' +
        JSON.stringify(firstId) +
        ')])',
    );
    await persisted();
    const daily = await evaluate(
      'Object.values(board.records).find(v=>v.type==="daily"&&v.parentId===' +
        JSON.stringify(weekly) +
        ').id',
    );
    await set('[data-title-id="' + daily + '"]', '离线新增日待办');
    await persisted();
    await screenshot('offline-desktop.png');
    await reload();
    await ready();
    await expose();
    for (const id of [annual, monthly, weekly, daily])
      if (!(await evaluate('!!board.records[' + JSON.stringify(id) + ']')))
        throw Error('Offline create lost');
    await toggleOffline(false);
    await clickText('刷新');
    await saved();
    const doc = await evaluate('fetch("/api/data/export").then(r=>r.json())');
    for (const [type, id, parent] of [
      ['annual', annual, null],
      ['monthly', monthly, annual],
      ['weekly', weekly, monthly],
      ['daily', daily, weekly],
    ]) {
      const row = doc.items[type].find((v) => v.id === id);
      if (!row || row.parentId !== parent)
        throw Error('Stable identity/lineage lost on sync ' + type);
    }
    // Lost response after the server committed: retry must use the same operation ID.
    await evaluate(
      'window.realFetch=window.fetch;window.dropOnce=true;window.fetch=async(...args)=>{const r=await window.realFetch(...args);if(window.dropOnce&&String(args[0]).includes("/api/work-items/daily/")&&args[1]?.method==="PATCH"){window.dropOnce=false;throw new TypeError("simulated lost ACK");}return r;};',
    );
    await set('[data-title-id="' + daily + '"]', '已提交但响应丢失');
    await delay(1400);
    await waitFor(
      'board.pendingCount>0 && Object.values(board.entries).some(v=>v.state==="error")',
      'lost acknowledgement retained',
    );
    const afterLost = await evaluate(
      'window.realFetch("/api/work-items/daily/' + daily + '").then(r=>r.json()).then(r=>r.item)',
    );
    await evaluate('window.fetch=window.realFetch');
    await clickText('刷新');
    await saved();
    const afterRetry = await evaluate(
      'fetch("/api/work-items/daily/' + daily + '").then(r=>r.json()).then(r=>r.item)',
    );
    if (afterLost.version !== afterRetry.version) throw Error('Lost ACK replay mutated twice');
    // Continue typing while the first response is held. The later edit remains queued.
    await evaluate(
      'window.realFetch=window.fetch;window.holdOnce=true;window.fetch=async(...args)=>{const r=await window.realFetch(...args);if(window.holdOnce&&String(args[0]).includes("/api/work-items/daily/")&&args[1]?.method==="PATCH"){window.holdOnce=false;window.responseHeld=true;await new Promise(resolve=>window.releaseResponse=resolve);}return r;};',
    );
    await set('[data-title-id="' + daily + '"]', '上传中的版本');
    await waitFor('window.responseHeld===true', 'upload held');
    await set('[data-title-id="' + daily + '"]', '上传期间继续输入的新版本');
    await persisted();
    await evaluate('window.releaseResponse();true');
    await saved();
    await evaluate('window.fetch=window.realFetch');
    if (
      (await evaluate(
        'fetch("/api/work-items/daily/' + daily + '").then(r=>r.json()).then(r=>r.item.title)',
      )) !== '上传期间继续输入的新版本'
    )
      throw Error('Later edits lost while uploading');
    // Simulate a separately authenticated device through API, then submit the stale local base.
    const remote = await evaluate(
      'fetch("/api/work-items/daily/' + daily + '").then(r=>r.json()).then(r=>r.item)',
    );
    await evaluate(
      'fetch("/api/work-items/daily/' +
        daily +
        '",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({operationId:crypto.randomUUID(),baseVersion:' +
        remote.version +
        ',values:{title:"另一设备的修改"}})}).then(r=>r.json())',
    );
    await set('[data-title-id="' + daily + '"]', '本机修改需要选择');
    await waitFor(
      'Object.values(board.entries).some(v=>v.state==="conflict")',
      'same item conflict',
    );
    await screenshot('conflict-desktop.png');
    await reload();
    await ready();
    await expose();
    await waitFor(
      'Object.values(board.entries).some(v=>v.state==="conflict")',
      'conflict survives reopen',
    );
    if (
      (await evaluate('board.records[' + JSON.stringify(daily) + '].title')) !== '本机修改需要选择'
    )
      throw Error('Conflict local draft overwritten');
    await evaluate('board.resolveConflict(' + JSON.stringify(daily) + ',true)');
    await saved();
    if (
      (await evaluate(
        'fetch("/api/work-items/daily/' + daily + '").then(r=>r.json()).then(r=>r.item.title)',
      )) !== '本机修改需要选择'
    )
      throw Error('Keep mine failed');
    // A conflict on one row must not stop unrelated rows.
    const otherId = firstId;
    const newest = await evaluate(
      'fetch("/api/work-items/daily/' + daily + '").then(r=>r.json()).then(r=>r.item)',
    );
    await evaluate(
      'fetch("/api/work-items/daily/' +
        daily +
        '",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({operationId:crypto.randomUUID(),baseVersion:' +
        newest.version +
        ',values:{title:"远端再次修改"}})}).then(r=>r.json())',
    );
    await set('[data-title-id="' + daily + '"]', '等待处理的冲突');
    await set('[data-title-id="' + otherId + '"]', '不同事项独立同步');
    await waitFor('Object.values(board.entries).some(v=>v.state==="conflict")', 'second conflict');
    await waitFor('!board.entries[' + JSON.stringify(otherId) + ']', 'different item saved');
    await evaluate('board.resolveConflict(' + JSON.stringify(daily) + ',false)');
    await saved();
    await call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await delay(200);
    await screenshot('offline-mobile.png');
    await screenshot('mobile-viewport.png', false);
    if (await evaluate('document.documentElement.scrollWidth>innerWidth'))
      throw Error('Mobile overflow');
    await call('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    // Exercise API backup flow from the real data-management dialog.
    await clickText('数据管理');
    await waitFor(
      '[...document.querySelectorAll(".wb-data-dialog button")].some(e=>e.textContent.trim()==="载入示例并预览"&&!e.disabled)',
      'data tools ready',
    );
    await clickText('载入示例并预览');
    await waitFor('!!document.querySelector(".wb-data-preview")', 'second sample preview');
    await evaluate(
      'window.realFetch=window.fetch;window.dropImport=true;window.fetch=async(...args)=>{const r=await window.realFetch(...args);if(window.dropImport&&String(args[0])==="/api/data/commit"){window.dropImport=false;throw new TypeError("lost import response");}return r;};',
    );
    await clickText('确认追加');
    await waitFor('document.body.innerText.includes("重试确认上次操作")', 'durable import receipt');
    await reload();
    await ready();
    await expose();
    await clickText('重试确认上次操作');
    await waitFor('document.querySelectorAll(".wb-item-daily").length===15', 'sample append');
    await saved();
    await clickText('数据管理');
    // Native confirmation is handled with CDP; no destructive request is sent until accepted.
    await waitFor(
      '[...document.querySelectorAll(".wb-data-dialog button")].some(e=>e.textContent.trim()==="清空并备份"&&!e.disabled)',
      'clear tools ready',
    );
    await call('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    await evaluate('window.confirm=()=>true;true');
    await clickText('清空并备份');
    await waitFor(
      'document.querySelectorAll(".wb-item-daily").length===0&&!document.querySelector(".wb-loading")',
      'clear with backup',
    );
    await clickText('数据管理');
    await waitFor('document.querySelectorAll(".wb-data-backup").length>0', 'backup listing');
    await click('.wb-data-backup .wb-button');
    await waitFor('!!document.querySelector(".wb-data-preview")', 'restore preview');
    await screenshot('restore-preview.png');
    await clickText('确认替换');
    await waitFor('document.querySelectorAll(".wb-item-daily").length===15', 'restore rows');
    await saved();
    // Keep an unsent A command across logout/login to B; each account has a separate cache and queue.
    await evaluate(
      'window.realFetch=window.fetch;window.fetch=(...args)=>String(args[0]).includes("/api/work-items/")&&args[1]?.method==="PATCH"?Promise.reject(new TypeError("offline item endpoint")):window.realFetch(...args);',
    );
    await set('[data-title-id="' + firstId + '"]', '原账号未同步草稿');
    await delay(1200);
    await persisted();
    if (!(await evaluate('board.pendingCount>0'))) throw Error('Account A has no pending draft');
    await clickText('退出登录');
    await waitFor('!!document.querySelector("#username")', 'A logout with saved local queue');
    await evaluate('window.fetch=window.realFetch');
    const emailB = username.replace('browser-', 'browser-b-');
    await registerAccount(emailB);
    await ready();
    await expose();
    if (
      await evaluate(
        'Object.values(board.records).some(v=>v.title==="原账号未同步草稿")||board.pendingCount>0',
      )
    )
      throw Error('A data leaked into B');
    const bdoc = await evaluate('fetch("/api/data/export").then(r=>r.json())');
    if (Object.values(bdoc.items).some((rows) => rows.length)) throw Error('A data uploaded to B');
    await clickText('退出登录');
    await waitFor('!!document.querySelector("#username")', 'B logout');
    await fill('username', username);
    await fill('password', password);
    await evaluate('document.querySelector("form").requestSubmit()');
    await ready();
    await expose();
    await saved();
    if (
      (await evaluate(
        'fetch("/api/work-items/daily/' + firstId + '").then(r=>r.json()).then(r=>r.item.title)',
      )) !== '原账号未同步草稿'
    )
      throw Error('A queue not resumed under A');
    if (process.env.TEST_CACHE_GENERATION === 'true') {
      if (!new URL(process.env.DATABASE_URL).pathname.startsWith('/workbench_restore'))
        throw Error('Cache rollback simulation requires isolated restore database');
      const ghost = await evaluate('board.add("daily").then(item=>item.id)');
      await saved();
      const current = await evaluate(
        'fetch("/api/work-items/daily/' + firstId + '").then(r=>r.json()).then(r=>r.item)',
      );
      const accountId = await evaluate('board.userId');
      await toggleOffline(true);
      await set('[data-title-id="' + firstId + '"]', '恢复后待确认的本机草稿');
      await persisted();
      const database = new Pool({ connectionString: process.env.DATABASE_URL });
      const connection = await database.connect();
      try {
        await connection.query('BEGIN');
        await connection.query("SET LOCAL session_replication_role='replica'");
        await connection.query(
          "UPDATE daily_tasks SET title='备份中的云端标题',version=$1 WHERE id=$2 AND user_id=$3",
          [current.version, firstId, accountId],
        );
        await connection.query('DELETE FROM daily_tasks WHERE id=$1 AND user_id=$2', [
          ghost,
          accountId,
        ]);
        await connection.query(
          'UPDATE deployment_state SET cache_generation=gen_random_uuid(),changed_at=now() WHERE singleton',
        );
        await connection.query('COMMIT');
      } catch (caught) {
        await connection.query('ROLLBACK');
        throw caught;
      } finally {
        connection.release();
        await database.end();
      }
      await toggleOffline(false);
      await clickText('刷新');
      await waitFor(
        'board.entries[' + JSON.stringify(firstId) + ']?.state==="conflict"',
        'restored epoch stops matching-version upload',
      );
      if (
        (await evaluate('board.records[' + JSON.stringify(firstId) + '].title')) !==
        '恢复后待确认的本机草稿'
      )
        throw Error('Epoch reset lost local draft');
      if (await evaluate('!!board.records[' + JSON.stringify(ghost) + ']'))
        throw Error('Post-backup ghost retained');
      if (
        (await evaluate(
          'fetch("/api/work-items/daily/' + firstId + '").then(r=>r.json()).then(r=>r.item.title)',
        )) !== '备份中的云端标题'
      )
        throw Error('Unconfirmed draft wrote into restored database');
      await evaluate('board.resolveConflict(' + JSON.stringify(firstId) + ',false)');
      await saved();
      if (
        (await evaluate('board.records[' + JSON.stringify(firstId) + '].title')) !==
        '备份中的云端标题'
      )
        throw Error('Cloud rollback not adopted');
    }
    if (browserErrors.length) throw Error('Browser exceptions ' + JSON.stringify(browserErrors));
    const result = {
      origin,
      employeePasswordLogin: true,
      passwordMinimumSix: true,
      guestSampleAndReload: true,
      explicitGuestMigration: true,
      offlineReload: true,
      offlineFourLevelCreate: true,
      stableIds: true,
      saveDuringLocalCreate: true,
      lostAckIdempotent: true,
      typingDuringUpload: true,
      persistentVersionConflict: true,
      unrelatedItemIndependent: true,
      backupClearRestore: true,
      lostImportReceiptSurvivesReopen: true,
      accountSwitchIsolation: true,
      restoredCacheGeneration: process.env.TEST_CACHE_GENERATION === 'true',
      mobileNoOverflow: true,
      browserErrors,
    };
    await fs.writeFile(path.join(output, 'browser-check.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (ws) ws.close();
    chrome.kill();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const r = await pool.query('SELECT id FROM users WHERE username=ANY($1)', [
        [username, username.replace('browser-', 'browser-b-')],
      ]);
      for (const user of r.rows) {
        await pool.query('BEGIN');
        for (const table of [
          'data_previews',
          'data_backups',
          'year_carryovers',
          'activity_logs',
          'schedule_history',
          'period_snapshots',
          'idempotency_keys',
          'daily_tasks',
          'weekly_tasks',
          'monthly_goals',
          'annual_goals',
        ])
          await pool.query('DELETE FROM ' + table + ' WHERE user_id=$1', [user.id]);
        await pool.query('DELETE FROM users WHERE id=$1', [user.id]);
        await pool.query('COMMIT');
      }
    } finally {
      await pool.end();
    }
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
