'use strict';

/**
 * traceProjection.js — 溯源记录的人读投影（DESIGN-ARCH-047 §3 PHASE 1/5）。
 *
 * 一条规范的结构化记录（JSONL 里的 `_khyTrace`）有两个确定性渲染目标：
 *   (a) 内联标签串——嵌在 TUI / REPL 工具行、中转正文横幅里；
 *   (b) `khy trace` 回放行——整条轨迹的逐条溯源 + 可信字形 + 矛盾标记。
 *
 * 字形是确定性的、人和机器都易读的纯文本：
 *   VERIFIED    `✓ KHY executed`
 *   CLAIMED     `⟳ {producer} claims`
 *   QUARANTINED `⚠ quarantined`
 *   矛盾         `⚠ unverified claim`
 *
 * 纯函数：同输入同输出，无 IO。绝不在此泄露被隔离调用的原始 payload（仅给标签）。
 */

const { TRUST, traceOf } = require('./khyTrace');

const GLYPH = Object.freeze({
  [TRUST.VERIFIED]: '✓',
  [TRUST.CLAIMED]: '⟳',
  [TRUST.QUARANTINED]: '⚠',
});

/** 取一条记录的内联标签，如 `✓ KHY executed` / `⟳ codex claims` / `⚠ quarantined`。 */
function inlineLabel(entry) {
  const t = traceOf(entry);
  const glyph = GLYPH[t.trust] || '·';
  if (t.trust === TRUST.VERIFIED) return `${glyph} KHY executed`;
  if (t.trust === TRUST.QUARANTINED) return `${glyph} quarantined`;
  // CLAIMED
  const who = t.producerId ? `${t.producer}:${t.producerId}` : t.producer;
  return `${glyph} ${who} claims`;
}

/** 矛盾摘要标签数组（每条声称一行），无矛盾返回 []。 */
function contradictionLabels(entry) {
  const t = traceOf(entry);
  const list = Array.isArray(t.contradictions) ? t.contradictions : [];
  return list.map((c) => {
    const claim = c && c.claim ? String(c.claim) : 'claimed action';
    const tool = c && c.expectedTool ? String(c.expectedTool) : 'tool';
    return `⚠ unverified claim: "${claim}" (no ${tool} ran)`;
  });
}

/**
 * `khy trace` 回放单行投影：{ glyph, trust, producer, kind, at, label, contradictions[] }。
 * @param {object} entry 带 _khyTrace 的轨迹条目
 * @param {number} [index]
 */
function replayRow(entry, index = null) {
  const t = traceOf(entry);
  return {
    index,
    glyph: GLYPH[t.trust] || '·',
    trust: t.trust,
    producer: t.producerId ? `${t.producer}:${t.producerId}` : t.producer,
    kind: t.kind,
    at: t.at,
    label: inlineLabel(entry),
    contradictions: contradictionLabels(entry),
  };
}

/** 链状态页脚文本。 */
function chainStatusLine(status) {
  if (!status || status.available === false) return 'chain: unavailable';
  if (status.ok) return `✓ chain intact (${status.length} entries)`;
  return `⚠ chain broken @ #${status.brokenAt}${status.reason ? ` — ${status.reason}` : ''}`;
}

module.exports = {
  GLYPH,
  inlineLabel,
  contradictionLabels,
  replayRow,
  chainStatusLine,
};
