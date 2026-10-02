/**
 * 全局配置：级别定义、信号参数、限频预算
 */

/** 级别定义，按周期升序。
 *  native=false 的级别由本地合成（币安无该原生周期：2分钟 / 10分钟 / 3小时）。
 *  hidden=true 的级别不参与界面显示与「多头排列」计数，仅作为合成数据源。
 *  limit = 该级别每次拉取的K线根数（合约权重敏感，权重 1 的上限是 99 根）。
 */
export const LEVELS = [
  { key: '1m', label: '1分', minutes: 1, native: true, hidden: true, limit: 200, backfill: 400 },
  { key: '2m', label: '2分', minutes: 2, native: false, from: '1m', ratio: 2 },
  { key: '3m', label: '3分', minutes: 3, native: true, limit: 99, backfill: 300 },
  { key: '5m', label: '5分', minutes: 5, native: true, limit: 150, backfill: 300 },
  { key: '10m', label: '10分', minutes: 10, native: false, from: '5m', ratio: 2 },
  { key: '15m', label: '15分', minutes: 15, native: true, limit: 99, backfill: 300 },
  { key: '30m', label: '30分', minutes: 30, native: true, limit: 99, backfill: 300 },
  { key: '1h', label: '1时', minutes: 60, native: true, limit: 150, backfill: 300 },
  { key: '2h', label: '2时', minutes: 120, native: true, limit: 99, backfill: 300 },
  { key: '3h', label: '3时', minutes: 180, native: false, from: '1h', ratio: 3 },
  { key: '4h', label: '4时', minutes: 240, native: true, limit: 99, backfill: 300 },
  { key: '6h', label: '6时', minutes: 360, native: true, limit: 99, backfill: 300 },
  { key: '12h', label: '12时', minutes: 720, native: true, limit: 99, backfill: 300 },
  { key: '1d', label: '日线', minutes: 1440, native: true, limit: 99, backfill: 300 },
  { key: '1w', label: '周线', minutes: 10080, native: true, limit: 99, backfill: 300 },
];

/** 界面显示与「多头排列」计数使用的级别（排除隐藏的数据源级别） */
export const VISIBLE_LEVELS = LEVELS.filter(l => !l.hidden);
export const LEVEL_KEYS = VISIBLE_LEVELS.map(l => l.key);
/** 全部级别 key（含隐藏），用于查找序列 */
export const ALL_LEVEL_KEYS = LEVELS.map(l => l.key);
export const LEVEL_INDEX = Object.fromEntries(LEVELS.map((l, i) => [l.key, i]));
export const NATIVE_LEVELS = LEVELS.filter(l => l.native);
export const MINUTE_MS = 60_000;

/** 级别状态码（前端按此着色） */
export const STATE = {
  NODATA: 0,   // 数据不足
  BULL_ALIGN: 1, // 多头排列 close>MA7>MA25 且 MA7 上行
  BULL: 2,       // 站上 MA7，但 MA7 尚未站上 MA25
  NEUTRAL: 3,    // 均线纠缠
  WEAK: 4,       // 跌破 MA7，但 MA25 仍在下方支撑
  BEAR_ALIGN: 5, // 空头排列 close<MA7<MA25
};

/** 级别事件码（叠加在状态上） */
export const EVENT = {
  NONE: 0,
  CROSS_UP: 1,      // 近期收盘上穿 MA7
  PULLBACK: 2,      // 近期回踩触及 MA7
  CROSS_DOWN: 3,    // 近期收盘跌破 MA7
  PULLBACK_CROSS: 4, // 回踩后再度上穿（本系统的核心触发形态）
};

/**
 * 级别组合（核心）：一组「基准 → 确认 → 最大」的**固定三元组**。
 * 基准级别：发生「回踩后上穿 MA7/EMA7」的触发级别
 * 确认级别：必须同步上穿自身均线
 * 最大级别：不得跌破自身均线
 * 三者不必相邻（如 3分 → 15分 → 2时，中间跨过 5分/10分）。
 */
export const DEFAULT_GROUPS = [
  { base: '3m', mid: '15m', big: '2h', enabled: true },
  { base: '2m', mid: '10m', big: '1h', enabled: true },
  { base: '5m', mid: '30m', big: '3h', enabled: true },
];

/** 信号引擎参数（前端可实时调） */
/**
 * 两阶段盯盘的级别对应表（可改）。
 *   big  大级别：出现「连续 bigBars 根阴K收盘不破 MA7/EMA7」→ 进入预备名单
 *   base 最小级别：跌破 MA7/EMA7 后**首次**收盘重新站上 → 报警
 *   mid  次级别（参考：是否够笔）
 *   inner 大级别内的中间级别（参考：是否够笔）
 *   adjacent 临近级别（参考：是否上穿均线）
 *
 * 用户确认的对应表就是这三组（与信号引擎的 DEFAULT_GROUPS 同一套映射）：
 *   2m → 10m → 1h      3m → 15m → 2h      5m → 30m → 3h
 */
export const DEFAULT_WATCH_GROUPS = [
  { big: '1h', mid: '10m', base: '2m', inner: ['15m', '30m'], adjacent: '15m', enabled: true },
  { big: '2h', mid: '15m', base: '3m', inner: ['30m', '1h'], adjacent: '30m', enabled: true },
  { big: '3h', mid: '30m', base: '5m', inner: ['1h', '2h'], adjacent: '1h', enabled: true },
];

export const DEFAULT_SIGNAL = {
  // ============ 三条通道总开关 ============
  // signalEnabled：共振信号引擎（固定级别组合 + 回踩突破 MA7/EMA7 + 背驰/成笔链过滤）
  // watchEnabled ：两阶段盯盘（大级别预备 → 最小级别首次站上）
  // dualEnabled  ：双阴不破均线（多） / 双阳不穿破均线（空）★ 当前只跑这一条
  signalEnabled: false,
  scanMode: 'groups',      // groups=只扫描下面配置的固定组合；auto=穷举（基准+下一档+任意更大级别）
  groups: DEFAULT_GROUPS,  // 固定组合列表
  minBullLevels: 3,        // 至少 N 个级别为多头排列（用户要求 ≥3）
  pullbackLookback: 6,     // 基准级别：多少根K线内必须出现"回踩MA7"
  pullbackTolerance: 0.002,// 回踩触及判定容差（相对 MA7 的百分比）
  triggerLookback: 2,      // 基准级别：多少根K线内完成"上穿MA7"
  adjacentLookback: 3,     // 确认级别：多少根K线内"上穿均线"
  requireEma7: true,       // 基准级别必须同时站上 EMA7
  requireAdjacentCross: true, // 确认级别必须同步上穿
  requireBaseBull: true,   // 基准级别必须处于多头形态
  bigMa: 'ema7',           // 最大级别"不跌破"用哪条均线：ma7 | ema7
  bigTolerance: 0.0,       // 最大级别允许贴近均线的容差（0 = 必须在其上方）
  useLiveCandle: true,     // 是否同时给出"形成中K线"的预警信号
  countRule: 'align',      // 共振计数：align=严格多头排列 c>MA7>MA25；above=站上MA7
  baseMinIdx: 2,           // auto 模式：允许作为"基准级别"的最小下标（2=3分钟）
  baseMaxIdx: 6,           // auto 模式：允许作为"基准级别"的最大下标（6=30分钟）
  minScore: 0,             // 低于此评分的信号不推送
  // —— 回踩形态 ——
  //   touch      = 最低价触及 MA7、收盘站住，之后发生「上穿 MA7」事件才触发（旧行为）
  //   twoBearHold = 连续 N 根阴K下跌但收盘始终没跌破 MA7/EMA7（影线可插破），
  //                 当前K线收盘同时站上两条均线即触发（跌无可跌）
  pullbackPattern: 'twoBearHold',
  pullbackBars: 2,         // twoBearHold 模式下要求几根阴K

  // —— 两阶段盯盘（预备 → 触发）——
  //   阶段一：大级别首次出现「连续 watchBigBars 根阴K收盘不破 MA7/EMA7」→ 进入预备名单
  //   阶段二：最小级别先收盘跌破 MA7 与 EMA7，再首次收盘重新站上 → 报警
  watchEnabled: false,
  watchBigBars: 2,          // 大级别要求连续几根「收盘不破两条均线」（2~3）
  watchRequireBear: true,   // 是否要求那几根是阴K
  watchGroups: DEFAULT_WATCH_GROUPS,   // 级别对应表（见文件上方定义）

  // —— 独立形态提醒：双阴不破均线（多） / 双阳不穿破均线（空）——
  //   不依赖共振组合，也不依赖盯盘状态机；这几档级别上一出现形态、第二根K线一收盘就提醒。
  dualEnabled: true,
  dualLevels: ['15m', '30m', '1h', '2h', '3h'],
  dualBars: 2,             // 连续几根（默认两根）
  dualRequireMaSlope: true,// 均线方向：做多要求 MA7 向上，做空要求 MA7 向下
  dualPrevBars: 3,         // 前置趋势：形态之前价格需已在均线同侧持续 N 根（0=不检查）
  // —— 缠论背驰过滤（排除「确认级别将要出现背驰笔」的信号） ——
  filterBeichi: true,      // 总开关
  beichiScope: 'mid',      // mid = 只查确认级别；mid+big = 连最大级别一起查
  beichiMinBars: 5,        // 标准笔：顶底分型之间至少 5 根K线（含包含处理）
  beichiRatio: 1.0,        // MACD 柱面积衰减阈值：当前面积 < 前一同向笔面积 × 该值
  beichiMinProgress: 0.3,  // 当前笔至少走到前一同向笔幅度的 30% 才判定（避免刚起步误判）
  // —— 回踩成笔链（笔延续级别） ——
  requireStrokeChain: true,    // 基准 → 确认级别之间的所有级别，都必须被这波回调带动成笔
  chainRequireAboveMa: false,  // 附加：链上各级别同时站上 MA7（「5m 带动 15m 也站上均线」）
};

/**
 * 市场配置档：现货 与 U 本位永续合约是两套独立的接口与额度。
 *
 * 注意（实测）：从部分网络访问时，U 本位合约的 kline / aggTrade / markPrice /
 * miniTicker / ticker 这几类 WS 流会被静默拦截（订阅回执正常但零数据），
 * 而 depth / bookTicker 正常。因此合约默认走「!bookTicker 实时价 + REST 补K线」。
 * 详见 README「合约数据通道」一节。
 */
export const MARKET_PROFILES = {
  spot: {
    key: 'spot',
    name: '现货 Spot',
    baseUrls: [
      'https://api.binance.com', 'https://api1.binance.com', 'https://api2.binance.com',
      'https://api3.binance.com', 'https://api4.binance.com', 'https://data-api.binance.vision',
    ],
    wsUrl: 'wss://stream.binance.com:9443/ws',
    klinesPath: '/api/v3/klines',
    tickerPath: '/api/v3/ticker/24hr',
    exchangeInfoPath: '/api/v3/exchangeInfo?permissions=SPOT&symbolStatus=TRADING',
    tickerWeight: 80,
    officialWeightCap: 6000,
    weightPerMinute: 3600,
    wsKlineStreams: true,        // 该市场的 kline WS 可用
    universeFilter: s => s.quoteAsset === 'USDT' && s.status === 'TRADING',
  },
  futures: {
    key: 'futures',
    name: 'U本位合约 USDⓈ-M',
    baseUrls: ['https://fapi.binance.com'],
    wsUrl: 'wss://fstream.binance.com/ws',
    klinesPath: '/fapi/v1/klines',
    tickerPath: '/fapi/v1/ticker/24hr',
    exchangeInfoPath: '/fapi/v1/exchangeInfo',
    tickerWeight: 40,
    officialWeightCap: 2400,
    weightPerMinute: 1900,       // 合约 IP 额度只有 2400/分钟，留足余量
    wsKlineStreams: false,       // 实测：kline WS 被拦截，改用 bookTicker
    bookTickerStream: '!bookTicker',
    universeFilter: s => s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && s.status === 'TRADING',
  },
};

/**
 * 环境变量读取：Node 下走 process.env；浏览器里没有 process，
 * 于是全部落到默认值 —— 这样**同一份 config.js 两端都能直接跑**。
 */
const ENV = (typeof process !== 'undefined' && process.env) ? process.env : {};
const env = (key, fallback = '') => (ENV[key] ?? fallback);

const PROFILE_KEY = String(env('MARKET', 'futures')).toLowerCase();
export const PROFILE = MARKET_PROFILES[PROFILE_KEY] ?? MARKET_PROFILES.futures;

export const APP = {
  market: PROFILE.key,
  profile: PROFILE,
  port: Number(env('PORT', 8848)),
  host: env('HOST', '127.0.0.1'),
  baseUrls: PROFILE.baseUrls,
  wsUrl: PROFILE.wsUrl,
  klinesPath: PROFILE.klinesPath,
  tickerPath: PROFILE.tickerPath,
  exchangeInfoPath: PROFILE.exchangeInfoPath,
  topN: 200,
  candleLimit: 200,          // 默认K线根数（各级别可在 LEVELS 里单独覆盖）
  tickerRefreshMs: 60_000,   // 涨幅榜刷新
  exchangeInfoRefreshMs: 30 * 60_000,
  resyncMs: 15 * 60_000,     // 全量对账，修复丢包
  broadcastMs: 1000,         // 前端表格推送频率
  weightPerMinute: PROFILE.weightPerMinute,
  weightBurst: 600,
  concurrency: 12,           // REST 并发
  maxCandlesKept: 320,       // 每个级别序列保留的K线数（MA99 需 99 根 + 回看 20 根，留足余量）
  minQuoteVolume: 0,         // 0 = 严格按涨幅榜取前200，不做流动性过滤
  minTrades24h: 50,          // 死盘保险丝：24h 成交笔数低于此值的对子剔除（避免僵尸币污染榜单）
  staleMs: 6 * 3600_000,     // K线超过此时长未更新则视为僵尸标的，不参与评估
  /**
   * 行情源模式：
   *   kline-ws   纯 K线 WebSocket（现货默认，真实 OHLC、零权重）
   *   tick-rest  bookTicker 实时价 + REST 定期补K线（合约默认）
   *   auto       启动时先试 K线 WS，15 秒内收不到数据就自动切到 tick-rest
   */
  feed: String(env('FEED', 'auto')).toLowerCase(),
};

/** tick-rest 模式下各周期的 REST 补K线节奏（毫秒） */
export const REST_REFRESH_PLAN = [
  { levels: ['1m'], everyMs: 90_000 },
  { levels: ['3m'], everyMs: 90_000 },
  { levels: ['5m'], everyMs: 90_000 },
  { levels: ['15m'], everyMs: 120_000 },
  { levels: ['30m'], everyMs: 180_000 },
  { levels: ['1h'], everyMs: 180_000 },
  { levels: ['2h', '4h'], everyMs: 300_000 },
  { levels: ['6h', '12h', '1d', '1w'], everyMs: 600_000 },
];

/** 稳定币 / 杠杆代币，从涨幅榜中剔除 */
export const EXCLUDE_BASE = new Set([
  'USDC', 'FDUSD', 'TUSD', 'BUSD', 'DAI', 'USDP', 'USDD', 'USDE', 'USD1', 'XUSD',
  'AEUR', 'EUR', 'GBP', 'EURI', 'PAXG', 'SUSD', 'USTC', 'UST', 'PYUSD', 'GUSD',
]);
export const EXCLUDE_SYMBOL_RE = /(UP|DOWN|BULL|BEAR)USDT$/;
