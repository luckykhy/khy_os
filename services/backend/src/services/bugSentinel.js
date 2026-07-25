'use strict';

/**
 * bugSentinel.js — 让 bug「越早暴露越好」,并把 bug 处置从「被动响应」升级为
 * 「主动监听发现 + 被动兜底」(单一真源,纯叶子)。
 *
 * 背景(goal 2026-06-25):本仓库为了不让诊断/可选增强搞崩主流程,广泛使用 fail-soft
 * 的 `catch {}`(src 下 100+ 处空 catch)。代价是:真正的 bug 在这些静默吞咽点凭空
 * 消失,直到顺流污染成更难诊断的次生故障才被「被动」发现。同时已有的 selfHeal /
 * resilience / failsafe / evoEngine 都是 REACTIVE —— 失败浮现后才动作,没有一处把
 * 「被吞掉的错误 + 内部不变量违反」汇成可被主动监听的早期信号。
 *
 * 本模块补这两个缺口:
 *
 *  A) invariant(cond, code, detail) —— 让 bug「越早暴露」。
 *     内部状态出现「绝不该发生」时:
 *       - strict 模式(测试/CI,或显式开启):立刻抛 BugSentinelError →
 *         bug 在最早的边界炸出来,而不是被下游掩盖。
 *       - observe 模式(生产默认):记录 + 计入主动监听,但**不抛**(被动兜底,
 *         诊断本身绝不让主流程崩溃)。
 *
 *  B) tripwire(err, context) —— 把「静默吞咽」变成「可观测信号」。
 *     全代码库的 fail-soft `catch` 把被吞掉的错误交到这里登记(而非凭空消失)。
 *     配一个**保守阈值的滑动窗口**:同一 code 在窗口内复发/速率越界 → 主动发出
 *     早期预警(主动监听发现),供 doctor / health / loop 读出。健康会话里偶发的
 *     单次吞咽永不告警(零误报)。
 *
 * 纯叶子:有界环形缓冲、零 IO、默认绝不抛(strict 仅在显式开启或测试环境);时钟可注入
 * 以便确定性单测。
 *
 * env:
 *   KHY_BUG_SENTINEL = off | observe | strict
 *     off      整体关闭:invariant 退化为透传布尔、tripwire 不记录、不告警。
 *     observe  (生产默认)记录 + 主动滑窗预警,但 invariant 不抛(被动兜底)。
 *     strict   invariant 违反立刻抛(越早暴露);测试环境(NODE_ENV==='test')默认 strict。
 *   KHY_BUG_SENTINEL_WINDOW_MS   滑窗宽度(默认 60000)。
 *   KHY_BUG_SENTINEL_THRESHOLD   同一 code 在窗口内的预警阈值(默认 5)。
 *
 * 用法(给 fail-soft catch 的标准改造):
 *   try { optionalThing(); }
 *   catch (e) { require('./bugSentinel').tripwire(e, { code: 'loop.optionalThing' }); }
 */

const MAX_RECORDS = 200;       // 主环形缓冲上限(drop-oldest)
const MAX_ANOMALIES = 50;      // 已触发预警保留上限
const DEFAULT_WINDOW_MS = 60000;
const DEFAULT_THRESHOLD = 5;

// ── 可注入时钟(默认 Date.now;测试用 __setClock 注入,确定性滑窗) ──
let _clock = () => Date.now();
function __setClock(fn) { _clock = typeof fn === 'function' ? fn : (() => Date.now()); }

// ── 进程内状态(单一真源) ──
const _records = [];                 // {kind:'invariant'|'swallowed', code, detail, at}
const _anomalies = [];               // {code, count, windowMs, firstSeen, lastSeen, sample, at}
const _byCode = new Map();           // code -> { count, times: number[] (窗口内时间戳) }
const _activeAnomalyCodes = new Set();// 已处于「越阈值」态的 code,避免每条都重复告警
const _listeners = new Set();        // onAnomaly 订阅者
let _totalSwallowed = 0;
let _totalBreaches = 0;

class BugSentinelError extends Error {
  constructor(code, detail) {
    super(`[invariant] ${code}${detail ? `: ${detail}` : ''}`);
    this.name = 'BugSentinelError';
    this.code = code;
    this.isBugSentinel = true;
  }
}

function mode(env = process.env) {
  const raw = env && env.KHY_BUG_SENTINEL;
  if (raw === 'off' || raw === '0' || raw === 'false') return 'off';
  if (raw === 'strict') return 'strict';
  if (raw === 'observe' || raw === 'on' || raw === '1') return 'observe';
  // 未显式设置:测试环境默认 strict(让 CI 在最早边界炸出 bug),否则 observe。
  if (env && env.NODE_ENV === 'test') return 'strict';
  return 'observe';
}

function isEnabled(env = process.env) { return mode(env) !== 'off'; }
function isStrict(env = process.env) { return mode(env) === 'strict'; }

function _windowMs(env = process.env) {
  const v = Number(env && env.KHY_BUG_SENTINEL_WINDOW_MS);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_WINDOW_MS;
}
function _threshold(env = process.env) {
  const v = Number(env && env.KHY_BUG_SENTINEL_THRESHOLD);
  return Number.isFinite(v) && v >= 2 ? Math.floor(v) : DEFAULT_THRESHOLD;
}

function _safeStr(x, max = 240) {
  let s;
  if (x == null) s = '';
  else if (typeof x === 'string') s = x;
  else if (x instanceof Error) s = x.message || String(x);
  else { try { s = JSON.stringify(x); } catch { s = String(x); } }
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function _codeFromError(err) {
  if (!err) return 'swallowed';
  if (err.code && typeof err.code === 'string') return `err.${err.code}`;
  if (err.name && err.name !== 'Error') return `err.${err.name}`;
  return 'swallowed';
}

// 主动监听发现:阈值越界的瞬间,除通知订阅者外,还经 Node 警告通道**主动**推一条预警
// (CI / 日志 / 守护进程都能捕获,且绝不让进程崩溃)。已由 active-set 去重 → 每个越阈值期
// 仅一条。env KHY_BUG_SENTINEL_ACTIVE=off 可静默(仍保留 snapshot 的被动可拉取)。
function _activeAnnounceEnabled(env) {
  const v = env && env.KHY_BUG_SENTINEL_ACTIVE;
  return v !== 'off' && v !== '0' && v !== 'false';
}
function _activeAnnounce(anomaly, env) {
  if (!_activeAnnounceEnabled(env)) return;
  try {
    process.emitWarning(
      `code "${anomaly.code}" recurred ${anomaly.count}× within ${Math.round(anomaly.windowMs / 1000)}s — possible hidden bug surfacing early`,
      { type: 'BugSentinelAnomaly', code: 'KHY_BUG_SENTINEL_ANOMALY' },
    );
  } catch { /* 主动通道 fail-soft:绝不反噬 */ }
}

function _emitAnomaly(anomaly, env) {
  _anomalies.push(anomaly);
  while (_anomalies.length > MAX_ANOMALIES) _anomalies.shift();
  for (const fn of _listeners) {
    try { fn(anomaly); } catch { /* listener fail-soft: 监听器自身绝不反噬哨兵 */ }
  }
  _activeAnnounce(anomaly, env);
}

/**
 * 核心登记:写入环形缓冲、滑窗计数,并在越过保守阈值时主动发预警(去重:同一 code
 * 在「越阈值」期间只发一次,回落到阈值下后可再次触发)。
 */
function _record(kind, code, detail, env) {
  const now = _clock();
  const c = code || 'unspecified';

  _records.push({ kind, code: c, detail: _safeStr(detail), at: now });
  while (_records.length > MAX_RECORDS) _records.shift();
  if (kind === 'swallowed') _totalSwallowed += 1;
  else if (kind === 'invariant') _totalBreaches += 1;

  const windowMs = _windowMs(env);
  const threshold = _threshold(env);
  let bucket = _byCode.get(c);
  if (!bucket) { bucket = { count: 0, times: [] }; _byCode.set(c, bucket); }
  bucket.count += 1;
  bucket.times.push(now);
  // 滑窗裁剪:只保留窗口内的时间戳。
  const cutoff = now - windowMs;
  while (bucket.times.length && bucket.times[0] < cutoff) bucket.times.shift();

  const inWindow = bucket.times.length;
  if (inWindow >= threshold && !_activeAnomalyCodes.has(c)) {
    _activeAnomalyCodes.add(c);
    _emitAnomaly({
      code: c,
      kind,
      count: inWindow,
      windowMs,
      threshold,
      firstSeen: bucket.times[0],
      lastSeen: now,
      sample: _safeStr(detail, 160),
      at: now,
    }, env);
  } else if (inWindow < threshold && _activeAnomalyCodes.has(c)) {
    _activeAnomalyCodes.delete(c); // 回落 → 重新武装
  }
}

/**
 * 不变量:cond 为真返回 true;为假则记一次违反。strict → 抛 BugSentinelError(越早暴露);
 * observe → 记录并返回 false(被动兜底,不抛)。off → 退化为纯布尔透传(零开销、不记录)。
 *
 * 用在「绝不该发生」的内部状态上(契约违反、不可达分支、解析后仍非法的结构)。
 */
function invariant(condition, code, detail, env = process.env) {
  const m = mode(env);
  if (m === 'off') return Boolean(condition);
  if (condition) return true;
  _record('invariant', code || 'invariant', detail, env);
  if (m === 'strict') throw new BugSentinelError(code || 'invariant', _safeStr(detail));
  return false;
}

/**
 * 静默吞咽登记:把 fail-soft catch 吞掉的错误变成可观测信号。绝不抛、绝不反噬调用点。
 * 返回登记记录(或 off 时 null)。
 */
function tripwire(error, context = {}, env = process.env) {
  try {
    if (mode(env) === 'off') return null;
    const code = (context && context.code) || _codeFromError(error);
    const detail = (context && context.detail) || (error && error.message) || _safeStr(error);
    _record('swallowed', code, detail, env);
    return { code, detail: _safeStr(detail) };
  } catch {
    return null; // 哨兵自身绝不抛
  }
}

/** 订阅主动预警(主动监听发现的出口)。返回取消订阅函数。 */
function onAnomaly(fn) {
  if (typeof fn !== 'function') return () => {};
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function offAnomaly(fn) { _listeners.delete(fn); }

/** 读出当前哨兵状态(供 loop 返回契约 / khy health / khy doctor 主动呈现)。 */
function snapshot(env = process.env) {
  const byCode = {};
  // 取计数前若干(确定性:按 count 降序,再按 code 字典序)。
  const entries = [..._byCode.entries()]
    .map(([code, b]) => [code, b.count])
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 12);
  for (const [code, count] of entries) byCode[code] = count;
  return {
    mode: mode(env),
    swallowed: _totalSwallowed,
    breaches: _totalBreaches,
    distinctCodes: _byCode.size,
    byCode,
    active: [..._activeAnomalyCodes],
    anomalies: _anomalies.slice(-10),
    window: { windowMs: _windowMs(env), threshold: _threshold(env) },
  };
}

/** 是否有需要主动呈现的内容(任一吞咽/违反/活跃预警)。 */
function hasSignal() {
  return _totalSwallowed > 0 || _totalBreaches > 0 || _activeAnomalyCodes.size > 0;
}

/** 清空(测试用,也供长驻进程周期性归零)。 */
function reset() {
  _records.length = 0;
  _anomalies.length = 0;
  _byCode.clear();
  _activeAnomalyCodes.clear();
  _totalSwallowed = 0;
  _totalBreaches = 0;
}

module.exports = {
  mode,
  isEnabled,
  isStrict,
  invariant,
  tripwire,
  onAnomaly,
  offAnomaly,
  snapshot,
  hasSignal,
  reset,
  BugSentinelError,
  __setClock,
  // 暴露给测试/调试的常量
  _DEFAULTS: { MAX_RECORDS, DEFAULT_WINDOW_MS, DEFAULT_THRESHOLD },
};
