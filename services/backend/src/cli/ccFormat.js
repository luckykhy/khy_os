'use strict';

/**
 * ccFormat — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 「对齐 Claude Code 不只是显示对齐,更要让 CC 前端显示背后的**后端逻辑**对齐。」
 * CC 屏幕上的「回合时长 / token 计数」并不是临时拼的字符串,它背后是 CC 源码
 * `src/utils/format.ts` 里两个纯格式化函数 `formatDuration` / `formatTokens`。
 * 本叶子把这两个函数**逐字节忠实移植**过来,作为 Khy 一切「ms → 时长串 /
 * token 数 → 紧凑串」渲染的**单一真源**——这样 Khy 屏幕上看到的数字,就是 CC
 * 用**同一套算法**算出来的,而不是另写一套近似口径(那正是「显示对齐但后端逻辑没对齐」)。
 *
 * 对齐基准(CC 源 src/utils/format.ts,逐分支移植):
 *   formatDuration(ms):
 *     ms===0            → "0s"
 *     ms<1             → `${(ms/1000).toFixed(1)}s`
 *     ms<60000          → `${Math.floor(ms/1000)}s`        (注意:CC 用 floor,不是 round)
 *     ms≥60000          → 进位后 "Hh Mm Ss" / "Mm Ss"      (注意:CC 用空格分隔,分钟档保留 0 秒 "1m 0s")
 *     options.mostSignificantOnly / hideTrailingZeros 同 CC 语义。
 *   formatNumber(n):  Intl 紧凑记数(en-US, notation:compact, maxFrac 1, n≥1000 时 minFrac 1)→ 小写。
 *   formatTokens(n):  formatNumber(n).replace('.0','')  → "1.2k" / "1k" / "999" / "123.5k"。
 *
 * 门控:KHY_CC_FORMAT(默认开)。=0/false/off/no → 关。本叶子不自查门控来改算法
 * (移植就是忠实的),门控由**调用方**(thinkingDuration / turnStats)用来决定
 * 走 CC 口径还是逐字节回退到各自的 legacy 口径。
 */

function ccFormatEnabled(env = process.env) {
  const flag = String((env && env.KHY_CC_FORMAT) || '').trim().toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

/**
 * CC `formatDuration` 的忠实移植(src/utils/format.ts)。
 * @param {number} ms
 * @param {{hideTrailingZeros?:boolean, mostSignificantOnly?:boolean}} [options]
 * @returns {string}  非有限输入 → ''(绝不抛)。
 */
function ccFormatDuration(ms, options) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return '';
  if (n < 60000) {
    if (n === 0) return '0s';
    if (n < 1) return `${(n / 1000).toFixed(1)}s`;
    return `${Math.floor(n / 1000)}s`;
  }

  let days = Math.floor(n / 86400000);
  let hours = Math.floor((n % 86400000) / 3600000);
  let minutes = Math.floor((n % 3600000) / 60000);
  let seconds = Math.round((n % 60000) / 1000);

  // 进位(CC 同:59.5s round → 60s 须进位到分钟)
  if (seconds === 60) { seconds = 0; minutes++; }
  if (minutes === 60) { minutes = 0; hours++; }
  if (hours === 24) { hours = 0; days++; }

  const hide = options && options.hideTrailingZeros;

  if (options && options.mostSignificantOnly) {
    if (days > 0) return `${days}d`;
    if (hours > 0) return `${hours}h`;
    if (minutes > 0) return `${minutes}m`;
    return `${seconds}s`;
  }

  if (days > 0) {
    if (hide && hours === 0 && minutes === 0) return `${days}d`;
    if (hide && minutes === 0) return `${days}d ${hours}h`;
    return `${days}d ${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    if (hide && minutes === 0 && seconds === 0) return `${hours}h`;
    if (hide && seconds === 0) return `${hours}h ${minutes}m`;
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    if (hide && seconds === 0) return `${minutes}m`;
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * 门控包装:KHY_CC_FORMAT 开且能算出 → 返回 CC `formatDuration` 的人读时长
 * ("5m 0s" / "1h 0m 0s" / "2s");关 / 非有限 → 返回调用方传入的 `legacy`
 * (逐字节回退到各自旧口径,如裸 `${toFixed(0)}s`)。
 *
 * 镜像同模块 `ccFormatTokensOr`/`ccFormatCostOr` 的「门控 + call-site legacy」约定,
 * 供把裸秒数嵌进更大字符串的渲染处(会话时长、任务耗时)统一走 SSOT,而不必各自
 * 内联 `if (ccFormatEnabled(env)) ...` 分支。任何前后缀(如运行中的 `...`)由调用方
 * 在 `*Or` 外拼接,保证门控关时逐字节等于历史输出。
 * @param {number} ms
 * @param {string} legacy
 * @param {object} [env]
 * @param {{hideTrailingZeros?:boolean, mostSignificantOnly?:boolean}} [options]
 * @returns {string}
 */
function ccFormatDurationOr(ms, legacy, env, options) {
  if (!ccFormatEnabled(env)) return legacy;
  const out = ccFormatDuration(ms, options);
  return out || legacy;
}

// `new Intl.NumberFormat` 构造昂贵 → 缓存(与 CC 同策略)。纯记忆化,确定性不变。
let _fmtConsistent = null;
let _fmtInconsistent = null;
function _numberFormatter(consistent) {
  if (consistent) {
    if (!_fmtConsistent) {
      _fmtConsistent = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 1 });
    }
    return _fmtConsistent;
  }
  if (!_fmtInconsistent) {
    _fmtInconsistent = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 0 });
  }
  return _fmtInconsistent;
}

/**
 * CC `formatNumber` 的忠实移植:Intl 紧凑记数 + 小写。
 * @param {number} number
 * @returns {string}  非有限输入 → ''。Intl 异常 → 整数兜底(绝不抛)。
 */
function ccFormatNumber(number) {
  const v = Number(number);
  if (!Number.isFinite(v)) return '';
  try {
    return _numberFormatter(v >= 1000).format(v).toLowerCase();
  } catch {
    return String(Math.round(v));
  }
}

/**
 * CC `formatTokens` 的忠实移植:紧凑数去掉尾随 ".0"。
 * @param {number} count
 * @returns {string}
 */
function ccFormatTokens(count) {
  return ccFormatNumber(count).replace('.0', '');
}

/**
 * `ccFormatTokens` 的「门控 + call-site legacy」包装(镜像 `ccFormatCostOr`/
 * `ccBriefTimestampOr` 同模块约定),供把裸 token 数字嵌进更大字符串的渲染处
 * (如 `/context`/`/status` 面板的 `↑${x}k ↓${y}k`、`${used}k / ${limit}k`)收敛。
 * 门控开 → `ccFormatTokens(count)`(非有限 → '' → 回退 legacy);门控关 → 原样
 * 返回 call-site 传入的 legacy(逐字节回退;各 call-site 各传自己的 `.toFixed(1)k`/
 * `.toFixed(0)k` 历史规则,绝不串味)。
 *
 * @param {number} count  token 数。
 * @param {string} legacy call-site 历史格式串(门控关 / 非有限时返回)。
 * @param {object} [env]  环境变量(仅读门控)。
 * @returns {string}
 */
function ccFormatTokensOr(count, legacy, env = process.env) {
  if (!ccFormatEnabled(env)) return legacy;
  const out = ccFormatTokens(count);
  return out || legacy;
}

/**
 * CC `formatFileSize` 的忠实移植(src/utils/format.ts:9):
 *   kb = bytes/1024
 *   kb<1     → `${bytes} bytes`
 *   kb<1024  → `${kb.toFixed(1).replace(/\.0$/,'')}KB`   (无空格·去尾随 .0)
 *   mb<1024  → `${mb…}MB`
 *   else     → `${gb…}GB`
 * 这是 Khy 各处「字节数 → 人类可读」散落本地格式器(`(b/1024).toFixed(1)KB`
 * 恒显 KB、小文件塌成 "0.0KB"、无 MB/GB 进位)应收敛到的单一真源——与
 * formatDuration / formatTokens 同属 CC `format.ts`,补齐本族最后一类「数 → 串」。
 * @param {number} sizeInBytes
 * @returns {string}  非有限/负输入 → ''(绝不抛)。
 */
function ccFormatFileSize(sizeInBytes) {
  const n = Number(sizeInBytes);
  if (!Number.isFinite(n) || n < 0) return '';
  const kb = n / 1024;
  if (kb < 1) return `${n} bytes`;
  if (kb < 1024) return `${kb.toFixed(1).replace(/\.0$/, '')}KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1).replace(/\.0$/, '')}MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(1).replace(/\.0$/, '')}GB`;
}

// CC `formatRelativeTime`(src/utils/format.ts:144)的区间表 + 取整规则。
// CC 的核心后端逻辑不是「显示哪种语言的『X 分钟前』」,而是:
//   ① 用 **Math.trunc**(向零截断,绝不进位)算落在哪个区间、值是几——
//      你「用满了 N 个整单位」才显示 N,而不是「快到 N+1 了」就 round 上去;
//   ② 区间表是完整的 year→second 七档(标准日历阈值:day=24h、week=7d、month≈30d)。
// Khy 各处「多久以前」散落各写:resumeAdvisor 用 **Math.round**(把 23h59m 报成
// 「1 天前」、把 90s 报成「2 分钟前」=向上虚报),session.js 用 floor(截断对了)
// 但缺 week/month/year 档。本函数把 CC 这套**算法**收敛成单一真源,只返回结构化
// `{value, unit, isPast}`——**不**拼任何语言串,让各调用方保留自己的本地化
// (resumeAdvisor 中文「分钟前」、session.js 英文「m ago」),从而对齐的是 CC
// 显示背后的**后端逻辑**而非强行换成英文。
const _REL_INTERVALS = [
  { unit: 'year', seconds: 31536000 },
  { unit: 'month', seconds: 2592000 },
  { unit: 'week', seconds: 604800 },
  { unit: 'day', seconds: 86400 },
  { unit: 'hour', seconds: 3600 },
  { unit: 'minute', seconds: 60 },
  { unit: 'second', seconds: 1 },
];

/**
 * CC `formatRelativeTime` 的区间选择 + 截断逻辑(结构化、不本地化)。
 * @param {number} ageMs  距今的毫秒差,= now - timestamp(过去为正、未来为负)。
 * @returns {{value:number, unit:string, isPast:boolean}|null}
 *   value 已按 CC 的 **Math.trunc** 截断(绝不进位);unit ∈ year/month/week/day/hour/minute/second;
 *   isPast = ageMs >= 0。<1s → {value:0, unit:'second', isPast}。非有限 → null(绝不抛)。
 */
function ccRelativeAgeParts(ageMs) {
  const n = Number(ageMs);
  if (!Number.isFinite(n)) return null;
  const isPast = n >= 0;
  // CC: diffInSeconds = Math.trunc(diffInMs / 1000);区间值同样 Math.trunc。
  const absSeconds = Math.abs(Math.trunc(n / 1000));
  for (const { unit, seconds } of _REL_INTERVALS) {
    if (absSeconds >= seconds) {
      return { value: Math.trunc(absSeconds / seconds), unit, isPast };
    }
  }
  return { value: 0, unit: 'second', isPast };
}

// ── CC formatBriefTimestamp:按龄缩放细节的「绝对时间戳」(消息标签风) ──────────
// CC src/utils/formatBriefTimestamp.ts:同日 → 仅时间;6 日内 → 周几+时间;更久 →
// 周几+月日+时间。关键后端逻辑:档位由 **startOfDay 的「日历日差」**(`Math.round`)决定,
// **不是**流逝毫秒——所以「昨天 23:00」与「今天 01:00」相差 2h 却跨日 → 显周几而非仅时间。
// 与 ccRelativeAgeParts(流逝「N 前」)正交:那是相对龄,这是按龄缩放的绝对戳。

// 本地午夜(与 CC startOfDay 同口径:取运行时本地时区当日 0 点)。
function _startOfDayLocalMs(ms) {
  const d = new Date(Number(ms));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * CC formatBriefTimestamp 的**档位判定**(纯、确定性,不本地化)。
 * @param {number} targetMs  目标时间戳毫秒。
 * @param {number} nowMs     现在时间戳毫秒(注入,绝不读环境时钟 → 保持叶子确定性)。
 * @returns {'time'|'weekday'|'full'|null}
 *   同日 → 'time';未来日 / >6 日前 → 'full';其间(1..6 日前)→ 'weekday'。非有限 → null。
 */
function ccBriefTimestampScale(targetMs, nowMs) {
  const t = Number(targetMs);
  const n = Number(nowMs);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  // CC: daysAgo = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  const daysAgo = Math.round((_startOfDayLocalMs(n) - _startOfDayLocalMs(t)) / 86400000);
  if (daysAgo === 0) return 'time';
  if (daysAgo > 0 && daysAgo < 7) return 'weekday';
  return 'full'; // 未来(daysAgo<0)或 ≥7 日前,均落 CC 的最末 return(周几+月日+时间)。
}

// CC 各档的 Intl 选项集(逐字对应 formatBriefTimestamp 的三组 options)。
const _BRIEF_OPTS = {
  time: { hour: 'numeric', minute: '2-digit' },
  weekday: { weekday: 'long', hour: 'numeric', minute: '2-digit' },
  full: { weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' },
};

/**
 * CC formatBriefTimestamp 的渲染(档位 → 本地化串)。locale 默认 'zh-CN'(Khy 是中文 CLI,
 * 与 localBrainService 的 'zh-CN' 一致);CC 自身按 LC_ALL/LC_TIME/LANG 推 BCP47,这里刻意固定 zh-CN
 * 只对齐**按龄缩放细节**这一后端逻辑,不引 CC 的 POSIX-locale 推导(那是另一层、且需 env 读取)。
 * @returns {string}  非有限 / toLocaleString 抛 → ''(绝不抛)。
 */
function ccBriefTimestamp(targetMs, nowMs, locale = 'zh-CN') {
  const scale = ccBriefTimestampScale(targetMs, nowMs);
  if (!scale) return '';
  try {
    return new Date(Number(targetMs)).toLocaleString(locale, _BRIEF_OPTS[scale]);
  } catch {
    return '';
  }
}

/**
 * 门控包装:KHY_CC_FORMAT(经 ccFormatEnabled)开且能算出 → 返回 CC 按龄缩放戳;
 * 关 / 非有限 / 渲染空 → 返回调用方传入的 `legacy` 串(逐字节回退)。
 * @param {number} targetMs
 * @param {number} nowMs
 * @param {string} legacy   门控关 / 兜底时原样返回的旧串(调用方自己的 toLocaleTimeString())。
 * @param {object} [env]
 */
function ccBriefTimestampOr(targetMs, nowMs, legacy, env) {
  if (!ccFormatEnabled(env)) return legacy;
  const out = ccBriefTimestamp(targetMs, nowMs);
  return out || legacy;
}

// ── CC formatResetTime:配额「重置时刻」按剩余时长缩放的绝对戳 ─────────────────
// CC src/utils/format.ts:formatResetTime(timestampInSeconds, showTimezone, showTime)。
// 与 ccBriefTimestamp(按「日历日龄」缩放消息标签)正交:此函数按**距重置还有多久**
// 缩放。CC 的后端逻辑三条:
//   ① 距重置 >24h → 显「月日 + 时间」;≤24h → 仅显时间(近在眼前无需报日期);
//   ② 分钟为 0 → 省略分钟位(整点只显小时,减噪);
//   ③ 目标年 ≠ 今年 → 补年份(仅跨年重置才显年)。
// 背后动机:配额/速率限制的 reset 通常就在本小时内,"15:47" 远比裸 ISO
// "2026-07-01 15:47:00 UTC" 可读;只有极远的 reset 才需要日期/年份。
// Khy 现状:forge.js 的 GitHub API 速率限制把 core.reset(unix 秒)渲染成裸
// ISO-UTC 串(既非本地时刻、又永远带满年月日时分秒)→ 本族收敛为 CC 口径。
//
// 与 CC 刻意差异(同 ccBriefTimestamp 的取舍):locale 默认 'zh-CN'(Khy 中文 CLI),
// 故走 24 小时制、无 am/pm——CC 的 en-US 12 小时 + am/pm 小写化是**本地化表层**,
// 非后端逻辑。am/pm 小写 strip 仍逐字移植(对 zh-CN 是 no-op,对显式传入 en-US
// 的 call-site 才生效),保持可复用。时区标签(CC showTimezone → getTimeZone())由
// call-site 经 opts.timezoneLabel 显式传入,叶子**不读 env、不算 getTimeZone**(保持纯)。

/**
 * CC formatResetTime 的**档位判定**(纯、确定性,不本地化)。
 * @param {number} targetMs  重置时刻毫秒。
 * @param {number} nowMs     现在毫秒(注入,绝不读环境时钟 → 保持叶子确定性)。
 * @returns {'datetime'|'time'|null}
 *   距重置 >24h → 'datetime'(补月日);≤24h → 'time'(仅时间)。非有限 → null。
 */
function ccResetTimeScale(targetMs, nowMs) {
  const t = Number(targetMs);
  const n = Number(nowMs);
  if (!Number.isFinite(t) || !Number.isFinite(n)) return null;
  // CC: hoursUntilReset = (date.getTime() - now.getTime()) / (1000*60*60);>24h → 补日期。
  return (t - n) / 3600000 > 24 ? 'datetime' : 'time';
}

/**
 * CC formatResetTime 的渲染(档位 → 本地化串)。
 * @param {number} targetMs  重置时刻毫秒(family 惯例取 ms;`*Or` 包装接 unix 秒)。
 * @param {number} nowMs     现在毫秒。
 * @param {{showTime?:boolean, locale?:string, timezoneLabel?:string}} [opts]
 *   showTime=false → 只显月日不显时间(CC 的 showTime=false 分支);locale 默认 'zh-CN';
 *   timezoneLabel 存在 → 末尾追加 ` (label)`(对齐 CC showTimezone,标签由 call-site 传)。
 * @returns {string}  非有限 / toLocaleString 抛 → ''(绝不抛)。
 */
function ccFormatResetTime(targetMs, nowMs, opts) {
  const scale = ccResetTimeScale(targetMs, nowMs);
  if (!scale) return '';
  try {
    const date = new Date(Number(targetMs));
    const now = new Date(Number(nowMs));
    const minutes = date.getMinutes();
    const showTime = !opts || opts.showTime !== false;
    const locale = (opts && opts.locale) || 'zh-CN';
    const tzLabel = opts && opts.timezoneLabel ? ` (${opts.timezoneLabel})` : '';

    let out;
    if (scale === 'datetime') {
      // CC datetime 分支的 options(逐字对应):月日 + 可选时分 + 跨年补年。
      const o = {
        month: 'short',
        day: 'numeric',
        hour: showTime ? 'numeric' : undefined,
        minute: !showTime || minutes === 0 ? undefined : '2-digit',
      };
      if (date.getFullYear() !== now.getFullYear()) o.year = 'numeric';
      out = date.toLocaleString(locale, o);
    } else {
      // CC time-only 分支:仅时分,整点省分钟。
      out = date.toLocaleTimeString(locale, {
        hour: 'numeric',
        minute: minutes === 0 ? undefined : '2-digit',
      });
    }
    // CC: 去掉 am/pm 前空格并小写(zh-CN 无 am/pm → no-op;en-US call-site 才生效)。
    return out.replace(/ ([AP]M)/i, (_m, ap) => ap.toLowerCase()) + tzLabel;
  } catch {
    return '';
  }
}

/**
 * 门控 + call-site legacy 包装。**入参是 unix 秒**(对齐 CC formatResetTime 与
 * GitHub API `core.reset` 口径),内部 ×1000 转 ms 交核心函数。
 * 门控关 / 非有限秒 / sec<=0 / 渲染空 → 返回调用方 `legacy`(逐字节回退到旧 ISO-UTC)。
 * @param {number} targetSeconds  unix 秒。
 * @param {number} nowMs          现在毫秒(call-site 传 Date.now())。
 * @param {string} legacy         门控关 / 兜底原样返回的旧串。
 * @param {object} [env]
 * @param {object} [opts]         透传 ccFormatResetTime 的 opts。
 * @returns {string}
 */
function ccFormatResetTimeOr(targetSeconds, nowMs, legacy, env, opts) {
  if (!ccFormatEnabled(env)) return legacy;
  const sec = Number(targetSeconds);
  if (!Number.isFinite(sec) || sec <= 0) return legacy;
  const out = ccFormatResetTime(sec * 1000, nowMs, opts);
  return out || legacy;
}

// CC `round` 辅助(src/cost-tracker.ts:247):确定性「乘精度→四舍五入→除回」。
function _round(number, precision) {
  return Math.round(number * precision) / precision;
}

/**
 * CC `formatCost` 的忠实移植(src/cost-tracker.ts:178):**幅度自适应精度**。
 *   cost > 0.5 → round(cost,100).toFixed(2)        (大额 → 2 位/角分精度)
 *   cost ≤ 0.5 → cost.toFixed(maxDecimalPlaces)     (微额 → 默认 4 位,保留亚分可读)
 * 关键后端逻辑 = 一个 **0.5 阈值**按金额大小切换显示精度:大额显 2 位、微额显 4 位
 * (4 位防止把 ¥0.005 这类亚分成本四舍五入塌成 0)。CC 是 `formatTotalCost /
 * formatModelUsage / BuiltinStatusLine` 的**唯一**成本格式化 SSOT;Khy 此前三处
 * 各写一套精度(hudRenderer 状态行 0.01 阈值、HUD 面板硬编码 toFixed(4)/toFixed(2)、
 * router /cost 硬编码 toFixed(4))→ 本函数收敛为同一 CC 口径。
 *
 * 与 CC 唯一刻意差异:**不带货币符号**(返回纯数字串),由调用方决定 $ / ¥
 * ——与本族 ccFormatTokens(不带 " tokens")同惯例。Khy 是 CNY CLI,各调用方
 * 显示 ¥(USD×7.25),阈值即作用在所显示的 ¥ 值上(= CC $0.5 在 CNY 下的本地
 * 等价 ¥0.5;round-to-cents + 自适应精度算法逐字节忠实)。
 * @param {number} cost
 * @param {number} [maxDecimalPlaces=4]
 * @returns {string}  非有限 / 负 → ''(绝不抛;调用方均已 gate `>0`)。
 */
function ccFormatCost(cost, maxDecimalPlaces = 4) {
  if (cost == null) return '';
  const n = Number(cost);
  if (!Number.isFinite(n) || n < 0) return '';
  const mdpRaw = Number(maxDecimalPlaces);
  const mdp = Number.isFinite(mdpRaw) && mdpRaw >= 0 ? mdpRaw : 4;
  return n > 0.5 ? _round(n, 100).toFixed(2) : n.toFixed(mdp);
}

/**
 * 门控包装:KHY_CC_FORMAT 开且能算出 → 返回 CC 幅度自适应精度的纯数字串(无符号);
 * 关 / 非有限 → 返回调用方传入的 `legacy`(逐字节回退到各自旧 toFixed 口径)。
 * 货币符号(¥)仍由调用方在外拼接,保证门控关时与历史输出逐字节一致。
 * @param {number} cost
 * @param {string} legacy
 * @param {object} [env]
 * @param {number} [maxDecimalPlaces=4]
 */
function ccFormatCostOr(cost, legacy, env, maxDecimalPlaces = 4) {
  if (!ccFormatEnabled(env)) return legacy;
  const out = ccFormatCost(cost, maxDecimalPlaces);
  return out || legacy;
}

module.exports = {
  ccFormatEnabled,
  ccFormatDuration,
  ccFormatDurationOr,
  ccFormatNumber,
  ccFormatTokens,
  ccFormatTokensOr,
  ccFormatFileSize,
  ccRelativeAgeParts,
  ccBriefTimestampScale,
  ccBriefTimestamp,
  ccBriefTimestampOr,
  ccResetTimeScale,
  ccFormatResetTime,
  ccFormatResetTimeOr,
  ccFormatCost,
  ccFormatCostOr,
};
