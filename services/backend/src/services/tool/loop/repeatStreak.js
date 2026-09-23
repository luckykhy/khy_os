'use strict';

/**
 * loop/repeatStreak.js — consecutive identical tool-call streak detector and
 * system-reminder builder (extracted verbatim from toolUseLoopCore.js as slice 2
 * of the `loop/` phase decomposition).
 *
 * Complements the per-call dedup in the dispatch paths: read-only tools are
 * exempted from dedup for up to 3 identical runs, so a weak model can silently
 * re-fetch the same data round after round (the reported repeated `news`
 * calls). Track "one identical call per round" streaks at loop level and, once
 * the threshold is crossed, emit a system reminder carrying the previous
 * result summary so the model answers from data it already has.
 *
 * Pure leaf: operates only on a caller-owned `state` object (`{ key, count }`)
 * and the round's `toolResults`; requires nothing from the core → no import cycle.
 */

const REPEATED_CALL_REMINDER_THRESHOLD = 3;

function _trackRepeatedCallStreak(state, toolResults) {
  if (!state || !Array.isArray(toolResults) || toolResults.length === 0) {
    return null;
  }
  const real = toolResults.filter((tr) => tr && tr.tool && !String(tr.tool).startsWith('_'));
  // Streak semantics: exactly one real call this round, identical to the last
  // round's single call. Anything else resets the streak.
  if (real.length !== 1) {
    state.key = null;
    state.count = 0;
    return null;
  }
  const tr = real[0];
  let key;
  try {
    key = JSON.stringify({ t: tr.tool, p: tr.params || {} });
  } catch {
    key = String(tr.tool);
  }
  if (key === state.key) {
    state.count += 1;
  } else {
    state.key = key;
    state.count = 1;
  }
  if (state.count < REPEATED_CALL_REMINDER_THRESHOLD) {
    return null;
  }
  const ok = !!(tr.result && tr.result.success === true);
  let summary = '';
  try {
    const r = tr.result || {};
    const raw =
      typeof r.output === 'string'
        ? r.output
        : typeof r.content === 'string'
          ? r.content
          : r.results
            ? JSON.stringify(r.results)
            : '';
    summary = String(raw || '')
      .trim()
      .slice(0, 600);
  } catch {
    summary = '';
  }
  return (
    '[SYSTEM: 检测到你已连续 ' +
    state.count +
    ' 次用完全相同的参数调用工具 ' +
    tr.tool +
    (ok ? '，且该调用此前已成功执行，结果如下' : '') +
    (summary ? '：\n' + summary + '\n' : '。') +
    '请勿再用相同参数重复调用该工具，请直接基于已有结果用中文回答用户。]'
  );
}

module.exports = { REPEATED_CALL_REMINDER_THRESHOLD, _trackRepeatedCallStreak };
