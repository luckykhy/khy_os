'use strict';

/**
 * teammateBus — in-process teammate registry and message bus (s15 Agent Teams).
 *
 * This is the single source of truth for multi-turn "teammates": long-running
 * in-process agents that the lead can message mid-flight and that can message
 * the lead back. It mirrors the s13 background-task pattern: a shared registry
 * module that the producer tools (TeamCreate / TeamDelete / SendMessage) and the
 * consumer (toolUseLoop) both import, so the lead loop stays agnostic to what
 * kind of work is running.
 *
 * Why a separate module (not state on the tools):
 *   class-based tools are re-instantiated per registration and `defineTool`
 *   freezes its object, so neither can hold shared mutable state. A standalone
 *   module owns the registry + inboxes and exposes a stable function contract.
 *
 * Design notes (aligned with Claude Code's teammate model, scoped to KHY's
 * single-process Node runtime — no blind copy of CC's Python daemon threads):
 *   - Teammate inbox: messages the lead (or peers) send to a teammate.
 *   - Lead inbox: messages a teammate sends back to the lead. Drained each turn
 *     by the agent loop and injected as <teammate-message> context.
 *   - Runner: how a teammate actually executes. Injectable so tests can drive
 *     the full create -> work -> reply-to-lead cycle deterministically, and so
 *     the production default (a standalone Agent run) is not hardcoded into the
 *     tool layer. The bus drives status transitions; the runner only does work.
 */

const LEAD_ID = 'lead';

// id -> { id, name, task, tools, status, createdAt, result?, error? }
const _teammates = new Map();
// teammateId -> Array<{ from, fromName, message, type, ts }>
const _inboxes = new Map();
// Messages addressed to the lead: Array<{ from, fromName, message, type, ts }>
const _leadInbox = [];

// s16: protocol request state. requestId -> ProtocolState
// { requestId, type, sender, target, status, payload, createdAt }
// type:   'shutdown' | 'plan_approval'
// status: 'pending' | 'approved' | 'rejected'
const _pendingRequests = new Map();

let _runner = null;

/** Upper bound on concurrently-registered teammates (zero-hardcode: env-tunable). */
function maxTeammates() {
  const raw = parseInt(process.env.KHY_MAX_TEAMMATES || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 16;
}

/** Cap on lead-inbox backlog so a chatty teammate cannot grow memory unbounded. */
function maxLeadInbox() {
  const raw = parseInt(process.env.KHY_MAX_LEAD_INBOX || '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

/**
 * Install the function that actually runs a teammate's task.
 * @param {(teammate: object) => (Promise<any>|any)} fn  Resolves to the
 *        teammate's final result (string or { summary }). Throwing marks the
 *        teammate failed. Pass null to clear (teammates then stay 'running').
 */
function setTeammateRunner(fn) {
  _runner = typeof fn === 'function' ? fn : null;
}

/** Default runner: execute the task as a standalone general-purpose Agent. */
function _defaultRunner(teammate) {
  const agentTool = require('./AgentTool');
  return agentTool
    .execute({ prompt: teammate.task, subagent_type: 'general-purpose' }, {})
    .then((r) => (r && (r.result || r.output || r.message)) || '');
}

function _genId() {
  return `team_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Register a teammate and dispatch its work.
 * @returns {object|{error:string}} the teammate record, or an error descriptor.
 */
function createTeammate({ name, task, tools } = {}) {
  if (!name || !String(name).trim()) return { error: 'teammate name is required' };
  if (!task || !String(task).trim()) return { error: 'teammate task is required' };
  if (_teammates.size >= maxTeammates()) {
    return { error: `teammate limit reached (${maxTeammates()})` };
  }

  const teammate = {
    id: _genId(),
    name: String(name),
    task: String(task),
    tools: Array.isArray(tools) ? tools : null,
    status: 'running',
    createdAt: Date.now(),
  };
  _teammates.set(teammate.id, teammate);
  _inboxes.set(teammate.id, []);

  const run = _runner || _defaultRunner;
  // Dispatch asynchronously; never let runner errors escape registration.
  Promise.resolve()
    .then(() => run(teammate))
    .then((result) => {
      const e = _teammates.get(teammate.id);
      if (!e || e.status === 'deleted') return;
      e.status = 'completed';
      e.result = result;
      const text = typeof result === 'string' ? result : (result && result.summary) || '(completed)';
      sendToLead(teammate.id, teammate.name, text, 'completion');
    })
    .catch((err) => {
      const e = _teammates.get(teammate.id);
      if (!e || e.status === 'deleted') return;
      e.status = 'failed';
      e.error = err && err.message ? err.message : String(err);
      sendToLead(teammate.id, teammate.name, `task failed: ${e.error}`, 'error');
    });

  return teammate;
}

/** @returns {object|null} */
function getTeammate(id) {
  return _teammates.get(id) || null;
}

/** @returns {Array<object>} registry snapshot (without internal promise refs). */
function listTeammates() {
  return Array.from(_teammates.values()).map((t) => ({
    id: t.id,
    name: t.name,
    task: t.task,
    status: t.status,
    createdAt: t.createdAt,
    pendingInbox: (_inboxes.get(t.id) || []).length,
  }));
}

/**
 * Remove a teammate and discard its inbox.
 * @returns {boolean} true if a teammate was removed.
 */
function deleteTeammate(id) {
  const t = _teammates.get(id);
  if (!t) return false;
  t.status = 'deleted';
  _teammates.delete(id);
  _inboxes.delete(id);
  return true;
}

/**
 * Send a message to a teammate's inbox (lead -> teammate, or peer -> teammate).
 * @param {string} id
 * @param {string} message
 * @param {string} [from='lead']
 * @param {string} [fromName='lead']
 * @param {string} [type='message']     s16 protocol type, e.g. 'shutdown_request'
 * @param {object} [metadata=null]       s16 correlation payload, e.g. { requestId }
 * @returns {boolean} true if the teammate exists and the message was queued.
 */
function sendToTeammate(id, message, from = LEAD_ID, fromName = 'lead', type = 'message', metadata = null) {
  const inbox = _inboxes.get(id);
  if (!inbox) return false;
  inbox.push({
    from,
    fromName,
    message: String(message == null ? '' : message),
    type: type || 'message',
    metadata: metadata || null,
    ts: Date.now(),
  });
  return true;
}

/** Drain (read + clear) a teammate's inbox. @returns {Array<object>} */
function drainTeammateInbox(id) {
  const inbox = _inboxes.get(id);
  if (!inbox || inbox.length === 0) return [];
  return inbox.splice(0, inbox.length);
}

/**
 * Send a message from a teammate to the lead inbox.
 * @param {string} from
 * @param {string} fromName
 * @param {string} message
 * @param {string} [type='message']
 * @param {object} [metadata=null]
 */
function sendToLead(from, fromName, message, type = 'message', metadata = null) {
  _leadInbox.push({
    from,
    fromName: fromName || from,
    message: String(message == null ? '' : message),
    type: type || 'message',
    metadata: metadata || null,
    ts: Date.now(),
  });
  while (_leadInbox.length > maxLeadInbox()) _leadInbox.shift();
}

/** Drain (read + clear) the lead inbox. @returns {Array<object>} */
function drainLeadInbox() {
  if (_leadInbox.length === 0) return [];
  return _leadInbox.splice(0, _leadInbox.length);
}

// ── s16: structured request-response protocols ──────────────────────────────
//
// Two protocols share one mechanism (a single pending->approved/rejected FSM):
//   shutdown        Lead -> Teammate   graceful shutdown handshake
//   plan_approval   Teammate -> Lead   plan review before high-risk work
//
// Every request carries a requestId; the response carries the same id back, so
// the two halves correlate across the bus. match_response validates that the
// response type matches the request type, so a shutdown_response can never
// accidentally resolve a plan_approval request.

function _genRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** @returns {object|null} the protocol state for a request id. */
function getPendingRequest(requestId) {
  return _pendingRequests.get(requestId) || null;
}

/** @returns {Array<object>} snapshot of all tracked protocol requests. */
function listPendingRequests() {
  return Array.from(_pendingRequests.values()).map((s) => ({ ...s }));
}

/**
 * Lead -> Teammate: begin a graceful shutdown handshake.
 *
 * A still-running teammate gets a shutdown_request in its inbox and is marked
 * 'stopping'; it is removed only once it replies shutdown_response (approve) and
 * the lead consumes that response. A teammate that has already finished
 * (completed/failed) or does not exist is finalized immediately — there is
 * nothing to wrap up, so no handshake is needed.
 *
 * @param {string} teammateId
 * @param {string} [reason='']
 * @returns {{ requestId: string, status: string }|{error: string}}
 */
function requestShutdown(teammateId, reason = '') {
  const t = _teammates.get(teammateId);
  if (!t) return { error: `Teammate ${teammateId} not found` };

  const requestId = _genRequestId();
  const state = {
    requestId,
    type: 'shutdown',
    sender: LEAD_ID,
    target: teammateId,
    status: 'pending',
    payload: String(reason || ''),
    createdAt: Date.now(),
  };
  _pendingRequests.set(requestId, state);

  // Already terminal: nothing in flight to drain, so shut down at once.
  if (t.status === 'completed' || t.status === 'failed') {
    state.status = 'approved';
    _finalizeShutdown(teammateId);
    return { requestId, status: 'approved' };
  }

  t.status = 'stopping';
  sendToTeammate(teammateId, reason || 'Please shut down.', LEAD_ID, 'lead',
    'shutdown_request', { requestId });
  return { requestId, status: 'pending' };
}

/** Remove a teammate after a shutdown was approved (or forced). */
function _finalizeShutdown(teammateId) {
  const t = _teammates.get(teammateId);
  if (t) t.status = 'deleted';
  _teammates.delete(teammateId);
  _inboxes.delete(teammateId);
}

/**
 * Teammate -> Lead: request approval of a plan before doing high-risk work.
 * @param {string} teammateId
 * @param {string} plan
 * @returns {{ requestId: string }|{error: string}}
 */
function requestPlanApproval(teammateId, plan) {
  const t = _teammates.get(teammateId);
  if (!t) return { error: `Teammate ${teammateId} not found` };
  if (!plan || !String(plan).trim()) return { error: 'plan is required' };

  const requestId = _genRequestId();
  _pendingRequests.set(requestId, {
    requestId,
    type: 'plan_approval',
    sender: teammateId,
    target: LEAD_ID,
    status: 'pending',
    payload: String(plan),
    createdAt: Date.now(),
  });
  sendToLead(teammateId, t.name, String(plan), 'plan_approval_request', { requestId });
  return { requestId };
}

/**
 * Lead -> Teammate: respond to a pending plan_approval request.
 * @param {string} requestId
 * @param {boolean} approve
 * @param {string} [feedback='']
 * @returns {{ok:true, target:string}|{error:string}}
 */
function reviewPlan(requestId, approve, feedback = '') {
  const state = _pendingRequests.get(requestId);
  if (!state) return { error: `Unknown request ${requestId}` };
  if (state.type !== 'plan_approval') return { error: `Request ${requestId} is not a plan_approval` };
  if (state.status !== 'pending') return { error: `Request ${requestId} already ${state.status}` };

  state.status = approve ? 'approved' : 'rejected';
  // The decision is delivered to the teammate; its own inbox dispatch matches it.
  sendToTeammate(state.sender,
    approve ? '[Plan approved]' : `[Plan rejected]${feedback ? ` ${feedback}` : ''}`,
    LEAD_ID, 'lead', 'plan_approval_response', { requestId, approve: !!approve, feedback: String(feedback || '') });
  return { ok: true, target: state.sender };
}

/**
 * Correlate a *_response back to its pending request and update its status.
 * Validates the response type matches the request type and that the request is
 * still pending (idempotent — a duplicate response is ignored).
 *
 * @param {string} responseType  e.g. 'shutdown_response' | 'plan_approval_response'
 * @param {string} requestId
 * @param {boolean} approve
 * @returns {boolean} true if a pending request transitioned.
 */
function matchResponse(responseType, requestId, approve) {
  const state = _pendingRequests.get(requestId);
  if (!state) return false;
  if (state.type === 'shutdown' && responseType !== 'shutdown_response') return false;
  if (state.type === 'plan_approval' && responseType !== 'plan_approval_response') return false;
  if (state.status !== 'pending') return false; // already resolved — skip duplicate

  state.status = approve ? 'approved' : 'rejected';
  if (state.type === 'shutdown' && approve) {
    _finalizeShutdown(state.target);
  }
  return true;
}

/**
 * Teammate-side inbox consumer. A teammate's runner/idle loop calls this to
 * process protocol messages addressed to it. Auto-replies to a shutdown_request
 * with shutdown_response (approve) and signals the runner to stop; matches any
 * plan_approval_response; returns the remaining plain messages plus a shutdown
 * flag so the runner knows to wind down.
 *
 * @param {string} teammateId
 * @returns {{ shutdown: boolean, planDecision: ('approved'|'rejected'|null), messages: Array<object> }}
 */
function dispatchTeammateInbox(teammateId) {
  const t = _teammates.get(teammateId);
  const msgs = drainTeammateInbox(teammateId);
  let shutdown = false;
  let planDecision = null;
  const passthrough = [];

  for (const msg of msgs) {
    const reqId = msg.metadata && msg.metadata.requestId;
    if (msg.type === 'shutdown_request') {
      shutdown = true;
      sendToLead(teammateId, t ? t.name : teammateId, 'Shutting down.',
        'shutdown_response', { requestId: reqId, approve: true });
      continue;
    }
    if (msg.type === 'plan_approval_response') {
      const approve = !!(msg.metadata && msg.metadata.approve);
      if (reqId) matchResponse('plan_approval_response', reqId, approve);
      planDecision = approve ? 'approved' : 'rejected';
      continue;
    }
    passthrough.push(msg);
  }
  return { shutdown, planDecision, messages: passthrough };
}

/**
 * Lead-side unified inbox consumer (s16 consume_lead_inbox). Drains the lead
 * inbox and routes every *_response through matchResponse BEFORE returning the
 * messages, so a message can never be consumed without its protocol state being
 * updated. Returns the drained messages (including protocol ones) for context
 * injection.
 * @returns {Array<object>}
 */
function consumeLeadInbox() {
  const msgs = drainLeadInbox();
  for (const msg of msgs) {
    const reqId = msg.metadata && msg.metadata.requestId;
    if (reqId && typeof msg.type === 'string' && msg.type.endsWith('_response')) {
      const approve = !!(msg.metadata && msg.metadata.approve);
      matchResponse(msg.type, reqId, approve);
    }
  }
  return msgs;
}

/**
 * Drain the lead inbox (protocol-aware) and format pending teammate messages as
 * an injectable <teammate-message> block, or null when the inbox is empty.
 * Consumed by the agent loop each turn — the s15 lead-inbox injection keystone,
 * now routing s16 protocol responses through consumeLeadInbox first.
 * @returns {string|null}
 */
function collectTeammateMessagesAsText() {
  const msgs = consumeLeadInbox();
  if (msgs.length === 0) return null;
  const blocks = msgs.map((m) => {
    const tag = m.type && m.type !== 'message' ? ` type="${m.type}"` : '';
    return `<teammate-message from="${m.fromName}"${tag}>\n${m.message}\n</teammate-message>`;
  });
  return blocks.join('\n');
}

/**
 * s17 autonomous idle step. A teammate's idle loop calls this once per poll to
 * find work without the lead assigning it:
 *   1. Inbox has priority — it may carry a shutdown_request or a plan response.
 *      - shutdown_request -> auto-replies shutdown_response, action 'shutdown'.
 *      - other messages    -> action 'message' with the passthrough messages.
 *   2. Otherwise scan the shared task board and auto-claim the next startable,
 *      unowned task (dependency-gated by _taskStore.canStart).
 *      - claimed -> action 'claimed' with the task.
 *      - nothing -> action 'idle'.
 *
 * The runner owns the sleep/timeout cadence (s17 IDLE_POLL_INTERVAL / TIMEOUT);
 * keeping a single deterministic step here makes the decision testable.
 *
 * @param {string} teammateId
 * @param {string} [owner] claim owner (defaults to the teammate id)
 * @returns {{ action: 'shutdown'|'message'|'claimed'|'idle', task?, worktreePath?, messages?, planDecision? }}
 */
function autonomousPoll(teammateId, owner) {
  const disp = dispatchTeammateInbox(teammateId);
  if (disp.shutdown) return { action: 'shutdown' };
  if (disp.messages.length || disp.planDecision) {
    return { action: 'message', messages: disp.messages, planDecision: disp.planDecision };
  }
  let store;
  try { store = require('./_taskStore'); } catch { return { action: 'idle' }; }
  const res = store.claimNext(owner || teammateId);
  if (res && res.ok) {
    const result = { action: 'claimed', task: res.task };
    // s18 cwd-switch bridge: if the claimed task is bound to a worktree, surface
    // its absolute path so the runner can run the teammate's bash/read/write
    // inside that isolated directory instead of the shared workdir.
    if (res.task && res.task.worktree) {
      try {
        const wp = require('../services/worktreeManager').worktreePathFor(res.task.worktree);
        if (wp) result.worktreePath = wp;
      } catch { /* worktree path resolution is best-effort */ }
    }
    return result;
  }
  return { action: 'idle' };
}

/** Test-only: clear all registry, inbox, and protocol state. */
function _resetForTest() {
  _teammates.clear();
  _inboxes.clear();
  _leadInbox.length = 0;
  _pendingRequests.clear();
  _runner = null;
}

module.exports = {
  LEAD_ID,
  setTeammateRunner,
  createTeammate,
  getTeammate,
  listTeammates,
  deleteTeammate,
  sendToTeammate,
  drainTeammateInbox,
  sendToLead,
  drainLeadInbox,
  collectTeammateMessagesAsText,
  maxTeammates,
  // s16 protocols
  requestShutdown,
  requestPlanApproval,
  reviewPlan,
  matchResponse,
  dispatchTeammateInbox,
  consumeLeadInbox,
  getPendingRequest,
  listPendingRequests,
  // s17 autonomy
  autonomousPoll,
  _resetForTest,
};
