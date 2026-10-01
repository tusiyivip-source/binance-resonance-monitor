/** 把 lightweight-charts 下载到 public/vendor/，保证离线可用（不走 CDN） */
import fs from 'node:fs';
import path from 'node:path';

const VER = '4.1.3';
const url = `https://unpkg.com/lightweight-charts@${VER}/dist/lightweight-charts.standalone.production.js`;
const out = path.resolve('public/vendor/lightweight-charts.js');
fs.mkdirSync(path.dirname(out), { recursive: true });

const r = await fetch(url, { redirect: 'follow' });
if (!r.ok) { console.log('失败: HTTP ' + r.status); process.exit(1); }
const t = await r.text();
fs.writeFileSync(out, t, 'utf8');

console.log(`已保存 ${out}`);
console.log(`大小 ${(t.length / 1024).toFixed(1)} KB`);
const vm = t.match(/version\s*[:=]\s*["']([\d.]+)["']/);
console.log('版本 ' + (vm ? vm[1] : '(未识别)'));
for (const api of ['createChart', 'addCandlestickSeries', 'addLineSeries', 'addHistogramSeries',
  'CrosshairMode', 'subscribeCrosshairMove', 'setMarkers']) {
  console.log(`  ${api.padEnd(24)} ${t.includes(api) ? '✓' : '✗'}`);
}
