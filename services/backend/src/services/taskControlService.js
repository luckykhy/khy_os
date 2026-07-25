'use strict';

const runtime = require('../tasks/largeTaskRuntimeStore');

const TASK_CONTROL_ACTIONS = Object.freeze({
  cancel: 'cancel',
  pause: 'pause',
  resume: 'resume',
});

const TERMINAL_TASK_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'dead_letter']);

function _ok(data = {}) {
  return { ok: true, ...data };
}

function _err(status, code, message, data = {}) {
  return { ok: false, status, code, message, ...data };
}

function _normalizedTaskId(taskId) {
  return String(taskId || '').trim();
}

function getTask(taskId) {
  const normalizedId = _normalizedTaskId(taskId);
  if (!normalizedId) {
    return _err(400, 'missing_task_id', 'taskId 为必填项。');
  }
  const task = runtime.getTask(normalizedId);
  if (!task) {
    return _err(404, 'task_not_found', `未找到任务 ${normalizedId}。`);
  }
  return _ok({ task });
}

function getTaskDetail(taskId, options = {}) {
  const base = getTask(taskId);
  if (!base.ok) return base;

  const includeAudit = options.include_audit === true || options.includeAudit === true;
  if (!includeAudit) return _ok({ task: base.task });

  const audit = runtime.getTaskAudit(base.task.id);
  return _ok({
    task: base.task,
    audit,
  });
}

function listTasks(filter = {}) {
  return runtime.listTasks(filter || {});
}

function _cancelTask(task, options = {}) {
  const taskId = task.id;
  const reason = String(options.reason || 'cancelled by operator').trim() || 'cancelled by operator';
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return _ok({
      task,
      already_terminal: true,
      reason: 'already_terminal',
    });
  }

  const source = String(task?.payload_json?.source || '');
  if (source === 'bg_task') {
    const backgroundTaskLauncher = require('./backgroundTaskLauncher');
    const result = backgroundTaskLauncher.stop(taskId);
    if (!result.ok) {
      return _err(409, 'cancel_rejected', result.error || `任务 ${taskId} 取消失败。`, { task });
    }
    return _ok({ task: result.task || runtime.getTask(taskId) || task });
  }

  if (source === 'background_task_manager') {
    const backgroundTaskManager = require('./backgroundTaskManager');
    const result = backgroundTaskManager.cancel(taskId, reason);
    if (!result.success) {
      return _err(409, 'cancel_rejected', result.error || `任务 ${taskId} 取消失败。`, { task });
    }
    const latest = runtime.getTask(taskId);
    return _ok({ task: latest || task });
  }

  if (source === 'tool_task_store') {
    const toolTaskStore = require('../tools/_taskStore');
    const stopped = toolTaskStore.stopTask(taskId);
    if (!stopped) {
      return _err(409, 'cancel_rejected', `任务 ${taskId} 不存在或已结束。`, { task });
    }
    const latest = runtime.getTask(taskId);
    return _ok({ task: latest || task });
  }

  if (source === 'legacy_task_store') {
    const legacyTaskStore = require('../tasks/taskStore');
    const updated = legacyTaskStore.updateTask(taskId, {
      status: 'killed',
      error: reason,
    });
    if (!updated) {
      return _err(409, 'cancel_rejected', `任务 ${taskId} 取消失败。`, { task });
    }
    const latest = runtime.getTask(taskId);
    return _ok({ task: latest || task });
  }

  const cancelled = runtime.cancelTask(taskId, reason);
  return _ok({ task: cancelled || task });
}

function _pauseTask(task) {
  const taskId = task.id;
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return _err(
      409,
      'terminal_task',
      `终态任务 ${taskId} 无法暂停（当前状态 ${task.status}）。`,
      { task }
    );
  }
  if (task.status === 'paused') {
    return _ok({
      task,
      already_paused: true,
      reason: 'already_paused',
    });
  }

  const source = String(task?.payload_json?.source || '');
  if (source === 'background_task_manager') {
    const backgroundTaskManager = require('./backgroundTaskManager');
    const result = backgroundTaskManager.pause(taskId);
    if (!result.success) {
      return _err(409, 'pause_rejected', result.error || `任务 ${taskId} 暂停失败。`, { task });
    }
    const latest = runtime.getTask(taskId);
    return _ok({ task: latest || task });
  }

  if (task.status !== 'running') {
    return _err(409, 'invalid_state', `当前状态 ${task.status} 不支持暂停。`, { task });
  }
  runtime.transitionTask(taskId, 'pausing');
  const paused = runtime.transitionTask(taskId, 'paused');
  return _ok({ task: paused || runtime.getTask(taskId) || task });
}

function _resumeTask(task) {
  const taskId = task.id;
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return _err(
      409,
      'terminal_task',
      `终态任务 ${taskId} 无法恢复（当前状态 ${task.status}）。`,
      { task }
    );
  }
  if (task.status === 'running') {
    return _ok({
      task,
      already_running: true,
      reason: 'already_running',
    });
  }

  const source = String(task?.payload_json?.source || '');
  if (source === 'background_task_manager') {
    const backgroundTaskManager = require('./backgroundTaskManager');
    const result = backgroundTaskManager.resume(taskId);
    if (!result.success) {
      return _err(409, 'resume_rejected', result.error || `任务 ${taskId} 恢复失败。`, { task });
    }
    const latest = runtime.getTask(taskId);
    return _ok({ task: latest || task });
  }

  let current = task;
  if (current.status === 'pausing') {
    current = runtime.transitionTask(taskId, 'paused');
  }
  if (current.status !== 'paused') {
    return _err(409, 'invalid_state', `当前状态 ${current.status} 不支持恢复。`, { task: current });
  }
  const resumed = runtime.transitionTask(taskId, 'running', {
    heartbeat_at: new Date().toISOString(),
  });
  return _ok({ task: resumed || runtime.getTask(taskId) || current });
}

function controlTask(taskId, action, options = {}) {
  const normalizedAction = String(action || '').trim().toLowerCase();
  const normalizedId = _normalizedTaskId(taskId);
  if (!normalizedId) {
    return _err(400, 'missing_task_id', 'taskId 为必填项。');
  }
  if (!Object.values(TASK_CONTROL_ACTIONS).includes(normalizedAction)) {
    return _err(400, 'invalid_action', `不支持的任务操作: ${action}`);
  }

  const found = getTask(normalizedId);
  if (!found.ok) return found;
  const task = found.task;

  if (normalizedAction === TASK_CONTROL_ACTIONS.cancel) {
    return _cancelTask(task, options);
  }
  if (normalizedAction === TASK_CONTROL_ACTIONS.pause) {
    return _pauseTask(task);
  }
  return _resumeTask(task);
}

module.exports = {
  TASK_CONTROL_ACTIONS,
  TERMINAL_TASK_STATUSES: new Set(TERMINAL_TASK_STATUSES),
  getTask,
  getTaskDetail,
  listTasks,
  controlTask,
};
