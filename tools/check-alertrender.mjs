/** 确认右侧报警面板能渲染出形态提醒卡片 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const PORT = 9377;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-alert-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 90000); }); };
const ev = async expr => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(9000);

  const r = await ev(`(() => {
    const cards = [...document.querySelectorAll('#alertlist .acard')];
    return {
      count: cards.length,
      head: cards.slice(0,3).map(c => ({
        sym: c.querySelector('.sym')?.textContent,
        chain: c.querySelector('.chain')?.textContent?.trim(),
        txt: c.querySelector('.txt')?.textContent?.slice(0,46),
        meta: c.querySelector('.meta')?.textContent?.replace(/\\s+/g,' ').trim(),
      })),
      empty: document.querySelector('#alertlist')?.textContent?.includes('暂无') || false,
      alertCount: document.querySelector('#alert-count')?.textContent,
    };
  })()`);
  console.log('  渲染卡片数:', r.count, ' 面板计数:', r.alertCount, ' 空态:', r.empty);
  for (const h of r.head) {
    console.log('    ' + h.sym + '  [' + h.chain + ']');
    console.log('      ' + h.txt);
    console.log('      meta: ' + h.meta);
  }
  console.log('  JS 异常:', errs.length ? errs.slice(0,2).join(' | ') : '无');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('docs/img', { recursive: true });
  fs.writeFileSync('docs/img/alerts-dual.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/alerts-dual.png');
  process.exitCode = (r.count > 0 && errs.length === 0) ? 0 : 1;
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
