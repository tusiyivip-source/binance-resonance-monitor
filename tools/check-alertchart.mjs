/** 确认「报警级别K线」标签页能渲染形态提醒的图 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9388;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ac-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 90000); }); };
const ev = async expr => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval');
  return r.result.value;
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(10000);
  await ev(`document.querySelector('#tab-alert').click()`);
  await sleep(9000);

  const r = await ev(`(() => {
    const g = document.querySelector('#alertchartgrid');
    const cards = [...g.querySelectorAll('.chartcard')];
    const painted = cards.map(c => {
      const cv = c.querySelector('.cchart canvas') || c.querySelector('canvas');
      if (!cv) return 0;
      const d = cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4*97) if (d[i] > 0) n++;
      return n;
    });
    return { cards: cards.length, painted,
      head: cards.slice(0,4).map(c => ({
        lv: c.querySelector('.lv')?.textContent?.trim(),
        roles: c.querySelector('.roles')?.textContent?.trim(),
        st: c.querySelector('.st')?.textContent?.trim(),
        sp: c.querySelector('.sp')?.textContent?.replace(/\\s+/g,' ').trim(),
      })) };
  })()`);
  console.log('  报警K线图卡片数:', r.cards, ' 已绘制像素:', r.painted.filter(x=>x>0).length + '/' + r.painted.length);
  for (const h of r.head) console.log('    ' + (h.lv||'').padEnd(14) + '[' + (h.roles||'') + '] ' + (h.st||'') + '  ' + (h.sp||''));
  console.log('  JS 异常:', errs.length ? errs.slice(0,2).join(' | ') : '无');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/alerts-chart.png', Buffer.from(shot.data, 'base64'));
  console.log('  截图: docs/img/alerts-chart.png');
  process.exitCode = (r.cards > 0 && r.painted.some(x=>x>0) && !errs.length) ? 0 : 1;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
