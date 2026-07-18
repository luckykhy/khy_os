'use strict';

const largeTasksRoute = require('../../src/routes/largeTasks');
const runtime = require('../../src/tasks/largeTaskRuntimeStore');
const { runTasksControlContract } = require('../../src/cli/tasksControlContract');
const taskControlService = require('../../src/services/taskControlService');
const {
  resetRemoteStateForTests,
} = require('../../src/services/remote');
const { resetAll: resetCircuitBreakers } = require('../../src/services/circuitBreaker');

function _makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function _findRouteLayer(method, routePath) {
  const lowered = String(method || '').toLowerCase();
  return largeTasksRoute.stack.find((layer) => {
    if (!layer || !layer.route) return false;
    if (layer.route.path !== routePath) return false;
    return Boolean(layer.route.methods?.[lowered]);
  });
}

async function _invokeRoute(method, routePath, reqPatch = {}) {
  const layer = _findRouteLayer(method, routePath);
  if (!layer) {
    throw new Error(`Route not found: ${method.toUpperCase()} ${routePath}`);
  }

  const req = {
    method: String(method || '').toUpperCase(),
    headers: reqPatch.headers || {},
    body: reqPatch.body || {},
    query: reqPatch.query || {},
    params: reqPatch.params || {},
  };
  const res = _makeRes();

  const handlers = layer.route.stack.map((item) => item.handle);
  let cursor = 0;
  const next = async (error) => {
    if (error) throw error;
    const handler = handlers[cursor++];
    if (!handler) return;
    return handler(req, res, next);
  };

  await next();
  return {
    status: res.statusCode,
    body: res.body,
  };
}

function _taskStatusLabel(status = '') {
  const labels = {
    queued: '待执行',
    claimed: '已认领',
    running: '执行中',
    retry_wait: '重试等待',
    pausing: '暂停中',
    paused: '已暂停',
    cancelling: '取消中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
    dead_letter: '死信',
  };
  return labels[String(status || '').trim()] || status || '未知';
}

const ACTION_ALIASES = Object.freeze({
  cancel: 'cancel',
  stop: 'cancel',
  kill: 'cancel',
  pause: 'pause',
  resume: 'resume',
  取消: 'cancel',
  暂停: 'pause',
  恢复: 'resume',
});

function _createRuntimeTaskWithState(state, idPrefix = 'parity-task') {
  const id = `${idPrefix}-${Math.random().toString(36).slice(2, 8)}`;
  const created = runtime.createTask({
    id,
    type: 'parity-control-task',
    max_attempts: 2,
    payload_json: { source: 'parity_matrix' },
  });
  const taskId = created.id;
  if (state === 'queued') return taskId;

  runtime.claimTask(taskId, 'parity-worker', { leaseMs: 60_000 });
  runtime.startTask(taskId, 'parity-worker');
  if (state === 'running') return taskId;

  if (state === 'paused') {
    runtime.transitionTask(taskId, 'pausing');
    runtime.transitionTask(taskId, 'paused');
    return taskId;
  }

  if (state === 'cancelled') {
    runtime.cancelTask(taskId, 'parity matrix terminal seed');
    return taskId;
  }

  throw new Error(`Unsupported task state for parity fixture: ${state}`);
}

function _runRepl(rawArgs) {
  return runTasksControlContract(rawArgs, {
    taskControlService,
    actionAliases: ACTION_ALIASES,
    taskStatusLabel: _taskStatusLabel,
    defaultCancelReason: 'Cancelled by /tasks command',
  });
}

function _assertReplEvent(result, expected = {}) {
  expect(result.handled).toBe(true);
  expect(Array.isArray(result.events)).toBe(true);
  expect(result.events.length).toBeGreaterThan(0);
  const first = result.events[0];
  if (expected.level) expect(first.level).toBe(expected.level);
  for (const token of (expected.includes || [])) {
    expect(String(first.text || '')).toContain(token);
  }
}

function _assertHttpResult(httpResult, expected = {}) {
  expect(httpResult.status).toBe(expected.status);
  expect(Boolean(httpResult.body?.success)).toBe(Boolean(expected.success));
  if (expected.code) {
    expect(httpResult.body?.data?.code).toBe(expected.code);
  }
  if (expected.flag) {
    expect(httpResult.body?.data?.[expected.flag]).toBe(true);
  }
  if (expected.taskStatus) {
    expect(httpResult.body?.data?.task?.status).toBe(expected.taskStatus);
  }
}

const CONTROL_PARITY_MATRIX = [
  {
    name: 'missing taskId',
    action: 'pause',
    replArgs: 'pause',
    httpParams: {},
    expectedRepl: { level: 'error', includes: ['用法: /tasks cancel|pause|resume <taskId>'] },
    expectedHttp: { status: 400, success: false, code: 'missing_task_id' },
  },
  {
    name: 'task not found',
    action: 'pause',
    replArgs: 'pause not-found-task',
    httpParams: { taskId: 'not-found-task' },
    expectedRepl: { level: 'error', includes: ['任务不存在: not-found-task'] },
    expectedHttp: { status: 404, success: false, code: 'task_not_found' },
  },
  {
    name: 'pause queued invalid_state',
    action: 'pause',
    state: 'queued',
    replCommand: '暂停',
    expectedRepl: { level: 'error', includes: ['任务操作失败', '当前状态 queued 不支持暂停'] },
    expectedHttp: { status: 409, success: false, code: 'invalid_state' },
  },
  {
    name: 'pause paused already_paused',
    action: 'pause',
    state: 'paused',
    replCommand: 'pause',
    expectedRepl: { level: 'info', includes: ['任务已是暂停状态'] },
    expectedHttp: { status: 200, success: true, flag: 'already_paused', taskStatus: 'paused' },
  },
  {
    name: 'resume running already_running',
    action: 'resume',
    state: 'running',
    replCommand: 'resume',
    expectedRepl: { level: 'info', includes: ['任务已在运行状态'] },
    expectedHttp: { status: 200, success: true, flag: 'already_running', taskStatus: 'running' },
  },
  {
    name: 'resume cancelled terminal_task',
    action: 'resume',
    state: 'cancelled',
    replCommand: '恢复',
    expectedRepl: { level: 'error', includes: ['任务操作失败', '终态任务'] },
    expectedHttp: { status: 409, success: false, code: 'terminal_task' },
  },
  {
    name: 'cancel cancelled already_terminal',
    action: 'cancel',
    state: 'cancelled',
    replCommand: '取消',
    replTail: '手动结束',
    expectedRepl: { level: 'info', includes: ['任务已结束，无需取消'] },
    expectedHttp: { status: 200, success: true, flag: 'already_terminal', taskStatus: 'cancelled' },
  },
  {
    name: 'pause running success',
    action: 'pause',
    state: 'running',
    replCommand: 'pause',
    expectedRepl: { level: 'success', includes: ['已暂停任务'] },
    expectedHttp: { status: 200, success: true, taskStatus: 'paused' },
  },
  {
    name: 'resume paused success',
    action: 'resume',
    state: 'paused',
    replCommand: 'resume',
    expectedRepl: { level: 'success', includes: ['已恢复任务'] },
    expectedHttp: { status: 200, success: true, taskStatus: 'running' },
  },
  {
    name: 'cancel running success',
    action: 'cancel',
    state: 'running',
    replCommand: 'cancel',
    replTail: 'manual-stop',
    expectedRepl: { level: 'success', includes: ['已取消任务'] },
    expectedHttp: { status: 200, success: true, taskStatus: 'cancelled' },
  },
];

describe('tasks control parity matrix (REPL /tasks vs HTTP /largeTasks)', () => {
  beforeEach(async () => {
    resetCircuitBreakers();
    try {
      await _invokeRoute('post', '/worker/stop');
    } catch {
      // ignore stop failures before first run
    }
    runtime.resetForTests({ persist: false });
    resetRemoteStateForTests();
  });

  afterEach(async () => {
    resetCircuitBreakers();
    try {
      await _invokeRoute('post', '/worker/stop');
    } catch {
      // ignore stop failures during cleanup
    }
    runtime.resetForTests({ persist: false });
    resetRemoteStateForTests();
  });

  test.each(CONTROL_PARITY_MATRIX)('$name', async (entry) => {
    // REPL path (contract used by /tasks command)
    let replArgs = String(entry.replArgs || '').trim();
    if (!replArgs) {
      const replTaskId = _createRuntimeTaskWithState(entry.state, 'repl-parity');
      const tail = entry.replTail ? ` ${entry.replTail}` : '';
      replArgs = `${entry.replCommand || entry.action} ${replTaskId}${tail}`.trim();
    }
    const replResult = _runRepl(replArgs);
    _assertReplEvent(replResult, entry.expectedRepl);

    // HTTP route path (same semantic action)
    const routePath = `/:taskId/${entry.action}`;
    const body = entry.action === 'cancel' ? { reason: 'http-matrix-stop' } : {};
    let params = entry.httpParams || null;
    if (!params) {
      const httpTaskId = _createRuntimeTaskWithState(entry.state, 'http-parity');
      params = { taskId: httpTaskId };
    }
    const httpResult = await _invokeRoute('post', routePath, { params, body });
    _assertHttpResult(httpResult, entry.expectedHttp);
  });
});
