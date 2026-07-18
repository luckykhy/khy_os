/**
 * Task Store (legacy API) backed by the canonical large-task runtime store.
 */
'use strict';

const { EventEmitter } = require('events');
const {
  generateTaskId,
  isValidTaskType,
} = require('./index');
const { initTaskOutput, cleanupTaskOutput } = require('./diskOutput');
const runtime = require('./largeTaskRuntimeStore');

const TERMINAL_TASK_TTL = 5 * 60 * 1000;
const MAX_TASKS = 500;
const SOURCE = 'legacy_task_store';
const WORKER_ID = 'legacy-task-store';

const LEGACY_TO_CANONICAL = Object.freeze({
  pending: 'queued',
  running: 'running',
  completed: 'succeeded',
  failed: 'failed',
  killed: 'cancelled',
});

const CANONICAL_TO_LEGACY = Object.freeze({
  queued: 'pending',
  claimed: 'running',
  running: 'running',
  retry_wait: 'running',
  pausing: 'running',
  paused: 'running',
  cancelling: 'running',
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'killed',
  dead_letter: 'failed',
});

const _emitter = new EventEmitter();
_emitter.setMaxListeners(50);
let _evictionTimer = null;

function _isManaged(task) {
  return Boolean(task && task.payload_json && task.payload_json.source === SOURCE);
}

function _legacyStatus(task) {
  return CANONICAL_TO_LEGACY[task.status] || 'pending';
}

function _toLegacyTask(task) {
  if (!_isManaged(task)) return null;
  const payload = task.payload_json || {};
  return {
    id: task.id,
    type: payload.type || task.type,
    status: _legacyStatus(task),
    description: payload.description || '',
    subject: payload.subject || payload.description || '',
    activeForm: payload.activeForm || null,
    toolUseId: payload.toolUseId || null,
    startTime: payload.startTime || Date.parse(task.created_at),
    endTime: task.completed_at ? Date.parse(task.completed_at) : null,
    totalPausedMs: payload.totalPausedMs || 0,
    outputFile: payload.outputFile || null,
    outputOffset: payload.outputOffset || 0,
    notified: Boolean(payload.notified),
    blocks: Array.isArray(payload.blocks) ? payload.blocks : [],
    blockedBy: Array.isArray(payload.blockedBy) ? payload.blockedBy : [],
    owner: payload.owner || null,
    error: payload.error || (task.last_error ? task.last_error.message : null),
  };
}

function _getManagedTask(taskId) {
  const task = runtime.getTask(taskId);
  return _isManaged(task) ? task : null;
}

function _setPayload(taskId, mutator) {
  const task = _getManagedTask(taskId);
  if (!task) return null;
  const payload = { ...(task.payload_json || {}) };
  mutator(payload, task);
  runtime.updateTaskFields(taskId, {
    payload_json: payload,
    last_error: payload.error ? { type: 'legacy_task_error', message: String(payload.error) } : task.last_error,
  });
  return _getManagedTask(taskId);
}

function _moveToRunning(taskId) {
  const task = _getManagedTask(taskId);
  if (!task) return null;
  if (task.status === 'running') return task;
  if (task.status === 'claimed') return runtime.startTask(taskId, WORKER_ID);
  if (task.status === 'retry_wait') {
    runtime.updateTaskFields(taskId, { next_run_at: new Date().toISOString() });
  }
  if (task.status === 'queued' || task.status === 'retry_wait') {
    runtime.claimTask(taskId, WORKER_ID, { leaseMs: 60_000 });
    return runtime.startTask(taskId, WORKER_ID);
  }
  if (task.status === 'paused') return runtime.transitionTask(taskId, 'running');
  if (task.status === 'pausing') {
    runtime.transitionTask(taskId, 'paused');
    return runtime.transitionTask(taskId, 'running');
  }
  if (task.status === 'cancelling') throw new Error(`Cannot run cancelling task: ${taskId}`);
  if (task.status === 'succeeded' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'dead_letter') {
    throw new Error(`Cannot run terminal task: ${taskId}`);
  }
  return task;
}

function _allTasks() {
  return runtime.listTasks({ source: SOURCE });
}

function _isTerminalLegacy(status) {
  return status === 'completed' || status === 'failed' || status === 'killed';
}

function _evictOldestTerminal() {
  let oldest = null;
  let oldestTime = Number.POSITIVE_INFINITY;
  for (const task of _allTasks()) {
    const legacy = _toLegacyTask(task);
    if (!legacy || !_isTerminalLegacy(legacy.status) || !legacy.endTime) continue;
    if (legacy.endTime < oldestTime) {
      oldest = legacy.id;
      oldestTime = legacy.endTime;
    }
  }
  if (oldest) {
    deleteTask(oldest);
  }
}

function _scheduleEviction() {
  if (_evictionTimer) return;
  _evictionTimer = setInterval(() => {
    const now = Date.now();
    const all = _allTasks();
    for (const task of all) {
      const legacy = _toLegacyTask(task);
      if (!legacy || !_isTerminalLegacy(legacy.status) || !legacy.endTime) continue;
      if ((now - legacy.endTime) > TERMINAL_TASK_TTL) {
        deleteTask(legacy.id);
      }
    }

    const hasTerminal = _allTasks().some((task) => {
      const legacy = _toLegacyTask(task);
      return legacy && _isTerminalLegacy(legacy.status);
    });
    if (!hasTerminal && _evictionTimer) {
      clearInterval(_evictionTimer);
      _evictionTimer = null;
    }
  }, 60_000);

  if (_evictionTimer.unref) _evictionTimer.unref();
}

function createTask(description, type, options = {}) {
  if (!isValidTaskType(type)) {
    throw new Error(`Invalid task type: ${type}`);
  }
  if (_allTasks().length >= MAX_TASKS) {
    _evictOldestTerminal();
  }

  const id = generateTaskId(type);
  const startTime = Date.now();

  try {
    initTaskOutput(id);
  } catch {
    // Best effort.
  }

  runtime.createTask({
    id,
    type,
    max_attempts: 1,
    payload_json: {
      source: SOURCE,
      type,
      description,
      subject: options.subject || description,
      activeForm: options.activeForm || null,
      toolUseId: options.toolUseId || null,
      startTime,
      totalPausedMs: 0,
      outputFile: null,
      outputOffset: 0,
      notified: false,
      blocks: [],
      blockedBy: [],
      owner: null,
      error: null,
    },
  });

  const task = _toLegacyTask(_getManagedTask(id));
  _emitter.emit('created', { taskId: id, task });
  _emitter.emit('change', { type: 'created', taskId: id, task });
  _scheduleEviction();
  return task;
}

function getTask(id) {
  const task = _getManagedTask(id);
  return task ? _toLegacyTask(task) : null;
}

function listTasks(filter = {}) {
  let tasks = _allTasks().map(_toLegacyTask).filter(Boolean);
  if (filter.status) tasks = tasks.filter((task) => task.status === filter.status);
  if (filter.type) tasks = tasks.filter((task) => task.type === filter.type);
  if (filter.owner) tasks = tasks.filter((task) => task.owner === filter.owner);
  return tasks;
}

function getTaskSummary() {
  const tasks = listTasks();
  const summary = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    killed: 0,
    tasks: [],
  };
  for (const task of tasks) {
    summary[task.status] = (summary[task.status] || 0) + 1;
    summary.tasks.push({
      id: task.id,
      type: task.type,
      status: task.status,
      subject: task.subject,
      description: task.description,
      startTime: task.startTime,
      endTime: task.endTime,
      owner: task.owner,
      blocks: task.blocks,
      blockedBy: task.blockedBy,
    });
  }
  return summary;
}

function _mutateDependencyMirror(taskId, patch = {}) {
  const currentTask = _getManagedTask(taskId);
  if (!currentTask) return null;
  let payload = { ...(currentTask.payload_json || {}) };
  payload.blocks = Array.isArray(payload.blocks) ? payload.blocks.slice() : [];
  payload.blockedBy = Array.isArray(payload.blockedBy) ? payload.blockedBy.slice() : [];

  if (patch.addBlocks) {
    const ids = Array.isArray(patch.addBlocks) ? patch.addBlocks : [patch.addBlocks];
    for (const id of ids) {
      if (!payload.blocks.includes(id)) payload.blocks.push(id);
      _setPayload(id, (blockedPayload) => {
        blockedPayload.blockedBy = Array.isArray(blockedPayload.blockedBy) ? blockedPayload.blockedBy : [];
        if (!blockedPayload.blockedBy.includes(taskId)) blockedPayload.blockedBy.push(taskId);
      });
    }
  }

  if (patch.addBlockedBy) {
    const ids = Array.isArray(patch.addBlockedBy) ? patch.addBlockedBy : [patch.addBlockedBy];
    for (const id of ids) {
      if (!payload.blockedBy.includes(id)) payload.blockedBy.push(id);
      _setPayload(id, (blockerPayload) => {
        blockerPayload.blocks = Array.isArray(blockerPayload.blocks) ? blockerPayload.blocks : [];
        if (!blockerPayload.blocks.includes(taskId)) blockerPayload.blocks.push(taskId);
      });
    }
  }

  if (patch.removeBlocks) {
    const ids = Array.isArray(patch.removeBlocks) ? patch.removeBlocks : [patch.removeBlocks];
    payload.blocks = payload.blocks.filter((id) => !ids.includes(id));
    for (const id of ids) {
      _setPayload(id, (blockedPayload) => {
        blockedPayload.blockedBy = Array.isArray(blockedPayload.blockedBy) ? blockedPayload.blockedBy : [];
        blockedPayload.blockedBy = blockedPayload.blockedBy.filter((v) => v !== taskId);
      });
    }
  }

  if (patch.removeBlockedBy) {
    const ids = Array.isArray(patch.removeBlockedBy) ? patch.removeBlockedBy : [patch.removeBlockedBy];
    payload.blockedBy = payload.blockedBy.filter((id) => !ids.includes(id));
    for (const id of ids) {
      _setPayload(id, (blockerPayload) => {
        blockerPayload.blocks = Array.isArray(blockerPayload.blocks) ? blockerPayload.blocks : [];
        blockerPayload.blocks = blockerPayload.blocks.filter((v) => v !== taskId);
      });
    }
  }

  runtime.updateTaskFields(taskId, { payload_json: payload });
  return _getManagedTask(taskId);
}

function updateTask(id, updates = {}) {
  const current = _getManagedTask(id);
  if (!current) return null;

  const prev = _toLegacyTask(current);
  const prevStatus = prev.status;

  if (_isTerminalLegacy(prevStatus) && updates.status === undefined && !Object.prototype.hasOwnProperty.call(updates, 'notified')) {
    return prev;
  }

  _setPayload(id, (payload) => {
    if (updates.subject !== undefined) payload.subject = updates.subject;
    if (updates.description !== undefined) payload.description = updates.description;
    if (updates.activeForm !== undefined) payload.activeForm = updates.activeForm;
    if (updates.owner !== undefined) payload.owner = updates.owner;
    if (updates.error !== undefined) payload.error = updates.error;
    if (updates.notified !== undefined) payload.notified = Boolean(updates.notified);
    if (updates.outputOffset !== undefined) payload.outputOffset = updates.outputOffset;
  });

  _mutateDependencyMirror(id, {
    addBlocks: updates.addBlocks,
    addBlockedBy: updates.addBlockedBy,
    removeBlocks: updates.removeBlocks,
    removeBlockedBy: updates.removeBlockedBy,
  });

  if (updates.status !== undefined) {
    const target = LEGACY_TO_CANONICAL[updates.status];
    if (!target) {
      throw new Error(`Invalid status: ${updates.status}`);
    }
    if (target === 'queued') {
      const latest = _getManagedTask(id);
      if (!latest) return null;
      if (latest.status === 'retry_wait') {
        runtime.updateTaskFields(id, { next_run_at: new Date().toISOString() });
      } else if (latest.status !== 'queued') {
        throw new Error(`Cannot move task ${id} to pending from ${latest.status}`);
      }
    } else if (target === 'running') {
      _moveToRunning(id);
    } else if (target === 'succeeded') {
      _moveToRunning(id);
      runtime.markSucceeded(id, WORKER_ID, null, { progress_pct: 100 });
    } else if (target === 'failed') {
      _moveToRunning(id);
      runtime.transitionTask(id, 'failed', {
        last_error: { type: 'task_failed', message: updates.error || 'Task failed' },
      });
    } else if (target === 'cancelled') {
      runtime.cancelTask(id, updates.error || 'Task killed');
    }
  }

  const updatedTask = _toLegacyTask(_getManagedTask(id));
  _emitter.emit('updated', { taskId: id, task: updatedTask, prev });
  _emitter.emit('change', { type: 'updated', taskId: id, task: updatedTask, prev });
  return updatedTask;
}

function deleteTask(id) {
  const task = getTask(id);
  if (!task) return false;

  for (const blockId of task.blocks) {
    _setPayload(blockId, (blockedPayload) => {
      blockedPayload.blockedBy = Array.isArray(blockedPayload.blockedBy) ? blockedPayload.blockedBy : [];
      blockedPayload.blockedBy = blockedPayload.blockedBy.filter((v) => v !== id);
    });
  }
  for (const blockerId of task.blockedBy) {
    _setPayload(blockerId, (blockerPayload) => {
      blockerPayload.blocks = Array.isArray(blockerPayload.blocks) ? blockerPayload.blocks : [];
      blockerPayload.blocks = blockerPayload.blocks.filter((v) => v !== id);
    });
  }

  runtime.deleteTask(id);
  try {
    cleanupTaskOutput(id);
  } catch {
    // Best effort.
  }

  _emitter.emit('deleted', { taskId: id, task });
  _emitter.emit('change', { type: 'deleted', taskId: id, task });
  return true;
}

function killAllRunning() {
  const killed = [];
  for (const task of listTasks({ status: 'running' })) {
    runtime.cancelTask(task.id, 'Killed by killAllRunning');
    killed.push(task.id);
  }
  return killed;
}

function clearTerminal() {
  let count = 0;
  for (const task of listTasks()) {
    if (_isTerminalLegacy(task.status)) {
      deleteTask(task.id);
      count++;
    }
  }
  return count;
}

function reset() {
  for (const task of listTasks()) {
    deleteTask(task.id);
  }
  if (_evictionTimer) {
    clearInterval(_evictionTimer);
    _evictionTimer = null;
  }
}

function on(event, listener) {
  _emitter.on(event, listener);
  return () => _emitter.off(event, listener);
}

function once(event, listener) {
  _emitter.once(event, listener);
}

module.exports = {
  createTask,
  getTask,
  listTasks,
  getTaskSummary,
  updateTask,
  deleteTask,
  killAllRunning,
  clearTerminal,
  reset,
  on,
  once,
  TERMINAL_TASK_TTL,
  MAX_TASKS,
};
