'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');

describe('largeTaskRuntimeStore', () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-large-task-store-'));
    storePath = path.join(tempDir, 'runtime.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('validates transitions and enforces terminal immutability', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const task = store.createTask({ type: 'demo-task', max_attempts: 2 });

    expect(() => store.transitionTask(task.id, 'succeeded')).toThrow('Invalid task transition');

    store.transitionTask(task.id, 'claimed', {
      lease_owner: 'worker-1',
      lease_until: new Date(Date.now() + 1000).toISOString(),
      heartbeat_at: new Date().toISOString(),
    });
    store.transitionTask(task.id, 'running');
    store.markSucceeded(task.id, 'worker-1', { ok: true }, { progress_pct: 100 });

    const terminal = store.getTask(task.id);
    expect(terminal.status).toBe('succeeded');

    expect(() => store.transitionTask(task.id, 'running')).toThrow('Terminal task is immutable');
  });

  test('moves task to dead_letter after retry budget is exhausted', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const task = store.createTask({ type: 'retry-task', max_attempts: 2 });

    store.claimTask(task.id, 'worker-a', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-a');
    const first = store.markFailed(task.id, 'worker-a', new Error('transient failure'));
    expect(first.retry_scheduled).toBe(true);
    expect(store.getTask(task.id).status).toBe('retry_wait');

    // Force immediate retry to avoid waiting for backoff in test.
    store.updateTaskFields(task.id, { next_run_at: new Date(Date.now() - 1000).toISOString() });
    store.claimTask(task.id, 'worker-a', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-a');
    const second = store.markFailed(task.id, 'worker-a', new Error('final failure'));

    expect(second.dead_letter).toBe(true);
    const finalTask = store.getTask(task.id);
    expect(finalTask.status).toBe('dead_letter');
    expect(finalTask.attempt_count).toBe(2);
  });

  test('restores checkpoint state after simulated restart', () => {
    const storeA = createLargeTaskRuntimeStore({ storePath });
    const task = storeA.createTask({ type: 'checkpoint-task', max_attempts: 3 });
    storeA.claimTask(task.id, 'worker-c', { leaseMs: 30_000 });
    storeA.startTask(task.id, 'worker-c');

    const checkpoint = storeA.saveCheckpoint(task.id, {
      step_no: 7,
      progress_pct: 70,
      schema_version: 1,
      state_blob_json: { cursor: 4200, shard: 'A' },
    });
    expect(checkpoint.step_no).toBe(7);

    // Simulate process restart by creating a new store instance.
    const storeB = createLargeTaskRuntimeStore({ storePath });
    const loadedTask = storeB.getTask(task.id);
    expect(loadedTask).toBeTruthy();
    expect(loadedTask.progress_pct).toBe(70);

    const latest = storeB.getLatestCheckpoint(task.id, { allowed_schema_versions: [1] });
    expect(latest).toBeTruthy();
    expect(latest.step_no).toBe(7);
    expect(latest.state_blob_json).toEqual({ cursor: 4200, shard: 'A' });

    const resumed = storeB.resumeFromCheckpoint(task.id, { allowed_schema_versions: [1] });
    expect(resumed.resumed).toBe(true);
    expect(resumed.task.payload_json.resume_from_checkpoint.step_no).toBe(7);
  });

  test('replays idempotent side effects and prevents duplicate execution', async () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    let sideEffectCount = 0;

    const first = await store.executeIdempotentSideEffect({
      scope: 'payments',
      idempotency_key: 'idem-001',
      intent_hash: 'intent-a',
      executor: async () => {
        sideEffectCount++;
        return { transfer_id: 'txn-1', amount: 100 };
      },
    });

    const second = await store.executeIdempotentSideEffect({
      scope: 'payments',
      idempotency_key: 'idem-001',
      intent_hash: 'intent-a',
      executor: async () => {
        sideEffectCount++;
        return { transfer_id: 'txn-2', amount: 100 };
      },
    });

    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(sideEffectCount).toBe(1);
    expect(second.result).toEqual({ transfer_id: 'txn-1', amount: 100 });
  });

  test('rejects idempotency key reuse with different intent hash', async () => {
    const store = createLargeTaskRuntimeStore({ storePath });

    await store.executeIdempotentSideEffect({
      scope: 'deploy',
      idempotency_key: 'idem-xyz',
      intent_hash: 'intent-v1',
      executor: async () => ({ ok: true }),
    });

    const conflict = await store.executeIdempotentSideEffect({
      scope: 'deploy',
      idempotency_key: 'idem-xyz',
      intent_hash: 'intent-v2',
      executor: async () => ({ ok: false }),
    });

    expect(conflict.ok).toBe(false);
    expect(conflict.code).toBe('idempotency_conflict');
  });

  test('records transition events and exposes metrics snapshot', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const task = store.createTask({ type: 'metrics-task', max_attempts: 2 });

    store.claimTask(task.id, 'worker-m', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-m');
    store.markSucceeded(task.id, 'worker-m', { ok: true }, { progress_pct: 100 });

    const events = store.listTaskEvents({ task_id: task.id });
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(events.some((event) => event.state_to === 'claimed')).toBe(true);
    expect(events.some((event) => event.state_to === 'running')).toBe(true);
    expect(events.some((event) => event.state_to === 'succeeded')).toBe(true);

    const metrics = store.getMetricsSnapshot();
    expect(metrics.task_total).toBeGreaterThanOrEqual(1);
    expect(metrics.terminal_total).toBeGreaterThanOrEqual(1);
    expect(metrics.success_rate).toBeGreaterThan(0);
    expect(metrics.event_total).toBeGreaterThanOrEqual(events.length);
  });

  test('requeues expired leases for running tasks', () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const store = createLargeTaskRuntimeStore({
      storePath,
      nowFn: () => nowMs,
    });
    const task = store.createTask({ type: 'lease-task', max_attempts: 3 });
    store.claimTask(task.id, 'worker-l', { leaseMs: 1_000 });
    store.startTask(task.id, 'worker-l');

    nowMs += 2_000;
    const result = store.requeueExpiredLeases();
    expect(result.requeued).toBe(1);

    const requeued = store.getTask(task.id);
    expect(requeued.status).toBe('retry_wait');
    expect(requeued.lease_owner).toBeNull();
  });

  test('streams task events through subscription and emits monotonic event_id', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const observed = [];
    const unsubscribe = store.subscribeTaskEvents((event) => {
      observed.push(event);
    });

    const task = store.createTask({ type: 'sub-task', max_attempts: 2 });
    store.claimTask(task.id, 'worker-sub', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-sub');
    store.markSucceeded(task.id, 'worker-sub', { ok: true }, { progress_pct: 100 });
    unsubscribe();

    expect(observed.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < observed.length; i += 1) {
      expect(observed[i].event_id).toBeGreaterThan(observed[i - 1].event_id);
    }
    expect(observed.every((event) => event.task_id === task.id)).toBe(true);
  });

  test('classifies auth failures as non-retryable and terminates immediately', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const task = store.createTask({ type: 'auth-fail-task', max_attempts: 5 });
    store.claimTask(task.id, 'worker-auth', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-auth');

    const result = store.markFailed(task.id, 'worker-auth', {
      type: 'auth',
      message: 'invalid api key',
      status: 401,
    });

    expect(result.retry_scheduled).toBe(false);
    expect(result.dead_letter).toBeFalsy();
    expect(result.retry_classification).toBe('non_retryable_error_type');

    const finalTask = store.getTask(task.id);
    expect(finalTask.status).toBe('failed');
    expect(finalTask.attempt_count).toBe(1);
    expect(finalTask.last_error.retryable).toBe(false);
    expect(finalTask.last_error.status_code).toBe(401);

    const attempts = store.getAttempts(task.id);
    expect(attempts[0].retryable).toBe(false);
    expect(attempts[0].retry_classification).toBe('non_retryable_error_type');
    expect(attempts[0].status_code).toBe(401);

    const events = store.listTaskEvents({ task_id: task.id });
    const failedEvent = events.find((event) => event.state_to === 'failed');
    expect(failedEvent).toBeTruthy();
    expect(failedEvent.retryable).toBe(false);
    expect(failedEvent.retry_classification).toBe('non_retryable_error_type');
    expect(failedEvent.status_code).toBe(401);
  });

  test('classifies timeout failures as retryable and schedules retry', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const task = store.createTask({ type: 'timeout-fail-task', max_attempts: 3 });
    store.claimTask(task.id, 'worker-timeout', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-timeout');

    const timeoutErr = new Error('request timed out');
    timeoutErr.code = 'ETIMEDOUT';
    const result = store.markFailed(task.id, 'worker-timeout', timeoutErr);

    expect(result.retry_scheduled).toBe(true);
    expect(result.retry_delay_ms).toBeGreaterThanOrEqual(0);
    expect(result.retry_classification).toBe('retryable_error_kind');

    const queued = store.getTask(task.id);
    expect(queued.status).toBe('retry_wait');
    expect(queued.last_error.retryable).toBe(true);

    const attempts = store.getAttempts(task.id);
    expect(attempts[0].retryable).toBe(true);
    expect(attempts[0].retry_classification).toBe('retryable_error_kind');
    expect(['timeout', 'network', 'rate_limit']).toContain(attempts[0].error_kind);
    expect(attempts[0].status_code).toBeNull();

    const events = store.listTaskEvents({ task_id: task.id });
    const retryEvent = events.find((event) => event.state_to === 'retry_wait');
    expect(retryEvent).toBeTruthy();
    expect(retryEvent.retryable).toBe(true);
    expect(retryEvent.retry_classification).toBe('retryable_error_kind');
    expect(['timeout', 'network', 'rate_limit']).toContain(retryEvent.error_kind);
    expect(retryEvent.status_code).toBeNull();
  });

  test('supports store-level retry policy override for default non-retryable behavior', () => {
    const store = createLargeTaskRuntimeStore({
      storePath,
      retry_policy: {
        default_retryable: false,
      },
    });
    const task = store.createTask({ type: 'policy-default-fail-task', max_attempts: 3 });
    store.claimTask(task.id, 'worker-policy', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-policy');

    const result = store.markFailed(task.id, 'worker-policy', new Error('unexpected failure'));

    expect(result.retry_scheduled).toBe(false);
    expect(result.dead_letter).toBe(false);
    expect(result.retry_classification).toBe('default_non_retryable');
    expect(store.getTask(task.id).status).toBe('failed');
  });

  test('supports per-call retry policy override in markFailed', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const task = store.createTask({ type: 'policy-call-override-task', max_attempts: 3 });
    store.claimTask(task.id, 'worker-policy', { leaseMs: 10_000 });
    store.startTask(task.id, 'worker-policy');

    const result = store.markFailed(task.id, 'worker-policy', new Error('generic handler failure'), {
      retry_policy: {
        non_retryable_error_types: ['error'],
      },
    });

    expect(result.retry_scheduled).toBe(false);
    expect(result.dead_letter).toBe(false);
    expect(result.retry_classification).toBe('non_retryable_error_type');
    expect(store.getTask(task.id).status).toBe('failed');
  });

  test('exposes and updates retry policy snapshots', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const before = store.getRetryPolicy();
    expect(Array.isArray(before.non_retryable_error_types)).toBe(true);
    expect(before.non_retryable_status_codes).toContain(401);
    expect(before.default_retryable).toBe(true);

    const updated = store.setRetryPolicy({
      non_retryable_status_codes: [400, 418, 418],
      default_retryable: false,
    });
    expect(updated.non_retryable_status_codes).toEqual([400, 418]);
    expect(updated.default_retryable).toBe(false);
    expect(updated.non_retryable_error_types).toEqual(before.non_retryable_error_types);
  });

  test('records retry policy update audit events with metadata', () => {
    const store = createLargeTaskRuntimeStore({ storePath });

    const updated = store.updateRetryPolicy({
      default_retryable: false,
      retryable_error_kinds: ['timeout', 'network'],
    }, {
      trace_id: 'trace-policy-update-1',
      actor: 'tester',
      source: 'unit_test',
      reason: 'tighten retries for deterministic failures',
    });

    expect(updated.changed).toBe(true);
    expect(updated.policy.default_retryable).toBe(false);
    expect(updated.event.policy_event_id).toBeGreaterThan(0);
    expect(updated.event.actor).toBe('tester');
    expect(updated.event.trace_id).toBe('trace-policy-update-1');
    expect(updated.event.changed).toBe(true);
    expect(updated.event.before_policy.default_retryable).toBe(true);
    expect(updated.event.after_policy.default_retryable).toBe(false);

    const events = store.listRetryPolicyEvents({ limit: 10 });
    expect(events).toHaveLength(1);
    expect(events[0].policy_event_id).toBe(updated.event.policy_event_id);
  });

  test('filters retry policy events by after_id and trace_id', () => {
    const store = createLargeTaskRuntimeStore({ storePath });

    const first = store.updateRetryPolicy({ default_retryable: false }, {
      trace_id: 'trace-a',
      actor: 'tester-a',
      source: 'unit_test',
    });
    const second = store.updateRetryPolicy({ default_retryable: true }, {
      trace_id: 'trace-b',
      actor: 'tester-b',
      source: 'unit_test',
    });

    const afterFirst = store.listRetryPolicyEvents({
      after_id: first.event.policy_event_id,
      limit: 10,
    });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].policy_event_id).toBe(second.event.policy_event_id);

    const traceOnly = store.listRetryPolicyEvents({
      trace_id: 'trace-a',
      limit: 10,
    });
    expect(traceOnly).toHaveLength(1);
    expect(traceOnly[0].trace_id).toBe('trace-a');
  });

  test('handles retry policy approval ticket lifecycle', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const patch = {
      default_retryable: false,
      non_retryable_error_kinds: ['timeout'],
    };
    const ticket = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-approval-1',
      requester: 'tester',
      reason: 'high-risk change requires review',
      patch,
      risk_level: 'critical',
      risk_reason: 'default_retryable changed to false',
      ttl_ms: 60_000,
    });

    expect(ticket.ticket_id).toBeTruthy();
    expect(ticket.status).toBe('pending');
    expect(ticket.patch_hash).toBeTruthy();

    const pending = store.listRetryPolicyApprovalTickets({ status: 'pending', limit: 20 });
    expect(pending.some((item) => item.ticket_id === ticket.ticket_id)).toBe(true);

    const approved = store.approveRetryPolicyApprovalTicket(ticket.ticket_id, 'reviewer-1');
    expect(approved.status).toBe('approved');
    expect(approved.approved_by).toBe('reviewer-1');

    const consume = store.consumeRetryPolicyApprovalTicket(ticket.ticket_id, { patch });
    expect(consume.ok).toBe(true);
    expect(consume.ticket.status).toBe('consumed');
    expect(consume.ticket.consumed_at).toBeTruthy();
  });

  test('rejects approval ticket consumption with mismatched patch', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const ticket = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-approval-2',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'default_retryable changed to false',
    });
    store.approveRetryPolicyApprovalTicket(ticket.ticket_id, 'reviewer-2');

    const consume = store.consumeRetryPolicyApprovalTicket(ticket.ticket_id, {
      patch: { default_retryable: true },
    });
    expect(consume.ok).toBe(false);
    expect(consume.code).toBe('ticket_patch_mismatch');
  });

  test('streams retry policy approval events through subscription', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const observed = [];
    const unsubscribe = store.subscribeRetryPolicyApprovalEvents((event) => {
      observed.push(event);
    });

    const ticket = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-approval-stream-1',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'default_retryable changed to false',
    });
    store.approveRetryPolicyApprovalTicket(ticket.ticket_id, 'reviewer');
    unsubscribe();

    expect(observed.length).toBeGreaterThanOrEqual(2);
    const created = observed.find((event) => event.event_type === 'ticket_created');
    const approved = observed.find((event) => event.event_type === 'ticket_approved');
    expect(created).toBeTruthy();
    expect(approved).toBeTruthy();
    expect(approved.approval_event_id).toBeGreaterThan(created.approval_event_id);
    expect(observed.every((event) => event.ticket_id === ticket.ticket_id)).toBe(true);
  });

  test('prunes aged terminal approval tickets and events via retention policy', () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const store = createLargeTaskRuntimeStore({
      storePath,
      nowFn: () => nowMs,
      approval_retention: {
        ticket_max_total: 100,
        event_max_total: 100,
        terminal_ticket_max_count: 100,
        terminal_ticket_max_age_ms: 60_000,
        event_max_age_ms: 60_000,
      },
    });

    const oldTicket = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-retention-old',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'test retention prune by age',
    });
    store.rejectRetryPolicyApprovalTicket(oldTicket.ticket_id, 'reviewer-old', 'age-prune');

    nowMs += 120_000;

    const freshTicket = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-retention-fresh',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'test retention fresh ticket',
    });
    store.rejectRetryPolicyApprovalTicket(freshTicket.ticket_id, 'reviewer-fresh', 'keep-fresh');

    const allTickets = store.listRetryPolicyApprovalTickets({ limit: 20 });
    expect(allTickets.some((item) => item.ticket_id === oldTicket.ticket_id)).toBe(false);
    expect(allTickets.some((item) => item.ticket_id === freshTicket.ticket_id)).toBe(true);

    const oldEvents = store.listRetryPolicyApprovalEvents({
      ticket_id: oldTicket.ticket_id,
      limit: 20,
    });
    expect(oldEvents).toHaveLength(0);
  });

  test('keeps pending approval tickets while bounding terminal ticket count', () => {
    let nowMs = Date.parse('2026-02-01T00:00:00.000Z');
    const store = createLargeTaskRuntimeStore({
      storePath,
      nowFn: () => nowMs,
      approval_retention: {
        ticket_max_total: 100,
        event_max_total: 100,
        terminal_ticket_max_count: 1,
        terminal_ticket_max_age_ms: 365 * 24 * 60 * 60_000,
        event_max_age_ms: 365 * 24 * 60 * 60_000,
      },
    });

    const pending = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-retention-pending',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'pending ticket should be kept',
    });

    nowMs += 1_000;
    const terminalA = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-retention-a',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'terminal A',
    });
    store.rejectRetryPolicyApprovalTicket(terminalA.ticket_id, 'reviewer-a', 'reject-a');

    nowMs += 1_000;
    const terminalB = store.createRetryPolicyApprovalTicket({
      trace_id: 'trace-retention-b',
      requester: 'tester',
      patch: { default_retryable: false },
      risk_level: 'critical',
      risk_reason: 'terminal B',
    });
    store.rejectRetryPolicyApprovalTicket(terminalB.ticket_id, 'reviewer-b', 'reject-b');

    const tickets = store.listRetryPolicyApprovalTickets({ limit: 20 });
    const terminalTickets = tickets.filter((item) => ['consumed', 'rejected', 'expired'].includes(item.status));
    expect(tickets.some((item) => item.ticket_id === pending.ticket_id)).toBe(true);
    expect(terminalTickets).toHaveLength(1);
    expect(terminalTickets[0].ticket_id).toBe(terminalB.ticket_id);
  });

  test('updates and persists retry policy approval retention settings', () => {
    const storeA = createLargeTaskRuntimeStore({ storePath });
    const before = storeA.getRetryPolicyApprovalRetention();
    expect(before.ticket_max_total).toBeGreaterThan(0);

    const update = storeA.updateRetryPolicyApprovalRetention({
      ticket_max_total: 777,
      event_max_total: 888,
      terminal_ticket_max_count: 99,
      terminal_ticket_max_age_ms: 120_000,
      event_max_age_ms: 180_000,
    });
    expect(update.changed).toBe(true);
    expect(update.retention.ticket_max_total).toBe(777);
    expect(update.retention.event_max_total).toBe(888);
    expect(update.retention.terminal_ticket_max_count).toBe(99);
    expect(update.retention.terminal_ticket_max_age_ms).toBe(120_000);
    expect(update.retention.event_max_age_ms).toBe(180_000);

    const updateNoChange = storeA.updateRetryPolicyApprovalRetention({
      ticket_max_total: 777,
      event_max_total: 888,
      terminal_ticket_max_count: 99,
      terminal_ticket_max_age_ms: 120_000,
      event_max_age_ms: 180_000,
    });
    expect(updateNoChange.changed).toBe(false);

    const storeB = createLargeTaskRuntimeStore({ storePath });
    const loaded = storeB.getRetryPolicyApprovalRetention();
    expect(loaded.ticket_max_total).toBe(777);
    expect(loaded.event_max_total).toBe(888);
    expect(loaded.terminal_ticket_max_count).toBe(99);
    expect(loaded.terminal_ticket_max_age_ms).toBe(120_000);
    expect(loaded.event_max_age_ms).toBe(180_000);
  });

  test('records retention audit events with metadata and filters by after_id/trace_id', () => {
    const store = createLargeTaskRuntimeStore({ storePath });

    const first = store.updateRetryPolicyApprovalRetention({
      ticket_max_total: 901,
    }, {
      trace_id: 'trace-retention-audit-1',
      actor: 'tester-1',
      source: 'unit_test',
      reason: 'tighten ticket cap',
    });
    expect(first.event.retention_event_id).toBeGreaterThan(0);
    expect(first.event.trace_id).toBe('trace-retention-audit-1');
    expect(first.event.actor).toBe('tester-1');
    expect(first.event.changed).toBe(true);

    const second = store.updateRetryPolicyApprovalRetention({
      event_max_total: 1500,
    }, {
      trace_id: 'trace-retention-audit-2',
      actor: 'tester-2',
      source: 'unit_test',
      reason: 'adjust event cap',
    });
    expect(second.event.retention_event_id).toBeGreaterThan(first.event.retention_event_id);

    const afterFirst = store.listRetryPolicyApprovalRetentionEvents({
      after_id: first.event.retention_event_id,
      limit: 10,
    });
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].retention_event_id).toBe(second.event.retention_event_id);

    const traceOnly = store.listRetryPolicyApprovalRetentionEvents({
      trace_id: 'trace-retention-audit-1',
      limit: 10,
    });
    expect(traceOnly).toHaveLength(1);
    expect(traceOnly[0].trace_id).toBe('trace-retention-audit-1');
    expect(traceOnly[0].before_retention.ticket_max_total).toBeGreaterThan(0);
    expect(traceOnly[0].after_retention.ticket_max_total).toBe(901);
  });

  test('streams retention audit events through subscription', () => {
    const store = createLargeTaskRuntimeStore({ storePath });
    const observed = [];
    const unsubscribe = store.subscribeRetryPolicyApprovalRetentionEvents((event) => {
      observed.push(event);
    });

    store.updateRetryPolicyApprovalRetention({
      ticket_max_total: 1200,
    }, {
      trace_id: 'trace-retention-stream-1',
      actor: 'tester-stream',
      source: 'unit_test',
      reason: 'stream event one',
    });
    store.updateRetryPolicyApprovalRetention({
      event_max_total: 2400,
    }, {
      trace_id: 'trace-retention-stream-1',
      actor: 'tester-stream',
      source: 'unit_test',
      reason: 'stream event two',
    });
    unsubscribe();

    expect(observed.length).toBeGreaterThanOrEqual(2);
    expect(observed.every((event) => event.trace_id === 'trace-retention-stream-1')).toBe(true);
    expect(observed[0].retention_event_id).toBeGreaterThan(0);
    expect(observed[1].retention_event_id).toBeGreaterThan(observed[0].retention_event_id);
  });
});
