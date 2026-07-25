'use strict';

const { EventEmitter } = require('events');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const { spawn } = require('child_process');
const { RemoteExecService } = require('../../src/services/remote/remoteExecService');
const { createRemoteApprovalBridge } = require('../../src/services/remote/remoteApprovalBridge');

function makeFakeSshChild({ stdout = [], stderr = [], code = 0, signal = null }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();

  process.nextTick(() => {
    for (const chunk of stdout) {
      child.stdout.emit('data', Buffer.from(String(chunk), 'utf8'));
    }
    for (const chunk of stderr) {
      child.stderr.emit('data', Buffer.from(String(chunk), 'utf8'));
    }
    child.emit('close', code, signal);
  });

  return child;
}

describe('RemoteExecService live execution', () => {
  const originalEnableExec = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
  const originalIdle = process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS;

  let connectionManager;
  let approvalBridge;
  let service;

  beforeEach(() => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS = '30000';
    spawn.mockReset();

    const sessions = new Map();
    connectionManager = {
      getSession: jest.fn((connectionId) => sessions.get(connectionId) || null),
      touch: jest.fn((connectionId) => {
        const session = sessions.get(connectionId);
        if (!session) return false;
        session.lastActivityAt = new Date().toISOString();
        return true;
      }),
    };

    approvalBridge = createRemoteApprovalBridge();

    const session = {
      connectionId: 'conn-live-1',
      traceId: 'trace-live-1',
      hostAlias: 'demo-live',
      remoteUser: 'devops',
      remoteWorkspace: '~/project',
    };
    sessions.set(session.connectionId, session);

    service = new RemoteExecService({
      connectionManager,
      approvalBridge,
    });
  });

  afterAll(() => {
    if (originalEnableExec === undefined) {
      delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
    } else {
      process.env.KHY_REMOTE_SSH_ENABLE_EXEC = originalEnableExec;
    }

    if (originalIdle === undefined) {
      delete process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS;
    } else {
      process.env.KHY_REMOTE_SSH_IDLE_TIMEOUT_MS = originalIdle;
    }
  });

  test('executes command and returns idempotent replay on repeated same key', async () => {
    spawn.mockImplementation(() => makeFakeSshChild({ stdout: ['ok line\n'], code: 0 }));

    const first = await service.requestExecution({
      connectionId: 'conn-live-1',
      commands: ['echo hello'],
      idempotencyKey: 'idem-live-1',
      traceId: 'trace-live-1',
    });

    expect(first.status).toBe('completed');
    expect(first.summary.executed_steps).toBe(1);
    expect(spawn).toHaveBeenCalledTimes(1);

    const second = await service.requestExecution({
      connectionId: 'conn-live-1',
      commands: ['echo hello'],
      idempotencyKey: 'idem-live-1',
      traceId: 'trace-live-1',
    });

    expect(second.status).toBe('idempotent_replay');
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  test('consumes approved ticket once for dangerous command', async () => {
    spawn.mockImplementation(() => makeFakeSshChild({ stdout: ['deleted\n'], code: 0 }));

    const ticket = approvalBridge.createTicket({
      traceId: 'trace-live-1',
      connectionId: 'conn-live-1',
      hostAlias: 'demo-live',
      commands: ['rm -rf /tmp/build-cache'],
      idempotencyKey: 'idem-live-2',
      riskContext: { source: 'test' },
    });
    approvalBridge.approveTicket(ticket.ticket_id, 'tester');

    const first = await service.requestExecution({
      connectionId: 'conn-live-1',
      commands: ['rm -rf /tmp/build-cache'],
      idempotencyKey: 'idem-live-2',
      approvalTicketId: ticket.ticket_id,
      traceId: 'trace-live-1',
    });

    expect(first.status).toBe('completed');

    const storedTicket = approvalBridge.getTicket(ticket.ticket_id);
    expect(storedTicket.consumed_at).toBeTruthy();
    expect(storedTicket.consumed_by_idempotency_key).toBe('idem-live-2');

    const freshService = new RemoteExecService({
      connectionManager,
      approvalBridge,
    });

    const second = await freshService.requestExecution({
      connectionId: 'conn-live-1',
      commands: ['rm -rf /tmp/build-cache'],
      idempotencyKey: 'idem-live-2',
      approvalTicketId: ticket.ticket_id,
      traceId: 'trace-live-1',
    });

    expect(second.status).toBe('approval_ticket_consumed');
  });
});
