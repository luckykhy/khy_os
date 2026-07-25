'use strict';

/**
 * taskDecomposer.js — Programmatic task decomposition and result aggregation.
 *
 * Strategies 1-4: deterministic pattern matching (no LLM calls).
 * Strategy 4.5: deterministic sequential-chain (emits `dependencies`, no LLM).
 * Strategy 5: LLM-assisted semantic decomposition (opt-in via KHY_LLM_DECOMPOSE=true).
 */

// ── Role inference ───────────────────────────────────────────────────

const ROLE_PATTERNS = {
  explore: /搜索|查找|找到|分析|了解|读取|阅读|查看|列出|列举|检索|探索|search|find|read|list|analyze|explore|look|scan|check|inspect/i,
  implement: /修改|实现|添加|创建|写入|编写|修复|重构|改造|替换|新建|生成|implement|add|create|write|fix|refactor|update|replace|generate|build/i,
  verify: /测试|验证|检查|运行|校验|test|verify|validate|run|check|lint|build/i,
};

/**
 * Infer agent role from a subtask description.
 * @param {string} text
 * @returns {string}
 */
function _inferRole(text) {
  // Priority: implement > verify > explore > general
  // (implement is more specific than explore when both match)
  if (ROLE_PATTERNS.implement.test(text)) return 'implement';
  if (ROLE_PATTERNS.verify.test(text)) return 'verify';
  if (ROLE_PATTERNS.explore.test(text)) return 'explore';
  return 'general';
}

// ── Decomposition strategies ─────────────────────────────────────────

/**
 * Strategy 1: Explicit numbered lists.
 *   "1. do X\n2. do Y\n3. do Z" → 3 subtasks
 */
function _splitNumberedList(message) {
  const lines = message.split('\n');
  const items = [];
  let contextPrefix = [];

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)\s*[.、)）]\s+(.+)/);
    if (match) {
      items.push({
        index: parseInt(match[1], 10),
        text: match[2].trim(),
        originalLine: line.trim(),
      });
    } else if (items.length === 0 && line.trim()) {
      // Lines before the first numbered item are context
      contextPrefix.push(line.trim());
    }
  }

  if (items.length < 2) return null;

  const prefix = contextPrefix.length > 0
    ? contextPrefix.join('\n') + '\n\n'
    : '';

  return {
    reason: 'numbered_list',
    subtasks: items.map((item, i) => ({
      prompt: `${prefix}${item.originalLine}`,
      role: _inferRole(item.text),
      originIndex: i,
    })),
  };
}

/**
 * Strategy 2: Parenthesized numbering.
 *   "(1) xxx (2) yyy (3) zzz"
 */
function _splitParenNumbering(message) {
  const parts = message.split(/\(\d+\)\s*/);
  // First element is the prefix before (1)
  if (parts.length < 3) return null; // need at least 2 numbered parts

  const prefix = parts[0].trim();
  const items = parts.slice(1).map(p => p.trim()).filter(Boolean);
  if (items.length < 2) return null;

  const prefixStr = prefix ? prefix + '\n\n' : '';

  return {
    reason: 'paren_numbering',
    subtasks: items.map((text, i) => ({
      prompt: `${prefixStr}(${i + 1}) ${text}`,
      role: _inferRole(text),
      originIndex: i,
    })),
  };
}

/**
 * Strategy 3: Chinese parallel markers with semicolons.
 *   "请同时分析 A；检查 B；处理 C"
 *   "分别修改 X、Y、Z 文件"
 */
function _splitParallelMarkers(message) {
  // Check for parallel intent markers
  if (!/同时|分别|并行|各自|respectively|simultaneously|concurrently/i.test(message)) {
    return null;
  }

  // Split by Chinese semicolons or numbered Chinese commas
  let parts = message.split(/[；;]\s*/);
  if (parts.length < 2) {
    // Try splitting by Chinese enumeration comma after parallel markers
    const afterMarker = message.replace(/^.*?(同时|分别|并行|各自)\s*/, '');
    parts = afterMarker.split(/[、,]\s*/);
  }

  if (parts.length < 2) return null;

  // Extract the intent prefix (everything before the parallel marker)
  const markerMatch = message.match(/^(.*?)(同时|分别|并行|各自|respectively|simultaneously)/i);
  const prefix = markerMatch ? markerMatch[1].trim() : '';
  const prefixStr = prefix ? prefix + ' — ' : '';

  const items = parts.map(p => p.trim()).filter(p => p.length > 2);
  if (items.length < 2) return null;

  return {
    reason: 'parallel_markers',
    subtasks: items.map((text, i) => ({
      prompt: `${prefixStr}${text}`,
      role: _inferRole(text),
      originIndex: i,
    })),
  };
}

/**
 * Strategy 4: Multiple file/module targets.
 *   "修改 a.js、b.js、c.js 的错误处理"
 *   "refactor error handling in routes.js, auth.js, and db.js"
 */
function _splitMultiFileTargets(message) {
  // Extract file references (path-like strings with extensions)
  const filePattern = /(?:^|\s|[、,，])((?:[\w./\\-]+\.(?:js|ts|jsx|tsx|py|go|java|rs|vue|css|html|json|yaml|yml|md|rb|php|c|cpp|h|hpp|swift|kt|sh|bash|sql))\b)/gi;
  const files = [];
  let match;
  while ((match = filePattern.exec(message)) !== null) {
    files.push(match[1].trim());
  }

  if (files.length < 3) return null;

  // Extract the action part (message without file references)
  let action = message;
  for (const f of files) {
    action = action.replace(f, '').replace(/[、,，]\s*/, ' ');
  }
  action = action.replace(/\s{2,}/g, ' ').trim();

  return {
    reason: 'multi_file',
    subtasks: files.map((file, i) => ({
      prompt: `${action}\n\n聚焦于文件: ${file}`,
      role: _inferRole(action),
      originIndex: i,
    })),
  };
}

/**
 * Strategy 4.5: Sequential-chain markers → an ORDERED chain (each step depends
 * on the prior one). This is the deterministic PRODUCER of `dependencies` that
 * the wave scheduler (`dependencyWaveScheduler.planWaves`) has been waiting for.
 *
 * WHY THIS EXISTS (deep-dig finding — the arc's producer-side severed bridge):
 *   Strategies 1-4 emit subtasks with ONLY {prompt, role, originIndex} — no
 *   `dependencies`. The only producer of `dependencies` is the opt-in
 *   `_llmDecomposer` (strategy 5, needs KHY_LLM_DECOMPOSE + a live model). But the
 *   arc's entry `agenticHarnessService.decompose(...)` is called WITHOUT
 *   `deps.callModel`, so on the DEFAULT OFFLINE path (pip/npm install, no LLM key)
 *   strategy 5 never runs → every subtask reaches `planWaves` with zero edges → a
 *   single flat wave → the entire ordered-wave arc (OPS-MAN-083/087/091/092) is a
 *   silent no-op, and khy is still "flatten-and-race". `planWaves` is a consumer
 *   waiting for a `dependencies` field that no DETERMINISTIC producer supplies.
 *   This strategy is that deterministic producer.
 *
 * Recognizes explicit sequential markers (先…再…、然后、接着、之后、最后、首先、
 * 其次、基于上一步、then、after that、next、finally) and splits the message into
 * ORDERED steps, emitting `dependencies: [priorIndex]` (1-based) on every step
 * after the first — a linear chain step_i → step_(i+1). `_normalizeDeps` already
 * accepts a numeric 1-based index reference, so `[i]` resolves to subtask-i.
 *
 * Gated `KHY_SEQ_CHAIN_DECOMPOSE` (default-on; 0/false/off/no → return null so the
 * strategy is skipped and decompose falls back byte-identically to today's four
 * strategies / no_pattern). Pure, never throws, zero IO.
 *
 *   "先探索代码库再实现功能然后验证结果" → 3 steps, deps []/[1]/[2],
 *   roles explore → implement → verify, run as three serial single-member waves.
 */
const _SEQ_FALSY = new Set(['0', 'false', 'off', 'no']);
function _seqChainEnabled() {
  const v = process.env.KHY_SEQ_CHAIN_DECOMPOSE;
  if (v === undefined || v === null) return true;
  return !_SEQ_FALSY.has(String(v).trim().toLowerCase());
}

// Leading sequential connectives. Each marks the START of a new ordered step.
// 基于上一步/基于前一步 are treated as boundaries but NOT stripped (they carry meaning).
const _SEQ_LEADING = /(首先|其次|然后|接着|随后|之后|最后|再次|基于上一步|基于前一步|then|after that|afterwards|next,|finally)/gi;
// Presence check (includes the standalone 先…再… pair, handled separately below).
const _SEQ_PRESENCE = /首先|其次|然后|接着|随后|之后|最后|先.*再|基于(上一步|前一步)|then|after that|afterwards|next,|finally/i;
// Leading connective stripped from the FRONT of a segment (kept separate from
// _SEQ_LEADING so 基于上一步/基于前一步 stay in the prompt).
const _SEQ_STRIP = /^(首先|其次|然后|接着|随后|之后|最后|再次|then|after that|afterwards|next,|finally)[，,、:：\s]*/i;
// A rare sentinel that cannot appear in a user message, so splitting on it never
// fragments English words (which already contain spaces).
const _SEQ_SEP = ' SEQ ';

function _splitSequentialChain(message) {
  if (!_seqChainEnabled()) return null;
  if (typeof message !== 'string' || !message.trim()) return null;
  if (!_SEQ_PRESENCE.test(message)) return null;

  // Normalize the 先…再… pair into leading-connective form so one splitter handles
  // it: alias the FIRST 先 → 首先 and the FIRST 再 → 然后 (each prefixed with the
  // sentinel). Only when BOTH are present (a lone 先/再 is too weak a signal).
  let normalized = message;
  if (/先/.test(message) && /再/.test(message)) {
    normalized = normalized.replace(/先/, `${_SEQ_SEP}首先`).replace(/再/, `${_SEQ_SEP}然后`);
  }
  // Insert the sentinel before every leading connective so segments break there.
  normalized = normalized.replace(_SEQ_LEADING, `${_SEQ_SEP}$1`);

  const steps = [];
  for (let seg of normalized.split(_SEQ_SEP)) {
    seg = seg.replace(_SEQ_STRIP, '').trim();
    if (seg.length > 2) steps.push(seg);
  }

  if (steps.length < 2) return null;

  return {
    reason: 'sequential_chain',
    subtasks: steps.map((text, i) => ({
      prompt: text,
      role: _inferRole(text),
      originIndex: i,
      // Linear chain: step i (0-based) depends on step (i-1), referenced 1-based.
      dependencies: i === 0 ? [] : [i],
    })),
  };
}

// ── Main API ─────────────────────────────────────────────────────────

/**
 * Decompose a user message into independent subtasks.
 * Strategies 1-4.5: deterministic pattern matching.
 * Strategy 5: LLM-assisted semantic decomposition (opt-in, score >= 6).
 *
 * @param {string} message - User's original message
 * @param {{ score: number }} complexResult - From _isComplexTask
 * @param {object} [deps] - Optional { callModel } for LLM decomposition
 * @returns {Promise<{ shouldDecompose: boolean, subtasks: Array<{prompt: string, role: string, originIndex: number}>, reason: string }>}
 */
async function decompose(message, complexResult = {}, deps = null) {
  if (!message || typeof message !== 'string') {
    return { shouldDecompose: false, subtasks: [], reason: 'empty' };
  }

  // Minimum complexity threshold
  if (complexResult.score < 4) {
    return { shouldDecompose: false, subtasks: [], reason: 'too_simple' };
  }

  // Try deterministic strategies in priority order.
  // _splitSequentialChain sits AFTER the numbered/paren strategies (explicit
  // numbering wins) but BEFORE _splitParallelMarkers (a "先…再…" ordered intent
  // must not be mistaken for an unordered parallel burst).
  const strategies = [
    _splitNumberedList,
    _splitParenNumbering,
    _splitSequentialChain,
    _splitParallelMarkers,
    _splitMultiFileTargets,
  ];

  for (const strategy of strategies) {
    const result = strategy(message);
    if (result && result.subtasks.length >= 2) {
      return {
        shouldDecompose: true,
        subtasks: result.subtasks,
        reason: result.reason,
      };
    }
  }

  // Strategy 5: LLM-assisted decomposition (only for high complexity)
  if (complexResult.score >= 6 && deps?.callModel) {
    try {
      const llmDecomposer = require('./_llmDecomposer');
      const llmResult = await llmDecomposer.decompose(message, deps);
      if (llmResult && llmResult.subtasks.length >= 2) {
        return {
          shouldDecompose: true,
          subtasks: llmResult.subtasks,
          reason: llmResult.reason,
        };
      }
    } catch { /* LLM decomposition failed, fall through */ }
  }

  return { shouldDecompose: false, subtasks: [], reason: 'no_pattern' };
}

// ── Result aggregation ───────────────────────────────────────────────

// Gate: render a dependency-skipped subtask (OPS-MAN-087 emits
// `{ success:false, skipped:true, ... }`) as a DISTINCT "跳过（依赖失败）"
// status/count instead of folding it into the plain 失败 bucket, so the final
// report keeps the causal distinction between "genuinely failed" and
// "skipped because an upstream dep failed". default-on; only 0/false/off/no
// disable it → byte-identical to today's behavior (skips render as 失败).
// Read env per-call (pure, never throws) so tests can toggle it; sibling gate
// that stays OUT of flagRegistry (same as the KHY_DEP_WAVE_* trio).
const _MERGE_FALSY = new Set(['0', 'false', 'off', 'no']);
function _skipDistinctEnabled() {
  const v = process.env.KHY_MERGE_SKIP_DISTINCT;
  if (v === undefined || v === null) return true;
  return !_MERGE_FALSY.has(String(v).trim().toLowerCase());
}

/**
 * Merge structured sub-agent results into a unified output.
 *
 * @param {Array<{prompt: string, role: string, originIndex: number}>} subtasks
 * @param {Array<{agentId: string, name: string, depth: number, result: object}>} aggregated
 * @returns {string} Formatted merged output
 */
function mergeResults(subtasks, aggregated) {
  if (!aggregated || aggregated.length === 0) {
    return '所有子任务未返回结果。';
  }

  // Map aggregated results back to subtasks by index
  // aggregated order matches child fork order (subtask-1, subtask-2, ...)
  const paired = subtasks.map((st, i) => {
    const agResult = aggregated.find(a => a.name === `subtask-${i + 1}`);
    return { subtask: st, result: agResult?.result || null };
  });

  // Sort by originIndex
  paired.sort((a, b) => a.subtask.originIndex - b.subtask.originIndex);

  const sections = [];
  let successCount = 0;
  let failCount = 0;
  let skipCount = 0;
  // OPS-MAN-099: count of subtasks that succeeded yet produced nothing
  // (no body / no files / no toolCalls) — an "empty success" that today folds
  // silently into 完成. Gate KHY_MERGE_EMPTY_SUCCESS off → isEmptySuccess is
  // always false → emptyCount stays 0 → byte-revert to today's rendering.
  let emptyCount = 0;
  // OPS-MAN-101: roles of subtasks that FAILED (not skipped, not empty-success),
  // for a role-distribution honesty line so a failed 验证 (results unvalidated)
  // is distinguishable from a failed 探索 (recoverable). Gate
  // KHY_MERGE_ROLE_ATTRIBUTION off → tag/summary render '' → byte-revert.
  const failedRoles = [];
  const allFilesModified = new Set();
  // OPS-MAN-095: per-subtask (label, files) for parallel write-conflict detection.
  // A file listed by ≥2 real (non-skipped) subtasks = potential write-write race
  // that the de-duping `allFilesModified` Set silently collapses to one entry.
  const perSubtaskFiles = [];

  for (const { subtask, result } of paired) {
    const idx = subtask.originIndex + 1;
    const preview = subtask.prompt.split('\n')[0].slice(0, 100);
    // OPS-MAN-101: decorative role tag (e.g. 「（验证）」). Gate off / unknown
    // role → '' → header is byte-identical to today's `### 子任务 N: preview`.
    const { formatRoleTag } = require('./orchestrator/mergeRoleAttribution');
    const roleTag = formatRoleTag(subtask.role);
    const header = `### 子任务 ${idx}${roleTag}: ${preview}`;

    if (!result) {
      failCount++;
      failedRoles.push(subtask.role);
      sections.push(`${header}\n**状态**: 未执行\n`);
      continue;
    }

    // Dependency-skipped (OPS-MAN-087) → distinct status/count, never folded
    // into 失败. Skipped subtasks never ran, so they carry no output/files.
    const isSkipped = _skipDistinctEnabled() && result.skipped === true;
    if (isSkipped) {
      skipCount++;
      sections.push(`${header}\n**状态**: 跳过（依赖失败）\n${result.error || '依赖失败，已跳过'}`);
      continue;
    }

    const success = result.success !== false;
    if (success) successCount++;
    else {
      failCount++;
      // OPS-MAN-101: record the role of this failed subtask for the footer
      // role-distribution line (未执行 above is also recorded).
      failedRoles.push(subtask.role);
    }

    // OPS-MAN-099: an empty success (success but no body/files/toolCalls) is
    // rendered as a distinct 「完成（无产出）」 so a silent no-op/empty-response
    // agent is not indistinguishable from real work. successCount is unchanged
    // (it truly did not fail) — this only adds a visible marker + footer count.
    const { isEmptySuccess } = require('./orchestrator/mergeEmptySuccess');
    const emptySuccess = success && isEmptySuccess(result);
    if (emptySuccess) emptyCount++;

    const status = success
      ? (emptySuccess ? '⚠️ 完成（无产出）' : '完成')
      : `失败: ${result.error || '未知错误'}`;
    const body = result.text || result.output || '(无输出)';

    // Collect files modified
    if (Array.isArray(result.filesModified)) {
      for (const f of result.filesModified) allFilesModified.add(f);
      // OPS-MAN-095: record this real subtask's files for conflict detection.
      // Skipped subtasks (handled above) never reach here → carry no files.
      if (result.filesModified.length > 0) {
        perSubtaskFiles.push({ label: `子任务 ${idx}`, files: result.filesModified });
      }
    }

    const meta = [];
    if (result.toolCalls) meta.push(`工具调用: ${result.toolCalls}`);
    if (result.elapsed) meta.push(`耗时: ${result.elapsed}`);
    if (result.iterations) meta.push(`迭代: ${result.iterations}`);

    sections.push(
      `${header}\n**状态**: ${status}\n${body}` +
      (meta.length > 0 ? `\n_${meta.join(' | ')}_` : '')
    );
  }

  // Summary footer
  const total = subtasks.length;
  const footer = [
    `\n---\n## 汇总`,
    `- 完成: ${successCount}/${total} 项`,
  ];
  if (failCount > 0) footer.push(`- 失败: ${failCount} 项`);
  if (skipCount > 0) footer.push(`- 跳过（依赖失败）: ${skipCount} 项`);
  if (allFilesModified.size > 0) {
    footer.push(`- 修改文件: ${[...allFilesModified].join(', ')}`);
  }
  // OPS-MAN-095: parallel write-conflict honesty. When ≥2 real subtasks list the
  // same file, the de-duping Set above hides the collision — surface it as a
  // visible warning. Gate KHY_MERGE_FILE_CONFLICT off → detectFileConflicts
  // returns [] → no line = byte-revert to today's "de-dup only" behavior.
  const { detectFileConflicts, formatConflictWarning } = require('./orchestrator/mergeFileConflicts');
  const conflictWarning = formatConflictWarning(detectFileConflicts(perSubtaskFiles));
  if (conflictWarning) {
    footer.push(`- ${conflictWarning}`);
  }

  // OPS-MAN-099: empty-success honesty. If any subtask succeeded with no output,
  // surface a footer count. Gate off → emptyCount stayed 0 → no line (byte-revert).
  const { formatEmptySuccessWarning } = require('./orchestrator/mergeEmptySuccess');
  const emptyWarning = formatEmptySuccessWarning(emptyCount);
  if (emptyWarning) {
    footer.push(`- ${emptyWarning}`);
  }

  // OPS-MAN-101: role-attribution honesty. Break the failCount down by the
  // TYPE of work that failed so a failed 验证 (results unvalidated) is not
  // hidden behind an anonymous 「失败」. Gate KHY_MERGE_ROLE_ATTRIBUTION off →
  // formatRoleFailureSummary returns '' → no line (byte-revert). The bucket
  // counts always sum to failCount (unknown roles fall back to 通用).
  const { formatRoleFailureSummary } = require('./orchestrator/mergeRoleAttribution');
  const roleFailureSummary = formatRoleFailureSummary(failedRoles);
  if (roleFailureSummary) {
    footer.push(`- ${roleFailureSummary}`);
  }

  return sections.join('\n\n---\n\n') + footer.join('\n');
}

module.exports = { decompose, mergeResults, _splitSequentialChain };
