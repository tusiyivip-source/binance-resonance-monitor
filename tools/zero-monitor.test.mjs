import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZERO_LEVEL_KEYS, zeroMonitorAt, zeroOptions, compareZero } from '../src/zero-monitor.js';
import { Engine } from '../src/engine.js';

const opt = zeroOptions();
function sample(tail, minutes = 15, before = 40) {
  const dif = [...Array(before).fill(10), ...tail.map(x => x[0])];
  const dea = [...Array(before).fill(11), ...tail.map(x => x[1])];
  const ms = minutes * 60_000, end = Math.floor(Date.now() / ms) * ms;
  const t = dif.map((_, i) => end - (dif.length - i) * ms);
  const ind = {macd: {dif, dea, hist:dif.map((x,i)=>(x-dea[i])*2)}};
  const series = {t, ms, lastClosedIndex:t.length-1, ensure:()=>ind};
  return {series, ind, at: (i = t.length-1, options=opt) => zeroMonitorAt(series, ind, i, options)};
}
test('golden cross is visible before proximity; first near is the earliest post-cross close', () => {
  const x = sample([[8,7],[4,3],[2,1],[1,.5]]);
  const watch = x.at(40), near = x.at();
  assert.equal(watch.cross,'golden'); assert.equal(watch.phase,'watch'); assert.equal(watch.firstNearAt,null);
  assert.equal(near.phase,'near'); assert.equal(near.firstNearAt,x.series.t[42]+x.series.ms);
  assert.equal(near.crossAt,x.series.t[40]+x.series.ms);
  assert.equal(near.near,.1);
});
test('reverse cross starts a new episode and may be near on the same candle', () => {
  const x=sample([[8,7],[2,1],[1,2],[.5,1]]), z=x.at();
  assert.equal(z.cross,'death'); assert.equal(z.crossAt,x.series.t[42]+x.series.ms);
  assert.equal(z.firstNearAt,z.crossAt);
});
test('equality neither produces duplicate crosses nor loses a true crossing', () => {
  const x=sample([[8,7],[7,7],[6,6],[5,4],[4,4],[3,4]]);
  assert.equal(x.at(43).crossAt,x.series.t[40]+x.series.ms);
  assert.equal(x.at().cross,'death'); assert.equal(x.at().barsSinceCross,0);
});
test('historic thresholds do not borrow the future peak and prior near is not reused after cross', () => {
  const x=sample([[2,3],[8,7],[4,3],[100,90],[2,1]]);
  assert.equal(x.at(42).firstNearAt,null);
  assert.equal(x.at().firstNearAt,x.series.t[44]+x.series.ms);
  assert.equal(x.at(42,zeroOptions({near:.5})).firstNearAt,x.series.t[42]+x.series.ms);
});
test('unknown crossings and all-flat data never invent a first-near time', () => {
  const x=sample([[2,3]]);
  assert.equal(x.at().cross,null); assert.equal(x.at().firstNearAt,null);
  x.ind.macd.dif.fill(0); x.ind.macd.dea.fill(0);
  assert.equal(x.at(),null);
});
test('gaps and invalid indicator values break the cross history', () => {
  const x=sample([[8,7],[2,1],[1,.5]]);
  x.series.t[42]+=x.series.ms;
  assert.equal(x.at().cross,null);
  const y=sample([[8,7],[2,1],[1,.5]]);
  y.ind.macd.dea[41]=NaN;
  assert.equal(y.at().cross,null);
});
test('leaving near zone is not labelled as waiting for the first approach', () => {
  const x=sample([[8,7],[2,1],[6,5]]);
  assert.equal(x.at().phase,'idle');
});
test('confirmed proximity sorts before watch; earlier near precedes smaller distance', () => {
  const rows=[{sym:'B',k:'15m',z:{phase:'near',firstNearAt:200,near:.01}},
    {sym:'A',k:'15m',z:{phase:'near',firstNearAt:100,near:.2}},
    {sym:'C',k:'15m',z:{phase:'watch',crossAt:1,near:.6}}];
  assert.deepEqual(rows.sort(compareZero).map(x=>x.sym),['A','B','C']);
});
test('option normalization preserves zero and rejects nonfinite inputs', () => {
  assert.equal(zeroOptions({near:0,minQual:0}).maxNear,0);
  assert.equal(zeroOptions({near:'Infinity',minQual:99}).maxNear,.3);
  assert.equal(zeroOptions({minQual:99}).minQual,7);
});
function engineFixture() {
  const early=sample([[8,7],[2,1],[2,1],[2,1]]);
  const late=sample([[8,7],[6,5],[5,4],[.1,0]]);
  const death=sample([[8,7],[6,5],[5,4],[2,3]]);
  const state=x=>({seeded:true,price:10,changePct:1,quoteVolume:100,series:{'15m':x.series,'5m':x.series}});
  const market={universe:['LATE','EARLY','DEATH'],symbols:new Map([['LATE',state(late)],['EARLY',state(early)],['DEATH',state(death)]])};
  const e=new Engine(market,{});
  e.levelPayload=(st,k)=>({key:k,candles:[]});
  return {e,early,late,death};
}
test('both APIs use seven levels and chronological sorting; filters run before limit', () => {
  const {e}=engineFixture(), chart=e.zeroCharts(150,1);
  assert.deepEqual(chart.levels,ZERO_LEVEL_KEYS); assert.equal(chart.items[0].symbol,'EARLY');
  const filtered=e.zeroCharts(150,1,{cross:'death'});
  assert.equal(filtered.total,1); assert.equal(filtered.items[0].symbol,'DEATH');
  const table=e.zeroAxis({cross:'golden'});
  assert.deepEqual(table.symbols,['EARLY','LATE']);
  assert.equal(table.monitors[0].length,7);
  assert.equal(e.zeroCharts(150,24,{minQual:2}).total,0);
  assert.equal(e.zeroCharts(150,24,{q:'late'}).items[0].symbol,'LATE');
});
test('unfinished and future bars are excluded; stale data is excluded', () => {
  const {e,early}=engineFixture();
  early.series.lastClosedIndex=40;
  const result=e.zeroAxis({q:'early'});
  // This old confirmed bar is stale, even if a newer unfinished bar exists.
  assert.equal(result.symbols.length,0);
  const {e:e2,late}=engineFixture();
  late.series.t[43]=Date.now()+60_000;
  assert.equal(e2.zeroCharts(150,24,{q:'late',phase:'near'}).total,0);
});
test('combined charts reserve space for waiting crosses while preserving within-stage chronology', () => {
  const {e}=engineFixture();
  const waiting=sample([[9,8],[8,7],[7,6],[6,5]]);
  e.market.universe.push('WAIT');
  e.market.symbols.set('WAIT',{seeded:true,price:10,series:{'15m':waiting.series}});
  const both=e.zeroCharts(150,3);
  assert.equal(both.items.length,3);
  assert.equal(both.items[2].symbol,'WAIT');
  const only=e.zeroCharts(150,3,{phase:'near'});
  assert.equal(only.items.length,3);
  assert.ok(only.items.every(x=>x.zero.phase==='near'));
});
