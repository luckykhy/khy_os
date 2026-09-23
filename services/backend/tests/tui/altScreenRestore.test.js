'use strict';

/**
 * Regression guard for the alternate-screen restore on TUI exit (P0-6).
 *
 * The TUI wrote ?1049h on mount (non-CC KHY_ALT_SCREEN default-on) but the
 * entire repo had no ?1049l anywhere — every exit path leaked: the terminal
 * stayed in the alternate buffer and the user's shell history was hidden
 * behind it (gemini-cli's documented failure mode). The fix restores on:
 *   1. the converging exit paths: printInkResumeHint (teardown +
 *      bootstrap/shutdown hook, once-guarded) calls restoreAltScreen BEFORE
 *      the hint lines, so the hint lands on the PRIMARY screen;
 *   2. any other exit: a process.once('exit') fallback hook.
 * The restore bytes are fs.writeSync(1, …) — sync, because libuv may never
 * flush async TTY writes inside 'exit' listeners on Windows.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('child_process');
const path = require('path');
const Module = require('module');

// Stub the ai module via a permanently-installed loader patch (same pattern as
// tuiResumeHint.test.js): printInkResumeHint calls require('../ai') at exit
// time, so the patch must stay installed for the test's lifetime.
let _aiStub = null;
const _origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (_aiStub && /[\\/]ai$/.test(request)) return _aiStub;
  return _origLoad.call(this, request, parent, isMain);
};

require('../../src/cli/tui/inkRuntime').registerJsx();
const tuiApp = require('../../src/cli/tui/app.js');
const { printInkResumeHint } = tuiApp;
const I = tuiApp._internals;
const fs = require('fs');

// Capture fs.writeSync calls (fd 1) — restoreAltScreen is the only terminal
// writer on these paths (the ai stub never touches the terminal).
let _syncWrites = [];
const _origWriteSync = fs.writeSync;
fs.writeSync = function patchedWriteSync(fd, data) {
  _syncWrites.push({ fd, data: String(data) });
  return String(data).length;
};

function resetScenario() {
  _syncWrites = [];
  _aiStub = null;
  delete printInkResumeHint._done;
  I._setAltScreenActiveForTest(false);
}

test.afterEach(resetScenario);
test.after(() => {
  fs.writeSync = _origWriteSync;
});

test('restoreAltScreen: never-entered alt screen writes NOTHING (no stray 1049l)', () => {
  // A CC-mode session (KHY_ALT_SCREEN=0) never flips the flag. Writing 1049l
  // from it would bounce a CC terminal out of ITS current screen — so the
  // restore must be a strict no-op when inactive.
  I._setAltScreenActiveForTest(false);
  I.restoreAltScreen();
  assert.strictEqual(_syncWrites.length, 0);
});

test('restoreAltScreen: active → exactly one sync ?1049l?25h write to fd 1, idempotent', () => {
  I._setAltScreenActiveForTest(true);
  I.restoreAltScreen();
  assert.strictEqual(_syncWrites.length, 1, `expected 1 write, got ${_syncWrites.length}`);
  assert.strictEqual(_syncWrites[0].fd, 1, 'must write to fd 1 (the TTY)');
  assert.strictEqual(_syncWrites[0].data, '\x1B[?1049l\x1B[?25h');
  // Second call (the exit-hook path after the hint path already restored)
  // must not duplicate the write.
  I.restoreAltScreen();
  assert.strictEqual(_syncWrites.length, 1, 'restore must be idempotent');
});

test('hint path: active flag → restore is written BEFORE the hint lines', () => {
  // Order is the whole point: the hint must land on the PRIMARY screen.
  // Restore happens at the top of printInkResumeHint, before console.log.
  I._setAltScreenActiveForTest(true);
  _aiStub = {
    saveConversation: () => {},
    getLiveSessionId: () => 'sess-alt',
    listConversations: () => [],
  };
  const order = []; // 'restore' vs 'hint'
  const origLog = console.log;
  console.log = (line = '') => { order.push('hint'); };
  const origSync = fs.writeSync;
  fs.writeSync = function patched(fd, data) {
    if (String(data).includes('1049l')) order.push('restore');
    return origSync.call(fs, fd, data);
  };
  try {
    printInkResumeHint();
  } finally {
    console.log = origLog;
    fs.writeSync = origSync;
  }
  assert.ok(order.includes('restore'), 'restore must fire on the hint path');
  assert.ok(order.indexOf('restore') < order.indexOf('hint'), `restore must precede hint, got ${order.join(',')}`);
});

test('hint path: once-guard means the second exit path restores zero bytes', () => {
  I._setAltScreenActiveForTest(true);
  _aiStub = {
    saveConversation: () => {},
    getLiveSessionId: () => 'sess-once',
    listConversations: () => [],
  };
  const sink = () => {};
  const origLog = console.log;
  console.log = sink;
  try {
    printInkResumeHint(); // waitUntilExit path
    printInkResumeHint(); // shutdown-hook path — must be a full no-op
  } finally {
    console.log = origLog;
  }
  const restores = _syncWrites.filter((w) => w.data.includes('1049l'));
  assert.strictEqual(restores.length, 1, 'exactly one 1049l across both exit paths');
});

test('exit fallback: _installAltScreenExitHook registers exactly ONE exit listener', () => {
  const before = process.listenerCount('exit');
  I._installAltScreenExitHook();
  I._installAltScreenExitHook(); // double-install must be a no-op (once-guard)
  assert.strictEqual(process.listenerCount('exit'), before + 1);
});

// ── End-to-end: real child process, real 'exit' event, real fd 1 ────────────
// The spawn test is the golden evidence: mount-state flag + process.exit(0)
// (what bootstrap/shutdown.js does on SIGINT) must emit the 1049l bytes on
// the child's real stdout even though 'exit'-time async writes can be lost.
const CHILD_SCRIPT = `
require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'cli', 'tui', 'inkRuntime'))}).registerJsx();
const app = require(${JSON.stringify(path.join(__dirname, '..', '..', 'src', 'cli', 'tui', 'app.js'))});
app._internals._setAltScreenActiveForTest(true);
app._internals._installAltScreenExitHook();
process.exit(0); // hard exit: NO teardown, NO hint — only the 'exit' fallback
`;

test('spawn: hard process.exit(0) still emits ?1049l bytes on fd 1 (the leak, fixed)', () => {
  const r = spawnSync(process.execPath, ['-e', CHILD_SCRIPT], {
    encoding: 'buffer',
    timeout: 20000,
  });
  assert.strictEqual(r.status, 0, `child exit status ${r.status}, stderr: ${String(r.stderr || '')}`);
  const out = String(r.stdout || '');
  assert.ok(out.includes('\x1B[?1049l'), `child stdout must contain ?1049l, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes('\x1B[?25h'), 'child stdout must contain the cursor-visible safety net');
});

test('spawn: without the mount flag, hard exit writes NO restore bytes (CC mode safe)', () => {
  const script = CHILD_SCRIPT.replace(
    /app\._internals\._setAltScreenActiveForTest\(true\);/,
    'app._internals._setAltScreenActiveForTest(false);'
  );
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'buffer',
    timeout: 20000,
  });
  assert.strictEqual(r.status, 0);
  const out = String(r.stdout || '');
  assert.ok(!out.includes('1049l'), `no-alt-screen session must NOT write 1049l, got: ${JSON.stringify(out)}`);
});
