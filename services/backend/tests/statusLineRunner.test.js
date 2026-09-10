'use strict';
/**
 * statusLineRunner.test.js â€?hermetic: a synthetic exec is injected so no real
 * child process ever runs.
 */
const runner = require('../src/cli/statusLine/statusLineRunner');
const SETTINGS = { statusLine: { type: 'command', command: 'echo hi', padding: 0 } };

describe('Status Line Runner', () => {
  test('renderOnce: executes command, feeds stdin JSON, returns the rendered line', () => {
      let seenInput = null; let seenCmd = null;
      const exec = (cmd, input) => { seenCmd = cmd; seenInput = input; return { status: 0, stdout: 'MODEL Â· /proj\n', stderr: '', error: null }; };
      const res = runner.renderOnce({ settings: SETTINGS, snapshot: { cwd: '/proj', model: { id: 'm', displayName: 'M' } }, env: {}, exec });
      expect(res.ok).toBe(true);
      expect(res.line).toBe('MODEL Â· /proj');
      expect(seenCmd).toBe('echo hi');
      const payload = JSON.parse(seenInput);
      expect(payload.cwd).toBe('/proj');
      expect(payload.model.display_name).toBe('M');
  });

  test('renderOnce: disabled gate short-circuits (never execs)', () => {
      let called = false;
      const exec = () => { called = true; return { status: 0, stdout: 'x' }; };
      const res = runner.renderOnce({ settings: SETTINGS, env: { KHY_STATUS_LINE: '0' }, exec });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('disabled');
      expect(called).toBe(false);
  });

  test('renderOnce: unconfigured â†?reason=unconfigured, never execs', () => {
      let called = false;
      const exec = () => { called = true; return { status: 0, stdout: 'x' }; };
      const res = runner.renderOnce({ settings: {}, env: {}, exec });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('unconfigured');
      expect(called).toBe(false);
  });

  test('renderOnce: exec error is captured, never thrown', () => {
      const exec = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });
      const res = runner.renderOnce({ settings: SETTINGS, env: {}, exec });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('exec_error');
      expect(res.error).toMatch(/ENOENT/);
  });

  test('renderOnce: a throwing exec is caught into exec_error', () => {
      const exec = () => { throw new Error('boom'); };
      const res = runner.renderOnce({ settings: SETTINGS, env: {}, exec });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('exec_error');
      expect(res.error).toMatch(/boom/);
  });

  test('renderOnce: empty output â†?reason=empty_output with stderr surfaced', () => {
      const exec = () => ({ status: 1, stdout: '   \n', stderr: 'bad config', error: null });
      const res = runner.renderOnce({ settings: SETTINGS, env: {}, exec });
      expect(res.ok).toBe(false);
      expect(res.reason).toBe('empty_output');
      expect(res.error).toBe('bad config');
  });

  test('renderOnce: padding from settings is applied to the line', () => {
      const exec = () => ({ status: 0, stdout: 'hi', stderr: '', error: null });
      const res = runner.renderOnce({ settings: { statusLine: { command: 'x', padding: 3 } }, env: {}, exec });
      expect(res.ok).toBe(true);
      expect(res.line).toBe('   hi');
  });

});

