'use strict';

/**
 * domain/catalog/toolUseLoop/dedupLoopState.js — pre-loop dedup map + loop-state
 * initialization cluster, carved out of toolUseLoopCore.js runToolUseLoop body
 * (T-021 in-body slice #3, in-place factory; the core destructures every name
 * back so all downstream reads/mutations stay byte-identical).
 *
 * Pure value initialization: builds the cross-turn executed-call dedup map
 * (seeded from a prior continuation round's reusable successes), the file-read
 * hash staleness map, the repeated-call streak / answer-echo / short-stop /
 * length-auto-continue guard flags, and the _isFailedToolResult predicate.
 *
 * The only external input is inheritedDedupKeys (the cross-turn dedup map).
 * ZERO static requires (in-body convention); reads only process.env + deps.
 */

function createDedupLoopState(deps = {}) {
  const { inheritedDedupKeys } = deps;

  // Dedup: track ALL tool calls (both success and failure) to avoid re-executing
  // identical calls. Previously only tracked failures, which allowed the AI to
  // call the same successful command (e.g. `tree /f .`) 10 times in a loop.
  // Cross-turn inheritance: if a prior continuation round passed its dedup map,
  // seed from it so the new round is aware of what was already executed.
  // A tool result is a "failure" only when it explicitly reports success:false.
  // Failed calls are retryable (see dedup below) and are NOT inherited across
  // turns, so a transient failure never freezes the next round's first attempt.
  // A tool result is a "failure" only when it explicitly reports success:false.
  // Failed calls are retryable (see dedup below) and are NOT inherited across
  // turns, so a transient failure never freezes the next round's first attempt.
  const _isFailedToolResult = (r) => !!r && typeof r === 'object' && r.success === false;
  const executedCallKeys = new Map(); // key -> { result, count }
  if (inheritedDedupKeys instanceof Map && inheritedDedupKeys.size > 0) {
    // Cross-turn inheritance: seed only entries that carry a REUSABLE success
    // result. Failures and bare intent markers (result === null) are skipped so
    // the new round can genuinely retry them instead of hard-blocking.
    for (const [_k, _v] of inheritedDedupKeys) {
      const _r = _v && _v.result;
      if (_r != null && !_isFailedToolResult(_r)) {
        executedCallKeys.set(_k, _v);
      }
    }
  }
  const fileReadHashes = new Map(); // absolutePath -> md5(first 10KB) for staleness detection
  let consecutiveDedupIterations = 0; // track consecutive all-deduped rounds
  // Loop-level consecutive identical-call streak (see _trackRepeatedCallStreak).
  const _repeatCallStreak = { key: null, count: 0 };
  // 跨轮「答案回声」断路器状态:本轮内已 substantive 流式过的答案指纹。answerEchoGuard 据此在结论前
  // 判断本轮答案是否复现了此前流式过的某个答案(重复输出 Flavor A/B 的统一缺口:无跨轮答案文本比对)。
  const _streamedAnswerFps = [];
  // 重复输出修复(auto-web-search 复述):记录本轮是否曾注入过 auto-web-search。搜索结果回灌后模型
  // 常基于结果把已流式答案又复述一遍并附加引用,导致长度显著变化而穿透 echo guard 的长度比护栏;
  // 该标志让回声断路器在此场景放宽 lenRatioMax,使附加引用后的复述仍进入 Jaccard 判定被拦截。
  let _autoWebSearchInjectedThisTurn = false;
  // 短停自动续写(默认关)单次封顶:全轮至多触发一次续写,防「续写又早停→再续写」抖动。
  let _shortStopContinuationUsed = false;
  // Length-truncation auto-continue (P0, last-resort in the no-tool-call branch):
  // when the primary maxTokensRecovery never engaged (its gate off / preconditions
  // unmet) a 'length' stop would otherwise fall through and be finalized as a
  // complete answer. Bounded counter (max 2) prevents infinite continue loops.
  // Gate KHY_LENGTH_TRUNCATION_AUTO_CONTINUE default-on; '0'/'false'/'off'/'no' disables.
  const _lengthAutoContinueEnabled = !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_LENGTH_TRUNCATION_AUTO_CONTINUE || '')
      .trim()
      .toLowerCase()
  );
  const _LENGTH_AUTO_CONTINUE_MAX = 2;
  let _lengthAutoContinueUsed = 0;
  // Set when maxTokensRecovery already tried and gave up (diminishing returns /
  // attempts exhausted) — the P0 auto-continue must not re-fight that decision.
  let _lengthRecoveryExhausted = false;

  return {
    _isFailedToolResult,
    executedCallKeys,
    fileReadHashes,
    consecutiveDedupIterations,
    _repeatCallStreak,
    _streamedAnswerFps,
    _autoWebSearchInjectedThisTurn,
    _shortStopContinuationUsed,
    _lengthAutoContinueEnabled,
    _LENGTH_AUTO_CONTINUE_MAX,
    _lengthAutoContinueUsed,
    _lengthRecoveryExhausted,
  };
}

module.exports = { createDedupLoopState };
