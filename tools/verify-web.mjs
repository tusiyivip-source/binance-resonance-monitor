/**
 * 纯前端版端到端验证（真实 Chrome）
 *   node tools/verify-web.mjs [url]
 *
 * 与 Node 版不同，这里没有后端可查，所以判据全部落在「页面真实状态」上：
 * 引擎是否跑起来、快照是否有数据、表格是否渲染、图表是否画出像素、
 * 以及 window.__DSH_WEB__ 暴露的运行时统计。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8850/';
const WAIT_SEED_MS = Number(process.argv[3] || 150000);
const PORT = 9353;
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map();
const send = (m, p = {}) => { const i = ++id; ws.send(JSON.stringify({ id: i, method: m, params: p }));
  return new Promise((res, rej) => { pending.set(i, { res, rej }); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error(m + ' timeout')); } }, 120000); }); };
const ev = async expr => {
  const r = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  \u001b[32m✓\u001b[0m ${name}` + (detail ? `  \u001b[2m${detail}\u001b[0m` : '')); }
  else { fail++; console.log(`  \u001b[31m✗\u001b[0m ${name}` + (detail ? `  \u001b[31m${detail}\u001b[0m` : '')); }
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const t = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
      if (!/favicon|404/.test(t)) errs.push(t);
    }
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  console.log('\n\u001b[36m▌加载页面\u001b[0m');
  const t0 = Date.now();
  await send('Page.navigate', { url: URL_ });
  await sleep(6000);

  ok('页面标题正确', (await ev('document.title')).includes('币安'), await ev('document.title'));
  ok('引导层已就绪（window.__DSH_WEB__ 存在）', await ev('!!window.__DSH_WEB__'));
  ok('fetch 补丁已生效（EventSource 被替换）',
    await ev('window.EventSource.name === "LocalEventSource"'), await ev('window.EventSource.name'));
  ok('界面脚本已加载（app.js 的函数存在）',
    await ev('typeof window.render === "function" || typeof buildHeader === "function"'));
  ok('在线版说明条已显示',
    await ev(`getComputedStyle(document.getElementById('web-mode-note')).display !== 'none'`));

  console.log('\n\u001b[36m▌等待行情（浏览器直连币安，渐进播种）\u001b[0m');
  let seeded = 0, lastLog = 0;
  const deadline = Date.now() + WAIT_SEED_MS;
  while (Date.now() < deadline) {
    const s = await ev(`(() => { const w = window.__DSH_WEB__; if (!w) return null;
      return { symbols: w.market.symbols.size, done: w.market.stats?.seeding?.done ?? 0,
               total: w.market.stats?.seeding?.total ?? 0, feed: w.market.feedMode,
               weight: w.bucket?.used ?? 0, sweeps: w.engine.stats().sweepCount }; })()`);
    if (s) {
      seeded = s.done;
      if (Date.now() - lastLog > 15000) {
        console.log(`   播种 ${s.done}/${s.total}  标的 ${s.symbols}  行情源 ${s.feed}  扫描 ${s.sweeps} 次  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
        lastLog = Date.now();
      }
      if (s.symbols >= 20 && s.done >= Math.min(40, s.total)) break;
    }
    await sleep(3000);
  }

  const S = await ev(`(() => { const w = window.__DSH_WEB__;
    return { symbols: w.market.symbols.size, seeding: w.market.stats.seeding, feed: w.market.feedMode,
      marketStats: w.market.stats, engine: w.engine.stats(), rows: document.querySelectorAll('#body tr').length,
      header: document.querySelectorAll('#head th').length, alerts: document.querySelectorAll('.acard').length,
      topN: w.APP.topN }; })()`);
  console.log(`   标的 ${S.symbols} · 播种 ${S.seeding.done}/${S.seeding.total} · 行情源 ${S.feed} · 扫描 ${S.engine.sweepCount} 次`);
  const tk = S.marketStats?.tick ?? {};
  console.log(`   tick 流：bookTicker ${tk.bookMsgs ?? 0} 条 / 状态 ${tk.state} / 价格tick ${tk.priceTicks ?? 0} / 重连 ${tk.reconnects ?? 0}`);
  ok('市场已初始化（拉到标的列表）', S.symbols > 0, `${S.symbols} 个`);
  ok('数据通道为 tick-rest（实时价 + REST 补K线）', S.feed === 'tick-rest', S.feed);
  ok('★ bookTicker 数据流健康（连接打开且消息持续到达）',
    tk.state === 'open' && (tk.bookMsgs ?? 0) > 200,
    `状态 ${tk.state}，累计 ${tk.bookMsgs ?? 0} 条消息，驱动了 ${tk.priceTicks ?? 0} 次价格tick`);
  ok('引擎在持续扫描', S.engine.sweepCount > 3, `${S.engine.sweepCount} 次，单次 ${S.engine.lastSweepMs}ms`);
  ok('表格已渲染出行', S.rows > 0, `${S.rows} 行 / ${S.header} 列表头`);
  ok('没有连不上币安（等价于后端版的 /api 可用）', S.symbols >= 10, `标的 ${S.symbols}`);

  // 行情是否真的在动：连续两次取价对比（取成交活跃的头部标的，别用冷门币）
  const mv = await ev(`(async () => {
    const w = window.__DSH_WEB__;
    const snap = w.engine.snapshot();
    // 按成交额排序取最活跃的 40 个，冷门币可能几分钟才成交一次
    const idx = snap.symbols.map((s, i) => [s, snap.rows[i]?.[2] ?? 0]).sort((a, b) => b[1] - a[1]).slice(0, 40).map(x => x[0]);
    const pick = () => idx.map(s => w.market.symbols.get(s)?.price);
    const a = pick(); await new Promise(r => setTimeout(r, 6000)); const b = pick();
    let chg = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) chg++;
    return { chg, n: a.length, sample: idx.slice(0, 5).join(',') }; })()`);
  ok('★ 实时价在动（成交额前 40 标的）', mv.chg >= 5, `${mv.chg}/${mv.n} 个标的价格在 6 秒内变化（${mv.sample}…）`);

  // A) 机制检查：直接推一个价格 tick，验证 applyTick 确实更新了形成中的K线
  //    （不依赖运气——真实行情可能恰好 8 秒内没有该标的的成交）
  const mech = await ev(`(() => {
    const w = window.__DSH_WEB__;
    const st = [...w.market.symbols.values()].find(s => s.seeded && s.series['3m'].t.length > 20);
    if (!st) return null;
    const s = st.series['3m'];
    const i = s.t.length - 1;
    const before = { c: s.c[i], h: s.h[i], l: s.l[i] };
    const px = +(before.c * 1.012).toPrecision(10);
    s.applyTick(px, Date.now());
    const j = s.t.length - 1;
    return { symbol: st.symbol, idxBefore: i, idxAfter: j, price: px,
             before, after: { c: s.c[j], h: s.h[j], l: s.l[j] } };
  })()`);
  ok('★ 价格 tick 能驱动K线更新（applyTick 机制）',
    !!mech && mech.after.c === mech.price && mech.after.h >= mech.price && mech.after.l <= mech.price,
    mech ? `${mech.symbol} 收盘 ${mech.before.c} → ${mech.after.c}，高/低 ${mech.before.h}/${mech.before.l} → ${mech.after.h}/${mech.after.l}` : '无样本');

  // B) 真实行情：取成交额前几名里已播种的标的，只要有任意一个在动就说明数据链是活的
  const kline = await ev(`(async () => {
    const w = window.__DSH_WEB__;
    const snap = w.engine.snapshot();
    const act = snap.symbols.map((s, i) => [s, snap.rows[i]?.[2] ?? 0]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    const sts = act.map(s => w.market.symbols.get(s)).filter(s => s && s.seeded && s.series['3m'].t.length > 5).slice(0, 8);
    const pick = () => sts.map(s => s.series['3m'].c[s.series['3m'].c.length - 1]);
    const a = pick(); await new Promise(r => setTimeout(r, 9000)); const b = pick();
    const moved = sts.map((s, i) => ({ sym: s.symbol, from: a[i], to: b[i] })).filter(x => x.from !== x.to);
    return { n: sts.length, moved: moved.slice(0, 4), movedCount: moved.length }; })()`);
  console.log(`   真实行情：${kline?.movedCount}/${kline?.n} 个标的的 3 分K线在 9 秒内被 tick 改写`
    + (kline?.moved?.length ? `（${kline.moved.map(m => m.sym).join(',')}）` : ''));
  ok('★ 实时价正在驱动K线更新（活跃标的，9 秒窗口）',
    !!kline && kline.movedCount > 0, kline ? `${kline.movedCount}/${kline.n} 个标的末根K线发生变化` : '无样本');

  // 接口路由
  console.log('\n\u001b[36m▌就地 /api/* 路由\u001b[0m');
  const api = await ev(`(async () => {
    const j = async u => { const r = await fetch(u); return { status: r.status, body: await r.json() }; };
    const snap = await j('/api/snapshot');
    const stats = await j('/api/stats');
    const cfg = await j('/api/config');
    const alerts = await j('/api/alerts');
    const dt = await j('/api/detail?symbol=' + (snap.body.symbols?.[0] || 'BTCUSDT'));
    const ch = await j('/api/chart?symbol=' + (snap.body.symbols?.[0] || 'BTCUSDT') + '&bars=120');
    const ac = await j('/api/alertchart?bars=120&limit=12');
    const pf = await j('/api/performance');
    const pu = await j('/api/push');
    return {
      snap: { symbols: snap.body.symbols?.length, rows: snap.body.rows?.length, levels: snap.body.levels?.length },
      stats: { hasMarket: !!stats.body.market, webMode: stats.body.webMode },
      cfg: { keys: Object.keys(cfg.body || {}).length, strokeChain: cfg.body?.requireStrokeChain },
      alerts: { isArr: Array.isArray(alerts.body), n: alerts.body?.length },
      detail: { status: dt.status, levels: dt.body?.levels ? Object.keys(dt.body.levels).length : 0 },
      chart: { status: ch.status, levels: ch.body?.levels?.length, c0: ch.body?.levels?.[0]?.candles?.length, macd: !!ch.body?.levels?.[0]?.macd },
      alertchart: { total: ac.body?.total, shown: ac.body?.shown, items: ac.body?.items?.length },
      perf: { horizons: pf.body?.horizons?.length, byScore: pf.body?.byScore?.length },
      push: { meta: Object.keys(pu.body?.channelMeta || {}), webMode: pu.body?.webMode },
    };
  })()`);
  console.log('   ' + JSON.stringify(api));
  ok('/api/snapshot 返回紧凑快照', api.snap.symbols > 0 && api.snap.rows === api.snap.symbols && api.snap.levels > 0,
    `${api.snap.symbols} 标的 × ${api.snap.levels} 级别`);
  ok('/api/stats 带 webMode 标记', api.stats.hasMarket && api.stats.webMode === true);
  ok('/api/config 返回完整参数（含成笔链）', api.cfg.keys > 20 && api.cfg.strokeChain !== undefined, `${api.cfg.keys} 个键`);
  ok('/api/alerts 返回数组', api.alerts.isArr, `${api.alerts.n} 条`);
  ok('/api/detail 返回 14 个级别', api.detail.status === 200 && api.detail.levels === 14, `${api.detail.levels} 级别`);
  ok('★ /api/chart 返回 14 级别K线 + MACD',
    api.chart.status === 200 && api.chart.levels === 14 && api.chart.c0 > 0 && api.chart.macd,
    `${api.chart.levels} 级别 × ${api.chart.c0} 根，MACD=${api.chart.macd}`);
  ok('/api/alertchart 正常（可为空）', api.alertchart.total >= 0, `total ${api.alertchart.total} / shown ${api.alertchart.shown}`);
  ok('/api/performance 结构完整（本地绩效库）', api.perf.horizons === 3 && api.perf.byScore === 4,
    `${api.perf.horizons} 窗口 / ${api.perf.byScore} 分档`);
  ok('/api/push 仍返回通道元数据（前端面板要渲染）', api.push.meta.join(',') === 'dingtalk,webhook' && api.push.webMode);

  // 配置写回
  const setCfg = await ev(`(async () => {
    const before = (await (await fetch('/api/config')).json()).requireStrokeChain;
    await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ requireStrokeChain: !before }) });
    const after = (await (await fetch('/api/config')).json()).requireStrokeChain;
    await fetch('/api/config', { method:'POST', headers:{'content-type':'application/json'},
      body: JSON.stringify({ requireStrokeChain: before }) });
    return { before, after }; })()`);
  ok('★ /api/config POST 能改参数并生效', setCfg.before !== setCfg.after, `${setCfg.before} → ${setCfg.after} → 还原`);

  // 图表视图
  console.log('\n\u001b[36m▌图表视图\u001b[0m');
  await ev(`document.querySelector('#tab-multi').click()`);
  await sleep(7000);
  const CH = await ev(`(() => {
    const cards = [...document.querySelectorAll('#chartgrid .chartcard')];
    const c0 = cards[0]?.querySelector('.cchart canvas');
    let painted = 0;
    if (c0) { const d = c0.getContext('2d').getImageData(0,0,c0.width,c0.height).data;
      for (let i = 3; i < d.length; i += 4*53) if (d[i] > 0) painted++; }
    const g = document.querySelector('#chartgrid');
    return { cards: cards.length, inited: cards.filter(c => c.querySelector('.tv-lightweight-charts')).length,
      painted, cols: g.style.getPropertyValue('--cols'), ch: g.style.getPropertyValue('--ch'),
      overflow: g.scrollHeight - g.clientHeight, labels: cards.map(c => c.querySelector('.lv')?.textContent) }; })()`);
  console.log(`   ${CH.cards} 张 · 列=${CH.cols} --ch=${CH.ch} · 已绘制 ${CH.painted} · 溢出 ${CH.overflow}px`);
  ok('★ 多级别K线图渲染出 14 张', CH.cards === 14 && CH.inited === 14, `${CH.cards} 张`);
  ok('★ 画布真的画出了内容', CH.painted > 50, `采样非透明像素 ${CH.painted}`);
  ok('适应窗口：一屏铺满不出滚动条', CH.overflow <= 1, `溢出 ${CH.overflow}px`);
  ok('级别顺序正确', CH.labels.join(',') === '2分,3分,5分,10分,15分,30分,1时,2时,3时,4时,6时,12时,日线,周线', CH.labels.join(' '));

  await ev(`document.querySelector('#tab-alert').click()`);
  await sleep(6000);
  const AC = await ev(`(() => { const g = document.querySelector('#alertchartgrid');
    const cards = [...g.querySelectorAll('.chartcard')];
    return { cards: cards.length, inited: cards.filter(c => c.querySelector('.tv-lightweight-charts')).length,
      overflow: g.scrollHeight - g.clientHeight }; })()`);
  ok('报警级别K线视图可切换（无报警时为空是正常的）',
    AC.cards === AC.inited, `${AC.cards} 张`);

  await ev(`document.querySelector('#tab-matrix').click()`);
  await sleep(800);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.mkdirSync('docs/img', { recursive: true });
  fs.writeFileSync('docs/img/web-mode.png', Buffer.from(shot.data, 'base64'));
  console.log('\n  截图: docs/img/web-mode.png (' + (fs.statSync('docs/img/web-mode.png').size / 1024).toFixed(0) + ' KB)');

  console.log('\n\u001b[36m▌运行期异常\u001b[0m');
  ok('无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' | ') || '无');

  console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
  console.log(`总耗时 ${((Date.now() - t0) / 1000).toFixed(0)} 秒`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  console.error('失败: ' + (e.stack || e.message)); process.exitCode = 1;
} finally {
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(process.exitCode || 0); }, 700);
}
