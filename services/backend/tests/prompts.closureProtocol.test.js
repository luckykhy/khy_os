'use strict';
/**
 * prompts.closureProtocol.test.js — the always-on "Execute, verify, close"
 * protocol in _coreProfile (reached via getKhySpecificSection).
 *
 * Goal「系统提示词每一步驱动下一步,直到任务完成闭环」: the closure block is the
 * baseline self-propelling loop instruction applied to EVERY task (even plain
 * chat), independent of goal/ultrawork/coding mode directives. It must articulate
 * three things the old 3-bullet version left implicit:
 *   1. an exit invariant (name the completion condition up front),
 *   2. the step→step drive (each result is compared against the condition),
 *   3. verifiable closure (a check that ran, not a claim), then stop.
 *
 * These assertions are intentionally about the PRESENCE of the mechanic, not exact
 * wording, so the prose can be polished without churn — but the loop's three legs
 * must remain. Re-anchored to the current "Execute, verify, close" wording after
 * the block absorbed the status-transparency (Action/Target/Progress) directive.
 */
const prompts = require('../src/constants/prompts');
function closureBlock() {
  const s = prompts.getKhySpecificSection({});
  const start = s.indexOf('## Execute, verify, close');
  expect(start >= 0).toBeTruthy();
  // Slice to the next heading so assertions stay scoped to this block.
  const rest = s.slice(start + 3);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

describe('Problem-solving closure protocol (always-on)', () => {
  test('heading frames the self-propelling loop (execute → verify → close)', () => {
    const block = closureBlock();
    expect(block).toMatch(/execute, verify, close/i);
    expect(block).toMatch(/close the loop/i);
  });

  test('leg 1: names the completion condition as the loop exit test', () => {
    const block = closureBlock();
    expect(block).toMatch(/define the completion condition/i);
    expect(block).toMatch(/before claiming completion/i);
  });

  test('leg 2: every meaningful result is compared against the condition', () => {
    const block = closureBlock();
    // The drive mechanic: read the result, pick the next step; a failed step
    // adjusts the approach instead of repeating the same failing call.
    expect(block).toMatch(/compare every meaningful result/i);
    expect(block).toMatch(/if a step fails/i);
    expect(block).toMatch(/do not repeat the same failing call/i);
  });

  test('leg 3: closure requires a verifiable check, not a bare claim', () => {
    const block = closureBlock();
    expect(block).toMatch(/verifiab/i);
    expect(block).toMatch(/focused test|syntax check|reproduction/i);
  });

  test('bounds it: close only when the condition is verifiably met, then stop', () => {
    const block = closureBlock();
    expect(block).toMatch(/only when the condition is verifiably met/i);
    expect(block).toMatch(/stop once (it|the condition) is met/i);
  });

  test('still executes-first (does not regress the original directive)', () => {
    const block = closureBlock();
    expect(block).toMatch(/call the appropriate tool instead of only describing steps/i);
    expect(block).toMatch(/read before editing/i);
  });

  test('single closure section — no duplicate heading (single-layer noise principle)', () => {
    const s = prompts.getKhySpecificSection({});
    const occurrences = (s.match(/## Execute, verify, close/g) || []).length;
    expect(occurrences).toBe(1);
  });
});
