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
    if (alert.score < this.cfg.minScore) { this.stats.dropped++; return false; }
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
      url = `${dingtalkUrl()}?access_token=${encodeURIComponent(ch.accessToken)}`;
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
  return { ok: false, err: `dingtalk errcode=${j.errcode} ${j.errmsg ?? ''}` };
}

/**
 * 格式化一批信号为钉钉 markdown。
 * 钉钉 markdown 支持 #/## 标题、**加粗**、`>` 引用、列表，不支持表格与 <font color>。
 * @returns {{title:string, text:string}}
 */
export function formatAlerts(alerts, { test = false, keyword = '' } = {}) {
  const head = test ? '🧪 钉钉推送测试' : `🔔 多级别共振信号 ×${alerts.length}`;
  const title = (keyword ? keyword + ' ' : '') + (test
    ? '推送测试'
    : (alerts.length === 1
      ? `${alerts[0].confirmed ? '✅' : '⚡'} ${alerts[0].symbol} ${alerts[0].score}分 ${alerts[0].base}→${alerts[0].mid}→${alerts[0].big}`
      : `共振信号 ×${alerts.length}`));

  const lines = [`### ${head}`, ''];
  alerts.forEach((a, i) => {
    const tag = a.confirmed ? '已确认' : '预警';
    lines.push(`**${i + 1}. ${a.symbol}**　${a.score}分　${tag}`);
    lines.push(`> 级别：${a.base} → ${a.mid} → ${a.big}　|　共振 ${a.bullCount} 级`);
    lines.push(`> 价格：${a.price}　|　距MA7 ${a.distBaseMa7Pct >= 0 ? '+' : ''}${Number(a.distBaseMa7Pct ?? 0).toFixed(2)}%　|　${hhmm(a.ts)}`);
    lines.push(`> ${a.text}`);
    lines.push('');
  });
  if (!test) lines.push('---', '来源：币安多级别共振盯盘系统');
  return { title, text: lines.join('\n') };
}

function hhmm(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
