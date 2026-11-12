/** 验证：固定一个「不在标的池里」的币种，它不会被删掉，卡片能一直画出来 */
const B = 'http://127.0.0.1:8848';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (n, c, d = '') => { if (c) { pass++; console.log('  \u001b[32m✓\u001b[0m ' + n + (d ? '  \u001b[2m' + d + '\u001b[0m' : '')); } else { fail++; console.log('  \u001b[31m✗\u001b[0m ' + n + (d ? '  \u001b[31m' + d + '\u001b[0m' : '')); } };
const get = async p => (await fetch(B + p)).json();

const snap = await get('/api/snapshot');
const inUniverse = new Set(snap.symbols || []);
console.log('  当前标的池:', inUniverse.size, '个');

// 找一个「在币安合约里存在、但不在我们池子里」的币
const tickers = await (await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr')).json();
const usdt = tickers
  .filter(t => t.symbol.endsWith('USDT'))
  .map(t => ({ sym: t.symbol, qv: Number(t.quoteVolume), pct: Math.abs(Number(t.priceChangePercent)) }))
  .filter(t => !inUniverse.has(t.sym) && t.qv > 2_000_000)
  .sort((a, b) => a.qv - b.qv);      // 取小的，确保不会混进榜
const target = usdt[0];
if (!target) { console.log('  ✗ 找不到池外标的'); process.exit(1); }
console.log('  选一个池外标的:', target.sym, ' 成交额', (target.qv / 1e4).toFixed(0) + '万', ' 涨跌幅', target.pct.toFixed(2) + '%');

const pinId = 'p|' + target.sym + '|15m-2h';
const enc = encodeURIComponent(pinId);

// ① 立刻请求：此时 symbols 里还没有它，出不来（这是已知限制）
const r0 = await get(`/api/pairgrid?bars=60&limit=5&pin=${enc}`);
const has0 = (r0.items || []).some(x => x.symbol === target.sym);
console.log('  ① 立刻请求：出现 =', has0, '（还没进池，预期 false）');

// ② 等 80 秒让 universe 刷新（60 秒一次），把它拉进池子
console.log('  ② 等 80 秒让标的池刷新…');
await sleep(80_000);

const st = await get('/api/stats');
console.log('     刷新后标的池:', st.market.symbols, '个');

const r1 = await get(`/api/pairgrid?bars=60&limit=5&pin=${enc}`);
const got1 = (r1.items || []).find(x => x.symbol === target.sym);
console.log('  ③ 再次请求：出现 =', !!got1, got1 ? ('K线 ' + (got1.candles || []).length + ' 根，pinnedOnly=' + got1.pair.pinnedOnly) : '');
ok('★ 固定的池外标的被拉进池子并画出K线', !!got1 && (got1.candles || []).length > 0,
  got1 ? (got1.candles || []).length + ' 根' : '没出现');

// ④ 再等一轮刷新，确认它没被删掉（这就是原来会消失的场景）
console.log('  ④ 再等 75 秒，跨过一次标的池刷新…');
await sleep(75_000);
const r2 = await get(`/api/pairgrid?bars=60&limit=5&pin=${enc}`);
const got2 = (r2.items || []).find(x => x.symbol === target.sym);
ok('★ 跨过标的池刷新后卡片仍在（不再消失）', !!got2 && (got2.candles || []).length > 0,
  got2 ? (got2.candles || []).length + ' 根' : '消失了');

// ⑤ 它不该出现在配对扫描里（rank=0，不参与策略）
const pz = await get('/api/pairzero');
const inScan = (pz.items || []).some(x => x.symbol === target.sym);
ok('★ 保留下来的标的不会参与策略扫描（rank=0）', inScan === false, inScan ? '✗ 出现在配对信号里' : '未出现');

// ⑥ 不再传 pin 之后，它会自然释放
const r3 = await get('/api/pairgrid?bars=60&limit=5');
const gone = !(r3.items || []).some(x => x.symbol === target.sym);
ok('不传 pin 时不再返回它', gone);

console.log(`\n${fail === 0 ? '\u001b[32m全部通过\u001b[0m' : '\u001b[31m存在失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败`);
process.exitCode = fail ? 1 : 0;
