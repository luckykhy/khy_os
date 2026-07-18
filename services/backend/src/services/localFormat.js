'use strict';

/**
 * 本地模式结构化排版（无模型输出统一呈现层）
 * =================================================================
 * 角色：给所有「无 AI 模型」产出的回复一套统一、整洁、可扫读的结构——
 * 区块标题（## 标题）、要点列表（- 项）、来源块（编号 URL 独占整行）、
 * 元信息脚注。产出的是 **Markdown**，交由 cli/markdownRenderer 渲染成
 * 终端视觉（## → 加粗青色标题、- → •、1. URL → › URL 且不被硬换行截断），
 * 同时对 web/SSE 等非终端消费者天然友好。
 *
 * 设计铁律（与本地模式其余子系统一致）：
 *  - 单一真源：本地推理 / 网络搜索整理 / 任务模板 / 多行 Tier-1 工具
 *    全部经此处拼装，避免各自为政的零散格式。
 *  - 零硬编码：开关经 env 可调（KHY_LOCAL_STRUCTURED）。
 *  - 状态透明：元信息行显式标注「本地 · 无模型」+ 置信度/来源数。
 *  - URL 友好：来源 URL 编号且独占整行不缩进，配合渲染层不硬换行规则，
 *    终端可整段选中复制完整链接。
 */

// 是否启用结构化排版（默认开；设 0/off/false/no 回退到调用方自有的朴素拼装）。
function isEnabled() {
  const v = String(process.env.KHY_LOCAL_STRUCTURED || 'on').trim().toLowerCase();
  return !['0', 'off', 'false', 'no'].includes(v);
}

// 区块标题：渲染为「## 标题」→ 终端加粗青色小标题。
function heading(title) {
  return `## ${String(title || '').trim()}`;
}

// 要点列表：每项「- 文本」→ 终端「• 文本」。自动跳过空项。
function bullets(items) {
  return (items || [])
    .map(s => String(s == null ? '' : s).trim())
    .filter(Boolean)
    .map(s => `- ${s}`);
}

// 「键: 值」对齐列表（系统信息等）。键右侧补空格到统一宽度便于扫读。
function keyValues(pairs) {
  const rows = (pairs || []).filter(p => p && p[1] != null && String(p[1]).length > 0);
  if (!rows.length) return [];
  const keyW = Math.max(...rows.map(([k]) => _displayWidth(String(k))));
  return rows.map(([k, v]) => {
    const key = String(k);
    const pad = ' '.repeat(Math.max(1, keyW - _displayWidth(key) + 1));
    return `- ${key}${pad}${String(v)}`;
  });
}

// 来源块：标题 + 编号 URL（每个 URL 独占整行、不缩进，避免渲染层硬换行截断）。
// 返回行数组（含前置空行与标题）；无 URL 返回 []。
function sourceBlock(urls, { limit = 4, title = '来源（可复制完整链接）' } = {}) {
  const list = [...new Set((urls || []).map(u => String(u || '').trim()).filter(Boolean))].slice(0, limit);
  if (!list.length) return [];
  const out = ['', heading(title)];
  list.forEach((u, i) => out.push(`${i + 1}. ${u}`));
  return out;
}

// 元信息脚注行：把若干片段拼成「（a · b · 本地 · 无模型）」。
// 始终追加「本地 · 无模型」状态标识（除非调用方已包含）。
function metaLine(parts) {
  const segs = (parts || []).map(s => String(s || '').trim()).filter(Boolean);
  if (!segs.some(s => /无模型/.test(s))) segs.push('本地 · 无模型');
  return `（${segs.join(' · ')}）`;
}

/**
 * 组装一篇结构化文档。
 * @param {object} doc
 * @param {string}   [doc.title]      顶部标题（## 标题）。
 * @param {Array<{heading?:string, body?:string, lines?:string[]}>} [doc.sections]
 *        各区块；body 为整段文本，lines 为预排版行（优先 lines）。
 * @param {string[]} [doc.sources]    来源 URL 列表。
 * @param {string[]} [doc.meta]       元信息片段（如「中置信」「基于 4 来源」）。
 * @param {string}   [doc.footer]     末尾说明（如「未做改写或推理」），灰显。
 * @returns {string} Markdown 文本。
 */
function compose(doc = {}) {
  const lines = [];
  if (doc.title) lines.push(`# ${String(doc.title).trim()}`, '');

  for (const sec of (doc.sections || [])) {
    if (!sec) continue;
    const body = sec.lines && sec.lines.length
      ? sec.lines
      : (sec.body != null ? String(sec.body).split('\n') : []);
    const hasContent = body.some(l => String(l).trim().length > 0);
    if (!hasContent) continue;
    if (sec.heading) lines.push(heading(sec.heading));
    body.forEach(l => lines.push(l));
    lines.push('');
  }

  for (const l of sourceBlock(doc.sources || [])) lines.push(l);

  if (doc.meta && doc.meta.length) {
    lines.push('');
    lines.push(metaLine(doc.meta));
  }
  if (doc.footer) {
    lines.push('');
    lines.push(`> ${String(doc.footer).trim()}`);
  }

  // 合并多余空行（最多保留一个），去掉首尾空行。
  const out = [];
  for (const l of lines) {
    if (l === '' && out[out.length - 1] === '') continue;
    out.push(l);
  }
  while (out.length && out[0] === '') out.shift();
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// 轻量显示宽度（CJK 记 2 列），仅用于 keyValues 对齐，避免引入渲染层依赖。
function _displayWidth(s) {
  let w = 0;
  for (const ch of String(s || '')) {
    const cp = ch.codePointAt(0);
    w += (cp >= 0x1100 && (
      cp <= 0x115F ||
      (cp >= 0x2E80 && cp <= 0xA4CF) ||
      (cp >= 0xAC00 && cp <= 0xD7A3) ||
      (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) ||
      (cp >= 0xFF00 && cp <= 0xFF60) ||
      (cp >= 0xFFE0 && cp <= 0xFFE6)
    )) ? 2 : 1;
  }
  return w;
}

module.exports = {
  isEnabled,
  heading,
  bullets,
  keyValues,
  sourceBlock,
  metaLine,
  compose,
  _displayWidth,
};
