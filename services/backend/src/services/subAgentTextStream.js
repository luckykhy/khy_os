'use strict';

/**
 * subAgentTextStream — 纯叶子:把子 agent 增量吐出的「正文文本 token」coalesce 成一行
 * 有界、确定性的实时预览,喂给 agentTreeView 的 detail 子行,使父 agent 能看到子 agent
 * 正在「说什么」(正文),而不仅仅是它在跑哪个工具(status)。对齐 Claude Code:子 agent
 * 的 prose 也实时流式上浮到父级树。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 process.env 做门控,不碰 fs/网络/子进程/时钟/随机)。
 *   - 确定性:同输入恒同输出。
 *   - 绝不抛:任何异常路径都返回安全值(空串 / 原 buffer)。
 *   - env 门控 KHY_SUBAGENT_TEXT_STREAM 默认开;关 = 调用方据 isEnabled() 直接短路,
 *     不产生任何 agent_text 事件 → 字节回退到「只流 status」的旧行为。
 *
 * 单一真源:
 *   - 「什么算一段子 agent 文本 delta」= textFromChunk(只此一处解析 onChunk 的 chunk 形状)。
 *   - 「如何把 delta 累成有界 buffer」= appendDelta(只此一处定上限)。
 *   - 「如何从 buffer 提一行预览」= previewLine(只此一处定取末行 + clip)。
 *   - 「agent_text 事件形状」= buildAgentTextEvent(只此一处)。
 * 接缝(AgentTool 生产端 / agentTreeView 消费端)绝不另写这些规则。
 */

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_SUBAGENT_TEXT_STREAM;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// buffer 只保留最近 N 个字符:预览只需末行,无须无界增长(子 agent 可能吐几十 KB)。
const _BUF_CAP = 2000;
// 预览行默认宽度,与 agentTreeView._clip 的 72 对齐,避免子行换行撑破框。
const _PREVIEW_MAX = 72;

/**
 * 从 ai.chat 的 onChunk 收到的 chunk 中抽出「正文文本」delta。单一真源:
 * 只接受 { type:'text', text:string } 这一种正文形状,以及裸字符串(防御);
 * assistant_preface / tool_use / 其它结构 chunk 一律忽略(返回 '')——它们不是子 agent
 * 在「正常作答」的正文,不该污染预览行。
 * @param {*} chunk
 * @returns {string}
 */
function textFromChunk(chunk) {
  try {
    if (chunk == null) return '';
    if (typeof chunk === 'string') return chunk;
    if (typeof chunk === 'object' && chunk.type === 'text' && typeof chunk.text === 'string') {
      return chunk.text;
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 把一段 delta 追加进有界 buffer,返回新 buffer(纯函数,绝不改入参)。
 * 超过 _BUF_CAP 只保留尾部(预览取末行,头部丢弃无影响)。
 * @param {string} buf
 * @param {string} delta
 * @returns {string}
 */
function appendDelta(buf, delta) {
  try {
    const base = typeof buf === 'string' ? buf : '';
    const add = typeof delta === 'string' ? delta : String(delta == null ? '' : delta);
    if (!add) return base;
    const merged = base + add;
    return merged.length > _BUF_CAP ? merged.slice(merged.length - _BUF_CAP) : merged;
  } catch {
    return typeof buf === 'string' ? buf : '';
  }
}

/**
 * 从 buffer 提取要展示的一行预览:取最后一段非空白文本(按换行切分,取最后一个
 * 有内容的行),折叠内部连续空白,首尾 trim,超 max 截断加省略号。确定性。
 * 空内容 → ''(调用方据此不发事件)。
 * @param {string} buf
 * @param {number} [max=_PREVIEW_MAX]
 * @returns {string}
 */
function previewLine(buf, max = _PREVIEW_MAX) {
  try {
    const s = typeof buf === 'string' ? buf : '';
    if (!s) return '';
    const lines = s.split(/\r?\n/);
    let last = '';
    for (let i = lines.length - 1; i >= 0; i--) {
      const t = String(lines[i] || '').replace(/\s+/g, ' ').trim();
      if (t) { last = t; break; }
    }
    if (!last) return '';
    const n = Number.isFinite(max) && max > 1 ? (max | 0) : _PREVIEW_MAX;
    return last.length > n ? `${last.slice(0, n - 1)}…` : last;
  } catch {
    return '';
  }
}

/**
 * 归一的 agent_text 进度事件(供 agentTreeView.applyProgressEvent 消费)。
 * @param {string} text 已 previewLine 化的一行预览
 * @returns {{type:'agent_text', text:string}}
 */
function buildAgentTextEvent(text) {
  return { type: 'agent_text', text: typeof text === 'string' ? text : String(text == null ? '' : text) };
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeSubAgentTextStream() {
  return {
    gate: 'KHY_SUBAGENT_TEXT_STREAM',
    defaultOn: true,
    bufferCap: _BUF_CAP,
    previewMax: _PREVIEW_MAX,
    summary: '子 agent 正文 token 实时上浮到父级 agent 树的 detail 子行(对齐 Claude Code 流式 prose);'
      + '门控关则只流工具 status,不发 agent_text 事件(字节回退)。',
  };
}

module.exports = {
  isEnabled,
  textFromChunk,
  appendDelta,
  previewLine,
  buildAgentTextEvent,
  describeSubAgentTextStream,
};
