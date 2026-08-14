'use strict';

/**
 * Tests for the persistence hardening in largeTaskRuntimeStore:
 * - Atomic write with retry (_atomicWriteWithRetry)
 * - Orphan tmp file cleanup (_cleanupStaleTmpFiles)
 * - Store lock acquire/release (_acquireStoreLock / _releaseStoreLock)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLargeTaskRuntimeStore } = require('../../src/tasks/largeTaskRuntimeStore');

describe('largeTaskRuntimeStore — persistence hardening', () => {
  let tempDir;
  let storePath;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-persist-test-'));
    storePath = path.join(tempDir, 'large_task_runtime.json');
  });

  afterEach(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('createTask → state file exists and is readable', () => {
    test('creates a task and persists it to disk as valid JSON', () => {
      const store = createLargeTaskRuntimeStore({ storePath });
      const task = store.createTask({ type: 'persist-test' });

      expect(task.id).toBeTruthy();
      expect(fs.existsSync(storePath)).toBe(true);

      const raw = fs.readFileSync(storePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.tasks[task.id]).toBeTruthy();
      expect(parsed.tasks[task.id].type).toBe('persist-test');
    });

    test('a fresh store instance can read back the persisted task', () => {
      const storeA = createLargeTaskRuntimeStore({ storePath });
      const task = storeA.createTask({ type: 'readback-test' });

      const storeB = createLargeTaskRuntimeStore({ storePath });
      const readBack = storeB.getTask(task.id);
      expect(readBack).toBeTruthy();
      expect(readBack.id).toBe(task.id);
      expect(readBack.type).toBe('readback-test');
    });
  });

  describe('orphan tmp cleanup (_cleanupStaleTmpFiles)', () => {
    test('deletes stale tmp files (mtime > 60s) on first load, keeps fresh ones', () => {
      // Ensure the store dir exists before creating the orphan files
      fs.mkdirSync(path.dirname(storePath), { recursive: true });

      const basename = path.basename(storePath);
      const staleFile = path.join(tempDir, `${basename}.tmp-111-222`);
      const freshFile = path.join(tempDir, `${basename}.tmp-333-444`);

      // Create both tmp files
      fs.writeFileSync(staleFile, 'stale-content', 'utf-8');
      fs.writeFileSync(freshFile, 'fresh-content', 'utf-8');

      // Roll back the stale file's mtime by 120 seconds
      const pastTime = new Date(Date.now() - 120_000);
      fs.utimesSync(staleFile, pastTime, pastTime);

      // Creating/loading the store triggers _cleanupStaleTmpFiles on first access
      const store = createLargeTaskRuntimeStore({ storePath });
      store.listTasks(); // triggers _ensureLoaded

      expect(fs.existsSync(staleFile)).toBe(false);
      expect(fs.existsSync(freshFile)).toBe(true);
    });
  });

  describe('atomic write with retry (renameSync EPERM)', () => {
    test('retries on EPERM and succeeds on third attempt, no tmp residue', () => {
      const store = createLargeTaskRuntimeStore({ storePath });

      let renameCallCount = 0;
      const originalRenameSync = fs.renameSync;
      const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        renameCallCount++;
        // The first 2 rename calls for our store path throw EPERM
        if (renameCallCount <= 2 && String(src).includes('.tmp-')) {
          const err = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        return originalRenameSync(src, dest);
      });

      try {
        // This triggers _persist → _atomicWriteWithRetry
        const task = store.createTask({ type: 'retry-test' });
        expect(task.id).toBeTruthy();

        // Verify the file was written successfully
        expect(fs.existsSync(storePath)).toBe(true);
        const parsed = JSON.parse(fs.readFileSync(storePath, 'utf-8'));
        expect(parsed.tasks[task.id]).toBeTruthy();

        // Verify no .tmp-* files remain
        const tmpFiles = fs.readdirSync(tempDir).filter((f) => f.includes('.tmp-'));
        expect(tmpFiles).toHaveLength(0);

        // Verify renameSync was called at least 3 times
        expect(renameCallCount).toBeGreaterThanOrEqual(3);
      } finally {
        spy.mockRestore();
      }
    });

    test('all rename attempts fail → _persist throws, tmp file is cleaned up', () => {
      const store = createLargeTaskRuntimeStore({ storePath });

      // First, create the store file so _ensureLoaded works
      store.createTask({ type: 'setup-for-failure' });

      // Now mock renameSync to always fail with EPERM
      const spy = jest.spyOn(fs, 'renameSync').mockImplementation((src, dest) => {
        if (String(src).includes('.tmp-')) {
          const err = new Error('EPERM: operation not permitted');
          err.code = 'EPERM';
          throw err;
        }
        // For non-tmp renames (like lock cleanup), call original
        return jest.requireActual('fs').renameSync(src, dest);
      });

      try {
        // The next mutation should fail since all renames fail
        expect(() => {
          store.createTask({ type: 'will-fail' });
        }).toThrow();

        // Verify no .tmp-* files remain (finally block cleans them up)
        const tmpFiles = fs.readdirSync(tempDir).filter((f) => f.includes('.tmp-'));
        expect(tmpFiles).toHaveLength(0);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('store lock lifecycle', () => {
    test('no .lock directory remains after a successful write', () => {
      const store = createLargeTaskRuntimeStore({ storePath });
      store.createTask({ type: 'lock-test' });

      const lockDir = `${storePath}.lock`;
      expect(fs.existsSync(lockDir)).toBe(false);
    });

    test('no .lock directory remains after multiple writes', () => {
      const store = createLargeTaskRuntimeStore({ storePath });
      for (let i = 0; i < 5; i++) {
        store.createTask({ type: `lock-multi-${i}` });
      }

      const lockDir = `${storePath}.lock`;
      expect(fs.existsSync(lockDir)).toBe(false);

      const allTasks = store.listTasks();
      expect(allTasks).toHaveLength(5);
    });
  });
});
