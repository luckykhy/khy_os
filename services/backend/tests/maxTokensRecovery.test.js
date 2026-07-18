'use strict';

/**
 * Tests for the s11 fix: max_tokens / truncation recovery as a single source of
 * truth (maxTokensRecovery.js), now wired into toolUseLoop.
 *
 * Before this fix the module was an orphan — toolUseLoop reimplemented the
 * truncation set, the continuation prompt, and the "3 attempts" cap inline, and
 * had no diminishing-returns guard, so a stuck model would always burn every
 * continuation attempt producing nothing. These tests pin the pure recovery
 * primitives the loop now depends on:
 *   • isTruncationStop  — provider-agnostic detection of a token-cap stop
 *   • shouldRecover     — attempt budget + Phase 1 escalation descriptor
 *   • isNegligibleContinuation — the diminishing-returns predicate
 *   • buildContinuationPrompt  — the single continuation prompt
 */

const assert = require('assert');

const R = require('../src/services/query/maxTokensRecovery');

describe('s11 — maxTokensRecovery primitives', () => {
  describe('isTruncationStop', () => {
    test('recognizes every provider-native cap stop reason', () => {
      for (const r of ['length', 'max_tokens', 'max-tokens', 'max_tokens_exceeded',
        'max_output_tokens', 'max_completion_tokens']) {
        assert.strictEqual(R.isTruncationStop(r), true, `${r} must count as truncation`);
      }
    });

    test('is case/whitespace tolerant', () => {
      assert.strictEqual(R.isTruncationStop('  MAX_TOKENS '), true);
      assert.strictEqual(R.isTruncationStop('Length'), true);
    });

    test('rejects non-truncation / empty reasons', () => {
      for (const r of ['stop', 'end_turn', 'tool_use', '', null, undefined]) {
        assert.strictEqual(R.isTruncationStop(r), false, `${r} must not count as truncation`);
      }
    });
  });

  describe('shouldRecover', () => {
    test('returns null for non-truncation stops', () => {
      assert.strictEqual(R.shouldRecover('end_turn', 0, 8000), null);
    });

    test('returns null once the attempt budget is exhausted', () => {
      assert.strictEqual(R.shouldRecover('length', R.MAX_OUTPUT_RECOVERY_ATTEMPTS, 64000), null);
    });

    test('Phase 1: escalates an explicit small cap to the full budget', () => {
      const rec = R.shouldRecover('length', 0, 8000);
      assert.ok(rec);
      assert.strictEqual(rec.shouldEscalate, true);
      assert.strictEqual(rec.nextMax, R.ESCALATED_MAX_TOKENS);
      assert.strictEqual(rec.recoveryCount, 1);
    });

    test('does not escalate when the cap is already wide', () => {
      const rec = R.shouldRecover('length', 1, 64000);
      assert.ok(rec);
      assert.strictEqual(rec.shouldEscalate, false);
      assert.strictEqual(rec.nextMax, 64000);
      assert.strictEqual(rec.recoveryCount, 2);
    });

    test('treats a missing cap as the capped default (escalates)', () => {
      const rec = R.shouldRecover('max_tokens', 0, undefined);
      assert.ok(rec);
      assert.strictEqual(rec.shouldEscalate, true);
      assert.strictEqual(rec.nextMax, R.ESCALATED_MAX_TOKENS);
    });
  });

  describe('isNegligibleContinuation (diminishing-returns predicate)', () => {
    test('short / blank chunks are negligible', () => {
      assert.strictEqual(R.isNegligibleContinuation(''), true);
      assert.strictEqual(R.isNegligibleContinuation('   \n  '), true);
      assert.strictEqual(R.isNegligibleContinuation('ok'), true);
      assert.strictEqual(R.isNegligibleContinuation(null), true);
      assert.strictEqual(R.isNegligibleContinuation(undefined), true);
    });

    test('a substantial chunk is not negligible', () => {
      const big = 'x'.repeat(R.MIN_CONTINUATION_CHARS + 1);
      assert.strictEqual(R.isNegligibleContinuation(big), false);
    });

    test('respects a caller-supplied threshold', () => {
      assert.strictEqual(R.isNegligibleContinuation('hello', 3), false); // 5 >= 3
      assert.strictEqual(R.isNegligibleContinuation('hello', 100), true); // 5 < 100
    });

    test('invalid thresholds fall back to the module default', () => {
      const justUnder = 'y'.repeat(R.MIN_CONTINUATION_CHARS - 1);
      assert.strictEqual(R.isNegligibleContinuation(justUnder, 0), true);
      assert.strictEqual(R.isNegligibleContinuation(justUnder, -5), true);
      assert.strictEqual(R.isNegligibleContinuation(justUnder, NaN), true);
    });

    test('trims surrounding whitespace before measuring', () => {
      const padded = `   ${'z'.repeat(R.MIN_CONTINUATION_CHARS + 5)}   `;
      assert.strictEqual(R.isNegligibleContinuation(padded), false);
    });
  });

  describe('isRepetitiveContinuation (degeneration backstop)', () => {
    test('flags a chanted continuation as repetitive', () => {
      assert.strictEqual(R.isRepetitiveContinuation('要，'.repeat(400)), true);
    });

    test('does not flag a substantive continuation', () => {
      assert.strictEqual(
        R.isRepetitiveContinuation('Here is the rest of the answer with real content.'),
        false,
      );
    });

    test('is safe on empty / non-string input', () => {
      assert.strictEqual(R.isRepetitiveContinuation(''), false);
      assert.strictEqual(R.isRepetitiveContinuation(null), false);
      assert.strictEqual(R.isRepetitiveContinuation(undefined), false);
    });
  });

  describe('buildContinuationPrompt', () => {
    test('is a stable non-empty system continuation directive', () => {
      const p = R.buildContinuationPrompt();
      assert.strictEqual(typeof p, 'string');
      assert.ok(p.length > 0);
      assert.ok(/resume/i.test(p) && /truncat/i.test(p),
        'prompt should tell the model to resume after truncation');
    });
  });

  describe('module surface', () => {
    test('exposes the constants the loop relies on', () => {
      assert.strictEqual(R.MAX_OUTPUT_RECOVERY_ATTEMPTS, 3);
      assert.strictEqual(R.CAPPED_DEFAULT_MAX_TOKENS, 8000);
      assert.strictEqual(R.ESCALATED_MAX_TOKENS, 64000);
      assert.ok(R.MIN_CONTINUATION_CHARS > 0);
      assert.ok(R.MAX_NEGLIGIBLE_CONTINUATIONS > 0);
    });
  });
});
