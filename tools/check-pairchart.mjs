/** 验证「配对监控」的 K 线图呈现 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9521;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pc-'));
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

  console.log('\n\u001b[36m▌默认 = 配对 K 线图\u001b[0m');
  const s = await ev(`(() => {
    const cards=[...document.querySelectorAll('#pairchartgrid .chartcard')];
    const painted=cards.map(x=>{
      const cv=x.querySelector('canvas');
      if(!cv||!cv.width||!cv.height) return 0;
      try { const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
        let n=0; for(let i=3;i<d.length;i+=4*97) if(d[i]>0) n++; return n; } catch { return 0; }
    });
    return { cards:cards.length, painted:painted.filter(x=>x>0).length,
      tableHidden: getComputedStyle(document.querySelector('#pairtablewrap')).display==='none',
      chartVisible: getComputedStyle(document.querySelector('#pairchartwrap')).display!=='none',
      head: cards.slice(0,4).map(x=>({
        lv:x.querySelector('.lv')?.textContent?.trim(),
        roles:x.querySelector('.roles')?.textContent?.trim(),
        st:x.querySelector('.st')?.textContent?.trim(),
        sp:x.querySelector('.sp')?.textContent?.trim(),
        meta:(x.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90),
      })),
      live: document.querySelector('#pair-live')?.textContent?.trim(),
      modeSel: document.querySelector('#pair-mode')?.value,
      sizeSel: document.querySelector('#pair-size')?.value,
    };
  })()`);
  console.log('    卡片 ' + s.cards + ' 张，有像素 ' + s.painted + '/' + s.cards);
  console.log('    状态栏: ' + s.live);
  for (const h of s.head) console.log('    ' + (h.lv||'') + ' [' + (h.roles||'') + '] ' + (h.st||'') + '  ' + (h.sp||'') + '  ' + (h.meta||''));
  ok('★ 默认显示 K 线图、表格隐藏', s.chartVisible && s.tableHidden);
  ok('★ 渲染出配对 K 线卡片', s.cards > 0, s.cards + ' 张');
  ok('★ 每张卡片都画出了内容', s.painted === s.cards, s.painted + '/' + s.cards);
  ok('★ 卡片头是「次级别 → 主级别」', s.head.every(h => /→/.test(h.sp||'')), (s.head[0]?.sp||''));
  ok('★ 卡片显示主级别 DIF 与回踩根数',
    /主级别 DIF/.test(s.head[0]?.meta||'') && /(回踩|反弹) \d+ 根/.test(s.head[0]?.meta||''), s.head[0]?.meta||'');
  ok('卡片头标了多/空', /看多|看空/.test(s.head[0]?.st||''), s.head[0]?.st);
  ok('默认 2 列', s.sizeSel === '2', String(s.sizeSel));

  const vis = await ev(`(() => {
    const c = document.querySelector('#pairchartgrid .chartcard');
    const m = c && c.querySelector('[class*=meta]');
    if (!m) return { found: false };
    const r = m.getBoundingClientRect();
    const cs = getComputedStyle(m);
    return { found: true, w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, opacity: cs.opacity,
      text: (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) };
  })()`);
  ok('★ 卡片上的「主级别 DIF / 回踩根数」真的可见',
    vis.found && vis.w > 20 && vis.h > 6 && vis.display !== 'none' && vis.opacity !== '0',
    JSON.stringify(vis));

  console.log('\n\u001b[36m▌切到表格模式\u001b[0m');
  await ev(`(() => { const s=document.querySelector('#pair-mode'); s.value='table'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(7000);
  const tb = await ev(`(() => {
    const rows=[...document.querySelectorAll('#pairbody tr')];
    return { rows: rows.length,
      tableVisible: getComputedStyle(document.querySelector('#pairtablewrap')).display!=='none',
      chartHidden: getComputedStyle(document.querySelector('#pairchartwrap')).display==='none',
      head: [...document.querySelectorAll('#pairgrid thead th')].map(t=>t.textContent.trim()) };
  })()`);
  ok('★ 切表格：表格显示、图表隐藏', tb.tableVisible && tb.chartHidden);
  ok('★ 表格仍然是配对口径', /配对/.test(tb.head.join('')), tb.head.join(' | '));
  ok('表格有数据行', tb.rows > 0, tb.rows + ' 行');

  await ev(`(() => { const s=document.querySelector('#pair-mode'); s.value='chart'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(7000);
  ok('切回图表模式正常', await ev(`document.querySelectorAll('#pairchartgrid .chartcard').length > 0`));

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/pair-charts.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/pair-charts.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
