'use strict';

/**
 * moaAggregation.js — pure leaf for MoA (Mixture-of-Agents) aggregation.
 * (ported concept from Hermes Agent v0.18.0 MoA, adapted to Khy-OS engine).
 *
 * Hermes MoA fans a question out to several "reference" models, shows each
 * model's answer, then an aggregator model synthesizes one final answer. Khy-OS
 * already fans out via arenaManager; this leaf owns the two *deterministic*
 * pieces so they stay pure and testable:
 *   - normalizeReferences(entries): drop failed/empty, de-duplicate near-identical
 *     answers, bound count + length → clean [{ model, content }] list;
 *   - buildAggregatorPrompt({question, references}): assemble the canonical MoA
 *     synthesis prompt (each reference quoted verbatim, labeled) for the aggregator.
 *
 * PURE LEAF CONTRACT: zero IO (no fs/net/process/argless Date), deterministic
 * (identical inputs → byte-identical output), never throws. All model calls stay
 * in the service layer (moaService).
 */

const _MAX_REFERENCES = 8;       // cap fan-in so the aggregator prompt stays bounded
const _MAX_REF_CHARS = 6000;     // per-reference length cap (mid-truncate marker kept)
const _DEDUP_THRESHOLD = 0.9;    // jaccard ≥ this ⇒ treat as duplicate, keep the richer one

// 收敛到 utils/toStr 单一真源(逐字节委托,调用点不变)
const _str = require('../utils/toStr').toStr;

/**
 * Word-set Jaccard similarity in [0,1]. Self-contained (no cross-file coupling)
 * so the leaf stays independent and pure.
 */
function _jaccardSimilarity(a, b) {
  const wa = new Set(_str(a).toLowerCase().split(/\s+/).filter(Boolean));
  const wb = new Set(_str(b).toLowerCase().split(/\s+/).filter(Boolean));
  if (wa.size === 0 && wb.size === 0) return 1;
  if (wa.size === 0 || wb.size === 0) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  const union = wa.size + wb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function _clampContent(text) {
  const s = _str(text).trim();
  if (s.length <= _MAX_REF_CHARS) return s;
  const head = Math.ceil(_MAX_REF_CHARS * 0.6);
  const tail = _MAX_REF_CHARS - head;
  return `${s.slice(0, head)}\n…[截断]…\n${s.slice(s.length - tail)}`;
}

/**
 * Normalize raw arena entries into a clean, de-duplicated reference list.
 * @param {Array<{model?, content?, failed?, error?}>} entries
 * @param {{ maxReferences?: number, dedupThreshold?: number }} [options]
 * @returns {Array<{ model: string, content: string }>}
 */
function normalizeReferences(entries, options = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const maxRefs =
    Number.isFinite(options.maxReferences) && options.maxReferences > 0
      ? Math.floor(options.maxReferences)
      : _MAX_REFERENCES;
  const threshold =
    Number.isFinite(options.dedupThreshold) ? options.dedupThreshold : _DEDUP_THRESHOLD;

  // 1) keep only successful entries with non-empty content, preserving input order.
  const cleaned = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    if (e.failed) continue;
    const content = _str(e.content).trim();
    if (!content) continue;
    cleaned.push({ model: _str(e.model) || 'unknown', content });
  }

  // 2) de-duplicate near-identical answers; when two are near-identical keep the
  //    richer (longer) one, but retain the earliest model label for stability.
  const kept = [];
  for (const cand of cleaned) {
    let dupIndex = -1;
    for (let i = 0; i < kept.length; i++) {
      if (_jaccardSimilarity(cand.content, kept[i].content) >= threshold) {
        dupIndex = i;
        break;
      }
    }
    if (dupIndex === -1) {
      kept.push(cand);
    } else if (cand.content.length > kept[dupIndex].content.length) {
      // richer answer wins the slot, keep original label
      kept[dupIndex] = { model: kept[dupIndex].model, content: cand.content };
    }
  }

  // 3) bound count + per-reference length.
  return kept.slice(0, maxRefs).map((r) => ({ model: r.model, content: _clampContent(r.content) }));
}

/**
 * Build the MoA aggregator prompt. The aggregator model receives the original
 * question and every reference answer verbatim, and is instructed to synthesize
 * a single best answer (not to pick a winner). Deterministic string assembly.
 * @param {{ question?: string, references?: Array<{model,content}>, language?: string }} params
 * @returns {string}
 */
function buildAggregatorPrompt(params = {}) {
  const question = _str(params.question).trim();
  const references = Array.isArray(params.references) ? params.references : [];
  const lang = _str(params.language).trim();

  const lines = [];
  lines.push('你是一个 Mixture-of-Agents 聚合器(aggregator)。');
  lines.push('下面是若干参考模型对同一个问题各自给出的回答。');
  lines.push('请综合所有参考回答的优点、纠正其中的错误与遗漏,合成一份最准确、完整的最终答案。');
  lines.push('不要只是挑选某一个回答,也不要逐条罗列各模型说了什么;直接输出合成后的最终答案。');
  if (lang) lines.push(`请用${lang}作答。`);
  lines.push('');
  lines.push('# 原始问题');
  lines.push(question || '(未提供问题)');
  lines.push('');
  lines.push('# 参考回答');
  if (references.length === 0) {
    lines.push('(没有可用的参考回答)');
  } else {
    references.forEach((ref, i) => {
      const model = _str(ref && ref.model) || `model-${i + 1}`;
      const content = _str(ref && ref.content).trim() || '(空)';
      lines.push('');
      lines.push(`## 参考 ${i + 1} — ${model}`);
      lines.push(content);
    });
  }
  lines.push('');
  lines.push('# 你的合成答案');
  return lines.join('\n');
}

module.exports = {
  normalizeReferences,
  buildAggregatorPrompt,
  // exported for focused unit tests
  _jaccardSimilarity,
};
