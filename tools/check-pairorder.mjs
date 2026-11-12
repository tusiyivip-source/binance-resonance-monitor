import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9831;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ok-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m)); } }, 60000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception?.description || String(r.exceptionDetails.text)).slice(0, 300) };
  return r.result.value;
};
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(22000);
  await ev(`document.querySelector('#tab-zero').click()`);
  await sleep(20000);

  const r = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    const named = cards.filter(c => c.querySelector('.sym')?.textContent?.trim());
    const metas = cards.map(c => (c.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim());
    const times = VIEWS.pair.items.map(x => x.at);
    let asc = true; for (let i=1;i<times.length;i++) if (times[i] < times[i-1]) asc = false;
    return { n: cards.length, named: named.length, asc,
      first: metas[0]||'', last: metas[metas.length-1]||'',
      firstAt: times[0] ? new Date(times[0]).toLocaleTimeString('zh-CN') : '-',
      lastAt: times[times.length-1] ? new Date(times[times.length-1]).toLocaleTimeString('zh-CN') : '-' };
  })()`);
  if (r.__err) { console.log('  读取失败:', r.__err); fail++; }
  else {
    console.log('  卡片 ' + r.n + ' 张，有币种名 ' + r.named);
    console.log('    首张(' + r.firstAt + '): ' + r.first);
    console.log('    末张(' + r.lastAt + '): ' + r.last);
    ok('★ 所有卡片都渲染出来（不再只画一张）', r.n > 0 && r.named === r.n, r.named + '/' + r.n);
    ok('★ 按先后顺序（旧 → 新）排列', r.asc === true, '首 ' + r.firstAt + ' → 末 ' + r.lastAt);
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pair-order.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/pair-order.png');
} catch (e) { console.error('失败: ' + e.message); fail++; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
