'use strict';

/**
 * domain/catalog/toolUseLoop/iterationJournal.js — per-iteration journal
 * recording, carved out of toolUseLoopCore.js runToolUseLoop main loop
 * (T-021 in-body slice #5, the first IN-LOOP phase — the higher-risk ctx arc).
 *
 * On each round it slices the tool-call log from a monotonic cursor, maps each
 * entry to a compact { name, ok, durationMs, error } record and appends an
 * iteration record to the journal. It owns the two cursor/seq counters the loop
 * used to keep as bare `let`s (grep-proven used ONLY here); they live as closure
 * state created once per runToolUseLoop call, so their lifecycle is identical.
 *
 * Fail-soft: the whole body is wrapped in try/catch — a journal failure NEVER
 * blocks the main loop, exactly as the former inline block. The runId is passed
 * in (still owned by the core, shared with the start/end-record phases); the
 * caller already guards `if (_loopRunId)` so this method assumes a live runId.
 *
 * In-body convention: ZERO static require back into toolUseLoopCore; the one
 * lazy require points at the sibling toolLoopJournal module, re-based for this dir.
 */

function createIterationJournal() {
  // 每轮记录一次；_loopSeq 独立于 iteration 计数（后者有 grace 语义会重号）。
  let _loopSeq = 0;
  // toolCallLog 游标：journal 已写到哪里，下一轮从这里切片。
  let _loopToolCursor = 0;

  function recordIteration(runId, iteration, toolCallLog) {
    try {
      const _j2 = require('../../../tool/toolLoopJournal');
      const _slice = toolCallLog.slice(_loopToolCursor);
      _loopToolCursor = toolCallLog.length;
      _j2.appendJournal(
        runId,
        _j2.buildIterationRecord({
          seq: ++_loopSeq,
          iteration,
          // toolCallLog 条目形如 { iteration, tool, params, result:{success,error}, elapsed }
          tools: _slice.map((e) => {
            const r = e && e.result;
            const ok = r && r.success !== undefined ? !!r.success : null;
            return {
              name: e && e.tool,
              ok,
              durationMs: e && e.elapsed != null ? Number(e.elapsed) : null,
              error: ok === false && r ? r.error : null,
            };
          }),
        })
      );
    } catch {
      /* journal 绝不阻断主循环 */
    }
  }

  return { recordIteration };
}

module.exports = { createIterationJournal };
