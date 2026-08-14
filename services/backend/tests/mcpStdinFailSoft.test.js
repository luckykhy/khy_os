'use strict';

/**
 * Regression: a stdio MCP server that exits immediately during startup must
 * fail SOFT (connect() rejects) — it must NOT crash the process with an
 * uncaught 'error' (EPIPE) on the child's stdin socket.
 *
 * Repro history: a CC-bridged server configured with a broken launcher (a 0-byte
 * `npx` that exits 0 without serving) caused khy to write `initialize` into an
 * already-closed stdin. The write's async failure surfaced as an unhandled
 * 'error' event on stdin (write EPIPE) and took the whole process down. The fix
 * attaches a stdin 'error' listener in _connectStdio so the connection instead
 * resolves through the normal startup-exit/timeout path.
 *
 * Uses a REAL subprocess (`node -e process.exit(0)`) so the actual stdin socket
 * lifecycle is exercised — no mocks. node:test.
 *
 * Run with:  node --test --test-force-exit tests/mcpStdinFailSoft.test.js
 * (--test-force-exit because the real-subprocess transport leaves benign teardown
 * handles that node:test would otherwise wait on; the assertion itself completes.)
 */

const test = require('node:test');
const assert = require('node:assert');

const { connectMCPServer, disconnectMCPServer } = require('../src/services/mcp/index');

test('stdio server that exits at startup fails soft (no uncaught EPIPE)', async () => {
  let uncaught = null;
  const onUncaught = (e) => { uncaught = e; };
  process.on('uncaughtException', onUncaught);

  // A child that exits 0 the instant it starts — never reads stdin, so khy's
  // initialize write lands on a closed pipe (the EPIPE repro).
  const config = {
    type: 'stdio',
    command: process.execPath, // node
    args: ['-e', 'process.exit(0)'],
    env: {},
  };

  let rejected = false;
  try {
    await connectMCPServer('failsoft-probe', config, { connectTimeout: 4000 });
  } catch {
    rejected = true; // expected: connect() rejects because the child died at startup
  } finally {
    try { await disconnectMCPServer('failsoft-probe'); } catch { /* already gone */ }
  }

  // Give any async stdin 'error' a tick to surface before we assert.
  await new Promise((r) => setTimeout(r, 100));
  process.removeListener('uncaughtException', onUncaught);

  assert.strictEqual(uncaught, null, `must not crash on stdin EPIPE, got: ${uncaught && uncaught.message}`);
  assert.strictEqual(rejected, true, 'connect() must reject when the server exits during startup');
});
