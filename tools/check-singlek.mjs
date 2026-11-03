/** 浏览器验证：单K回踩不破 视图 + K线图 tab 已移除 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 9461;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sk-'));
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
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8848/' });
  await sleep(14000);

  console.log('\n\u001b[36m▌K线图 tab 已移除\u001b[0m');
  ok('★ #tab-multi 不存在', !(await ev(`!!document.querySelector('#tab-multi')`)));
  ok('★ #chartgrid 不存在', !(await ev(`!!document.querySelector('#chartgrid')`)));
  ok('#chart-cols / #chart-live 不存在',
    !(await ev(`!!document.querySelector('#chart-cols')`)) && !(await ev(`!!document.querySelector('#chart-live')`)));
  const tabs = await ev(`[...document.querySelectorAll('.viewtabs .vt')].map(b=>b.textContent.trim()).filter(Boolean)`);
  console.log('    当前标签: ' + tabs.join('  |  '));
  ok('★ 新标签「单K回踩不破」存在', tabs.some(t => t.includes('单K回踩不破')), tabs.join(' | '));

  console.log('\n\u001b[36m▌单K视图（默认平铺 K 线）\u001b[0m');
  await ev(`document.querySelector('#tab-single').click()`);
  await sleep(11000);
  const c = await ev(`(() => {
    const cards=[...document.querySelectorAll('#singlechartgrid .chartcard')];
    const painted=cards.map(x=>{
      const cv=x.querySelector('canvas');
      if(!cv || !cv.width || !cv.height) return 0;
      try {
        const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
        let n=0; for(let i=3;i<d.length;i+=4*97) if(d[i]>0) n++;
        return n;
      } catch { return 0; }
    });
    return { cards:cards.length, painted,
      inited: cards.filter(x=>x.querySelector('.tv-lightweight-charts')).length,
      head: cards.slice(0,3).map(x=>({
        lv:x.querySelector('.lv')?.textContent?.trim(),
        roles:x.querySelector('.roles')?.textContent?.trim(),
        st:x.querySelector('.st')?.textContent?.trim(),
        sp:x.querySelector('.sp')?.textContent?.trim(),
        meta:(x.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim(),
      })),
      live: document.querySelector('#single-live')?.textContent?.trim(),
      chartVisible: getComputedStyle(document.querySelector('#singlechartwrap')).display!=='none',
      tableHidden: getComputedStyle(document.querySelector('#singletablewrap')).display==='none',
    };
  })()`);
  console.log('    卡片 ' + c.cards + ' 张（已初始化 ' + c.inited + '）· 有像素 ' + c.painted.filter(x=>x>0).length + '/' + c.painted.length);
  console.log('    状态栏: ' + c.live);
  for (const h of c.head) console.log('    ' + (h.lv||'') + ' [' + (h.roles||'') + '] ' + (h.st||'') + '  ' + (h.sp||'') + '  ' + (h.meta||''));
  ok('★ 单K页默认显示 K 线墙、表格隐藏', c.chartVisible && c.tableHidden);
  ok('★ 渲染出 K 线卡片', c.cards > 0, c.cards + ' 张');
  ok('★ 每张卡片都真的画出了内容', c.painted.filter(x=>x>0).length === c.cards, c.painted.filter(x=>x>0).length + '/' + c.cards);
  ok('★ 卡片头显示币种+周期+榜内名次',
    /USDT/.test(c.head[0]?.lv || '') && /#\d+ · .*(分|时|日)/.test(c.head[0]?.sp || ''),
    (c.head[0]?.lv||'') + ' / ' + (c.head[0]?.sp||''));
  // 卡片可能多可能空，断言要兼容两个方向
  ok('★ 卡片显示单K涨跌幅与实体放大',
    /单K [+−]\d+(\.\d+)?%/.test(c.head[0]?.meta||'') && /实体放大/.test(c.head[0]?.meta||''), c.head[0]?.meta||'');
  ok('★ 卡片显示回踩/反抽幅度与不破线',
    /(回踩|反抽) \d+(\.\d+)?%/.test(c.head[0]?.meta||'') && /不破线/.test(c.head[0]?.meta||''), c.head[0]?.meta||'');
  ok('卡片头标为看多/看空', /^(看多|看空)$/.test(c.head[0]?.st||''), c.head[0]?.st);

  // 趁现在还在单K图表页，先截一张（后面会切到表格/零轴页）
  {
    const s1 = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync('docs/img/single-k.png', Buffer.from(s1.data, 'base64'));
    console.log('\n  截图（单K图表页）: docs/img/single-k.png');
  }

  console.log('\n\u001b[36m▌零轴筛选（只看零轴上的 / 零轴下的）\u001b[0m');
  const hasSel = await ev(`(() => {
    const s = document.querySelector('#single-zero');
    return s ? [...s.options].map(o => o.value).join(',') : null;
  })()`);
  ok('★ 有三个选项：不限 / 零轴上 / 零轴下', hasSel === 'all,above,below', String(hasSel));

  await ev(`(() => { const s=document.querySelector('#single-zero'); s.value='above'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(7000);
  const zUp = await ev(`(() => {
    const sp=[...document.querySelectorAll('#singlechartgrid .chartcard .sp')].map(e=>e.textContent);
    return { n: sp.length, allUp: sp.length>0 && sp.every(x=>x.includes('零轴上')), sample: sp.slice(0,3) };
  })()`);
  ok('★ 只看零轴上 → 卡片全部标为零轴上', zUp.allUp, zUp.n + ' 张：' + zUp.sample.join(' | '));

  await ev(`(() => { const s=document.querySelector('#single-zero'); s.value='below'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(7000);
  const zDn = await ev(`(() => {
    const sp=[...document.querySelectorAll('#singlechartgrid .chartcard .sp')].map(e=>e.textContent);
    return { n: sp.length, allDn: sp.length>0 && sp.every(x=>x.includes('零轴下')), sample: sp.slice(0,3) };
  })()`);
  ok('★ 只看零轴下 → 卡片全部标为零轴下', zDn.allDn, zDn.n + ' 张：' + zDn.sample.join(' | '));

  // 复原，后面还要看表格
  await ev(`(() => { const s=document.querySelector('#single-zero'); s.value='all'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(4000);


  console.log('\n\u001b[36m▌切到表格模式\u001b[0m');
  await ev(`(() => { const s=document.querySelector('#single-mode'); s.value='table'; s.dispatchEvent(new Event('change')); })()`);
  await sleep(9000);
  const tb = await ev(`(() => {
    const rows=[...document.querySelectorAll('#singlebody tr')];
    const cells=n=>rows.map(tr=>tr.children[n]?.textContent.trim()).filter(Boolean);
    return { rows:rows.length, head:[...document.querySelectorAll('#singlegrid thead th')].map(t=>t.textContent.trim()),
      dirs:cells(3).slice(0,6), zeros:cells(4).slice(0,6),
      gain:cells(5).slice(0,3), retr:cells(7).slice(0,3),
      bars:cells(8).slice(0,3), line:cells(9).slice(0,3),
      tableVisible: getComputedStyle(document.querySelector('#singletablewrap')).display!=='none',
      chartHidden: getComputedStyle(document.querySelector('#singlechartwrap')).display==='none' };
  })()`);
  console.log('    表头(' + tb.head.length + '列): ' + tb.head.join(' | '));
  console.log('    行 ' + tb.rows + ' · 方向 ' + tb.dirs.join(' ') + ' · 涨幅 ' + tb.gain.join(' ') + ' · 不破线 ' + tb.line.join(' '));
  ok('★ 切到表格：表格显示、K线墙隐藏', tb.tableVisible && tb.chartHidden);
  ok('★ 表格渲染出信号行', tb.rows > 0, tb.rows + ' 行');
  ok('表头含「方向」列', /方向/.test(tb.head.join('')), tb.head.join(' | '));
  ok('★ 每行都有方向（多/空）', tb.dirs.length > 0 && tb.dirs.every(x => x === '多' || x === '空'), tb.dirs.join(' '));
  ok('★ 表头含「零轴」列且每行标了上/下',
    /零轴/.test(tb.head.join('')) && tb.zeros.length > 0 && tb.zeros.every(x => x === '上' || x === '下'), tb.zeros.join(' '));
  ok('表头是单K口径（含 单K涨幅 / 回踩 / 不破线）',
    /单K涨幅/.test(tb.head.join('')) && /回踩/.test(tb.head.join('')) && /不破线/.test(tb.head.join('')), tb.head.join(' | '));
  ok('涨跌幅列是百分比（多带 + / 空带 −）', tb.gain.every(x => /^[+−-]?\d+(\.\d+)?%/.test(x)), tb.gain.join(' '));
  ok('回调根数列是「N 根」', tb.bars.every(x => /^\d+ 根$/.test(x)), tb.bars.join(' '));


  console.log('\n\u001b[36m▌报警级别K线视图里的单K卡片\u001b[0m');
  // 报警缓冲可能为空（重启后要等 K 线收盘），有数据才断言
  const alertHasSK = await ev(`fetch('/api/alertchart?bars=150&limit=24')
    .then(r=>r.json()).then(d=>(d.items||[]).filter(i=>i.kind==='single').length)`);
  if (alertHasSK > 0) {
    await ev(`document.querySelector('#tab-alert').click()`);
    await sleep(11000);
    const av = await ev(`(() => {
      const cards=[...document.querySelectorAll('#alertchartgrid .chartcard')];
      const painted=cards.map(x=>{
        const cv=x.querySelector('canvas');
        if(!cv || !cv.width || !cv.height) return 0;
        try { const d=cv.getContext('2d').getImageData(0,0,cv.width,cv.height).data;
          let n=0; for(let i=3;i<d.length;i+=4*97) if(d[i]>0) n++; return n; } catch { return 0; }
      });
      return { n:cards.length, painted:painted.filter(x=>x>0).length,
        heads: cards.slice(0,4).map(x=>(x.querySelector('.sp')?.textContent||'').trim()),
        metas: cards.slice(0,4).map(x=>(x.querySelector('[class*=meta]')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,80)),
        sidebar: document.querySelector('#alertlist')?.textContent?.includes('组合未保存') };
    })()`);
    console.log('    报警卡 ' + av.n + ' 张，有像素 ' + av.painted + '/' + av.n);
    for (let i = 0; i < av.heads.length; i++) console.log('    ' + av.heads[i] + '   ' + av.metas[i]);
    ok('★ 报警视图渲染出卡片且都画了内容', av.n > 0 && av.painted === av.n, av.painted + '/' + av.n);
    ok('★ 单K报警卡片头显示「榜内 #N」，不是「组合未保存」',
      av.heads.every(h => /榜内 #\d+/.test(h)), av.heads.join(' | '));
    ok('★ 单K报警卡片显示单K幅度与不破线',
      av.metas.every(m => /单K [+−]\d/.test(m) && /不破线/.test(m)), av.metas.join(' | '));
    ok('右侧报警面板不再显示「历史记录（组合未保存）」', av.sidebar === false,
      av.sidebar ? '还在显示' : '已改为单K信息');
    await ev(`document.querySelector('#tab-single').click()`);
    await sleep(3000);
  } else {
    console.log('    （报警缓冲里暂无单K报警，跳过渲染断言）');
  }


  console.log('\n\u001b[36m▌切回零轴视图\u001b[0m');
  await ev(`document.querySelector('#tab-zero').click()`);
  await sleep(3000);
  ok('切回零轴视图正常',
    await ev(`getComputedStyle(document.querySelector('#view-single')).display==='none'`));

  console.log('\n\u001b[36m▌异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' | ') || '无');

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync('docs/img/single-k-table.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图（表格页）: docs/img/single-k-table.png');
  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail ? 1 : 0;
} catch (e) { console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1; }
finally {
  try { ws?.close(); } catch { } try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
