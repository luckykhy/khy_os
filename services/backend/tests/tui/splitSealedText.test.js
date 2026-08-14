'use strict';

/**
 * splitSealedText — Phase 1.1 progressive text commit. Splits an OPEN
 * (still-streaming) text segment into a markdown-safe `sealed` prefix that can
 * be committed to scrollback and the in-flight `live` remainder.
 *
 * The contract the finalize drain relies on:
 *   - sealed + live === input   (no loss, no duplication — char-offset based)
 *   - a cut is made ONLY at a blank line that is NOT inside a fenced code block
 *   - the last (unterminated) line is never a boundary (still streaming)
 *   - tables/lists are safe for free: they end at a blank line and never
 *     contain one, so a blank-line cut can never split a row or a fence
 */

const { splitSealedText } = require('../../src/cli/tui/hooks/useQueryBridge');

function assertLossless(input) {
  const { sealed, live } = splitSealedText(input);
  expect(sealed + live).toBe(input);
}

describe('splitSealedText — no-loss invariant', () => {
  test('sealed + live always reconstructs the input', () => {
    [
      '',
      'one line, no newline',
      'para one\n\npara two still streaming',
      'a\n\nb\n\nc tail',
      '```js\nconst x = 1;\n\nconst y = 2;\n```\n\nafter fence',
      '| a | b |\n| - | - |\n| 1 | 2 |\n\ntrailing',
    ].forEach(assertLossless);
  });
});

describe('splitSealedText — boundary selection', () => {
  test('no boundary yet → everything stays live', () => {
    expect(splitSealedText('still going, no blank line')).toEqual({
      sealed: '', live: 'still going, no blank line',
    });
  });

  test('seals at a completed blank line, keeps the open tail live', () => {
    const { sealed, live } = splitSealedText('para one\n\npara two in progress');
    expect(sealed).toBe('para one\n\n');
    expect(live).toBe('para two in progress');
  });

  test('takes the LAST safe boundary when several exist', () => {
    const { sealed, live } = splitSealedText('a\n\nb\n\nc still typing');
    expect(sealed).toBe('a\n\nb\n\n');
    expect(live).toBe('c still typing');
  });

  test('a trailing blank line (turn ended on a blank) is itself a boundary', () => {
    // "x\n\n" → lines ['x','',''] : the middle blank is terminated, the last is
    // empty/unterminated. Seals up to and including the terminated blank.
    const { sealed, live } = splitSealedText('x\n\n');
    expect(sealed).toBe('x\n\n');
    expect(live).toBe('');
  });
});

describe('splitSealedText — never cuts inside a fence', () => {
  test('blank line inside an OPEN fence is not a boundary', () => {
    const input = 'intro\n\n```js\nconst a = 1;\n\nconst b = 2;';
    const { sealed, live } = splitSealedText(input);
    // Only the blank before the fence is safe; the in-fence blank is excluded.
    expect(sealed).toBe('intro\n\n');
    expect(live).toBe('```js\nconst a = 1;\n\nconst b = 2;');
  });

  test('after a fence CLOSES, a following blank line becomes a boundary', () => {
    const input = '```js\nx\n\ny\n```\n\ntail in progress';
    const { sealed, live } = splitSealedText(input);
    expect(sealed).toBe('```js\nx\n\ny\n```\n\n');
    expect(live).toBe('tail in progress');
  });

  test('tilde fences are tracked too', () => {
    const input = '~~~\na\n\nb\n~~~\n\ndone tail';
    const { sealed } = splitSealedText(input);
    expect(sealed).toBe('~~~\na\n\nb\n~~~\n\n');
  });
});

describe('splitSealedText — tables never split mid-row', () => {
  test('an in-progress table with no trailing blank stays fully live', () => {
    const input = '| a | b |\n| - | - |\n| 1 | 2 |';
    expect(splitSealedText(input)).toEqual({ sealed: '', live: input });
  });

  test('a completed table followed by a blank seals the whole table', () => {
    const input = '| a | b |\n| - | - |\n| 1 | 2 |\n\nnext para';
    const { sealed, live } = splitSealedText(input);
    expect(sealed).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n\n');
    expect(live).toBe('next para');
  });
});
