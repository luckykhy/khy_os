'use strict';
/**
 * verbosityFlag.test.js â€?global `--verbose` / `--debug` switch.
 *
 * A single discoverable flag must light up debug logging (LOG_LEVEL=debug) and
 * the KHY_*_DEBUG diagnostic paths (KHY_DEBUG=1). It must be ESCALATE-ONLY: a
 * more verbose level the user pinned explicitly is never downgraded, and absence
 * of the flag changes nothing.
 *
 * Tests target the pure `_applyVerbosityFlag` helper directly (no async route
 * dispatch) so env mutations are deterministic and cannot interleave.
 */
const { _applyVerbosityFlag } = require('../../src/cli/router');
function withEnv(fn) {
  const saved = { LOG_LEVEL: process.env.LOG_LEVEL, KHY_DEBUG: process.env.KHY_DEBUG };
  try { return fn(); }
  finally {
    if (saved.LOG_LEVEL === undefined) delete process.env.LOG_LEVEL; else process.env.LOG_LEVEL = saved.LOG_LEVEL;
    if (saved.KHY_DEBUG === undefined) delete process.env.KHY_DEBUG; else process.env.KHY_DEBUG = saved.KHY_DEBUG;
  }
}
describe('Verbosity Flag', () => {
  test('string "true" values also trigger it', () => {
    withEnv(() => {
      delete process.env.LOG_LEVEL;
      _applyVerbosityFlag({ verbose: 'true' });
      expect(process.env.LOG_LEVEL).toBe('debug');
    });
  });
  
  test('--verbose escalates an unset level to debug and turns on KHY_DEBUG', () => {
      withEnv(() => {
        delete process.env.LOG_LEVEL; delete process.env.KHY_DEBUG;
        _applyVerbosityFlag({ verbose: true });
        expect(process.env.LOG_LEVEL).toBe('debug');
        expect(process.env.KHY_DEBUG).toBe('1');
      });
  });

  test('--debug is an alias for --verbose', () => {
      withEnv(() => {
        delete process.env.LOG_LEVEL; delete process.env.KHY_DEBUG;
        _applyVerbosityFlag({ debug: true });
        expect(process.env.LOG_LEVEL).toBe('debug');
      });
  });

  test('it never downgrades a more verbose level the user pinned', () => {
      withEnv(() => {
        process.env.LOG_LEVEL = 'silly';
        _applyVerbosityFlag({ verbose: true });
        expect(process.env.LOG_LEVEL).toBe('silly');
      });
  });

  test('it does not clobber an existing explicit KHY_DEBUG value', () => {
      withEnv(() => {
        delete process.env.LOG_LEVEL;
        process.env.KHY_DEBUG = '2';
        _applyVerbosityFlag({ verbose: true });
        expect(process.env.KHY_DEBUG).toBe('2');
      });
  });

  test('absence of the flag leaves verbosity untouched', () => {
      withEnv(() => {
        delete process.env.LOG_LEVEL; delete process.env.KHY_DEBUG;
        _applyVerbosityFlag({});
        expect(process.env.LOG_LEVEL).toBe(undefined);
        expect(process.env.KHY_DEBUG).toBe(undefined);
      });
  });

});

