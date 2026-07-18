'use strict';

const runtime = require('../../src/tasks/largeTaskRuntimeStore');
const backgroundTaskManager = require('../../src/services/backgroundTaskManager');
const toolTaskStore = require('../../src/tools/_taskStore');
const legacyTaskStore = require('../../src/tasks/taskStore');
const taskControlService = require('../../src/services/taskControlService');

function _resetAllStores() {
  try { backgroundTaskManager.reset(); } catch { /* ignore */ }
  try { toolTaskStore.clear(); } catch { /* ignore */ }
  try { legacyTaskStore.reset(); } catch { /* ignore */ }
  runtime.resetForTests({ persist: false });
}

function _createRunningRuntimeTask(id, source = 'runtime_test') {
  const created = runtime.createTask({
    id,
    type: 'task-control-test',
    max_attempts: 2,
    payload_json: { source },
  });
  runtime.claimTask(created.id, 'task-control-worker', { leaseMs: 60_000 });
  runtime.startTask(created.id, 'task-control-worker');
  return runtime.getTask(created.id);
}

describe('taskControlService', () => {
  beforeEach(() => {
    _resetAllStores();
  });

  afterEach(() => {
    _resetAllStores();
  });

  test('rejects missing taskId and invalid action', () => {
    const missing = taskControlService.controlTask('', 'pause');
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(400);
    expect(missing.code).toBe('missing_task_id');

    const invalidAction = taskControlService.controlTask('task-1', 'unknown');
    expect(invalidAction.ok).toBe(false);
    expect(invalidAction.status).toBe(400);
    expect(invalidAction.code).toBe('invalid_action');
  });

  test('returns task_not_found when target task does not exist', () => {
    const missing = taskControlService.controlTask('not-exists', 'cancel');
    expect(missing.ok).toBe(false);
    expect(missing.status).toBe(404);
    expect(missing.code).toBe('task_not_found');
  });

  test('pauses and resumes runtime-managed tasks', () => {
    const task = _createRunningRuntimeTask('rt-pause-resume');

    const paused = taskControlService.controlTask(task.id, 'pause');
    expect(paused.ok).toBe(true);
    expect(paused.task.status).toBe('paused');

    const resumed = taskControlService.controlTask(task.id, 'resume');
    expect(resumed.ok).toBe(true);
    expect(resumed.task.status).toBe('running');
  });

  test('reports conflict for unsupported runtime state transitions', () => {
    const created = runtime.createTask({
      id: 'rt-invalid-state',
      type: 'task-control-test',
      payload_json: { source: 'runtime_test' },
    });

    const pauseRejected = taskControlService.controlTask(created.id, 'pause');
    expect(pauseRejected.ok).toBe(false);
    expect(pauseRejected.status).toBe(409);
    expect(pauseRejected.code).toBe('invalid_state');

    const resumeRejected = taskControlService.controlTask(created.id, 'resume');
    expect(resumeRejected.ok).toBe(false);
    expect(resumeRejected.status).toBe(409);
    expect(resumeRejected.code).toBe('invalid_state');
  });

  test('returns terminal conflict for pause/resume and already_terminal for cancel', () => {
    const task = _createRunningRuntimeTask('rt-terminal');
    runtime.cancelTask(task.id, 'manual cancel for terminal test');

    const pauseRejected = taskControlService.controlTask(task.id, 'pause');
    expect(pauseRejected.ok).toBe(false);
    expect(pauseRejected.status).toBe(409);
    expect(pauseRejected.code).toBe('terminal_task');

    const resumeRejected = taskControlService.controlTask(task.id, 'resume');
    expect(resumeRejected.ok).toBe(false);
    expect(resumeRejected.status).toBe(409);
    expect(resumeRejected.code).toBe('terminal_task');

    const cancelNoop = taskControlService.controlTask(task.id, 'cancel');
    expect(cancelNoop.ok).toBe(true);
    expect(cancelNoop.already_terminal).toBe(true);
    expect(cancelNoop.task.status).toBe('cancelled');
  });

  test('reports already_paused and already_running flags for no-op controls', () => {
    const pausedTask = _createRunningRuntimeTask('rt-already-paused');
    runtime.transitionTask(pausedTask.id, 'pausing');
    runtime.transitionTask(pausedTask.id, 'paused');

    const alreadyPaused = taskControlService.controlTask(pausedTask.id, 'pause');
    expect(alreadyPaused.ok).toBe(true);
    expect(alreadyPaused.already_paused).toBe(true);
    expect(alreadyPaused.task.status).toBe('paused');

    const runningTask = _createRunningRuntimeTask('rt-already-running');
    const alreadyRunning = taskControlService.controlTask(runningTask.id, 'resume');
    expect(alreadyRunning.ok).toBe(true);
    expect(alreadyRunning.already_running).toBe(true);
    expect(alreadyRunning.task.status).toBe('running');
  });

  test('uses backgroundTaskManager control path for background tasks', () => {
    const registration = backgroundTaskManager.register({
      type: 'background-task-control',
      label: 'background control task',
    });
    const taskId = registration.task.id;

    const paused = taskControlService.controlTask(taskId, 'pause');
    expect(paused.ok).toBe(true);
    expect(paused.task.status).toBe('paused');

    const resumed = taskControlService.controlTask(taskId, 'resume');
    expect(resumed.ok).toBe(true);
    expect(resumed.task.status).toBe('running');

    const cancelled = taskControlService.controlTask(taskId, 'cancel', { reason: 'operator stop' });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.task.status).toBe('cancelled');
  });

  test('uses tool_task_store and legacy_task_store cancel path', () => {
    toolTaskStore.add({
      id: 'tool-task-control',
      subject: 'tool task',
      description: 'tool task control',
      status: 'running',
    });
    const toolCancelled = taskControlService.controlTask('tool-task-control', 'cancel', {
      reason: 'stop tool task',
    });
    expect(toolCancelled.ok).toBe(true);
    expect(toolCancelled.task.status).toBe('cancelled');
    expect(runtime.getTask('tool-task-control').status).toBe('cancelled');

    const legacy = legacyTaskStore.createTask('legacy task control', 'local_bash');
    const legacyCancelled = taskControlService.controlTask(legacy.id, 'cancel', {
      reason: 'stop legacy task',
    });
    expect(legacyCancelled.ok).toBe(true);
    expect(legacyCancelled.task.status).toBe('cancelled');
    expect(runtime.getTask(legacy.id).status).toBe('cancelled');
  });

  test('returns audit detail when includeAudit is enabled', () => {
    const task = _createRunningRuntimeTask('rt-detail-audit');
    runtime.transitionTask(task.id, 'pausing');
    runtime.transitionTask(task.id, 'paused');

    const detail = taskControlService.getTaskDetail(task.id, { includeAudit: true });
    expect(detail.ok).toBe(true);
    expect(detail.task.id).toBe(task.id);
    expect(detail.audit).toBeTruthy();
    expect(detail.audit.task.id).toBe(task.id);
    expect(Array.isArray(detail.audit.events)).toBe(true);
    expect(detail.audit.events.length).toBeGreaterThan(0);
  });
});
