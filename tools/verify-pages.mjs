/** 复核 GitHub Pages 线上站点：资源可达性 + 真实浏览器渲染 + 截图 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = process.argv[2] || 'https://tusiyivip-source.github.io/binance-resonance-monitor';
const PORT = 9351;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1) 资源可达性 ---------- */
console.log('=== 线上资源 ===');
const assets = ['/', '/img/shot.png', '/img/shot-chart.png', '/img/shot-alertchart.png', '/img/shot-detail.png'];
let allOk = true;
for (const p of assets) {
  try {
    const r = await fetch(BASE + p, { method: 'GET' });
    const len = r.headers.get('content-length');
    const kb = len ? Math.round(+len / 1024) + ' KB' : (await r.arrayBuffer()).byteLength / 1024 + ' KB';
    console.log(`  ${r.ok ? '✓' : '✗'} ${p.padEnd(24)} HTTP ${r.status}  ${kb}`);
    if (!r.ok) allOk = false;
  } catch (e) { console.log(`  ✗ ${p.padEnd(24)} ${e.message}`); allOk = false; }
}

/* ---------- 2) 真实浏览器渲染 ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 40000); }); };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const errs = [];
  await send('Runtime.enable'); await send('Page.enable');
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(6000);
  const r = await send('Runtime.evaluate', {
    returnByValue: true, awaitPromise: true,
    expression: `(() => ({
      title: document.title,
      h1: document.querySelector('h1')?.textContent || '',
      sections: document.querySelectorAll('section').length,
      imgs: [...document.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      height: document.body.scrollHeight,
    }))()`,
  });
  const v = r.result.value;
  console.log('\n=== 线上渲染 ===');
  console.log('  标题   : ' + v.title);
  console.log('  H1     : ' + v.h1);
  console.log('  区块数 : ' + v.sections);
  console.log('  图片   : ' + v.imgs.map(i => (i.ok ? '✓' : '✗') + i.src).join('  '));
  console.log('  横向溢出: ' + (v.overflow ? '有' : '无'));
  console.log('  页面高度: ' + v.height + 'px');
  console.log('  JS 异常 : ' + (errs.length ? errs.slice(0, 2).join(' | ') : '无'));
  const okAll = allOk && v.imgs.every(i => i.ok) && !v.overflow && errs.length === 0 && v.h1.length > 0;
  console.log('\n  ' + (okAll ? '✓ 线上站点正常' : '✗ 线上站点有问题'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('docs/img', { recursive: true });
  fs.writeFileSync('docs/img/pages-live.png', Buffer.from(shot.data, 'base64'));
  console.log('  首屏截图: docs/img/pages-live.png (' + (fs.statSync('docs/img/pages-live.png').size / 1024).toFixed(0) + ' KB)');
  process.exitCode = okAll ? 0 : 1;
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
