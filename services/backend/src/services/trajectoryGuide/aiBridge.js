'use strict';

/**
 * aiBridge.js — AI repair-hook factory for trajectory replay (DESIGN-ARCH-049,
 * capability A: "AI-assisted replay").
 *
 * This is the ONLY module in the trajectory subsystem that touches a model. It is
 * deliberately kept OUT of replayEngine.js: the engine stays model-free (防呆①)
 * and receives this hook as an injected `opts.repair(step, ctx)` closure. When the
 * deterministic core cannot proceed on a step (a NETWORK_AI step, an un-approved
 * SHELL step, a precondition divergence, an execution failure, or a post-verify
 * hash mismatch), the engine calls the hook; the hook drives an AI sub-agent
 * through the normal AgentTool funnel to reproduce the recorded artifact.
 *
 * Red lines (mirrors the locked decision "补桥但守红线"):
 *   - The recorded sha256 stays the SOLE success oracle: the engine re-runs
 *     _verifyArtifacts after the hook returns. The hook NEVER rewrites a recorded
 *     file merely to force a hash, and NEVER mutates step.artifacts[].sha256.
 *   - One attempt per step (防呆: per-seq counter, mirrors selfHeal MAX_LOOP=1).
 *   - No privilege escalation: the sub-agent runs through the same executeTool
 *     funnel + onControlRequest; SHELL/L2 beyond the recorded policy is refused
 *     with a red-line halt rather than auto-approved.
 *   - State transparency: every attempt resolves to a structured
 *     {attempted, ok?, reason, agent?} the engine surfaces in its report.
 */

const config = require('./config');

/** Truncate a value to a short, log-safe preview string. */
function _preview(v, max = 200) {
  let s;
  try { s = typeof v === 'string' ? v : JSON.stringify(v); } catch { s = String(v); }
  if (s == null) return '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Describe the recorded artifacts a step must reproduce (path + required sha256). */
function _artifactBrief(step) {
  const arts = Array.isArray(step && step.artifacts) ? step.artifacts : [];
  return arts
    .filter((a) => a && a.path)
    .map((a) => {
      if (a.op === 'delete') return `- DELETE ${a.path}`;
      return `- ${a.path}  (sha256=${a.sha256 || '?'}, op=${a.op || 'create'})`;
    })
    .join('\n');
}

/**
 * Build the tightly-scoped sub-agent goal for one step. The prompt names the
 * exact target file(s) and required hash but explicitly forbids hash-forcing —
 * the agent must reproduce the artifact by performing the recorded operation.
 */
function _buildRepairPrompt(step, kind) {
  const name = step && step.name ? step.name : '(unknown)';
  return [
    `[Trajectory Replay — AI Repair Bridge]`,
    `The deterministic replay engine could not reproduce one recorded step (reason: ${kind}).`,
    `Reproduce the recorded artifact(s) by PERFORMING the original operation — do NOT`,
    `edit any file merely to match a hash, and do NOT fabricate output. The replay`,
    `engine will independently re-verify the recorded sha256 after you finish; that`,
    `hash is the sole success criterion.`,
    ``,
    `Recorded tool: ${name}`,
    `Recorded params: ${_preview(step && step.params, 800)}`,
    ``,
    `Target artifact(s) to reproduce on disk:`,
    _artifactBrief(step) || '(none recorded)',
    ``,
    `Produce exactly these artifact(s) at the exact path(s). Stop when done.`,
  ].join('\n');
}

/**
 * Create a repair hook bound to a single replay run.
 *
 * @param {object} [opts]
 * @param {object} [opts.agentTool]  an AgentTool-like instance with async
 *   execute(params, context); defaults to the real AgentTool. Injectable for tests.
 * @param {function} [opts.onControlRequest] host approval channel forwarded to the
 *   sub-agent (subagent permission bubbling). Absent ⇒ the funnel's own policy applies.
 * @param {string} [opts.preferredModel]  model id override (defaults to config knob).
 * @param {number} [opts.timeoutMs]       per-attempt activity timeout (defaults to config knob).
 * @returns {(step:object, ctx:object)=>Promise<{attempted:boolean, ok?:boolean, reason:string, agent?:object}>}
 */
function createRepairHook(opts = {}) {
  const max = config.repairMax();
  const preferredModel = opts.preferredModel || config.repairModel() || '';
  const timeoutSec = Math.max(1, Math.round((opts.timeoutMs || config.repairTimeoutMs()) / 1000));
  const onControlRequest = typeof opts.onControlRequest === 'function' ? opts.onControlRequest : null;

  // Lazily resolve the real AgentTool so importing this module never drags the
  // tool graph into the engine's process unless a repair actually runs.
  let agentTool = opts.agentTool || null;
  const getAgentTool = () => {
    if (agentTool) return agentTool;
    const AgentTool = require('../../tools/AgentTool');
    const Ctor = AgentTool && AgentTool.AgentTool ? AgentTool.AgentTool : AgentTool;
    agentTool = new Ctor();
    return agentTool;
  };

  const attemptsBySeq = new Map();

  return async function repair(step, ctx) {
    const seq = step && Number.isFinite(step.seq) ? step.seq : -1;
    const used = attemptsBySeq.get(seq) || 0;
    if (used >= max) {
      // 防呆: one attempt per step — never loop a step into a token sink.
      return { attempted: false, reason: `repair budget exhausted for seq ${seq} (max ${max})` };
    }
    attemptsBySeq.set(seq, used + 1);

    const kind = (ctx && ctx.kind) || 'unknown';
    const prompt = _buildRepairPrompt(step, kind);

    let result;
    try {
      const tool = getAgentTool();
      result = await tool.execute(
        {
          prompt,
          subagent_type: 'verify',
          preferred_model: preferredModel || undefined,
          timeout: timeoutSec,
        },
        { traceContext: { onControlRequest } }
      );
    } catch (e) {
      return { attempted: true, ok: false, reason: `repair agent error: ${e && e.message ? e.message : String(e)}` };
    }

    const ok = !!(result && result.success);
    return {
      attempted: true,
      ok, // advisory only — the engine re-verifies the recorded sha256 itself
      reason: ok ? 'AI 子代理已执行复现操作（待引擎哈希校验）' : `AI 子代理未成功：${_preview(result && (result.error || result.message), 200)}`,
      agent: result || null,
    };
  };
}

module.exports = {
  createRepairHook,
  _buildRepairPrompt,
  _artifactBrief,
};
