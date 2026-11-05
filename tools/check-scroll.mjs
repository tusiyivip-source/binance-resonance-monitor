/** 验证：固定后页面滚动位置保持不动 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9601;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-scroll-'));
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

async function run(label, tabSel, gridSel, cardSel, pinSel, idAttr) {
  await ev(`localStorage.removeItem('dsh.pinnedCards')`);
  await ev(`location.reload()`);
  await sleep(22000);
  await ev(`document.querySelector('${tabSel}').click()`);
  await sleep(9000);

  // 滚到中间，然后固定一张靠后的卡
  const setup = await ev(`(() => {
    const grid = document.querySelector('${gridSel}');
    grid.scrollTop = Math.round(grid.scrollHeight / 3);
    return { top: grid.scrollTop, h: grid.scrollHeight, client: grid.clientHeight };
  })()`);
  await sleep(1200);
  const before = await ev(`document.querySelector('${gridSel}').scrollTop`);
  const pin = await ev(`(() => {
    const cards=[...document.querySelectorAll('${gridSel} ${cardSel}')];
    const c = cards[Math.min(10, cards.length - 1)];
    const pid = c.dataset['${idAttr}'];
    c.querySelector('${pinSel}').click();
    return { pid };
  })()`);
  console.log('    滚动到 ' + before + 'px（总高 ' + setup.h + '，视口 ' + setup.client + '），固定 ' + pin.pid);

  const samples = [];
  for (let i = 0; i < 12; i++) {
    await sleep(1500);
    samples.push(await ev(`document.querySelector('${gridSel}').scrollTop`));
  }
  const min = Math.min(...samples), max = Math.max(...samples);
  console.log('    18 秒内滚动位置: ' + min + ' ~ ' + max + '（采样 ' + samples.join(',') + '）');
  ok(label + '：固定后滚动位置保持不动', min === before && max === before, '基准 ' + before + '，范围 ' + min + '~' + max);
  ok(label + '：没有被拉回顶部', min > 30, '最小 ' + min + 'px');

  // 按刷新 → 固定的排到第 1 位，并且视图滚回顶部（否则看不见）
  const rfSel = label === '配对全景' ? '#pg-refresh' : '#zero-refresh';
  await ev(`document.querySelector('${rfSel}').click()`);
  await sleep(7000);
  const after = await ev(`(() => {
    const grid = document.querySelector('${gridSel}');
    const cards=[...grid.querySelectorAll('${cardSel}')];
    return { top: grid.scrollTop,
      firstPid: cards[0]?.dataset['${idAttr}'],
      idx: cards.findIndex(c => c.dataset['${idAttr}'] === ${JSON.stringify(pin.pid)}) };
  })()`);
  console.log('    按刷新后：滚动 ' + after.top + 'px，固定在倒数第 ' + (after.idx + 1) + ' 张，首张 ' + after.firstPid);
  ok(label + '：按刷新后固定的排到第 1 位', after.idx === 0, '第 ' + (after.idx + 1) + ' 张');
  ok(label + '：按刷新后视图滚回顶部', after.top === 0, after.top + 'px');
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

  console.log('\n\u001b[36m▌配对全景\u001b[0m');
  await run('配对全景', '#tab-pgrid', '#pggrid', '.pgcard', '.pg-act[data-act="pin"]', 'pgId');

  console.log('\n\u001b[36m▌配对监控\u001b[0m');
  await run('配对监控', '#tab-zero', '#pairchartgrid', '.chartcard', '.pinbtn', 'pinId');

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
