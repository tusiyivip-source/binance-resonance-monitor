/** 验证：不再出现重复卡片；固定的排在最顶端 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9621;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-dup-'));
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
  await ev(`localStorage.removeItem('dsh.pinnedCards')`);
  await ev(`location.reload()`);
  await sleep(22000);

  for (const [label, tabSel, gridSel, cardSel, pinSel, refreshSel, idAttr] of [
    ['配对全景', '#tab-pgrid', '#pggrid', '.pgcard', '.pg-act[data-act="pin"]', '#pg-refresh', 'pgId'],
    ['配对监控', '#tab-zero', '#pairchartgrid', '.chartcard', '.pinbtn', '#zero-refresh', 'pinId'],
  ]) {
    console.log('\n\u001b[36m▌' + label + '\u001b[0m');
    await ev(`document.querySelector('${tabSel}').click()`);
    await sleep(9000);

    const before = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      const ids = cards.map(c => c.dataset['${idAttr}']);
      return { n: cards.length, dup: ids.length - new Set(ids).size };
    })()`);
    ok(label + '：初始没有重复卡片', before.dup === 0, before.n + ' 张，重复 ' + before.dup);

    // 固定第 10 张，然后按刷新
    const pin = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      const c = cards[Math.min(9, cards.length - 1)];
      const pid = c.dataset['${idAttr}'];
      c.querySelector('${pinSel}').click();
      return { pid };
    })()`);
    await sleep(1500);
    await ev(`document.querySelector('${refreshSel}').click()`);
    await sleep(7000);

    const after = await ev(`(() => {
      const grid = document.querySelector('${gridSel}');
      const cards=[...grid.querySelectorAll('${cardSel}')];
      const ids = cards.map(c => c.dataset['${idAttr}']);
      const idx = ids.indexOf(${JSON.stringify(pin.pid)});
      const tr = cards[idx]?.getBoundingClientRect();
      const gr = grid.getBoundingClientRect();
      return { n: cards.length, dup: ids.length - new Set(ids).size,
        idx, top: grid.scrollTop,
        deltaFromGridTop: tr ? Math.round(tr.top - gr.top) : null };
    })()`);
    console.log('    刷新后：' + after.n + ' 张，重复 ' + after.dup + '，固定在索引 ' + after.idx
      + '，距网格顶部 ' + after.deltaFromGridTop + 'px');
    ok(label + '：刷新后仍无重复卡片', after.dup === 0, '重复 ' + after.dup);
    ok(label + '：固定的排在索引 0（最顶端）', after.idx === 0, '索引 ' + after.idx);
    ok(label + '：视觉上就在网格第一行', after.deltaFromGridTop !== null && after.deltaFromGridTop < 40,
      after.deltaFromGridTop + 'px');
    ok(label + '：已滚到顶部', after.top === 0, after.top + 'px');

    // 再等两轮轮询，确认不被放大
    await sleep(9000);
    const later = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      const ids = cards.map(c => c.dataset['${idAttr}']);
      return { n: cards.length, dup: ids.length - new Set(ids).size, idx: ids.indexOf(${JSON.stringify(pin.pid)}) };
    })()`);
    ok(label + '：两轮轮询后不膨胀、不位移', later.dup === 0 && later.n === after.n && later.idx === 0,
      later.n + ' 张，重复 ' + later.dup + '，索引 ' + later.idx);
  }

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pin-top.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pin-top.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
