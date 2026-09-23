'use strict';

/**
 * largeTasks.errorPathsAndWatch.test.js — 补齐 src/routes/largeTasks.js 的
 * 未覆盖分支（邻居 largeTasks.route.test.js 覆盖正向流，本文件锁错误面）：
 *   - 审批决策四连错：缺 ticket_id 400 / 非法 decision 400 / 未知审批单 404 /
 *     已决审批单再决 409（状态机拒绝二次审批）
 *   - retry-policy 审批票消费：未知票 404、已消费票 409；actor 头回退链
 *     （x-operator-id → x-actor-id → unknown_operator）
 *   - 未知任务资源：/:id/audit、/:id/checkpoints、/:id/run → 404 结构化错误
 *   - GET /events 状态过滤（state_to/state_from/after_at）与 limit 收敛
 *   - 路由表锁定（方法 × 路径清单，防端点静默改名/丢失）
 *   - /events/stream watch=1 的「订阅 → 实时推送」接线（replay-only 已由邻居覆盖）
 * runner：jest（与 tests/routes/largeTasks.route.test.js 同风格）；
 * runtime 经 resetForTests 隔离，绝不触碰真实数据。
 */
const { EventEmitter } = require('events');
const largeTasksRoute = require('../../src/routes/largeTasks');
const runtime = require('../../src/tasks/largeTaskRuntimeStore');
const { resetRemoteStateForTests } = require('../../src/services/domain/network/remote');
const { resetAll: resetCircuitBreakers } = require('../../src/services/circuitBreaker');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  return { status: res.statusCode, body: res.body };
}

function _parseSseEvents(raw) {
  const events = [];
  for (const block of String(raw || '').split('\n\n')) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((line) => line.startsWith(':'))) continue;
    let event = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim() || 'message';
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    let data = dataLines.join('\n');
    try {
      data = JSON.parse(data);
    } catch {
      /* keep raw */
    }
    events.push({ event, data });
  }
  return events;
}

async function _openWatchStream(reqPatch = {}) {
  const layer = _findRouteLayer('get', '/events/stream');
  const req = new EventEmitter();
  req.method = 'GET';
  req.headers = reqPatch.headers || {};
  req.query = reqPatch.query || {};

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.writableEnded = false;
  let raw = '';
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = { ...(headers || {}) };
    res.headersSent = true;
  };
  res.write = (chunk) => {
    raw += String(chunk || '');
    return true;
  };
  res.end = () => {
    if (res.writableEnded) return;
    res.writableEnded = true;
    res.emit('close');
  };

  const handler = layer.route.stack[0].handle;
  await handler(req, res, () => {});
  return {
    events: () => _parseSseEvents(raw),
    close: () => res.end(),
  };
}

async function _createAndRunTask(type, payloadJson) {
  const createRes = await _invokeRoute('post', '/', {
    body: { type, payload_json: payloadJson },
  });
  const taskId = createRes.body.data.task.id;
  const runRes = await _invokeRoute('post', '/:taskId/run', {
    params: { taskId },
    body: { dry_run: true, commit: false },
  });
  return { taskId, runRes };
}

describe('largeTasks route — 错误分支 / 过滤器 / watch 接线', () => {
  beforeEach(async () => {
    resetCircuitBreakers();
    try {
      await _invokeRoute('post', '/worker/stop');
    } catch {
      /* first run has no worker */
    }
    runtime.resetForTests({ persist: false });
    resetRemoteStateForTests();
  });

  afterEach(async () => {
    resetCircuitBreakers();
    try {
      await _invokeRoute('post', '/worker/stop');
    } catch {
      /* ignore */
    }
    runtime.resetForTests({ persist: false });
    resetRemoteStateForTests();
  });

  test('审批决策四连错：400 缺票 / 400 非法决策 / 404 未知票 / 409 已决票', async () => {
    const missingTicket = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: { decision: 'approve' },
    });
    expect(missingTicket.status).toBe(400);
    expect(missingTicket.body.error.code).toBe('INVALID_ARGUMENT');
    expect(missingTicket.body.error.message).toContain('ticket_id 为必填项');

    const { createRetryPolicyApprovalTicket } = runtime;
    const ticket = createRetryPolicyApprovalTicket({
      trace_id: 'trace-decision-errors',
      requester: 'tester',
      reason: 'needs approval',
      risk_level: 'high',
      risk_reason: 'test',
      patch: { default_retryable: false },
    });
    const ticketId = ticket.ticket_id;

    const badDecision = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: { ticket_id: ticketId, decision: 'maybe' },
    });
    expect(badDecision.status).toBe(400);
    expect(badDecision.body.error.message).toContain('decision 仅支持 approve 或 reject');

    const ghostTicket = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: { ticket_id: 'ticket-ghost-000', decision: 'approve' },
    });
    expect(ghostTicket.status).toBe(404);
    expect(ghostTicket.body.error.code).toBe('MODEL_NOT_FOUND');
    expect(ghostTicket.body.error.message).toContain('未找到对应审批单');

    const approve = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: { ticket_id: ticketId, decision: 'approve', reviewer: 'owner-1' },
    });
    expect(approve.status).toBe(200);
    const redecide = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: { ticket_id: ticketId, decision: 'reject', reviewer: 'owner-2' },
    });
    expect(redecide.status).toBe(409);
    expect(redecide.body.success).toBe(false);
    expect(redecide.body.error.message).toContain('无法再次审批');
  });

  test('retry-policy 消费审批票：未知票 404、已消费票 409', async () => {
    const ghostConsume = await _invokeRoute('post', '/retry-policy', {
      body: {
        retry_policy: { default_retryable: false },
        approval_ticket_id: 'ticket-ghost-000',
      },
    });
    expect(ghostConsume.status).toBe(404);
    expect(ghostConsume.body.error.code).toBe('MODEL_NOT_FOUND');

    // 经路由申请审批（202 + 审批票），保证票的状态/patch 与路由口径一致
    const requestApproval = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: { retry_policy: { default_retryable: false } },
    });
    expect(requestApproval.status).toBe(202);
    const ticketId = requestApproval.body.data.approval_ticket.ticket_id;
    expect(ticketId).toBeTruthy();

    // 先审批通过（decision），票状态 pending → approved，才能被消费
    const approve = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: { ticket_id: ticketId, decision: 'approve', reviewer: 'owner-1' },
    });
    expect(approve.status).toBe(200);
    expect(approve.body.data.ticket.status).toBe('approved');

    const first = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        retry_policy: { default_retryable: false },
        approval_ticket_id: ticketId,
      },
    });
    expect(first.status).toBe(200);
    expect(first.body.data.retry_policy.default_retryable).toBe(false);

    // 第二次仍要求审批的高危 patch（新增高危 error kind），但复用的是已消费票 → 409
    const second = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        retry_policy: { non_retryable_error_kinds: ['timeout'] },
        approval_ticket_id: ticketId,
      },
    });
    expect(second.status).toBe(409, '已消费审批票不得二次消费');
    expect(second.body.success).toBe(false);
  });

  test('actor 头回退链：x-operator-id 优先，x-actor-id 兜底', async () => {
    const viaOperator = await _invokeRoute('post', '/retry-policy/approvals/retention', {
      headers: { 'x-operator-id': 'op-1', 'x-actor-id': 'actor-1' },
      body: { retry_policy_approval_retention: { ticket_max_total: 5_500 } },
    });
    expect(viaOperator.body.data.audit_event.actor).toBe('op-1');

    const viaActor = await _invokeRoute('post', '/retry-policy/approvals/retention', {
      headers: { 'x-actor-id': 'actor-2' },
      body: { retry_policy_approval_retention: { ticket_max_total: 5_400 } },
    });
    expect(viaActor.body.data.audit_event.actor).toBe('actor-2');

    const fallback = await _invokeRoute('post', '/retry-policy/approvals/retention', {
      body: { retry_policy_approval_retention: { ticket_max_total: 5_300 } },
    });
    expect(fallback.body.data.audit_event.actor).toBe('unknown_operator');
  });

  test('未知任务资源 → 404 结构化错误（audit / checkpoints / run）', async () => {
    const auditRes = await _invokeRoute('get', '/:taskId/audit', {
      params: { taskId: 'task-ghost-000' },
    });
    expect(auditRes.status).toBe(404);
    expect(auditRes.body.error.code).toBe('MODEL_NOT_FOUND');
    expect(auditRes.body.error.message).toContain('未找到任务');

    const cpRes = await _invokeRoute('post', '/:taskId/checkpoints', {
      params: { taskId: 'task-ghost-000' },
      body: { step_no: 1 },
    });
    expect(cpRes.status).toBe(404);
    expect(cpRes.body.error.message).toContain('未找到任务');

    const runRes = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId: 'task-ghost-000' },
      body: { dry_run: true, commit: false },
    });
    expect(runRes.status).toBe(404);
    expect(runRes.body.error.message).toContain('未找到任务');
  });

  test('GET /events：state_to 过滤 + after_at 窗口 + limit 收敛', async () => {
    const { taskId } = await _createAndRunTask('event-filter-task', {
      steps: [{ action: 'set', key: 'k', value: 1 }],
    });

    const runningOnly = await _invokeRoute('get', '/events', {
      query: { task_id: taskId, state_to: 'running', limit: '200' },
    });
    expect(runningOnly.status).toBe(200);
    expect(runningOnly.body.data.events.length).toBeGreaterThan(0);
    expect(runningOnly.body.data.events.every((e) => e.state_to === 'running')).toBe(true);

    const fromQueued = await _invokeRoute('get', '/events', {
      query: { task_id: taskId, state_from: 'queued', limit: '200' },
    });
    expect(fromQueued.body.data.events.some((e) => e.state_from === 'queued')).toBe(true);

    const limited = await _invokeRoute('get', '/events', {
      query: { task_id: taskId, limit: '1' },
    });
    expect(limited.body.data.events).toHaveLength(1);

    const futureWindow = await _invokeRoute('get', '/events', {
      query: { task_id: taskId, after_at: new Date(Date.now() + 60_000).toISOString() },
    });
    expect(futureWindow.body.data.events).toHaveLength(0, '未来窗口内无任何事件');
  });

  test('路由表锁定：30 个端点，关键 方法×路径 齐全（防端点静默漂移）', () => {
    const routes = largeTasksRoute.stack
      .filter((l) => l.route)
      .map((l) => ({ path: l.route.path, methods: Object.keys(l.route.methods) }));
    const expected = [
      ['POST', '/'],
      ['GET', '/'],
      ['GET', '/metrics'],
      ['GET', '/board'],
      ['GET', '/events'],
      ['GET', '/worker/status'],
      ['POST', '/worker/start'],
      ['POST', '/worker/stop'],
      ['POST', '/:taskId/cancel'],
      ['POST', '/:taskId/pause'],
      ['POST', '/:taskId/resume'],
      ['GET', '/handover/snapshot'],
      ['GET', '/events/stream'],
      ['GET', '/retry-policy/approvals/stream'],
      ['GET', '/circuit/commit'],
      ['GET', '/retry-policy'],
      ['GET', '/retry-policy/events'],
      ['GET', '/retry-policy/approvals/pending'],
      ['GET', '/retry-policy/approvals/retention'],
      ['POST', '/retry-policy/approvals/retention'],
      ['GET', '/retry-policy/approvals/retention/events'],
      ['GET', '/retry-policy/approvals/retention/stream'],
      ['GET', '/retry-policy/approvals/events'],
      ['POST', '/retry-policy/approvals/decision'],
      ['POST', '/retry-policy'],
      ['GET', '/:taskId'],
      ['GET', '/:taskId/audit'],
      ['POST', '/:taskId/checkpoints'],
      ['POST', '/:taskId/run'],
      ['POST', '/run-next'],
    ];
    expect(routes.length).toBe(30);
    const missing = expected.filter(
      ([method, p]) => !routes.some((r) => r.path === p && r.methods.includes(method.toLowerCase())),
    );
    expect(missing).toEqual([]);
  });

  test('/events/stream watch=1：订阅存活时新任务事件被实时推送', async () => {
    // 先制造一个已结算任务的事件，把 after_id 落在其尾端（replay 应为 0）
    await _createAndRunTask('watch-baseline-task', {
      steps: [{ action: 'set', key: 'base', value: 1 }],
    });
    const allEvents = runtime.listTaskEvents({ limit: 5_000 });
    expect(allEvents.length).toBeGreaterThan(0);
    const tailId = allEvents[allEvents.length - 1].event_id;

    // 不按 task_id 过滤 → 订阅期间任何任务的新事件都应被实时推送
    const stream = await _openWatchStream({
      query: { watch: '1', limit: '200', after_id: String(tailId) },
    });
    // 给 replay + ready 事件一点时间写入
    await sleep(80);

    // 打开订阅之后再创建并运行一个新任务 → 其事件应在流仍打开时被推送
    const { taskId: liveTaskId } = await _createAndRunTask('watch-live-task', {
      steps: [{ action: 'set', key: 'live', value: 2 }],
    });
    await sleep(80);
    stream.close();

    const events = stream.events();
    const ready = events.find((e) => e.event === 'ready');
    expect(ready).toBeTruthy(), 'watch 流必须先发 ready';
    expect(ready.data.watch).toBe(true);
    expect(ready.data.after_id).toBe(tailId);
    const liveEvents = events.filter((e) => e.event === 'task_event' && e.data.task_id === liveTaskId);
    expect(liveEvents.length).toBeGreaterThan(0, '订阅存活期间新任务事件必须被实时推送');
    expect(liveEvents.some((e) => e.data.state_to === 'succeeded')).toBe(true);
  });
});
