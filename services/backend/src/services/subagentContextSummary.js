'use strict';

/**
 * subagentContextSummary —— 纯叶子 (pure leaf):把父代理的对话历史确定性地蒸馏成一段
 *   紧凑、有界的「父上下文摘要」,供子代理启动时注入,缓解「子代理完全看不见父对话」的隔离问题。
 *
 * 契约 (CONTRACT):零 IO(对话历史由调用方读入后作数组传进来;本叶子只做纯字符串/数组运算,
 *   绝不碰 fs / 网络 / 子进程 / 时钟)、确定性(同入参恒定同输出,不调用 Date.now()/随机)、
 *   绝不抛(任何畸形入参 fail-soft 返回空串)、单一真源(摘要结构 / 上界 / 抽取规则只在这里)、
 *   env 门控默认开(`KHY_SUBAGENT_PARENT_SUMMARY`,仅 {0,false,off,no} 关闭,关闭即返回空串
 *   = 字节回退到「不注入任何父上下文」的旧行为)。
 *
 * 设计意图:子代理隔离是刻意的(策略留在父代理、子代理只做被交付的自包含块),但「完全失明」
 *   会让子代理重复探索父代理已知的事实(最近用户意图、已涉及的文件路径)。这里只抽取**低风险、
 *   高确定性**的连续性信息——最近的用户意图原话 + 最近提到的文件路径——并严格限长,既给子代理
 *   一点方向,又不喧宾夺主、不破坏「自包含 prompt」原则。**不做**模糊的「决策挖掘」(易假阳性);
 *   真正的任务上下文仍应由父代理写进自包含 prompt。显式 `parent_context_summary` 永远优先于此。
 */

const DEFAULTS = Object.freeze({
  maxChars: 1500,       // 摘要块总字符上界(防喧宾夺主)
  recentUserTurns: 2,   // 取最近几条用户消息作「意图」
  maxFilePaths: 12,     // 文件路径最多列几条
  intentClip: 400,      // 单条用户意图裁剪长度
});

/** 是否启用父上下文摘要(门控关 → 返回空串,不注入)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_SUBAGENT_PARENT_SUMMARY) != null ? env.KHY_SUBAGENT_PARENT_SUMMARY : '')
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

function _envInt(env, key, fallback, lo, hi) {
  const raw = env && env[key];
  if (raw == null || String(raw).trim() === '') return fallback;
  let n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  n = Math.round(n);
  if (n < lo) n = lo;
  if (n > hi) n = hi;
  return n;
}

/**
 * 把一条消息归一化为纯文本。兼容字符串 content、{text} 以及 Anthropic 风格的
 * content 块数组 [{type:'text', text}]。读不出 → 空串。
 * @param {*} message
 * @returns {string}
 */
function extractText(message) {
  if (message == null) return '';
  if (typeof message === 'string') return message;
  const c = message.content != null ? message.content : message.text;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const parts = [];
    for (const block of c) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block.text === 'string') parts.push(block.text);
    }
    return parts.join('\n');
  }
  return '';
}

function _role(message) {
  if (message && typeof message.role === 'string') return message.role.toLowerCase();
  return '';
}

/**
 * 从文本中抽取看起来像文件路径的串(含目录分隔或带扩展名),去重保序。
 * 零 IO:只做正则,不检查文件是否真实存在。
 * @param {string} text
 * @param {boolean} [pathRedosGuard=true] 有界路径正则(默认开,防灾难性回溯 ReDoS);
 *   传 false 使用历史无界正则(字节回退,重新暴露 O(n²) DoS)。
 * @returns {string[]}
 */
function extractFilePaths(text, pathRedosGuard = true) {
  const out = [];
  const seen = Object.create(null);
  const s = typeof text === 'string' ? text : '';
  // 形如 a/b/c.ext 或 ./x.js 或 src/foo.test.js;要求至少一个 '/' 且带扩展名,
  // 或单段带常见代码扩展名。保守以降低假阳性。
  // 路径分量有界 {1,255}(文件系统单分量硬上限)防灾难性回溯:嵌套
  // `(?:[\w.-]+\/)+[\w.-]+\.` 里贪婪 `+` 段在超长无分隔串(父对话里粘贴的乱码)
  // 上 O(n²) 挂死。对一切真实路径逐字节等价。门控关回退无界形态。
  const re = pathRedosGuard
    ? /(?:\.{1,2}\/)?(?:[\w.-]{1,255}\/)+[\w.-]{1,255}\.[A-Za-z0-9]{1,8}|[\w.-]{1,255}\.(?:js|ts|jsx|tsx|py|c|h|go|rs|md|json|yaml|yml|sh|vue)\b/g
    : /(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}|[\w.-]+\.(?:js|ts|jsx|tsx|py|c|h|go|rs|md|json|yaml|yml|sh|vue)\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m[0];
    if (!seen[p]) { seen[p] = true; out.push(p); }
  }
  return out;
}

function _clip(text, n) {
  const s = String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).trimEnd() + '…';
}

/**
 * 从父对话历史蒸馏出可注入的「父上下文摘要」块。门控关 / 无可用信息 → 空串。
 *
 * @param {Array} parentConversation  父对话消息数组(role/content)
 * @param {Object} [opts]             覆盖默认上界(maxChars/recentUserTurns/maxFilePaths)
 * @param {Object} [env]
 * @returns {string}  可直接拼进子代理 prompt 的块,或 ''
 */
function buildContextSummary(parentConversation, opts = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  if (!isEnabled(env)) return '';
  if (!Array.isArray(parentConversation) || parentConversation.length === 0) return '';

  const o = opts && typeof opts === 'object' ? opts : {};
  const maxChars = _envInt(env, 'KHY_SUBAGENT_SUMMARY_MAX_CHARS',
    Number.isFinite(o.maxChars) ? o.maxChars : DEFAULTS.maxChars, 200, 8000);
  const recentUserTurns = Number.isFinite(o.recentUserTurns) ? o.recentUserTurns : DEFAULTS.recentUserTurns;
  const maxFilePaths = Number.isFinite(o.maxFilePaths) ? o.maxFilePaths : DEFAULTS.maxFilePaths;
  // 有界路径正则(防 ReDoS)默认开;仅 {0,false,off,no} 关闭走无界字节回退。
  const pathRedosGuard = !['0', 'false', 'off', 'no'].includes(
    String((env && env.KHY_SUBAGENT_PATH_REDOS_GUARD) || '').trim().toLowerCase(),
  );

  // 最近的用户意图(倒序取最近 N 条非空用户消息,再正序展示)。
  const userTexts = [];
  for (let i = parentConversation.length - 1; i >= 0 && userTexts.length < recentUserTurns; i--) {
    if (_role(parentConversation[i]) !== 'user') continue;
    const t = extractText(parentConversation[i]).trim();
    if (t) userTexts.push(t);
  }
  userTexts.reverse();

  // 文件路径(扫最近若干条消息,跨角色)。
  const pathSet = Object.create(null);
  const paths = [];
  const scanFrom = Math.max(0, parentConversation.length - 8);
  for (let i = scanFrom; i < parentConversation.length; i++) {
    for (const p of extractFilePaths(extractText(parentConversation[i]), pathRedosGuard)) {
      if (!pathSet[p] && paths.length < maxFilePaths) { pathSet[p] = true; paths.push(p); }
    }
  }

  if (userTexts.length === 0 && paths.length === 0) return '';

  const lines = ['[Parent Context Summary — 连续性参考;父代理仍拥有总体策略,这只是快照而非完整对话]'];
  if (userTexts.length) {
    lines.push('最近用户意图:');
    for (const t of userTexts) lines.push(`- ${_clip(t, DEFAULTS.intentClip)}`);
  }
  if (paths.length) {
    lines.push('最近涉及的文件:');
    for (const p of paths) lines.push(`- ${p}`);
  }
  lines.push('(如需更多上下文请在你被交付的任务范围内自行探查;不要据此越权重做整体规划。)');

  let block = lines.join('\n');
  if (block.length > maxChars) block = block.slice(0, maxChars - 1).trimEnd() + '…';
  return block;
}

/**
 * 选出最终要注入的摘要:显式摘要优先,否则从对话历史派生。门控关 → ''。
 * @param {string} explicitSummary       调用方显式提供的 parent_context_summary
 * @param {Array}  parentConversation    父对话(用于 auto-derive)
 * @param {Object} [opts]
 * @param {Object} [env]
 * @returns {string}
 */
function resolveSummary(explicitSummary, parentConversation, opts = {}, env = (typeof process !== 'undefined' ? process.env : {})) {
  if (!isEnabled(env)) return '';
  const explicit = typeof explicitSummary === 'string' ? explicitSummary.trim() : '';
  if (explicit) {
    const maxChars = _envInt(env, 'KHY_SUBAGENT_SUMMARY_MAX_CHARS', DEFAULTS.maxChars, 200, 8000);
    const body = explicit.length > maxChars ? explicit.slice(0, maxChars - 1).trimEnd() + '…' : explicit;
    return `[Parent Context Summary — 父代理提供]\n${body}`;
  }
  return buildContextSummary(parentConversation, opts, env);
}

module.exports = {
  DEFAULTS,
  isEnabled,
  extractText,
  extractFilePaths,
  buildContextSummary,
  resolveSummary,
};
