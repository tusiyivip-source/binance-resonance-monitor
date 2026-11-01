const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

class Element {
  constructor(fragment = false) {
    this.fragment = fragment; this.children = []; this.listeners = {}; this.nodes = new Map();
    this.value = ''; this.checked = true; this.className = ''; this._text = ''; this.innerHTML = '';
    this.clientWidth = 1000; this.clientHeight = 700; this.style = { setProperty() {} };
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: name => { if (!this.classList.contains(name)) this.className += ' ' + name; },
      remove: name => { this.className = this.className.split(/\s+/).filter(n => n !== name).join(' '); },
      toggle: (name, force) => { const on = force ?? !this.classList.contains(name); this.classList[on ? 'add' : 'remove'](name); return on; },
    };
  }
  get childElementCount() { return this.children.length; }
  get lastElementChild() { return this.children.at(-1); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(node) { if (node.fragment) this.children.push(...node.children); else this.children.push(node); return node; }
  removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
  querySelector(s) { if (!this.nodes.has(s)) this.nodes.set(s, new Element()); return this.nodes.get(s); }
  querySelectorAll() { return []; }
  addEventListener(event, fn) { (this.listeners[event] ??= []).push(fn); }
  after() {} blur() {} remove() {} focus() { this.focused = true; }
}
function setup() {
  const document = new Element(); document.hidden = false;
  document.createElement = () => new Element(); document.createDocumentFragment = () => new Element(true);
  const context = vm.createContext({ document, window: { addEventListener() {}, LightweightCharts: {} },
    localStorage: { getItem() { return null; }, setItem() {} }, setTimeout() { return 1; }, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {}, requestAnimationFrame() {}, AbortController, URLSearchParams, performance,
    structuredClone, console, Element, fetch: async () => { throw new Error('Unexpected network call'); } });
  const app = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8');
  const chart = fs.readFileSync(path.join(__dirname, '../public/chart.js'), 'utf8');
  vm.runInContext(app.slice(0, app.lastIndexOf('\nbind();')), context);
  vm.runInContext(chart.slice(0, chart.lastIndexOf('\nif (typeof LC')), context);
  return { context, run: code => vm.runInContext(code, context) };
}
const sample = `$('#zero-mode').value='table'; $('#f-side').value='all';
const sample={symbol:'TESTUSDT',level:'15m',dir:'long',near:.1,hold:5,dif:1,dea:.5,firstNearAt:50,price:10,changePct:-1,quoteVolume:1000,at:100,seeded:true};
let captured=[]; const original=makeMonitorRow; makeMonitorRow=p=>{const r=original(p);captured.push(r);return r};
ZERO={items:[sample],levels:['15m'],t:100};renderZero();`;

test('stable row updates price, proximity and DIF without rebuilding', () => {
  const { run } = setup(); run(sample);
  run('Object.assign(sample,{price:20,near:.15,dif:2});renderZero()');
  assert.equal(run('captured.length'), 1);
  assert.equal(run('captured[0].refs.price.textContent'), '20.0000');
  assert.equal(run('captured[0].refs.near.textContent'), '15.0%');
  assert.equal(run('captured[0].refs.dif.textContent'), '2.000');
});
test('quick filters affect table and are sent to chart queries', () => {
  const { run } = setup(); run(sample);
  run("activeChips.add('up');renderZero()");
  assert.equal(run('DISPLAY_ORDER.length'), 0);
  assert.ok(run("zeroQuery().includes('onlyUp=1')"));
  run("activeChips.clear();activeChips.add('seed');sample.seeded=false;renderZero()");
  assert.equal(run('DISPLAY_ORDER.length'), 0);
  run("activeChips.clear();activeChips.add('conf');sample.confirmed=false;renderZero()");
  assert.equal(run('DISPLAY_ORDER.length'), 0);
});
test('descending duration and structure sorting match the arrow', () => {
  const { run } = setup();run(sample);
  for (const key of ['hold', 'dif', 'dea']) {
    run(`ZERO.items=[{...sample,symbol:'LOW',hold:3,dif:1,dea:.5},{...sample,symbol:'HIGH',hold:9,dif:3,dea:2}];sortKey='${key}';sortDir=-1;renderZero()`);
    assert.equal(run('DISPLAY_ORDER[0]'), 'HIGH');
  }
});
test('pair duplicates cannot trap next-symbol navigation', () => {
  const { run } = setup();
  run("SNAP={symbols:['AAA','BBB']};DISPLAY_ORDER=['AAA','AAA','BBB'];chartSymbol='AAA';selectChartSymbol=s=>chartSymbol=s;stepChart(1)");
  assert.equal(run('chartSymbol'), 'BBB');
});
test('zero request errors remain visible and duplicate polling is avoided', async () => {
  const { run, context } = setup();run(sample);
  context.fetch = async () => ({ ok: false, status: 503 });
  await run('loadZero()');
  assert.match(run("$('#zero-live').textContent"), /HTTP 503/);
  let finish, count = 0;
  context.fetch = () => { count++;return new Promise(r=>finish=r); };
  const first=run('loadZero()');await run('loadZero()');assert.equal(count,1);
  finish({ok:true,json:async()=>({items:[],symbols:[],levels:[],t:200})});await first;
});
test('zero chart errors use the zero view status element', async () => {
  const { run, context } = setup();context.fetch=async()=>({ok:false,status:503});run("activeView='zero'");
  await run("fetchChart({kind:'zero'},'/fake')");
  assert.match(run("$('#zero-live').textContent"), /503/);
  assert.equal(run("$('#alert-live').textContent"), '');
});
test('zero pair signals keep confirmation, pair and unscored status', () => {
  const {run}=setup();
  assert.equal(run("signalConfirmed({kind:'zeropair',confirmed:true,mode:'zeropair'})"),true);
  assert.equal(run("signalChain({kind:'zeropair',pair:'15m-2h'})"),'15m-2h');
  assert.equal(run("signalHasScore({kind:'zeropair',score:0})"),false);
  assert.ok(!run('signalChain({})').includes('undefined'));
});
test('reused chart switches its timeframe formatter', () => {
  const {run}=setup();run(`let calls=[];buildCard=()=>new Element();initChart=(card,minutes)=>({card,minutes,chart:{remove(){},applyOptions(o){calls.push(o)}}});const view={grid:new Element(),entries:[]};ensureCards(view,[{minutes:10}]);ensureCards(view,[{minutes:60}])`);
  assert.equal(run('view.entries[0].minutes'),60);
  assert.equal(run('calls.length'),1);
});
test('late detail responses cannot replace the last requested symbol', async () => {
  const {run,context}=setup();const pending={};context.fetch=url=>new Promise(resolve=>pending[url.split('=')[1]]=resolve);
  const old=run("openDetail('OLD')"),current=run("openDetail('NEW')");
  const response=()=>({ok:true,json:async()=>({price:1,changePct:0,quoteVolume:1,levels:{}})});
  pending.NEW(response());await current;pending.OLD(response());await old;
  assert.match(run("$('#d-title').innerHTML"),/^NEW /);
});
test('slash in an editable field does not trigger global search', () => {
  const {run}=setup();run("bind();document.activeElement={tagName:'INPUT'};let blocked=false;for(const cb of document.listeners.keydown)cb({key:'/',target:document.activeElement,preventDefault(){blocked=true}})");
  assert.equal(run('blocked'),false);
});

test('table header clicks keep the chosen sort instead of resetting it', () => {
  const {run}=setup();run(sample);
  run(`const header=new Element();header.dataset={sort:'hold'};document.querySelectorAll=s=>s==='th.sortable'?[header]:[];bind();header.listeners.click[0]()`);
  assert.equal(run('sortKey'),'hold');
  assert.equal(run('sortDir'),-1);
});

test('zero alert status is visible even when the other strategies are disabled', async () => {
  const {run}=setup();
  run(`requestJSON=async()=>({market:{feedMode:'tick-rest',tick:{state:'open',lastPriceAt:Date.now()},rest:{},seeding:{}},engine:{cfg:{zeroAlertEnabled:true,signalEnabled:false,watchEnabled:false,dualEnabled:false}}})`);
  await run('pollStats()');
  assert.equal(run("$('#pill-strategy').textContent"),'策略：零轴配对');
});

test('zero charts obey the MACD switch and confirmed pair badges', () => {
  const {run}=setup();
  run(`let counts={};const series=name=>({setData(points){counts[name]=points.length},update(){},setMarkers(){}});
    const card=new Element();const e={card,chart:{applyOptions(){},priceScale(){return{applyOptions(){}}},timeScale(){return{fitContent(){}}}},candle:series('candle'),ma7:series('ma7'),ema7:series('ema7'),ma25:series('ma25'),pen:series('pen'),macdHist:series('macdHist'),macdDif:series('macdDif'),macdDea:series('macdDea'),vol:series('vol')};
    $('#chart-macd').checked=false;
    const it={symbol:'TEST',key:'15m',label:'15分',kind:'zero',side:'long',price:1,pair:{label:'15m-2h',sub:'15m',main:'2h'},zero:{side:1,near:.1,hold:3,dif:1,dea:0,firstNearAt:1000},candles:[[1000,1,2,.5,1.5,10]],ma7:[1],ema7:[1],ma25:[1],macd:{hist:[1],dif:[1],dea:[0]}};
    paintCard({kind:'zero',entries:[e]},0,it);`);
  assert.equal(run('counts.macdHist'),0);
  run(`paintCard({kind:'alert',entries:[e]},0,{...it,kind:'zeropair',confirmed:true,mode:'zeropair',pair:'15m-2h',candles:[]})`);
  assert.equal(run("card.querySelector('.cchead').querySelector('.st').textContent"),'已确认');
  assert.match(run("card.querySelector('.cchead').querySelector('.sp').innerHTML"),/15m-2h/);
  assert.ok(!run("card.querySelector('.cchead').querySelector('.sp').innerHTML").includes('0分'));
});
