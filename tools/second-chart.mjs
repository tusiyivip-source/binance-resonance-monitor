/**
 * 生成二买/二卖的结构图（30m 主级别 + 15m 次级别），供截图
 * 用法: node tools/second-chart.mjs SYMBOL:short SYMBOL:long ...
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const FAPI = 'https://fapi.binance.com/fapi/v1/klines';
const sma = (arr, p) => arr.map((_, i) => i < p - 1 ? NaN : arr.slice(i - p + 1, i + 1).reduce((s, v) => s + v, 0) / p);

async function klines(sym, interval, limit = 300) {
  const r = await fetch(`${FAPI}?symbol=${sym}&interval=${interval}&limit=${limit}`);
  if (!r.ok) throw new Error(sym + ' ' + interval + ' HTTP ' + r.status);
  return (await r.json()).map((k, i) => ({
    idx: i, t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], done: +k[6] < Date.now(),
  }));
}

function buildStrokes(cs, minBars = 5) {
  const merged = [];
  for (let i = 0; i < cs.length; i++) {
    const k = { h: cs[i].h, l: cs[i].l, from: i, to: i };
    if (merged.length) {
      const last = merged[merged.length - 1];
      const inside = (k.h <= last.h && k.l >= last.l) || (k.h >= last.h && k.l <= last.l);
      if (inside) {
        const up = merged.length < 2 ? true : last.h > merged[merged.length - 2].h;
        last.h = up ? Math.max(last.h, k.h) : Math.min(last.h, k.h);
        last.l = up ? Math.max(last.l, k.l) : Math.min(last.l, k.l);
        last.to = i; continue;
      }
    }
    merged.push(k);
  }
  const fr = [];
  for (let i = 1; i < merged.length - 1; i++) {
    const a = merged[i - 1], b = merged[i], c = merged[i + 1];
    if (b.h > a.h && b.h > c.h) fr.push({ type: 'top', mi: i, price: b.h });
    else if (b.l < a.l && b.l < c.l) fr.push({ type: 'bottom', mi: i, price: b.l });
  }
  const pts = [];
  for (const f of fr) {
    if (!pts.length) { pts.push(f); continue; }
    const last = pts[pts.length - 1];
    if (last.type === f.type) { if (f.type === 'top' ? f.price > last.price : f.price < last.price) pts[pts.length - 1] = f; continue; }
    if (f.mi - last.mi >= minBars - 1) pts.push(f);
  }
  for (const p of pts) {
    const a = merged[p.mi].from, b = merged[p.mi].to;
    let idx = a, best = p.type === 'top' ? cs[a].h : cs[a].l;
    for (let i = a + 1; i <= b; i++) { const v = p.type === 'top' ? cs[i].h : cs[i].l; if (p.type === 'top' ? v > best : v < best) { best = v; idx = i; } }
    p.idx = idx; p.price = best;
  }
  return pts;
}

const lib = fs.readFileSync('public/vendor/lightweight-charts.js', 'utf8');
const specs = process.argv.slice(2).map(s => { const [sym, dir] = s.split(':'); return { sym, dir }; });
if (!specs.length) { console.log('用法: node tools/second-chart.mjs ORCAUSDT:short AINUSDT:long'); process.exit(1); }

const blocks = [];
for (const { sym, dir } of specs) {
  const r30 = await klines(sym, '30m'), r15 = await klines(sym, '15m');
  const csM = r30.filter(k => k.done), csS = r15.filter(k => k.done);
  const ma7M = sma(csM.map(k => k.c), 7), ma7S = sma(csS.map(k => k.c), 7);
  const pts = buildStrokes(csM, 5);

  let sk = null;
  for (let k = pts.length - 1; k >= 2; k--) {
    const C = pts[k], B = pts[k - 1], A = pts[k - 2];
    if (A.type === B.type || B.type === C.type) continue;
    if (B.idx - A.idx < 5 || C.idx - B.idx < 5) continue;
    const maB = ma7M[B.idx];
    if (!Number.isFinite(maB)) continue;
    if (A.type === 'top') { if (!(B.price < maB) || !(C.price < A.price)) continue; sk = { dir: 'short', A, B, C, maB }; }
    else { if (!(B.price > maB) || !(C.price > A.price)) continue; sk = { dir: 'long', A, B, C, maB }; }
    break;
  }
  if (!sk) { console.log(`  ${sym} 未找到骨架，跳过`); continue; }
  if ((dir === 'short') !== (sk.dir === 'short')) console.log(`  提示: ${sym} 实际方向是 ${sk.dir}`);

  const cT = csM[sk.C.idx].t;
  const seg15 = csS.map((k, i) => ({ k, ma: ma7S[i], i })).filter(x => Number.isFinite(x.ma) && x.k.t > cT);
  const ready = x => sk.dir === 'short' ? x.k.c < x.ma : x.k.c > x.ma;
  const lastReady = seg15.length && ready(seg15[seg15.length - 1]);
  const hadOther = seg15.some(x => !ready(x));

  const toCandles = cs => cs.map(k => ({ time: Math.floor(k.t / 1000), open: k.o, high: k.h, low: k.l, close: k.c }));
  const toLine = (cs, ma) => cs.map((k, i) => ({ time: Math.floor(k.t / 1000), value: ma[i] })).filter(p => Number.isFinite(p.value));

  // —— 视图窗口：只保留结构附近，否则 300 根压扁后 A/B/C 挤在右边缘看不出来 ——
  const winFrom30 = Math.max(0, sk.A.idx - 18);
  const w30 = csM.slice(winFrom30);
  const ma7Mwin = ma7M.slice(winFrom30);
  // 15m：从 A 的时间往前留一点，到最新
  const aT = csM[sk.A.idx].t;
  const winFrom15 = Math.max(0, csS.findIndex(k => k.t >= aT) - 12);
  const w15 = csS.slice(winFrom15);
  const ma7Swin = ma7S.slice(winFrom15);

  const mkMarkers = () => {
    const ms = [];
    const add = (p, text, color, position) => {
      if (p.idx < winFrom30) return;
      ms.push({ time: Math.floor(csM[p.idx].t / 1000), position, color, shape: 'circle', text });
    };
    add(sk.A, 'A ' + (sk.A.type === 'top' ? '左侧高点' : '左侧低点'), '#94a3b8', sk.A.type === 'top' ? 'aboveBar' : 'belowBar');
    add(sk.B, 'B ' + (sk.B.type === 'top' ? '高' : '低'), '#f0b90b', sk.B.type === 'top' ? 'aboveBar' : 'belowBar');
    add(sk.C, 'C ' + (sk.C.type === 'top' ? '高' : '低'), '#a855f7', 'aboveBar');
    return ms.sort((a, b) => a.time - b.time);
  };

  // 15m 图上标出「再次跌破/站上」的位置
  const breakIdx = (() => {
    for (let j = seg15.length - 1; j >= 0; j--) {
      const cur = ready(seg15[j]);
      const prevNow = j > 0 ? ready(seg15[j - 1]) : false;
      if (cur && seg15.slice(0, j).some(x => !ready(x))) return seg15[j];
    }
    return null;
  })();

  const label = sk.dir === 'short' ? '二卖（上穿零轴段失败 → 次级别再跌破）' : '二买（回踩不破前低 → 次级别再站上）';
  blocks.push({
    sym, dir: sk.dir, label,
    candles30: toCandles(w30), ma30: toLine(w30, ma7Mwin), markers: mkMarkers(),
    candles15: toCandles(w15), ma15: toLine(w15, ma7Swin),
    break15: breakIdx ? { time: Math.floor(breakIdx.k.t / 1000), price: breakIdx.k.c, ma: breakIdx.ma } : null,
    info: {
      b1: sk.B.idx - sk.A.idx, b2: sk.C.idx - sk.B.idx,
      a: sk.A.price, b: sk.B.price, c: sk.C.price,
      after: csM.length - 1 - sk.C.idx,
      lastReady, hadOther,
      sClose: csS[csS.length - 1].c, sMa: ma7S[csS.length - 1],
      cTime: new Date(cT).toLocaleString('zh-CN'),
    },
  });
}

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
  *{box-sizing:border-box}
  body{margin:0;background:#0a1018;color:#c9d6e5;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif}
  .wrap{padding:16px}
  .card{background:#0d1622;border:1px solid #1c2b3d;border-radius:10px;margin-bottom:14px;overflow:hidden}
  .hd{display:flex;align-items:center;gap:10px;padding:9px 13px;border-bottom:1px solid #1c2b3d;background:#0b131d}
  .sym{font-size:15px;font-weight:700;color:#f0b90b}
  .tag{font-size:11px;padding:1px 7px;border-radius:4px;border:1px solid}
  .short{color:#ef4444;border-color:#ef4444;background:#ef444418}
  .long{color:#22c55e;border-color:#22c55e;background:#22c55e18}
  .desc{color:#8ba0bd;font-size:12px}
  .row{display:flex}
  .pane{flex:1;border-right:1px solid #16202e}
  .pane:last-child{border-right:0}
  .ttl{padding:5px 10px;color:#8ba0bd;font-size:12px;border-bottom:1px solid #16202e}
  .ttl b{color:#e2e8f0}
  .chart{height:330px}
  .foot{padding:8px 13px;color:#7b90ab;font-size:12px;border-top:1px solid #16202e;display:flex;gap:18px;flex-wrap:wrap}
  .foot b{color:#c9d6e5;font-weight:600}
  .k{color:#f0b90b}
</style></head><body><div class="wrap" id="root"></div>
<script>${lib}</script>
<script>
const data = ${JSON.stringify(blocks)};
const UP='#22c55e', DN='#ef4444', MA='#f0b90b';
const root = document.getElementById('root');
const baseOpts = {
  layout:{background:{color:'#0d1622'},textColor:'#8ba0bd',fontSize:11},
  grid:{vertLines:{color:'#16202e'},horzLines:{color:'#16202e'}},
  rightPriceScale:{borderColor:'#1c2b3d'},
  timeScale:{borderColor:'#1c2b3d',timeVisible:true,secondsVisible:false},
  crosshair:{mode:0},
  handleScroll:false, handleScale:false,
};
function draw(el, candles, ma, markers, priceLines){
  const chart = LightweightCharts.createChart(el, baseOpts);
  const cs = chart.addCandlestickSeries({upColor:UP,downColor:DN,borderUpColor:UP,borderDownColor:DN,wickUpColor:UP,wickDownColor:DN,
    lastValueVisible:false, priceLineVisible:false});
  cs.setData(candles);
  const m = chart.addLineSeries({color:MA,lineWidth:1.5,priceLineVisible:false,lastValueVisible:false,crosshairMarkerVisible:false});
  m.setData(ma);
  if (markers && markers.length) cs.setMarkers(markers);
  if (priceLines) for (const pl of priceLines){
    cs.createPriceLine({price:pl.price,color:pl.color,lineWidth:1,lineStyle:2,axisLabelVisible:true,title:pl.title});
  }
  chart.timeScale().fitContent();
  return chart;
}
for (const b of data){
  const wrap = document.createElement('div');
  wrap.className='card';
  const i = b.info;
  wrap.innerHTML = \`
    <div class="hd">
      <span class="sym">\${b.sym}</span>
      <span class="tag \${b.dir}">\${b.dir==='short'?'二卖 · 做空':'二买 · 做多'}</span>
      <span class="desc">\${b.label}</span>
    </div>
    <div class="row">
      <div class="pane"><div class="ttl"><b>30分 主级别</b> · MA7 黄线 · A/B/C 为笔端点</div><div class="chart" id="c30-\${b.sym}"></div></div>
      <div class="pane"><div class="ttl"><b>15分 次级别</b> · MA7 黄线 · 触发点</div><div class="chart" id="c15-\${b.sym}"></div></div>
    </div>
    <div class="foot">
      <span>① 主级别笔 <b>\${i.b1} 根</b></span>
      <span>② 反弹笔 <b>\${i.b2} 根</b></span>
      <span>A=<b class="k">\${i.a}</b> B=<b class="k">\${i.b}</b> C=<b class="k">\${i.c}</b></span>
      <span>\${b.dir==='short'?'C 未破左侧高点 A':'C 未破左侧低点 A'} <b>\${b.dir==='short'?(i.c<i.a?'✓':'✗'):(i.c>i.a?'✓':'✗')}</b></span>
      <span>C 之后 <b>\${i.after} 根</b>(30m)</span>
      <span>15m 曾到反侧 <b>\${i.hadOther?'✓':'✗'}</b> · 现在 \${b.dir==='short'?'跌破':'站上'} MA7 <b>\${i.lastReady?'✓':'✗'}</b> (收\${i.sClose} / MA7 \${i.sMa.toPrecision(6)})</span>
      <span>C 时间 <b>\${i.cTime}</b></span>
    </div>\`;
  root.appendChild(wrap);
  draw(document.getElementById('c30-'+b.sym), b.candles30, b.ma30, b.markers,
    [{price:i.a,color:'#94a3b8',title:'A',axisLabelVisible:true},
     {price:i.b,color:'#f0b90b',title:'B',axisLabelVisible:false},
     {price:i.c,color:'#a855f7',title:'C',axisLabelVisible:false}]);
  const pl15 = b.break15 ? [{price:b.break15.ma,color:'#64748b',title:'MA7@触发'}] : null;
  draw(document.getElementById('c15-'+b.sym), b.candles15, b.ma15,
    b.break15 ? [{time:b.break15.time,position:b.dir==='short'?'aboveBar':'belowBar',color:'#a855f7',shape:'arrowDown',text:b.dir==='short'?'再次跌破':'再次站上'}] : null,
    pl15);
}
document.title='二买二卖结构图';
</script></body></html>`;

const out = path.resolve('data/second-chart.html');
fs.writeFileSync(out, html);
console.log('  HTML 已生成:', out, `(${(html.length / 1024).toFixed(0)} KB, ${blocks.length} 个标的)`);

// 截图
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p));
const png = path.resolve('docs/img/second-buy-sell.png');
const height = 190 + blocks.length * 400;
execFileSync(CHROME, [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
  `--window-size=1880,${height}`, `--screenshot=${png}`, '--virtual-time-budget=4000',
  'file:///' + out.replace(/\\/g, '/'),
], { stdio: 'ignore' });
console.log('  截图已生成:', png, `(${(fs.statSync(png).size / 1024).toFixed(0)} KB)`);
