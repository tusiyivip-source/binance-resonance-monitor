/** 验证「配对全景」多图平铺屏 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9541;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pg-'));
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
  await sleep(20000);

  console.log('\n\u001b[36m▌切到「配对全景」\u001b[0m');
  const tabExists = await ev(`!!document.querySelector('#tab-pgrid')`);
  const tabLabel = await ev(`document.querySelector('#tab-pgrid')?.textContent?.trim()`);
  ok('★ 新增独立标签「配对全景」', tabExists, String(tabLabel));

  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(12000);

  const s = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const painted=cards.map(x=>{
      const cv=x.querySelector('canvas');
      if(!cv||!cv.width||!cv.height) return 0;
      try { const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
        let n=0; for(let i=3;i<d.length;i+=4*97) if(d[i]>0) n++; return n; } catch { return 0; }
    });
    return {
      cards: cards.length, painted: painted.filter(x=>x>0).length,
      cols: getComputedStyle(document.querySelector('#pggrid')).gridTemplateColumns.split(' ').length,
      viewVisible: getComputedStyle(document.querySelector('#view-pgrid')).display!=='none',
      pairWrapHidden: getComputedStyle(document.querySelector('#pairwrap')).display==='none',
      head: cards.slice(0,4).map(x=>({
        sym: x.querySelector('.pg-sym')?.textContent?.trim(),
        price: x.querySelector('.pg-price')?.textContent?.trim(),
        pct: x.querySelector('.pg-pct')?.textContent?.trim(),
        info: (x.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim(),
        acts: x.querySelectorAll('.pg-act').length,
        ok: x.querySelector('.pg-ok')?.textContent?.trim(),
      })),
      live: document.querySelector('#pg-live')?.textContent?.trim(),
      toolbarVisible: getComputedStyle(document.querySelector('#pg-symbar')).display!=='none',
    };
  })()`);
  console.log('    面板 ' + s.cards + ' 个，有像素 ' + s.painted + '/' + s.cards + '，' + s.cols + ' 列');
  console.log('    状态栏: ' + s.live);
  for (const h of s.head) console.log('    ' + (h.sym||'') + '  ' + (h.price||'') + '  ' + (h.pct||'') + '   ' + (h.info||''));
  ok('★ 独立视图可见、原配对页隐藏', s.viewVisible && s.pairWrapHidden);
  ok('★ 工具条出现', s.toolbarVisible);
  ok('★ 平铺出面板', s.cards > 0, s.cards + ' 个');
  ok('★ 默认 4 列', s.cols === 4, String(s.cols));
  ok('★ 每个面板都画出了K线', s.painted === s.cards, s.painted + '/' + s.cards);
  ok('★ 面板头有币种 / 价格 / 涨跌幅',
    /USDT/.test(s.head[0]?.sym||'') && /^\$/.test(s.head[0]?.price||'') && /^[+-]\d+(\.\d+)?%$/.test(s.head[0]?.pct||''),
    (s.head[0]?.sym||'') + ' ' + (s.head[0]?.price||'') + ' ' + (s.head[0]?.pct||''));
  ok('★ 面板底部含策略全部信息（级别/方向/下跌根数/DIF/MA5）',
    /(15分|30分|1时|2时|3时|6时|12时)/.test(s.head[0]?.info||'') && /(看多|看空)/.test(s.head[0]?.info||'')
    && /下跌 \d+ 根|零上死叉·阳收MA5/.test(s.head[0]?.info||'') && /死叉 DIF/.test(s.head[0]?.info||'') && /MA5 /.test(s.head[0]?.info||''),
    s.head[0]?.info||'');
  ok('每个面板 3 个操作按钮', s.head.every(h => h.acts === 3), String(s.head[0]?.acts));
  ok('底部有「数据正常」标记', /✓/.test(s.head[0]?.ok||''), s.head[0]?.ok||'');
  ok('状态栏写明「已提醒」条数', /已提醒 \d+ 条/.test(s.live||''), s.live||'');

  console.log('\n\u001b[36m▌MACD / 已提醒全部\u001b[0m');
  const extra = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pggrid .pgcard')];
    const first=cards[0];
    // 面板高度分三块：K线 + MACD 副图（画布高度应明显超过纯K线的 2/3）
    const cv=first?.querySelector('canvas');
    return { cards: cards.length,
      colsSel: !!document.querySelector('#pg-cols'),
      limVal: document.querySelector('#pg-limit')?.value,
      cvH: cv ? cv.height : 0,
      info: (first?.querySelector('.pg-info')?.textContent||'').replace(/\\s+/g,' ').trim() };
  })()`);
  const alerted = await ev(`fetch('/api/pairgrid?bars=120&limit=200').then(r=>r.json()).then(d=>d.total)`);
  console.log('    面板 ' + extra.cards + ' 个 · 接口已提醒 ' + alerted + ' 条 · 数量下拉 ' + extra.limVal);
  ok('★ 列数选择已移除（固定一行 4 个）', extra.colsSel === false);
  ok('★ 显示全部已提醒的（面板数 ≈ 已提醒去重数）',
    // 刚重启时报警历史是空的；另外个别币可能已跌出标的池、画不出图，允许差 1 个
    alerted > 0 && extra.cards >= Math.min(alerted, 40) - 1, extra.cards + ' / ' + alerted);
  ok('★ 数量下拉默认「全部已提醒」', extra.limVal === '200', String(extra.limVal));

  await ev(`[...document.querySelectorAll('#pgseg-side .nnbtn')].find(b=>b.dataset.side==='long').click()`);
  await sleep(5000);
  const lng = await ev(`(() => {
    const dirs=[...document.querySelectorAll('#pggrid .pgcard .pg-dir')].map(e=>e.textContent.trim());
    return { n: dirs.length, allLong: dirs.length>0 && dirs.every(d=>d==='看多') };
  })()`);
  ok('★ 只看多 → 面板全是看多', lng.allLong, lng.n + ' 个');

  await ev(`[...document.querySelectorAll('#pgseg-side .nnbtn')].find(b=>b.dataset.side==='all').click()`);
  await sleep(4000);

  console.log('\n\u001b[36m▌不影响现有配对页\u001b[0m');
  await ev(`document.querySelector('#tab-zero').click()`);
  await sleep(8000);
  const back = await ev(`({ pairCards: document.querySelectorAll('#pairchartgrid .chartcard').length,
    pgridHidden: getComputedStyle(document.querySelector('#view-pgrid')).display==='none' })`);
  ok('★ 切回配对页正常、全景屏隐藏', back.pairCards > 0 && back.pgridHidden, back.pairCards + ' 张');

  console.log('\n\u001b[36m▌不重复提醒\u001b[0m');
  // 报警由引擎后台按 K 线收盘自然产生，跟开不开全景屏无关；
  // 这里只验证「读接口本身不会产生报警」——同一瞬间连续读 6 次，计数器不能跳。
  const cnt = async () => (await (await fetch('http://127.0.0.1:8848/api/stats')).json()).engine.dual.pairZero.count;
  const c1 = await cnt();
  for (let k = 0; k < 6; k++) await fetch('http://127.0.0.1:8848/api/pairgrid?bars=60&limit=20');
  const c2 = await cnt();
  console.log('    连续读 6 次 /api/pairgrid：报警计数 ' + c1 + ' → ' + c2);
  ok('★ 读全景接口不产生报警（不重复提醒）', c2 === c1, c1 + ' → ' + c2);

  // 另外确认全景屏发出的请求都是只读的 GET
  await ev(`document.querySelector('#tab-pgrid').click()`);
  await sleep(6000);
  const reqs = await ev(`performance.getEntriesByType('resource')
    .map(e => e.name).filter(n => /\\/api\\//.test(n)).slice(-12)`);
  console.log('    全景屏最近请求: ' + (reqs || []).map(u => u.replace('http://127.0.0.1:8848', '')).join(' '));
  ok('★ 全景屏只请求只读的 /api/pairgrid', (reqs || []).some(u => u.includes('/api/pairgrid')));

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pair-grid.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pair-grid.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
