const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const sourceRoot = fs.existsSync(path.join(__dirname, '../public/app.js'))
  ? path.join(__dirname, '../public') : __dirname;

function setup() {
  const nodes = new Map(), events = new Map();
  const element = () => ({ textContent: '', innerHTML: '', className: '', style: {}, checked: false, value: '',
    disabled: false, childElementCount: 1, children: [], dataset: {},
    classList: { contains: () => true, toggle() {}, add() {}, remove() {} },
    addEventListener(name, fn) { this[name] = fn; }, querySelectorAll: () => [], after() {}, appendChild() {},
  });
  const document = { hidden: false, querySelector: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], createElement: element, createDocumentFragment: element,
    addEventListener(name, fn) { events.set(name, fn); }, body: element(),
  };
  const context = vm.createContext({ document, window: { LightweightCharts: {} }, localStorage: { getItem: () => null },
    console, performance: { now: () => 20000 }, setTimeout, clearTimeout, setInterval, clearInterval,
    AbortController, structuredClone, fetch: async () => ({ ok: true, json: async () => ({}) }),
  });
  const app = fs.readFileSync(path.join(sourceRoot, 'app.js'), 'utf8').split('/* ---------------- 启动 ---------------- */')[0];
  const chart = fs.readFileSync(path.join(sourceRoot, 'chart.js'), 'utf8').split("if (typeof LC === 'undefined')")[0];
  vm.runInContext(app, context); vm.runInContext(chart, context);
  return { context, nodes, document, events, run: code => vm.runInContext(code, context) };
}

test('short and long signals use their own direction; missing price remains unknown', () => {
  const { run } = setup();
  assert.equal(run("signalChange({price:100,side:'short'},90)"), 10);
  assert.equal(run("signalChange({price:100,side:'long'},90)"), -10);
  assert.equal(run("signalChange({price:100,side:'short'},null)"), null);
});

test('an upstream health refresh cannot hide a stale or broken page stream', () => {
  const { run, nodes } = setup();
  run("marketHealth={kind:'ok',text:'行情在线'}; streamState='error'; lastSnapAt=19500; renderConnection()");
  assert.equal(nodes.get('#pill-ws').className, 'pill bad');
  run("streamState='open'; lastSnapAt=1000; renderConnection()");
  assert.equal(nodes.get('#pill-ws').className, 'pill bad');
  run('lastSnapAt=19500; renderConnection()');
  assert.equal(nodes.get('#pill-ws').className, 'pill ok');
});

test('HTTP errors reject configuration saves and retain the original config', async () => {
  const { run, context } = setup();
  run("cfg={bigMa:'ema7'}");
  context.fetch = async () => ({ ok: false, status: 500, json: async () => ({ error: '保存失败' }) });
  await assert.rejects(run("postCfg({bigMa:'ma7'})"), /保存失败/);
  assert.equal(run('cfg.bigMa'), 'ema7');
});

test('series updates skip unchanged data, update the latest bar, and reset for historical repairs', () => {
  const { context, run } = setup();
  const calls = [];
  context.series = { setData: points => calls.push(['set', points.length]), update: point => calls.push(['update', point.time]) };
  run('syncSeries(series,[{time:1,value:2},{time:2,value:3}])');
  run('syncSeries(series,[{time:1,value:2},{time:2,value:3}])');
  run('syncSeries(series,[{time:1,value:2},{time:2,value:4}])');
  run('syncSeries(series,[{time:1,value:2},{time:2,value:4},{time:3,value:5}])');
  run('syncSeries(series,[{time:1,value:9},{time:2,value:4},{time:3,value:5}])');
  run('syncSeries(series,[])');
  assert.deepEqual(calls, [['set',2],['update',2],['update',3],['set',3],['set',0]]);
});

test('late chart responses are discarded even if the transport ignores abort', async () => {
  const { run, context } = setup();
  const pending = [];
  context.fetch = url => new Promise(resolve => pending.push({url, resolve}));
  run("activeView='multi'");
  const old = run("fetchChart(VIEWS.multi,'/chart?symbol=BTC')");
  const current = run("fetchChart(VIEWS.multi,'/chart?symbol=ETH')");
  pending[1].resolve({ ok: true, json: async () => ({symbol:'ETH'}) });
  assert.equal((await current).symbol, 'ETH');
  pending[0].resolve({ ok: true, json: async () => ({symbol:'BTC'}) });
  assert.equal(await old, null);
});

test('same chart request is not duplicated while pending', async () => {
  const { run, context } = setup();
  let resolve, count = 0;
  context.fetch = () => { count++; return new Promise(r => resolve = r); };
  run("activeView='multi'");
  const first = run("fetchChart(VIEWS.multi,'/chart')");
  assert.equal(await run("fetchChart(VIEWS.multi,'/chart')"), null);
  assert.equal(count, 1);
  resolve({ok:true,json:async()=>({symbol:'BTC'})}); await first;
});

test('hidden pages do not start chart polling and discard in-flight results', async () => {
  const { run, context, document } = setup();
  let resolve, count = 0;
  context.fetch = () => { count++; return new Promise(r => resolve=r); };
  run("activeView='multi'");
  const pending = run("fetchChart(VIEWS.multi,'/chart')");
  document.hidden = true;
  run('refreshActive()');
  resolve({ok:true,json:async()=>({symbol:'BTC'})});
  assert.equal(await pending, null); assert.equal(count,1);
});

test('coin navigation follows the latest filter, including an empty filter', () => {
  const {run} = setup();
  run("SNAP={symbols:['BTC','ETH']}; DISPLAY_ORDER=['BTC','ETH']; ensureChartList()");
  run("DISPLAY_ORDER=['ETH']; ensureChartList()");
  assert.equal(run("chartList.join(',')"),'ETH');
  run('DISPLAY_ORDER=[]');
  assert.equal(run('ensureChartList()'), false);
  assert.equal(run('chartList.length'),0);
});

test('saving captures edited groups and push settings before postCfg refills the form', async () => {
  const {run, context, nodes} = setup();
  const writes=[];
  context.fetch=async (url, options) => {
    const body=JSON.parse(options.body); writes.push({url,body});
    return {ok:true,json:async()=>structuredClone(body)};
  };
  run(`bind();
    cfg={groups:[{base:'2m',mid:'10m',big:'1h',enabled:true}]};
    ALL_LEVELS=[{key:'2m'},{key:'10m'},{key:'1h'}];
    readCfgForm=()=>({bigMa:'ma7'}); CFG_SNAPSHOT={bigMa:'ema7'};
    collectPush=()=>({enabled:true,channels:[]});
    fillCfgForm=()=>{cfg.groups=[]};
    renderAlerts=()=>{}; renderPush=()=>{}; renderGroups=()=>{}; updateGroupChip=()=>{}; toast=()=>{};
  `);
  const button=nodes.get('#btn-cfgsave');
  await button.click({currentTarget:button});
  assert.equal(writes.length,2);
  assert.equal(writes[0].body.groups[0].mid,'10m');
  assert.equal(writes[0].body.bigMa,'ma7');
  assert.equal(writes[1].body.enabled,true);
  assert.equal(button.disabled,false);
});

test('price-only alert refresh reuses the cards and updates the short direction', () => {
  const {run, nodes} = setup();
  const output={textContent:'',style:{}};
  run("alerts=[{symbol:'BTC',price:100,side:'short'}]; renderedAlerts=alerts.slice(); PRICE.set('BTC',90)");
  const box = run("$('#alertlist')");
  box.querySelectorAll=()=>[output];
  run('renderAlerts()');
  assert.equal(output.textContent,'看空表现 +10.00%');
  assert.equal(output.style.color,'#22c55e');
});
