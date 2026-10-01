/** 本地渲染 docs/index.html 并截图，验证展示页没问题 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = 'file:///' + path.resolve('docs/index.html').replace(/\\/g, '/');
const PORT = 9350;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pages-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1440,900', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 40000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: FILE });
  await sleep(3500);

  const R = await ev(`(() => {
    const imgs = [...document.querySelectorAll('img')];
    return {
      title: document.title,
      h1: document.querySelector('h1')?.textContent,
      sections: document.querySelectorAll('section').length,
      tables: document.querySelectorAll('table').length,
      cards: document.querySelectorAll('.card').length,
      notes: document.querySelectorAll('.note').length,
      links: [...document.querySelectorAll('a[href^="http"]')].length,
      imgs: imgs.map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0, w: i.naturalWidth })),
      bodyH: document.body.scrollHeight,
      hOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      scrollW: document.documentElement.scrollWidth,
      winW: window.innerWidth,
    };
  })()`);
  console.log(JSON.stringify(R, null, 1));

  const bad = R.imgs.filter(i => !i.ok);
  console.log('\n图片: ' + R.imgs.length + ' 张，失败 ' + bad.length + (bad.length ? ' → ' + bad.map(b => b.src).join(', ') : ''));
  console.log('横向溢出: ' + (R.hOverflow ? `是（${R.scrollW} > ${R.winW}）` : '否'));
  console.log(errs.length ? '⚠ JS 异常: ' + errs.slice(0, 3).join(' | ') : '无 JS 异常');

  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync('docs-preview.png', Buffer.from(shot.data, 'base64'));
  console.log('整页截图: docs-preview.png (' + (fs.statSync('docs-preview.png').size / 1024).toFixed(0) + ' KB)');
  // 首屏单独一张
  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs-hero.png', Buffer.from(shot2.data, 'base64'));
  console.log('首屏截图: docs-hero.png (' + (fs.statSync('docs-hero.png').size / 1024).toFixed(0) + ' KB)');
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
