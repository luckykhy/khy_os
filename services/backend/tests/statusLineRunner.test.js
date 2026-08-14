'use strict';

/**
 * statusLineRunner.test.js — hermetic: a synthetic exec is injected so no real
 * child process ever runs.
 */

const test = require('node:test');
const assert = require('node:assert');
const runner = require('../src/cli/statusLine/statusLineRunner');

const SETTINGS = { statusLine: { type: 'command', command: 'echo hi', padding: 0 } };

test('renderOnce: executes command, feeds stdin JSON, returns the rendered line', () => {
  let seenInput = null; let seenCmd = null;
  const exec = (cmd, input) => { seenCmd = cmd; seenInput = input; return { status: 0, stdout: 'MODEL · /proj\n', stderr: '', error: null }; };
  const res = runner.renderOnce({ settings: SETTINGS, snapshot: { cwd: '/proj', model: { id: 'm', displayName: 'M' } }, env: {}, exec });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.line, 'MODEL · /proj');
  assert.strictEqual(seenCmd, 'echo hi');
  const payload = JSON.parse(seenInput);
  assert.strictEqual(payload.cwd, '/proj');
  assert.strictEqual(payload.model.display_name, 'M');
});

test('renderOnce: disabled gate short-circuits (never execs)', () => {
  let called = false;
  const exec = () => { called = true; return { status: 0, stdout: 'x' }; };
  const res = runner.renderOnce({ settings: SETTINGS, env: { KHY_STATUS_LINE: '0' }, exec });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'disabled');
  assert.strictEqual(called, false);
});

test('renderOnce: unconfigured → reason=unconfigured, never execs', () => {
  let called = false;
  const exec = () => { called = true; return { status: 0, stdout: 'x' }; };
  const res = runner.renderOnce({ settings: {}, env: {}, exec });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'unconfigured');
  assert.strictEqual(called, false);
});

test('renderOnce: exec error is captured, never thrown', () => {
  const exec = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });
  const res = runner.renderOnce({ settings: SETTINGS, env: {}, exec });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'exec_error');
  assert.match(res.error, /ENOENT/);
});

test('renderOnce: a throwing exec is caught into exec_error', () => {
  const exec = () => { throw new Error('boom'); };
  const res = runner.renderOnce({ settings: SETTINGS, env: {}, exec });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'exec_error');
  assert.match(res.error, /boom/);
});

test('renderOnce: empty output → reason=empty_output with stderr surfaced', () => {
  const exec = () => ({ status: 1, stdout: '   \n', stderr: 'bad config', error: null });
  const res = runner.renderOnce({ settings: SETTINGS, env: {}, exec });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'empty_output');
  assert.strictEqual(res.error, 'bad config');
});

test('renderOnce: padding from settings is applied to the line', () => {
  const exec = () => ({ status: 0, stdout: 'hi', stderr: '', error: null });
  const res = runner.renderOnce({ settings: { statusLine: { command: 'x', padding: 3 } }, env: {}, exec });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.line, '   hi');
});
