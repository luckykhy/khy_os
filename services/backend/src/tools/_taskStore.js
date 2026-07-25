/**
 * Unified task store adapter for TaskCreate/TaskUpdate/TaskList tools.
 *
 * Backed by the persistent large-task runtime store.
 */

'use strict';

const runtime = require('../tasks/largeTaskRuntimeStore');
const { buildBlockedBySuffix } = require('./taskBlockedBySuffix');

const SOURCE = 'tool_task_store';
const WORKER_ID = 'tool-task-worker';

const LEGACY_TO_CANONICAL = Object.freeze({
  pending: 'queued',
  in_progress: 'running',
  completed: 'succeeded',
  error: 'failed',
  running: 'running',
});

const CANONICAL_TO_LEGACY = Object.freeze({
  queued: 'pending',
  claimed: 'in_progress',
  running: 'in_progress',
  retry_wait: 'in_progress',
  pausing: 'in_progress',
  paused: 'in_progress',
  cancelling: 'in_progress',
  succeeded: 'completed',
  failed: 'error',
  cancelled: 'error',
  dead_letter: 'error',
});

function _legacyStatus(canonicalStatus) {
  return CANONICAL_TO_LEGACY[canonicalStatus] || 'pending';
}

function _canonicalStatus(legacyStatus) {
  return LEGACY_TO_CANONICAL[legacyStatus] || null;
}

function _toToolTask(task) {
  if (!task || !task.payload_json || task.payload_json.source !== SOURCE) return null;
  const payload = task.payload_json;
  return {
    id: task.id,
    subject: payload.subject || '',
    description: payload.description || '',
    activeForm: payload.activeForm || null,
    status: _legacyStatus(task.status),
    owner: payload.owner || null,
    blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    blockedBy: Array.isArray(payload.blockedBy) ? payload.blockedBy : [],
    output: payload.output || null,
    type: payload.type || 'task',
    // s18 worktree isolation: which isolated git worktree this task runs in.
    // null until bound; binding never changes status (see bindWorktree).
    worktree: payload.worktree || null,
    createdAt: payload.createdAt || task.created_at,
    updatedAt: payload.updatedAt || task.updated_at,
  };
}

function _assertToolTask(taskId) {
  const task = runtime.getTask(taskId);
  if (!task || !task.payload_json || task.payload_json.source !== SOURCE) return null;
  return task;
}

/**
 * Dependency gate (s12): a task may only start once every task in its
 * `blockedBy` list has completed. Mirrors Claude Code's claim-time check.
 *
 * A dependency counts as a blocker when it is missing (referenced ID does not
 * resolve to a tool task), is a self-reference, or has not reached `completed`.
 * Missing deps are treated as blocked rather than throwing, so a typo'd ID can
 * never silently unblock a task.
 *
 * @param {string} id - Task ID to evaluate
 * @returns {{ ok: boolean, blockers: string[], reason?: string }}
 */
function canStart(id) {
  const task = _assertToolTask(id);
  if (!task) return { ok: false, blockers: [], reason: 'not_found' };
  const blockedBy = Array.isArray(task.payload_json.blockedBy) ? task.payload_json.blockedBy : [];
  const blockers = [];
  for (const depId of blockedBy) {
    if (depId === id) { blockers.push(depId); continue; } // self-dependency: never satisfiable
    const dep = _assertToolTask(depId);
    if (!dep) { blockers.push(depId); continue; }          // missing dependency = blocked
    if (_legacyStatus(dep.status) !== 'completed') blockers.push(depId);
  }
  return { ok: blockers.length === 0, blockers };
}

const _LIVE_STATUSES = new Set(['claimed', 'running', 'retry_wait', 'paused', 'pausing']);

function _moveToRunning(taskId) {
  const current = runtime.getTask(taskId);
  if (!current) return null;
  if (current.status === 'running') return current;
  if (current.status === 'claimed') {
    return runtime.startTask(taskId, WORKER_ID);
  }
  if (current.status === 'retry_wait') {
    runtime.updateTaskFields(taskId, { next_run_at: new Date().toISOString() });
  }
  if (current.status === 'queued' || current.status === 'retry_wait') {
    runtime.claimTask(taskId, WORKER_ID, { leaseMs: 30_000 });
    return runtime.startTask(taskId, WORKER_ID);
  }
  if (current.status === 'paused') {
    return runtime.transitionTask(taskId, 'running');
  }
  if (current.status === 'pausing') {
    runtime.transitionTask(taskId, 'paused');
    return runtime.transitionTask(taskId, 'running');
  }
  if (current.status === 'cancelling') {
    throw new Error(`Cannot move cancelling task to running: ${taskId}`);
  }
  if (current.status === 'succeeded' || current.status === 'failed' || current.status === 'cancelled' || current.status === 'dead_letter') {
    throw new Error(`Terminal task cannot run: ${taskId}`);
  }
  return current;
}

function add(task) {
  if (!task || !task.id) throw new Error('Task must have an id');
  const status = _canonicalStatus(task.status || 'pending') || 'queued';
  const payload = {
    source: SOURCE,
    type: task.type || 'task',
    subject: task.subject || '',
    description: task.description || '',
    activeForm: task.activeForm || null,
    owner: task.owner || null,
    blocks: Array.isArray(task.blocks) ? task.blocks : [],
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy : [],
    output: task.output || null,
    worktree: task.worktree || null,
    createdAt: task.createdAt || new Date().toISOString(),
    updatedAt: task.updatedAt || new Date().toISOString(),
  };

  runtime.createTask({
    id: task.id,
    type: 'tool_task',
    payload_json: payload,
    priority: 100,
    max_attempts: 1,
    idempotency_key: task.idempotencyKey || null,
  });

  if (status === 'running') {
    _moveToRunning(task.id);
  } else if (status === 'succeeded') {
    _moveToRunning(task.id);
    runtime.markSucceeded(task.id, WORKER_ID, null, { progress_pct: 100 });
  } else if (status === 'failed') {
    _moveToRunning(task.id);
    runtime.transitionTask(task.id, 'failed', {
      last_error: { type: 'tool_error', message: 'Task marked as error' },
    });
  }
}

function get(id) {
  const task = _assertToolTask(id);
  return task ? _toToolTask(task) : undefined;
}

function getTask(id) {
  const task = _assertToolTask(id);
  if (!task) return undefined;
  const mapped = _toToolTask(task);
  // TaskOutputTool historically waits on "running".
  if (mapped.status === 'in_progress') mapped.status = 'running';
  return mapped;
}

function update(id, updates = {}) {
  const existing = _assertToolTask(id);
  if (!existing) return null;

  const nextPayload = {
    ...(existing.payload_json || {}),
  };

  if (updates.description !== undefined) nextPayload.description = updates.description;
  if (updates.activeForm !== undefined) nextPayload.activeForm = updates.activeForm;
  if (updates.subject !== undefined) nextPayload.subject = updates.subject;
  if (updates.owner !== undefined) nextPayload.owner = updates.owner || null;
  if (updates.output !== undefined) nextPayload.output = updates.output;
  if (updates.blocks !== undefined) nextPayload.blocks = Array.isArray(updates.blocks) ? updates.blocks : [];
  if (updates.blockedBy !== undefined) nextPayload.blockedBy = Array.isArray(updates.blockedBy) ? updates.blockedBy : [];
  if (updates.worktree !== undefined) nextPayload.worktree = updates.worktree || null;
  nextPayload.updatedAt = new Date().toISOString();
  runtime.updateTaskFields(id, { payload_json: nextPayload });

  if (updates.status) {
    const status = _canonicalStatus(updates.status);
    if (!status) throw new Error(`Invalid task status: ${updates.status}`);

    if (status === 'queued') {
      const latest = runtime.getTask(id);
      if (latest && latest.status === 'retry_wait') {
        runtime.updateTaskFields(id, { next_run_at: new Date().toISOString() });
      } else if (latest && latest.status !== 'queued') {
        throw new Error(`Cannot move task ${id} to pending from ${latest.status}`);
      }
    } else if (status === 'running') {
      // s12 dependency gate: refuse to start a task whose blockers are not yet
      // completed. Only enforced on a fresh start (not when the task is already
      // live), so idempotent in_progress updates (e.g. activeForm edits) pass.
      const latest = runtime.getTask(id);
      if (!latest || !_LIVE_STATUSES.has(latest.status)) {
        const gate = canStart(id);
        if (!gate.ok) {
          throw new Error(`Task ${id} is blocked by incomplete dependencies: ${gate.blockers.join(', ')}`);
        }
      }
      _moveToRunning(id);
    } else if (status === 'succeeded') {
      _moveToRunning(id);
      runtime.markSucceeded(id, WORKER_ID, null, { progress_pct: 100 });
    } else if (status === 'failed') {
      _moveToRunning(id);
      runtime.transitionTask(id, 'failed', {
        last_error: { type: 'tool_error', message: 'Task marked as error' },
      });
    }
  }

  return get(id);
}

function list(statusFilter) {
  const canonical = _canonicalStatus(statusFilter || '');
  let tasks = runtime.listTasks({ source: SOURCE });
  if (statusFilter) {
    if (canonical === 'running') {
      const live = new Set(['claimed', 'running', 'retry_wait', 'paused', 'pausing', 'cancelling']);
      tasks = tasks.filter((task) => live.has(task.status));
    } else if (canonical === 'queued') {
      tasks = tasks.filter((task) => task.status === 'queued');
    } else if (canonical === 'succeeded') {
      tasks = tasks.filter((task) => task.status === 'succeeded');
    } else if (canonical === 'failed') {
      tasks = tasks.filter((task) => task.status === 'failed' || task.status === 'cancelled' || task.status === 'dead_letter');
    } else {
      tasks = [];
    }
  }
  return tasks.map(_toToolTask).filter(Boolean);
}

function listTasks(statusFilter) {
  return list(statusFilter);
}

function remove(id) {
  const task = _assertToolTask(id);
  if (!task) return false;
  return runtime.deleteTask(id);
}

function stopTask(id) {
  const task = _assertToolTask(id);
  if (!task) return false;
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'dead_letter') {
    return false;
  }
  runtime.cancelTask(id, 'Stopped by TaskStop tool');
  return true;
}

function clear() {
  const tasks = runtime.listTasks({ source: SOURCE });
  for (const task of tasks) {
    runtime.deleteTask(task.id);
  }
}

function count() {
  return runtime.listTasks({ source: SOURCE }).length;
}

/**
 * 生成当前任务的结构化快照文本。
 * 用于上下文压缩时注入摘要，确保 AI 在压缩后仍能看到任务进度。
 *
 * 统一快照通道：合并 V2 依赖图任务 + V1 TodoWrite 清单，避免 V1 todo
 * 在压缩后从上下文消失（V1 原本只写不外露）。
 *
 * @returns {string} 可读的任务清单，空字符串表示无任务
 */
function snapshot() {
  const tasks = list();
  // CC TaskListV2 openBlockers parity: a dependency that has already completed
  // is no longer blocking — drop it from the "blocked by" annotation so the line
  // reflects only the deps STILL gating this task. Built once over the full set.
  const completedIds = new Set(
    tasks.filter(t => t.status === 'completed').map(t => String(t.id)),
  );
  const v2 = tasks.map(t => {
    const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
    const blocked = buildBlockedBySuffix(t.blockedBy, completedIds, process.env);
    // CC parity: while in_progress, surface the present-continuous activeForm
    // ("Fixing auth bug") as the running-task label instead of the static subject.
    if (t.status === 'in_progress' && t.activeForm) {
      return `${icon} #${t.id} ${t.activeForm}${blocked}`;
    }
    const desc = t.description ? ` — ${t.description.slice(0, 80)}` : '';
    return `${icon} #${t.id} ${t.subject || '(untitled)'}${blocked}${desc}`;
  });

  // Fold in V1 TodoWrite checklist (lazy-require to avoid load-order coupling).
  let v1 = '';
  try {
    const TodoWriteTool = require('./TodoWriteTool');
    if (typeof TodoWriteTool.snapshot === 'function') v1 = TodoWriteTool.snapshot();
  } catch { /* TodoWrite tool unavailable — V2-only snapshot */ }

  const parts = [];
  if (v2.length) parts.push(v2.join('\n'));
  if (v1) parts.push(v1);
  return parts.join('\n');
}

/**
 * Current activity label for status surfaces (spinner / status line).
 *
 * Returns the in_progress task's activeForm — the CC present-continuous label
 * ("Fixing auth bug") — falling back to its subject, or '' when nothing is
 * running. This is the consumer-facing hook that makes activeForm a live field
 * rather than a write-only one.
 *
 * @returns {string}
 */
function currentActivity() {
  const active = list().find(t => t.status === 'in_progress');
  if (!active) return '';
  return active.activeForm || active.subject || '';
}

/**
 * Claim a task for an owner (s12 multi-agent coordination).
 *
 * Combines ownership acquisition with starting work, mirroring the teaching
 * version's `claim_task`: pending → in_progress with `owner` set. Rejections are
 * structured (never thrown) so a coordinating agent can react:
 *   - not_found        : no such tool task
 *   - already_resolved : task is already completed
 *   - already_claimed  : a different owner already holds it
 *   - blocked          : an upstream dependency is not yet completed
 *
 * Re-claiming by the SAME owner is idempotent. A task whose owner was cleared
 * (see release) can be re-claimed by anyone.
 *
 * @param {string} id - Task ID to claim
 * @param {string} [owner='agent'] - Claiming agent identifier
 * @returns {{ ok: boolean, reason?: string, owner?: string, blockers?: string[], task?: object }}
 */
function claim(id, owner = 'agent') {
  const existing = _assertToolTask(id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const tool = _toToolTask(existing);

  if (tool.status === 'completed') return { ok: false, reason: 'already_resolved' };
  if (tool.owner && tool.owner !== owner) {
    return { ok: false, reason: 'already_claimed', owner: tool.owner };
  }

  const gate = canStart(id);
  if (!gate.ok) return { ok: false, reason: 'blocked', blockers: gate.blockers };

  update(id, { owner, status: 'in_progress' });
  return { ok: true, owner, task: get(id) };
}

/**
 * Release a task's ownership so another agent can reclaim it (s12 recovery path
 * for a terminated / stalled teammate — CC unassigns unfinished tasks).
 *
 * Clears the `owner` field. The runtime state machine has no running → queued
 * edge, so the status is left intact; an unowned non-terminal task is reclaimable
 * via claim(). When `expectedOwner` is given, the release is a no-op unless it
 * matches the current owner (prevents one agent from releasing another's task).
 *
 * @param {string} id - Task ID to release
 * @param {string} [expectedOwner] - If set, only release when this owner holds it
 * @returns {{ ok: boolean, reason?: string, owner?: string, task?: object }}
 */
function release(id, expectedOwner) {
  const existing = _assertToolTask(id);
  if (!existing) return { ok: false, reason: 'not_found' };
  const tool = _toToolTask(existing);
  if (tool.status === 'completed') return { ok: false, reason: 'already_resolved' };
  if (expectedOwner !== undefined && tool.owner && tool.owner !== expectedOwner) {
    return { ok: false, reason: 'owner_mismatch', owner: tool.owner };
  }
  update(id, { owner: null });
  return { ok: true, task: get(id) };
}

/**
 * s17 autonomous discovery: list every task a teammate may claim right now —
 * pending, unowned, and startable (all `blockedBy` completed). Mirrors the
 * teaching version's `scan_unclaimed_tasks`. Ordered oldest-first by createdAt
 * so claiming is deterministic and the longest-waiting task goes first.
 *
 * @returns {object[]} claimable tool tasks
 */
function scanUnclaimed() {
  return list('pending')
    .filter((t) => !t.owner)
    .filter((t) => canStart(t.id).ok)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

/**
 * s17 auto-claim: scan the board and claim the first available task for `owner`.
 *
 * The AI-facing task surface is in-process, so scan+claim is not a cross-process
 * atomic CAS (that lives in coordinator/taskBoard's SQLite path). The owner
 * check inside claim() still rejects a racing second claimer, so the worst case
 * is "skip and try the next candidate" — never two owners on one task.
 *
 * @param {string} [owner='agent']
 * @returns {{ ok: boolean, task?: object, reason?: string }}
 */
function claimNext(owner = 'agent') {
  for (const candidate of scanUnclaimed()) {
    const res = claim(candidate.id, owner);
    if (res.ok) return { ok: true, task: res.task };
  }
  return { ok: false, reason: 'none_available' };
}

/**
 * s18 task<->worktree binding: record which isolated git worktree a task should
 * run in, WITHOUT changing its status. The s18 invariant is that binding only
 * answers "where", never "when" — the task stays pending/queued so a teammate
 * still claims it through the normal board flow. Mirrors the teaching version's
 * bind_task_to_worktree.
 *
 * The worktree name is validated with the SAME path-traversal-safe rule the
 * worktree manager enforces, so a name that could escape .khy/worktrees/ can
 * never be persisted onto a task. Validation is best-effort: if the manager is
 * unavailable the binding still proceeds (the manager re-validates at create).
 *
 * @param {string} taskId
 * @param {string} worktreeName
 * @returns {{ ok: boolean, reason?: string, task?: object }}
 */
function bindWorktree(taskId, worktreeName) {
  const existing = _assertToolTask(taskId);
  if (!existing) return { ok: false, reason: 'not_found' };
  if (!worktreeName || !String(worktreeName).trim()) {
    return { ok: false, reason: 'invalid_name' };
  }
  let validateName = null;
  // Pure validator from the zero-dep leaf — avoids a require cycle back into
  // worktreeManager (DESIGN-ARCH-020, R3).
  try { ({ validateName } = require('../utils/worktreeName')); } catch { /* optional */ }
  if (typeof validateName === 'function' && !validateName(worktreeName)) {
    return { ok: false, reason: 'invalid_name' };
  }
  // No status in the update -> status stays put (the binding invariant).
  update(taskId, { worktree: String(worktreeName) });
  return { ok: true, task: get(taskId) };
}

module.exports = { add, get, getTask, update, list, listTasks, canStart, claim, release, scanUnclaimed, claimNext, bindWorktree, remove, stopTask, clear, count, snapshot, currentActivity };
