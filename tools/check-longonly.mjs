import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9711;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lng-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m)); } }, 60000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
  return r.result.value;
};
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 200));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(22000);
  await ev(`document.querySelector('#tab-single').click()`);
  await sleep(13000);

  const r = await ev(`(() => {
    const cards=[...document.querySelectorAll('#singlechartgrid .chartcard')];
    const heads = cards.slice(0,6).map(c => (c.querySelector('.sp')?.textContent||'').trim());
    const metas = cards.slice(0,6).map(c => (c.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,70));
    const shortCards = cards.filter(c => /看空/.test((c.textContent||''))).length;
    const rebound = cards.filter(c => /反弹/.test((c.textContent||''))).length;
    const pw = document.querySelector('#pairwrap');
    return { n: cards.length, heads, metas, shortCards, rebound,
      pairHidden: pw ? getComputedStyle(pw).display : 'none',
      pairCards: document.querySelectorAll('#pairchartgrid .chartcard').length };
  })()`);
  console.log('  卡片 ' + r.n + ' 张');
  for (let i = 0; i < Math.min(3, r.heads.length); i++) console.log('    ' + r.heads[i] + '   ' + r.metas[i]);
  ok('★ 页面上还有卡片', r.n > 0, r.n + ' 张');
  ok('★ 左侧「配对监控」网格已隐藏', r.pairHidden === 'none', 'display=' + r.pairHidden);
  ok('★ 没有「看空」卡片（反弹那一支已去掉）', r.shortCards === 0, r.shortCards + ' 张看空');
  ok('★ 卡片里不再出现「反弹」字样', r.rebound === 0, r.rebound + ' 张');

  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/single-longonly.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/single-longonly.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
