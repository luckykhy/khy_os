'use strict';

/**
 * unknownProblemHandler.js — Unknown-Problem Handler state machine (DESIGN-ARCH-043).
 *
 * Gives the khy agent a rigorous, code-enforced discipline for handling
 * unknown / ambiguous / out-of-domain requests instead of guessing or jumping
 * straight to execution. The 5-state machine:
 *
 *   1. 未知识别 (Unknown Recognition) — is the input empty/ambiguous/out-of-domain?
 *      yes → 信息请求; no → 分解映射.
 *   2. 信息请求 (Info Request) — surface unknowns + assumptions + ≤3 questions
 *      (priority 目标→约束→资源), then WAIT for the user.
 *   3. 分解映射 (Decompose) — break into sub-steps with input/expected-output/deps;
 *      any step lacking an expected output → back to 信息请求.
 *   4. 方案提议 (Propose) — exactly 2 options (思路 / 适用条件 / 风险点); user picks
 *      or auto-pick highest confidence.
 *   5. 执行与校验 (Execute & Verify) — step-by-step with checkpoints; failure → 分解映射.
 *
 * The discipline is "physically" enforced rather than left to model goodwill:
 *   - The system-prompt section hard-codes the OUTPUT STRUCTURE per phase using
 *     emoji section heads (🔍/❓ · 🧭 table · ⚙️/✅ · ⚠️) — NOT `[State: X]` markers,
 *     which are visually noisy. Structure == state ("implicit state lock").
 *   - The execution chain (toolUseLoop) parses those same heads back out: an
 *     info-request reply BLOCKS tool execution and hands control to the user; a
 *     deviation-warning reply triggers context sanitization.
 *
 * This module is the single source for both the prompt text and the detectors,
 * so the structure the model is told to emit and the structure the code matches
 * can never drift apart.
 *
 * Self-gated by KHY_UNKNOWN_PROBLEM_HANDLER (default off). `isEnabled()` is the
 * single switch consulted by every wiring site; default-off means zero behavior
 * change until explicitly turned on.
 */

const ENV_FLAG = 'KHY_UNKNOWN_PROBLEM_HANDLER';

/** Canonical structure heads — the SINGLE source the prompt and detectors share. */
const MARKERS = Object.freeze({
  INFO_UNKNOWN: '🔍 **未知点识别**',
  INFO_CONFIRM: '❓ **确认信息**',
  PROPOSE: '🧭 **方案对比**',
  EXEC_STEP: '⚙️ **执行步骤',     // followed by ` [x/y]**`
  EXEC_CHECK: '✅ **校验点**',
  DEVIATION: '⚠️ **偏离预警**',
  TRUNCATION: '⚠️ **生成中断预警**：正在重试当前步骤',
});

/**
 * @returns {boolean} whether the handler is enabled (flag === '1'|'true'|'on').
 */
function isEnabled() {
  const v = String(process.env[ENV_FLAG] || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

function _has(text, marker) {
  return typeof text === 'string' && text.includes(marker);
}

/**
 * Info-request phase: the reply asks the user for clarification and must NOT be
 * followed by tool execution. Recognized by the 🔍 未知点识别 head (the ❓ block
 * may be merged into the same head in short replies).
 * @param {string} reply
 * @returns {boolean}
 */
function isInfoRequest(reply) {
  return _has(reply, MARKERS.INFO_UNKNOWN);
}

/**
 * Deviation/rollback phase: execution failed and the agent is rolling back.
 * Triggers context sanitization (drop failed assumptions, keep confirmed facts).
 * @param {string} reply
 * @returns {boolean}
 */
function isDeviationWarning(reply) {
  return _has(reply, MARKERS.DEVIATION);
}

/**
 * Execution phase: the reply is carrying out a concrete sub-step.
 * @param {string} reply
 * @returns {boolean}
 */
function isExecutionStep(reply) {
  return _has(reply, MARKERS.EXEC_STEP);
}

/**
 * An execution-phase reply is considered TRUNCATED when it opened an execution
 * step but never produced the matching ✅ checkpoint (the step head is the last
 * structural element). Used to drive the active-retry defense. Only meaningful
 * for execution-phase replies; non-execution replies return false.
 * @param {string} reply
 * @param {object} [opts]
 * @param {boolean} [opts.stopReasonLength] - adapter reported a length/maxtokens stop
 * @returns {boolean}
 */
function isExecutionTruncated(reply, opts = {}) {
  if (!isExecutionStep(reply)) return false;
  const hasCheckpoint = _has(reply, MARKERS.EXEC_CHECK);
  // Truncated if the checkpoint never arrived, or the adapter explicitly says the
  // output was cut at the token limit.
  return !hasCheckpoint || opts.stopReasonLength === true;
}

/**
 * Hidden system directive injected on rollback: reset context to user intent +
 * failure reason only, dropping mid-flight wrong assumptions. Keeps a failed
 * branch from polluting the next reasoning round ("repeat-one-sentence" loops).
 * @param {string} [failureReason]
 * @returns {string}
 */
function buildSanitizationDirective(failureReason) {
  const reason = (failureReason && String(failureReason).trim()) || '上一步执行校验失败';
  return `[System: 上下文重置，仅保留用户原始意图与失败原因（${reason}），清除中间错误假设；回到分解映射重新规划，禁止原地重试同一失败子步。]`;
}

/**
 * Prefix for an actively-retried truncated execution step (visible, not [State:]).
 * @returns {string}
 */
function truncationRetryPrefix() {
  return `${MARKERS.TRUNCATION}\n\n`;
}

/**
 * The system-prompt section embodying the state machine. Structure-as-state:
 * each phase has an exclusive emoji head and hard preconditions, so the model
 * cannot reach 执行 without having emitted 方案对比 and obtained a choice.
 * @returns {string}
 */
function buildStateMachineSection() {
  return [
    '# 未知问题处理状态机（隐式状态锁 · 强制结构）',
    '当用户请求属于「未知 / 模糊 / 信息不足 / 超出领域 / 方案不确定」时，你必须严格按下述有限状态机推进，并以"强制输出结构"锁定当前状态。**严禁输出 `[State: X]` 之类机械标记**——你的状态由本次回复采用的结构唯一确定。',
    '可一步可靠回答的已知问题：正常作答并结束，不要套用本结构。',
    '',
    '## 状态流转（只允许这些边）',
    '1. **未知识别**：判断输入是否为空/模糊/超出领域。是→信息请求；否→分解映射。',
    '2. **信息请求**：列出未知点、已有假设、最多 3 个问题（优先级 目标→约束→资源），然后停止等待用户。',
    '3. **分解映射**：拆为子步骤（标注 输入 / 预期输出 / 前置依赖）。任一步无法标注预期输出 → 退回信息请求。',
    '4. **方案提议**：给出 2 个方案（思路 / 适用条件 / 风险点）。需用户选择，或自动选最高置信度方案。',
    '5. **执行与校验**：逐步执行并输出校验点。失败 → 退回分解映射。',
    '',
    '## 强制输出结构（结构即状态）',
    '### 信息请求期 —— 必须以如下结构开头，输出后停止等待用户：',
    `${MARKERS.INFO_UNKNOWN}`,
    '- 列出 1–3 个具体未知量（要可靠解决此问题尚缺哪些关键事实）。',
    '',
    `${MARKERS.INFO_CONFIRM}`,
    '- 最多 3 个问题，**必须是判断题（是/否、二选一）或填空题（补一个具体值）**，严禁开放式问题。',
    '- 顺序按 目标 → 约束 → 资源。每个问题自带默认假设：`若不回答，默认按【X】处理`。',
    '',
    '### 方案提议期 —— 用户未从下方选定方案前，**绝对禁止输出任何执行步骤（致命错误）**：',
    `${MARKERS.PROPOSE}`,
    '',
    '| 方案 | 思路 | 适用条件 | 风险点 |',
    '|---|---|---|---|',
    '| 方案 A | … | … | … |',
    '| 方案 B | … | … | … |',
    '',
    '👉 请选择（A / B）；若你不选，我将自动采用置信度更高的方案并说明理由。',
    '',
    '### 执行期 —— 每个子步必须成对输出：',
    `${MARKERS.EXEC_STEP} [x/y]**：<本子步在做什么>`,
    '（需外部能力时在此发起工具调用，使用 khy 原生 Tool Use 结构化调用，而非把命令写进正文）',
    `${MARKERS.EXEC_CHECK}：<可观测成功判据 + 实际结果是否满足>`,
    '- 校验通过→下一子步；全部通过→给最终结论收束。校验失败→进入偏离回退。',
    '',
    '### 偏离回退 —— 执行失败时（不使用 [FALLBACK]）：',
    `${MARKERS.DEVIATION}：<失败的校验点与客观原因>，退回重新分析。`,
    '随后强制做上下文净化：✅保留（已确认事实）/ ❌弃用（失效假设）/ 🔁新方向，并回到方案提议；禁止原地重试同一失败子步。',
    '',
    '## 防御铁律',
    '- **防跳步**：缺关键信息时严禁跳过信息请求结构直接给方案或执行；用户未选方案严禁输出执行步骤；一条回复只呈现一个阶段的结构。',
    '- **防截断**：若执行步骤的校验点未写完即被截断，下一条以 `' + MARKERS.TRUNCATION + '` 开头主动重续当前子步，不要干等用户再问。',
    '- **防污染/死循环**：回退时清空失效假设，仅保留已确认事实与失败原因；同一问题最多回退重提方案 2 次，单子步最多重试 1 次，超限则诚实说明卡点并结束，不空转。',
    '- **红线**：不泄露密钥/凭证、不绕过人工确认；破坏性/不可逆动作执行前必须在风险点标注并取得确认。',
  ].join('\n');
}

module.exports = {
  ENV_FLAG,
  MARKERS,
  isEnabled,
  isInfoRequest,
  isDeviationWarning,
  isExecutionStep,
  isExecutionTruncated,
  buildSanitizationDirective,
  truncationRetryPrefix,
  buildStateMachineSection,
};
