'use strict';

/**
 * shellEscape — coverage for the REPL `!<cmd>` shell-escape feature.
 *
 *  - formatShellEscapeContext: the PURE formatter that turns queued `!` command
 *    results into the `<shell-escape-output>` context block injected into the
 *    next AI turn. Locks the tag shape, exit-code rendering, empty handling,
 *    and the size cap.
 *  - end-to-end: drives the SAME single-source shell tool the escape uses
 *    (src/tools/shellCommand) to prove `!echo` actually runs and its output is
 *    what gets formatted into context — cross-platform (echo exists on cmd,
 *    PowerShell, bash, sh).
 *
 * Runnable under both jest and `node --test` via the shim (no jest binary here).
 */

const { formatShellEscapeContext } = require('../../src/cli/repl');
const shellTool = require('../../src/tools/shellCommand');

/* ── jest-or-node:test shim ─────────────────────────────────────────────── */
let _describe = global.describe;
let _test = global.test || global.it;
let _expect = global.expect;
if (typeof _describe !== 'function' || typeof _expect !== 'function') {
  const assert = require('assert');
  const nt = require('node:test');
  _describe = nt.describe;
  _test = nt.test;
  _expect = (actual) => ({
    toBe: (e) => assert.strictEqual(actual, e),
    toContain: (e) => assert.ok(String(actual).includes(e), `expected to contain ${e}`),
    toMatch: (re) => assert.ok(re.test(String(actual)), `expected to match ${re}`),
  });
}

/* ── formatShellEscapeContext ───────────────────────────────────────────── */
_describe('formatShellEscapeContext', () => {
  _test('empty / non-array yields no block', () => {
    _expect(formatShellEscapeContext([])).toBe('');
    _expect(formatShellEscapeContext(null)).toBe('');
    _expect(formatShellEscapeContext(undefined)).toBe('');
  });

  _test('records with no command are dropped', () => {
    _expect(formatShellEscapeContext([{ body: 'x' }, { command: '' }])).toBe('');
  });

  _test('single record renders command, body, exit code inside the tag', () => {
    const out = formatShellEscapeContext([{ command: 'dir', body: 'a\nb', code: 0 }]);
    _expect(out).toMatch(/^<shell-escape-output>\n/);
    _expect(out).toMatch(/<\/shell-escape-output>$/);
    _expect(out).toContain('$ dir');
    _expect(out).toContain('a\nb');
    _expect(out).toContain('(exit 0)');
  });

  _test('missing body and code fall back to placeholder / 0', () => {
    const out = formatShellEscapeContext([{ command: 'noop' }]);
    _expect(out).toContain('(无输出)');
    _expect(out).toContain('(exit 0)');
  });

  _test('multiple records are separated by a blank line', () => {
    const out = formatShellEscapeContext([
      { command: 'a', body: '1', code: 0 },
      { command: 'b', body: '2', code: 1 },
    ]);
    _expect(out).toContain('$ a\n1\n(exit 0)\n\n$ b\n2\n(exit 1)');
  });

  _test('oversized output is truncated with a marker', () => {
    const huge = 'x'.repeat(50);
    const out = formatShellEscapeContext([{ command: 'big', body: huge, code: 0 }], 20);
    _expect(out).toContain('…(shell 输出已截断)');
  });
});

/* ── end-to-end through the real shell tool ─────────────────────────────── */
_describe('shell-escape e2e (real shellCommand tool)', () => {
  _test('!echo runs and its output formats into the context block', async () => {
    const result = await shellTool.execute({ command: 'echo khy-escape-ok' }, {});
    const rec = {
      command: 'echo khy-escape-ok',
      body: String((result && (result.output || result.error)) || '').replace(/\s+$/, ''),
      code: result && Number.isFinite(result.exitCode) ? result.exitCode : (result && result.success ? 0 : 1),
      success: !!(result && result.success),
    };
    _expect(rec.success).toBe(true);
    _expect(rec.body).toContain('khy-escape-ok');
    const ctx = formatShellEscapeContext([rec]);
    _expect(ctx).toContain('khy-escape-ok');
    _expect(ctx).toContain('<shell-escape-output>');
  });
});
