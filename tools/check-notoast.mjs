/** 验证：① 不再弹左侧浮层，报警只进右侧面板 ② 固定面板始终置顶且不消失 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9551;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-nt-'));
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

  console.log('\n\u001b[36m▌不弹左侧浮层\u001b[0m');
  const before = await ev(`({ toasts: document.querySelectorAll('#toasts > *').length,
    alerts: document.querySelectorAll('#alertlist > *').length })`);
  // 造一批新报警：临时放开时效闸门（先关推送，避免刷群）
  await ev(`fetch('/api/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:false})})`);
  await ev(`fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pairZeroAlertStaleSec:999999})})`);
  await sleep(14000);
  const after = await ev(`({ toasts: document.querySelectorAll('#toasts > *').length,
    alerts: document.querySelectorAll('#alertlist > *').length })`);
  await ev(`fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pairZeroAlertStaleSec:120})})`);
  await ev(`fetch('/api/push',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:true})})`);
  console.log('    浮层条目 ' + before.toasts + ' → ' + after.toasts + '，右栏报警 ' + before.alerts + ' → ' + after.alerts);
  ok('★ 新报警不再弹左侧浮层', after.toasts === 0, '浮层 ' + after.toasts + ' 条');
  ok('★ 报警照常进入右侧「共振报警」面板', after.alerts > 0, after.alerts + ' 条');

  console.log('\n\u001b[36m▌固定面板置顶且不消失\u001b[0m');
  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(12000);
  const pinInfo = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const target = cards[5] || cards[0];
    const id = target.dataset.pgId;
    const sym = target.querySelector('.pg-sym')?.textContent?.trim();
    target.querySelector('.pg-act[data-act="pin"]').click();
    return { id, sym, total: cards.length };
  })()`);
  await sleep(6000);
  const p1 = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    return { firstId: cards[0]?.dataset.pgId, firstSym: cards[0]?.querySelector('.pg-sym')?.textContent?.trim(),
      pinnedCls: cards[0]?.classList.contains('pinned'), n: cards.length };
  })()`);
  console.log('    固定: ' + pinInfo.sym + ' (' + pinInfo.id + ')  共 ' + pinInfo.total + ' 个面板');
  console.log('    现在第 1 个: ' + p1.firstSym + ' pinned=' + p1.pinnedCls);
  ok('★ 点固定后立刻排到第 1 位', p1.firstId === pinInfo.id, p1.firstId);
  ok('★ 第 1 个带固定高亮', p1.pinnedCls === true);

  // 连刷 3 轮，看它是否一直在第 1 位
  let held = 0;
  for (let i = 0; i < 3; i++) {
    await ev(`loadPairGrid()`);
    await sleep(4000);
    const cur = await ev(`document.querySelector('#pggrid .pgcard')?.dataset.pgId`);
    if (cur === pinInfo.id) held++;
  }
  ok('★ 连续 3 次刷新后仍在第 1 位', held === 3, held + '/3');

  // 服务端补位：请求里带 pin，接口必须把它带上
  const apiHas = await ev(`(() => {
    const pins=[...JSON.parse(localStorage.getItem('dsh.pinnedCards')||'[]')];
    return fetch('/api/pairgrid?bars=120&limit=200&pin='+encodeURIComponent(pins.join(',')))
      .then(r=>r.json()).then(d=>({ wanted: pins.length,
        got: (d.items||[]).filter(x=>pins.includes('p|'+x.symbol+'|'+x.pair.sub+'-'+x.pair.main)).length }));
  })()`);
  ok('★ 固定的面板一定出现在接口结果里（不会因过期消失）', apiHas.got >= apiHas.wanted && apiHas.wanted > 0,
    apiHas.got + '/' + apiHas.wanted);

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pin-held.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pin-held.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
