'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLargeTaskRuntimeStore } = require('../../../src/tasks/largeTaskRuntimeStore');
const { createLargeTaskOrchestrator } = require('../../../src/tasks/largeTaskOrchestrator');
const { createResourceManager } = require('../../../src/services/resources/resourceManager');
const { createResourceTaskAdapter } = require('../../../src/services/resources/resourceTask');

function manifestFor(hash) {
  return { schemaVersion: 1, resources: [{
    id: 'fixture-tool', kind: 'tool', version: '1.0.0', policy: 'manual',
    platforms: { 'win32-x64': { sources: ['https://example.test/fixture.bin'], sha256: hash, format: 'file', sentinel: 'fixture.bin', size: 12 } },
  }] };
}

describe('resource task adapter', () => {
  let tempDir;
  let runtime;
  let orchestrator;
  let manager;
  let previousLedger;

  beforeEach(() => {
    previousLedger = process.env.KHY_INSTALL_LEDGER;
    process.env.KHY_INSTALL_LEDGER = '0';
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-resource-task-'));
    runtime = createLargeTaskRuntimeStore({ storePath: path.join(tempDir, 'tasks.json') });
    orchestrator = createLargeTaskOrchestrator({ runtime, workerId: 'resource-test-worker' });
    manager = createResourceManager({ root: path.join(tempDir, 'resources'), platform: 'win32-x64' });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (previousLedger === undefined) delete process.env.KHY_INSTALL_LEDGER;
    else process.env.KHY_INSTALL_LEDGER = previousLedger;
  });

  test('runs a visible download task and reuses its succeeded result', async () => {
    const payload = Buffer.from('task payload');
    const hash = crypto.createHash('sha256').update(payload).digest('hex');
    manager = createResourceManager({ root: path.join(tempDir, 'resources'), platform: 'win32-x64', manifest: manifestFor(hash) });
    const adapter = createResourceTaskAdapter({ manager, runtime, orchestrator });
    let calls = 0;
    const first = await adapter.fetch('fixture-tool', { downloader: async (url, dest, options) => {
      calls += 1;
      fs.writeFileSync(dest, payload);
      options.onProgress(payload.length, payload.length);
    } });
    expect(first.result.status).toBe('provisioned');
    expect(first.task.type).toBe('resource_download');
    expect(first.task.status).toBe('succeeded');
    expect(calls).toBe(1);

    const second = await adapter.fetch('fixture-tool', { downloader: async () => { calls += 1; } });
    expect(second.result.status).toBe('provisioned');
    expect(second.task.id).toBe(first.task.id);
    expect(calls).toBe(1);
    expect(second.task.payload_json.downloaded_bytes).toBe(payload.length);
  });
});
