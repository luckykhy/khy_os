'use strict';

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normalizeToken = require('../utils/trimLowerCase');

function runTasksControlContract(rawArgs = '', deps = {}) {
  const taskControlService = deps.taskControlService;
  const actionAliases = deps.actionAliases || {};
  const taskStatusLabel = typeof deps.taskStatusLabel === 'function'
    ? deps.taskStatusLabel
    : (status) => String(status || 'unknown');
  const defaultCancelReason = String(
    deps.defaultCancelReason || 'Cancelled by /tasks command'
  );

  const tokens = String(rawArgs || '').trim().split(/\s+/).filter(Boolean);
  const primary = _normalizeToken(tokens[0] || '');
  const action = actionAliases[primary] || null;
  if (!action) {
    return { handled: false, events: [] };
  }

  const events = [];
  const taskId = String(tokens[1] || '').trim();
  if (!taskId) {
    events.push({
      level: 'error',
      text: '用法: /tasks cancel|pause|resume <taskId>',
    });
    return { handled: true, events };
  }

  const controlOptions = action === 'cancel'
    ? { reason: tokens.slice(2).join(' ').trim() || defaultCancelReason }
    : {};
  const result = taskControlService.controlTask(taskId, action, controlOptions);

  if (!result.ok) {
    if (result.code === 'missing_task_id') {
      events.push({
        level: 'error',
        text: '用法: /tasks cancel|pause|resume <taskId>',
      });
      return { handled: true, events };
    }
    if (result.code === 'task_not_found') {
      events.push({
        level: 'error',
        text: `任务不存在: ${taskId}`,
      });
      return { handled: true, events };
    }
    events.push({
      level: 'error',
      text: `任务操作失败: ${result.message || 'unknown error'}`,
    });
    return { handled: true, events };
  }

  if (action === 'cancel' && result.already_terminal) {
    events.push({
      level: 'info',
      text: `任务已结束，无需取消: ${taskId} (${result.task?.status || 'unknown'})`,
    });
    return { handled: true, events };
  }
  if (action === 'pause' && result.already_paused) {
    events.push({
      level: 'info',
      text: `任务已是暂停状态: ${taskId}`,
    });
    return { handled: true, events };
  }
  if (action === 'resume' && result.already_running) {
    events.push({
      level: 'info',
      text: `任务已在运行状态: ${taskId}`,
    });
    return { handled: true, events };
  }

  const updatedTask = result.task;
  if (action === 'cancel') {
    events.push({
      level: 'success',
      text: `已取消任务: ${taskId} -> ${taskStatusLabel(updatedTask?.status)} (${updatedTask?.status || 'unknown'})`,
    });
    return { handled: true, events };
  }
  if (action === 'pause') {
    events.push({
      level: 'success',
      text: `已暂停任务: ${taskId} -> ${taskStatusLabel(updatedTask?.status)} (${updatedTask?.status || 'unknown'})`,
    });
    return { handled: true, events };
  }
  events.push({
    level: 'success',
    text: `已恢复任务: ${taskId} -> ${taskStatusLabel(updatedTask?.status)} (${updatedTask?.status || 'unknown'})`,
  });
  return { handled: true, events };
}

module.exports = {
  runTasksControlContract,
};
