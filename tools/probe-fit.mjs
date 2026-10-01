/** 验证「适应窗口」：14 张图是否真的一屏铺满、无滚动条 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const PORT = 9339;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-fit-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 40000); }); };
const ev = async e => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: e });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

const read = () => ev(`(() => {
  const grid = document.querySelector('#chartgrid');
  const cards = [...grid.querySelectorAll('.chartcard')];
  const holders = cards.map(c => c.querySelector('.cchart'));
  const rows = [...new Set(cards.map(c => Math.round(c.getBoundingClientRect().top)))];
  const lastBottom = Math.max(...cards.map(c => c.getBoundingClientRect().bottom));
  const n = (typeof chartData !== 'undefined' && chartData?.levels?.[0]?.candles?.length) || 0;
  const h0 = holders[0].getBoundingClientRect();
  return {
    cols: grid.style.getPropertyValue('--cols'),
    ch: grid.style.getPropertyValue('--ch'),
    gridH: grid.clientHeight, scrollH: grid.scrollHeight,
    overflow: grid.scrollHeight - grid.clientHeight,
    docScroll: document.documentElement.scrollHeight - window.innerHeight,
    cards: cards.length,
    rowCount: rows.length,
    rowWidths: (() => {
      const byRow = {};
      for (const c of cards) {
        const r = Math.round(c.getBoundingClientRect().top);
        (byRow[r] ??= []).push(Math.round(c.getBoundingClientRect().width));
      }
      return Object.values(byRow).map(w => w.join('+'));
    })(),
    cardRect: Math.round(cards[0].getBoundingClientRect().width) + 'x' + Math.round(cards[0].getBoundingClientRect().height),
    plotRect: Math.round(h0.width) + 'x' + Math.round(h0.height),
    bottomGap: Math.round(grid.getBoundingClientRect().bottom - lastBottom),
    bars: n,
    px: +(((h0.width - 70) / Math.max(1, n))).toFixed(2),
    sym: document.querySelector('#chart-sym').textContent,
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

  for (const [w, h, label] of [[1920, 1080, '1920×1080'], [1600, 900, '1600×900'], [2560, 1440, '2560×1440'], [1366, 768, '1366×768']]) {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: URL_ });
    await sleep(13000);
    await ev(`document.querySelector('#tab-multi').click()`);
    await sleep(6500);
    const r = await read();
    const okFit = r.overflow <= 1 && r.docScroll <= 1 && r.cards === 14;
    console.log(`${label}  列=${r.cols}  --ch=${r.ch}  卡片=${r.cardRect}  绘图区=${r.plotRect}`);
    console.log(`           各列宽: ${r.rowWidths.join('  |  ')}`);
    console.log(`           网格 ${r.gridH}px / 内容 ${r.scrollH}px  溢出 ${r.overflow}px  页面溢出 ${r.docScroll}px  `
      + `底部余量 ${r.bottomGap}px  ${r.bars}根/${r.px}px  → ${okFit ? '✓ 无滚动' : '✗ 有滚动'}`);
  }

  // 手工列数仍可用
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(13000);
  await ev(`document.querySelector('#tab-multi').click()`);
  await sleep(6500);
  console.log('\n--- 手动列数（应出现滚动，属预期） ---');
  for (const v of ['2', '4']) {
    await ev(`document.querySelector('#chart-cols').value='${v}'; document.querySelector('#chart-cols').dispatchEvent(new Event('change'))`);
    await sleep(4500);
    const r = await read();
    console.log(`  ${v} 列  --ch=${r.ch} 卡片=${r.cardRect}  网格 ${r.gridH}/${r.scrollH} 溢出 ${r.overflow}px`);
  }
  await ev(`document.querySelector('#chart-cols').value='fit'; document.querySelector('#chart-cols').dispatchEvent(new Event('change'))`);
  await sleep(4500);
  const back = await read();
  console.log(`  切回适应窗口  列=${back.cols} --ch=${back.ch} 溢出 ${back.overflow}px`);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/shot-chart.png', Buffer.from(shot.data, 'base64'));
  console.log('\n截图: shot-chart.png (' + (fs.statSync('docs/img/shot-chart.png').size / 1024).toFixed(0) + ' KB)');
  console.log(errs.length ? '⚠ 异常: ' + errs.slice(0, 3).join(' | ') : '页面无 JS 异常');
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
