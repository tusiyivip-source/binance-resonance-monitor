/**
 * 用真实 Chrome（headless）打开面板，做 DOM 断言 + 截图。
 *   node tools/shot.mjs [url] [outfile]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const OUT = process.argv[3] || 'docs/img/shot.png';
const PORT = 9333;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-shot-'));
const child = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--hide-scrollbars', '--no-first-run',
  '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitEndpoint() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch { }
    await sleep(250);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const logs = [];
let ws, id = 0;
const pending = new Map();

function send(method, params = {}) {
  const mid = ++id;
  ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(method + ' 超时')); } }, 30000);
  });
}

try {
  await waitEndpoint();
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);

  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', rej);
  });

  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id); pending.delete(m.id);
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(`[${m.params.type}] ` + m.params.args.map(a => a.value ?? a.description ?? a.type).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('[EXCEPTION] ' + (m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
    }
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(12000);   // 等 SSE 首帧 + 表格渲染

  const probe = await send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const q = s => document.querySelector(s);
      const rows = document.querySelectorAll('#body tr');
      const cells = document.querySelectorAll('#body tr:first-child .cell');
      const pipes = document.querySelectorAll('#head th.lv');
      const cards = document.querySelectorAll('#alertlist .acard');
      return {
        title: document.title,
        levelCols: pipes.length,
        headLabels: [...pipes].map(t=>t.textContent),
        rows: rows.length,
        cellsInFirstRow: cells.length,
        firstRow: rows[0] ? [...rows[0].querySelectorAll('td')].map(td=>td.textContent.trim()).slice(0,8) : null,
        firstRowCells: rows[0] ? [...rows[0].querySelectorAll('.cell')].map(c=>c.className.replace('cell ','')) : null,
        alertCards: cards.length,
        firstAlert: cards[0] ? cards[0].innerText.replace(/\\n/g,' | ') : null,
        pillWs: q('#pill-ws')?.textContent.trim(),
        pillSym: q('#pill-sym')?.textContent.trim(),
        pillBull: q('#pill-bull')?.textContent.trim(),
        pillSig: q('#pill-sig')?.textContent.trim(),
        pillTime: q('#pill-time')?.textContent.trim(),
        emptyVisible: getComputedStyle(q('#empty')).display,
        hasCss: getComputedStyle(q('#topbar')).borderBottomWidth,
        bodyBg: getComputedStyle(document.body).backgroundColor,
      };
    })()`,
  });

  const r = probe.result.value;
  console.log('\n=== DOM 断言 ===');
  console.log(JSON.stringify(r, null, 1));
  console.log('\n=== 控制台输出/异常 ===');
  console.log(logs.length ? logs.join('\n') : '（无）');

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`\n截图已保存：${OUT}  (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);

  // 二次截图：打开详情抽屉
  await send('Runtime.evaluate', { expression: `document.querySelector('#body tr .c-sym')?.click()` });
  await sleep(2500);
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/shot-detail.png', Buffer.from(shot2.data, 'base64'));
  console.log('详情截图：shot-detail.png');
} catch (e) {
  console.error('失败：' + (e.stack || e.message));
  process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 800);
}
