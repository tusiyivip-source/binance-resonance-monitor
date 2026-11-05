/** 验证「固定到最前」按钮 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9531;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pin-'));
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
  await sleep(22000);
  await ev(`localStorage.removeItem('dsh.pinnedCards')`);

  console.log('\n\u001b[36m▌图钉按钮\u001b[0m');
  const s = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    return { n: cards.length,
      withPin: cards.filter(c=>c.querySelector('.pinbtn')).length,
      firstSym: cards[0]?.querySelector('.lv')?.textContent?.trim(),
      firstSp: cards[0]?.querySelector('.sp')?.textContent?.trim(),
      thirdSym: cards[2]?.querySelector('.lv')?.textContent?.trim(),
      thirdSp: cards[2]?.querySelector('.sp')?.textContent?.trim(),
      thirdId: cards[2]?.dataset.pinId };
  })()`);
  console.log('    卡片 ' + s.n + ' 张，带图钉 ' + s.withPin);
  console.log('    #1 ' + s.firstSym + '  ' + s.firstSp);
  console.log('    #3 ' + s.thirdSym + '  ' + s.thirdSp);
  ok('★ 每张卡片都有固定按钮', s.n > 0 && s.withPin === s.n, s.withPin + '/' + s.n);
  ok('卡片带有稳定 pinId', !!s.thirdId, String(s.thirdId));

  console.log('\n\u001b[36m▌固定第 3 张\u001b[0m');
  const pinned = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    const idx = Math.min(2, cards.length - 1);
    const target = cards[idx];
    // id / sym / idx 都要在点击之前读，否则重绘后读到的已是别的卡片
    const id = target.dataset.pinId;
    const sym = target.querySelector('.lv')?.textContent?.trim();
    target.querySelector('.pinbtn').click();
    return { id, sym, idx };
  })()`);
  await sleep(2500);
  const after = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    const i = cards.findIndex(c => c.dataset.pinId === ${JSON.stringify(pinned.id)});
    return { idx: i, pinned: cards[i]?.classList.contains('pinned'),
      firstId: cards[0]?.dataset.pinId,
      stored: localStorage.getItem('dsh.pinnedCards') };
  })()`);
  console.log('    固定的是: ' + pinned.sym + '  (' + pinned.id + ')');
  console.log('    它在第 ' + (after.idx + 1) + ' 张，pinned=' + after.pinned + '，第 1 张仍是 ' + after.firstId);
  console.log('    localStorage: ' + after.stored);
  ok('★ 点图钉后位置不变（不再自动跳到最前）', after.idx === pinned.idx, '原第 ' + (pinned.idx + 1) + ' → 现第 ' + (after.idx + 1));
  ok('★ 卡片有 pinned 高亮', after.pinned === true);
  ok('★ 固定状态写进了 localStorage', (after.stored || '').includes(pinned.id), String(after.stored));

  console.log('\n\u001b[36m▌按刷新按钮才置顶\u001b[0m');
  await ev(`document.querySelector('#zero-refresh').click()`);
  await sleep(7000);
  const again = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    return { firstId: cards[0]?.dataset.pinId, firstPinned: cards[0]?.classList.contains('pinned') };
  })()`);
  ok('★ 按刷新按钮后固定卡排到第 1 位', again.firstId === pinned.id && again.firstPinned, again.firstId);

  console.log('\n\u001b[36m▌重新载入页面仍固定\u001b[0m');
  await send('Page.reload', { ignoreCache: false });
  await sleep(22000);
  const reload = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    const i = cards.findIndex(c => c.dataset.pinId === ${JSON.stringify(pinned.id)});
    return { firstId: cards[0]?.dataset.pinId, idx: i,
      pinned: cards[i]?.classList.contains('pinned'),
      total: cards.length };
  })()`);
  // 整页刷新后 pinFirstMode 回到 false，所以位置按时间序；但「已固定」的标记必须保留
  ok('★ 刷新整页后固定标记仍在（位置不强制置顶）',
    reload.pinned === true && reload.idx >= 0,
    '第 ' + (reload.idx + 1) + ' 张 / 共 ' + reload.total + ' 张，pinned=' + reload.pinned);

  console.log('\n\u001b[36m▌取消固定\u001b[0m');
  await ev(`(() => {
    const c = document.querySelector('#pairchartgrid .chartcard.pinned');
    if (c) c.querySelector('.pinbtn').click();
  })()`);
  await sleep(2500);
  const off = await ev(`({ pinned: document.querySelectorAll('#pairchartgrid .chartcard.pinned').length,
    stored: localStorage.getItem('dsh.pinnedCards') })`);
  ok('★ 再点一次取消固定', off.pinned === 0, 'pinned=' + off.pinned + ' stored=' + off.stored);

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pin-demo.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pin-demo.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
