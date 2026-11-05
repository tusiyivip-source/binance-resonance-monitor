/**
 * 复现用户操作序列：
 *   1) 先按一次刷新（把开关打开）
 *   2) 再固定一张靠后的卡片
 *   3) 盯 45 秒，看它会不会被顶到最前面
 * 这正是上一版会出问题的路径。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9591;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-seq-'));
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

async function run(label, tabSel, gridSel, cardSel, pinSel, refreshSel, idAttr, pinGoesTop) {
  await ev(`localStorage.removeItem('dsh.pinnedCards')`);
  await ev(`location.reload()`);
  await sleep(22000);
  await ev(`document.querySelector('${tabSel}').click()`);
  await sleep(9000);

  // ① 先按一次刷新（把开关打开 —— 上一版就是这里留下来的状态）
  await ev(`document.querySelector('${refreshSel}').click()`);
  await sleep(6000);
  const afterRefresh = await ev(`(() => ({
    pfm: (typeof pinFirstMode !== 'undefined' ? pinFirstMode : null),
    pg: (typeof PG !== 'undefined' ? PG.pinFirst : null)
  }))()`);
  console.log('    ① 按过刷新后 pinFirstMode=' + afterRefresh.pfm + ' PG.pinFirst=' + afterRefresh.pg);
  ok(label + '：刷新后开关自动关回去（一次性）', afterRefresh.pfm === false, String(afterRefresh.pfm));

  // ② 固定一张靠后的
  const t = await ev(`(() => {
    const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
    const idx = Math.min(8, cards.length - 1);
    const c = cards[idx];
    const pid = c.dataset['${idAttr}'];
    c.querySelector('${pinSel}').click();
    return { idx, pid, n: cards.length };
  })()`);
  console.log('    ② 固定第 ' + (t.idx + 1) + ' 张 (' + t.pid + ')');

  // ③ 盯 45 秒
  let last = t.idx, moved = 0;
  for (let i = 0; i < 30; i++) {
    await sleep(1500);
    const cur = await ev(`(() => {
      const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
      return cards.findIndex(c => c.dataset['${idAttr}'] === ${JSON.stringify(t.pid)});
    })()`);
    if (cur !== last) {
      moved++;
      console.log('    ⚠ t=' + ((i + 1) * 1.5).toFixed(1) + 's 位置 ' + (last + 1) + ' → ' + (cur + 1));
      last = cur;
    }
  }
  if (pinGoesTop) {
    ok(label + '：固定后稳定停在第 1 位、不再乱动', last === 0 && moved <= 1, '移动 ' + moved + ' 次，最终第 ' + (last + 1) + ' 张');
  } else {
    ok(label + '：刷新过一次之后再固定，45 秒内不移动', moved === 0, moved ? '移动 ' + moved + ' 次' : '纹丝不动');
  }
  if (!pinGoesTop) ok(label + '：也没有跑到第 1 位', last !== 0, '在第 ' + (last + 1) + ' 张');
  else ok(label + '：最终就在第 1 张', last === 0, '第 ' + (last + 1) + ' 张');
}

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

  console.log('\n\u001b[36m▌配对监控：先按刷新，再固定\u001b[0m');
  await run('配对监控', '#tab-zero', '#pairchartgrid', '.chartcard', '.pinbtn', '#zero-refresh', 'pinId');

  console.log('\n\u001b[36m▌配对全景：先按刷新，再固定\u001b[0m');
  await run('配对全景', '#tab-pgrid', '#pggrid', '.pgcard', '.pg-act[data-act="pin"]', '#pg-refresh', 'pgId', true);

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
