/** 探测 Lightweight Charts 渲染后的 DOM 结构与绘制情况 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const PORT = 9338;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-lc-'));
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
  await send('Log.enable').catch(() => { });
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push(m.params.args.map(a => a.value).join(' '));
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(14000);
  console.log('LightweightCharts 已加载:', await ev(`typeof LightweightCharts !== 'undefined'`));
  await ev(`document.querySelector('#tab-multi').click()`);
  await sleep(6000);

  const info = await ev(`(() => {
    const grid = document.querySelector('#chartgrid');
    const cards = [...grid.querySelectorAll('.chartcard')];
    const c0 = cards[0];
    const holder = c0?.querySelector('.cchart');
    const canvases = holder ? [...holder.querySelectorAll('canvas')] : [];
    const paint = cv => {
      const ctx = cv.getContext('2d');
      if (!cv.width || !cv.height) return 0;
      try {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4 * 53) if (d[i] > 0) n++;
        return n;
      } catch (e) { return -1; }
    };
    const r = cv => { const b = cv.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); };
    return {
      cards: cards.length,
      labels: cards.map(x => x.querySelector('.lv').textContent),
      cardRect: Math.round(c0.getBoundingClientRect().width) + 'x' + Math.round(c0.getBoundingClientRect().height),
      holderRect: holder ? Math.round(holder.getBoundingClientRect().width) + 'x' + Math.round(holder.getBoundingClientRect().height) : null,
      canvasCount: canvases.length,
      canvasRects: canvases.map(r),
      canvasBacking: canvases.map(cv => cv.width + 'x' + cv.height),
      painted: canvases.map(paint),
      childTags: [...holder.children].map(x => x.tagName + (x.className ? '.' + String(x.className).slice(0,30) : '')),
      divBadges: cards.filter(c => c.querySelector('.badge-div')).length,
      roles: cards.map(c => [...c.querySelectorAll('.roles .rb')].map(x => x.classList[1]).join('+')).filter(Boolean),
      live: document.querySelector('#chart-live').textContent,
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));

  // 试一下 tooltip 与放大
  const zi = await ev(`(async () => {
    const card = document.querySelector('#chartgrid .chartcard');
    const w0 = Math.round(card.getBoundingClientRect().width);
    const h0 = Math.round(card.getBoundingClientRect().height);
    card.querySelector('.cchart').click();
    await new Promise(r=>setTimeout(r,4500));
    return { w0, h0, w1: Math.round(card.getBoundingClientRect().width), h1: Math.round(card.getBoundingClientRect().height),
      zoomed: card.classList.contains('zoomed'),
      canvas: card.querySelector('.cchart canvas')?.getBoundingClientRect().width };
  })()`);
  console.log('点图放大:', JSON.stringify(zi));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/shot-chart.png', Buffer.from(shot.data, 'base64'));
  console.log('截图: shot-chart.png (' + (fs.statSync('docs/img/shot-chart.png').size / 1024).toFixed(0) + ' KB)');
  if (errs.length) console.log('\n⚠ 页面异常:\n  ' + errs.slice(0, 6).join('\n  '));
  else console.log('\n页面无 JS 异常');
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
