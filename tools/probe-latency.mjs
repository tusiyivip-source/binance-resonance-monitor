/** 量化报警延迟：K线收盘时刻 → 实际报警时刻 */
const B = 'http://127.0.0.1:8848';
const LEVEL_MS = { '2m': 120e3, '3m': 180e3, '5m': 300e3, '10m': 600e3, '15m': 900e3, '30m': 1800e3,
  '1h': 3600e3, '2h': 7200e3, '3h': 10800e3, '4h': 14400e3, '6h': 21600e3, '12h': 43200e3, '1d': 86400e3, '1w': 604800e3 };

const a = await (await fetch(B + '/api/alerts')).json();
const list = Array.isArray(a) ? a : (a.alerts || []);
console.log('  报警总数:', list.length);

const byLevel = {};
for (const x of list) {
  const lv = x.levelLabel || x.level || x.mid || x.base;
  const key = x.level || x.mid || x.base;
  const ms = LEVEL_MS[key];
  if (!ms || !x.candleT || !x.ts) continue;
  const closesAt = x.candleT + ms;          // 这根K线真正收盘的时刻
  const delay = x.ts - closesAt;            // 实际报警滞后多久
  if (delay < -5000 || delay > 3600e3) continue;
  (byLevel[lv] ??= []).push(delay);
}

const fmt = ms => ms < 1000 ? Math.round(ms) + 'ms' : (ms / 1000).toFixed(1) + 's';
console.log('\n  级别      条数   中位延迟    最大延迟');
for (const [lv, arr] of Object.entries(byLevel)) {
  arr.sort((p, q) => p - q);
  const med = arr[(arr.length - 1) >> 1];
  const max = arr[arr.length - 1];
  console.log('  ' + lv.padEnd(8) + String(arr.length).padStart(4) + '   ' + fmt(med).padStart(9) + '   ' + fmt(max).padStart(9));
}

const all = Object.values(byLevel).flat().sort((p, q) => p - q);
if (all.length) {
  console.log('\n  总体：中位 ' + fmt(all[(all.length - 1) >> 1]) + '   90分位 ' + fmt(all[Math.floor(all.length * 0.9)]) + '   最大 ' + fmt(all[all.length - 1]));
}
