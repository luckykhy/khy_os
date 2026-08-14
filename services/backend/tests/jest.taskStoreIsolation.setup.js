'use strict';

/**
 * Jest global setup — pin every suite's data home to a throwaway temp dir.
 *
 * The task tools (`TaskCreate`/`TaskUpdate`/`TaskList`) go through
 * `src/tools/_taskStore`, which is backed by the persistent large-task runtime
 * store. That store instantiates a module-load-time singleton
 * (`largeTaskRuntimeStore.js`: `const defaultStore = createLargeTaskRuntimeStore()`)
 * whose path is resolved eagerly from `getDataDir('tasks')`, with a
 * `process.cwd()/.khy-runtime/tasks` fallback.
 *
 * Without an override that resolves to the REAL data home, so suites that call
 * `taskStore.add(...)` wrote fixtures straight into the live task list — they
 * surfaced in the TUI task panel mid-session — and their `taskStore.clear()`
 * teardown wiped whatever real tasks the user had. Several suites already
 * isolate themselves by hand (see aiUploadStore / apiKeyPoolHotReload); doing it
 * here covers every suite, including ones added later.
 *
 * A fresh dir per test file (setupFiles runs once per file) also stops fixtures
 * from bleeding between files that share a worker process.
 *
 * Both the unified data home AND the project-scoped data home are pinned:
 * several consumers resolve through getProjectDataHome()/getProjectDataDir()
 * (sessionSearchIndex → <home>/sessions.db, sessionPersistence, memoryEngine,
 * trajectories). Without the project pin those tests would read/write the LIVE
 * project home — on a running install the file is locked (EBUSY on Windows) by
 * the daemon and assertions read real user data (e.g. sessionSearchIndex stats).
 *
 * NOT guarded on `KHY_DATA_HOME === undefined` on purpose: `getDataHome()`
 * exports that var as a memoization side effect, so running the suite from
 * inside a khy session inherits it — precisely the case that caused the leak.
 * Isolation is therefore unconditional, with one explicit escape hatch:
 * `KHY_TEST_USE_REAL_DATA_HOME=1 npx jest` leaves resolution untouched.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.KHY_TEST_USE_REAL_DATA_HOME !== '1') {
  const parent = path.join(os.tmpdir(), 'khy-jest-data');
  fs.mkdirSync(parent, { recursive: true });
  const dataHome = fs.mkdtempSync(path.join(parent, `w${process.pid}-`));
  process.env.KHY_DATA_HOME = dataHome;
  process.env.KHY_PROJECT_DATA_HOME = path.join(dataHome, 'project');
}
