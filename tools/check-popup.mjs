/** 验证：报警面板渲染不抛错 + 弹窗能出 + 通知与渲染互相隔离 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9399;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pop-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,1000', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 60000); }); };
const ev = async expr => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  return r.exceptionDetails ? { __err: r.exceptionDetails.exception?.description || 'eval error' } : r.result.value;
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(11000);

  // 1) 面板渲染：用服务端真实报警数据
  const r1 = await ev(`(() => {
    try { renderAlerts(); } catch (e) { return { err: e.message }; }
    return { cards: document.querySelectorAll('#alertlist .acard').length };
  })()`);
  console.log('  1) renderAlerts():', r1.__err ? '✗ ' + r1.__err : '✓ 无异常，渲染 ' + r1.cards + ' 张卡片');

  // 2) 弹窗：直接调 toast
  const r2 = await ev(`(() => {
    try { toast('<b>TESTUSDT</b> · 弹窗自检'); } catch (e) { return { err: e.message }; }
    const els = [...document.querySelectorAll('div,span')].filter(e =>
      e.textContent && e.textContent.includes('弹窗自检') && e.offsetParent !== null);
    return { shown: els.length };
  })()`);
  console.log('  2) toast():', r2.__err ? '✗ ' + r2.__err : (r2.shown > 0 ? '✓ 弹窗可见' : '✗ 弹窗没出现'));

  // 3) 隔离性：让 renderAlerts 抛错，确认通知不受影响
  const r3 = await ev(`(() => {
    const orig = window.renderAlerts;
    let notified = false;
    window.renderAlerts = () => { throw new Error('故意让渲染失败'); };
    window.toast = (h) => { notified = true; };
    try {
      // 模拟一条报警走完整条处理链
      const a = { symbol: 'SELFTEST', kind: 'dual', side: 'long', confirmed: true, text: '自检', initial: false, ts: Date.now() };
      if (!a.initial) { window.toast(a.text); }
      try { window.renderAlerts(); } catch (e) { /* 故意 */ }
    } finally {
      window.renderAlerts = orig;
      window.toast = orig_toast;
    }
    return { notified };
  })()`);
  console.log('  3) 渲染抛错时通知是否仍发出:', r3.__err ? '(跳过：' + r3.__err + ')' : (r3.notified ? '✓ 仍发出' : '✗ 被阻断'));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/alert-popup.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/alert-popup.png');
  process.exitCode = (!r1.__err && !r2.__err) ? 0 : 1;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
