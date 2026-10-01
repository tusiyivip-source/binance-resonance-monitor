/** 驱动真实浏览器打开 _probe.html，读回直连币安的能力结论 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/_probe.html';
const PORT = 9352;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-bprobe-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1200,900', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 120000); }); };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Page.navigate', { url: URL_ });
  // 探测脚本本身要跑 ~40 秒（4 个 WS × 9 秒）
  for (let i = 0; i < 24; i++) {
    await sleep(3000);
    const done = await send('Runtime.evaluate', { returnByValue: true, expression: '!!window.__PROBE__' });
    if (done.result.value) break;
  }
  const r = await send('Runtime.evaluate', { returnByValue: true, expression: 'window.__PROBE__ || {pending:true}' });
  const text = await send('Runtime.evaluate', { returnByValue: true, expression: `document.getElementById('out').textContent` });

  console.log('=== 浏览器输出 ===');
  console.log(text.result.value);
  console.log('\n=== 结构化结论 ===');
  const P = r.result.value;
  if (P.pending) { console.log('  探测未完成'); process.exitCode = 1; }
  else {
    for (const [k, v] of Object.entries(P.rest || {})) {
      console.log(`  REST ${k.padEnd(18)} ${v.ok ? '✓ HTTP ' + v.status : '✗ ' + (v.err || v.status)}  ${v.n ?? ''} 条  ACAO=${v.acao ?? '-'}`);
    }
    for (const [k, v] of Object.entries(P.ws || {})) {
      console.log(`  WS   ${k.padEnd(18)} ${v.msgs > 0 ? '✓ ' + v.msgs + ' 帧 / ' + v.bytes + ' 字节 / 首帧 ' + v.firstDataMs + 'ms'
        : (v.opened ? '✗ 连上但零数据帧' : '✗ 连不上')}  ${v.errors?.join(';') || ''}`);
    }
  }
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
