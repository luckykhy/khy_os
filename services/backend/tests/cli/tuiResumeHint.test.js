'use strict';

/**
 * Regression guard for the ink-TUI exit resume hint.
 *
 * The classic REPL prints a "session saved — resume with /resume" hint on exit,
 * but the ink TUI path tore down silently after Ctrl-C, so users never learned
 * the conversation was recoverable (the「ctrl c 后没有 resume」report). The fix
 * adds printInkResumeHint(), called both after waitUntilExit() and as a
 * shutdown hook (since bootstrap/shutdown.js's process.exit can win the race).
 * It must: surface /resume + the concrete session id, fall back to the most
 * recent persisted session, print nothing when nothing is persisted, and never
 * print twice across the two exit paths.
 */

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Stub the ai module via a permanently-installed loader patch: printInkResumeHint
// calls require('../ai') at exit time (not import time), so the patch must stay
// installed for the lifetime of the test, diverting only when _aiStub is set.
let _aiStub = null;
const _origLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (_aiStub && /[\\/]ai$/.test(request)) return _aiStub;
  return _origLoad.call(this, request, parent, isMain);
};

require('../../src/cli/tui/inkRuntime').registerJsx();
const { printInkResumeHint } = require('../../src/cli/tui/app.jsx');

function captureHint(aiStub) {
  _aiStub = aiStub;
  // reset the once-guard so each scenario starts fresh
  delete printInkResumeHint._done;
  const lines = [];
  const original = console.log;
  console.log = (line = '') => lines.push(String(line));
  try {
    printInkResumeHint();
  } finally {
    console.log = original;
    _aiStub = null;
  }
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

test('live session id → prints /resume hint with the concrete id', () => {
  let saved = 0;
  const lines = captureHint({
    saveConversation: () => { saved += 1; },
    getLiveSessionId: () => 'sess-abc123',
    listConversations: () => [],
  });
  assert.ok(lines.some((l) => l.includes('/resume')), 'must mention /resume');
  assert.ok(lines.some((l) => l.includes('khy resume sess-abc123')), 'must show the live id');
  assert.strictEqual(saved, 1, 'must take a final snapshot');
});

test('no live id → falls back to most-recent persisted session', () => {
  const lines = captureHint({
    saveConversation: () => {},
    getLiveSessionId: () => '',
    listConversations: () => [{ sessionId: 'fallback-99' }],
  });
  assert.ok(lines.some((l) => l.includes('khy resume fallback-99')), 'must use fallback id');
});

test('nothing persisted → prints no hint at all', () => {
  const lines = captureHint({
    saveConversation: () => {},
    getLiveSessionId: () => '',
    listConversations: () => [],
  });
  assert.strictEqual(lines.length, 0, `expected silence, got: ${lines.join(' | ')}`);
});

test('once-guard: second call across exit paths prints nothing', () => {
  _aiStub = {
    saveConversation: () => {},
    getLiveSessionId: () => 'sess-twice',
    listConversations: () => [],
  };
  delete printInkResumeHint._done;
  const lines = [];
  const original = console.log;
  console.log = (line = '') => lines.push(String(line));
  try {
    printInkResumeHint(); // waitUntilExit path
    const after1 = lines.length;
    printInkResumeHint(); // shutdown-hook path — must be a no-op
    assert.strictEqual(lines.length, after1, 'second call must not print again');
  } finally {
    console.log = original;
    _aiStub = null;
  }
  assert.ok(lines.some((l) => l.includes('khy resume sess-twice')), 'first call still prints');
});
