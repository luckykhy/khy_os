'use strict';

const { EventEmitter } = require('events');
const largeTasksRoute = require('../../src/routes/largeTasks');
const runtime = require('../../src/tasks/largeTaskRuntimeStore');
const {
  resetRemoteStateForTests,
  remoteApprovalBridge,
  sshConnectionManager,
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

function _parseSseEvents(raw) {
  const events = [];
  const blocks = String(raw || '').split('\n\n');
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) continue;
    if (lines.every((line) => line.startsWith(':'))) continue;
    let event = 'message';
    let id = null;
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('id:')) {
        const parsed = Number.parseInt(line.slice(3).trim(), 10);
        id = Number.isFinite(parsed) ? parsed : null;
      } else if (line.startsWith('event:')) {
        event = line.slice(6).trim() || 'message';
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) continue;
    const text = dataLines.join('\n');
    let data = text;
    try { data = JSON.parse(text); } catch { /* keep raw */ }
    events.push({ id, event, data });
  }
  return events;
}

async function _invokeStreamRoute(routePathOrReqPatch = '/events/stream', reqPatchMaybe = {}) {
  const routePath = typeof routePathOrReqPatch === 'string' ? routePathOrReqPatch : '/events/stream';
  const reqPatch = typeof routePathOrReqPatch === 'string' ? reqPatchMaybe : (routePathOrReqPatch || {});
  const layer = _findRouteLayer('get', routePath);
  if (!layer) throw new Error(`Route not found: GET ${routePath}`);

  const req = new EventEmitter();
  req.method = 'GET';
  req.headers = reqPatch.headers || {};
  req.query = reqPatch.query || {};
  req.body = reqPatch.body || {};
  req.params = reqPatch.params || {};

  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.headersSent = false;
  res.writableEnded = false;
  res.destroyed = false;
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

  const done = new Promise((resolve) => {
    res.on('close', () => {
      resolve({
        status: res.statusCode,
        headers: res.headers,
        raw,
        events: _parseSseEvents(raw),
      });
    });
  });

  const handler = layer.route.stack[0].handle;
  await handler(req, res, () => {});

  // Non-watch path closes immediately via res.end().
  if (!res.writableEnded) {
    res.end();
  }
  return done;
}

describe('largeTasks route', () => {
  beforeEach(async () => {
    resetCircuitBreakers();
    try {
      await _invokeRoute('post', '/worker/stop');
    } catch {
      // Ignore stop failures before first run.
    }
    runtime.resetForTests({ persist: false });
    resetRemoteStateForTests();
  });

  afterEach(async () => {
    resetCircuitBreakers();
    try {
      await _invokeRoute('post', '/worker/stop');
    } catch {
      // Ignore stop failures after each test.
    }
    runtime.resetForTests({ persist: false });
    resetRemoteStateForTests();
  });

  test('creates and lists large tasks', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'demo-route-task',
        payload_json: { hello: 'world' },
        max_attempts: 2,
      },
    });
    expect(createRes.status).toBe(200);
    expect(createRes.body.success).toBe(true);
    const taskId = createRes.body.data.task.id;
    expect(taskId).toBeTruthy();

    const listRes = await _invokeRoute('get', '/', {
      query: { limit: '20' },
    });
    expect(listRes.status).toBe(200);
    expect(listRes.body.success).toBe(true);
    expect(listRes.body.data.total).toBeGreaterThanOrEqual(1);
    expect(listRes.body.data.tasks.some((task) => task.id === taskId)).toBe(true);
  });

  test('runs task in dry_run mode and returns plan/side-effect preview', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'dry-run-task',
        payload_json: {
          state: { seed: 1 },
          steps: [
            { action: 'set', key: 'x', value: 42 },
            { action: 'side_effect', idempotency_key: 'idem-route-dry-run-1', intent_hash: 'intent-dry-run' },
          ],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    const runRes = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: {
        dry_run: true,
        commit: false,
      },
    });
    expect(runRes.status).toBe(200);
    expect(runRes.body.success).toBe(true);
    expect(runRes.body.data.run_result.ok).toBe(true);
    expect(runRes.body.data.run_result.result.plan.step_total).toBe(2);
    expect(runRes.body.data.run_result.result.side_effects).toHaveLength(1);
    expect(runRes.body.data.run_result.result.side_effects[0].code).toBe('commit_required');
  });

  test('fails run when idle timeout is exceeded without activity', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'idle-timeout-route-task',
        payload_json: {
          steps: [
            { action: 'sleep', sleep_ms: 80 },
          ],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    const runRes = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: {
        dry_run: true,
        commit: false,
        idle_timeout_ms: 30,
        retry_base_delay_ms: 1,
        retry_cap_delay_ms: 1,
        retry_jitter_pct: 0,
      },
    });
    expect(runRes.status).toBe(200);
    expect(runRes.body.success).toBe(true);
    expect(runRes.body.data.run_result.ok).toBe(false);
    expect(runRes.body.data.run_result.error.type).toBe('task_idle_timeout');
  });

  test('applies retry_policy override from route run options', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'policy-route-task',
        payload_json: {
          steps: [{ action: 'fail', fail_message: 'generic failure' }],
        },
        max_attempts: 3,
      },
    });
    const taskId = createRes.body.data.task.id;

    const runRes = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: {
        dry_run: true,
        commit: false,
        retry_policy: {
          default_retryable: false,
        },
      },
    });
    expect(runRes.status).toBe(200);
    expect(runRes.body.success).toBe(true);
    expect(runRes.body.data.run_result.ok).toBe(false);
    expect(runRes.body.data.run_result.retry_scheduled).toBe(false);

    const taskRes = await _invokeRoute('get', '/:taskId', {
      params: { taskId },
    });
    expect(taskRes.status).toBe(200);
    expect(taskRes.body.data.task.status).toBe('failed');
    expect(taskRes.body.data.task.last_error.retry_classification).toBe('default_non_retryable');
  });

  test('replays side effects by idempotency key across tasks when commit enabled', async () => {
    const taskARes = await _invokeRoute('post', '/', {
      body: {
        type: 'commit-task',
        payload_json: {
          steps: [
            {
              action: 'side_effect',
              scope: 'route-idem-scope',
              idempotency_key: 'idem-route-commit-001',
              intent_hash: 'intent-001',
              effect_result: { ticket: 'A' },
            },
          ],
        },
      },
    });
    const taskAId = taskARes.body.data.task.id;

    const runA = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId: taskAId },
      body: {
        dry_run: false,
        commit: true,
      },
    });
    expect(runA.status).toBe(200);
    expect(runA.body.data.run_result.ok).toBe(true);
    expect(runA.body.data.run_result.result.side_effects[0].replayed).toBe(false);

    const taskBRes = await _invokeRoute('post', '/', {
      body: {
        type: 'commit-task',
        payload_json: {
          steps: [
            {
              action: 'side_effect',
              scope: 'route-idem-scope',
              idempotency_key: 'idem-route-commit-001',
              intent_hash: 'intent-001',
              effect_result: { ticket: 'B' },
            },
          ],
        },
      },
    });
    const taskBId = taskBRes.body.data.task.id;

    const runB = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId: taskBId },
      body: {
        dry_run: false,
        commit: true,
      },
    });
    expect(runB.status).toBe(200);
    expect(runB.body.data.run_result.ok).toBe(true);
    expect(runB.body.data.run_result.result.side_effects[0].replayed).toBe(true);
    expect(runB.body.data.run_result.result.side_effects[0].result.effect_result).toEqual({ ticket: 'A' });
  });

  test('fails committed side-effect task when circuit opens after repeated downstream errors', async () => {
    const buildTask = async (name) => {
      const createRes = await _invokeRoute('post', '/', {
        body: {
          type: name,
          payload_json: {
            steps: [
              {
                action: 'side_effect',
                scope: 'large_task_builtin',
                idempotency_key: `${name}-idem`,
                intent_hash: `${name}-intent`,
                effect_result: { should_not_happen: true },
              },
              { action: 'set', key: 'after', value: true },
            ],
          },
        },
      });
      return createRes.body.data.task.id;
    };

    const runTask = async (taskId) => _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: {
        dry_run: false,
        commit: true,
      },
    });

    const originalExecute = runtime.executeIdempotentSideEffect;
    let callCount = 0;
    runtime.executeIdempotentSideEffect = async (input) => {
      callCount += 1;
      if (callCount <= 3) {
        throw new Error('downstream unavailable');
      }
      return originalExecute(input);
    };

    try {
      const taskA = await buildTask('route-cb-a');
      const runA = await runTask(taskA);
      expect(runA.status).toBe(200);
      expect(runA.body.data.run_result.ok).toBe(false);
      expect(runA.body.data.run_result.error.message).toContain('downstream unavailable');

      const taskB = await buildTask('route-cb-b');
      const runB = await runTask(taskB);
      expect(runB.status).toBe(200);
      expect(runB.body.data.run_result.ok).toBe(false);
      expect(runB.body.data.run_result.error.message).toContain('downstream unavailable');

      const taskC = await buildTask('route-cb-c');
      const runC = await runTask(taskC);
      expect(runC.status).toBe(200);
      expect(runC.body.data.run_result.ok).toBe(false);
      expect(runC.body.data.run_result.error.message).toContain('downstream unavailable');

      const taskD = await buildTask('route-cb-d');
      const runD = await runTask(taskD);
      expect(runD.status).toBe(200);
      expect(runD.body.data.run_result.ok).toBe(false);
      expect(runD.body.data.run_result.error.message).toContain('circuit_open');

      const circuitRes = await _invokeRoute('get', '/circuit/commit', {
        query: { scope: 'large_task_builtin' },
      });
      expect(circuitRes.status).toBe(200);
      expect(circuitRes.body.success).toBe(true);
      expect(circuitRes.body.data.scope).toBe('large_task_builtin');
      expect(circuitRes.body.data.circuit.state).toBe('open');
    } finally {
      runtime.executeIdempotentSideEffect = originalExecute;
    }
  });

  test('updates retry policy via control plane and exposes audit events', async () => {
    const before = await _invokeRoute('get', '/retry-policy', {
      query: { include_audit: '1', limit: '20' },
    });
    expect(before.status).toBe(200);
    expect(before.body.success).toBe(true);
    expect(before.body.data.retry_policy.default_retryable).toBe(true);
    expect(Array.isArray(before.body.data.audit.events)).toBe(true);

    const requestApproval = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        reason: 'tighten retry boundary for deterministic failures',
        retry_policy: {
          default_retryable: false,
          non_retryable_status_codes: [400, 401, 422, 499],
        },
      },
    });
    expect(requestApproval.status).toBe(202);
    expect(requestApproval.body.success).toBe(true);
    expect(requestApproval.body.data.status).toBe('approval_required');
    expect(requestApproval.body.data.risk.requires_approval).toBe(true);
    expect(requestApproval.body.data.approval_ticket.ticket_id).toBeTruthy();

    const pending = await _invokeRoute('get', '/retry-policy/approvals/pending', {
      query: { limit: '20' },
    });
    expect(pending.status).toBe(200);
    expect(pending.body.success).toBe(true);
    expect(pending.body.data.approvals.some((item) => item.ticket_id === requestApproval.body.data.approval_ticket.ticket_id)).toBe(true);

    const decision = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: {
        ticket_id: requestApproval.body.data.approval_ticket.ticket_id,
        decision: 'approve',
        reviewer: 'owner-1',
      },
    });
    expect(decision.status).toBe(200);
    expect(decision.body.success).toBe(true);
    expect(decision.body.data.ticket.status).toBe('approved');

    const update = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        reason: 'tighten retry boundary for deterministic failures',
        approval_ticket_id: requestApproval.body.data.approval_ticket.ticket_id,
        retry_policy: {
          default_retryable: false,
          non_retryable_status_codes: [400, 401, 422, 499],
        },
      },
    });
    expect(update.status).toBe(200);
    expect(update.body.success).toBe(true);
    expect(update.body.data.changed).toBe(true);
    expect(update.body.data.retry_policy.default_retryable).toBe(false);
    expect(update.body.data.audit_event.actor).toBe('mobile-admin');
    expect(update.body.data.audit_event.policy_event_id).toBeGreaterThan(0);

    const events = await _invokeRoute('get', '/retry-policy/events', {
      query: {
        after_id: String(update.body.data.audit_event.policy_event_id - 1),
        limit: '20',
      },
    });
    expect(events.status).toBe(200);
    expect(events.body.success).toBe(true);
    expect(events.body.data.events.length).toBeGreaterThanOrEqual(1);
    expect(events.body.data.events[0].after_policy.default_retryable).toBe(false);
  });

  test('updates low-risk retry policy without approval ticket', async () => {
    const update = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        retry_policy: {
          non_retryable_status_codes: [400, 401, 403, 404, 409, 422, 425],
        },
      },
    });
    expect(update.status).toBe(200);
    expect(update.body.success).toBe(true);
    expect(update.body.data.risk.requires_approval).toBe(false);
    expect(update.body.data.retry_policy.non_retryable_status_codes).toContain(425);
  });

  test('gets and updates retry-policy approval retention via control plane', async () => {
    const before = await _invokeRoute('get', '/retry-policy/approvals/retention');
    expect(before.status).toBe(200);
    expect(before.body.success).toBe(true);
    expect(before.body.data.retry_policy_approval_retention.ticket_max_total).toBeGreaterThan(0);

    const traceId = 'trace-route-retention-audit-1';
    const update = await _invokeRoute('post', '/retry-policy/approvals/retention', {
      headers: {
        'x-operator-id': 'mobile-admin',
        'x-trace-id': traceId,
      },
      body: {
        reason: 'tune retention for long-running environment',
        retry_policy_approval_retention: {
          ticket_max_total: 6_000,
          event_max_total: 12_000,
          terminal_ticket_max_count: 1_234,
          terminal_ticket_max_age_ms: 86_400_000,
          event_max_age_ms: 172_800_000,
        },
      },
    });
    expect(update.status).toBe(200);
    expect(update.body.success).toBe(true);
    expect(update.body.data.changed).toBe(true);
    expect(update.body.data.retry_policy_approval_retention.ticket_max_total).toBe(6_000);
    expect(update.body.data.retry_policy_approval_retention.event_max_total).toBe(12_000);
    expect(update.body.data.retry_policy_approval_retention.terminal_ticket_max_count).toBe(1_234);
    expect(update.body.data.audit_event.retention_event_id).toBeGreaterThan(0);
    expect(update.body.data.audit_event.trace_id).toBe(traceId);
    expect(update.body.data.audit_event.actor).toBe('mobile-admin');

    const after = await _invokeRoute('get', '/retry-policy/approvals/retention');
    expect(after.status).toBe(200);
    expect(after.body.success).toBe(true);
    expect(after.body.data.retry_policy_approval_retention.ticket_max_total).toBe(6_000);
    expect(after.body.data.retry_policy_approval_retention.event_max_total).toBe(12_000);

    const events = await _invokeRoute('get', '/retry-policy/approvals/retention/events', {
      query: {
        trace_id: traceId,
        after_id: String(update.body.data.audit_event.retention_event_id - 1),
        limit: '20',
      },
    });
    expect(events.status).toBe(200);
    expect(events.body.success).toBe(true);
    expect(events.body.data.total).toBeGreaterThanOrEqual(1);
    expect(events.body.data.events[0].retention_event_id).toBe(update.body.data.audit_event.retention_event_id);
  });

  test('rejects invalid retry-policy approval retention patch', async () => {
    const invalid = await _invokeRoute('post', '/retry-policy/approvals/retention', {
      body: {
        retry_policy_approval_retention: {
          ticket_max_total: 1,
          unknown_field: true,
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.success).toBe(false);
    expect(invalid.body.message).toContain('更新重试策略审批保留策略失败');
  });

  test('lists retry-policy approval events with filters and after_id replay', async () => {
    const traceId = 'trace-retry-policy-approval-events';
    const requestApproval = await _invokeRoute('post', '/retry-policy', {
      headers: {
        'x-operator-id': 'mobile-admin',
        'x-trace-id': traceId,
      },
      body: {
        reason: 'require approval for critical retry-policy change',
        retry_policy: {
          default_retryable: false,
        },
      },
    });
    expect(requestApproval.status).toBe(202);
    const ticketId = requestApproval.body.data.approval_ticket.ticket_id;

    const decision = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: {
        ticket_id: ticketId,
        decision: 'approve',
        reviewer: 'owner-approval-events',
      },
    });
    expect(decision.status).toBe(200);
    expect(decision.body.success).toBe(true);

    const consume = await _invokeRoute('post', '/retry-policy', {
      headers: {
        'x-operator-id': 'mobile-admin',
        'x-trace-id': traceId,
      },
      body: {
        reason: 'apply approved retry-policy change',
        approval_ticket_id: ticketId,
        retry_policy: {
          default_retryable: false,
        },
      },
    });
    expect(consume.status).toBe(200);
    expect(consume.body.success).toBe(true);

    const list = await _invokeRoute('get', '/retry-policy/approvals/events', {
      query: {
        ticket_id: ticketId,
        trace_id: traceId,
        limit: '20',
        after_id: '0',
      },
    });
    expect(list.status).toBe(200);
    expect(list.body.success).toBe(true);
    expect(list.body.data.total).toBeGreaterThanOrEqual(3);
    expect(Array.isArray(list.body.data.events)).toBe(true);
    expect(list.body.data.events.some((event) => event.event_type === 'ticket_created')).toBe(true);
    expect(list.body.data.events.some((event) => event.event_type === 'ticket_approved')).toBe(true);
    expect(list.body.data.events.some((event) => event.event_type === 'ticket_consumed')).toBe(true);

    const approvedOnly = await _invokeRoute('get', '/retry-policy/approvals/events', {
      query: {
        ticket_id: ticketId,
        event_type: 'ticket_approved',
        limit: '20',
      },
    });
    expect(approvedOnly.status).toBe(200);
    expect(approvedOnly.body.success).toBe(true);
    expect(approvedOnly.body.data.events.length).toBe(1);
    expect(approvedOnly.body.data.events[0].event_type).toBe('ticket_approved');
    expect(approvedOnly.body.data.events[0].ticket_id).toBe(ticketId);

    const allEvents = list.body.data.events;
    const tailEventId = allEvents[allEvents.length - 1].approval_event_id;
    const replayFromHeader = await _invokeRoute('get', '/retry-policy/approvals/events', {
      headers: { 'last-event-id': String(tailEventId) },
      query: {
        ticket_id: ticketId,
        limit: '20',
      },
    });
    expect(replayFromHeader.status).toBe(200);
    expect(replayFromHeader.body.success).toBe(true);
    expect(replayFromHeader.body.data.after_id).toBe(tailEventId);
    expect(replayFromHeader.body.data.total).toBe(0);
    expect(replayFromHeader.body.data.events).toHaveLength(0);
  });

  test('rejects invalid retry policy patch in control plane update', async () => {
    const invalid = await _invokeRoute('post', '/retry-policy', {
      body: {
        retry_policy: {
          unknown_field: ['x'],
          non_retryable_status_codes: ['abc', 99, 700],
          default_retryable: 'false',
        },
      },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.success).toBe(false);
    expect(invalid.body.message).toContain('更新重试策略失败');
  });

  test('blocks dangerous retry policy combination via guardrails', async () => {
    const blocked = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        reason: 'intentionally unsafe config for guardrail test',
        retry_policy: {
          default_retryable: false,
          retryable_error_kinds: [],
          non_retryable_error_kinds: ['timeout', 'network', 'rate_limit'],
        },
      },
    });

    expect(blocked.status).toBe(422);
    expect(blocked.body.success).toBe(false);
    expect(blocked.body.data.code).toBe('retry_policy_guardrail_blocked');
    expect(Array.isArray(blocked.body.data.violations)).toBe(true);
    expect(blocked.body.data.violations.length).toBeGreaterThan(0);
    expect(blocked.body.data.violations.some((item) => item.code === 'transient_retry_signal_missing')).toBe(true);
    expect(blocked.body.data.violations.some((item) => item.code === 'all_transient_kinds_non_retryable')).toBe(true);

    const pending = await _invokeRoute('get', '/retry-policy/approvals/pending', {
      query: { limit: '20' },
    });
    expect(pending.status).toBe(200);
    expect(pending.body.success).toBe(true);
    expect(pending.body.data.total_pending).toBe(0);
  });

  test('returns audit and metrics snapshots', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'audit-task',
        payload_json: {
          checkpoint_every: 1,
          steps: [
            { action: 'set', key: 'alpha', value: 1 },
            { action: 'checkpoint', progress_pct: 50, schema_version: 1, state_blob_json: { a: 1 } },
          ],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    const runRes = await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: {
        dry_run: true,
        commit: false,
      },
    });
    expect(runRes.status).toBe(200);
    expect(runRes.body.data.run_result.ok).toBe(true);

    const auditRes = await _invokeRoute('get', '/:taskId/audit', {
      params: { taskId },
    });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.success).toBe(true);
    expect(auditRes.body.data.audit.task.id).toBe(taskId);
    expect(auditRes.body.data.audit.events.length).toBeGreaterThan(0);
    expect(auditRes.body.data.audit.checkpoints.length).toBeGreaterThan(0);

    const metricsRes = await _invokeRoute('get', '/metrics');
    expect(metricsRes.status).toBe(200);
    expect(metricsRes.body.success).toBe(true);
    expect(metricsRes.body.data.metrics.task_total).toBeGreaterThanOrEqual(1);
    expect(metricsRes.body.data.metrics.event_total).toBeGreaterThan(0);
  });

  test('exposes retry classification fields in audit and events payloads', async () => {
    const nonRetryTask = runtime.createTask({
      type: 'audit-non-retry-task',
      max_attempts: 3,
      payload_json: { source: 'route-test' },
    });
    runtime.claimTask(nonRetryTask.id, 'route-audit-worker', { leaseMs: 60_000 });
    runtime.startTask(nonRetryTask.id, 'route-audit-worker');
    runtime.markFailed(nonRetryTask.id, 'route-audit-worker', {
      type: 'auth',
      message: 'invalid api key',
      status: 401,
    });

    const retryableTask = runtime.createTask({
      type: 'audit-retryable-task',
      max_attempts: 3,
      payload_json: { source: 'route-test' },
    });
    runtime.claimTask(retryableTask.id, 'route-audit-worker', { leaseMs: 60_000 });
    runtime.startTask(retryableTask.id, 'route-audit-worker');
    const timeoutErr = new Error('request timed out');
    timeoutErr.code = 'ETIMEDOUT';
    runtime.markFailed(retryableTask.id, 'route-audit-worker', timeoutErr);

    const auditRes = await _invokeRoute('get', '/:taskId/audit', {
      params: { taskId: nonRetryTask.id },
    });
    expect(auditRes.status).toBe(200);
    expect(auditRes.body.success).toBe(true);

    const nonRetryAttempt = auditRes.body.data.audit.attempts[0];
    expect(nonRetryAttempt.retryable).toBe(false);
    expect(nonRetryAttempt.retry_classification).toBe('non_retryable_error_type');
    expect(nonRetryAttempt.error_kind).toBeNull();
    expect(nonRetryAttempt.status_code).toBe(401);

    const nonRetryEvent = auditRes.body.data.audit.events.find((event) => event.state_to === 'failed');
    expect(nonRetryEvent).toBeTruthy();
    expect(nonRetryEvent.retryable).toBe(false);
    expect(nonRetryEvent.retry_classification).toBe('non_retryable_error_type');
    expect(nonRetryEvent.error_kind).toBeNull();
    expect(nonRetryEvent.status_code).toBe(401);

    const eventsRes = await _invokeRoute('get', '/events', {
      query: {
        task_id: retryableTask.id,
        limit: '200',
      },
    });
    expect(eventsRes.status).toBe(200);
    expect(eventsRes.body.success).toBe(true);
    const retryWaitEvent = eventsRes.body.data.events.find((event) => event.state_to === 'retry_wait');
    expect(retryWaitEvent).toBeTruthy();
    expect(retryWaitEvent.retryable).toBe(true);
    expect(retryWaitEvent.retry_classification).toBe('retryable_error_kind');
    expect(['timeout', 'network', 'rate_limit']).toContain(retryWaitEvent.error_kind);
    expect(retryWaitEvent.status_code).toBeNull();
  });

  test('runs next queued task via run-next endpoint', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'next-task',
        payload_json: {
          steps: [{ action: 'set', key: 'done', value: true }],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    const runNextRes = await _invokeRoute('post', '/run-next', {
      body: {
        dry_run: true,
        commit: false,
      },
    });
    expect(runNextRes.status).toBe(200);
    expect(runNextRes.body.success).toBe(true);
    expect(runNextRes.body.data.run_result.ok).toBe(true);
    expect(runNextRes.body.data.run_result.task.id).toBe(taskId);
  });

  test('starts worker loop, exposes status, and stops worker', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'worker-route-task',
        payload_json: {
          steps: [{ action: 'set', key: 'done', value: true }],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    const startRes = await _invokeRoute('post', '/worker/start', {
      body: {
        run_now: true,
        interval_ms: 5_000,
        max_runs_per_tick: 2,
        dry_run: true,
        commit: false,
      },
    });
    expect(startRes.status).toBe(200);
    expect(startRes.body.success).toBe(true);
    expect(startRes.body.data.worker.running).toBe(true);
    expect(startRes.body.data.worker.last_tick.executed).toBeGreaterThanOrEqual(1);

    const taskRes = await _invokeRoute('get', '/:taskId', {
      params: { taskId },
    });
    expect(taskRes.status).toBe(200);
    expect(taskRes.body.data.task.status).toBe('succeeded');

    const statusRes = await _invokeRoute('get', '/worker/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.success).toBe(true);
    expect(statusRes.body.data.worker.running).toBe(true);
    expect(statusRes.body.data.worker.queue_depth).toBe(0);
    expect(statusRes.body.data.worker.last_tick).toBeTruthy();

    const stopRes = await _invokeRoute('post', '/worker/stop');
    expect(stopRes.status).toBe(200);
    expect(stopRes.body.success).toBe(true);
    expect(stopRes.body.data.worker.running).toBe(false);
  });

  test('supports pause resume cancel task control endpoints', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'control-task',
        payload_json: {
          steps: [{ action: 'set', key: 'done', value: true }],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    runtime.claimTask(taskId, 'control-worker', { leaseMs: 60_000 });
    runtime.startTask(taskId, 'control-worker');

    const pauseRes = await _invokeRoute('post', '/:taskId/pause', {
      params: { taskId },
      body: {},
    });
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body.success).toBe(true);
    expect(pauseRes.body.data.task.status).toBe('paused');

    const pauseAgainRes = await _invokeRoute('post', '/:taskId/pause', {
      params: { taskId },
      body: {},
    });
    expect(pauseAgainRes.status).toBe(200);
    expect(pauseAgainRes.body.success).toBe(true);
    expect(pauseAgainRes.body.data.already_paused).toBe(true);
    expect(pauseAgainRes.body.data.task.status).toBe('paused');

    const resumeRes = await _invokeRoute('post', '/:taskId/resume', {
      params: { taskId },
      body: {},
    });
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.success).toBe(true);
    expect(resumeRes.body.data.task.status).toBe('running');

    const resumeAgainRes = await _invokeRoute('post', '/:taskId/resume', {
      params: { taskId },
      body: {},
    });
    expect(resumeAgainRes.status).toBe(200);
    expect(resumeAgainRes.body.success).toBe(true);
    expect(resumeAgainRes.body.data.already_running).toBe(true);
    expect(resumeAgainRes.body.data.task.status).toBe('running');

    const cancelRes = await _invokeRoute('post', '/:taskId/cancel', {
      params: { taskId },
      body: { reason: 'stop now' },
    });
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.success).toBe(true);
    expect(cancelRes.body.data.task.status).toBe('cancelled');

    const cannotResume = await _invokeRoute('post', '/:taskId/resume', {
      params: { taskId },
      body: {},
    });
    expect(cannotResume.status).toBe(409);
    expect(cannotResume.body.success).toBe(false);
    expect(cannotResume.body.data.code).toBe('terminal_task');
  });

  test('returns consistent task control error codes across endpoints', async () => {
    const missingTaskId = await _invokeRoute('post', '/:taskId/pause', {
      params: {},
      body: {},
    });
    expect(missingTaskId.status).toBe(400);
    expect(missingTaskId.body.success).toBe(false);
    expect(missingTaskId.body.data.code).toBe('missing_task_id');

    const notFound = await _invokeRoute('post', '/:taskId/cancel', {
      params: { taskId: 'not-found-task' },
      body: {},
    });
    expect(notFound.status).toBe(404);
    expect(notFound.body.success).toBe(false);
    expect(notFound.body.data.code).toBe('task_not_found');

    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'invalid-state-task',
        payload_json: {
          steps: [{ action: 'set', key: 'done', value: true }],
        },
      },
    });
    const queuedTaskId = createRes.body.data.task.id;

    const invalidPause = await _invokeRoute('post', '/:taskId/pause', {
      params: { taskId: queuedTaskId },
      body: {},
    });
    expect(invalidPause.status).toBe(409);
    expect(invalidPause.body.success).toBe(false);
    expect(invalidPause.body.data.code).toBe('invalid_state');

    const taskDetail = await _invokeRoute('get', '/:taskId', {
      params: { taskId: queuedTaskId },
    });
    expect(taskDetail.status).toBe(200);
    expect(taskDetail.body.success).toBe(true);
    expect(taskDetail.body.data.task.id).toBe(queuedTaskId);
  });

  test('returns cross-device handover snapshot with recent ops, active tasks, and approvals', async () => {
    const finishedRes = await _invokeRoute('post', '/', {
      body: {
        type: 'handover-finished-task',
        payload_json: {
          steps: [{ action: 'set', key: 'done', value: true }],
        },
      },
    });
    const finishedTaskId = finishedRes.body.data.task.id;
    await _invokeRoute('post', '/:taskId/run', {
      params: { taskId: finishedTaskId },
      body: { dry_run: true, commit: false },
    });

    const activeTask = runtime.createTask({
      type: 'handover-active-task',
      max_attempts: 3,
      payload_json: { source: 'handover_test' },
    });
    runtime.claimTask(activeTask.id, 'handover-worker', { leaseMs: 60_000 });
    runtime.startTask(activeTask.id, 'handover-worker');
    runtime.updateTaskFields(activeTask.id, { progress_pct: 40 });

    sshConnectionManager.connect({
      hostEntry: {
        alias: 'dev-remote',
        host: 'dev-remote.example',
        port: 22,
        user: 'developer',
      },
      workspace: '/workspace/app',
      purpose: 'development',
      traceId: 'trace-remote-handover',
    });

    remoteApprovalBridge.createTicket({
      traceId: 'trace-ticket-handover',
      connectionId: 'conn-handover',
      hostAlias: 'dev-remote',
      commands: ['git push origin main'],
      idempotencyKey: 'idem-handover-1',
    });
    runtime.updateRetryPolicyApprovalRetention(
      { ticket_max_total: 6_050 },
      {
        trace_id: 'trace-retention-handover',
        actor: 'handover-admin',
        source: 'route-test',
        reason: 'handover snapshot retention signal',
      }
    );

    const snapshotRes = await _invokeRoute('get', '/handover/snapshot', {
      query: {
        window_minutes: '120',
        operation_limit: '3',
        retention_limit: '3',
        running_limit: '20',
        approval_limit: '10',
        session_limit: '10',
        todo_limit: '10',
      },
    });
    expect(snapshotRes.status).toBe(200);
    expect(snapshotRes.body.success).toBe(true);

    const snapshot = snapshotRes.body.data.snapshot;
    expect(Array.isArray(snapshot.recent_operations)).toBe(true);
    expect(snapshot.recent_operations.length).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.active_large_tasks)).toBe(true);
    expect(snapshot.active_large_tasks.some((task) => task.task_id === activeTask.id)).toBe(true);
    expect(Array.isArray(snapshot.pending_remote_approvals)).toBe(true);
    expect(snapshot.pending_remote_approvals.length).toBe(1);
    expect(Array.isArray(snapshot.active_remote_sessions)).toBe(true);
    expect(snapshot.active_remote_sessions.length).toBe(1);
    expect(Array.isArray(snapshot.recent_retry_policy_approval_retention_changes)).toBe(true);
    expect(snapshot.recent_retry_policy_approval_retention_changes.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(snapshot.pending_todos)).toBe(true);
    expect(typeof snapshot.summary.queue_depth).toBe('number');
    expect(snapshot.summary.retention_policy_change_count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.pending_remote_approval_count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.active_remote_session_count).toBeGreaterThanOrEqual(1);
  });

  test('returns compact mobile handover snapshot when format=mobile', async () => {
    const taskRes = await _invokeRoute('post', '/', {
      body: {
        type: 'handover-mobile-task',
        payload_json: {
          steps: [{ action: 'set', key: 'ok', value: true }],
        },
      },
    });
    const taskId = taskRes.body.data.task.id;
    await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: { dry_run: true, commit: false },
    });

    remoteApprovalBridge.createTicket({
      traceId: 'trace-ticket-mobile',
      connectionId: 'conn-mobile',
      hostAlias: 'mobile-host',
      commands: ['git push origin main'],
      idempotencyKey: 'idem-mobile-1',
    });
    runtime.updateRetryPolicyApprovalRetention(
      { ticket_max_total: 6_150 },
      {
        trace_id: 'trace-retention-mobile',
        actor: 'mobile-admin',
        source: 'route-test',
        reason: 'mobile snapshot retention signal',
      }
    );

    const snapshotRes = await _invokeRoute('get', '/handover/snapshot', {
      query: {
        format: 'mobile',
        window_minutes: '120',
      },
    });
    expect(snapshotRes.status).toBe(200);
    expect(snapshotRes.body.success).toBe(true);

    const snapshot = snapshotRes.body.data.snapshot;
    expect(snapshot.mode).toBe('mobile_compact');
    expect(Array.isArray(snapshot.cards)).toBe(true);
    expect(snapshot.cards.length).toBeGreaterThanOrEqual(4);
    expect(Array.isArray(snapshot.top.recent_operations)).toBe(true);
    expect(Array.isArray(snapshot.top.active_large_tasks)).toBe(true);
    expect(Array.isArray(snapshot.top.pending_remote_approvals)).toBe(true);
    expect(Array.isArray(snapshot.top.pending_todos)).toBe(true);
    expect(Array.isArray(snapshot.top.recent_retention_policy_changes)).toBe(true);
    expect(snapshot.top.recent_retention_policy_changes.length).toBeGreaterThanOrEqual(1);
    expect(typeof snapshot.summary.queue_depth).toBe('number');
    expect(snapshot.summary.retention_policy_change_count).toBeGreaterThanOrEqual(1);
    expect(snapshot.summary.pending_remote_approval_count).toBeGreaterThanOrEqual(1);
  });

  test('lists task events with after_id filter', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'events-task',
        payload_json: {
          steps: [{ action: 'set', key: 'k', value: 1 }],
        },
      },
    });
    const taskId = createRes.body.data.task.id;

    await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: { dry_run: true, commit: false },
    });

    const allEventsRes = await _invokeRoute('get', '/events', {
      query: { task_id: taskId, limit: '200' },
    });
    expect(allEventsRes.status).toBe(200);
    expect(allEventsRes.body.success).toBe(true);
    expect(allEventsRes.body.data.events.length).toBeGreaterThan(0);

    const firstEventId = allEventsRes.body.data.events[0].event_id;
    const afterRes = await _invokeRoute('get', '/events', {
      query: {
        task_id: taskId,
        after_id: String(firstEventId),
        limit: '200',
      },
    });
    expect(afterRes.status).toBe(200);
    expect(afterRes.body.success).toBe(true);
    expect(afterRes.body.data.events.every((event) => event.event_id > firstEventId)).toBe(true);
  });

  test('streams replay events with watch=0 and respects Last-Event-ID fallback', async () => {
    const createRes = await _invokeRoute('post', '/', {
      body: {
        type: 'stream-task',
        payload_json: {
          steps: [{ action: 'set', key: 'x', value: 2 }],
        },
      },
    });
    const taskId = createRes.body.data.task.id;
    await _invokeRoute('post', '/:taskId/run', {
      params: { taskId },
      body: { dry_run: true, commit: false },
    });

    const listRes = await _invokeRoute('get', '/events', {
      query: { task_id: taskId, limit: '200' },
    });
    const allEvents = listRes.body.data.events;
    expect(allEvents.length).toBeGreaterThan(0);

    const replay = await _invokeStreamRoute({
      query: { task_id: taskId, watch: '0', limit: '200', after_id: '0' },
    });
    expect(replay.status).toBe(200);
    const ready = replay.events.find((event) => event.event === 'ready');
    const done = replay.events.find((event) => event.event === 'done');
    const taskEvents = replay.events.filter((event) => event.event === 'task_event');
    expect(ready).toBeTruthy();
    expect(done).toBeTruthy();
    expect(taskEvents.length).toBe(allEvents.length);
    expect(ready.data.replay_count).toBe(allEvents.length);

    const tailEventId = allEvents[allEvents.length - 1].event_id;
    const replayFromHeader = await _invokeStreamRoute({
      query: { task_id: taskId, watch: '0', limit: '200' },
      headers: { 'last-event-id': String(tailEventId) },
    });
    const ready2 = replayFromHeader.events.find((event) => event.event === 'ready');
    const replayed2 = replayFromHeader.events.filter((event) => event.event === 'task_event');
    expect(ready2).toBeTruthy();
    expect(ready2.data.after_id).toBe(tailEventId);
    expect(ready2.data.replay_count).toBe(0);
    expect(replayed2).toHaveLength(0);
  });

  test('streams retention audit events with watch=0 and Last-Event-ID fallback', async () => {
    const traceId = 'trace-retention-stream-route-1';
    const update = await _invokeRoute('post', '/retry-policy/approvals/retention', {
      headers: {
        'x-operator-id': 'mobile-admin',
        'x-trace-id': traceId,
      },
      body: {
        reason: 'retention stream replay test',
        retry_policy_approval_retention: {
          ticket_max_total: 6_100,
        },
      },
    });
    expect(update.status).toBe(200);
    expect(update.body.success).toBe(true);

    const replay = await _invokeStreamRoute('/retry-policy/approvals/retention/stream', {
      query: {
        trace_id: traceId,
        watch: '0',
        limit: '200',
        after_id: '0',
      },
    });
    expect(replay.status).toBe(200);
    const ready = replay.events.find((event) => event.event === 'ready');
    const done = replay.events.find((event) => event.event === 'done');
    const retentionEvents = replay.events.filter((event) => event.event === 'retry_policy_approval_retention_event');
    expect(ready).toBeTruthy();
    expect(done).toBeTruthy();
    expect(retentionEvents.length).toBeGreaterThanOrEqual(1);
    expect(retentionEvents.every((item) => item.data.trace_id === traceId)).toBe(true);

    const tailEventId = retentionEvents[retentionEvents.length - 1].id;
    const replayFromHeader = await _invokeStreamRoute('/retry-policy/approvals/retention/stream', {
      query: {
        trace_id: traceId,
        watch: '0',
        limit: '200',
      },
      headers: { 'last-event-id': String(tailEventId) },
    });
    const ready2 = replayFromHeader.events.find((event) => event.event === 'ready');
    const replayed2 = replayFromHeader.events
      .filter((event) => event.event === 'retry_policy_approval_retention_event');
    expect(ready2).toBeTruthy();
    expect(ready2.data.after_id).toBe(tailEventId);
    expect(ready2.data.replay_count).toBe(0);
    expect(replayed2).toHaveLength(0);
  });

  test('streams retry-policy approval events with watch=0 and Last-Event-ID fallback', async () => {
    const requestApproval = await _invokeRoute('post', '/retry-policy', {
      headers: { 'x-operator-id': 'mobile-admin' },
      body: {
        reason: 'require approval for high-risk policy',
        retry_policy: {
          default_retryable: false,
        },
      },
    });
    expect(requestApproval.status).toBe(202);
    const ticketId = requestApproval.body.data.approval_ticket.ticket_id;

    const approveRes = await _invokeRoute('post', '/retry-policy/approvals/decision', {
      body: {
        ticket_id: ticketId,
        decision: 'approve',
        reviewer: 'owner-1',
      },
    });
    expect(approveRes.status).toBe(200);
    expect(approveRes.body.success).toBe(true);

    const replay = await _invokeStreamRoute('/retry-policy/approvals/stream', {
      query: {
        ticket_id: ticketId,
        watch: '0',
        limit: '200',
        after_id: '0',
      },
    });
    expect(replay.status).toBe(200);
    const ready = replay.events.find((event) => event.event === 'ready');
    const done = replay.events.find((event) => event.event === 'done');
    const approvalEvents = replay.events.filter((event) => event.event === 'retry_policy_approval_event');
    expect(ready).toBeTruthy();
    expect(done).toBeTruthy();
    expect(approvalEvents.length).toBeGreaterThanOrEqual(2);
    expect(approvalEvents.some((item) => item.data.event_type === 'ticket_created')).toBe(true);
    expect(approvalEvents.some((item) => item.data.event_type === 'ticket_approved')).toBe(true);

    const tailEventId = approvalEvents[approvalEvents.length - 1].id;
    const replayFromHeader = await _invokeStreamRoute('/retry-policy/approvals/stream', {
      query: {
        ticket_id: ticketId,
        watch: '0',
        limit: '200',
      },
      headers: { 'last-event-id': String(tailEventId) },
    });
    const ready2 = replayFromHeader.events.find((event) => event.event === 'ready');
    const replayed2 = replayFromHeader.events.filter((event) => event.event === 'retry_policy_approval_event');
    expect(ready2).toBeTruthy();
    expect(ready2.data.after_id).toBe(tailEventId);
    expect(ready2.data.replay_count).toBe(0);
    expect(replayed2).toHaveLength(0);
  });
});
