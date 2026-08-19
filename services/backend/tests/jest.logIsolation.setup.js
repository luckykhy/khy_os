'use strict';

/**
 * Jest global setup — pin every suite's log directory to a throwaway temp dir.
 *
 * The shared winston logger (`platform/packages/shared/src/utils/logger.js`)
 * resolves its output directory once at module load. That path used to be
 * hardcoded to the package's own `logs/` dir, so every suite that touched the
 * logger wrote into the LIVE log files. `tests/utils/logger.test.js` is the
 * blatant case — it asserts that `logger.error(...)` does not throw, which
 * appended a literal `test error message` line to `error-<today>.log` on every
 * single run — but any suite that exercises a code path containing a
 * `logger.warn`/`logger.error` did the same, quietly diluting the real logs with
 * fixture noise and making them useless for diagnosing actual incidents.
 *
 * Same class of leak as tests/jest.taskStoreIsolation.setup.js, and fixed the
 * same way: set the env var in `setupFiles`, which runs before the test module
 * (and therefore before the logger) is required.
 *
 * One directory per worker process rather than per test file: log lines don't
 * bleed between suites the way task-store fixtures do, so a shared dir per
 * worker is enough, and it keeps a 619-suite run from leaving 619 temp dirs
 * behind. Separate dirs per worker still avoid two workers racing on the same
 * winston-daily-rotate-file audit file.
 *
 * Escape hatch: `KHY_TEST_USE_REAL_LOG_DIR=1 npx jest` leaves resolution alone.
 *
 * Precedence note: `KHY_LOG_DIR` ranks BELOW `KHY_LOG_HOME`/`KHY_DATA_HOME` in
 * the shared resolver, because it is this test hook rather than a deployment
 * knob. jest.taskStoreIsolation.setup.js already pins `KHY_DATA_HOME` to a temp
 * dir, so under a normal run the logs land in `<temp data home>/logs` and this
 * file is the backstop for runs with `KHY_TEST_USE_REAL_DATA_HOME=1`.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

if (process.env.KHY_TEST_USE_REAL_LOG_DIR !== '1' && !process.env.KHY_LOG_DIR) {
  const dir = path.join(os.tmpdir(), 'khy-jest-logs', `w${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.KHY_LOG_DIR = dir;
}
