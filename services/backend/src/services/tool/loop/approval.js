'use strict';

/**
 * loop/approval.js — exec/control-approval reader cluster carved out of
 * toolUseLoopCore.js (T-021 god-file split, pure-leaf slice).
 *
 * Owns the onControlRequest response readers + the execApproval verdict
 * resolution used by the tool loop's permission seams:
 *   - _readControlDecision  allow/deny out of a control_response payload
 *   - _resolveExecApproval  execApproval verdict incl. escape valves + token stamp
 *   - _readControlAnswers   AskUserQuestion answers out of a control_response
 *
 * Pure leaf: every external module is reached by a LAZY require re-based for
 * this deeper dir (./ -> ../ ; ../ -> ../../); there is NO back-edge into the
 * core, so this adds nothing to the require-graph SCC (M6 cycles stay 0).
 * Bodies are byte-identical to the former core functions.
 */

/**
 * Read an allow/deny decision out of an onControlRequest response. Delegates to
 * the canonical toolCalling._decisionFromControl so the execApproval path honors
 * the SAME resolution payloads every host emits — primitives (`true`, `'always'`)
 * AND the {behavior} object shape. The Ink PermissionsPrompt resolves "允许本次"
 * as the boolean `true` and "免审/始终允许" as the string `'always'`; a parser
 * that only accepted objects (the previous local implementation) mis-read those
 * as deny, so a TUI approval still produced "[ExecApproval] Approval required".
 * Returns 'allow' or 'deny'. Defaults to 'deny' (fail-closed) when the response
 * is missing or unreadable — an absent channel must never silently permit.
 */
function _readControlDecision(resp) {
  try {
    const decision = require('../toolCalling')._decisionFromControl(resp);
    return decision === 'allow' || decision === 'allow-always' ? 'allow' : 'deny';
  } catch {
    // Fallback: toolCalling unavailable — tolerate primitives + object shape inline.
    if (resp === true) {
      return 'allow';
    }
    if (!resp || typeof resp !== 'object') {
      return 'deny';
    }
    let node = resp;
    if (node.type === 'control_response' && node.response) {
      node = node.response;
    }
    const inner = node.response && typeof node.response === 'object' ? node.response : node;
    const behavior = inner.behavior || node.behavior;
    return behavior === 'allow' ? 'allow' : 'deny';
  }
}

/**
 * Resolve an execApproval verdict for a shell command, connecting the ask-state
 * to the host approval channel (onControlRequest). Returns 'allow' | 'deny'.
 *
 * Contract (s03 permission pipeline, defect ①):
 *   - allowed:true                      → 'allow' (hard allow, unchanged)
 *   - no requestId                      → 'deny'  (hard deny, unchanged)
 *   - ask-state (requestId present):
 *       · escape valve open             → decide('approved') + stamp token + 'allow'
 *         (KHY_EXEC_APPROVAL=off | dangerousMode | yolo profile)
 *       · no onControlRequest channel   → fail-closed: decide('denied') + 'deny'
 *       · channel says allow            → decide('approved') + stamp token + 'allow'
 *       · channel says deny / unreadable→ decide('denied') + 'deny'
 *
 * The EXEC_APPROVED Symbol token stamped onto call.params short-circuits the
 * downstream canonical gate (toolCalling.requestPermission) so an already
 * approved command is not prompted twice. A Symbol key cannot be forged by the
 * model through JSON params.
 */
async function _resolveExecApproval(call, approval, onControlRequest, signal) {
  if (approval.allowed === true) {
    return 'allow';
  }
  if (!approval.requestId) {
    return 'deny';
  }

  const requestId = approval.requestId;
  let execApprovalMod = null;
  try {
    execApprovalMod = require('../../execApproval');
  } catch {
    execApprovalMod = null;
  }
  const mgr = execApprovalMod && execApprovalMod.execApproval;
  const EXEC_APPROVED = execApprovalMod && execApprovalMod.EXEC_APPROVED;

  const _stampAllow = () => {
    if (mgr) {
      try {
        mgr.decide(requestId, 'approved', { decidedBy: 'escape_valve' });
      } catch {
        /* best-effort */
      }
    }
    if (EXEC_APPROVED && call.params && typeof call.params === 'object') {
      call.params[EXEC_APPROVED] = true;
    }
    return 'allow';
  };
  const _stampDeny = (by) => {
    if (mgr) {
      try {
        mgr.decide(requestId, 'denied', { decidedBy: by || 'fail_closed' });
      } catch {
        /* best-effort */
      }
    }
    return 'deny';
  };

  // Escape valves — keep non-interactive environments (CI / WS fire-and-forget
  // / subagent) usable. permissionLevel defaults to ask, so without these the
  // fail-closed branch would reject every risk command.
  let yolo = false;
  try {
    yolo = require('../../permissionStore').getProfile() === 'yolo';
  } catch {
    /* optional */
  }
  let dangerous = false;
  try {
    dangerous = require('../toolCalling').isDangerousMode();
  } catch {
    /* optional */
  }
  if (process.env.KHY_EXEC_APPROVAL === 'off' || dangerous || yolo) {
    return _stampAllow();
  }

  // No approval channel → fail-closed. Content-related ask is un-bypassable.
  if (typeof onControlRequest !== 'function') {
    return _stampDeny('no_channel');
  }

  let ctrlResp = null;
  try {
    // Race against abort so a never-settling approval prompt (orphaned overlay,
    // ESC, interrupt) can't park the loop forever. Gated KHY_CONTROL_REQUEST_GUARD
    // (default on); off → raw promise. On abort/timeout → null → fail-closed deny.
    ctrlResp = await require('../../controlRequestGuard').guardControlRequest(
      onControlRequest({
        requestId: `exec_${requestId}`,
        request: {
          subtype: 'can_use_tool',
          tool_name: 'shell_command',
          input: { command: call.params?.command, risk: approval.risk, reason: approval.reason },
        },
      }),
      { signal: signal || null, env: process.env }
    );
  } catch {
    ctrlResp = null;
  }

  if (_readControlDecision(ctrlResp) === 'allow') {
    return _stampAllow();
  }
  return _stampDeny('user_denied');
}

/**
 * Read AskUserQuestion answers out of an onControlRequest response. Tolerant of
 * the several shapes a host handler may return:
 *   - REPL handleControlRequest: { subtype:'success', response:{ behavior, updatedInput:{ answers } } }
 *   - bare SDK payload:          { behavior, updatedInput:{ answers } }
 *   - full envelope:             { type:'control_response', response:{ response:{ behavior, updatedInput } } }
 * Returns { answers } on allow, { denied:true } on deny, or {} when unreadable.
 */
function _readControlAnswers(resp) {
  if (!resp || typeof resp !== 'object') {
    return {};
  }
  let node = resp;
  if (node.type === 'control_response' && node.response) {
    node = node.response;
  }
  const inner = node.response && typeof node.response === 'object' ? node.response : node;
  const behavior = inner.behavior || node.behavior;
  if (behavior === 'deny') {
    return { denied: true };
  }
  const ui =
    inner.updatedInput || node.updatedInput || (inner.response && inner.response.updatedInput);
  if (ui && ui.answers && typeof ui.answers === 'object') {
    return { answers: ui.answers };
  }
  return {};
}

module.exports = {
  _readControlDecision,
  _resolveExecApproval,
  _readControlAnswers,
};
