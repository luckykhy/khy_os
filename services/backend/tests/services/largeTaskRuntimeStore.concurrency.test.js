'use strict';

/**
 * Multi-process concurrency test for largeTaskRuntimeStore.
 *
 * Spawns 2 child processes that each perform 50 createTask + updateTaskFields
 * cycles against the same temporary storePath. After both finish:
 * - The state file must be valid JSON
 * - It must contain exactly 100 tasks (no data loss)
 * - No orphan .tmp-* files remain
 * - No .lock directory remains
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');

// Increase test timeout — two child processes do 50 I/O each
jest.setTimeout(60_000);

describe('largeTaskRuntimeStore — multi-process concurrency', () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-concurrency-test-'));
    storePath = path.join(tempDir, 'large_task_runtime.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('two child processes each doing 50 createTask+update → 100 tasks, no orphans, no lock dirs', () => {
    // Write a small inline worker script to tempDir
    const workerScript = `
'use strict';
const storePath = process.argv[2];
const workerId = process.argv[3];
const { createLargeTaskRuntimeStore } = require(${JSON.stringify(
      require.resolve('../../src/tasks/largeTaskRuntimeStore')
    )});

const store = createLargeTaskRuntimeStore({ storePath });
for (let i = 0; i < 50; i++) {
  const task = store.createTask({ type: 'concurrency-' + workerId });
  store.updateTaskFields(task.id, { payload_json: { iteration: i, worker: workerId } });
}
process.exit(0);
`;
    const workerPath = path.join(tempDir, 'worker.js');
    fs.writeFileSync(workerPath, workerScript, 'utf-8');

    // Run both workers in parallel using start /b (Windows) or &
    // Using execSync with two sequential calls is simpler for Jest;
    // we'll use a small coordinator script for true parallelism.
    const coordinatorScript = `
'use strict';
const { spawn } = require('child_process');
const workerPath = process.argv[2];
const storePath = process.argv[3];

const children = [];
for (let i = 0; i < 2; i++) {
  children.push(spawn(process.execPath, [workerPath, storePath, 'w' + i], {
    stdio: 'inherit',
  }));
}

let exitCount = 0;
let hasError = false;
children.forEach((child) => {
  child.on('close', (code) => {
    if (code !== 0) hasError = true;
    exitCount++;
    if (exitCount === 2) {
      process.exit(hasError ? 1 : 0);
    }
  });
  child.on('error', () => {
    hasError = true;
    exitCount++;
    if (exitCount === 2) process.exit(1);
  });
});
`;
    const coordPath = path.join(tempDir, 'coordinator.js');
    fs.writeFileSync(coordPath, coordinatorScript, 'utf-8');

    // Execute the coordinator synchronously (blocks until both children done)
    execFileSync(process.execPath, [coordPath, workerPath, storePath], {
      timeout: 50_000,
      stdio: 'pipe',
    });

    // Validation: read back with a fresh store
    const store = createLargeTaskRuntimeStore({ storePath });
    const allTasks = store.listTasks();

    // 1) JSON must be valid (if we got here, createLargeTaskRuntimeStore parsed it)
    expect(fs.existsSync(storePath)).toBe(true);
    const raw = fs.readFileSync(storePath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();

    // 2) Exactly 100 tasks (50 per worker, no loss)
    expect(allTasks.length).toBe(100);

    // 3) No orphan .tmp-* files
    const dirContents = fs.readdirSync(tempDir);
    const tmpFiles = dirContents.filter((f) => f.includes('.tmp-') && !f.endsWith('.js'));
    expect(tmpFiles).toHaveLength(0);

    // 4) No .lock directory remains
    const lockDirs = dirContents.filter((f) => f.endsWith('.lock'));
    expect(lockDirs).toHaveLength(0);
  });
});
