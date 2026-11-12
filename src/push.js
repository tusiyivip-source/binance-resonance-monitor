/**
 * 钉钉推送（自定义机器人）
 *
 * 钉钉群机器人只需一个 Webhook，支持三种安全设置，本模块都兼容：
 *   1. 自定义关键词 —— 消息里必须包含关键词，用 cfg.keyword 自动补进标题
 *   2. 加签          —— 填了 secret 就自动按官方规则签名（HMAC-SHA256 + base64 + urlEncode）
 *   3. IP 白名单     —— 无需额外处理
 *
 * 重要：钉钉机器人硬限「20 条/分钟」（超限返回 errcode 660026），
 * 而本系统每小时会产生几十条信号，逐条推送必然刷屏+撞限流，
 * 因此这里做**批量聚合**：窗口期内的信号合并成一条再发。
 *
 * 另附一个通用 webhook 通道，方便接自建中转服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// 通道元数据与默认配置放在无 Node 依赖的 push-meta.js 里，浏览器版共用同一份。
// 注意：`export ... from` 只转发、不创建本地绑定，所以这里还要再 import 一次本地名。
export { DINGTALK_URL, CHANNEL_META, DEFAULT_PUSH } from './push-meta.js';
import { DINGTALK_URL, CHANNEL_META, DEFAULT_PUSH } from './push-meta.js';

/** 允许用环境变量把推送指向自建/代理地址（也便于测试时指向 Mock 服务） */
const dingtalkUrl = () => process.env.DINGTALK_URL || DINGTALK_URL;

/**
 * 把用户填的「Access Token」归一化成纯 token。
 *
 * 为什么需要：钉钉群机器人页面上给的是一条完整 Webhook 地址
 *   https://oapi.dingtalk.com/robot/send?access_token=<64位十六进制>
 * 而配置项要的只是最后那串 token。用户十有八九会把整条地址粘进来，
 * 拼出来的 URL 就变成 `...?access_token=https%3A%2F%2F...`，
 * 钉钉返回 **errcode=300005 token is not exist** —— 看起来像"token 失效"，
 * 实际只是多粘了一段。这里把常见粘法都兼容掉。
 */
export function normalizeDingtalkToken(raw) {
  let s = String(raw ?? '').trim().replace(/\s+/g, '');
  if (!s) return '';
  // 1) 粘了整条 Webhook 地址
  if (/^https?:/i.test(s)) {
    try { s = new URL(s).searchParams.get('access_token') || s; }
    catch { const m = s.match(/access_token=([^&]+)/i); s = m ? decodeURIComponent(m[1]) : s; }
  }
  // 2) 粘了 "access_token=xxx" 或前面带了别的参数
  s = s.replace(/^.*?access_token=/i, '');
  // 3) 后面还挂了别的查询参数
  s = s.replace(/[?&].*$/, '');
  return s;
}

/** token 看起来是否正常（钉钉的是 64 位十六进制）；仅用于提示，不阻断发送 */
export function looksLikeDingtalkToken(t) {
  return /^[0-9a-f]{32,}$/i.test(t);
}

const mask = s => (!s ? '' : (s.length <= 8 ? '****' : s.slice(0, 4) + '****' + s.slice(-4)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_ATTEMPTS = 5;

/** 限流专用错误：不消耗重试次数，交给上层退避后重投 */
class RateLimitError extends Error {
  constructor(message, retryAfter) { super(message); this.retryAfter = retryAfter; this.rateLimited = true; }
}

/** 钉钉加签：sign = urlEncode(base64(HMAC-SHA256(secret, `${timestamp}\n${secret}`))) */
export function dingtalkSign(secret, timestamp) {
  const stringToSign = `${timestamp}\n${secret}`;
  const raw = crypto.createHmac('sha256', secret).update(stringToSign, 'utf8').digest('base64');
  return encodeURIComponent(raw);
}

export class Pusher {
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.cfg = structuredClone(DEFAULT_PUSH);
    this.queue = [];
    this.timer = null;
    this.sentTimes = [];
    this.sending = false;
    this.stats = { queued: 0, sent: 0, failed: 0, retried: 0, dropped: 0, messages: 0, lastError: null, lastAt: 0, lastPreview: null };
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.cfg = { ...DEFAULT_PUSH, ...raw, channels: Array.isArray(raw.channels) ? raw.channels : [] };
      this.log.info(`推送配置已载入：${this.enabledChannels().length} 个启用通道`);
    } catch (e) {
      this.log.warn('推送配置读取失败：' + e.message);
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2));
    } catch (e) {
      this.log.warn('推送配置写入失败：' + e.message);
    }
  }

  enabledChannels() {
    if (!this.cfg.enabled) return [];
    return (this.cfg.channels ?? []).filter(c => {
      if (!c || c.enabled === false) return false;
      if (c.type === 'webhook') return !!c.url;
      if (c.type === 'dingtalk') return !!c.accessToken;
      return false;
    });
  }

  /** 前端读取用：密钥只回显掩码 */
  publicConfig() {
    return {
      ...this.cfg,
      channels: (this.cfg.channels ?? []).map(c => {
        const out = { ...c };
        for (const f of (CHANNEL_META[c.type]?.fields ?? [])) {
          if (f.secret && out[f.key]) { out[f.key + 'Masked'] = mask(out[f.key]); delete out[f.key]; }
        }
        return out;
      }),
    };
  }

  /** 更新配置；密钥字段若回传掩码或空串则保留原值 */
  setConfig(patch) {
    const next = { ...this.cfg };
    for (const [k, v] of Object.entries(patch)) {
      if (k === 'channels') continue;
      if (k in DEFAULT_PUSH) next[k] = v;
    }
    if (Array.isArray(patch.channels)) {
      const old = this.cfg.channels ?? [];
      next.channels = patch.channels.slice(0, 8).map((c, i) => {
        const type = CHANNEL_META[c?.type] ? c.type : 'dingtalk';
        const out = { type, enabled: c?.enabled !== false };
        for (const f of CHANNEL_META[type].fields) {
          const incoming = c?.[f.key];
          const prev = old[i]?.type === type ? old[i]?.[f.key] : null;
          out[f.key] = (!incoming || String(incoming).includes('****')) ? (prev ?? '') : String(incoming);
        }
        return out;
      });
    }
    this.cfg = next;
    this.save();
    this.log.info(`推送配置已更新：${this.enabledChannels().length} 个启用通道，启用=${this.cfg.enabled}`);
    return this.publicConfig();
  }

  /** 引擎产生信号时调用（同步、非阻塞） */
  push(alert) {
    if (!this.enabledChannels().length) return false;
    // 存量/回填信号（initial=true）只入面板，不推送 —— 它们描述的是已经发生过的形态，
    // 推出去会让人误以为是刚出现的机会（重启后尤其明显）。
    if (alert.initial) { this.stats.dropped++; return false; }
    // 评分门槛只对有评分体系的信号（共振）生效。
    // 形态提醒（双阴不破 / 双阳不穿）的 score 恒为 0，若也走同一个门槛，
    // 用户把 minScore 设成 68 之后就再也收不到形态提醒了 —— 那正是最容易踩的坑。
    const hasScore = alert.kind !== 'dual' && Number.isFinite(alert.score) && alert.score > 0;
    if (hasScore && alert.score < this.cfg.minScore) { this.stats.dropped++; return false; }
    if (this.cfg.confirmedOnly && !alert.confirmed) { this.stats.dropped++; return false; }
    this.queue.push(alert);
    this.stats.queued++;
    if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => { }); }, this.cfg.batchWindowMs);
    }
    return true;
  }

  _canSend(now) {
    this.sentTimes = this.sentTimes.filter(t => now - t < 60_000);
    return this.sentTimes.length < this.cfg.maxPerMinute;
  }

  async flush() {
    if (this.sending || !this.queue.length) return;
    this.sending = true;
    try {
      const now = Date.now();
      if (!this._canSend(now)) {
        const oldest = this.sentTimes[0] ?? now;
        const wait = Math.max(1000, 60_000 - (now - oldest) + 500);
        this.log.warn(`推送已达每分钟上限 ${this.cfg.maxPerMinute} 条，${(wait / 1000).toFixed(0)}s 后重试`);
        this._schedule(wait);
        return;
      }
      const batch = this.queue.splice(0, this.cfg.maxItemsPerMessage);
      const msg = formatAlerts(batch, { keyword: this.cfg.channels?.find(c => c.keyword)?.keyword });
      const r = await this.deliver(batch, msg);

      if (r.ok) {
        this.sentTimes.push(Date.now());
        this.stats.sent += batch.length;
        this.stats.messages++;
        this.stats.lastAt = Date.now();
        this.stats.lastPreview = msg.text.slice(0, 240);
        this.stats.lastError = null;
      } else {
        // 失败必须放回队列，否则信号会被静默丢弃
        for (const a of batch) a.__pushAttempts = (a.__pushAttempts ?? 0) + 1;
        const retry = batch.filter(a => a.__pushAttempts < MAX_ATTEMPTS);
        const giveUp = batch.length - retry.length;
        if (retry.length) this.queue.unshift(...retry);
        this.stats.retried += retry.length;
        this.stats.failed += giveUp;
        if (r.rateLimited) {
          this.log.warn(`推送被限流，${(r.retryAfter / 1000).toFixed(0)}s 后重投（队列 ${this.queue.length} 条）`);
        } else if (giveUp) {
          this.log.warn(`推送连续失败 ${MAX_ATTEMPTS} 次，放弃 ${giveUp} 条信号`);
        }
        this._schedule(r.rateLimited ? r.retryAfter : 2000);
      }
    } finally {
      this.sending = false;
      if (this.queue.length && !this.timer) this._schedule(1000);
    }
  }

  _schedule(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush().catch(() => { }); }, Math.max(200, ms));
  }

  async deliver(alerts, msg) {
    const channels = this.enabledChannels();
    if (!channels.length) return { ok: false, retryAfter: 0, rateLimited: false };
    const results = await Promise.all(channels.map(c =>
      this.sendOne(c, alerts, msg).then(() => ({ ok: true })).catch(e => ({ ok: false, err: e.message, rateLimited: !!e.rateLimited, retryAfter: e.retryAfter || 0 }))));
    const bad = results.filter(r => !r.ok);
    if (bad.length) {
      this.stats.lastError = `${bad[0].err} (${bad.length}/${results.length} 通道失败)`;
      this.log.warn('推送失败：' + bad.map(b => b.err).join(' ; '));
    }
    return {
      ok: bad.length === 0,
      rateLimited: bad.some(b => b.rateLimited),
      retryAfter: Math.max(0, ...bad.map(b => b.retryAfter || 0)),
    };
  }

  async sendOne(ch, alerts, msg, retries = 2) {
    let url, body, headers = { 'content-type': 'application/json' };

    if (ch.type === 'dingtalk') {
      const ts = Date.now();
      const token = normalizeDingtalkToken(ch.accessToken);
      url = `${dingtalkUrl()}?access_token=${encodeURIComponent(token)}`;
      if (ch.secret) url += `&timestamp=${ts}&sign=${dingtalkSign(ch.secret, ts)}`;
      body = JSON.stringify({
        msgtype: 'markdown',
        markdown: { title: msg.title.slice(0, 60), text: msg.text.slice(0, 18_000) },
      });
    } else {
      if (!ch.url) throw new Error('自定义 webhook 缺少 url');
      url = ch.url;
      body = JSON.stringify({ source: 'binance-monitor', title: msg.title, text: msg.text, alerts });
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      try {
        const res = await fetch(url, { method: 'POST', headers, body, signal: ctl.signal });
        clearTimeout(t);
        const txt = await res.text();
        const v = judgeDingtalk(ch.type, res.status, txt);
        if (v.ok) return { ok: true };
        // 限流：立刻抛出，不在这里长睡，交给上层退避并保留队列
        if (v.retryAfter) throw new RateLimitError(v.err, v.retryAfter);
        if (attempt < retries) { await sleep(600 * (attempt + 1)); continue; }
        throw new Error(v.err);
      } catch (e) {
        clearTimeout(t);
        if (attempt >= retries) throw new Error(`${ch.type}: ${e.message}`);
        await sleep(600 * (attempt + 1));
      }
    }
    throw new Error(`${ch.type}: 重试耗尽`);
  }

  /** 发测试消息验证配置 */
  async sendTest() {
    const channels = this.enabledChannels();
    if (!channels.length) return { ok: false, error: '没有启用任何推送通道（请先勾选、填 Access Token，并打开顶部的「启用推送」）' };
    const fake = [{
      symbol: 'TESTUSDT', group: '3m>15m>2h', base: '3m', mid: '15m', big: '2h',
      score: 88, confirmed: true, price: 1.2345, distBaseMa7Pct: 0.42, bullCount: 9,
      ts: Date.now(),
      text: '3分回踩后上穿MA7/EMA7，15分同步上穿均线，2时站稳EMA7不破 · 9个级别多头排列 · [测试消息]',
    }];
    const msg = formatAlerts(fake, { test: true, keyword: channels.find(c => c.keyword)?.keyword });
    const out = await Promise.all(channels.map(async c => {
      try { await this.sendOne(c, fake, msg); return { type: c.type, label: CHANNEL_META[c.type].label, ok: true }; }
      catch (e) { return { type: c.type, label: CHANNEL_META[c.type].label, ok: false, error: e.message }; }
    }));
    return { ok: out.every(o => o.ok), results: out, preview: msg.text };
  }

  get statsOut() {
    return {
      ...this.stats,
      enabledChannels: this.enabledChannels().map(c => ({ type: c.type, label: CHANNEL_META[c.type].label, signed: !!c.secret })),
      queueLength: this.queue.length,
    };
  }
}

/** 解析钉钉回执 */
function judgeDingtalk(type, status, txt) {
  if (type !== 'dingtalk') {
    return (status >= 200 && status < 300) ? { ok: true } : { ok: false, err: `webhook HTTP ${status}: ${txt.slice(0, 200)}` };
  }
  if (status < 200 || status >= 300) return { ok: false, err: `dingtalk HTTP ${status}: ${txt.slice(0, 200)}` };
  let j;
  try { j = JSON.parse(txt); } catch { return { ok: false, err: `dingtalk 响应无法解析: ${txt.slice(0, 200)}` }; }
  if (j.errcode === 0) return { ok: true };
  if (j.errcode === 660026) return { ok: false, err: 'dingtalk 触发每分钟限流(660026)', retryAfter: 60_000 };
  if (j.errcode === 310000) {
    return { ok: false, err: `dingtalk 安全设置不通过(310000)：${j.errmsg ?? ''} —— 若是「自定义关键词」，请在通道里填上关键词` };
  }
  if (j.errcode === 300005) {
    return {
      ok: false,
      // 保留 "errcode=300005 / token is not exist" 这些机器可读片段（测试与日志过滤要用），
      // 后面再补上给人看的排查指引。
      err: `dingtalk errcode=300005 token is not exist —— 钉钉找不到这个 access_token。`
        + '常见原因：①把整条 Webhook 地址粘进了 Token 框（正确做法是只填 access_token= 后面那 64 位）；'
        + '②机器人已被删除或重置；③复制时少了字符。'
        + '请到钉钉群 → 群设置 → 智能群助手 → 机器人 → 复制完整 Webhook 地址重新粘贴。',
    };
  }
  return { ok: false, err: `dingtalk errcode=${j.errcode} ${j.errmsg ?? ''}` };
}

/**
 * 格式化一批信号为钉钉 markdown。
 * 钉钉 markdown 支持 #/## 标题、**加粗**、`>` 引用、列表，不支持表格与 <font color>。
 * @returns {{title:string, text:string}}
 */
export function formatAlerts(alerts, { test = false, keyword = '' } = {}) {
  // —— 标题 ——
  // 三类信号语义不同，标题不能一律写「共振信号」：
  //   zeropair = 零轴配对（主级别定方向 + 次级别回踩触发）
  //   dual     = 形态提醒（双阴不破 / 双阳不穿）
  //   其它     = 多级别共振
  const nZero = alerts.filter(a => a.kind === 'zeropair').length;
  const nPair = alerts.filter(a => a.kind === 'pairzero').length;
  const nSingle = alerts.filter(a => a.kind === 'singlek').length;
  const nDual = alerts.filter(a => a.kind === 'dual').length;
  const nReso = alerts.length - nZero - nPair - nSingle - nDual;
  const nTop = alerts.filter(a => a.tier === 'top').length;
  const nTail = alerts.filter(a => a.tier === 'tail').length;
  const only = nPair === alerts.length ? 'pair'
    : nSingle === alerts.length ? 'single'
    : nZero === alerts.length ? 'zero'
    : nDual === alerts.length ? 'dual' : 'mixed';

  let head;
  if (test) head = '🧪 钉钉推送测试';
  else if (only === 'pair') head = `🔔 配对信号 ×${nPair}`;
  else if (only === 'single') head = `🔔 一阳穿三阴 ×${nSingle}`;
  else if (only === 'zero') head = `🔔 零轴配对信号 ×${nZero}`;
  else if (only === 'dual') head = `🔔 形态提醒 ×${nDual}` + (nTop || nTail ? `（前段 ${nTop} · 后段 ${nTail}）` : '');
  else head = `🔔 盯盘信号 ×${alerts.length}`;

  const title = (keyword ? keyword + ' ' : '') + (test
    ? '推送测试'
    : (alerts.length === 1
      ? (() => {
          const a = alerts[0];
          if (a.kind === 'pairzero') return `${a.side === 'long' ? '🔴' : '🟢'} ${a.symbol} ${a.pair} ${a.side === 'long' ? '看多' : '看空'}`;
          if (a.kind === 'singlek') return `${a.side === 'long' ? '🔴' : '🟢'} ${a.symbol} ${a.levelLabel ?? a.level} ${a.side === 'long' ? '看多' : '看空'}`;
          if (a.kind === 'zeropair') return `${a.side === 'long' ? '🔴' : '🟢'} ${a.symbol} ${a.pair} ${a.side === 'long' ? '看多' : '看空'}`;
          if (a.kind === 'dual') return `${a.side === 'long' ? '🔴' : '🟢'} ${a.symbol} ${a.levelLabel ?? ''} ${a.side === 'long' ? '看多' : '看空'}`;
          return `${a.confirmed ? '✅' : '⚡'} ${a.symbol} ${a.score}分 ${a.base}→${a.mid}→${a.big}`;
        })()
      : (only === 'pair' ? `配对 ×${nPair}` : only === 'single' ? `一阳穿三阴 ×${nSingle}` : only === 'zero' ? `零轴配对 ×${nZero}` : only === 'dual' ? `形态提醒 ×${nDual}` : `信号 ×${alerts.length}`)));

  const lines = [`### ${head}`, ''];
  const footer = () => { if (!test) lines.push('---', '来源：币安多级别共振盯盘系统'); };

  // —— ⓪ 配对全景的信号（两套策略并列）——
  //   A 连跌N根·首次收阳  /  B 零上死叉·阳收MA5
  if (nPair) {
    const pz = alerts.filter(a => a.kind === 'pairzero')
      .sort((x, y) => String(x.variant || '').localeCompare(String(y.variant || ''))
        || (x.level || '').localeCompare(y.level || '')
        || String(x.symbol).localeCompare(String(y.symbol)));
    if (only !== 'pair') { lines.push(`#### ◎ 配对全景信号　×${nPair}`); lines.push(''); }
    pz.forEach((a, i) => {
      const lvl = a.levelLabel || a.subLabel || a.level || '—';
      const tag = a.variantLabel || (a.variant === 'state' ? '零上死叉·阳收MA5' : '首次收阳');
      lines.push(`**${i + 1}. ${a.symbol}**　${lvl}　看多　【${tag}】　榜内 #${a.rank ?? '—'}`);
      lines.push(`> 零轴上死叉　DIF ${Number(a.deadDif ?? 0).toPrecision(3)} / DEA ${Number(a.deadDea ?? 0).toPrecision(3)}`);
      if (a.variant === 'state') {
        lines.push(`> 当前 DIF ${Number(a.dif ?? 0).toPrecision(3)}　柱 ${Number(a.hist ?? 0).toPrecision(3)}　阳线收 ${a.close} 站上 MA5 ${Number(a.ma5 ?? 0).toPrecision(3)}`);
      } else {
        lines.push(`> 死叉后连跌 ${a.downBars ?? '—'} 根　首次收阳 ${a.close}　MA5 ${Number(a.ma5 ?? 0).toPrecision(3)}`);
      }
      lines.push(`> 现价 ${a.price}　|　24h ${Number(a.changePct) >= 0 ? '+' : ''}${Number(a.changePct).toFixed(2)}%　|　${hhmm(a.ts)}`);
      lines.push('');
    });
  }

  // —— ⓪ 一阳穿三阴 ——
  // 每条的看点是「推动有多强 + 回调有多浅 + 不破线在哪」，三样都要写清楚。
  if (nSingle) {
    const sk = alerts.filter(a => a.kind === 'singlek')
      .sort((x, y) => (y.bigT ?? 0) - (x.bigT ?? 0) || (y.bodyPct ?? 0) - (x.bodyPct ?? 0));
    if (only !== 'single') { lines.push(`#### ◎ 一阳穿三阴　×${nSingle}`); lines.push(''); }
    sk.forEach((a, i) => {
      const up = a.side === 'long';
      lines.push(`**${i + 1}. ${a.symbol}**　${a.levelLabel ?? a.level}　${up ? '看多' : '看空'}　榜内 #${a.rank ?? '—'}`);
      lines.push(`> 阳线 +${Number(a.bodyPct ?? 0).toFixed(2)}%（实体放大 ${Number(a.mult ?? 0).toFixed(1)} 倍）`);
      lines.push(`> 下跌 ${a.barsAfter ?? '—'} 根　|　穿透 ${Number(a.retracePct ?? 0).toFixed(2)}%　|　三阴最高开 ${a.line ?? '—'}　|　收盘 ${a.close ?? a.price}`);
      // 上级确认：例如 2 时必须金叉同向才推
      if (a.confirm) {
        lines.push(`> 确认 ${a.confirm.label} ${a.confirm.cross} ✓ 同向　|　DIF ${Number(a.confirm.dif).toPrecision(3)} / DEA ${Number(a.confirm.dea).toPrecision(3)}`);
      }
      lines.push(`> ${hhmm(a.ts)}`);
      lines.push('');
    });
  }

  // —— ① 零轴配对 ——
  // 主级别只定方向，次级别才是触发点，所以两个级别都要写明，
  // 并且把「次级别贴近程度」和「主级别 DIF」都列出来，方便判断强弱。
  if (nZero) {
    const zs = alerts.filter(a => a.kind === 'zeropair')
      .sort((x, y) => (x.subNear ?? 9) - (y.subNear ?? 9) || (y.mainHold ?? 0) - (x.mainHold ?? 0));
    if (only !== 'zero') { lines.push(`#### ◎ 零轴配对　×${nZero}`); lines.push(''); }
    zs.forEach((a, i) => {
      const up = a.side === 'long';
      lines.push(`**${i + 1}. ${a.symbol}**　${a.pair}　${up ? '看多' : '看空'}`);
      lines.push(`> 次级别 ${a.levelLabel ?? a.sub}：靠近零轴 ${(Number(a.subNear ?? 0) * 100).toFixed(1)}%`
        + `　|　${up ? '零轴上方不下穿' : '零轴下方不上穿'}　|　已持续 ${a.subHold ?? '—'} 根`);
      lines.push(`> 主级别 ${a.mainLabel ?? a.main}：DIF=${Number(a.mainDif ?? 0).toPrecision(4)}`
        + `（${Number(a.mainDif) > 0 ? '零轴上方' : '零轴下方'}）　|　已持续 ${a.mainHold ?? '—'} 根`);
      lines.push(`> 价格：${a.price}　|　${hhmm(a.ts)}`);
      lines.push('');
    });
  }

  // —— ② 形态提醒：前 N / 后 N 分开列 ——
  if (nDual) {
    const du = alerts.filter(a => a.kind === 'dual');
    const tiered = du.some(a => a.tier);
    const groups = tiered
      ? [['top', '🅰 涨幅榜前段'], ['tail', '🅱 涨幅榜后段'], [null, '其他']]
      : [[null, '形态提醒']];
    for (const [key, label] of groups) {
      const sub = du.filter(a => (a.tier ?? null) === key)
        .sort((x, y) => (y.star ? 1 : 0) - (x.star ? 1 : 0) || (x.rank ?? 999) - (y.rank ?? 999));
      if (!sub.length) continue;
      const nStar = sub.filter(a => a.star).length;
      if (only !== 'dual' || tiered) { lines.push(`#### ${label}　×${sub.length}${nStar ? `　⭐${nStar}` : ''}`); lines.push(''); }
      sub.forEach((a, i) => {
        const star = a.star ? '⭐ ' : '';
        lines.push(`**${i + 1}. ${star}${a.symbol}**　${a.levelLabel ?? a.level}　${a.side === 'long' ? '看多' : '看空'}　已确认`);
        lines.push(`> 价格：${a.price}　|　排名 #${a.rank ?? '—'}${a.star ? '　⭐星标' : ''}　|　${hhmm(a.ts)}`);
        lines.push(`> ${String(a.text).replace(/^★\s*/, '').replace(/^【(前|后)\d+】/, '')}`);
        lines.push('');
      });
    }
  }

  // —— ③ 共振 ——
  if (nReso) {
    if (only === 'mixed') { lines.push(`#### ◇ 多级别共振　×${nReso}`); lines.push(''); }
    alerts.filter(a => a.kind !== 'zeropair' && a.kind !== 'dual').forEach((a, i) => {
      lines.push(`**${i + 1}. ${a.symbol}**　${a.score}分　${a.confirmed ? '已确认' : '预警'}`);
      lines.push(`> 级别：${a.base} → ${a.mid} → ${a.big}　|　共振 ${a.bullCount} 级`);
      lines.push(`> 价格：${a.price}　|　距MA7 ${a.distBaseMa7Pct >= 0 ? '+' : ''}${Number(a.distBaseMa7Pct ?? 0).toFixed(2)}%　|　${hhmm(a.ts)}`);
      lines.push(`> ${a.text}`);
      lines.push('');
    });
  }

  footer();
  return { title, text: lines.join('\n') };
}

function hhmm(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
