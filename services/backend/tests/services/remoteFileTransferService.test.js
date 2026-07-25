'use strict';

/**
 * remoteFileTransferService.test.js — unit locks for the scp upload service.
 *
 * Mirrors the mock pattern of remoteExecService.liveExec.test.js: child_process
 * is mocked so scp never actually runs; a fake child emits stdout/stderr/close.
 * Asserts: gating (execution_disabled), correct scp args (alias destination),
 * secret redaction, idempotency replay, and the failure path.
 */

const { EventEmitter } = require('events');

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

const { spawn } = require('child_process');
const { createRemoteFileTransferService } = require('../../src/services/remote/remoteFileTransferService');

function makeFakeScpChild({ stdout = [], stderr = [], code = 0, signal = null }) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();

  process.nextTick(() => {
    for (const chunk of stdout) child.stdout.emit('data', Buffer.from(String(chunk), 'utf8'));
    for (const chunk of stderr) child.stderr.emit('data', Buffer.from(String(chunk), 'utf8'));
    child.emit('close', code, signal);
  });

  return child;
}

describe('RemoteFileTransferService', () => {
  const originalEnableExec = process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
  let connectionManager;
  let service;

  beforeEach(() => {
    spawn.mockReset();
    const sessions = new Map();
    sessions.set('conn-1', {
      connectionId: 'conn-1',
      traceId: 'trace-1',
      hostAlias: 'demo-host',
      remoteUser: 'devops',
      remoteWorkspace: '~/app',
    });
    connectionManager = {
      getSession: jest.fn((id) => sessions.get(id) || null),
      touch: jest.fn(() => true),
    };
    service = createRemoteFileTransferService({ connectionManager });
  });

  afterAll(() => {
    if (originalEnableExec === undefined) delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;
    else process.env.KHY_REMOTE_SSH_ENABLE_EXEC = originalEnableExec;
  });

  test('returns execution_disabled and never spawns when gate is off', async () => {
    delete process.env.KHY_REMOTE_SSH_ENABLE_EXEC;

    const res = await service.upload({
      connectionId: 'conn-1',
      localPath: '/tmp/bundle.tar.gz',
      remotePath: 'bundle.tar.gz',
      idempotencyKey: 'k1',
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('execution_disabled');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('spawns scp with alias destination and BatchMode when gate is on', async () => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    spawn.mockImplementation(() => makeFakeScpChild({ stdout: ['done\n'], code: 0 }));

    const res = await service.upload({
      connectionId: 'conn-1',
      localPath: '/tmp/bundle.tar.gz',
      remotePath: 'bundle.tar.gz',
      idempotencyKey: 'k2',
    });

    expect(res.ok).toBe(true);
    expect(res.status).toBe('uploaded');
    expect(spawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawn.mock.calls[0];
    expect(cmd).toBe('scp');
    expect(args).toContain('-o');
    expect(args).toContain('BatchMode=yes');
    // Local source then alias:remote destination (alias resolves ~/.ssh/config).
    expect(args).toContain('/tmp/bundle.tar.gz');
    expect(args).toContain('demo-host:bundle.tar.gz');
    // No inline host/user/key material is passed.
    expect(args.join(' ')).not.toContain('devops@');
  });

  test('redacts secrets from stderr preview', async () => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    spawn.mockImplementation(() => makeFakeScpChild({
      stderr: ['warning token=supersecret123\n'],
      code: 1,
    }));

    const res = await service.upload({
      connectionId: 'conn-1',
      localPath: '/tmp/bundle.tar.gz',
      remotePath: 'bundle.tar.gz',
      idempotencyKey: 'k3',
    });

    expect(res.ok).toBe(false);
    expect(res.status).toBe('upload_failed');
    expect(res.stderr_preview).toContain('token=***');
    expect(res.stderr_preview).not.toContain('supersecret123');
  });

  test('requires idempotency key', async () => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    const res = await service.upload({
      connectionId: 'conn-1',
      localPath: '/tmp/bundle.tar.gz',
      remotePath: 'bundle.tar.gz',
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe('idempotency_key_required');
    expect(spawn).not.toHaveBeenCalled();
  });

  test('replays a prior successful upload for the same idempotency key', async () => {
    process.env.KHY_REMOTE_SSH_ENABLE_EXEC = 'true';
    spawn.mockImplementation(() => makeFakeScpChild({ code: 0 }));

    const first = await service.upload({
      connectionId: 'conn-1', localPath: '/tmp/b.tar.gz', remotePath: 'b.tar.gz', idempotencyKey: 'dup',
    });
    const second = await service.upload({
      connectionId: 'conn-1', localPath: '/tmp/b.tar.gz', remotePath: 'b.tar.gz', idempotencyKey: 'dup',
    });

    expect(first.status).toBe('uploaded');
    expect(second.status).toBe('idempotent_replay');
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
