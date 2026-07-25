'use strict';

/**
 * breakCache.js — 纯叶子(zero-IO,确定性):`/break-cache` 命令背后的全部纯逻辑。
 *
 * 对齐 Claude Code `/break-cache`(src/commands/break-cache/index.ts):Anthropic
 * 前缀提示缓存(`cache_control: ephemeral`)以**系统提示前缀的哈希**为键;往前缀里
 * 插一个唯一 nonce 即可让哈希失效,强制下一次(或每一次)API 调用重新计算上下文,
 * 用于「需要一个干净上下文窗口」的调试场景。
 *
 * khy 确实用前缀缓存:`services/gateway/adapters/claudeAdapter.js` 与
 * `services/multiFreeService.js` 都对静态前缀打 `cache_control: ephemeral`。所以本命令
 * **非空壳** —— 通过在系统提示最前面注入一行 nonce 注释来真正击穿缓存。
 *
 * 三态(对齐 CC):
 *   - once   :调度一次性击穿,下一次 API 调用注入 nonce 后**消费**(删除 marker)。
 *   - always :持久击穿,每次调用都注入 nonce(写 flag 文件)。
 *   - off    :清除 marker + flag。
 *
 * **背后逻辑**(scope 解析、nonce 注释构造、事件日志聚合、措辞)全在这里,确定性、
 * 零 IO、零业务 require —— now/rand 由薄壳 `services/gateway/breakCacheState.js` 注入,
 * 真正的文件读写/marker 消费是副作用,留在薄壳。
 *
 * 门控 KHY_BREAK_CACHE 默认开;关 → 命令不接管 + 消费侧绝不注入 nonce(字节回退)。
 */

function isEnabled(env) {
  const raw = env && env.KHY_BREAK_CACHE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 解析子命令 scope(对齐 CC callBreakCache):'' / 'once' → once;
 * 'always' / 'off' / 'status' / '--clear'(或 'clear')各自归一。
 */
function parseScope(args) {
  let raw = '';
  if (Array.isArray(args)) raw = args.filter((a) => a != null && a !== '').join(' ');
  else if (args != null) raw = String(args);
  const s = raw.trim().toLowerCase();
  if (s === 'status') return 'status';
  if (s === 'off') return 'off';
  if (s === '--clear' || s === 'clear') return 'clear';
  if (s === 'always' || s === 'always-on' || s === 'on') return 'always';
  if (s === '' || s === 'once') return 'once';
  return 'unknown';
}

/**
 * 构造注入系统提示前缀的 nonce 注释行。HTML 注释形式,对模型语义无害,只改前缀哈希。
 * now/rand 注入 → 纯函数。结尾换行,保证后续前缀文本紧随其后。
 */
function buildNonceComment(now, rand) {
  const n = Number(now);
  const ts = Number.isFinite(n) && n >= 0 ? n : 0;
  const r = String(rand == null ? '' : rand).replace(/[^A-Za-z0-9]/g, '').slice(0, 16) || '0';
  return `<!-- khy-break-cache ${ts}-${r} -->\n`;
}

/**
 * 把追加型事件日志(每行一个 JSON)聚合成统计(对齐 CC readStats)。
 * 纯函数:输入原始文件内容字符串(薄壳注入),容错坏行。
 */
function aggregateStats(rawLog) {
  const out = { totalBreaks: 0, lastBreakAt: null, alwaysModeEnabled: false };
  if (!rawLog) return out;
  const events = String(rawLog)
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter((e) => e && typeof e === 'object');
  if (events.length === 0) return out;
  out.totalBreaks = events.filter((e) => e.kind === 'once').length;
  out.lastBreakAt = events[events.length - 1].at || null;
  const always = events.filter((e) => e.kind === 'always_on' || e.kind === 'always_off');
  out.alwaysModeEnabled = always.length > 0 && always[always.length - 1].kind === 'always_on';
  return out;
}

/** 构造一行事件日志(JSON + 换行)。now/kind 注入。 */
function buildEvent(now, kind) {
  const n = Number(now);
  const ms = Number.isFinite(n) && n >= 0 ? n : 0;
  return JSON.stringify({ at: new Date(ms).toISOString(), kind: String(kind) }) + '\n';
}

const USAGE_TEXT = [
  '用法:/break-cache [scope]',
  '',
  '  (无参) / once    调度一次性缓存击穿,下一次 API 调用生效',
  '  always           开启持久击穿(每次请求都击穿前缀缓存)',
  '  off              关闭持久击穿并清除待生效的一次性 marker',
  '  --clear          仅清除待生效的一次性 marker(下一次调用前取消)',
  '  status           查看当前击穿状态与统计',
  '',
  '原理:Anthropic 前缀缓存以系统提示前缀哈希为键;往前缀注入唯一 nonce 即可',
  '      让哈希失效,强制重新计算上下文 —— 用于需要一个干净上下文窗口时。',
].join('\n');

function formatStatus(stats, onceActive, alwaysActive) {
  const s = stats || {};
  return [
    '## 缓存击穿状态',
    '',
    `  一次性 marker:${onceActive ? '已就绪(下一次调用将击穿缓存)' : '未设置'}`,
    `  持久模式    :${alwaysActive ? '开(每次调用都击穿)' : '关'}`,
    '',
    '## 统计',
    `  total_breaks  :${s.totalBreaks || 0}`,
    `  last_break_at :${s.lastBreakAt || 'never'}`,
  ].join('\n');
}

function formatOff(cleared) {
  return cleared
    ? '缓存击穿已关闭。已移除一次性 marker 和/或持久 flag。'
    : '缓存击穿原本就未激活。';
}

function formatClear(hadMarker, markerPath) {
  return hadMarker
    ? `已清除一次性缓存击穿 marker。\n  \`${markerPath}\``
    : '没有待生效的缓存击穿 marker。';
}

function formatAlways(alwaysPath) {
  return [
    '## 已开启持久缓存击穿',
    '',
    `flag 已写入:\`${alwaysPath}\``,
    '',
    '此后每次 API 调用都会在系统提示前缀注入随机 nonce,持续阻止前缀缓存命中。',
    '',
    '关闭:`/break-cache off`',
  ].join('\n');
}

function formatOnce(stats, markerPath) {
  const s = stats || {};
  return [
    '## 已调度一次性缓存击穿',
    '',
    `marker 已写入:\`${markerPath}\``,
    '下一次 API 调用会在系统提示前缀注入随机 nonce,然后自动消费(删除 marker)。',
    '',
    `(累计一次性击穿:${s.totalBreaks || 0} 次)`,
  ].join('\n');
}

module.exports = {
  isEnabled,
  parseScope,
  buildNonceComment,
  aggregateStats,
  buildEvent,
  USAGE_TEXT,
  formatStatus,
  formatOff,
  formatClear,
  formatAlways,
  formatOnce,
};
