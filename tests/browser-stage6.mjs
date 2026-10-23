import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import dotenv from 'dotenv';
import { Pool } from 'pg';
dotenv.config({ quiet: true });
const origin = process.argv[2] || 'http://localhost:8080';
const output = path.resolve(process.env.BROWSER_ARTIFACT_DIR || 'artifacts/stage6/ui');
const email = `browser-${randomUUID()}@example.test`;
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
    await waitFor('!!document.querySelector("#email")', 'login');
    const theme = async (value) => {
      await evaluate(
        `(()=>{const e=document.querySelector('[aria-label="外观主题"]');e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
    };
    await theme('dark');
    await waitFor('document.documentElement.dataset.theme==="dark"', 'dark login');
    await screenshot('login-dark.png', false);
    await theme('system');
    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'light' }],
    });
    await waitFor('document.documentElement.dataset.theme==="light"', 'system light');
    await call('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: 'dark' }],
    });
    await waitFor('document.documentElement.dataset.theme==="dark"', 'system dark');
    await theme('dark');
    await clickText('先以访客使用（仅本机保存）');
    await ready();
    await expose();
    await clickText('数据管理');
    await clickText('载入示例并预览');
    await waitFor('!!document.querySelector(".wb-data-preview")', 'sample preview');
    await screenshot('dialog-dark.png', false);
    await clickText('确认追加');
    await waitFor('document.querySelectorAll(".wb-item-daily").length===7', 'sample loaded');
    await persisted();
    await screenshot('workspace-dark.png', false);
    const paint = await evaluate(
      '({background:getComputedStyle(document.body).backgroundColor,text:getComputedStyle(document.querySelector(".workbench")).color,card:getComputedStyle(document.querySelector(".wb-item")).backgroundColor})',
    );
    if (paint.background !== 'rgb(17, 24, 39)' || paint.card !== 'rgb(27, 37, 55)')
      throw Error('Dark surfaces did not apply ' + JSON.stringify(paint));
    await call('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await screenshot('mobile-dark.png', false);
    if (await evaluate('document.documentElement.scrollWidth>innerWidth'))
      throw Error('Dark mobile overflow');
    const touch = await evaluate(
      '[...document.querySelectorAll(".wb-actions button")].every(e=>e.getBoundingClientRect().height>=44)',
    );
    if (!touch) throw Error('Touch targets below 44px');
    await theme('light');
    await screenshot('mobile-light.png', false);
    await theme('dark');
    const manifestResult = await call('Page.getAppManifest');
    if (manifestResult.errors?.length)
      throw Error('Manifest errors ' + JSON.stringify(manifestResult.errors));
    const manifest = JSON.parse(manifestResult.data);
    if (manifest.display !== 'standalone' || manifest.icons.length < 3)
      throw Error('Incomplete manifest');
    const installability = await call('Page.getInstallabilityErrors');
    if (installability.installabilityErrors.length)
      throw Error('Installability errors ' + JSON.stringify(installability));
    await evaluate('navigator.serviceWorker.ready.then(()=>true)');
    await waitFor('!!navigator.serviceWorker.controller', 'controlled shell');
    const apiCached = await evaluate(
      'fetch("/api/health").then(()=>caches.keys()).then(keys=>Promise.all(keys.map(k=>caches.open(k).then(c=>c.keys())))).then(groups=>groups.flat().some(r=>new URL(r.url).pathname.startsWith("/api/")))',
    );
    if (apiCached) throw Error('API response was cached by SW');
    const id = await evaluate(
      'document.querySelector(".wb-item-daily [data-title-id]").getAttribute("data-title-id")',
    );
    await set('[data-title-id="' + id + '"]', '更新版本后保留的草稿');
    await persisted();
    await evaluate(
      'navigator.serviceWorker.register("/sw.js?update-check="+crypto.randomUUID(),{scope:"/",updateViaCache:"none"}).then(()=>true)',
    );
    await waitFor('document.body.innerText.includes("新版本可用 · 保存并更新")', 'waiting update');
    await evaluate('board.storageError="fixture storage failure";true');
    await clickText('新版本可用 · 保存并更新');
    await waitFor(
      'document.body.innerText.includes("本机保存未完成，请先重试或导出草稿再更新")',
      'update guard',
    );
    await evaluate('board.storageError="";true');
    await evaluate('window.__workbenchBeforeUpdate = true');
    await clickText('新版本可用 · 保存并更新');
    await waitFor(
      '!window.__workbenchBeforeUpdate && document.readyState === "complete"',
      'updated document loaded',
    );
    await ready();
    await expose();
    await waitFor(
      'board.records[' + JSON.stringify(id) + ']?.title==="更新版本后保留的草稿"',
      'draft survives SW activation',
    );
    if ((await evaluate('document.documentElement.dataset.theme')) !== 'dark')
      throw Error('Theme did not survive update');
    if (browserErrors.length)
      throw Error('Uncaught browser errors ' + JSON.stringify(browserErrors));
    const result = {
      origin,
      darkLogin: true,
      darkWorkspace: true,
      darkDialogs: true,
      systemTheme: true,
      themePersistence: true,
      mobileNoOverflow: true,
      touchTargets44: true,
      installabilityErrors: installability.installabilityErrors,
      manifestIcons: manifest.icons,
      waitingUpdate: true,
      updateBlockedUntilLocalSave: true,
      draftSurvivesUpdate: true,
      apiNeverCached: true,
      paint,
      browserErrors,
    };
    await fs.writeFile(path.join(output, 'browser-check.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    if (ws) ws.close();
    chrome.kill();
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
      const r = await pool.query('SELECT id FROM users WHERE email=ANY($1)', [
        [email, email.replace('browser-', 'browser-b-')],
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
      await pool.query('DELETE FROM auth_codes WHERE email=$1', [email]);
    } finally {
      await pool.end();
    }
  }
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
