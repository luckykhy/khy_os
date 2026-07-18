'use strict';

/**
 * Background Task Manager
 *
 * Public API remains compatible with existing callers, but task state is now
 * persisted in the canonical large-task runtime store.
 */

const runtime = require('../tasks/largeTaskRuntimeStore');

const TERMINAL_TASK_TTL_MS = 5 * 60 * 1000;
const MAX_TASKS = 100;
const CLEANUP_INTERVAL_MS = 60 * 1000;

const SOURCE = 'background_task_manager';
const WORKER_ID = 'background-task-manager';

const TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled']);

/** @type {Map<string, AbortController>} */
const _abortControllers = new Map();
/** @type {Function[]} */
const _listeners = [];

let _cleanupTimer = null;
let _nextId = 1;

function _canonicalToLegacyStatus(status) {
  switch (status) {
    case 'queued':
      return 'pending';
    case 'claimed':
    case 'running':
    case 'retry_wait':
    case 'pausing':
    case 'cancelling':
      return 'running';
    case 'paused':
      return 'paused';
    case 'succeeded':
      return 'completed';
    case 'failed':
    case 'dead_letter':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'pending';
  }
}

function _legacyToCanonicalStatus(status) {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'paused':
      return 'paused';
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return null;
  }
}

function _toLegacyTask(task) {
  if (!task || !task.payload_json || task.payload_json.source !== SOURCE) return null;
  const payload = task.payload_json;
  const createdAtMs = Date.parse(task.created_at);
  const updatedAtMs = Date.parse(task.updated_at);
  const completedAtMs = task.completed_at ? Date.parse(task.completed_at) : null;
  return {
    id: task.id,
    type: payload.type || task.type || 'generic',
    state: _canonicalToLegacyStatus(task.status),
    label: payload.label || task.id,
    createdAt: Number.isFinite(createdAtMs) ? createdAtMs : Date.now(),
    updatedAt: Number.isFinite(updatedAtMs) ? updatedAtMs : Date.now(),
    completedAt: Number.isFinite(completedAtMs) ? completedAtMs : null,
    result: payload.result ?? task.last_result ?? null,
    error: payload.error ?? task.last_error?.message ?? null,
    meta: payload.meta || {},
  };
}

function _listManagedTasks(filter = {}) {
  let tasks = runtime.listTasks({ source: SOURCE });
  if (filter.type) tasks = tasks.filter((task) => (task.payload_json?.type || task.type) === filter.type);
  if (filter.state) {
    const canonical = _legacyToCanonicalStatus(filter.state);
    if (canonical === 'running') {
      const active = new Set(['claimed', 'running', 'retry_wait', 'pausing', 'cancelling']);
      tasks = tasks.filter((task) => active.has(task.status));
    } else if (canonical === 'failed') {
      tasks = tasks.filter((task) => task.status === 'failed' || task.status === 'dead_letter');
    } else if (canonical) {
      tasks = tasks.filter((task) => task.status === canonical);
    } else {
      tasks = [];
    }
  }
  return tasks;
}

function _emit(event, task) {
  for (const listener of _listeners) {
    try {
      listener(event, task);
    } catch {
      // Ignore listener failures
    }
  }
}

function _ensureCleanup() {
  if (_cleanupTimer) return;
  _cleanupTimer = setInterval(_runCleanup, CLEANUP_INTERVAL_MS);
  if (_cleanupTimer.unref) _cleanupTimer.unref();
}

function _runCleanup() {
  const now = Date.now();
  const tasks = _listManagedTasks();
  for (const task of tasks) {
    const legacy = _toLegacyTask(task);
    if (!legacy) continue;
    if (!TERMINAL_STATES.has(legacy.state)) continue;
    if (!legacy.completedAt) continue;
    if ((now - legacy.completedAt) <= TERMINAL_TASK_TTL_MS) continue;
    runtime.deleteTask(task.id);
    _abortControllers.delete(task.id);
  }
}

function _evictIfNeeded() {
  const tasks = _listManagedTasks();
  if (tasks.length < MAX_TASKS) return;

  const removable = tasks
    .filter((task) => {
      const legacy = _toLegacyTask(task);
      return Boolean(legacy && TERMINAL_STATES.has(legacy.state) && legacy.completedAt);
    })
    .sort((a, b) => Date.parse(a.completed_at || a.updated_at) - Date.parse(b.completed_at || b.updated_at));

  for (const task of removable) {
    runtime.deleteTask(task.id);
    _abortControllers.delete(task.id);
    if (_listManagedTasks().length < MAX_TASKS) break;
  }
}

function _updatePayload(id, patch = {}) {
  const task = runtime.getTask(id);
  if (!task) return null;
  const payload = {
    ...(task.payload_json || {}),
    ...patch,
  };
  runtime.updateTaskFields(id, { payload_json: payload });
  return runtime.getTask(id);
}

function register(params = {}) {
  _ensureCleanup();
  _evictIfNeeded();

  // Generate a unique ID, skipping any that already exist in the runtime store
  // (can happen when the store persists across sessions but _nextId resets).
  let id;
  do {
    id = `bg_${_nextId++}`;
  } while (runtime.getTask(id));
  const nowIso = new Date().toISOString();

  runtime.createTask({
    id,
    type: 'background_task',
    max_attempts: 1,
    payload_json: {
      source: SOURCE,
      type: params.type || 'generic',
      label: params.label || id,
      meta: params.meta || {},
      result: null,
      error: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      completedAt: null,
    },
  });

  runtime.claimTask(id, WORKER_ID, { leaseMs: 120_000 });
  runtime.startTask(id, WORKER_ID);

  const controller = new AbortController();
  _abortControllers.set(id, controller);

  const legacy = _toLegacyTask(runtime.getTask(id));
  _emit('created', legacy);

  return {
    task: legacy,
    signal: controller.signal,
    release: () => complete(id),
  };
}

function pause(id) {
  const task = runtime.getTask(id);
  if (!task || task.payload_json?.source !== SOURCE) {
    return { success: false, error: 'Task not found' };
  }
  const state = _canonicalToLegacyStatus(task.status);
  if (state !== 'running') return { success: false, error: `Cannot pause task in state: ${state}` };

  runtime.transitionTask(id, 'pausing');
  runtime.transitionTask(id, 'paused');
  const updated = _toLegacyTask(runtime.getTask(id));
  _emit('paused', updated);
  return { success: true };
}

function resume(id) {
  const task = runtime.getTask(id);
  if (!task || task.payload_json?.source !== SOURCE) {
    return { success: false, error: 'Task not found' };
  }
  const state = _canonicalToLegacyStatus(task.status);
  if (state !== 'paused') return { success: false, error: `Cannot resume task in state: ${state}` };

  runtime.transitionTask(id, 'running', {
    heartbeat_at: new Date().toISOString(),
  });

  if (!_abortControllers.has(id)) {
    _abortControllers.set(id, new AbortController());
  }

  const updated = _toLegacyTask(runtime.getTask(id));
  _emit('resumed', updated);
  return { success: true, signal: _abortControllers.get(id)?.signal };
}

function cancel(id, reason) {
  const task = runtime.getTask(id);
  if (!task || task.payload_json?.source !== SOURCE) {
    return { success: false, error: 'Task not found' };
  }
  const state = _canonicalToLegacyStatus(task.status);
  if (TERMINAL_STATES.has(state)) {
    return { success: false, error: `Task already in terminal state: ${state}` };
  }

  const controller = _abortControllers.get(id);
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error(reason || 'Task cancelled'));
  }

  runtime.cancelTask(id, reason || 'Cancelled by user');
  _updatePayload(id, {
    error: reason || 'Cancelled by user',
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const updated = _toLegacyTask(runtime.getTask(id));
  _emit('cancelled', updated);
  return { success: true };
}

function complete(id, result) {
  const task = runtime.getTask(id);
  if (!task || task.payload_json?.source !== SOURCE) return { success: false };
  const state = _canonicalToLegacyStatus(task.status);
  if (TERMINAL_STATES.has(state)) return { success: false };

  runtime.markSucceeded(id, WORKER_ID, result ?? null, { progress_pct: 100 });
  _updatePayload(id, {
    result: result ?? null,
    error: null,
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  _abortControllers.delete(id);
  const updated = _toLegacyTask(runtime.getTask(id));
  _emit('completed', updated);
  return { success: true };
}

function fail(id, error) {
  const task = runtime.getTask(id);
  if (!task || task.payload_json?.source !== SOURCE) return { success: false };
  const state = _canonicalToLegacyStatus(task.status);
  if (TERMINAL_STATES.has(state)) return { success: false };

  runtime.transitionTask(id, 'failed', {
    last_error: {
      type: 'background_task_failed',
      message: String(error || 'background task failed'),
    },
  });
  _updatePayload(id, {
    error: String(error || 'background task failed'),
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  _abortControllers.delete(id);
  const updated = _toLegacyTask(runtime.getTask(id));
  _emit('failed', updated);
  return { success: true };
}

function get(id) {
  const task = runtime.getTask(id);
  return _toLegacyTask(task);
}

function listAll(filter = {}) {
  return _listManagedTasks(filter).map(_toLegacyTask).filter(Boolean);
}

function getCounts() {
  const counts = { running: 0, paused: 0, completed: 0, failed: 0, cancelled: 0, pending: 0 };
  const tasks = listAll();
  for (const task of tasks) {
    counts[task.state] = (counts[task.state] || 0) + 1;
  }
  return counts;
}

function onEvent(listener) {
  _listeners.push(listener);
  return () => {
    const idx = _listeners.indexOf(listener);
    if (idx >= 0) _listeners.splice(idx, 1);
  };
}

function reset() {
  for (const [id, controller] of _abortControllers) {
    if (!controller.signal.aborted) controller.abort();
    _abortControllers.delete(id);
  }

  const tasks = _listManagedTasks();
  for (const task of tasks) {
    runtime.deleteTask(task.id);
  }

  _listeners.length = 0;
  if (_cleanupTimer) {
    clearInterval(_cleanupTimer);
    _cleanupTimer = null;
  }
  _nextId = 1;
}

module.exports = {
  register,
  pause,
  resume,
  cancel,
  complete,
  fail,
  get,
  listAll,
  getCounts,
  onEvent,
  reset,
  TERMINAL_TASK_TTL_MS,
  MAX_TASKS,
};
