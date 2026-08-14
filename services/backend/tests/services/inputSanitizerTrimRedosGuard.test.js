'use strict';

/**
 * inputSanitizerTrimRedosGuard — trailing-whitespace-anchor ReDoS in the input
 * sanitizer's final trim pass.
 *
 * `_runPipeline` ended with `s.replace(/^\s+|\s+$/g, '')`. The `\s+$`
 * alternative greedily consumes an interior whitespace run, then the `$` anchor
 * fails and backtracks the run at every start position → O(n^2). Earlier passes
 * only collapse `[ \t]` and `\n`, and RE_CONTROL's `-` range does
 * NOT include U+000D (CR); U+2028/U+2029 are likewise untouched. So a pasted run
 * of CR / LINE SEPARATOR / PARAGRAPH SEPARATOR survives to the final trim and
 * froze the turn: CR x100k ~8.6s, LS x80k ~10.6s. maxInputChars=200000 does NOT
 * help — an O(n^2) regex at 200k is still ~34s, and a hang never throws so the
 * sanitize() try/catch cannot save it.
 *
 * sanitizeForModel is called on the raw user message at cli/ai.js:5061, so this
 * is a real user-reachable DoS.
 *
 * Fix: use native String.prototype.trim() (O(n)) — byte-identical to the regex
 * for leading/trailing whitespace stripping (verified below across a battery and
 * randomized fuzz).
 */

const PATH = require.resolve('../../src/services/inputSanitizer');
const CR = String.fromCharCode(0x0d);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

function fresh() {
  delete require.cache[PATH];
  return require(PATH);
}

function elapsedMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('inputSanitizerTrimRedosGuard — final trim ReDoS', () => {
  it('sanitizeForModel stays linear on a huge CR run at the size cap', () => {
    const san = fresh();
    const s = 'x' + CR.repeat(200000) + 'y';
    const ms = elapsedMs(() => san.sanitizeForModel(s));
    expect(ms).toBeLessThan(2000); // was ~34s (freeze) with /^\s+|\s+$/g
  });

  it('sanitizeForModel stays linear on huge LINE/PARAGRAPH SEPARATOR runs', () => {
    const san = fresh();
    for (const ch of [LS, PS]) {
      const s = 'x' + ch.repeat(150000) + 'y';
      const ms = elapsedMs(() => san.sanitizeForModel(s));
      expect(ms).toBeLessThan(2000);
    }
  });

  it('leading/trailing whitespace is still trimmed (byte-identical semantics)', () => {
    const san = fresh();
    expect(san.sanitizeForModel('  hello world  ')).toBe('hello world');
    expect(san.sanitizeForModel(CR + CR + 'hi' + CR + CR)).toBe('hi');
    expect(san.sanitizeForModel('\t\n  keep me  \n\t')).toBe('keep me');
  });

  it('trim() is byte-identical to /^\\s+|\\s+$/g across a fuzz battery', () => {
    const RE = /^\s+|\s+$/g;
    const WS = [' ', '\t', '\n', CR, '\f', '\v', ' ', '　', LS, PS, '﻿'];
    const CH = ['a', '中', '1', '!', '\u{1f389}'];
    let allEq = true;
    for (let i = 0; i < 3000; i++) {
      let c = '';
      const n = 1 + Math.floor(Math.random() * 24);
      for (let j = 0; j < n; j++) {
        const pool = Math.random() < 0.5 ? WS : CH;
        c += pool[Math.floor(Math.random() * pool.length)];
      }
      if (c.replace(RE, '') !== c.trim()) { allEq = false; break; }
    }
    expect(allEq).toBe(true);
  });

  it('the pathological input produces the SAME output as the legacy regex (interior run preserved)', () => {
    const san = fresh();
    const s = 'x' + CR.repeat(500) + 'y';
    const legacy = s.replace(/^\s+|\s+$/g, '');
    // sanitizer only trims ends; interior CR run is preserved by both.
    expect(san.sanitizeForModel(s)).toBe(legacy);
  });
});
