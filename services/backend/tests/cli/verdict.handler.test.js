'use strict';

/**
 * verdict.js CLI handler tests (node:test).
 *
 * Drives `khy verdict` through an injected fake changeWatchService: show renders
 * the latest record, check triggers checkOnce then renders, --json emits the raw
 * record, and the pure render/format helpers behave deterministically.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { handleVerdict, formatVerdict, renderRecord } = require('../../src/cli/handlers/verdict');

function fakeService(rec, hooks = {}) {
  return {
    checkOnce: () => { if (hooks.onCheck) hooks.onCheck(); return hooks.checkResult || { changed: true }; },
    getLatestVerdict: () => rec,
    markConsumed: () => true,
  };
}

// Capture stdout for emit tests (deterministic, no real IO).
function captureStdout(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  return Promise.resolve(fn()).then(
    (r) => { process.stdout.write = orig; return { out: chunks.join(''), ret: r }; },
    (e) => { process.stdout.write = orig; throw e; },
  );
}

function emitService(feedback) {
  const acked = new Set();
  const fb = feedback || {
    schemaVersion: 'khy-change-watch/1', verdict: 'incorrect', reason: 'validation-failed',
    directive: '[SYSTEM: 这次改动不对]', text: '❌ khy 改动不对', display: '❌ khy 改动不对',
    files: ['bad.js'], failures: ['boom'], warnings: [],
  };
  return {
    consumePendingInjection: (cid) => { if (acked.has(cid)) return null; acked.add(cid); return fb; },
    pendingFor: () => fb,
    getStorePath: () => '/home/u/.khyos/change-watch/verdict.json',
    getLatestVerdict: () => fb,
  };
}

test('formatVerdict: maps each verdict to a labelled string', () => {
  assert.match(formatVerdict('correct'), /correct/);
  assert.match(formatVerdict('incorrect'), /incorrect/);
  assert.match(formatVerdict('uncertain'), /uncertain/);
  assert.match(formatVerdict('garbage'), /暂无判定/);
});

test('renderRecord: null → friendly empty line', () => {
  const lines = renderRecord(null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /暂无改动判定记录/);
});

test('renderRecord: incorrect record lists files + failures', () => {
  const lines = renderRecord({
    verdict: 'incorrect',
    files: ['a.js'],
    failures: ['语法错误 a.js:2: boom'],
    warnings: [],
    consumed: false,
  });
  const text = lines.join('\n');
  assert.match(text, /incorrect/);
  assert.match(text, /a\.js/);
  assert.match(text, /boom/);
});

test('handleVerdict show: prints latest record, returns 0', async () => {
  const svc = fakeService({ verdict: 'correct', files: ['x.js'], failures: [], warnings: [] });
  const code = await handleVerdict('show', [], {}, { service: svc });
  assert.equal(code, 0);
});

test('handleVerdict check: invokes checkOnce', async () => {
  let checked = false;
  const svc = fakeService(
    { verdict: 'incorrect', files: ['x.js'], failures: ['boom'], warnings: [] },
    { onCheck: () => { checked = true; } },
  );
  const code = await handleVerdict('check', [], {}, { service: svc });
  assert.equal(checked, true);
  assert.equal(code, 0);
});

test('handleVerdict --json: emits raw record', async () => {
  const rec = { verdict: 'uncertain', reason: 'nothing-checked', files: [] };
  const svc = fakeService(rec);
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try {
    await handleVerdict('show', [], { json: true }, { service: svc });
  } finally {
    process.stdout.write = orig;
  }
  const out = JSON.parse(chunks.join(''));
  assert.equal(out.verdict, 'uncertain');
});

test('handleVerdict help: returns 0 without touching service', async () => {
  const code = await handleVerdict('help', [], {}, { service: null });
  assert.equal(code, 0);
});

test('emit text: prints injectable directive for an external tool', async () => {
  const svc = emitService();
  const { out, ret } = await captureStdout(() => handleVerdict('emit', [], {}, { service: svc }));
  assert.equal(ret, 0);
  assert.match(out, /这次改动不对/);
});

test('emit claude-hook: emits UserPromptSubmit hook JSON contract', async () => {
  const svc = emitService();
  const { out } = await captureStdout(() => handleVerdict('emit', [], { format: 'claude-hook' }, { service: svc }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(parsed.hookSpecificOutput.additionalContext, /这次改动不对/);
});

test('emit json: emits versioned envelope with text + source path', async () => {
  const svc = emitService();
  const { out } = await captureStdout(() => handleVerdict('emit', [], { format: 'json', consumer: 'cursor' }, { service: svc }));
  const parsed = JSON.parse(out);
  assert.equal(parsed.schemaVersion, 'khy-change-watch/1');
  assert.equal(parsed.pending, true);
  assert.equal(parsed.consumer, 'cursor');
  assert.match(parsed.source, /verdict\.json$/);
});

test('emit: no pending feedback → exit 0, empty/closed output (safe to wire as a hook)', async () => {
  const svc = { consumePendingInjection: () => null, pendingFor: () => null, getStorePath: () => null, getLatestVerdict: () => null };
  const textRes = await captureStdout(() => handleVerdict('emit', [], {}, { service: svc }));
  assert.equal(textRes.ret, 0);
  assert.equal(textRes.out, ''); // nothing to inject
  const hookRes = await captureStdout(() => handleVerdict('emit', [], { format: 'claude-hook' }, { service: svc }));
  assert.equal(JSON.parse(hookRes.out) && Object.keys(JSON.parse(hookRes.out)).length, 0); // {}
});

test('emit --peek: does not consume (pendingFor used, not consumePendingInjection)', async () => {
  let consumed = false;
  const svc = {
    consumePendingInjection: () => { consumed = true; return null; },
    pendingFor: () => ({ directive: '[SYSTEM: peek]', text: 'peek' }),
    getStorePath: () => null, getLatestVerdict: () => null,
  };
  const { out } = await captureStdout(() => handleVerdict('emit', [], { peek: true }, { service: svc }));
  assert.equal(consumed, false);
  assert.match(out, /peek/);
});
