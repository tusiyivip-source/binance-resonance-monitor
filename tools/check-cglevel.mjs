import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9911;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lv-'));
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
  await ev(`document.querySelector('#tab-cg').click()`);
  await sleep(15000);

  const sel = await ev(`(() => {
    const s = document.querySelector('#cg-level');
    return { exists: !!s, opts: s ? [...s.options].map(o => o.textContent.trim()) : [] };
  })()`);
  console.log('  级别下拉: ' + sel.opts.join(' | '));
  ok('★ 标头有「级别筛选」下拉', sel.exists, sel.opts.length + ' 项');
  ok('★ 8 个级别选项齐全', sel.opts.length === 8, sel.opts.join(','));

  const before = await ev(`(() => {
    const cards=[...document.querySelectorAll('#cggrid .pgcard')];
    return { n: cards.length, lv: [...new Set(cards.map(c => (c.querySelector('.pg-pair')?.textContent||'').trim()))] };
  })()`);
  console.log('  全部级别: ' + before.n + ' 张，出现 ' + before.lv.join(','));
  ok('★ 全部级别时是多级别混合', before.lv.length > 1, before.lv.join(','));

  // 切到 30 分钟
  await ev(`(() => { const s=document.querySelector('#cg-level'); s.value='30m'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(11000);
  const after = await ev(`(() => {
    const cards=[...document.querySelectorAll('#cggrid .pgcard')];
    const lv = [...new Set(cards.map(c => (c.querySelector('.pg-pair')?.textContent||'').trim()))];
    return { n: cards.length, lv, live: (document.querySelector('#cg-live')?.textContent||'').trim().slice(0,90) };
  })()`);
  console.log('  只看 30分: ' + after.n + ' 张，级别 ' + after.lv.join(','));
  console.log('    统计条: ' + after.live);
  ok('★ 切到 30分后只剩 30分', after.n > 0 && after.lv.length === 1 && after.lv[0] === '30分', after.lv.join(','));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/cg-level.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/cg-level.png');
} catch (e) { console.error('失败: ' + e.message); fail++; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
