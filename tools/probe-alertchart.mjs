/** 探测「报警级别K线」视图 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const PORT = 9341;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-'));
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
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });
  await sleep(14000);

  // 标签是否在 K线图 左侧
  const tabs = await ev(`[...document.querySelectorAll('.viewtabs .vt')].map(b => b.id + ':' + b.textContent.trim())`);
  console.log('标签顺序: ' + tabs.join('  |  '));

  await ev(`document.querySelector('#tab-alert').click()`);
  await sleep(7000);

  const R = await ev(`(() => {
    const grid = document.querySelector('#alertchartgrid');
    const cards = [...grid.querySelectorAll('.chartcard')];
    const g = grid.getBoundingClientRect();
    return {
      gridVisible: getComputedStyle(grid).display !== 'none',
      tableHidden: getComputedStyle(document.querySelector('#tablewrap')).display === 'none',
      multiHidden: getComputedStyle(document.querySelector('#chartgrid')).display === 'none',
      overlayHidden: document.body.classList.contains('chartmode'),
      cards: cards.length,
      heads: cards.slice(0, 6).map(c => {
        const h = c.querySelector('.cchead');
        return [h.querySelector('.sym')?.textContent, h.querySelector('.rb.lvl')?.textContent,
                h.querySelector('.st')?.textContent, h.querySelector('.grp')?.textContent,
                h.querySelector('.sc')?.textContent, h.querySelector('.px')?.textContent].join(' | ');
      }),
      inited: cards.filter(c => c.querySelector('.tv-lightweight-charts')).length,
      cols: grid.style.getPropertyValue('--cols'),
      ch: grid.style.getPropertyValue('--ch'),
      overflow: grid.scrollHeight - grid.clientHeight,
      docScroll: document.documentElement.scrollHeight - window.innerHeight,
      emptyShown: getComputedStyle(document.querySelector('#alert-empty')).display !== 'none',
      live: document.querySelector('#alert-live').textContent,
      symbar: getComputedStyle(document.querySelector('#chart-symbar')).display,
      alertbar: getComputedStyle(document.querySelector('#alert-symbar')).display,
      px: (() => { const cs = window.VIEWS?.alert?.items?.[0]?.candles?.length || 0;
        const w = cards[0]?.querySelector('.cchart')?.getBoundingClientRect().width || 0;
        return cs ? +(((w - 70) / cs)).toFixed(2) : 0; })(),
    };
  })()`);
  console.log(JSON.stringify(R, null, 1));

  // 与 /api/alerts 的顺序是否一致
  const order = await ev(`(async () => {
    const a = await fetch('/api/alerts').then(r=>r.json());
    const list = Array.isArray(a) ? a : (a.alerts || []);
    const api = list.slice(0, 6).map(x => x.symbol + ':' + x.mid);
    const shown = [...document.querySelectorAll('#alertchartgrid .chartcard')].slice(0,6)
      .map(c => c.querySelector('.sym').textContent);
    return { api, shown };
  })()`);
  console.log('\n报警面板顺序(前6): ' + order.api.join(' '));
  console.log('图表展示顺序(前6): ' + order.shown.join(' '));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/shot-alertchart.png', Buffer.from(shot.data, 'base64'));
  console.log('\n截图: shot-alertchart.png (' + (fs.statSync('docs/img/shot-alertchart.png').size / 1024).toFixed(0) + ' KB)');
  console.log(errs.length ? '⚠ 异常: ' + errs.slice(0, 4).join(' | ') : '页面无 JS 异常');
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
