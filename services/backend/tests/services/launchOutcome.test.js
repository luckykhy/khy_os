'use strict';

// Unit tests for the launch-outcome wording pure leaf.
// node:test (jest is broken under rtk — run with `node --test`).

const test = require('node:test');
const assert = require('node:assert');

const lo = require('../../src/services/launchOutcome');

// ---------------------------------------------------------------------------
// isEnabled — gate ladder (default ON).
// ---------------------------------------------------------------------------

test('isEnabled: unset → on', () => {
  assert.strictEqual(lo.isEnabled({}), true);
  assert.strictEqual(lo.isEnabled(undefined), true);
});

test('isEnabled: explicit off tokens → off', () => {
  for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(lo.isEnabled({ KHY_LAUNCH_TRUST_SPAWN: v }), false, `value ${v}`);
  }
});

// ---------------------------------------------------------------------------
// Gate ON — honest "已启动" wording, never the alarming "未验证:未检测到新进程".
// ---------------------------------------------------------------------------

const ON = { KHY_LAUNCH_TRUST_SPAWN: '1' };

test('gate on: verified → 已启动并验证', () => {
  const s = lo.formatLaunchOutput('夸克', 'quark', { verified: true, mode: 'process-diff', pid: 1234 }, ON);
  assert.strictEqual(s, '已启动并验证: 夸克 (quark)');
});

test('gate on: spawned but no new process → 已启动, best-effort wording', () => {
  const s = lo.formatLaunchOutput('夸克', 'quark', {
    verified: false, mode: 'process-diff', imageName: 'quark.exe', reason: 'no-new-process-detected',
  }, ON);
  assert.match(s, /^已启动: 夸克 \(quark\)/);
  assert.doesNotMatch(s, /未验证/);
  assert.doesNotMatch(s, /未检测到新进程/);
  assert.match(s, /尽力而为/);
});

test('gate on: unverifiable (process name unknown) → 已启动, no scary "未验证"', () => {
  const s = lo.formatLaunchOutput('夸克', 'quark', { verified: false, mode: 'unverifiable', reason: 'process-name-unknown' }, ON);
  assert.match(s, /^已启动: 夸克 \(quark\)/);
  assert.doesNotMatch(s, /未验证/);
});

test('gate on: missing verification → 已启动', () => {
  const s = lo.formatLaunchOutput('夸克', 'quark', null, ON);
  assert.match(s, /^已启动: 夸克 \(quark\)/);
  assert.doesNotMatch(s, /未验证/);
});

// ---------------------------------------------------------------------------
// Gate OFF — byte-identical to the legacy four-branch _formatLaunchOutput.
// ---------------------------------------------------------------------------

const OFF = { KHY_LAUNCH_TRUST_SPAWN: 'off' };

test('gate off: verified → legacy 已启动并验证', () => {
  assert.strictEqual(
    lo.formatLaunchOutput('夸克', 'quark', { verified: true }, OFF),
    '已启动并验证: 夸克 (quark)',
  );
});

test('gate off: missing verification → legacy （未验证）', () => {
  assert.strictEqual(
    lo.formatLaunchOutput('夸克', 'quark', null, OFF),
    '已发送启动请求: 夸克 (quark)（未验证）',
  );
});

test('gate off: unverifiable → legacy （未验证：无法识别目标进程）', () => {
  assert.strictEqual(
    lo.formatLaunchOutput('夸克', 'quark', { mode: 'unverifiable' }, OFF),
    '已发送启动请求: 夸克 (quark)（未验证：无法识别目标进程）',
  );
});

test('gate off: no-new-process with imageName → legacy （未验证：未检测到新进程 X）', () => {
  assert.strictEqual(
    lo.formatLaunchOutput('夸克', 'quark', { reason: 'no-new-process-detected', imageName: 'quark.exe' }, OFF),
    '已发送启动请求: 夸克 (quark)（未验证：未检测到新进程 quark.exe）',
  );
});

test('gate off: process-diff no imageName → legacy （未验证）', () => {
  assert.strictEqual(
    lo.formatLaunchOutput('夸克', 'quark', { mode: 'process-diff', reason: 'no-new-process-detected' }, OFF),
    '已发送启动请求: 夸克 (quark)（未验证）',
  );
});

// ---------------------------------------------------------------------------
// _legacyFormat exported helper matches the gate-off path exactly.
// ---------------------------------------------------------------------------

test('_legacyFormat: equals gate-off output for every branch', () => {
  const cases = [
    { verified: true },
    null,
    { mode: 'unverifiable' },
    { reason: 'no-new-process-detected', imageName: 'quark.exe' },
    { mode: 'process-diff' },
  ];
  for (const v of cases) {
    assert.strictEqual(
      lo._legacyFormat('夸克', 'quark', v),
      lo.formatLaunchOutput('夸克', 'quark', v, OFF),
    );
  }
});
