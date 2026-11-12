/** 验证「报警级别K线」的固定功能：和配对全景一个方式 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9661;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-revpin-'));
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
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 260));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(22000);

  await ev(`localStorage.removeItem('dsh.pinnedCards')`);
  await ev(`location.reload()`);
  await sleep(22000);
  await ev(`document.querySelector('#tab-rev').click()`);
  await sleep(12000);

  const base = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    return { n: cards.length, hasPin: !!cards[0]?.querySelector('[data-act="pin"]'), ids: cards.slice(0,3).map(c=>c.dataset.rgId) };
  })()`);
  console.log('    ' + base.n + ' 张卡片，图钉按钮: ' + (base.hasPin ? '有' : '无'));
  console.log('    前 3 个 id: ' + base.ids.join('  '));
  ok('★ 每张卡片都有固定按钮', base.hasPin);
  ok('★ pinId 用 r| 命名空间（不污染配对全景）', base.ids.every(x => typeof x === 'string' && x.startsWith('r|')), base.ids[0]);

  // 固定第 5 张
  const pin = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    const idx = Math.min(4, cards.length - 1);
    const c = cards[idx];
    const id = c.dataset.rgId;
    c.querySelector('[data-act="pin"]').click();
    return { idx, id, sym: c.querySelector('.pg-sym')?.textContent?.trim() };
  })()`);
  console.log('    固定第 ' + (pin.idx + 1) + ' 张: ' + pin.sym + ' (' + pin.id + ')');
  await sleep(1500);

  const afterPin = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    const i = cards.findIndex(c => c.dataset.rgId === ${JSON.stringify(pin.id)});
    return { idx: i, pinned: cards[i]?.classList.contains('pinned'),
      stored: localStorage.getItem('dsh.pinnedCards') };
  })()`);
  ok('★ 点固定后有高亮', afterPin.pinned === true);
  ok('★ 固定状态写进 localStorage', (afterPin.stored || '').includes(pin.id), String(afterPin.stored));

  // 等一轮轮询：固定的应该跑到第 1 位
  await sleep(8000);
  const afterPoll = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    return { idx: cards.findIndex(c => c.dataset.rgId === ${JSON.stringify(pin.id)}),
      first: cards[0]?.dataset.rgId, n: cards.length };
  })()`);
  console.log('    轮询后: 固定在索引 ' + afterPoll.idx + '，首张 ' + afterPoll.first);
  ok('★ 轮询后固定的排到第 1 位（同配对全景）', afterPoll.idx === 0, '索引 ' + afterPoll.idx);

  // 再等一轮，确认不膨胀、不乱动
  await sleep(9000);
  const later = await ev(`(() => {
    const cards=[...document.querySelectorAll('#revgrid .pgcard')];
    const ids = cards.map(c=>c.dataset.rgId);
    return { idx: ids.indexOf(${JSON.stringify(pin.id)}), n: cards.length,
      dup: ids.length - new Set(ids).size };
  })()`);
  ok('★ 再轮询一次仍然稳定在第 1 位', later.idx === 0 && later.dup === 0, later.n + ' 张，重复 ' + later.dup);

  // 配对全景不能被影响：它的 localStorage 里不该出现 r| 前缀的 id
  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(11000);
  const pg = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const i = cards.findIndex(c => c.classList.contains('pinned'));
    return { n: cards.length, pinnedIdx: i, firstPinned: cards[0]?.classList.contains('pinned'),
      stored: localStorage.getItem('dsh.pinnedCards') };
  })()`);
  console.log('    配对全景: ' + pg.n + ' 张，首个固定项索引 ' + pg.pinnedIdx);
  ok('★ 配对全景没有被反转页的固定影响', pg.firstPinned === false, '首个是否固定: ' + pg.firstPinned);
  ok('★ 两屏的固定 id 互不干扰', (pg.stored || '').includes('r|') && !(pg.stored || '').includes('"p|'), String(pg.stored).slice(0, 60));

  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/rev-pin.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/rev-pin.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
