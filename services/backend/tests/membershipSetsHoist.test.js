'use strict';

/**
 * membershipSetsHoist.test.js — Ch2「不要每轮重建可复用结构」
 *
 * Verifies the pure module-const hoist of four further literal-only membership
 * Sets out of per-call function bodies in toolUseLoop (auto web-search modes,
 * delivery-nudge stopwords, app-target probe binaries, search-term stopwords).
 * Each was formerly rebuilt on every call; now built once at module load.
 * Behavior must be byte-identical; each set is consumed read-only via `.has`.
 */

const test = require('node:test');
const assert = require('node:assert');

const loop = require('../src/services/toolUseLoop');
const {
  _AUTO_WEB_SEARCH_MODES: MODES,
  _DELIVERY_NUDGE_STOPWORDS: NUDGE_STOP,
  _APP_TARGET_PROBE_BINS: PROBE,
  _SEARCH_TERM_STOPWORDS: SEARCH_STOP,
} = loop;

test('all four sets are exported and non-empty', () => {
  for (const s of [MODES, NUDGE_STOP, PROBE, SEARCH_STOP]) {
    assert.ok(s instanceof Set && s.size > 0);
  }
});

test('auto web-search modes membership is byte-identical', () => {
  const expected = ['auto', 'news', 'docs', 'academic', 'general'];
  assert.strictEqual(MODES.size, expected.length);
  for (const k of expected) assert.ok(MODES.has(k), `MODES missing ${k}`);
  assert.ok(!MODES.has('sports'));
});

test('app-target probe bins membership is byte-identical', () => {
  const expected = ['which', 'whereis', 'command', 'type', 'ps', 'pgrep', 'pidof', 'grep', 'bash', 'sh', 'zsh', 'env', 'nohup'];
  assert.strictEqual(PROBE.size, expected.length);
  for (const k of expected) assert.ok(PROBE.has(k), `PROBE missing ${k}`);
  // A real launch target must NOT be a probe bin.
  assert.ok(!PROBE.has('code') && !PROBE.has('firefox'));
});

test('delivery-nudge stopwords filter function words but keep content words', () => {
  assert.ok(NUDGE_STOP.has('please') && NUDGE_STOP.has('should'));
  assert.ok(NUDGE_STOP.has('把') && NUDGE_STOP.has('的'));
  assert.ok(!NUDGE_STOP.has('database') && !NUDGE_STOP.has('deploy'));
});

test('search-term stopwords filter generic search verbs, keep topic nouns', () => {
  assert.ok(SEARCH_STOP.has('search') && SEARCH_STOP.has('查找') && SEARCH_STOP.has('最新'));
  assert.ok(!SEARCH_STOP.has('kubernetes') && !SEARCH_STOP.has('比特币'));
});

test('the four sets are distinct objects and stable across re-require', () => {
  assert.notStrictEqual(MODES, PROBE);
  assert.notStrictEqual(NUDGE_STOP, SEARCH_STOP);
  const again = require('../src/services/toolUseLoop');
  assert.strictEqual(again._AUTO_WEB_SEARCH_MODES, MODES);
  assert.strictEqual(again._DELIVERY_NUDGE_STOPWORDS, NUDGE_STOP);
  assert.strictEqual(again._APP_TARGET_PROBE_BINS, PROBE);
  assert.strictEqual(again._SEARCH_TERM_STOPWORDS, SEARCH_STOP);
});
