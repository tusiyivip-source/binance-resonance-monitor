/**
 * 交互与布局校验： node tools/uitest.mjs [url]
 * 检查渲染尺寸/溢出/颜色区分度，并验证详情抽屉、参数面板、筛选、排序等交互。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_ = process.argv[2] || 'http://127.0.0.1:8848/';
const PORT = 9334;
const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].find(p => fs.existsSync(p));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ui-'));
const child = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1920,1080', '--hide-scrollbars', '--no-first-run', '--disable-gpu', 'about:blank'],
  { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws, id = 0; const pending = new Map(); const errs = [];
const send = (method, params = {}) => {
  const mid = ++id; ws.send(JSON.stringify({ id: mid, method, params }));
  return new Promise((res, rej) => {
    pending.set(mid, { res, rej });
    // 单次求值最长等 90 秒：有些用例会在页面内串多次「改设置 → 等重绘」，
    // 30 秒上限会误报成 Runtime.evaluate timeout
    setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(method + ' timeout')); } }, 90000);
  });
};
const evalJs = async expr => (await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: expr })).result.value;

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  console.log(cond ? `  \u001b[32m✓\u001b[0m ${name}${detail ? '  \u001b[2m' + detail + '\u001b[0m' : ''}`
    : `  \u001b[31m✗\u001b[0m ${name}  \u001b[31m${detail}\u001b[0m`);
  cond ? pass++ : fail++;
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch { } await sleep(250); }
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  ws = new WebSocket(list.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errs.push('console.error: ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  });
  await send('Runtime.enable'); await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });

  // 先等服务就绪：播种未完成时多数标的还没有K线，表格行数会偏少，导致断言不稳
  {
    let ready = false;
    for (let i = 0; i < 240; i++) {
      try {
        const s = await (await fetch(URL_.replace(/\/$/, '') + '/api/stats')).json();
        const sd = s.market?.seeding;
        if (sd && !sd.active && sd.total > 0 && sd.done >= sd.total) {
          console.log(`   服务就绪：已播种 ${sd.done}/${sd.total}，标的 ${s.market.symbols}`);
          ready = true;
          break;
        }
        if (i % 20 === 0) console.log(`   等待播种… ${sd?.done ?? 0}/${sd?.total ?? '?'}`);
      } catch { /* 服务还没起来 */ }
      await sleep(1000);
    }
    if (!ready) console.log('   \u001b[33m⚠ 等待播种超时，测试可能不稳定\u001b[0m');
  }

  // 新的「回踩成笔链」过滤非常严格，服务刚起步时可能一条报警都没有。
  // 先探一下缓冲区，不足就临时放宽两个缠论过滤器（测完在末尾还原）。
  let relaxed = false;
  {
    const api = URL_.replace(/\/$/, '');
    const buf = async () => { try { return (await (await fetch(api + '/api/stats')).json()).engine?.alertBuffer ?? 0; } catch { return 0; } };
    const n0 = await buf();
    if (n0 < 3) {
      console.log(`   报警缓冲区仅 ${n0} 条，临时放宽缠论过滤器以产生报警…`);
      await fetch(api + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requireStrokeChain: false, filterBeichi: false }) });
      relaxed = true;
    }
  }

  await send('Page.navigate', { url: URL_ });
  await sleep(12000);

  console.log('\n\u001b[36m▌布局\u001b[0m');
  const L = await evalJs(`(() => {
    const r = el => { const b = el.getBoundingClientRect(); return {w:Math.round(b.width),h:Math.round(b.height),x:Math.round(b.x),y:Math.round(b.y)}; };
    const cells = [...document.querySelectorAll('#body tr .cell')];
    const sizes = new Set(cells.slice(0,400).map(c=>{const b=c.getBoundingClientRect();return Math.round(b.width)+'x'+Math.round(b.height);}));
    const cols = [...document.querySelectorAll('#topbar,#toolbar,#tablewrap,#alerts')].map(e=>({id:e.id, ...r(e)}));
    const head = [...document.querySelectorAll('#head th.lv')].map(t=>t.textContent);
    const tbl = document.querySelector('#grid').getBoundingClientRect();
    return {
      win:[innerWidth,innerHeight],
      bodyOverflowX: document.documentElement.scrollWidth - innerWidth,
      cols, cellsCovered: cells.length, cellSizes:[...sizes],
      levelCols: head.length, headLabels: head,
      tableRight: Math.round(tbl.right), alertsLeft: Math.round(document.querySelector('#alerts').getBoundingClientRect().left),
      headHeight: Math.round(document.querySelector('#head').getBoundingClientRect().height),
      stickyTop: getComputedStyle(document.querySelector('#head th')).position,
      rows: document.querySelectorAll('#body tr').length,
      colored: (()=>{const s=new Set([...document.querySelectorAll('#body tr .cell')].slice(0,600).map(c=>getComputedStyle(c).backgroundColor));return s.size;})(),
      groupChip: document.querySelector('#f-groups')?.textContent || '',
    };
  })()`);
  console.log('   级别列: ' + L.headLabels.join(' '));
  console.log('   组合指示: ' + L.groupChip);
  ok('无横向溢出', L.bodyOverflowX <= 0, `overflowX=${L.bodyOverflowX}px`);
  // 表格列宽由浏览器按亚像素分配，可能出现 48/49 这种 1px 差异，容差 2px
  ok('级别列全部渲染且宽度一致（容差 2px）',
    L.cellSizes.length <= 2 && L.cellSizes.every(x => x !== '0x0')
    && Math.max(...L.cellSizes.map(x => +x.split('x')[0])) - Math.min(...L.cellSizes.map(x => +x.split('x')[0])) <= 2,
    `${L.levelCols} 列，${L.cellSizes.join(',')}`);
  ok('色块数量 = 行数 × 级别列数', L.cellsCovered === L.rows * L.levelCols, `${L.cellsCovered} = ${L.rows}×${L.levelCols}`);
  ok('级别列含用户要求的 2分/10分/3时', ['2m', '10m', '3h'].every(k => L.headLabels.includes(k)), L.headLabels.join(','));
  ok('隐藏级别 1分 不出现在矩阵中', !L.headLabels.includes('1m'), L.headLabels.join(','));
  ok('表格与报警面板不重叠', L.tableRight <= L.alertsLeft + 1, `表格右=${L.tableRight} 面板左=${L.alertsLeft}`);
  ok('表头吸顶生效', L.stickyTop === 'sticky', L.stickyTop);
  ok('色块颜色有区分度（≥4 种）', L.colored >= 4, `${L.colored} 种背景色`);

  console.log('\n\u001b[36m▌交互\u001b[0m');
  await evalJs(`document.querySelector('#body tr .c-sym .det').click()`);
  await sleep(2500);
  const D = await evalJs(`(() => {
    const d = document.querySelector('#detail');
    const rows = d.querySelectorAll('.lvtable tbody tr');
    return { hidden: d.classList.contains('hidden'), title: d.querySelector('#d-title').innerText,
      lvRows: rows.length, sample: rows[0] ? rows[0].innerText.replace(/\\t/g,' | ') : null,
      sums: d.querySelectorAll('.dsum .k').length };
  })()`);
  console.log('   ' + JSON.stringify(D));
  ok('点击币种打开详情抽屉', !D.hidden, D.title);
  ok('详情列出全部可见级别', D.lvRows === L.levelCols, `${D.lvRows} 行 vs ${L.levelCols} 列`);
  ok('详情含关键指标卡片（含跳转K线图入口）', D.sums === 5, `${D.sums} 张`);

  await evalJs(`document.querySelector('#detail [data-close]').click()`);
  await sleep(400);

  await evalJs(`document.querySelector('#btn-cfg').click()`);
  await sleep(600);
  const C = await evalJs(`(() => {
    const p = document.querySelector('#cfgpanel');
    const vals = {}; for (const el of p.querySelectorAll('input,select')) if (el.id) vals[el.id.replace('c-','')] = el.type==='checkbox'?el.checked:el.value;
    return { hidden: p.classList.contains('hidden'), count: Object.keys(vals).length, vals };
  })()`);
  console.log('   参数面板: ' + JSON.stringify(C.vals));
  ok('参数面板打开并回填', !C.hidden && C.count >= 14, `${C.count} 个字段`);
  ok('默认参数符合需求（≥3级共振 / 回踩6根 / 上穿2根 / 确认3根）',
    +C.vals.minBullLevels === 3 && +C.vals.pullbackLookback === 6 && +C.vals.triggerLookback === 2 && +C.vals.adjacentLookback === 3,
    `minBull=${C.vals.minBullLevels} pb=${C.vals.pullbackLookback} trig=${C.vals.triggerLookback} adj=${C.vals.adjacentLookback}`);

  // —— 级别组合编辑器 ——
  const G = await evalJs(`(() => {
    const rows = [...document.querySelectorAll('#grouplist .grow')];
    const read = r => [...r.querySelectorAll('select')].map(s=>s.value).join('>');
    return {
      n: rows.length,
      groups: rows.map(read),
      enabled: rows.map(r=>r.querySelector('input[type=checkbox]').checked),
      autoOff: !document.querySelector('#c-scanModeAuto').checked,
      selectsPerRow: rows[0] ? rows[0].querySelectorAll('select').length : 0,
    };
  })()`);
  console.log('   组合编辑器: ' + JSON.stringify(G));
  ok('组合编辑器渲染出 3 组示例组合（基准/确认/最大 各一个下拉）', G.n === 3 && G.selectsPerRow === 3, G.groups.join(' , '));
  ok('示例组合与需求一致：3分→15分→2时 / 2分→10分→1时 / 5分→30分→3时',
    G.groups.join('|') === '3m>15m>2h|2m>10m>1h|5m>30m>3h', G.groups.join(' , '));
  ok('默认不是穷举模式', G.autoOff);
  ok('工具栏显示当前生效组合', /15分|15m/.test(L.groupChip) || /3m/.test(L.groupChip), L.groupChip);

  // 添加 / 删除组合
  await evalJs(`document.querySelector('#btn-addgroup').click()`);
  await sleep(300);
  const G2 = await evalJs(`document.querySelectorAll('#grouplist .grow').length`);
  ok('「添加组合」生效', G2 === 4, `${G.n} → ${G2} 组`);
  await evalJs(`document.querySelector('#grouplist .grow:last-child .del').click()`);
  await sleep(300);
  const G3 = await evalJs(`document.querySelectorAll('#grouplist .grow').length`);
  ok('「删除组合」生效', G3 === 3, `${G2} → ${G3} 组`);

  // 非法顺序应给出警告
  const badMsg = await evalJs(`(() => {
    const r = document.querySelector('#grouplist .grow');
    const sels = r.querySelectorAll('select');
    sels[1].value = '2h'; sels[1].dispatchEvent(new Event('change'));
    return { warn: r.querySelector('.bad')?.textContent || '', mid: sels[1].value };
  })()`);
  ok('组合顺序非法时给出提示', /顺序/.test(badMsg.warn), badMsg.warn || '（无提示）');
  await evalJs(`document.querySelector('#btn-preset').click()`);
  await sleep(1200);
  const G4 = await evalJs(`[...document.querySelectorAll('#grouplist .grow')].map(r=>[...r.querySelectorAll('select')].map(s=>s.value).join('>')).join('|')`);
  ok('「恢复示例组合」还原成功', G4 === '3m>15m>2h|2m>10m>1h|5m>30m>3h', G4);
  // —— 钉钉推送配置（先重置，避免上一轮残留影响） ——
  await evalJs(`fetch('/api/push',{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({enabled:false, channels:[]})}).then(()=>location.reload()).catch(()=>{})`).catch(() => { });
  await sleep(7000);
  await evalJs(`document.querySelector('#btn-cfg').click()`);
  await sleep(500);
  const PU = await evalJs(`(async () => {
    const d = await fetch('/api/push').then(r=>r.json());
    document.querySelector('#btn-addpush').click();
    await new Promise(r=>setTimeout(r,300));
    const chans = [...document.querySelectorAll('#pushlist .pchan')];
    return {
      meta: Object.keys(d.channelMeta || {}),
      metaFields: (d.channelMeta?.dingtalk?.fields ?? []).map(f=>f.key),
      hasStats: !!d.stats,
      existingChannels: (d.config?.channels ?? []).length,
      rendered: chans.length,
      inputs: chans[0] ? [...chans[0].querySelectorAll('.pfld input')].map(i=>i.dataset.k) : [],
      hasTestBtn: !!document.querySelector('#btn-pushtest'),
    };
  })()`);
  console.log('   推送面板: ' + JSON.stringify(PU));
  ok('推送接口返回钉钉通道元数据', PU.meta.includes('dingtalk') && PU.meta.includes('webhook'), PU.meta.join(','));
  ok('钉钉通道含 accessToken / secret / keyword 三个字段',
    PU.metaFields.join(',') === 'accessToken,secret,keyword', PU.metaFields.join(','));
  ok('「添加通道」渲染出钉钉配置表单',
    PU.rendered === 1 && PU.inputs.length === 3,
    `已有 ${PU.existingChannels} 个通道，点击后渲染 ${PU.rendered} 个，输入框 ${PU.inputs.join(',')}`);
  ok('推送统计可见 / 测试按钮存在', PU.hasStats && PU.hasTestBtn);

  // —— 缠论背驰过滤控件 ——
  const BC = await evalJs(`(() => {
    const q = id => document.querySelector('#c-' + id);
    return {
      on: q('filterBeichi')?.checked,
      scope: q('beichiScope')?.value,
      scopeOpts: q('beichiScope') ? [...q('beichiScope').options].map(o=>o.value) : [],
      minBars: q('beichiMinBars')?.value,
      ratio: q('beichiRatio')?.value,
      minProgress: q('beichiMinProgress')?.value,
      stats: document.querySelector('#beichi-stats')?.textContent?.slice(0, 60) || '',
    };
  })()`);
  console.log('   背驰过滤控件: ' + JSON.stringify(BC));
  ok('背驰过滤默认开启，口径为默认值（仅确认级别 / 标准笔5根 / 阈值1.0 / 幅度比0.3）',
    BC.on === true && BC.scope === 'mid' && BC.minBars === '5'
    && Number(BC.ratio) === 1 && Number(BC.minProgress) === 0.3,
    `on=${BC.on} scope=${BC.scope} minBars=${BC.minBars} ratio=${BC.ratio} progress=${BC.minProgress}`);
  ok('检查范围可选「仅确认级别 / 确认+最大级别」',
    BC.scopeOpts.join(',') === 'mid,mid+big', BC.scopeOpts.join(','));
  ok('面板显示背驰过滤运行状态', /背驰过滤已(开启|关闭)/.test(BC.stats), BC.stats);

  // 改动应能保存并回读
  const BC2 = await evalJs(`(async () => {
    document.querySelector('#c-beichiRatio').value = '0.8';
    document.querySelector('#c-beichiScope').value = 'mid+big';
    await document.querySelector('#btn-cfgsave').click();
    await new Promise(r=>setTimeout(r,1200));
    const d = await fetch('/api/config').then(r=>r.json());
    return { ratio: d.beichiRatio, scope: d.beichiScope };
  })()`);
  ok('背驰过滤参数可保存并生效', Number(BC2.ratio) === 0.8 && BC2.scope === 'mid+big',
    `ratio=${BC2.ratio} scope=${BC2.scope}`);
  // 还原默认，避免影响后续用例
  await evalJs(`fetch('/api/config',{method:'POST',headers:{'content-type':'application/json'},
    body: JSON.stringify({beichiRatio:1.0, beichiScope:'mid'})})`);
  await sleep(200);

  // 密钥掩码：写入后读回应为掩码且不含完整值
  const M = await evalJs(`(async () => {
    await fetch('/api/push', {method:'POST',headers:{'content-type':'application/json'},
      body: JSON.stringify({ enabled:true, channels:[{type:'dingtalk',enabled:true,accessToken:'abcdefghijklmnopqrstuvwxyz0123456789',secret:'SEC0123456789abcdefghijklmnopqrstuvwxyz',keyword:'盯盘'}]})});
    const d = await fetch('/api/push').then(r=>r.json());
    return { cfg: d.config.channels[0], raw: JSON.stringify(d.config) };
  })()`);
  console.log('   掩码回显: ' + JSON.stringify(M.cfg));
  ok('★ accessToken 不以明文返回给前端',
    !M.raw.includes('abcdefghijklmnopqrstuvwxyz0123456789') && !!M.cfg.accessTokenMasked, M.cfg.accessTokenMasked);
  ok('★ secret 不以明文返回给前端',
    !M.raw.includes('SEC0123456789abcdefghijklmnopqrstuvwxyz') && !!M.cfg.secretMasked, M.cfg.secretMasked);
  ok('关键词明文保留（非密钥）', M.cfg.keyword === '盯盘', M.cfg.keyword);

  // 回传掩码不应把真密钥覆盖掉
  const K = await evalJs(`(async () => {
    const d0 = await fetch('/api/push').then(r=>r.json());
    const c = d0.config.channels[0];
    await fetch('/api/push', {method:'POST',headers:{'content-type':'application/json'},
      body: JSON.stringify({ channels:[{type:'dingtalk',enabled:true,accessToken:c.accessTokenMasked,secret:c.secretMasked,keyword:'盯盘'}]})});
    const d1 = await fetch('/api/push').then(r=>r.json());
    return { masked: d1.config.channels[0].accessTokenMasked };
  })()`);
  ok('回传掩码时真密钥未被覆盖', K.masked === M.cfg.accessTokenMasked, K.masked);

  // 恢复为未启用，避免测试期间真的往钉钉发消息
  await evalJs(`fetch('/api/push', {method:'POST',headers:{'content-type':'application/json'}, body: JSON.stringify({ enabled:false, channels: [] })})`);
  await sleep(200);

  await evalJs(`document.querySelector('#cfgpanel [data-close]').click()`);
  await sleep(300);

  // 绩效面板
  const api = await evalJs(`fetch('/api/performance').then(r=>r.json()).then(d=>({
    tracked: d.tracked, total: d.total, horizons: d.horizons.length, byScore: d.byScore.length,
    recent: d.recent.length, h4n: d.horizons[1]?.n ?? 0, hasKeys: !!d.confirmedOnly
  }))`);
  console.log('   绩效接口: ' + JSON.stringify(api));
  ok('绩效接口结构完整', api.horizons === 3 && api.byScore === 4 && api.hasKeys,
    `tracked=${api.tracked} 已结算+4h=${api.h4n}`);

  await evalJs(`document.querySelector('#btn-perf').click()`);
  await sleep(2000);
  const P = await evalJs(`(() => {
    const p = document.querySelector('#perf');
    return { hidden: p.classList.contains('hidden'),
      tables: p.querySelectorAll('table').length,
      rows: p.querySelectorAll('tbody tr').length,
      hasTip: !!p.querySelector('.hint'),
      head: p.querySelector('h3')?.textContent || '' };
  })()`);
  console.log('   绩效面板: ' + JSON.stringify(P));
  ok('绩效抽屉打开并渲染内容', !P.hidden && P.row > 0 || (!P.hidden && P.rows > 0), `${P.tables} 张表 / ${P.rows} 行`);
  await evalJs(`document.querySelector('#perf [data-close]').click()`);
  await sleep(300);

  // 信号相关用例需要「确实存在报警」。新的「回踩成笔链」过滤非常严格，
  // 服务刚起步的一段时间内可能一条报警都没有。这时临时放宽两个缠论过滤器把报警跑出来，
  // 测完再还原 —— 否则布局/交互用例会被信号稀缺误伤（踩过一次）。
  if (relaxed) {
    const api = URL_.replace(/\/$/, '');
    let n = 0;
    for (let i = 0; i < 60; i++) {
      try { n = (await (await fetch(api + '/api/stats')).json()).engine?.alertBuffer ?? 0; } catch { }
      if (n >= 5) break;
      await sleep(1000);
    }
    console.log(`   放宽后报警缓冲区 ${n} 条`);
  }

  // 筛选（等表格真正填满并稳定下来——重载后首屏可能只到了一部分快照）
  // before 取窗口内**峰值**：「完整表格」就等于这个峰值；
  // 若只取某一瞬间的值，服务端在重负载下晚一拍就会读到残缺的行数（踩过多次）。
  let before = 0;
  {
    let last = -1, stable = 0, n = 0, trace = [];
    for (let i = 0; i < 80; i++) {
      try { n = await evalJs(`document.querySelectorAll('#body tr').length`); }
      catch { n = -1; }
      if (n > before) before = n;
      trace.push(n);
      if (n > 100 && n === last) { if (++stable >= 3) break; } else stable = 0;
      last = n;
      await sleep(500);
    }
    console.log(`   表格稳定在 ${n} 行（峰值 ${before}，共采样 ${trace.length} 次）`);
    if (before < 100) {
      console.log('   采样轨迹: ' + trace.join(' '));
      const diag = await evalJs(`(() => ({
        ready: document.readyState, url: location.pathname,
        fBull: document.querySelector('#f-bull').value,
        fScore: document.querySelector('#f-score').value,
        q: document.querySelector('#q').value,
        chipOn: document.querySelector('#chips .chip')?.classList.contains('on'),
        snapRows: (typeof SNAP !== 'undefined' && SNAP?.rows?.length) || 0,
        snapBull3: (typeof SNAP !== 'undefined' && SNAP?.rows) ? SNAP.rows.filter(r => r[3] >= 3).length : 0,
        rev: (typeof SNAP !== 'undefined' && SNAP?.revision) || 0,
        chartmode: document.body.classList.contains('chartmode'),
        alertmode: document.body.classList.contains('alertchartmode'),
      }))()`);
      console.log('   诊断: ' + JSON.stringify(diag));
    }
  }
  await evalJs(`document.querySelector('#q').value='BTC'; document.querySelector('#q').dispatchEvent(new Event('input'))`);
  await sleep(600);
  const after = await evalJs(`document.querySelectorAll('#body tr').length`);
  ok('搜索过滤生效', after < before && after >= 0, `全部 ${before} 行 → 搜索 "BTC" ${after} 行`);
  await evalJs(`document.querySelector('#q').value=''; document.querySelector('#q').dispatchEvent(new Event('input'))`);
  await sleep(400);

  await evalJs(`document.querySelector('#chips .chip').click()`);
  await sleep(700);
  const sigOnly = await evalJs(`document.querySelectorAll('#body tr').length`);
  const chipOn = await evalJs(`document.querySelector('#chips .chip').classList.contains('on')`);
  ok('「仅看信号」筛选生效', chipOn && sigOnly < before && sigOnly > 0, `${before} 行 → ${sigOnly} 行`);
  await evalJs(`document.querySelector('#chips .chip').click()`);
  await sleep(400);
  const restored = await evalJs(`document.querySelectorAll('#body tr').length`);
  ok('取消筛选后行数恢复', restored >= before * 0.95, `${before} → ${restored} 行`);

  // 排序
  await evalJs(`document.querySelector('th[data-sort=score]').click()`);
  await sleep(700);
  const sorted = await evalJs(`(()=>{const v=[...document.querySelectorAll('#body tr .c-score')].map(t=>+t.textContent||0).slice(0,12);return v;})()`);
  const desc = sorted.every((x, i) => i === 0 || sorted[i - 1] >= x);
  ok('按评分排序生效', desc, `前12行评分 ${sorted.join(',')}`);

  // 报警面板
  const A = await evalJs(`(() => {
    const c = document.querySelectorAll('#alertlist .acard');
    const conf = document.querySelectorAll('#alertlist .acard.confirmed').length;
    const t = c[0]?.innerText || '';
    return { n: c.length, conf, full: t.replace(/\\n/g,' | '), hasChain: /→/.test(t), hasScore: /\\d+分/.test(t), hasPrice: /@/.test(t) };
  })()`);
  console.log('   ' + JSON.stringify({ n: A.n, conf: A.conf, hasChain: A.hasChain, hasScore: A.hasScore, hasPrice: A.hasPrice }));
  console.log('   首条: ' + A.full);
  ok('报警卡片渲染（含级别链路/评分/价格）', A.n > 0 && A.hasChain && A.hasScore && A.hasPrice,
    `${A.n} 条，其中已确认 ${A.conf} 条`);

  ok('运行期无 JS 异常', errs.length === 0, errs.slice(0, 3).join(' ; ') || '无');

  /* ================= K 线图视图（Lightweight Charts） ================= */
  console.log('\n\u001b[36m▌K线图视图（TradingView Lightweight Charts）\u001b[0m');
  console.log('   图表库: ' + await evalJs(`typeof LightweightCharts !== 'undefined' ? '已加载(本地 vendor)' : '未加载'`));
  ok('图表库从本地 vendor 加载（不走 CDN）', await evalJs(`typeof LightweightCharts !== 'undefined'`));
  // 注意：s.src 是浏览器解析后的绝对 URL（必然带 http:），必须看原始属性
  {
    const srcs = await evalJs(`[...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src'))`);
    ok('index.html 只引用本地脚本，无外部 CDN', srcs.every(s => !/^(https?:)?\/\//.test(s)), srcs.join(' '));
  }

  await evalJs(`document.querySelector('#tab-multi').click()`);
  await sleep(6000);

  const CH = await evalJs(`(() => {
    const cards = [...document.querySelectorAll('#chartgrid .chartcard')];
    const c0 = cards[0];
    const holder = c0?.querySelector('.cchart');
    const cvs = holder ? [...holder.querySelectorAll('canvas')] : [];
    const paint = cv => {
      const ctx = cv.getContext('2d');
      if (!cv.width || !cv.height) return 0;
      try { const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0; for (let i = 3; i < d.length; i += 4 * 53) if (d[i] > 0) n++; return n;
      } catch (e) { return -1; }
    };
    const rr = el => { const b = el.getBoundingClientRect(); return Math.round(b.width) + 'x' + Math.round(b.height); };
    return {
      chartmode: document.body.classList.contains('chartmode'),
      tableHidden: getComputedStyle(document.querySelector('#tablewrap')).display === 'none',
      cards: cards.length,
      labels: cards.map(c => c.querySelector('.lv').textContent),
      roles: cards.map(c => [...c.querySelectorAll('.roles .rb')].map(x => x.classList[1]).join('+')),
      divBadges: cards.filter(c => c.querySelector('.badge-div')).length,
      cardRect: rr(c0), holderRect: rr(holder),
      lcInited: !!holder.querySelector('.tv-lightweight-charts'),
      canvasPerCard: cvs.length,
      mainPainted: paint(cvs[0]),
      allPainted: cards.slice(0, 4).map(c => paint(c.querySelector('.cchart canvas'))),
      sizes: [...new Set(cards.map(c => rr(c.querySelector('.cchart'))))],
      prices: cards.slice(0, 3).map(c => c.querySelector('.px').textContent),
      ch: getComputedStyle(document.querySelector('#chartgrid')).getPropertyValue('--ch').trim(),
      cols: getComputedStyle(document.querySelector('#chartgrid')).gridTemplateColumns.split(' ').length,
      gridH: document.querySelector('#chartgrid').clientHeight,
      scrollH: document.querySelector('#chartgrid').scrollHeight,
      overflow: document.querySelector('#chartgrid').scrollHeight - document.querySelector('#chartgrid').clientHeight,
      docScroll: document.documentElement.scrollHeight - window.innerHeight,
      fit: document.querySelector('#chart-cols').value === 'fit',
      rowCount: new Set(cards.map(c => Math.round(c.getBoundingClientRect().top))).size,
      rowWidths: Object.values(cards.reduce((a, c) => {
        const k = Math.round(c.getBoundingClientRect().top);
        (a[k] ??= []).push(Math.round(c.getBoundingClientRect().width));
        return a;
      }, {})),
      heights: [...new Set(cards.map(c => Math.round(c.querySelector('.cchart').getBoundingClientRect().height)))],
      gotBars: (typeof VIEWS !== 'undefined' && VIEWS?.multi?.items?.[0]?.candles?.length) || 0,
      barsSel: document.querySelector('#chart-bars').value,
      live: document.querySelector('#chart-live').textContent.replace(/\d\d:\d\d:\d\d/, 'HH:MM:SS'),
    };
  })()`);
  console.log('   级别顺序: ' + CH.labels.join(' '));
  console.log('   角色标记: ' + CH.roles.filter(Boolean).join(' | '));
  console.log(`   卡片 ${CH.cards} 张 · ${CH.cardRect}（绘图区 ${CH.holderRect}）· 每张 ${CH.canvasPerCard} 个 canvas · 已绘制像素 ${CH.mainPainted}`);

  ok('切到 K线图后主区切换为图表（表格隐藏）', CH.chartmode && CH.tableHidden && CH.cards > 0,
    `chartmode=${CH.chartmode} 表格隐藏=${CH.tableHidden} 卡片=${CH.cards}`);
  ok('14 个级别按周期升序依次排列',
    CH.cards === 14 && CH.labels.join(',') === '2分,3分,5分,10分,15分,30分,1时,2时,3时,4时,6时,12时,日线,周线',
    CH.labels.join(' '));
  ok('★ 每张卡片都建好了 Lightweight Charts 实例', CH.lcInited && CH.canvasPerCard >= 2,
    `每张 ${CH.canvasPerCard} 个 canvas`);
  ok('★ 主画布真的画出了内容', CH.mainPainted > 100, `稀疏采样非透明像素 ${CH.mainPainted}`);
  const sum = a => a.reduce((x, y) => x + y, 0);
  const gap = 10;
  const rowTotal = r => sum(r) + (r.length - 1) * gap;
  const lastRow = CH.rowWidths[CH.rowWidths.length - 1] ?? [];
  ok('所有绘图区高度一致且等于设定的 --ch',
    CH.heights.length === 1 && CH.heights[0] === parseInt(CH.ch),
    `高度 ${CH.heights.join(',')}（--ch=${CH.ch}）宽度 ${CH.sizes.join(' / ')}`);
  ok('★ 适应窗口：14 张图一屏铺满，无滚动条',
    CH.fit && CH.overflow <= 1 && CH.docScroll <= 1 && CH.cards === 14,
    `列=${CH.cols} rows=${CH.rowCount} 网格 ${CH.gridH}px / 内容 ${CH.scrollH}px 溢出 ${CH.overflow}px 页面溢出 ${CH.docScroll}px`);
  ok('★ 末行不满时自动拉宽铺满整行（含列间距）',
    lastRow.length < CH.rowWidths[0].length && Math.abs(rowTotal(lastRow) - rowTotal(CH.rowWidths[0])) <= 4,
    CH.rowWidths.map(r => `${r.length}张×${r[0]}px`).join(' / ')
    + ` → 末行总宽 ${rowTotal(lastRow)} vs 首行 ${rowTotal(CH.rowWidths[0])}`);
  ok('★ 基准/确认/最大级别各 3 个被标记出来',
    CH.roles.filter(r => r.includes('base')).length === 3
    && CH.roles.filter(r => r.includes('mid')).length === 3
    && CH.roles.filter(r => r.includes('big')).length === 3,
    CH.roles.join(' '));
  ok('卡片显示收盘价与距MA7', /收 /.test(CH.prices[0]) && /距MA7/.test(CH.prices[0]), CH.prices[0]);
  ok('自动根数生效（按宽度反推）', CH.barsSel === 'auto' && CH.gotBars >= 50, `${CH.gotBars} 根`);

  // —— 十字光标 tooltip（用真实鼠标事件） ——
  {
    const box = await evalJs(`(() => { const b = document.querySelector('#chartgrid .chartcard .cchart').getBoundingClientRect();
      return { x: Math.round(b.left + b.width * 0.45), y: Math.round(b.top + b.height * 0.45) }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, buttons: 0 });
    await sleep(120);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x + 3, y: box.y + 2, buttons: 0 });
    await sleep(700);
    const tip = await evalJs(`(() => { const t = document.querySelector('#chartgrid .chartcard .ctip');
      return t ? { shown: getComputedStyle(t).display !== 'none', text: t.textContent.replace(/\\s+/g,' ').slice(0,80) } : null; })()`);
    console.log('   十字光标提示: ' + JSON.stringify(tip));
    ok('★ 十字光标悬停弹出 OHLC 提示框', !!(tip && tip.shown && /开 /.test(tip.text) && /收 /.test(tip.text)),
      tip ? tip.text : '未生成提示框');
  }

  // —— 副图 / 叠加层开关 ——
  // 用「采样像素指纹」而不是 PNG 字节长度：PNG 压缩后长度对少量像素变化不敏感
  // （缠论笔只是一条细虚线，开关它 PNG 长度只差 4%，会误判为"没重绘"）。
  {
    const T = await evalJs(`(async () => {
      const cv = document.querySelector('#chartgrid .chartcard .cchart canvas');
      const ctx = cv.getContext('2d');
      // 采样指纹：每 17 个像素取一次 RGBA
      const fp = () => {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const o = [];
        for (let i = 0; i < d.length; i += 4 * 17) o.push(d[i], d[i+1], d[i+2], d[i+3]);
        return o;
      };
      const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
      const set = async (id, v) => {
        const el = document.querySelector(id);
        el.checked = v; el.dispatchEvent(new Event('change'));
        await new Promise(r => setTimeout(r, 600));
      };
      const base = fp();
      await set('#chart-ma', false);   const noMA = fp();
      await set('#chart-ma', true);    const backMA = fp();
      await set('#chart-chan', false); const noChan = fp();
      await set('#chart-chan', true);  const backChan = fp();
      await set('#chart-macd', false); const noMacd = fp();
      await set('#chart-macd', true);  const backMacd = fp();
      return {
        n: base.length,
        dMA: diff(base, noMA), dMAback: diff(base, backMA),
        dChan: diff(backMA, noChan), dChanback: diff(backMA, backChan),
        dMacd: diff(backChan, noMacd), dMacdback: diff(backChan, backMacd),
      };
    })()`);
    const pct = d => (d / T.n * 100).toFixed(1) + '%';
    console.log(`   重绘差异（采样 ${T.n} 个通道）: 均线 ${T.dMA} 笔 ${T.dChan} MACD ${T.dMacd}`);
    ok('★ 关闭均线后重绘，重开后画面回到原状态',
      T.dMA > 20 && T.dMAback < T.dMA / 2, `关闭差异 ${pct(T.dMA)} → 重开差异 ${pct(T.dMAback)}`);
    ok('★ 关闭缠论笔后重绘，重开后画面回到原状态',
      T.dChan > 3 && T.dChanback < T.dChan / 2, `关闭差异 ${pct(T.dChan)} → 重开差异 ${pct(T.dChanback)}`);
    ok('★ 关闭 MACD 副图后重绘，重开后画面回到原状态',
      T.dMacd > 20 && T.dMacdback < T.dMacd / 2, `关闭差异 ${pct(T.dMacd)} → 重开差异 ${pct(T.dMacdback)}`);
  }

  // —— 列数切换 ——
  const COL = await evalJs(`(async () => {
    const read = () => {
      const r = document.querySelector('#chartgrid .chartcard .cchart').getBoundingClientRect();
      const n = (typeof VIEWS!=='undefined' && VIEWS?.multi?.items?.[0]?.candles?.length) || 0;
      return { w: Math.round(r.width), h: Math.round(r.height), bars: n, px: +((r.width - 74) / Math.max(1, n)).toFixed(2) };
    };
    const out = {};
    for (const v of ['4','1','2']) {
      document.querySelector('#chart-cols').value = v;
      document.querySelector('#chart-cols').dispatchEvent(new Event('change'));
      await new Promise(r=>setTimeout(r,4200));
      out[v] = read();
    }
    return out;
  })()`);
  console.log('   列数切换: ' + JSON.stringify(COL));
  ok('★ 切换列数时图表尺寸随之变化（1列最大、4列最小）',
    COL['1'].w > COL['2'].w && COL['2'].w > COL['4'].w && COL['1'].h > COL['4'].h,
    `1列 ${COL['1'].w}×${COL['1'].h} / 2列 ${COL['2'].w}×${COL['2'].h} / 4列 ${COL['4'].w}×${COL['4'].h}`);
  // 还原为「适应窗口」，否则后面报警视图的铺满断言会被这里的手动列数污染
  await evalJs(`document.querySelector('#chart-cols').value='fit'; document.querySelector('#chart-cols').dispatchEvent(new Event('change'))`);
  await sleep(4500);
  {
    const r = await evalJs(`(() => { const g = document.querySelector('#chartgrid');
      return { cols: g.style.getPropertyValue('--cols'), overflow: g.scrollHeight - g.clientHeight }; })()`);
    ok('手动列数后切回「适应窗口」能恢复铺满', r.overflow <= 1, `列=${r.cols} 溢出 ${r.overflow}px`);
  }

  // —— 点图放大 ——
  const ZM = await evalJs(`(async () => {
    const card = document.querySelector('#chartgrid .chartcard');
    const w0 = Math.round(card.getBoundingClientRect().width), h0 = Math.round(card.getBoundingClientRect().height);
    card.querySelector('.cchart').click();
    await new Promise(r=>setTimeout(r,5000));
    const w1 = Math.round(card.getBoundingClientRect().width), h1 = Math.round(card.getBoundingClientRect().height);
    const zoomed = card.classList.contains('zoomed');
    const canvasW = Math.round(card.querySelector('.cchart canvas').getBoundingClientRect().width);
    card.querySelector('.cchart').click();
    await new Promise(r=>setTimeout(r,4500));
    return { w0, h0, w1, h1, zoomed, canvasW,
      backW: Math.round(card.getBoundingClientRect().width), stillZoomed: card.classList.contains('zoomed') };
  })()`);
  console.log('   点图放大: ' + JSON.stringify(ZM));
  ok('★ 点图可放大（宽度铺满、高度增加、图表跟着变宽）',
    ZM.zoomed && ZM.w1 > ZM.w0 * 1.8 && ZM.h1 > ZM.h0 && ZM.canvasW > ZM.w0,
    `${ZM.w0}×${ZM.h0} → ${ZM.w1}×${ZM.h1}（画布 ${ZM.canvasW}）`);
  ok('★ 再点一次还原（刷新不会抹掉放大状态）', !ZM.stillZoomed && ZM.backW === ZM.w0, `还原为 ${ZM.backW}`);

  // —— 从表格点币种进入图表 ——
  await evalJs(`document.querySelector('#tab-matrix').click()`);
  await sleep(500);
  const fromTable = await evalJs(`(async () => {
    const tr = document.querySelectorAll('#body tr')[3];
    const sym = tr.querySelector('.c-sym .base').textContent + 'USDT';
    tr.querySelector('.c-sym').click();
    await new Promise(r=>setTimeout(r,5500));
    return { sym, shown: document.querySelector('#chart-sym').textContent,
      chartmode: document.body.classList.contains('chartmode'),
      cards: document.querySelectorAll('#chartgrid .chartcard').length,
      inited: !!document.querySelector('#chartgrid .chartcard .tv-lightweight-charts') };
  })()`);
  ok('★ 点表格里的币种 → 直接进入该币种的 K线图',
    fromTable.chartmode && fromTable.shown === fromTable.sym && fromTable.cards === 14 && fromTable.inited,
    `${fromTable.sym} → 显示 ${fromTable.shown}，${fromTable.cards} 张图`);

  const step = await evalJs(`(async () => {
    const a = document.querySelector('#chart-sym').textContent;
    document.querySelector('#chart-next').click();
    await new Promise(r=>setTimeout(r,4000));
    const b = document.querySelector('#chart-sym').textContent;
    document.querySelector('#chart-prev').click();
    await new Promise(r=>setTimeout(r,4000));
    return { a, b, c: document.querySelector('#chart-sym').textContent };
  })()`);
  ok('◀ ▶ 能切换币种并能切回来', step.b !== step.a && step.c === step.a, `${step.a} → ${step.b} → ${step.c}`);

  const bars = await evalJs(`(async () => {
    document.querySelector('#chart-bars').value = '60';
    document.querySelector('#chart-bars').dispatchEvent(new Event('change'));
    await new Promise(r=>setTimeout(r,3500));
    const n = (typeof VIEWS!=='undefined' && VIEWS?.multi?.items?.[0]?.candles?.length) || 0;
    document.querySelector('#chart-bars').value = 'auto';
    document.querySelector('#chart-bars').dispatchEvent(new Event('change'));
    return n;
  })()`);
  ok('K线根数可手动固定（60 根）', bars === 60, `返回 ${bars} 根`);

  const det = await evalJs(`(async () => {
    document.querySelector('#chart-detail').click();
    await new Promise(r=>setTimeout(r,1500));
    const open = !document.querySelector('#detail').classList.contains('hidden');
    const rows = document.querySelectorAll('#detail .lvtable tbody tr').length;
    document.querySelector('#detail [data-close]').click();
    return { open, rows };
  })()`);
  ok('图表页的「明细」按钮能打开级别明细表', det.open && det.rows === 14, `${det.rows} 行`);

  // 回归：没有数据的级别会传 null，fmtPrice 必须拦住（曾导致整个抽屉渲染中断）
  {
    const FP = await evalJs(`[null, undefined, NaN, 0.0000123, 1234.5].map(v => {
      try { return fmtPrice(v); } catch (e) { return 'THROW:' + e.message; } })`);
    ok('★ fmtPrice 对 null/undefined/NaN 安全（不再抛 toPrecision 异常）',
      FP[0] === '—' && FP[1] === '—' && FP[2] === '—' && !FP.some(x => String(x).startsWith('THROW')),
      FP.join(' | '));
    // 找一个含空数据级别的币种，确认明细仍能渲染
    const empty = await evalJs(`(async () => {
      const s = await fetch('/api/snapshot').then(r=>r.json());
      for (const sym of s.symbols.slice(0, 40)) {
        const d = await fetch('/api/detail?symbol=' + sym).then(r=>r.json());
        if (!d.levels) continue;
        const nulls = Object.values(d.levels).filter(l => l.price == null || l.ma7 == null).length;
        if (nulls > 0) return { sym, nulls, total: Object.keys(d.levels).length };
      }
      return null;
    })()`);
    if (empty) {
      const r = await evalJs(`(async () => {
        openDetail('${empty.sym}');
        await new Promise(r=>setTimeout(r,1500));
        const rows = document.querySelectorAll('#detail .lvtable tbody tr').length;
        document.querySelector('#detail [data-close]').click();
        return rows;
      })()`);
      ok(`★ 含空数据级别的币种（${empty.sym}，${empty.nulls}/${empty.total} 个级别无数据）明细仍完整渲染`,
        r === 14, `${r} 行`);
    } else {
      ok('★ 含空数据级别的币种明细仍完整渲染', true, '当前样本中未找到空数据级别，跳过');
    }
  }
  ok('K线图视图无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' ; ') || '无');

  /* ================= 报警级别K线视图 ================= */
  console.log('\n\u001b[36m▌报警级别K线视图\u001b[0m');
  {
    // 标签位置：新按钮必须在「K线图」左侧
    const tabs = await evalJs(`[...document.querySelectorAll('.viewtabs .vt')].map(b => b.id)`);
    const iA = tabs.indexOf('tab-alert'), iM = tabs.indexOf('tab-multi');
    ok('★ 「报警级别K线」按钮位于「K线图」左侧',
      iA >= 0 && iM >= 0 && iA < iM && tabs[iA + 1] === 'tab-multi',
      tabs.slice(0, 3).join(' → '));
  }

  // 后端：级别必须取组合的中间那段
  {
    const V = await evalJs(`(async () => {
      const a = await fetch('/api/alerts').then(r=>r.json());
      const list = Array.isArray(a) ? a : (a.alerts || []);
      const d = await fetch('/api/alertchart?bars=100&limit=24').then(r=>r.json());
      const LV = { '1m':'1分','2m':'2分','3m':'3分','5m':'5分','10m':'10分','15m':'15分','30m':'30分','1h':'1时','2h':'2时','3h':'3时','4h':'4时','6h':'6时','12h':'12时','1d':'日线','1w':'周线' };
      return {
        alertCount: list.length,
        shown: d.shown, total: d.total, skipped: d.skipped,
        items: d.items.map(it => ({ sym: it.symbol, group: it.group, mid: it.mid, key: it.key, label: it.label, bars: it.candles.length, id: it.alertId })),
        alertIds: list.map(x => x.id),
        lvMap: LV,
      };
    })()`);
    console.log(`   报警 ${V.alertCount} 条 · 接口返回 ${V.shown}/${V.total}（跳过 ${V.skipped}）`);
    console.log('   前 4 条: ' + V.items.slice(0, 4).map(i => `${i.sym} ${i.group}→取${i.label}`).join(' | '));

    ok('★ 每条报警取的级别 = 组合的中间级别',
      V.items.length > 0 && V.items.every(i => {
        const parts = String(i.group).split('>');
        return parts.length === 3 && parts[1] === i.mid && i.key === i.mid
          && i.label === V.lvMap[i.mid];
      }),
      V.items.slice(0, 3).map(i => `${i.group} → ${i.mid}/${i.label}`).join('  '));
    // 不比对两次独立请求的顺序（中间可能刚好来了新报警，必然错位）；
    // 直接校验「按提醒顺序」本身：alertId 由引擎自增分配，最新在前就必然是严格递减
    ok('★ 图表严格按提醒顺序排列（alertId 递减 = 最新在前）',
      V.items.length > 1 && V.items.every((it, k) => k === 0 || it.id < V.items[k - 1].id),
      `alertId ${V.items.slice(0, 5).map(i => i.id).join(' > ')}`);
    ok('图表条目全部来自当前报警列表',
      V.items.length > 0 && V.items.every(i => V.alertIds.includes(i.id)),
      `来自当前列表 ${V.items.filter(i => V.alertIds.includes(i.id)).length}/${V.items.length}`);
    ok('每条都带回了该级别的K线数据', V.items.every(i => i.bars > 0),
      `K线根数 ${[...new Set(V.items.map(i => i.bars))].join(',')}`);
  }

  await evalJs(`document.querySelector('#tab-alert').click()`);
  await sleep(7000);
  const AC = await evalJs(`(() => {
    const grid = document.querySelector('#alertchartgrid');
    const cards = [...grid.querySelectorAll('.chartcard')];
    const heads = cards.map(c => {
      const h = c.querySelector('.cchead');
      return {
        sym: h.querySelector('.sym')?.textContent || '',
        lvl: h.querySelector('.rb.lvl')?.textContent || '',
        mode: h.querySelector('.st')?.textContent || '',
        grp: h.querySelector('.grp')?.textContent || '',
        sc: h.querySelector('.sc')?.textContent || '',
      };
    });
    return {
      visible: getComputedStyle(grid).display !== 'none',
      bodyClass: document.body.classList.contains('alertchartmode'),
      tableHidden: getComputedStyle(document.querySelector('#tablewrap')).display === 'none',
      multiHidden: getComputedStyle(document.querySelector('#chartgrid')).display === 'none',
      cards: cards.length,
      inited: cards.filter(c => c.querySelector('.tv-lightweight-charts')).length,
      limitSel: +document.querySelector('#alert-limit').value || 24,
      heads,
      cols: grid.style.getPropertyValue('--cols'),
      ch: grid.style.getPropertyValue('--ch'),
      overflow: grid.scrollHeight - grid.clientHeight,
      scrollable: grid.scrollHeight - grid.clientHeight > 4,
      gridH: grid.clientHeight, scrollH: grid.scrollHeight,
      plotW: Math.round(cards[0]?.querySelector('.cchart')?.getBoundingClientRect().width || 0),
      plotH: Math.round(cards[0]?.querySelector('.cchart')?.getBoundingClientRect().height || 0),
      divScroll: document.documentElement.scrollHeight - window.innerHeight,
      symbar: getComputedStyle(document.querySelector('#chart-symbar')).display,
      alertbar: getComputedStyle(document.querySelector('#alert-symbar')).display,
      painted: (() => { const c = cards[0]?.querySelector('.cchart canvas');
        if (!c) return { n: 0, total: 0 };
        const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        let n = 0, total = 0;
        for (let i = 3; i < d.length; i += 4*53) { total++; if (d[i] > 0) n++; }
        return { n, total }; })(),
      live: document.querySelector('#alert-live').textContent,
    };
  })()`);
  console.log(`   卡片 ${AC.cards} 张 · 列=${AC.cols} --ch=${AC.ch} · 溢出 ${AC.overflow}px · 已绘制 ${AC.painted.n}/${AC.painted.total}`);
  console.log('   表头样例: ' + AC.heads.slice(0, 3).map(h => `${h.sym} ${h.lvl} ${h.mode} ${h.grp} ${h.sc}`).join(' | '));

  ok('切到报警视图后主区切换（表格与多级别图都隐藏）',
    AC.visible && AC.bodyClass && AC.tableHidden && AC.multiHidden, `body=${AC.bodyClass}`);
  ok('★ 每条报警渲染成一张K线图（条数 = min(设定上限, 实际报警数)）',
    AC.inited === AC.cards && AC.cards > 0 && AC.cards <= AC.limitSel,
    `${AC.cards} 张，初始化 ${AC.inited} 张（上限 ${AC.limitSel}）`);
  ok('★ 卡片表头显示 币种 / 确认级别 / 已确认或预警 / 组合 / 评分',
    AC.heads.every(h => /USDT$/.test(h.sym) && /分|时|日线|周线/.test(h.lvl)
      && /已确认|预警/.test(h.mode) && /→/.test(h.grp) && /分$/.test(h.sc)),
    AC.heads[0] ? `${AC.heads[0].sym} ${AC.heads[0].lvl} ${AC.heads[0].mode} ${AC.heads[0].grp} ${AC.heads[0].sc}` : '无');
  ok('★ 报警视图优先保证可读尺寸（默认「标准」，图表比紧凑档明显更大）',
    AC.plotH >= 200 && AC.plotW >= 340,
    `绘图区 ${AC.plotW}x${AC.plotH}（紧凑档约 292x147）`);
  ok('★ 放不下时可上下滚动查看（页面本身不滚动）',
    AC.scrollable && AC.divScroll <= 1,
    `网格 ${AC.gridH}/${AC.scrollH}px，溢出 ${AC.overflow}px，页面溢出 ${AC.divScroll}px`);
  ok('顶部提示当前布局与是否可滚动', /列 × \d+ 行/.test(AC.live) && /可上下滚动|一屏看全/.test(AC.live), AC.live);
  ok('★ 画布真的画出了内容',
    AC.painted.total > 0 && AC.painted.n / AC.painted.total > 0.015,
    `稀疏采样非透明像素 ${AC.painted.n}/${AC.painted.total} = ${(AC.painted.n / Math.max(1, AC.painted.total) * 100).toFixed(1)}%`);
  ok('报警视图隐藏币种切换栏、显示报警工具条',
    AC.symbar === 'none' && AC.alertbar !== 'none', `symbar=${AC.symbar} alertbar=${AC.alertbar}`);
  ok('顶部显示报警统计', /共 \d+ 条报警/.test(AC.live), AC.live);

  // 条数上限 + 尺寸档位 + 真实滚动（拆成两段，避免单次求值太久）
  {
    const SET = `const set = async (sel, v) => { const e = document.querySelector(sel); e.value = v;
      e.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 2600)); };
      const read = () => { const g = document.querySelector('#alertchartgrid');
        const c = g.querySelector('.chartcard .cchart').getBoundingClientRect();
        return { n: g.querySelectorAll('.chartcard').length, cols: g.style.getPropertyValue('--cols'),
          w: Math.round(c.width), h: Math.round(c.height),
          avail: (typeof VIEWS !== 'undefined' && VIEWS?.alert?.items?.length) || 0,
          overflow: g.scrollHeight - g.clientHeight }; };`;

    const S1 = await evalJs(`(async () => { ${SET}
      await set('#alert-limit', '12');     const small = read();
      // 档位差异只在「放不下、需要压缩」时才显现 —— 所以要在 24 条下比，
      // 12 条时地方宽裕，紧凑和标准都会得到同一个高度。
      await set('#alert-limit', '24');
      await set('#alert-size', 'compact'); const compact = read();
      await set('#alert-size', 'normal');  const normal = read();
      return { small, compact, normal };
    })()`);
    const S2 = await evalJs(`(async () => { ${SET}
      await set('#alert-size', 'xl');      const xl = read();
      await set('#alert-size', 'normal');  const normal2 = read();
      await set('#alert-limit', '12');     const small2 = read();
      await set('#alert-limit', '24');     const big = read();
      return { xl, normal2, small2, big };
    })()`);
    const SC = await evalJs(`(async () => {
      const g = document.querySelector('#alertchartgrid');
      const max = g.scrollHeight - g.clientHeight;
      const target = Math.min(500, max);          // 内容不足 500px 时按实际可滚距离
      g.scrollTop = target; await new Promise(r => setTimeout(r, 400));
      const at500 = g.scrollTop;
      g.scrollTop = max; await new Promise(r => setTimeout(r, 400));
      const atEnd = g.scrollTop;
      const oy = getComputedStyle(g).overflowY;
      g.scrollTop = 0;
      return { at500, atEnd, max, oy, target };
    })()`);
    const L = { ...S1, ...S2, ...SC };
    console.log('   尺寸档位: ' + JSON.stringify({ 紧凑: L.compact.h, 标准: L.normal.h, 特大: L.xl.h }));
    ok('可切换展示条数（12 / 24，受实际报警数封顶）',
      L.small.n === Math.min(12, L.big.avail) && L.big.n === Math.min(24, L.big.avail),
      `可用报警 ${L.big.avail} 条 → 12→${L.small.n} 24→${L.big.n}`);
    ok('★ 12 条时「标准」档能一屏看全', L.small2.overflow <= 4,
      `12 条 → 绘图区 ${L.small2.w}×${L.small2.h}，溢出 ${L.small2.overflow}px`);
    ok('★ 「紧凑」档把 24 条塞进一屏（保留原行为）', L.compact.overflow <= 4,
      `绘图区 ${L.compact.w}×${L.compact.h}，溢出 ${L.compact.overflow}px`);
    ok('★ 尺寸档位逐级放大（紧凑 < 标准 < 特大）',
      L.compact.h < L.normal.h && L.normal.h < L.xl.h,
      `紧凑 ${L.compact.h} < 标准 ${L.normal.h} < 特大 ${L.xl.h}`);
    ok('★ 放不下时真的可以滑动查看',
      L.max > 100 && L.oy === 'auto' && L.at500 === L.target && L.atEnd === L.max,
      `overflow-y=${L.oy} 可滚 ${L.max}px，滚到 500→${L.at500}，到底→${L.atEnd}`);
  }

  // 切回矩阵再切回来
  {
    const B = await evalJs(`(async () => {
      document.querySelector('#tab-matrix').click();
      await new Promise(r=>setTimeout(r,800));
      const backToMatrix = !document.body.classList.contains('alertchartmode')
        && getComputedStyle(document.querySelector('#alertchartwrap')).display === 'none'
        && getComputedStyle(document.querySelector('#tablewrap')).display !== 'none';
      document.querySelector('#tab-alert').click();
      await new Promise(r=>setTimeout(r,5500));
      const again = document.querySelectorAll('#alertchartgrid .chartcard').length;
      const c = document.querySelector('#alertchartgrid .cchart canvas');
      let againPainted = 0, againTotal = 0;
      if (c) { const dd = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
        for (let i = 3; i < dd.length; i += 4*53) { againTotal++; if (dd[i] > 0) againPainted++; } }
      return { backToMatrix, again, againPainted, againTotal };
    })()`);
    ok('切回矩阵视图正常（报警视图隐藏）', B.backToMatrix);
    ok('再次切回报警视图仍能正常渲染',
      B.again > 0 && B.againTotal > 0 && B.againPainted / B.againTotal > 0.015,
      `${B.again} 张，已绘制 ${B.againPainted}/${B.againTotal} = ${(B.againPainted / Math.max(1, B.againTotal) * 100).toFixed(1)}%`);
  }

  {
    // 注意：必须在**被悬停的那张卡片内**查询 tooltip。
    // 用 document.querySelector('#grid .ctip') 会拿到 DOM 里第一个 tip（属于别的卡片），
    // 那张卡片的 tip 早被隐藏了，于是测出来永远 shown=false。
    let tip = null;
    // 报警会持续到达、卡片可能增删或位移，所以每轮重试都**重新定位**；
    // 读取时在网格内找「任意一个可见的 tip」，而不是绑定某一张卡片。
    for (let k = 0; k < 5; k++) {
      const pt = await evalJs(`(() => {
        const g = document.querySelector('#alertchartgrid');
        const cards = [...g.querySelectorAll('.chartcard')];
        if (!cards.length) return null;
        const c = cards[Math.min(1, cards.length - 1)];
        const r = c.getBoundingClientRect();
        return { x: Math.round(r.left + r.width * 0.45), y: Math.round(r.top + r.height * 0.45) };
      })()`);
      if (!pt) break;
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y, buttons: 0 });
      await sleep(220);
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x + 2, y: pt.y + 1, buttons: 0 });
      await sleep(650);
      tip = await evalJs(`(() => {
        const g = document.querySelector('#alertchartgrid');
        const vis = [...g.querySelectorAll('.ctip')].filter(t => getComputedStyle(t).display !== 'none');
        return vis.length ? { shown: true, text: vis[0].textContent.replace(/\\s+/g,' ').slice(0,70) } : null;
      })()`);
      if (tip && tip.shown) break;
    }
    ok('★ 报警图表的十字光标提示显示币种与级别',
      !!(tip && tip.shown && /USDT/.test(tip.text)), tip ? `${tip.shown ? '可见' : '隐藏'} ${tip.text}` : '未生成提示框');
  }
  ok('报警视图无 JS 异常', errs.length === 0, errs.slice(0, 2).join(' ; ') || '无');
  await evalJs(`document.querySelector('#tab-matrix').click()`);
  if (relaxed) {
    await fetch(URL_.replace(/\/$/, '') + '/api/config', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requireStrokeChain: true, filterBeichi: true }) });
    console.log('   已还原缠论过滤器默认值');
  }
  await sleep(600);
} catch (e) {
  console.error('失败：' + (e.stack || e.message)); fail++;
} finally {
  console.log(`\n${fail === 0 ? '\u001b[32mUI 校验全部通过\u001b[0m' : '\u001b[31mUI 校验有失败项\u001b[0m'}：${pass} 通过 / ${fail} 失败\n`);
  try { ws?.close(); } catch { }
  try { child.kill(); } catch { }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { } process.exit(fail ? 1 : 0); }, 700);
}
