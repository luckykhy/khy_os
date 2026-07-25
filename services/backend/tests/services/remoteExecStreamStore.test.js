'use strict';

const {
  createRemoteExecStreamStore,
  buildRemoteExecStreamRequestFingerprint,
} = require('../../src/services/remote/remoteExecStreamStore');

describe('RemoteExecStreamStore', () => {
  const originalMaxEvents = process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS;

  afterEach(() => {
    if (originalMaxEvents === undefined) {
      delete process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS;
    } else {
      process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS = originalMaxEvents;
    }
  });

  test('ensureSession detects payload conflict for reused stream_id', () => {
    const store = createRemoteExecStreamStore();
    const streamId = 'stream-conflict-case';

    const fpA = buildRemoteExecStreamRequestFingerprint({
      connectionId: 'conn-1',
      commands: ['echo a'],
      dryRun: true,
      idempotencyKey: '',
      approvalTicketId: '',
      riskContext: null,
    });
    const fpB = buildRemoteExecStreamRequestFingerprint({
      connectionId: 'conn-1',
      commands: ['echo b'],
      dryRun: true,
      idempotencyKey: '',
      approvalTicketId: '',
      riskContext: null,
    });

    const first = store.ensureSession({
      streamId,
      requestFingerprint: fpA,
      requestContext: { commands: ['echo a'] },
    });
    expect(first.ok).toBe(true);
    expect(first.created).toBe(true);

    const same = store.ensureSession({
      streamId,
      requestFingerprint: fpA,
      requestContext: { commands: ['echo a'] },
    });
    expect(same.ok).toBe(true);
    expect(same.created).toBe(false);

    const conflict = store.ensureSession({
      streamId,
      requestFingerprint: fpB,
      requestContext: { commands: ['echo b'] },
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.code).toBe('stream_payload_conflict');
  });

  test('getEventsSince replays only events after seq and reports done status', () => {
    const store = createRemoteExecStreamStore();
    const streamId = 'stream-replay-case';

    const ensured = store.ensureSession({ streamId });
    expect(ensured.ok).toBe(true);

    store.appendEvent(streamId, { event: 'start', data: { status: 'running' } });
    store.appendEvent(streamId, { event: 'result', data: { status: 'dry_run' } });
    store.appendEvent(streamId, { event: 'done', data: { status: 'completed' } });

    const replay = store.getEventsSince(streamId, 1);
    expect(replay).toBeTruthy();
    expect(replay.done).toBe(true);
    expect(replay.terminal_status).toBe('completed');
    expect(replay.events.map((item) => item.seq)).toEqual([2, 3]);
    expect(replay.events.map((item) => item.event)).toEqual(['result', 'done']);
  });

  test('marks replay as truncated when early events are evicted by event cap', () => {
    process.env.KHY_REMOTE_SSH_MAX_STREAM_EVENTS = '2';
    const store = createRemoteExecStreamStore();
    const streamId = 'stream-truncated-case';

    const ensured = store.ensureSession({ streamId });
    expect(ensured.ok).toBe(true);

    store.appendEvent(streamId, { event: 'start', data: { step: 1 } });
    store.appendEvent(streamId, { event: 'remote_event', data: { step: 2 } });
    store.appendEvent(streamId, { event: 'done', data: { status: 'completed' } });

    const replay = store.getEventsSince(streamId, 0);
    expect(replay).toBeTruthy();
    expect(replay.truncated).toBe(true);
    expect(replay.first_available_seq).toBe(2);
    expect(replay.events.map((item) => item.seq)).toEqual([2, 3]);
  });

  test('exportState and importState preserve event timeline and completion status', () => {
    const sourceStore = createRemoteExecStreamStore();
    const streamId = 'stream-export-import-case';

    sourceStore.ensureSession({
      streamId,
      requestContext: {
        connection_id: 'conn-22',
        commands: ['echo persist'],
        dry_run: true,
      },
      metadata: {
        trace_id: 'trace-export-import',
      },
    });
    sourceStore.appendEvent(streamId, { event: 'start', data: { status: 'running' } });
    sourceStore.appendEvent(streamId, { event: 'result', data: { status: 'dry_run' } });
    sourceStore.appendEvent(streamId, { event: 'done', data: { status: 'completed' } });

    const snapshot = sourceStore.exportState();
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot.length).toBe(1);

    const restoredStore = createRemoteExecStreamStore();
    const restoredCount = restoredStore.importState(snapshot);
    expect(restoredCount).toBe(1);
    expect(restoredStore.hasSession(streamId)).toBe(true);
    expect(restoredStore.isDone(streamId)).toBe(true);

    const replay = restoredStore.getEventsSince(streamId, 0);
    expect(replay).toBeTruthy();
    expect(replay.events.map((item) => item.event)).toEqual(['start', 'result', 'done']);
    expect(replay.terminal_status).toBe('completed');
  });
});
