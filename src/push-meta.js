/**
 * 钉钉通道的元数据与默认配置 —— **不依赖任何 Node 内置模块**。
 *
 * 单独拆出来是为了让浏览器版也能读到同一份定义（前端要用它渲染推送配置面板），
 * 避免两边各写一份常量导致漂移。push.js 从这里再导出，保持原有导入路径不变。
 */

export const DINGTALK_URL = 'https://oapi.dingtalk.com/robot/send';

export const CHANNEL_META = {
  dingtalk: {
    label: '钉钉群机器人',
    fields: [
      { key: 'accessToken', label: 'Access Token', placeholder: 'Webhook 里 access_token= 后面那串', secret: true },
      { key: 'secret', label: '加签 Secret（可选）', placeholder: '安全设置选「加签」时填 SEC 开头那串', secret: true },
      { key: 'keyword', label: '自定义关键词（可选）', placeholder: '安全设置选「自定义关键词」时填，会自动加进标题', secret: false },
    ],
  },
  webhook: {
    label: '自定义 Webhook',
    fields: [
      { key: 'url', label: 'URL', placeholder: 'https://your-server/hook（POST JSON）', secret: true },
    ],
  },
};

export const DEFAULT_PUSH = {
  enabled: false,
  channels: [],
  minScore: 60,             // 低于此评分不推送
  confirmedOnly: false,     // 只推「已确认」（不含未收盘预警）
  batchWindowMs: 20_000,    // 聚合窗口：窗口内的信号合并成一条
  maxPerMinute: 10,         // 每分钟最多发几条（钉钉硬限 20）
  maxItemsPerMessage: 8,    // 单条消息最多列几个信号
};

/** 未启用推送时的空实现，供浏览器版复用（前端只需要这些字段） */
export function emptyPushStats() {
  return {
    queued: 0, sent: 0, failed: 0, retried: 0, dropped: 0, messages: 0,
    lastError: null, lastAt: null, lastPreview: null,
  };
}
