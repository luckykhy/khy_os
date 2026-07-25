'use strict';

/**
 * guardApproval.js — Turn a soft PreToolUse guard block into a user approval.
 *
 * Built-in tool guards (toolGuards.js) run at the very start of the execution
 * pipeline (Stage 1), long before the normal permission gate (Stage 7,
 * toolCalling.requestPermission). When a guard returns `{action:'block'}` the
 * pipeline aborts immediately and the user never gets a chance to approve — even
 * for "soft" guards whose only concern is something a knowing user can authorize
 * (editing outside the project root, overwriting an externally-modified file,
 * writing a not-yet-read existing file).
 *
 * This helper bridges that gap: given a guard that flagged its block as
 * `approvable`, it raises a single `can_use_tool` control request through the
 * host's interactive channel. On approval it stamps the EXEC_APPROVED token onto
 * the params so the downstream Stage-7 gate does not prompt a second time for the
 * same call. On denial — or when there is no interactive channel (classic REPL /
 * sub-agent / CI) — it fails closed and the original block stands.
 *
 * Hard security guards (path traversal, rate limit, loop/dedup guardrails) do
 * NOT set `approvable`, so they never reach this helper and remain unbypassable.
 */

/**
 * Ask the user to approve a tool call that a soft guard blocked.
 *
 * @param {object} args
 * @param {string} args.toolName            - Tool the model is invoking.
 * @param {object} args.params              - Tool params (file_path, etc.).
 * @param {string} [args.reason]            - Human-readable guard reason.
 * @param {string} [args.source]            - Guard source id (e.g. EditBoundaryGuard).
 * @param {Function} [args.onControlRequest]- Host interactive channel.
 * @returns {Promise<{ allowed: boolean, params: object }>}
 *   allowed=true → caller should proceed (params carries the EXEC_APPROVED stamp).
 *   allowed=false → caller keeps the original block (fail-closed).
 */
async function requestGuardApproval({ toolName, params, reason, source, onControlRequest } = {}) {
  const safeParams = params && typeof params === 'object' ? params : {};

  // Constraint-lattice irreducibility (§4.D): a red-line source (⊥) is a fixed
  // point of relaxation — relax(⊥)=⊥ — so it can NEVER be lifted to a prompt,
  // regardless of any approvable flag. Today red lines don't reach this helper
  // (they never set `approvable`), so this is a zero-regression belt-and-braces
  // enforcement of the contract documented above. Fail-open on require error to
  // preserve the existing soft-approval path if the module is unavailable.
  try {
    if (require('./constraintLattice').isRedLineSource(source)) {
      return { allowed: false, params: safeParams };
    }
  } catch { /* lattice optional — fall through to the legacy path */ }

  // No interactive channel → cannot obtain informed consent → keep the block.
  if (typeof onControlRequest !== 'function') {
    return { allowed: false, params: safeParams };
  }

  let ctrlResp = null;
  try {
    ctrlResp = await onControlRequest({
      requestId: `guard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      request: {
        subtype: 'can_use_tool',
        tool_name: toolName,
        // Surface the guard reason/source so the host overlay can explain exactly
        // what the user is authorizing (a boundary override, a stale overwrite…).
        input: { ...safeParams, _guardReason: reason || '', _guardSource: source || '' },
      },
    });
  } catch {
    return { allowed: false, params: safeParams };
  }

  // Reuse the canonical three-state decoder so TUI raw values (true/'always'),
  // REPL/SDK { behavior } objects, and nested control_response shapes all work.
  let decision = 'deny';
  try {
    decision = require('./toolCalling')._decisionFromControl(ctrlResp);
  } catch {
    // Fallback: minimal fail-closed decode if toolCalling is mid-cycle-require.
    if (ctrlResp === true || ctrlResp === 'always' || ctrlResp === 'allow-always') {
      decision = 'allow';
    } else if (ctrlResp && typeof ctrlResp === 'object') {
      let node = ctrlResp;
      if (node.type === 'control_response' && node.response) node = node.response;
      const inner = (node.response && typeof node.response === 'object') ? node.response : node;
      decision = (inner.behavior || node.behavior) === 'allow'
        || (inner.behavior || node.behavior) === 'allow-always' ? 'allow' : 'deny';
    }
  }

  if (decision !== 'allow' && decision !== 'allow-always') {
    return { allowed: false, params: safeParams };
  }

  // Remember an "always" decision via the existing permission store so the same
  // tool short-circuits Stage 7 on later calls this session (and persists if the
  // store is configured to). 'once' is intentionally not persisted.
  if (decision === 'allow-always') {
    try {
      const descriptor = _resolvePermissionKey(toolName);
      require('./permissionStore').approve(descriptor, 'forever');
    } catch { /* permissionStore optional */ }

    // "授权后可以访问" — when the user authorizes accessing a directory OUTSIDE the
    // project root (an EditBoundaryGuard / ReadBoundaryGuard soft block), choosing
    // "always" grants that whole directory for the session via the same store that
    // backs `/add-dir`. Later reads/writes anywhere under it then short-circuit the
    // boundary guards (isUnderAdditionalDir) instead of re-prompting per file —
    // the project-subdir rule stays free, the authorized external dir becomes free
    // too. Scoped to the approved path's PARENT directory (never an ancestor of it),
    // best-effort, opt-out via KHY_REMEMBER_APPROVED_DIR=0.
    try {
      _rememberApprovedDirectory(source, safeParams);
    } catch { /* directory memory is best-effort — never block the approval */ }
  }

  // Stamp the unforgeable EXEC_APPROVED Symbol so requestPermission (Stage 7)
  // honors this consent and does not double-prompt for the same call.
  let stamped = safeParams;
  try {
    const { EXEC_APPROVED } = require('./execApproval');
    if (EXEC_APPROVED) {
      stamped = { ...safeParams, [EXEC_APPROVED]: true };
    }
  } catch { /* execApproval optional — proceed without the stamp */ }

  return { allowed: true, params: stamped };
}

/**
 * Best-effort resolution of the permission key for a tool name, mirroring
 * requestPermission's descriptor lookup. Falls back to the raw tool name.
 * @private
 */
function _resolvePermissionKey(toolName) {
  try {
    const registry = require('../tools');
    const regTool = registry.get(toolName);
    if (regTool && regTool.name) return regTool.name;
  } catch { /* registry optional */ }
  return toolName;
}

// Boundary guards whose "always" approval should be remembered as a directory
// grant (the "授权后可以访问" / accessed-after-authorization semantics). Other
// soft guards (stale-overwrite, prior-read) authorize a single call, not a path
// scope, so they are intentionally excluded.
const _BOUNDARY_GUARD_SOURCES = new Set(['editboundaryguard', 'readboundaryguard']);

/**
 * On an "always" approval of an out-of-root boundary block, grant the approved
 * file's PARENT directory for the rest of the session via additionalDirectories
 * (the same store `/add-dir` uses). Subsequent reads/writes anywhere under that
 * directory then satisfy `isUnderAdditionalDir` and bypass the boundary guards —
 * realizing "once authorized, the directory is accessible" at directory grain.
 *
 * Deliberately scoped to dirname(approved file), never an ancestor: approving one
 * file in /etc must not silently open all of /. Opt out with
 * KHY_REMEMBER_APPROVED_DIR=0. Best-effort: callers wrap this in try/catch so a
 * failure here never blocks the approval the user already granted.
 * @private
 */
function _rememberApprovedDirectory(source, safeParams) {
  if (process.env.KHY_REMEMBER_APPROVED_DIR === '0') return;
  const src = String(source || '').toLowerCase();
  if (!_BOUNDARY_GUARD_SOURCES.has(src)) return;

  const rawPath = safeParams.file_path || safeParams.filePath || safeParams.path;
  if (!rawPath || typeof rawPath !== 'string') return;

  const path = require('path');
  const root = process.env.KHYQUANT_CWD || process.cwd();
  const abs = path.isAbsolute(rawPath) ? rawPath : path.resolve(root, rawPath);
  const dir = path.dirname(abs);
  if (!dir || dir === '.') return;

  require('./additionalDirectories').addDirectory(dir, { source: 'guard-approval' });
}

module.exports = { requestGuardApproval, _rememberApprovedDirectory };
