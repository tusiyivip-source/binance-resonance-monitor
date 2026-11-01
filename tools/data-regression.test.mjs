import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CandleSeries } from '../src/series.js';
import { Engine } from '../src/engine.js';
import { Tracker } from '../src/tracker.js';
import { memoryStorage } from '../src/file-storage.js';
import { Market } from '../src/market.js';
import { LEVELS } from '../src/config.js';

const log = { info() {}, warn() {}, ok() {} };
const row = (t, done = false) => ({ t, o: 100, h: 110, l: 90, c: 100, v: 1, q: 100, n: 1, done });

test('weekly ticks stay in Monday candle until the next Monday', t => {
  const now = Date.UTC(2026, 10, 1, 6);
  t.mock.method(Date, 'now', () => now);
  const monday = Date.UTC(2026, 9, 26);
  const s = new CandleSeries({ key: '1w', minutes: 10080 });
  s.bulkLoad([row(monday - s.ms, true), row(monday)]);
  assert.equal(s.applyTick(105, now), false);
  assert.deepEqual(s.t, [monday - s.ms, monday]);
  assert.equal(s.done[1], false);
  assert.equal(s.lastClosedIndex, 0);
  assert.equal(s.applyTick(106, monday + s.ms), true);
  assert.equal(s.t.at(-1), monday + s.ms);
  assert.equal(s.lastClosedIndex, 1);
});

test('cache restoration removes malformed Thursday weeks and reopens current Monday', t => {
  const now = Date.UTC(2026, 10, 1);
  t.mock.method(Date, 'now', () => now);
  const monday = Date.UTC(2026, 9, 26);
  const s = new CandleSeries({ key: '1w', minutes: 10080 });
  s.mergeLoad([row(monday - s.ms, true), row(monday, true), row(monday + 3 * 86400000)]);
  assert.deepEqual(s.t, [monday - s.ms, monday]);
  assert.deepEqual(s.done, [true, false]);
  s.applyTick(101, now);
  assert.equal(s.length, 2);
});

test('market restoration requests authoritative weekly OHLC after repairing corrupt cache', t => {
  const now=Date.UTC(2026,10,1), monday=Date.UTC(2026,9,26);
  t.mock.method(Date,'now',()=>now);
  const market=new Market(null,log);
  const state={series:Object.fromEntries(LEVELS.map(l=>[l.key,new CandleSeries(l)]))};
  market.symbols.set('TEST',state);
  market.applyCache({savedAt:now,symbols:{TEST:{'1w':[[monday,100,110,90,100,1,100,1,1],[monday+3*86400000,100,101,99,100,1,100,1,0]]}}});
  assert.deepEqual(state.series['1w'].t,[monday]);
  assert.equal(state.series['1w'].done[0],false);
  assert.ok(state.cacheStaleLevels.includes('1w'));
});

test('rising-only filter runs before indicator scanning',()=>{
  const state={seeded:true,changePct:-1,series:new Proxy({},{get(){throw new Error('Filtered symbol should not be scanned')}})};
  const engine=new Engine({universe:['DOWN'],symbols:new Map([['DOWN',state]])},log);
  assert.equal(engine.zeroAxis({onlyUp:'1'}).items.length,0);
});

test('seven independent levels never require a main timeframe or candle structure', () => {
  const keys=['15m','30m','1h','2h','3h','4h','6h'];
  const seriesFor=key=>{
    const minutes=LEVELS.find(l=>l.key===key).minutes,ms=minutes*60000,n=44,end=Math.floor(Date.now()/ms)*ms;
    const dif=[...Array(40).fill(10),8,4,2,1],dea=dif.map(x=>x/2);
    return {t:Array.from({length:n},(_,i)=>end-(n-i)*ms),ms,lastClosedIndex:n-1,ensure:()=>({macd:{dif,dea,hist:dif.map((v,i)=>2*(v-dea[i]))}})};
  };
  const st={seeded:true,price:100,changePct:1,quoteVolume:100,series:{'15m':seriesFor('15m')}};
  const e=new Engine({universe:['TEST'],symbols:new Map([['TEST',st]])},log);
  e.levelPayload=(state,key)=>({key,candles:[]});
  e.zeroStructure=()=>{throw new Error('Single monitor must not consult pair structure')};
  const single=e.zeroCharts(120,24);
  assert.deepEqual(single.levels,keys);assert.equal(single.mode,'single');
  assert.equal(single.items.length,1);assert.equal(single.items[0].key,'15m');assert.ok(!('pair' in single.items[0]));
  for(const key of keys)st.series[key]=seriesFor(key);
  const all=e.zeroAxis();assert.equal(all.items.length,7);assert.equal(all.monitors[0].length,7);
  assert.deepEqual([...new Set(all.items.map(i=>i.level))].sort(),[...keys].sort());
  const chart=e.zeroCharts(120,3);assert.equal(chart.items.length,3);assert.equal(chart.total,7);
  assert.ok(chart.items.every(i=>i.zero.firstNearBarAt!=null));
  assert.ok(chart.items.every((i,n,arr)=>!n||arr[n-1].zero.firstNearAt<=i.zero.firstNearAt));
});

test('alert payload preserves confirmation and pair identity', () => {
  const e = new Engine({ symbols: new Map([['TEST', {}]]) }, log);
  e.alerts = [{ symbol: 'TEST', kind: 'zeropair', mode: 'zeropair', confirmed: true, sub: '15m', main: '2h', pair: '15m-2h', level: '15m' }];
  e.levelPayload = () => ({ candles: [] });
  const item = e.alertCharts().items[0];
  assert.equal(item.mode, 'closed');
  assert.equal(item.confirmed, true);
  assert.equal(item.pair, '15m-2h');
});

test('tracker keeps same-candle pairs separate and stores direction', () => {
  const tr = new Tracker('', log, memoryStorage());
  const a = { symbol: 'TEST', kind: 'zeropair', side: 'short', price: 100, confirmed: true, candleT: 1, mode: 'zeropair' };
  assert.ok(tr.record({ ...a, pair: '15m-2h' }));
  assert.ok(tr.record({ ...a, pair: '30m-3h' }));
  assert.equal(tr.record({ ...a, pair: '15m-2h' }), null);
  assert.equal(tr.entries[0].side, 'short');
  assert.equal(tr.entries[0].score, null);
  assert.equal(tr.stats().byScore.find(b => b.name === '未评分').n, 2);
});

test('settlement follows direction and refuses stale settlement prices', t => {
  const now = Date.UTC(2026, 10, 1, 12), ts = now - 2 * 3600000;
  t.mock.method(Date, 'now', () => now);
  const tr = new Tracker('', log, memoryStorage());
  for (const side of ['long', 'short']) tr.record({ symbol: side, kind: 'zeropair', side, price: 100, ts, candleT: ts, pair: '15m-2h' });
  const ms = 180000, target = ts + 3600000;
  const series = { t: [target - ms], c: [90], ms, done: [true] };
  const market = { symbols: new Map(['long', 'short'].map(side => [side, { seeded: true, series: { '3m': series } }])) };
  tr.resolve(market, true);
  assert.equal(tr.entries[0].out.h1, -10);
  assert.equal(tr.entries[1].out.h1, 10);
  assert.equal(Tracker.priceAt(series, target + 2 * ms), null);
});

test('legacy history is preserved without inventing its missing direction', () => {
  const store = memoryStorage();
  store.append(JSON.stringify({ id: 1, symbol: 'OLD', initial: false, confirmed: true, score: 0, out: { h1: 5 } }) + '\n');
  const tr = new Tracker('', log, store), stats = tr.stats();
  assert.equal(stats.total, 1);
  assert.equal(stats.tracked, 0);
  assert.equal(stats.legacyExcluded, 1);
  assert.equal(stats.horizons[0].n, 0);
  assert.equal(stats.recent[0].legacy, true);
  assert.equal(tr.entries[0].out.h1, 5);
});
