'use strict';

/**
 * inputClassifiers.isEscOnly.test.js — bare-ESC predicate.
 *
 * `isEscOnlyInput` was extracted from cli/repl.js (where it had no direct test)
 * into the inputClassifiers module, alongside `isArrowEscapeLine`. It must match
 * ONLY a lone ESC byte (cancel/clear), never arrow CSI sequences or text.
 */

const { isEscOnlyInput } = require('../../src/cli/repl/inputClassifiers');

describe('isEscOnlyInput', () => {
  test('true only for a lone ESC byte', () => {
    expect(isEscOnlyInput('\u001b')).toBe(true);
  });

  test('false for arrow CSI sequences (ESC + [ + letter)', () => {
    expect(isEscOnlyInput('\u001b[A')).toBe(false);
    expect(isEscOnlyInput('\u001b[D')).toBe(false);
  });

  test('false for empty / plain text / undefined', () => {
    expect(isEscOnlyInput('')).toBe(false);
    expect(isEscOnlyInput('hello')).toBe(false);
    expect(isEscOnlyInput(undefined)).toBe(false);
  });
});
