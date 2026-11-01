/** 诊断在线版：捕获控制台、异常、网络失败 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'https://tusiyivip-source.github.io/binance-resonance-monitor/';
const PORT = 9481;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-online-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 60000); }); };
const ev = async expr => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
  return r.result.value;
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  const logs = [], errs = [], fails = [], okReqs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled') {
      logs.push(m.params.type + ': ' + (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 200));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      errs.push((d.exception?.description || d.text || '').slice(0, 300));
    }
    if (m.method === 'Network.loadingFailed') {
      fails.push(m.params.errorText + ' · ' + (m.params.blockedReason || '') + ' · ' + (m.params.type || ''));
    }
    if (m.method === 'Network.responseReceived') {
      const u = m.params.response.url, s = m.params.response.status;
      if (/binance|fapi|api\./.test(u)) okReqs.push(s + ' ' + u.slice(0, 90));
    }
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  console.log('  打开', URL_);
  await send('Page.navigate', { url: URL_ });
  await sleep(25000);

  const state = await ev(`({
    title: document.title,
    hasTabZero: !!document.querySelector('#tab-zero'),
    hasTabSingle: !!document.querySelector('#tab-single'),
    rows: document.querySelectorAll('#body tr').length,
    cards: document.querySelectorAll('#zerochartgrid .chartcard').length,
    empty: document.querySelector('#empty')?.textContent?.trim()?.slice(0,80),
    live: document.querySelector('#zero-live')?.textContent?.trim()?.slice(0,100),
    conn: document.querySelector('#conn')?.textContent?.trim(),
    boot: typeof window.__DSH_BOOT__,
    marked: typeof window.marked,
    lc: typeof window.LightweightCharts,
  })`);

  console.log('\n=== 页面状态 ===');
  for (const [k, v] of Object.entries(state)) console.log('  ' + k.padEnd(12) + ':', JSON.stringify(v));

  console.log('\n=== 币安请求（前10）===');
  if (!okReqs.length) console.log('  （没有任何币安请求）');
  for (const r of okReqs.slice(0, 10)) console.log('  ' + r);

  console.log('\n=== 网络失败（前10）===');
  if (!fails.length) console.log('  （无）'); else fails.slice(0, 10).forEach(f => console.log('  ' + f));

  console.log('\n=== JS 异常（前5）===');
  if (!errs.length) console.log('  （无）'); else errs.slice(0, 5).forEach(e => console.log('  ' + e.replace(/\n/g, ' ').slice(0, 240)));

  console.log('\n=== 控制台（前15）===');
  if (!logs.length) console.log('  （无）'); else logs.slice(0, 15).forEach(l => console.log('  ' + l));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.resolve('docs/img/online-open.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('\n  截图:', out);
} catch (e) { console.error('失败: ' + (e.stack || e.message)); }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(0); }, 700);
}
