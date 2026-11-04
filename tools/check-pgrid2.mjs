/** 验证配对全景的三处改动：隐藏右栏 / 新信号在底部 / 固定需按刷新才置顶 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9561;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pg2-'));
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
    if (m.method === 'Runtime.exceptionThrown') errs.push((m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text || '').slice(0, 300));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(24000);
  await ev(`localStorage.removeItem('dsh.pinnedCards')`);

  console.log('\n\u001b[36m▌右侧报警栏已隐藏\u001b[0m');
  const r1 = await ev(`(() => {
    document.querySelector('#tab-pgrid').click();
    return null;
  })()`);
  await sleep(12000);
  const side = await ev(`(() => {
    const a = document.querySelector('#alerts');
    const grid = document.querySelector('#pggrid');
    return { alertsDisplay: a ? getComputedStyle(a).display : 'missing',
      gridW: grid ? Math.round(grid.getBoundingClientRect().width) : 0,
      winW: window.innerWidth };
  })()`);
  console.log('    #alerts display=' + side.alertsDisplay + '  grid 宽 ' + side.gridW + ' / 窗口 ' + side.winW);
  ok('★ 全景屏下右侧报警栏已隐藏', side.alertsDisplay === 'none');
  ok('★ 图表区占满整宽', side.gridW >= side.winW - 40, side.gridW + ' / ' + side.winW);

  console.log('\n\u001b[36m▌新信号排到底部\u001b[0m');
  const order = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const ids = cards.map(c => c.dataset.pgId);
    // 第一个和最后一个的提醒时间：用接口对照
    return { n: cards.length, first: ids[0], last: ids[ids.length-1] };
  })()`);
  const apiOrder = await ev(`fetch('/api/pairgrid?bars=60&limit=200').then(r=>r.json()).then(d=>({
    first: d.items[0] ? d.items[0].symbol+'|'+d.items[0].pair.sub+'-'+d.items[0].pair.main : null,
    last: d.items.length ? d.items[d.items.length-1].symbol+'|'+d.items[d.items.length-1].pair.sub+'-'+d.items[d.items.length-1].pair.main : null,
    times: d.items.slice(0,3).map(x=>x.pair.alertedAt).filter(Boolean)
  }))`);
  const asc = apiOrder.times && apiOrder.times.length >= 2 ? apiOrder.times[0] <= apiOrder.times[1] : true;
  console.log('    接口首条 ' + apiOrder.first + '，末条 ' + apiOrder.last);
  ok('★ 接口按提醒时间正序（新信号在最后）', asc, JSON.stringify(apiOrder.times));
  ok('★ 页面第一个面板 = 接口第一条（最早提醒的）', 'p|' + apiOrder.first === order.first, order.first);

  console.log('\n\u001b[36m▌固定不自动跳位，刷新才置顶\u001b[0m');
  const pin = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const target = cards[cards.length - 1] || cards[0];   // 固定最后一个（最不容易被自然顶到前面）
    const id = target.dataset.pgId;
    const sym = target.querySelector('.pg-sym')?.textContent?.trim();
    const idx = cards.indexOf(target);
    target.querySelector('.pg-act[data-act="pin"]').click();
    return { id, sym, idx, pinned: target.classList.contains('pinned') };
  })()`);
  await sleep(2000);
  const afterPin = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const i = cards.findIndex(c => c.dataset.pgId === ${JSON.stringify(pin.id)});
    return { idx: i, firstId: cards[0]?.dataset.pgId, pinnedCount: document.querySelectorAll('#pggrid .pgcard.pinned').length };
  })()`);
  console.log('    固定第 ' + (pin.idx + 1) + ' 个 ' + pin.sym + '，标记后仍在第 ' + (afterPin.idx + 1) + ' 个');
  ok('★ 点固定后卡片带高亮', afterPin.pinnedCount >= 1, afterPin.pinnedCount + ' 个');
  ok('★ 点固定后不自动跳到最前', afterPin.idx === pin.idx, '原 ' + (pin.idx + 1) + ' → 现 ' + (afterPin.idx + 1));

  // 等一轮轮询，确认仍不跳
  await sleep(6000);
  const afterPoll = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    return { idx: cards.findIndex(c => c.dataset.pgId === ${JSON.stringify(pin.id)}), n: cards.length };
  })()`);
  ok('★ 轮询一次后也没有跳位', afterPoll.idx === pin.idx, '第 ' + (afterPoll.idx + 1) + ' 个 / 共 ' + afterPoll.n);

  // 点刷新按钮 → 固定项应当到第 1 位
  await ev(`document.querySelector('#pg-refresh').click()`);
  await sleep(8000);
  const afterRefresh = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    return { firstId: cards[0]?.dataset.pgId, firstPinned: cards[0]?.classList.contains('pinned'),
      idx: cards.findIndex(c => c.dataset.pgId === ${JSON.stringify(pin.id)}) };
  })()`);
  console.log('    刷新后：固定项在第 ' + (afterRefresh.idx + 1) + ' 个，首个 id=' + afterRefresh.firstId);
  ok('★ 点刷新按钮后固定项排到第 1 位', afterRefresh.idx === 0 && afterRefresh.firstPinned, afterRefresh.firstId);

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pgrid-full.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pgrid-full.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
