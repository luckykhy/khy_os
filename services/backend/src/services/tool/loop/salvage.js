'use strict';

/**
 * Salvage + end-of-loop honest-fallback helper family, extracted verbatim from
 * toolUseLoopCore.js (T-021 C3-P7). Pure leaf: these two functions depend only on
 * each other and on sibling service modules (re-required here, not on the core), so
 * there is NO back-edge into the god-file and no managed<->managed require cycle.
 * The core re-requires + re-exports both names (public surface unchanged).
 *
 *   - _salvageToolResults        render already-fetched tool data (weak model wrote
                                  no closing text; "先救后报" DESIGN-ARCH-029), capped,
                                  optionally led by a deterministic toolDataSummary.
   - _buildLoopEndFallbackReply  end-of-loop honest Chinese summary of what ran when
                                  the final reply is blank (AGENTS.md rule 2).
 */

// ── Salvage gathered tool results when the model writes no closing text ──────
// "先救后报" (DESIGN-ARCH-029 精神): a turn can end with successful tool calls
// (e.g. `news` fetched 8 articles, shown to the user as ✓) but ZERO assistant
// text — common for weak OpenAI-compatible models after a tool result. Printing
// a bare "未能生成有效回复" while real data sits in toolCallLog is the reported
// "工具调用显示绿色但还是没输出" symptom. Render the gathered results directly so
// the user always gets the data that was already fetched. Returns null when
// there is nothing renderable (then the caller falls back to the canned message).
function _salvageToolResults(toolCallLog, userMessage) {
  if (!Array.isArray(toolCallLog) || toolCallLog.length === 0) {
    return null;
  }
  const parts = [];
  for (const entry of toolCallLog) {
    const r = entry && entry.result;
    if (!r || r.success !== true) {
      continue;
    }
    let text = '';
    if (typeof r.output === 'string' && r.output.trim()) {
      text = r.output.trim();
    } else if (Array.isArray(r.results) && r.results.length) {
      text = r.results
        .map((it, i) => {
          if (it == null) {
            return '';
          }
          if (typeof it === 'string') {
            return `${i + 1}. ${it}`;
          }
          const title = it.title || it.name || it.headline || '';
          const url = it.url || it.link || '';
          const snippet = it.snippet || it.summary || it.description || '';
          return `${i + 1}. ${title}${snippet ? ` — ${snippet}` : ''}${url ? `\n   ${url}` : ''}`.trim();
        })
        .filter(Boolean)
        .join('\n');
    } else if (typeof r.content === 'string' && r.content.trim()) {
      text = r.content.trim();
    }
    if (text) {
      const label = entry && entry.tool ? `【${entry.tool}】\n` : '';
      parts.push(label + text);
    }
  }
  if (!parts.length) {
    return null;
  }
  let body = parts.join('\n\n');
  const CAP = 4000;
  if (body.length > CAP) {
    body = `${body.slice(0, CAP)}\n…（内容较长，已截断）`;
  }

  // 模型没产出总结时，khy 自己做一次确定性归纳（目录清单等）领头，原文随后附上。
  // 这样即便弱模型/无模型也"主动给结论"，不必用户再说一句"做个总结"。
  let summary = '';
  try {
    const tds = require('../toolDataSummary');
    // 把用户实际提问作为 focus 传给归纳器,让相关句子排最前(localNlp qFrac 主排序键)。
    // 纯叶子 buildSalvageSummaryOpts:门控关/空消息 → {} 逐字节回退今日无焦点归纳。
    if (tds.isEnabled()) {
      const _focusOpts = require('../../salvageSummaryFocus').buildSalvageSummaryOpts(
        userMessage,
        process.env
      );
      summary = tds.summarizeToolData(toolCallLog, _focusOpts);
    }
  } catch {
    /* fail-soft：归纳失败则退回原始呈现 */
  }

  if (summary && summary.trim()) {
    return `${summary.trim()}\n\n——以下为工具返回的原始内容——\n\n${body}`;
  }
  return `以下是已检索到的结果（模型本轮未生成总结，已为你直接呈现工具返回的内容）：\n\n${body}`;
}

// ── End-of-loop honest fallback (AGENTS.md rule 2: status transparency) ─────
// Used whenever the loop is about to conclude with a blank/whitespace-only
// final reply: instead of returning silence, build an honest Chinese summary
// of what actually ran (tool rounds, recent calls and their outcomes), state
// that the model produced no closing summary, surface any salvageable tool
// data, and suggest a retry. Pure formatting — never throws.
function _buildLoopEndFallbackReply(toolCallLog, { iterations, userMessage } = {}) {
  const log = Array.isArray(toolCallLog) ? toolCallLog : [];
  // Skip internal/system entries (e.g. '_legacy_cmd'); keep real tool calls.
  const calls = log.filter((t) => t && t.tool && !String(t.tool).startsWith('_'));
  const _callOk = (t) => t.success === true || !!(t.result && t.result.success === true);
  const succeeded = calls.filter(_callOk).length;
  const failed = calls.length - succeeded;
  const recent = calls
    .slice(-3)
    .map((t) => `${t.tool}（${_callOk(t) ? '成功' : '失败'}）`)
    .join('、');
  const rounds = Number(iterations) > 0 ? `${Number(iterations)} 轮` : '本次';
  const parts = [];
  parts.push(
    `已执行 ${rounds}工具循环，共发起 ${calls.length} 次工具调用（${succeeded} 成功、${failed} 失败），但模型在循环结束时未生成最终总结回复。`
  );
  if (recent) {
    parts.push(`最近的工具调用：${recent}。`);
  }
  let salvaged = null;
  try {
    salvaged = _salvageToolResults(log, userMessage);
  } catch {
    salvaged = null;
  }
  if (salvaged) {
    parts.push('', salvaged);
  }
  parts.push('', '建议重新发送本次提问，或将问题范围缩小后重试。');
  return parts.join('\n');
}

module.exports = { _salvageToolResults, _buildLoopEndFallbackReply };
