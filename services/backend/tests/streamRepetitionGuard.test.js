'use strict';

/**
 * Tests for streamRepetitionGuard — the live token-repetition (degeneration)
 * detector that backs the "讲个笑话 → 要要要…×1000" correction.
 *
 * Pins the pure detector (findRepetition), the streaming stateful guard
 * (create/push/inspect), the signature used by the repeat-break, and the
 * env-driven enable/config surface.
 */

const assert = require('assert');

const G = require('../src/services/query/streamRepetitionGuard');

describe('streamRepetitionGuard', () => {
  describe('findRepetition — degenerate tails', () => {
    test('detects a single chanted multi-char unit ("要,要,要…")', () => {
      const text = '小明说："要，' + '要，'.repeat(400);
      const r = G.findRepetition(text);
      assert.strictEqual(r.tripped, true);
      assert.strictEqual(r.unit, '要，');
      assert.ok(r.repeats >= 12);
      // Clean prefix keeps the lead-in plus exactly one unit, drops the flood.
      const prefix = text.slice(0, r.cleanPrefixLength);
      assert.ok(prefix.startsWith('小明说："要，'));
      assert.ok(prefix.length < text.length);
      // The dropped tail must be (nearly) all the chanted unit.
      assert.ok((text.length - prefix.length) >= r.runChars - r.unitLength);
    });

    test('detects a single chanted character', () => {
      const r = G.findRepetition('blah ' + 'a'.repeat(200));
      assert.strictEqual(r.tripped, true);
      assert.strictEqual(r.unitLength, 1);
      assert.strictEqual(r.unit, 'a');
    });

    test('detects a chanted short phrase', () => {
      const r = G.findRepetition('回答：' + '哈哈哈哈'.repeat(50));
      assert.strictEqual(r.tripped, true);
      assert.ok(r.runChars >= 48);
    });

    test('reports the SMALLEST repeating unit', () => {
      // "abab…" — smallest unit is "ab" (len 2), not "abab" (len 4).
      const r = G.findRepetition('x' + 'ab'.repeat(100));
      assert.strictEqual(r.tripped, true);
      assert.strictEqual(r.unitLength, 2);
      assert.strictEqual(r.unit, 'ab');
    });
  });

  describe('findRepetition — legitimate text does NOT trip', () => {
    test('normal prose', () => {
      const prose = 'The quick brown fox jumps over the lazy dog. '
        + 'A program walks into a bar and orders 1.0 beers. '
        + 'The bartender says nothing because it was a syntax error.';
      assert.strictEqual(G.findRepetition(prose).tripped, false);
    });

    test('a short emphatic repeat stays under threshold', () => {
      assert.strictEqual(G.findRepetition('哈哈哈哈哈哈').tripped, false); // 6 < 12 repeats
      assert.strictEqual(G.findRepetition('!!!').tripped, false);
    });

    test('a markdown bullet list does not look like chanting', () => {
      const list = ['- first item here', '- second different item',
        '- third unrelated point', '- fourth note'].join('\n');
      assert.strictEqual(G.findRepetition(list).tripped, false);
    });

    test('empty / short / non-string inputs are safe', () => {
      assert.strictEqual(G.findRepetition('').tripped, false);
      assert.strictEqual(G.findRepetition('hi').tripped, false);
      assert.strictEqual(G.findRepetition(null).tripped, false);
      assert.strictEqual(G.findRepetition(undefined).tripped, false);
      assert.strictEqual(G.findRepetition(42).tripped, false);
    });
  });

  describe('findRepetition — respects config overrides', () => {
    test('a higher minRepeats threshold suppresses a borderline run', () => {
      const text = 'z'.repeat(20);
      assert.strictEqual(G.findRepetition(text, { minRepeats: 12, minRunChars: 10 }).tripped, true);
      assert.strictEqual(G.findRepetition(text, { minRepeats: 50, minRunChars: 10 }).tripped, false);
    });
  });

  describe('repetitionSignature', () => {
    test('is stable for the same unit and null when not tripped', () => {
      const a = G.findRepetition('p' + '要，'.repeat(300));
      const b = G.findRepetition('different lead-in 要，要，' + '要，'.repeat(300));
      assert.strictEqual(G.repetitionSignature(a), G.repetitionSignature(b));
      assert.strictEqual(G.repetitionSignature({ tripped: false }), null);
      assert.strictEqual(G.repetitionSignature(null), null);
    });
  });

  describe('streaming guard (create/push/inspect)', () => {
    test('trips after enough chanted chunks arrive, stays tripped', () => {
      const g = G.create();
      assert.strictEqual(g.inspect().tripped, false);
      g.push('收银员问：要袋子吗？小明说："');
      assert.strictEqual(g.inspect().tripped, false);
      for (let i = 0; i < 400; i++) g.push('要，');
      assert.strictEqual(g.inspect().tripped, true);
      assert.strictEqual(g.tripped, true);
      // Idempotent once tripped.
      assert.strictEqual(g.inspect().tripped, true);
    });

    test('does not trip on a stream of normal sentences', () => {
      const g = G.create();
      g.push('Here is a joke. ');
      g.push('Why do programmers prefer dark mode? ');
      g.push('Because light attracts bugs.');
      assert.strictEqual(g.inspect().tripped, false);
    });

    test('reset clears state', () => {
      const g = G.create();
      for (let i = 0; i < 400; i++) g.push('要，');
      assert.strictEqual(g.inspect().tripped, true);
      g.reset();
      assert.strictEqual(g.tripped, false);
      assert.strictEqual(g.inspect().tripped, false);
    });

    test('bounded buffer never grows past maxBuffer', () => {
      const g = G.create({ maxBuffer: 256 });
      for (let i = 0; i < 1000; i++) g.push('要，');
      // Still detects (tail is all chant) and buffer stayed bounded.
      assert.strictEqual(g.inspect().tripped, true);
      assert.ok(g.config.maxBuffer === 256);
    });
  });

  describe('isEnabled', () => {
    const orig = process.env.KHY_STREAM_REPETITION_GUARD;
    afterEach(() => {
      if (orig === undefined) delete process.env.KHY_STREAM_REPETITION_GUARD;
      else process.env.KHY_STREAM_REPETITION_GUARD = orig;
    });

    test('defaults on, and explicit falsey values disable', () => {
      delete process.env.KHY_STREAM_REPETITION_GUARD;
      assert.strictEqual(G.isEnabled(), true);
      for (const v of ['0', 'false', 'off', 'no']) {
        process.env.KHY_STREAM_REPETITION_GUARD = v;
        assert.strictEqual(G.isEnabled(), false, `${v} should disable`);
      }
      process.env.KHY_STREAM_REPETITION_GUARD = '1';
      assert.strictEqual(G.isEnabled(), true);
    });
  });
});
