'use strict';

/**
 * calcSiblingRedosGuard — sibling greedy-digit ReDoS spots found by the R4
 * "same-shape cluster" sweep after the localBrainCalc Chinese-math fix.
 *
 * Two more regexes matched the pattern "greedy numeric run + failing literal
 * anchor" and backtracked at every start position → O(n^2):
 *
 *   1. offlineKnowledge `_UNIT_CONVERT_RE`/`_UNIT_CONVERT_RE2` — `(\d+…)…等于/换算`.
 *      Reached via the `unit_convert` tool (model-generated `params.query`) with
 *      NO internal length cap. >25 s freeze at 60k digits. Bounded head to
 *      `\d{1,15}` (byte-identical on realistic magnitudes).
 *   2. localReasoning `_extractFactCandidate` numUnit — `\d[\d,，.]*\s*(units)`.
 *      Reached from web-search snippet sentences (`_cleanSnippet` does not cap
 *      length). ~8.5 s freeze at 100k digits. Bounded run to `[\d,，.]{0,31}`.
 *
 * Both are tier-2 (model/web-output reachable, not raw-user-P1). The bounds are
 * unconditional (byte-identical on all realistic inputs) rather than env-gated,
 * because offlineKnowledge is a pure leaf (must not read process.env) and the
 * tool path passes no env.
 */

const offline = require('../../src/services/offlineKnowledge');
const reasoning = require('../../src/services/localReasoning');

function elapsedMs(fn) {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

describe('calcSiblingRedosGuard — unit-convert + fact-candidate ReDoS', () => {
  it('offlineKnowledge.unitConvert stays linear on a huge digit run', () => {
    const q = '9'.repeat(200000) + 'x';
    const ms = elapsedMs(() => offline.unitConvert(q));
    expect(ms).toBeLessThan(2000); // was >25000ms (freeze) unbounded
  });

  it('offlineKnowledge.unitConvert still performs realistic conversions', () => {
    expect(offline.unitConvert('20摄氏度等于多少')).toMatch(/华氏/);
    expect(offline.unitConvert('3.5千克是多少克')).toMatch(/3\.5/);
    // a non-conversion string returns null (no false match)
    expect(offline.unitConvert('hello world')).toBeNull();
  });

  it('localReasoning._extractFactCandidate stays linear on a huge numeric sentence', () => {
    const giant = '9'.repeat(100000) + '个';
    const ms = elapsedMs(() => reasoning._extractFactCandidate('人口', [giant]));
    expect(ms).toBeLessThan(1500); // was ~8500ms unbounded
  });

  it('localReasoning._extractFactCandidate still extracts a normal number+unit', () => {
    const out = reasoning._extractFactCandidate('中国人口', ['据统计中国人口约为14亿人。']);
    expect(out).toBe('14亿人');
  });
});
