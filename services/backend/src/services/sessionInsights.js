'use strict';

/**
 * sessionInsights.js — 纯叶子:把一段会话(已读入的消息序列)确定性地提炼成「会话洞见」报告。
 * 对齐 Claude Code 的 /insights:回顾本次会话——多少轮、用了哪些工具、聊了什么、耗时多久。
 *
 * 契约:零 IO(不碰 fs/网络/子进程,只读 process.env 做门控)、确定性(同输入恒等同输出,
 * 不依赖时钟/随机)、绝不抛(fail-soft)、env 门控 KHY_INSIGHTS 默认开、关闭即字节回退。
 * 真正的读盘(载入 session transcript)由调用方(工具 / CLI handler)完成,本叶子只接收已读入的数据。
 *
 * 单一真源:所有「怎么算洞见 / 怎么排版报告」的逻辑只在这里;工具与 CLI 都委派本叶子,
 * 绝不各写一份统计或排版。
 */

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  const raw = env && env.KHY_INSIGHTS;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 常量(单一真源)─────────────────────────────────────────────────────────
const TOP_TOOLS = 8;
const TOP_KEYWORDS = 10;
const KEYWORD_MIN_ASCII = 3; // ASCII 词最短长度(过滤 the/and 之外的短噪声由停用词兜)
const KEYWORD_MIN_CJK = 2; // CJK 词块最短长度(单字噪声大,取 ≥2)
const PREVIEW_LEN = 160;

// 极简双语停用词集(只挡最高频虚词;不追求 NLP 完备,够过滤报告噪声即可)。
const STOPWORDS = new Set([
  // 英文
  'the', 'and', 'for', 'with', 'that', 'this', 'you', 'your', 'are', 'was', 'were',
  'have', 'has', 'had', 'not', 'but', 'can', 'will', 'would', 'should', 'could',
  'from', 'into', 'about', 'what', 'when', 'where', 'which', 'how', 'why', 'who',
  'please', 'thanks', 'okay', 'let', 'get', 'use', 'using', 'one', 'all', 'any',
  'its', 'they', 'them', 'then', 'than', 'out', 'off', 'too', 'now', 'here', 'there',
  // 中文常见虚词/口语
  '的', '了', '和', '是', '在', '我', '你', '他', '她', '它', '们', '这', '那',
  '一个', '一下', '可以', '什么', '怎么', '为什么', '帮我', '需要', '应该', '现在',
  '没有', '就是', '不是', '这个', '那个', '如果', '因为', '所以', '但是', '而且',
  '我们', '你们', '他们', '请问', '谢谢', '好的', '直接', '然后',
]);

// 形如 tool_use / tool_calls / function_call 的内容块类型(与 toolUseLoop 的归一一致)。
const _TOOL_BLOCK_TYPES = new Set(['tool_use', 'tool_call', 'function_call']);

// ── 内容萃取(content 可能是 string 或块数组)──────────────────────────────
function _textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') { parts.push(block); continue; }
    if (block && typeof block === 'object') {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
      else if (typeof block.text === 'string' && !block.type) parts.push(block.text);
    }
  }
  return parts.join(' ');
}

function _toolNamesOf(content) {
  if (!Array.isArray(content)) return [];
  const names = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    // Anthropic 风格:{type:'tool_use', name}
    if (_TOOL_BLOCK_TYPES.has(block.type)) {
      const n = block.name || (block.function && block.function.name) || block.tool;
      if (n) names.push(String(n));
    }
    // OpenAI 风格:{type:'tool_calls', tool_calls:[{function:{name}}]} 或裸 tool_calls 数组
    const calls = block.tool_calls || (block.type === 'tool_calls' && block.tool_calls);
    if (Array.isArray(calls)) {
      for (const c of calls) {
        const n = c && ((c.function && c.function.name) || c.name);
        if (n) names.push(String(n));
      }
    }
  }
  return names;
}

// ── 关键词萃取(确定性:停用词过滤 + 频次 + 稳定排序)────────────────────────
function _extractTerms(text) {
  const terms = [];
  const s = String(text || '');
  // ASCII 词(字母数字、含连字符/下划线的标识符)
  const ascii = s.match(/[A-Za-z][A-Za-z0-9_-]{2,}/g) || [];
  for (const w of ascii) {
    const lw = w.toLowerCase();
    if (lw.length >= KEYWORD_MIN_ASCII && !STOPWORDS.has(lw)) terms.push(lw);
  }
  // CJK 连续块(整块作为一个候选词;单字噪声大,取长度 ≥2)
  const cjk = s.match(/[一-鿿]{2,}/g) || [];
  for (const w of cjk) {
    if (w.length >= KEYWORD_MIN_CJK && !STOPWORDS.has(w)) terms.push(w);
  }
  return terms;
}

function _rankCounts(counter, topN, keyName = 'term') {
  return Array.from(counter.entries())
    .sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, topN)
    .map(([key, count]) => ({ [keyName]: key, count }));
}

function _truncate(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

/**
 * 把一段会话提炼成洞见对象(纯计算)。
 * @param {object} session - { messages:[{role,content,timestamp}], createdAt, updatedAt, title, model, sessionId }
 * @returns {object} { ok, sessionId, title, model, counts, turns, durationMs, tools, keywords, firstUser, lastAssistant, avgUserLen, avgAssistantLen, messageCount }
 */
function computeInsights(session) {
  try {
    const s = session || {};
    const messages = Array.isArray(s.messages) ? s.messages : [];
    const counts = { total: 0, user: 0, assistant: 0, tool: 0, meta: 0 };
    const toolCounter = new Map();
    const kwCounter = new Map();
    let userLenSum = 0;
    let asstLenSum = 0;
    let firstUser = '';
    let lastAssistant = '';
    let minTs = null;
    let maxTs = null;

    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      counts.total += 1;
      const role = String(m.role || 'unknown').toLowerCase();
      const ts = Number(m.timestamp);
      if (Number.isFinite(ts)) {
        if (minTs === null || ts < minTs) minTs = ts;
        if (maxTs === null || ts > maxTs) maxTs = ts;
      }
      if (m.isMeta) counts.meta += 1;

      const text = _textOf(m.content);
      const toolNames = _toolNamesOf(m.content);
      for (const n of toolNames) toolCounter.set(n, (toolCounter.get(n) || 0) + 1);

      if (role === 'user') {
        counts.user += 1;
        userLenSum += text.length;
        if (!firstUser && text.trim()) firstUser = text;
        for (const t of _extractTerms(text)) kwCounter.set(t, (kwCounter.get(t) || 0) + 1);
      } else if (role === 'assistant') {
        counts.assistant += 1;
        asstLenSum += text.length;
        if (text.trim()) lastAssistant = text;
      } else if (role === 'tool') {
        counts.tool += 1;
      }
    }

    // 工具用量也把 role:'tool' 结果消息计入「调用过的工具」无名分类之外:这里只统计 tool_use 块名。
    const tools = _rankCounts(toolCounter, TOP_TOOLS, 'name');
    const keywords = _rankCounts(kwCounter, TOP_KEYWORDS, 'term');

    // 优先用消息自带的时间戳(同一时钟,自洽);仅当消息无时间戳时回退到会话快照元数据,
    // 避免把「假/旧 createdAt」与「快照 updatedAt=持久化时刻」两套时钟相减得出荒谬时长。
    const createdAt = (minTs !== null) ? minTs : (Number.isFinite(Number(s.createdAt)) ? Number(s.createdAt) : 0);
    const updatedAt = (maxTs !== null) ? maxTs : (Number.isFinite(Number(s.updatedAt)) ? Number(s.updatedAt) : 0);
    const durationMs = Math.max(0, updatedAt - createdAt);

    return {
      ok: true,
      sessionId: s.sessionId || '',
      title: s.title || '',
      model: s.model || '',
      messageCount: counts.total,
      counts,
      turns: counts.user,
      durationMs,
      createdAt,
      updatedAt,
      tools,
      toolCallTotal: Array.from(toolCounter.values()).reduce((a, b) => a + b, 0),
      keywords,
      firstUser: _truncate(firstUser, PREVIEW_LEN),
      lastAssistant: _truncate(lastAssistant, PREVIEW_LEN),
      avgUserLen: counts.user ? Math.round(userLenSum / counts.user) : 0,
      avgAssistantLen: counts.assistant ? Math.round(asstLenSum / counts.assistant) : 0,
    };
  } catch {
    return { ok: false, sessionId: '', title: '', model: '', messageCount: 0, counts: { total: 0, user: 0, assistant: 0, tool: 0, meta: 0 }, turns: 0, durationMs: 0, createdAt: 0, updatedAt: 0, tools: [], toolCallTotal: 0, keywords: [], firstUser: '', lastAssistant: '', avgUserLen: 0, avgAssistantLen: 0 };
  }
}

// ── 时长格式化(确定性,不依赖 locale)──────────────────────────────────────
function _fmtDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = Math.floor(total % 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec} 秒`;
  return `${sec} 秒`;
}

/**
 * 把洞见对象排版成可读报告(中文)。纯字符串,绝不读盘。
 */
function buildInsightsReport(insights) {
  const i = insights || {};
  if (!i.ok || !i.messageCount) {
    return '会话洞见:暂无可分析的消息(会话为空或尚未持久化)。';
  }
  const lines = [];
  lines.push('# 会话洞见');
  if (i.title) lines.push(`标题:${i.title}`);
  if (i.model) lines.push(`模型:${i.model}`);
  lines.push('');
  lines.push('## 概览');
  lines.push(`- 消息总数:${i.messageCount}(用户 ${i.counts.user} · 助手 ${i.counts.assistant} · 工具结果 ${i.counts.tool})`);
  lines.push(`- 对话轮次:${i.turns}`);
  lines.push(`- 持续时长:${_fmtDuration(i.durationMs)}`);
  lines.push(`- 工具调用:共 ${i.toolCallTotal} 次`);
  lines.push(`- 平均长度:用户 ${i.avgUserLen} 字 · 助手 ${i.avgAssistantLen} 字`);

  if (i.tools && i.tools.length) {
    lines.push('');
    lines.push('## 最常用工具');
    for (const t of i.tools) lines.push(`- ${t.name} × ${t.count}`);
  }
  if (i.keywords && i.keywords.length) {
    lines.push('');
    lines.push('## 话题关键词');
    lines.push(i.keywords.map((k) => `${k.term}(${k.count})`).join(' · '));
  }
  if (i.firstUser) {
    lines.push('');
    lines.push('## 起始诉求');
    lines.push(`> ${i.firstUser}`);
  }
  return lines.join('\n');
}

/**
 * 门控总入口:关闭即返回空报告(字节回退,功能下线)。
 */
function routeInsights(session, env = process.env) {
  if (!isEnabled(env)) return { ok: false, disabled: true, report: '' };
  const insights = computeInsights(session);
  return { ...insights, report: buildInsightsReport(insights) };
}

module.exports = {
  isEnabled,
  TOP_TOOLS,
  TOP_KEYWORDS,
  STOPWORDS,
  computeInsights,
  buildInsightsReport,
  routeInsights,
};
