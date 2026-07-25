'use strict';

const { runTasksControlContract } = require('../../src/cli/tasksControlContract');

const ACTION_ALIASES = Object.freeze({
  cancel: 'cancel',
  stop: 'cancel',
  pause: 'pause',
  resume: 'resume',
  取消: 'cancel',
  暂停: 'pause',
  恢复: 'resume',
});

function _statusLabel(status = '') {
  const labels = {
    running: '执行中',
    paused: '已暂停',
    cancelled: '已取消',
  };
  return labels[status] || status || '未知';
}

function _makeDeps(controlTaskImpl) {
  return {
    taskControlService: {
      controlTask: jest.fn(controlTaskImpl),
    },
    actionAliases: ACTION_ALIASES,
    taskStatusLabel: _statusLabel,
    defaultCancelReason: 'Cancelled by /tasks command',
  };
}

describe('tasksControlContract', () => {
  test('returns handled=false for non-control command', () => {
    const deps = _makeDeps(() => ({ ok: true }));
    const result = runTasksControlContract('running 20', deps);
    expect(result.handled).toBe(false);
    expect(result.events).toEqual([]);
    expect(deps.taskControlService.controlTask).not.toHaveBeenCalled();
  });

  test('prints usage when taskId is missing', () => {
    const deps = _makeDeps(() => ({ ok: true }));
    const result = runTasksControlContract('pause', deps);
    expect(result.handled).toBe(true);
    expect(result.events).toEqual([
      { level: 'error', text: '用法: /tasks cancel|pause|resume <taskId>' },
    ]);
    expect(deps.taskControlService.controlTask).not.toHaveBeenCalled();
  });

  test('maps task_not_found to explicit CLI message', () => {
    const deps = _makeDeps(() => ({
      ok: false,
      code: 'task_not_found',
      message: 'not found',
    }));
    const result = runTasksControlContract('pause t-404', deps);
    expect(result.handled).toBe(true);
    expect(result.events[0].level).toBe('error');
    expect(result.events[0].text).toBe('任务不存在: t-404');
  });

  test('maps generic failure to operation failed message', () => {
    const deps = _makeDeps(() => ({
      ok: false,
      code: 'invalid_state',
      message: '当前状态 queued 不支持暂停。',
    }));
    const result = runTasksControlContract('pause t-queued', deps);
    expect(result.handled).toBe(true);
    expect(result.events).toEqual([
      { level: 'error', text: '任务操作失败: 当前状态 queued 不支持暂停。' },
    ]);
  });

  test('maps cancel already_terminal to info text', () => {
    const deps = _makeDeps(() => ({
      ok: true,
      already_terminal: true,
      task: { id: 't-end', status: 'cancelled' },
    }));
    const result = runTasksControlContract('cancel t-end', deps);
    expect(result.handled).toBe(true);
    expect(result.events).toEqual([
      { level: 'info', text: '任务已结束，无需取消: t-end (cancelled)' },
    ]);
  });

  test('maps pause already_paused to info text', () => {
    const deps = _makeDeps(() => ({
      ok: true,
      already_paused: true,
      task: { id: 't-paused', status: 'paused' },
    }));
    const result = runTasksControlContract('pause t-paused', deps);
    expect(result.handled).toBe(true);
    expect(result.events).toEqual([
      { level: 'info', text: '任务已是暂停状态: t-paused' },
    ]);
  });

  test('maps resume already_running to info text', () => {
    const deps = _makeDeps(() => ({
      ok: true,
      already_running: true,
      task: { id: 't-running', status: 'running' },
    }));
    const result = runTasksControlContract('resume t-running', deps);
    expect(result.handled).toBe(true);
    expect(result.events).toEqual([
      { level: 'info', text: '任务已在运行状态: t-running' },
    ]);
  });

  test('maps successful cancel/pause/resume to success text', () => {
    const deps = _makeDeps((taskId, action) => {
      if (action === 'cancel') return { ok: true, task: { id: taskId, status: 'cancelled' } };
      if (action === 'pause') return { ok: true, task: { id: taskId, status: 'paused' } };
      return { ok: true, task: { id: taskId, status: 'running' } };
    });

    const cancelResult = runTasksControlContract('cancel t-1 stop', deps);
    expect(cancelResult.events).toEqual([
      { level: 'success', text: '已取消任务: t-1 -> 已取消 (cancelled)' },
    ]);

    const pauseResult = runTasksControlContract('pause t-2', deps);
    expect(pauseResult.events).toEqual([
      { level: 'success', text: '已暂停任务: t-2 -> 已暂停 (paused)' },
    ]);

    const resumeResult = runTasksControlContract('resume t-3', deps);
    expect(resumeResult.events).toEqual([
      { level: 'success', text: '已恢复任务: t-3 -> 执行中 (running)' },
    ]);
  });

  test('passes parsed cancel reason to control service', () => {
    const deps = _makeDeps(() => ({ ok: true, task: { status: 'cancelled' } }));
    runTasksControlContract('cancel task-9 because timeout', deps);
    expect(deps.taskControlService.controlTask).toHaveBeenCalledWith(
      'task-9',
      'cancel',
      { reason: 'because timeout' }
    );
  });
});
