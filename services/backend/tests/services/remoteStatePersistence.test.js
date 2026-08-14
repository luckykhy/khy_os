'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRemoteStatePersistence } = require('../../src/services/remote/remoteStatePersistence');

describe('RemoteStatePersistence', () => {
  let tempDir;
  let statePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-remote-state-'));
    statePath = path.join(tempDir, 'ssh_state.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('saves and loads approvals/streams payload when enabled', () => {
    const persistence = createRemoteStatePersistence({
      enabled: true,
      statePath,
    });

    const saveResult = persistence.save({
      approvals: [{ ticket_id: 't-1', status: 'pending' }],
      streams: [{ stream_id: 's-1', last_seq: 3, events: [{ seq: 3, event: 'done' }] }],
    });

    expect(saveResult.saved).toBe(true);
    expect(fs.existsSync(statePath)).toBe(true);

    const loaded = persistence.load();
    expect(loaded).toBeTruthy();
    expect(Array.isArray(loaded.approvals)).toBe(true);
    expect(Array.isArray(loaded.streams)).toBe(true);
    expect(loaded.approvals[0].ticket_id).toBe('t-1');
    expect(loaded.streams[0].stream_id).toBe('s-1');
  });

  test('clear removes persisted state file', () => {
    const persistence = createRemoteStatePersistence({
      enabled: true,
      statePath,
    });

    persistence.save({
      approvals: [{ ticket_id: 't-2', status: 'approved' }],
      streams: [],
    });
    expect(fs.existsSync(statePath)).toBe(true);

    const cleared = persistence.clear();
    expect(cleared.cleared).toBe(true);
    expect(fs.existsSync(statePath)).toBe(false);
  });

  test('disabled mode does not persist to disk', () => {
    const persistence = createRemoteStatePersistence({
      enabled: false,
      statePath,
    });

    const saveResult = persistence.save({
      approvals: [{ ticket_id: 't-3' }],
      streams: [{ stream_id: 's-3' }],
    });
    expect(saveResult.saved).toBe(false);
    expect(saveResult.reason).toBe('persistence_disabled');
    expect(fs.existsSync(statePath)).toBe(false);
    expect(persistence.load()).toBeNull();
  });
});
