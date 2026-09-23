'use strict';

/**
 * loop/steering.js — cross-turn tool-call repeat guard (extracted verbatim from
 * toolUseLoopCore.js as slice 3 of the `loop/` phase decomposition; mirrors
 * ZCode's steering concern).
 *
 * The in-turn loop detector + executedCallKeys reset every turn, so a model that
 * re-issues the SAME successful command on each new turn (each「继续」is a new
 * turn) never trips them. This guard closes that gap: callers pass the recent
 * successful tool-call signatures, and before dispatch we check whether the call
 * byte-matches one already answered. If so we steer the model to ANSWER from the
 * result already in context — or switch approach — instead of re-running it.
 *
 * Pure + fail-soft. Backward-compatible: dormant unless the caller supplies
 * recentToolSignatures (older/embedded callers are unaffected).
 *
 * One core-local binding is consumed here — DEDUP_READ_ONLY_TOOLS (the same-call
 * dedup exemption set, defined in the core Constants region and shared with the
 * dispatch loop). It is injected once at core load via setSteeringDeps to avoid a
 * require cycle back into the core, mirroring toolUseLoopHelpers' DI convention.
 * All other dependencies are external siblings/utils required directly.
 */

const _envFlagEnabled = require('../../../utils/envFlagEnabled');

// Injected at core load; defensive empty set so an un-injected require never throws.
let _DEDUP_READ_ONLY_TOOLS = new Set();
function setSteeringDeps(deps) {
  if (deps && deps.DEDUP_READ_ONLY_TOOLS) {
    _DEDUP_READ_ONLY_TOOLS = deps.DEDUP_READ_ONLY_TOOLS;
  }
}

// Normalize the caller-supplied signatures into { exact:Set, intents:Set }.
// Accepts an already-shaped object, an array of signature strings, or
// null/undefined (→ empty sets). Never throws.
function _normalizeRecentSignatures(input) {
  const exact = new Set();
  const intents = new Set();
  try {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      for (const s of input.exact || []) {
        if (s) {
          exact.add(String(s));
        }
      }
      for (const s of input.intents || []) {
        if (s) {
          intents.add(String(s));
        }
      }
    } else if (Array.isArray(input)) {
      for (const s of input) {
        if (s) {
          exact.add(String(s));
        }
      }
    }
  } catch {
    /* fail-soft → empty sets */
  }
  return { exact, intents };
}

// Build the (exact signature, intent key) pair for a call, mirroring the
// detector's normalization so callers and this guard agree. Returns
// { sig, intentKey } with '' for an unavailable component.
function _signatureForCall(name, params, detector) {
  let sig = '';
  let intentKey = '';
  try {
    const det = detector || require('../toolLoopDetector');
    try {
      sig = det.toolCallSignature(name, params || {}) || '';
    } catch {
      sig = '';
    }
    try {
      if (det._isShellTool && det._isShellTool(name)) {
        // Prefer _originalCommand: the loop rewrites the command for the host
        // platform (dir→ls, timeout injection) BETWEEN the pre-dispatch guard
        // (which sees the original) and onToolResult (which sees the rewritten
        // form + _originalCommand). Keying both off the ORIGINAL makes the
        // harvested signature and the guard's signature agree across turns.
        const cmd = String(
          (params && (params._originalCommand || params.command || params.cmd || params.script)) ||
            ''
        ).trim();
        if (cmd && det.extractShellIntent) {
          const intent = det.extractShellIntent(cmd);
          if (intent) {
            intentKey = 'shell:' + intent;
          }
        }
      } else if (det._isFsTool && det._isFsTool(name) && det.extractPathIntent) {
        const intent = det.extractPathIntent(name, params || {});
        if (intent) {
          intentKey = 'path:' + intent;
        }
      }
    } catch {
      intentKey = '';
    }
  } catch {
    /* detector unavailable → both '' */
  }
  return { sig, intentKey };
}

function _executionParams(params) {
  if (!params || typeof params !== 'object' || !params._toolControl) {
    return params;
  }
  const { _toolControl, ...rest } = params;
  return rest;
}

function _isReobserveRequested(call) {
  return call?.params?._toolControl?.reobserve === true;
}

// Observation calls describe current state, so an older successful result must
// not steer a later iteration away from taking a fresh measurement.
function _isObservationCall(call) {
  if (!call) {
    return false;
  }
  const name = String(call.name || call.tool || '');
  try {
    const detector = require('../toolLoopDetector');
    if (detector._isSearchTool && detector._isSearchTool(name)) {
      return _isReobserveRequested(call);
    }
    if (detector._isShellTool && detector._isShellTool(name)) {
      const command = call.params?._originalCommand || call.params?.command || call.params?.cmd;
      if (command) {
        const { classifyCommandRisk } = require('../../commandRiskClassifier');
        return classifyCommandRisk(command).isReadOnly === true;
      }
    }
    if (_DEDUP_READ_ONLY_TOOLS.has(name)) {
      return true;
    }
  } catch {
    /* fail-soft: unknown calls remain side-effecting */
  }
  return false;
}

// Decide whether to steer (without executing) a call that repeats a recent
// successful one. state = { counts:Map, cap:number } bounds steers per turn so
// the steer itself cannot loop; once the cap is hit the call falls through and
// executes normally (never a hard block).
function crossTurnRepeatDecision(call, recentSigs, state, env) {
  const e = env || process.env;
  if (!_envFlagEnabled(e.KHY_CROSS_TURN_TOOL_DEDUP, true)) {
    return { steer: false };
  }
  if (!call || !recentSigs) {
    return { steer: false };
  }
  const exact = recentSigs.exact;
  const intents = recentSigs.intents;
  const hasExact = exact && typeof exact.has === 'function' && exact.size > 0;
  const hasIntents = intents && typeof intents.has === 'function' && intents.size > 0;
  if (!hasExact && !hasIntents) {
    return { steer: false };
  }

  const name = String(call.name || call.tool || '');
  const params = call.params || {};
  const isObservation = _isObservationCall(call);
  const { sig, intentKey } = _signatureForCall(name, params, null);
  const matched =
    (sig && hasExact && exact.has(sig)) || (intentKey && hasIntents && intents.has(intentKey));
  if (!matched) {
    return { steer: false, reobserve: false };
  }
  // Explicit reobserve request: observation tool that the caller wants fresh
  if (isObservation && _isReobserveRequested(call)) {
    return { steer: false, reobserve: true };
  }
  // Filesystem tools with a file-path parameter (read_file, edit_file,
  // write_file, grep on a file, …): the intra-turn dedup has a content-hash
  // staleness check that correctly allows re-reads when the file changed.
  // Cross-turn steering runs BEFORE that check and would wrongly block a
  // legitimate re-read or a different-content edit to the same file.
  // → Skip cross-turn steering for any call that carries a file-path param;
  //   let the intra-turn layer (file hash / params-equality) decide instead.
  const _hasFilePath = !!(call.params && (call.params.file_path || call.params.path || call.params.filePath));
  if (_hasFilePath) {
    return { steer: false, reobserve: false };
  }

  const key = sig || intentKey;
  const counts = state && state.counts instanceof Map ? state.counts : null;
  const cap = state && Number.isFinite(state.cap) ? state.cap : 1;
  if (counts) {
    const prev = counts.get(key) || 0;
    if (prev >= cap) {
      return { steer: false };
    } // exhausted → let it execute
    counts.set(key, prev + 1);
  }

  const label = intentKey
    ? intentKey.replace(/^(shell|path):/, '')
    : String(params.command || params.cmd || params.path || params.file_path || name);
  const message =
    `[SYSTEM: 你在本次对话中已经成功运行过这条命令（${name}: ${String(label).slice(0, 120)}），` +
    '完整结果就在上方的工具结果里，不需要也不要再次运行同一条命令。请二选一：' +
    '① 直接基于上方已获取的结果，用中文写出用户要的最终回答（例如「可删除文件」表格），不要返回空白；' +
    '② 如果这条路拿不到所需信息（此路不通），换一个明显不同的方法或路径，而不是把同一条命令原样重试。]';
  // displayHint 是给用户看的「干净」一句话(绝不含 [SYSTEM:…] 内部控制串);message 仅喂模型。
  // 二者分离,避免内部转向指令泄漏到可见的工具结果行(见 ToolLines.errorText 优先用它)。
  const displayHint = `本轮已成功运行过这条命令，已跳过（结果在上方）。`;
  return { steer: true, message, displayHint, signature: sig, intentKey };
}

module.exports = {
  setSteeringDeps,
  _normalizeRecentSignatures,
  _signatureForCall,
  _executionParams,
  _isReobserveRequested,
  _isObservationCall,
  crossTurnRepeatDecision,
};
