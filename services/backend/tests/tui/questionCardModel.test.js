'use strict';

/**
 * questionCardModel — pure UI-logic unit tests.
 *
 * Covers the row layout (real options + 可讨论 + Other), wrapping card/cursor
 * navigation, and answer assembly (single/multi, including 可讨论, free-text,
 * and the laziness fallback where an empty multi-card collapses to 可讨论).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const m = require('../../src/cli/tui/ink-components/questionCardModel');

describe('rowLayout — 可讨论 + Other appended after real options', () => {
  test('two options → discussRow=2, otherRow=3, rowCount=4', () => {
    assert.deepEqual(m.rowLayout(2), { discussRow: 2, otherRow: 3, rowCount: 4 });
  });
  test('zero options is still well-formed (discuss+other only)', () => {
    assert.deepEqual(m.rowLayout(0), { discussRow: 0, otherRow: 1, rowCount: 2 });
  });
});

describe('rowKind — classify a cursor position', () => {
  test('within options → option', () => {
    assert.equal(m.rowKind(0, 3), 'option');
    assert.equal(m.rowKind(2, 3), 'option');
  });
  test('at discussRow → discuss', () => {
    assert.equal(m.rowKind(3, 3), 'discuss');
  });
  test('at otherRow → other', () => {
    assert.equal(m.rowKind(4, 3), 'other');
  });
});

describe('navigation wraps (多张卡左右 + 卡内上下)', () => {
  test('nextCard wraps at the end', () => {
    assert.equal(m.nextCard(2, 3), 0);
    assert.equal(m.nextCard(0, 3), 1);
  });
  test('prevCard wraps at the start', () => {
    assert.equal(m.prevCard(0, 3), 2);
    assert.equal(m.prevCard(2, 3), 1);
  });
  test('moveCursor wraps both directions', () => {
    assert.equal(m.moveCursor(0, -1, 4), 3);
    assert.equal(m.moveCursor(3, +1, 4), 0);
  });
  test('count<=0 collapses to 0 (degenerate guard)', () => {
    assert.equal(m.wrapIndex(5, 0), 0);
    assert.equal(m.nextCard(1, 0), 0);
  });
});

describe('singleSelection', () => {
  const options = [{ label: 'A' }, { label: 'B' }];
  test('cursor on a real option returns its label', () => {
    assert.equal(m.singleSelection({ options, cursor: 1 }), 'B');
  });
  test('cursor on discuss row returns 可讨论', () => {
    assert.equal(m.singleSelection({ options, cursor: 2 }), m.DISCUSS_LABEL);
  });
  test('cursor on Other row returns the typed value', () => {
    assert.equal(m.singleSelection({ options, cursor: 3, otherValue: '自定义' }), '自定义');
  });
  test('Other row with empty text → 可讨论 (laziness fallback)', () => {
    assert.equal(m.singleSelection({ options, cursor: 3, otherValue: '   ' }), m.DISCUSS_LABEL);
  });
});

describe('multiSelection — ordered: options → 可讨论 → free-text', () => {
  const options = [{ label: 'A' }, { label: 'B' }, { label: 'C' }];
  test('checked options preserve original order', () => {
    const sel = m.multiSelection({ options, checked: new Set([2, 0]) });
    assert.deepEqual(sel, ['A', 'C']);
  });
  test('discussChecked appends 可讨论 after options', () => {
    const sel = m.multiSelection({ options, checked: new Set([1]), discussChecked: true });
    assert.deepEqual(sel, ['B', m.DISCUSS_LABEL]);
  });
  test('free-text appended last', () => {
    const sel = m.multiSelection({ options, checked: new Set([0]), discussChecked: true, otherValue: '别的' });
    assert.deepEqual(sel, ['A', m.DISCUSS_LABEL, '别的']);
  });
  test('nothing selected → collapses to 可讨论 (lazy default)', () => {
    const sel = m.multiSelection({ options, checked: new Set() });
    assert.deepEqual(sel, [m.DISCUSS_LABEL]);
  });
});

describe('cardAnswer — joins multi with ", " (legacy-compatible)', () => {
  const options = [{ label: 'A' }, { label: 'B' }];
  test('multi joins selections', () => {
    const ans = m.cardAnswer({ multi: true, options, checked: new Set([0, 1]) });
    assert.equal(ans, 'A, B');
  });
  test('single returns one label', () => {
    const ans = m.cardAnswer({ multi: false, options, cursor: 0 });
    assert.equal(ans, 'A');
  });
});

describe('collectAllAnswers — keyed by question text, reads per-card state', () => {
  const questions = [
    { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
    { question: 'Q2', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: true },
  ];
  test('collects single + multi from independent per-card state', () => {
    const answers = m.collectAllAnswers(questions, {
      cursors: [1, 0],
      checkedSets: [new Set(), new Set([0, 1])],
      discussChecked: [false, false],
      otherVals: ['', ''],
    });
    assert.deepEqual(answers, { Q1: 'B', Q2: 'X, Y' });
  });
  test('a multi card left untouched falls back to 可讨论', () => {
    const answers = m.collectAllAnswers(questions, {
      cursors: [0, 0],
      checkedSets: [new Set(), new Set()],
      discussChecked: [false, false],
      otherVals: ['', ''],
    });
    assert.equal(answers.Q2, m.DISCUSS_LABEL);
  });
  test('missing question text falls back to positional key', () => {
    const answers = m.collectAllAnswers(
      [{ question: '', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
      { cursors: [0], checkedSets: [new Set()], discussChecked: [false], otherVals: [''] }
    );
    assert.equal(answers['Question 1'], 'A');
  });
});

// ── Fix 2/3 门控梯 ───────────────────────────────────────────────────────────
describe('questionTextCursorEnabled / questionMultipickEnabled — default on, falsy off', () => {
  test('default on (unset / empty env)', () => {
    assert.equal(m.questionTextCursorEnabled({}), true);
    assert.equal(m.questionMultipickEnabled({}), true);
    assert.equal(m.questionTextCursorEnabled(undefined), true);
    assert.equal(m.questionMultipickEnabled(undefined), true);
  });
  test('explicit falsy → off (case/space-insensitive)', () => {
    for (const v of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
      assert.equal(m.questionTextCursorEnabled({ KHY_QUESTION_TEXT_CURSOR: v }), false, `text ${v}`);
      assert.equal(m.questionMultipickEnabled({ KHY_QUESTION_MULTIPICK: v }), false, `multipick ${v}`);
    }
  });
  test('other values → on', () => {
    assert.equal(m.questionTextCursorEnabled({ KHY_QUESTION_TEXT_CURSOR: 'yes' }), true);
    assert.equal(m.questionMultipickEnabled({ KHY_QUESTION_MULTIPICK: '1' }), true);
  });
});

// ── Fix 3 有效多选(effectiveMulti) ─────────────────────────────────────────
describe('effectiveMulti — declared multiSelect OR (gate on AND promoted)', () => {
  test('declared multiSelect is always multi (even gate off)', () => {
    assert.equal(m.effectiveMulti({ multiSelect: true, promoted: false, env: { KHY_QUESTION_MULTIPICK: '0' } }), true);
  });
  test('single card promoted with gate on → multi', () => {
    assert.equal(m.effectiveMulti({ multiSelect: false, promoted: true, env: {} }), true);
  });
  test('single card promoted with gate off → still single (byte-identical legacy)', () => {
    assert.equal(m.effectiveMulti({ multiSelect: false, promoted: true, env: { KHY_QUESTION_MULTIPICK: '0' } }), false);
  });
  test('single card unpromoted → single', () => {
    assert.equal(m.effectiveMulti({ multiSelect: false, promoted: false, env: {} }), false);
  });
});

// ── Fix 3 cardAnswer / collectAllAnswers 尊重 promoted ────────────────────────
describe('promoted single card yields a joined multi answer', () => {
  const options = [{ label: 'A' }, { label: 'B' }];
  test('cardAnswer(promoted:true, gate on) joins like multi', () => {
    const ans = m.cardAnswer({ multi: false, promoted: true, env: {}, options, checked: new Set([0, 1]) });
    assert.equal(ans, 'A, B');
  });
  test('cardAnswer(promoted:true, gate off) stays single (cursor-based)', () => {
    const ans = m.cardAnswer({ multi: false, promoted: true, env: { KHY_QUESTION_MULTIPICK: '0' }, options, checked: new Set([0, 1]), cursor: 1 });
    assert.equal(ans, 'B');
  });
  test('collectAllAnswers with promotedMulti[i]=true → single card produces multi join; other card untouched', () => {
    const questions = [
      { question: 'Q1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
      { question: 'Q2', options: [{ label: 'X' }, { label: 'Y' }], multiSelect: false },
    ];
    const answers = m.collectAllAnswers(questions, {
      cursors: [0, 0],
      checkedSets: [new Set([0, 1]), new Set()],
      discussChecked: [false, false],
      otherVals: ['', ''],
      promotedMulti: [true, false],
    }, {});
    assert.equal(answers.Q1, 'A, B'); // promoted → multi join
    assert.equal(answers.Q2, 'X');    // untouched single card → cursor 0 = 'X'
  });
  test('collectAllAnswers without promotedMulti (back-compat) → all single', () => {
    const questions = [{ question: 'Q1', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }];
    const answers = m.collectAllAnswers(questions, {
      cursors: [1], checkedSets: [new Set([0, 1])], discussChecked: [false], otherVals: [''],
    });
    assert.equal(answers.Q1, 'B'); // no promotedMulti → single, cursor 1 = 'B'
  });
});
