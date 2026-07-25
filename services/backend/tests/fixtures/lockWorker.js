'use strict';

/**
 * Test fixture worker: a standalone process that performs a read-modify-write on
 * a shared file UNDER the cross-process file lock. A deliberate hold in the
 * middle widens the race window so that, without the lock, concurrent workers
 * would lose updates (last-writer-wins). With the lock, every worker's line must
 * survive. Driven by tests/fileLock.test.js via child_process.fork.
 *
 * argv: <file> <id> <holdMs>
 */
const fs = require('fs');
const L = require('../../src/tools/_fileLock');

const file = process.argv[2];
const id = process.argv[3];
const holdMs = Number(process.argv[4]) || 50;

(async () => {
  const handle = await L.acquire(file, { timeoutMs: 20000 });
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
    // Hold inside the lock to maximize the read-modify-write race window.
    await new Promise((r) => setTimeout(r, holdMs));
    fs.writeFileSync(file, cur + id + '\n', 'utf-8');
  } finally {
    handle.release();
  }
  process.exit(0);
})().catch((e) => {
  process.stderr.write(String(e && e.message) + '\n');
  process.exit(2);
});
