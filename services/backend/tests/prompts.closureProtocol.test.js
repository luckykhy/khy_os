'use strict';
/**
 * prompts.closureProtocol.test.js �?the always-on "Problem-solving closure"
 * protocol in _coreProfile (reached via getKhySpecificSection).
 *
 * Goal「系统提示词每一步驱动下一�?直到任务完成闭环�? the closure block is the
 * baseline self-propelling loop instruction applied to EVERY task (even plain
 * chat), independent of goal/ultrawork/coding mode directives. It must articulate
 * three things the old 3-bullet version left implicit:
 *   1. an exit invariant (name the completion condition up front),
 *   2. the step→step drive (each result picks the next action),
 *   3. verifiable closure (a check that ran, not an impression), then stop.
 *
 * These assertions are intentionally about the PRESENCE of the mechanic, not exact
 * wording, so the prose can be polished without churn �?but the loop's three legs
 * must remain.
 */
const prompts = require('../src/constants/prompts');
function closureBlock() {
  const s = prompts.getKhySpecificSection({});
  const start = s.indexOf('## Problem-solving closure');
  expect(start >= 0).toBeTruthy();
  // Slice to the next heading so assertions stay scoped to this block.
  const rest = s.slice(start + 3);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}
describe('Problem-solving closure protocol (always-on)', () => {
});

describe('Prompts closure Protocol', () => {
  test('heading frames the self-propelling loop (each step drives the next)', () => {
        const block = closureBlock();
        expect(block).toMatch(/each step drives the next/i);
        expect(block).toMatch(/loop closes|closes the loop|the loop/i);
  });

  test('leg 1: names the completion condition as the loop exit test', () => {
        const block = closureBlock();
        expect(block).toMatch(/completion condition/i);
        expect(block).toMatch(/exit test|what "done" means/i);
  });

  test('leg 2: each step derives the next from its result vs the condition', () => {
        const block = closureBlock();
        // The drive mechanic: read the result, pick the next step; never end a step
        // without either a next action or a proven closure.
        expect(block).toMatch(/after every step/i);
        expect(block).toMatch(/next step|next action/i);
        expect(block).toMatch(/never end a step without/i);
  });

  test('leg 3: closure requires a verifiable check, not an impression', () => {
        const block = closureBlock();
        expect(block).toMatch(/verifiab/i);
        expect(block).toMatch(/concrete check|actually ran/i);
        expect(block).toMatch(/impression/i);
  });

  test('bounds it: stop when met, do not over-polish (no scope contradiction)', () => {
        const block = closureBlock();
        expect(block).toMatch(/stop/i);
        expect(block).toMatch(/not keep polishing|do not keep polishing/i);
        // The three legitimate stop reasons remain.
        expect(block).toMatch(/met and verified/i);
        expect(block).toMatch(/constraint blocks you|real constraint/i);
        expect(block).toMatch(/user stops/i);
  });

  test('still executes-first (does not regress the original directive)', () => {
        const block = closureBlock();
        expect(block).toMatch(/do not stop at explanations/i);
        expect(block).toMatch(/execute first, summarize after/i);
  });

  test('single closure section �?no duplicate heading (single-layer noise principle)', () => {
        const s = prompts.getKhySpecificSection({});
        const occurrences = (s.match(/## Problem-solving closure/g) || []).length;
        expect(occurrences).toBe(1);
  });

});

