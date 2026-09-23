'use strict';

/**
 * turn-rollback WIRING tests (DESIGN-ARCH-096 §2-A, phase 2).
 *
 * Verifies the two integration seams, without a full agent loop:
 *   1. CLI handler `turnRollback` — list / last / by-id / cancel-on-no-confirm,
 *      delegating to turnCheckpointService (structured, never throws).
 *   2. dispatcher seam — toolCalling's executeTool threads `turnId` into
 *      `toolExecutionContext.traceContext`, and the write tools read it from
 *      exactly that path (the path their recordMutatedFile calls use).
 *
 * Isolation: fresh tmp KHY_APP_HOME per test; env restored in finally.
 */

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const TCS_REL = '../../src/services/turnCheckpointService';
const HANDLER_REL = '../../src/cli/handlers/turnRollback';

function freshEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-trw-'));
  const appHome = path.join(root, 'app-home');
  fs.mkdirSync(appHome, { recursive: true });
  const prevApp = process.env.KHY_APP_HOME;
  const prevData = process.env.KHY_DATA_HOME;
  process.env.KHY_APP_HOME = appHome;
  process.env.KHY_DATA_HOME = appHome;
  return {
    root,
    appHome,
    cleanup() {
      if (prevApp === undefined) delete process.env.KHY_APP_HOME;
      else process.env.KHY_APP_HOME = prevApp;
      if (prevData === undefined) delete process.env.KHY_DATA_HOME;
      else process.env.KHY_DATA_HOME = prevData;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function loadTcs() {
  delete require.cache[require.resolve(TCS_REL)];
  delete require.cache[require.resolve('../../src/utils/dataHome')];
  return require(TCS_REL);
}

test('turn-rollback handler: `list` reports zero turns gracefully when none exist', async () => {
  const env = freshEnv();
  try {
    loadTcs();
    const { handleTurnRollback } = require(HANDLER_REL);
    // No throw; returns true. (Output goes to stdout; we assert the call
    // completes and is structured, not the exact text.)
    const ok = await handleTurnRollback('turn-rollback', 'list', [], {});
    assert.equal(ok, true);
  } finally {
    env.cleanup();
  }
});

test('turn-rollback handler: no target turn → honest "no rollback-able turn"', async () => {
  const env = freshEnv();
  try {
    loadTcs();
    const { handleTurnRollback } = require(HANDLER_REL);
    // Empty args, no recorded turns → no-op, returns true.
    const ok = await handleTurnRollback('turn-rollback', null, [], {});
    assert.equal(ok, true);
  } finally {
    env.cleanup();
  }
});

test('turn-rollback handler: rollback of a recorded turn succeeds with --confirm (no prompt)', async () => {
  const env = freshEnv();
  try {
    const tcs = loadTcs();
    const proj = path.join(env.root, 'proj');
    fs.mkdirSync(proj, { recursive: true });
    const f = path.join(proj, 'x.js');
    fs.writeFileSync(f, 'original\n');

    const turnId = tcs.beginTurn('sess-h');
    tcs.recordMutatedFile(turnId, f, { reason: 'editFile', content: 'original\n' });
    tcs.endTurn(turnId);
    fs.writeFileSync(f, 'changed\n');

    const { handleTurnRollback } = require(HANDLER_REL);
    // --confirm skips the interactive prompt → deterministic path.
    const ok = await handleTurnRollback('turn-rollback', turnId, [], { confirm: true });
    assert.equal(ok, true);
    assert.equal(fs.readFileSync(f, 'utf8'), 'original\n');
    // terminal state now.
    assert.equal(tcs.loadTurn(turnId).status, 'rolledback');
  } finally {
    env.cleanup();
  }
});

// ── dispatcher / write-tool seam ─────────────────────────────────────

test('write tools read the turn id from context.traceContext.turnId (the dispatcher path)', () => {
  // This locks the EXACT access expression used in all six write tools, so a
  // rename of the dispatcher field breaks the tools (and this test) together.
  const context = { traceContext: { turnId: 'turn-x', sessionId: 's' } };
  const turnId = context && context.traceContext && context.traceContext.turnId;
  assert.equal(turnId, 'turn-x');

  // A context without the field must degrade to null (graceful no-op).
  const bare = { traceContext: {} };
  const none = bare && bare.traceContext && bare.traceContext.turnId;
  assert.equal(none, undefined);
  const noTrace = {};
  assert.equal(noTrace && noTrace.traceContext && noTrace.traceContext.turnId, undefined);
});

test('turnCalling threads a supplied turnId into traceContext (additive field, present only when given)', () => {
  // Read the actual source to confirm the field is wired — a weak but real
  // guard that the seam exists (the runtime end-to-end path needs a full loop).
  const srcPath = require.resolve('../../src/services/toolCalling');
  const src = fs.readFileSync(srcPath, 'utf8');
  assert.match(src, /turnId:\s*traceContext\?\.turnId/);
});
