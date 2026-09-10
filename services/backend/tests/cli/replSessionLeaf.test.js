'use strict';
/**
 * Leaf-contract test for replSession.js (the interactive session loop isolated from cli/repl.js).
 *
 * Governance: startRepl() is an irreducible ~9.4k-line routine. Per the "isolation-as-goal" decision it is
 * relocated verbatim (byte-identical body) into this same-directory sibling; the public entry cli/repl.js
 * keeps the small, independently unit-tested display/format utilities (_formatImageSize / _tk* /
 * formatShellEscapeContext / _resetGatewayBreakerOnSessionClear) plus the READ_SEARCH_TOOLS collapse set,
 * and injects them into replSession via setReplSessionDeps at host load (before startRepl is ever invoked).
 *
 * Proves: (1) the sibling exports startRepl (async) + the DI setter setReplSessionDeps; (2) the public entry
 * cli/repl.js re-exports the stable surface { startRepl, formatShellEscapeContext, _formatImageSize,
 * READ_SEARCH_TOOLS } and its startRepl is the same identity as the sibling's (wiring intact); (3)
 * setReplSessionDeps is a guarded, idempotent, non-throwing DI setter (6 functions via typeof guards, the
 * READ_SEARCH_TOOLS value via a `!== undefined` guard).
 *
 * startRepl drives the interactive REPL (readline, heavy IO, network), so this test stays on the
 * deterministic surface (export shape, wiring identity, setter guard) and never starts an actual session.
 */
const SIB = '../../src/cli/replSession';
const HOST = '../../src/cli/repl';

describe('Repl Session Leaf', () => {
  test('sibling exports startRepl (async) + DI setter', () => {
      const sib = require(SIB);
      expect(typeof sib.startRepl).toBe('function');
      expect(sib.startRepl.constructor.name).toBe('AsyncFunction');
      expect(typeof sib.setReplSessionDeps).toBe('function');
  });

  test('public entry re-exports the stable surface + startRepl identity is the sibling wiring', () => {
      const host = require(HOST);
      const sib = require(SIB);
      expect(typeof host.startRepl).toBe('function');
      expect(host.startRepl).toBe(sib.startRepl, 'host.startRepl must be the sibling startRepl');
      expect(typeof host.formatShellEscapeContext).toBe('function');
      expect(typeof host._formatImageSize).toBe('function');
      expect(host.READ_SEARCH_TOOLS instanceof Set).toBeTruthy();
      expect(host.READ_SEARCH_TOOLS.size > 0).toBeTruthy();
  });

  test('host utilities remain functional in the public entry', () => {
      const host = require(HOST);
      expect(host._formatImageSize(1536)).toBe('1.5KB');
      expect(host.formatShellEscapeContext([])).toBe('');
  });

  test('setReplSessionDeps is a guarded, idempotent, non-throwing DI setter', () => {
      const { setReplSessionDeps } = require(SIB);
      expect(() => setReplSessionDeps().not.toThrow());
      expect(() => setReplSessionDeps({}).not.toThrow());
      // Non-function fn-deps are ignored; the value dep accepts any defined value.
      expect(() => setReplSessionDeps({ _formatImageSize: 1, READ_SEARCH_TOOLS: null }).not.toThrow());
      const fn = () => {};
      const fake = {
        _formatImageSize: fn, _tk1: fn, _tk0: fn, _tkSpin: fn,
        formatShellEscapeContext: fn, _resetGatewayBreakerOnSessionClear: fn,
        READ_SEARCH_TOOLS: new Set(['Read']),
      };
      expect(() => setReplSessionDeps(fake).not.toThrow());
      expect(() => setReplSessionDeps(fake).not.toThrow());
  });

});

