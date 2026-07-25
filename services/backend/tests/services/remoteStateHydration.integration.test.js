'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('remote index persistence integration', () => {
  const originalPersistState = process.env.KHY_REMOTE_SSH_PERSIST_STATE;
  const originalStatePath = process.env.KHY_REMOTE_SSH_STATE_PATH;

  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-hydration-'));
    statePath = path.join(tempDir, 'ssh_state.json');
    process.env.KHY_REMOTE_SSH_PERSIST_STATE = 'true';
    process.env.KHY_REMOTE_SSH_STATE_PATH = statePath;
    jest.resetModules();
  });

  afterEach(() => {
    jest.resetModules();
    if (originalPersistState === undefined) {
      delete process.env.KHY_REMOTE_SSH_PERSIST_STATE;
    } else {
      process.env.KHY_REMOTE_SSH_PERSIST_STATE = originalPersistState;
    }
    if (originalStatePath === undefined) {
      delete process.env.KHY_REMOTE_SSH_STATE_PATH;
    } else {
      process.env.KHY_REMOTE_SSH_STATE_PATH = originalStatePath;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('hydrates approvals and streams from persisted state on module reload', () => {
    const first = require('../../src/services/remote');
    first.resetRemoteStateForTests();

    const createdTicket = first.remoteApprovalBridge.createTicket({
      traceId: 'trace-hydrate-1',
      connectionId: 'conn-hydrate-1',
      hostAlias: 'demo',
      commands: ['rm -rf /tmp/hydrate'],
      idempotencyKey: 'idem-hydrate-1',
      riskContext: { source: 'integration-test' },
    });
    first.remoteApprovalBridge.approveTicket(createdTicket.ticket_id, 'reviewer');

    first.remoteExecStreamStore.ensureSession({
      streamId: 'stream-hydrate-1',
      requestContext: {
        connection_id: 'conn-hydrate-1',
        commands: ['echo hydrate'],
        dry_run: true,
      },
    });
    first.remoteExecStreamStore.appendEvent('stream-hydrate-1', {
      event: 'start',
      data: { status: 'running' },
    });
    first.remoteExecStreamStore.appendEvent('stream-hydrate-1', {
      event: 'done',
      data: { status: 'completed' },
    });
    first.persistRemoteState();
    expect(fs.existsSync(statePath)).toBe(true);

    jest.resetModules();
    const second = require('../../src/services/remote');

    expect(second.remoteStateHydration.loaded).toBe(true);
    expect(second.remoteStateHydration.reason_code).toBeNull();
    expect(typeof second.remoteStateHydration.duration_ms).toBe('number');
    expect(second.remoteStateHydration.approvals_loaded).toBeGreaterThanOrEqual(1);
    expect(second.remoteStateHydration.streams_loaded).toBeGreaterThanOrEqual(1);
    const ticket = second.remoteApprovalBridge.getTicket(createdTicket.ticket_id);
    expect(ticket).toBeTruthy();
    expect(ticket.status).toBe('approved');

    const stream = second.remoteExecStreamStore.getSession('stream-hydrate-1');
    expect(stream).toBeTruthy();
    expect(stream.done).toBe(true);
    expect(stream.last_seq).toBeGreaterThanOrEqual(2);

    const snapshot = second.remoteStateSyncService.getSnapshot();
    expect(snapshot.summary.persistence_enabled).toBe(true);
    expect(snapshot.persistence).toBeTruthy();
    expect(snapshot.persistence.enabled).toBe(true);
    expect(snapshot.last_hydration).toBeTruthy();
    expect(snapshot.last_hydration.loaded).toBe(true);
    expect(['never', 'saved']).toContain(snapshot.persistence.last_save_status);
  });
});
