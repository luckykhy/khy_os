'use strict';

/**
 * searchFreshness.js — 时间维度 / 新鲜度的单一真源(goal 2026-06-25「怎么搜才能拿到最新数据」)。
 *
 * 教学要点(用户给的三条):
 *   1. 搜索接口要支持「按时间过滤 / 按日期排序」——本模块把每个引擎的时间过滤 URL 参数
 *      集中成 `freshnessToEngineParam`(百度 gpc/stf、Bing qft interval、DuckDuckGo df、
 *      搜狗 tsn)。khyos 是抓取式元搜索而非 Bing/Google API,所以「时间过滤」落在结果页
 *      URL 参数上;拿不准的引擎留空,由下面第 3 点的重排兜底。
 *   2. 工具封装要把参数暴露出来——`resolveWindow` 既接受显式 freshness,也在缺省时从 query
 *      自动识别意图(「硬编码进搜索参数」),所以即便模型忘了传,时效问题也会自动过滤。
 *   3. 按日期排序——`applyRecencyRanking` 解析每条结果里的日期(填充既有但一直为空的
 *      publishedDate 字段),把窗口内的新结果顶上去;这一层与具体引擎是否真的认 URL 参数
 *      无关,是可靠的兜底「按日期排序」。
 *
 * 纯叶子:零 IO、确定性(now 由调用方注入,便于单测)、可单测。env 门控
 * KHY_SEARCH_FRESHNESS(默认开)+ KHY_SEARCH_FRESHNESS_RERANK(默认开)。
 */

const SEC = 1000;
const DAY_MS = 24 * 60 * 60 * SEC;

// 时间窗口 → 天数。这是档位的单一真源,其余映射都从这里派生。
const WINDOW_DAYS = { day: 1, week: 7, month: 30, year: 365 };
const WINDOW_ORDER = ['day', 'week', 'month', 'year'];

// ── env 门控 ─────────────────────────────────────────────────────────
// 收敛到 utils/envOnByName 单一真源(逐字节委托,调用点不变)
const _envOn = require('../../utils/envOnByName');
function isEnabled(env) { return _envOn(env, 'KHY_SEARCH_FRESHNESS'); }
function isRerankEnabled(env) { return _envOn(env, 'KHY_SEARCH_FRESHNESS_RERANK'); }

// ── 1. 意图识别 ──────────────────────────────────────────────────────
// 从 query 文本判断是否是时效性问题,以及合适的时间窗口。保守:只在出现明确时间/
// 新闻意图时返回窗口,普通检索一律返回 null(不限定时间,不动既有召回)。
// 强信号优先(今天/实时 > 本周 > 本月 > 今年),通用「最新/新闻」类落到 week 这个稳妥默认。
const DAY_RE = /(今天|今日|昨天|刚刚|刚才|此刻|实时|\btoday\b|\byesterday\b|\bbreaking\b|\blive\b|\bright now\b)/i;
const WEEK_RE = /(本周|这周|这一周|近一周|\bthis week\b|\bpast week\b)/i;
const MONTH_RE = /(本月|这个月|近一月|近一个月|\bthis month\b|\bpast month\b)/i;
const YEAR_RE = /(今年|本年|\bthis year\b)/i;
// 通用时效意图(无明确窗口)→ 默认 week。
const GENERIC_RE = /(最新|最近|近期|目前|现在|当前|新闻|快讯|动态|进展|消息|行情|股价|报价|天气|\blatest\b|\brecent(ly)?\b|\bnewest\b|\bnews\b|\bcurrent\b|\bnowadays\b|\bup[\s-]?to[\s-]?date\b|\bupdate[ds]?\b)/i;

/**
 * @param {string} query
 * @returns {'day'|'week'|'month'|'year'|null}
 */
function detectFreshness(query) {
  const q = String(query || '');
  if (!q.trim()) return null;
  if (DAY_RE.test(q)) return 'day';
  if (WEEK_RE.test(q)) return 'week';
  if (MONTH_RE.test(q)) return 'month';
  if (YEAR_RE.test(q)) return 'year';
  if (GENERIC_RE.test(q)) return 'week';
  return null;
}

/**
 * 归一化外部传入的 freshness 值到内部窗口名。接受:
 *   - 内部名 day/week/month/year
 *   - 单字母 d/w/m/y
 *   - 博查式 oneDay/oneWeek/oneMonth/oneYear、noLimit
 *   - 'auto'(交给自动识别,返回 'auto' 透传)、'none'/'noLimit'(→ null)
 * 不认识 → null。
 * @returns {'day'|'week'|'month'|'year'|'auto'|null}
 */
function normalizeWindow(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return null;
  if (s === 'auto') return 'auto';
  if (s === 'none' || s === 'nolimit' || s === 'no_limit' || s === 'all' || s === 'any') return null;
  if (WINDOW_DAYS[s]) return s;
  const single = { d: 'day', w: 'week', m: 'month', y: 'year' };
  if (single[s]) return single[s];
  const bocha = { oneday: 'day', oneweek: 'week', onemonth: 'month', oneyear: 'year' };
  if (bocha[s]) return bocha[s];
  // "m6" / "past week" 等宽松形态
  if (/^m\d+$/.test(s)) return 'month';
  if (/day/.test(s)) return 'day';
  if (/week/.test(s)) return 'week';
  if (/month/.test(s)) return 'month';
  if (/year/.test(s)) return 'year';
  return null;
}

/**
 * 决定本次搜索实际生效的时间窗口:显式优先,否则按 query 自动识别(把新鲜度
 * 「硬编码」进搜索参数 —— 即便模型没传,时效问题也会被过滤)。门控关闭 → null。
 * @param {string|undefined} explicit  工具层传入的 freshness
 * @param {string} query
 * @param {object} [env]
 * @returns {'day'|'week'|'month'|'year'|null}
 */
function resolveWindow(explicit, query, env) {
  if (!isEnabled(env)) return null;
  const norm = normalizeWindow(explicit);
  if (norm && norm !== 'auto') return norm;
  // norm === 'auto' 或未提供 → 自动识别
  return detectFreshness(query);
}

// ── 2. 每引擎的时间过滤 URL 参数 ─────────────────────────────────────
/**
 * 返回要拼到引擎结果页 URL 上的 query 串(不含前导 & / ?),无合适参数返回 ''。
 * 拿不准的引擎(360)留空,靠 applyRecencyRanking 兜底;未知参数会被各引擎忽略,
 * 不会 400,所以即便某引擎不认也安全。
 * @param {string} window  day|week|month|year
 * @param {string} engine  baidu|bing-cn|duckduckgo|sogou|so360|kiro
 * @param {number} [nowMs] 注入的当前时间(毫秒),用于需要时间戳的引擎(百度)
 * @returns {string}
 */
function freshnessToEngineParam(window, engine, nowMs) {
  if (!window || !WINDOW_DAYS[window]) return '';
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const days = WINDOW_DAYS[window];
  switch (engine) {
    case 'duckduckgo': {
      // DuckDuckGo html 端 df=d|w|m|y,最可靠。
      const m = { day: 'd', week: 'w', month: 'm', year: 'y' };
      return `df=${m[window]}`;
    }
    case 'baidu': {
      // 百度时间过滤:gpc=stf=<startSec>,<endSec>|stftype=2(URL 编码)。
      const endSec = Math.floor(now / 1000);
      const startSec = Math.floor((now - days * DAY_MS) / 1000);
      return `gpc=${encodeURIComponent(`stf=${startSec},${endSec}|stftype=2`)}`;
    }
    case 'bing-cn': {
      // Bing 的时间区间:qft=interval="7|8|9"(24h / 周 / 月)。年无干净取值则不限。
      const m = { day: '7', week: '8', month: '9' };
      return m[window] ? `qft=${encodeURIComponent(`interval="${m[window]}"`)}` : '';
    }
    case 'sogou': {
      // 搜狗时间过滤 tsn=1|2|3|4 → 日/周/月/年。
      const m = { day: '1', week: '2', month: '3', year: '4' };
      return `tsn=${m[window]}`;
    }
    case 'so360':
      // 360 时间参数不稳定,留空,靠结果重排兜底。
      return '';
    case 'kiro':
      // Kiro/MCP:用博查式枚举作为 arguments.freshness(见 webSearchService 调用处)。
      return '';
    default:
      return '';
  }
}

/** 博查式 freshness 枚举(供 MCP arguments 用):day→oneDay 等。 */
function windowToBochaFreshness(window) {
  const m = { day: 'oneDay', week: 'oneWeek', month: 'oneMonth', year: 'oneYear' };
  return m[window] || 'noLimit';
}

// ── 3. 结果日期解析 + 按时间重排 ─────────────────────────────────────
const ZH_MONTH = '01';
const EN_MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * 从一段文本(标题/摘要/已有 publishedDate)解析出一个时间戳(毫秒)。
 * 支持中文相对(N小时前/N天前/昨天/今天)、英文相对(N days ago)、绝对
 * (YYYY-MM-DD、YYYY/MM/DD、YYYY年MM月DD日、Mon DD, YYYY、DD Mon YYYY)。
 * 解析不出 → null。now 注入以保持确定性。
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {number|null}
 */
function parseResultDate(text, nowMs) {
  const s = String(text || '');
  if (!s) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // 相对(中文)
  let m = s.match(/(\d+)\s*分钟前/);
  if (m) return now - parseInt(m[1], 10) * 60 * SEC;
  m = s.match(/(\d+)\s*小时前/);
  if (m) return now - parseInt(m[1], 10) * 60 * 60 * SEC;
  m = s.match(/(\d+)\s*天前/);
  if (m) return now - parseInt(m[1], 10) * DAY_MS;
  if (/前天/.test(s)) return now - 2 * DAY_MS;
  if (/昨天/.test(s)) return now - DAY_MS;
  if (/(今天|今日|刚刚|刚才)/.test(s)) return now;

  // 相对(英文)e.g. "3 days ago", "an hour ago"
  m = s.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const mult = { minute: 60 * SEC, hour: 60 * 60 * SEC, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS, year: 365 * DAY_MS };
    return now - n * (mult[unit] || DAY_MS);
  }

  // 绝对:YYYY-MM-DD / YYYY/MM/DD
  m = s.match(/(20\d{2})[-/](\d{1,2})[-/](\d{1,2})/);
  if (m) return _ymd(m[1], m[2], m[3]);

  // 绝对:YYYY年MM月DD日(日可缺省)
  m = s.match(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})?\s*日?/);
  if (m) return _ymd(m[1], m[2], m[3] || '1');

  // 绝对:Mon DD, YYYY  e.g. "Jun 20, 2026"
  m = s.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/);
  if (m && EN_MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) {
    return _ymd(m[3], EN_MONTHS[m[1].slice(0, 3).toLowerCase()] + 1, m[2]);
  }
  // 绝对:DD Mon YYYY  e.g. "20 Jun 2026"
  m = s.match(/\b(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(20\d{2})\b/);
  if (m && EN_MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) {
    return _ymd(m[3], EN_MONTHS[m[2].slice(0, 3).toLowerCase()] + 1, m[1]);
  }
  return null;
}

function _ymd(y, mo, d) {
  const yi = parseInt(y, 10);
  const mi = parseInt(mo, 10);
  const di = parseInt(d, 10);
  if (!yi || !mi || mi < 1 || mi > 12 || di < 1 || di > 31) return null;
  // 用 UTC 构造,避免时区漂移影响确定性测试。
  const t = Date.UTC(yi, mi - 1, di);
  return Number.isFinite(t) ? t : null;
}

/** 时间戳 → YYYY-MM-DD(UTC),用于回填 publishedDate。 */
function _fmtYmd(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${d.getUTCFullYear()}-${mm}-${dd}`;
}

/**
 * 「按日期排序」的兜底层:给结果解析日期、回填空的 publishedDate,并在窗口生效时
 * 把窗口内的新结果稳定地顶到前面。绝不丢结果(过期的下沉但保留,保召回)。
 *   - 窗口内(dated 且 ts >= now-window):按 ts 倒序(新在前)
 *   - 无日期:保持原有相对顺序(放在窗口内之后)
 *   - 过期(dated 且 ts < cutoff):放最后,按 ts 倒序
 * window 为空时只回填 publishedDate,不重排。
 * 返回新数组(浅拷贝每个元素),不改入参。
 * @param {Array} results
 * @param {string|null} window
 * @param {number} [nowMs]
 * @param {object} [env]
 */
function applyRecencyRanking(results, window, nowMs, env) {
  if (!Array.isArray(results) || results.length === 0) return Array.isArray(results) ? results.slice() : [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();

  // 先做日期富化(即便不重排也回填 publishedDate)。
  const enriched = results.map((r, i) => {
    const copy = { ...r };
    let ts = parseResultDate(copy.publishedDate, now);
    if (ts == null) ts = parseResultDate(`${copy.title || ''} ${copy.snippet || ''}`, now);
    if (ts != null) {
      copy._freshTs = ts;
      if (!copy.publishedDate) copy.publishedDate = _fmtYmd(ts);
    } else {
      copy._freshTs = null;
    }
    copy._origIdx = i;
    return copy;
  });

  if (!window || !WINDOW_DAYS[window] || !isRerankEnabled(env)) {
    // 不重排:去掉内部辅助字段后原序返回。
    return enriched.map(({ _freshTs, _origIdx, ...rest }) => rest);
  }

  const cutoff = now - WINDOW_DAYS[window] * DAY_MS;
  const inWindow = [];
  const undated = [];
  const stale = [];
  for (const r of enriched) {
    if (r._freshTs == null) undated.push(r);
    else if (r._freshTs >= cutoff) inWindow.push(r);
    else stale.push(r);
  }
  // 稳定排序:同 ts 时按原序(_origIdx)保持确定性。
  inWindow.sort((a, b) => (b._freshTs - a._freshTs) || (a._origIdx - b._origIdx));
  stale.sort((a, b) => (b._freshTs - a._freshTs) || (a._origIdx - b._origIdx));
  const ordered = [...inWindow, ...undated, ...stale];
  return ordered.map(({ _freshTs, _origIdx, ...rest }) => rest);
}

module.exports = {
  WINDOW_DAYS,
  WINDOW_ORDER,
  isEnabled,
  isRerankEnabled,
  detectFreshness,
  normalizeWindow,
  resolveWindow,
  freshnessToEngineParam,
  windowToBochaFreshness,
  parseResultDate,
  applyRecencyRanking,
};
