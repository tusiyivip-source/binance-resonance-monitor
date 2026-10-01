/** 探测报警视图的「放大 + 滚动」布局 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const PORT = 9342;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-zoom-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 45000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
const read = () => ev(`(() => {
  const grid = document.querySelector('#alertchartgrid');
  const cards = [...grid.querySelectorAll('.chartcard')];
  const c0 = cards[0]?.querySelector('.cchart');
  const r0 = c0?.getBoundingClientRect();
  const n = (typeof VIEWS !== 'undefined' && VIEWS?.alert?.items?.[0]?.candles?.length) || 0;
  return {
    cards: cards.length,
    cols: grid.style.getPropertyValue('--cols'),
    ch: grid.style.getPropertyValue('--ch'),
    card: cards[0] ? Math.round(cards[0].getBoundingClientRect().width) + 'x' + Math.round(cards[0].getBoundingClientRect().height) : '-',
    plot: r0 ? Math.round(r0.width) + 'x' + Math.round(r0.height) : '-',
    gridH: grid.clientHeight, scrollH: grid.scrollHeight,
    scrollable: grid.scrollHeight - grid.clientHeight > 4,
    bars: n,
    px: r0 && n ? +((r0.width - 70) / n).toFixed(2) : 0,
    live: document.querySelector('#alert-live').textContent.replace(/·\s*\d\d:\d\d:\d\d/, '').trim(),
  };
})()`);

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  const errs = [];
  await send('Runtime.enable'); await send('Page.enable');
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(14000);
  await ev(`document.querySelector('#tab-alert').click()`);
  await sleep(7000);

  console.log('=== 尺寸档位（24 条报警）===');
  for (const [size, label] of [['compact', '紧凑'], ['normal', '标准'], ['large', '大'], ['xl', '特大']]) {
    await ev(`document.querySelector('#alert-size').value='${size}'; document.querySelector('#alert-size').dispatchEvent(new Event('change'))`);
    await sleep(5000);
    const r = await read();
    console.log(`  ${label.padEnd(4)} 列=${r.cols} --ch=${r.ch}  卡片 ${r.card}  绘图区 ${r.plot}  ${r.bars}根/${r.px}px`);
    console.log(`       ${r.scrollable ? '可滚动' : '一屏看全'}  网格 ${r.gridH}/${r.scrollH}px   |  ${r.live}`);
  }

  console.log('\n=== 条数 × 尺寸 组合 ===');
  for (const [limit, size] of [['12', 'normal'], ['24', 'normal'], ['60', 'normal'], ['24', 'large'], ['12', 'large']]) {
    await ev(`document.querySelector('#alert-limit').value='${limit}'; document.querySelector('#alert-limit').dispatchEvent(new Event('change'));
              document.querySelector('#alert-size').value='${size}'; document.querySelector('#alert-size').dispatchEvent(new Event('change'))`);
    await sleep(5200);
    const r = await read();
    console.log(`  ${limit} 条 / ${size.padEnd(7)} → 列=${r.cols} 卡片 ${r.card}  绘图区 ${r.plot}  ${r.px}px/根  ${r.scrollable ? '可滚动' : '一屏看全'}`);
  }

  // 真的能滚
  console.log('\n=== 滚动行为 ===');
  await ev(`document.querySelector('#alert-limit').value='24'; document.querySelector('#alert-limit').dispatchEvent(new Event('change'));
            document.querySelector('#alert-size').value='normal'; document.querySelector('#alert-size').dispatchEvent(new Event('change'))`);
  await sleep(5200);
  const S = await ev(`(async () => {
    const g = document.querySelector('#alertchartgrid');
    const before = g.scrollTop;
    g.scrollTop = 600;
    await new Promise(r=>setTimeout(r,400));
    const mid = g.scrollTop;
    g.scrollTop = g.scrollHeight;
    await new Promise(r=>setTimeout(r,400));
    const end = g.scrollTop;
    const max = g.scrollHeight - g.clientHeight;
    g.scrollTop = 0;
    return { before, mid, end, max, overflowY: getComputedStyle(g).overflowY };
  })()`);
  console.log(`  滚动前 ${S.before} → 设 600 后 ${S.mid} → 到底 ${S.end}（max ${S.max}）overflow-y=${S.overflowY}`);
  const okScroll = S.mid === 600 && S.end === S.max && S.max > 100;
  console.log(`  ${okScroll ? '✓ 可以滑动查看' : '✗ 滚动异常'}`);

  await ev(`document.querySelector('#alertchartgrid').scrollTop = 0`);
  await sleep(500);
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/shot-alertchart.png', Buffer.from(shot.data, 'base64'));
  console.log('\n截图: shot-alertchart.png (' + (fs.statSync('docs/img/shot-alertchart.png').size / 1024).toFixed(0) + ' KB)');
  console.log(errs.length ? '⚠ 异常: ' + errs.slice(0, 3).join(' | ') : '页面无 JS 异常');
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
