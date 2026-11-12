import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9731;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-yg-'));
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

  const tabs = await ev(`[...document.querySelectorAll('button[id^="tab-"]')].map(b => b.textContent.trim())`);
  console.log('  标签: ' + tabs.join(' | '));
  ok('★ 标签名已改为「一阳穿三阴」', tabs.some(t => t.includes('一阳穿三阴')), tabs.join(' | '));
  ok('★ 旧名「单K回踩不破」已消失', !tabs.some(t => t.includes('单K回踩不破')));

  await ev(`document.querySelector('#tab-single').click()`);
  await sleep(13000);

  const r = await ev(`(() => {
    const cards=[...document.querySelectorAll('#singlechartgrid .chartcard')];
    const metas = cards.map(c => (c.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim());
    return { n: cards.length,
      first: metas[0] || '',
      conf: (cards[0]?.querySelector('.sk-conf')?.textContent||'').replace(/\\s+/g,' ').trim(),
      hasOldText: cards.some(c => /不破线|回踩/.test(c.textContent||'')) };
  })()`);
  console.log('  卡片 ' + r.n + ' 张');
  console.log('    首张: ' + r.first);
  console.log('    确认: ' + r.conf);
  ok('★ 卡片渲染出来了', r.n > 0, r.n + ' 张');
  ok('★ 显示「阳线 +x%」', /阳线 \+\d/.test(r.first), r.first);
  ok('★ 显示「连续阴 N 根」', /下跌 \d+ 根/.test(r.first), r.first);
  ok('★ 显示「穿透 x%」与「三阴最高开」', /穿透/.test(r.first) && /三阴最高开/.test(r.first), r.first);
  ok('★ 旧文案「不破线/回踩」已清除', r.hasOldText === false);
  ok('★ 上级确认仍在', /金叉|死叉/.test(r.conf), r.conf);
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/one-yang.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/one-yang.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
