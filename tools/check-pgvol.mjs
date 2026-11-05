/** 验证全景面板底部显示 24h 成交额 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9631;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vol-'));
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
  await sleep(24000);

  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(11000);

  const s = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const vols = cards.map(c => c.querySelector('.pg-vol')?.textContent?.trim() || '');
    const sample = cards.slice(0,5).map(c => ({
      sym: c.querySelector('.pg-sym')?.textContent?.trim(),
      vol: c.querySelector('.pg-vol')?.textContent?.trim(),
      info: (c.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,70),
    }));
    return { n: cards.length, withVol: vols.filter(Boolean).length,
      allFmt: vols.every(v => /^额 (\\d+(\\.\\d+)?(亿|万)?|—)$/.test(v)),
      sample };
  })()`);
  console.log('    面板 ' + s.n + ' 个，带成交额 ' + s.withVol);
  for (const x of s.sample) console.log('    ' + (x.sym||'') + '  ' + (x.vol||'') + '   ' + (x.info||''));
  ok('★ 每个面板都显示成交额', s.n > 0 && s.withVol === s.n, s.withVol + '/' + s.n);
  ok('★ 成交额格式正确（亿/万/原值）', s.allFmt, s.sample[0]?.vol || '');
  ok('★ 成交额排在底部信息的第一位', /^额 /.test(s.sample[0]?.info || ''), s.sample[0]?.info || '');

  // 和接口数据对一下
  const api = await ev(`fetch('/api/pairgrid?bars=60&limit=8').then(r=>r.json())
    .then(d=>(d.items||[]).slice(0,5).map(x=>x.symbol+'|'+Math.round(x.pair.quoteVolume||0)))`);
  console.log('    接口前 5 个成交额: ' + api.join('  '));

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pgrid-vol.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pgrid-vol.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
