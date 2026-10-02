/**
 * 构建纯前端版（可部署到任意静态托管；也是 GitHub Pages 的发布目录）。
 *
 *   node tools/build-web.mjs
 *
 * 为什么输出到 docs/：GitHub Pages 的发布源只支持「根目录」或「/docs」，
 * 不支持任意子目录。输出到 docs/ 之后，站点根目录就直接是盯盘界面。
 * 展示页让位到 docs/about.html，截图共同放在 docs/img/。
 *
 * 设计要点：**不复制任何业务逻辑**。core 模块直接从 src/ 拷过去，
 * 前端 app.js / chart.js 也是原封不动 —— 保证 Node 版与网页版不会漂移。
 * 唯一新增的是 src/browser/boot.js（把 /api/* 与 SSE 就地路由到内存引擎）。
 *
 * 构建时会硬检查：所有要发给浏览器的模块**不得 import 任何 node: 内置模块**，
 * 否则网页版会静默挂掉。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve('.');
const OUT = path.join(ROOT, 'docs');

/** 会随网页一起下发给浏览器的模块（注意：不含 file-storage.js / push.js） */
const CORE = [
  'config.js', 'indicators.js', 'chan.js', 'series.js', 'signals.js',
  'rest.js', 'market.js', 'tickfeed.js', 'engine.js',
  'emitter.js', 'logger.js', 'tracker.js', 'push-meta.js',
  'watch.js',
];
const BROWSER = ['boot.js'];
const PUBLIC_FILES = ['app.js', 'chart.js', 'style.css'];

/** 构建产物「拥有」的路径——只清理这些，不动 about.html 与 img/ */
const OWNED = ['index.html', ...PUBLIC_FILES, 'vendor', 'src'];

/* ---------------- 1) 硬检查：不能有 node: 依赖 ---------------- */
const NODE_PAT = /(?:^|\n)\s*import[^\n]*from\s+['"]node:|\brequire\(\s*['"]node:|(?:^|\n)\s*import\s+fs\s+from/;
const offenders = [];
for (const f of [...CORE.map(x => path.join('src', x)), ...BROWSER.map(x => path.join('src', 'browser', x))]) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  if (NODE_PAT.test(src)) offenders.push(f);
}
if (offenders.length) {
  console.log('✗ 以下模块含 node: 内置依赖，浏览器会直接报错：');
  for (const f of offenders) console.log('    ' + f);
  process.exit(1);
}
console.log(`✓ 依赖检查通过：${CORE.length + BROWSER.length} 个模块均无 node: 内置依赖`);

/* ---------------- 1b) 硬检查：相对导入的模块必须都在下发清单里 ----------------
 * 只查「有没有 node: 依赖」是不够的 —— 新增一个模块（如 watch.js）而忘记加进 CORE，
 * 线上会因为模块解析失败而整个应用打不开，本地却完全看不出来。
 * 这里把每个下发模块的相对 import 解析出来，逐个确认它确实会被一起下发。 */
{
  const shipped = new Set([...CORE, ...BROWSER.map(x => 'browser/' + x)].map(x => 'src/' + x.replace(/\\/g, '/')));
  const missing = [];
  const importRe = /(?:^|\n)\s*(?:import|export)[^\n]*?from\s+['"](\.[^'"]+)['"]/g;
  for (const rel of [...CORE.map(x => 'src/' + x), ...BROWSER.map(x => 'src/browser/' + x)]) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    let m;
    while ((m = importRe.exec(src)) !== null) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
      if (!shipped.has(resolved)) missing.push(rel + '  →  ' + m[1] + '  (解析为 ' + resolved + ')');
    }
  }
  if (missing.length) {
    console.log('✗ 以下模块引用了没有一起下发的文件，线上会直接打不开：');
    for (const x of [...new Set(missing)]) console.log('    ' + x);
    process.exit(1);
  }
  console.log(`✓ 引用完整性通过：${shipped.size} 个模块的相对导入全部在清单内`);
}

/* ---------------- 2) 只清理自己拥有的产物 ---------------- */
fs.mkdirSync(OUT, { recursive: true });
for (const p of OWNED) {
  const full = path.join(OUT, p);
  if (fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
}
fs.mkdirSync(path.join(OUT, 'src', 'browser'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(path.join(ROOT, from), path.join(OUT, to));

for (const f of CORE) copy(path.join('src', f), path.join('src', f));
for (const f of BROWSER) copy(path.join('src', 'browser', f), path.join('src', 'browser', f));
for (const f of PUBLIC_FILES) copy(path.join('public', f), f);
copy(path.join('public', 'vendor', 'lightweight-charts.js'), path.join('vendor', 'lightweight-charts.js'));

/* ---------------- 3) 生成 index.html ---------------- */
let html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

// 静态资源改相对路径（部署到子目录时绝对路径会 404）
html = html.replace('href="/style.css"', 'href="./style.css"');

// 替换底部的三个 script 标签为「先装补丁、再加载界面」的引导器
const scripts = [
  '<script src="/vendor/lightweight-charts.js"></script>',
  '<script src="/app.js"></script>',
  '<script src="/chart.js"></script>',
];
const bootstrap = `<script>
/* 纯前端版引导：先把 /api/* 与 EventSource 换成内存实现，再加载界面脚本。
   界面脚本必须保持「经典脚本」身份（它们靠全局作用域互相访问），
   所以这里用动态 import + 顺序注入，而不是把它们变成 module。 */
(function () {
  var banner = document.getElementById('web-mode-note');
  function fail(e) {
    var msg = (e && (e.stack || e.message)) || String(e);
    if (banner) { banner.style.display = 'block'; banner.innerHTML = '<b>启动失败</b>：' + msg; }
    console.error('[web] 启动失败', e);
  }
  import('./src/browser/boot.js').then(function () {
    if (banner) banner.style.display = 'block';
    function load(src) {
      return new Promise(function (res, rej) {
        var s = document.createElement('script');
        s.src = src; s.onload = res; s.onerror = function () { rej(new Error('脚本加载失败：' + src)); };
        document.body.appendChild(s);
      });
    }
    return load('./vendor/lightweight-charts.js')
      .then(function () { return load('./app.js'); })
      .then(function () { return load('./chart.js'); });
  }).catch(fail);
})();
</script>`;

const first = scripts[0];
if (!html.includes(first)) { console.log('✗ 找不到脚本标签锚点，index.html 结构可能已变'); process.exit(1); }
html = html.replace(scripts.join('\n'), bootstrap);
// 万一三个标签不连续，逐个兜底
for (const s of scripts) html = html.replace(s + '\n', '').replace(s, '');

// 顶部插入「在线版」说明条
const note = `<div id="web-mode-note" style="display:none;padding:6px 14px;font-size:12px;
  background:#132a1f;border-bottom:1px solid #1e4a33;color:#8ee0b0;line-height:1.6">
  🌐 <b>在线版</b>：数据由你的浏览器直接向币安公开接口获取（无需后端）。
  行情源为「实时价 + REST 补K线」——实测本网络下币安的 K线 WebSocket 被屏蔽，与后端版同一套应对方案。
  <span style="color:#f0b90b">钉钉推送不可用</span>（需要后端保管密钥）。
  <a href="./about.html" style="color:#7dd3fc;margin-left:8px">关于本项目 →</a>
</div>`;
const bodyOpen = html.indexOf('<body>');
if (bodyOpen < 0) { console.log('✗ 找不到 <body>'); process.exit(1); }
html = html.slice(0, bodyOpen + 6) + '\n' + note + html.slice(bodyOpen + 6);

fs.writeFileSync(path.join(OUT, 'index.html'), html);

/* ---------------- 4) 报告 ---------------- */
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d =>
  d.isDirectory() ? walk(path.join(dir, d.name)) : [path.join(dir, d.name)]);
const files = walk(OUT);
const total = files.reduce((s, f) => s + fs.statSync(f).size, 0);
console.log(`\n✓ 已生成 docs/  （${files.length} 个文件，${(total / 1024).toFixed(0)} KB）`);
for (const f of files.sort()) {
  console.log(`    ${(fs.statSync(f).size / 1024).toFixed(1).padStart(8)} KB  ${path.relative(OUT, f).replace(/\\/g, '/')}`);
}
console.log('\n站点根目录 = 盯盘界面，展示页在 docs/about.html');
console.log('本地预览：  node tools/serve-web.mjs        然后打开 http://127.0.0.1:8850/');
