'use strict';

/**
 * deterministicFactsUnitRedosGuard — Chinese unit-conversion ReDoS.
 *
 * `_UNIT_RE` (a `gi` global regex) had an unbounded greedy numeric head
 * `(\d+(?:\.\d+)?)`. When the trailing unit/connector anchor fails, the engine
 * backtracks the digit run at every start position → O(n^2). This regex is
 * reached through `routeDeterministicFacts({ text })` which, in MODEL mode,
 * scans the RAW userMessage directly (cli/ai.js:4784, default on) BEFORE the
 * inputSanitizer 200k cap. A crafted `9…9x` message froze the turn (~18 s at
 * 50k digits, >34 s at 80k). The call site's try/catch cannot help — a hang
 * never throws. This is the most user-reachable spot in this cluster (model
 * mode is the mainstream path, unlike calc's model-less /local route).
 *
 * Fix: bound the numeric head to `\d{1,15}` — covers every real magnitude,
 * byte-identical on realistic inputs, linear on the pathological one.
 */

const PATH = require.resolve('../../src/services/deterministicFacts');

function fresh() {
  delete require.cache[PATH];
  return require(PATH);
}

function elapsedMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('deterministicFactsUnitRedosGuard — _UNIT_RE ReDoS', () => {
  it('routeDeterministicFacts stays linear on a huge digit run', () => {
    const df = fresh();
    const q = '9'.repeat(200000) + 'x';
    const ms = elapsedMs(() => df.routeDeterministicFacts({ text: q }));
    expect(ms).toBeLessThan(2000); // was >34000ms (freeze) unbounded
  });

  it('detectUnitFact stays linear on a huge digit run', () => {
    const df = fresh();
    const q = '9'.repeat(100000) + '米';
    const ms = elapsedMs(() => df.detectUnitFact(q));
    expect(ms).toBeLessThan(1500);
  });

  it('realistic unit conversions still detect (byte-identical behavior)', () => {
    const df = fresh();
    for (const q of ['1米等于多少厘米', '3.5千克是多少克', '100千米等于多少米', '5英尺是多少米']) {
      const r = df.detectFact(q);
      expect(r).not.toBeNull();
      expect(r.type).toBe('deterministic_fact');
      expect(Array.isArray(r.facts)).toBe(true);
      expect(r.facts.length).toBeGreaterThan(0);
    }
  });

  it('a 14-digit magnitude (within the cap) still converts', () => {
    const df = fresh();
    const r = df.detectFact('12345678901234米是多少厘米');
    expect(r).not.toBeNull();
    expect(r.facts.length).toBeGreaterThan(0);
  });

  it('a non-conversion string yields no unit fact (no false match)', () => {
    const df = fresh();
    expect(df.detectUnitFact('hello world 你好')).toBeNull();
  });
});
