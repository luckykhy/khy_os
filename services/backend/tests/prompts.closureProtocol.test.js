'use strict';

/**
 * prompts.closureProtocol.test.js — the always-on "Problem-solving closure"
 * protocol in _coreProfile (reached via getKhySpecificSection).
 *
 * Goal「系统提示词每一步驱动下一步,直到任务完成闭环」: the closure block is the
 * baseline self-propelling loop instruction applied to EVERY task (even plain
 * chat), independent of goal/ultrawork/coding mode directives. It must articulate
 * three things the old 3-bullet version left implicit:
 *   1. an exit invariant (name the completion condition up front),
 *   2. the step→step drive (each result picks the next action),
 *   3. verifiable closure (a check that ran, not an impression), then stop.
 *
 * These assertions are intentionally about the PRESENCE of the mechanic, not exact
 * wording, so the prose can be polished without churn — but the loop's three legs
 * must remain.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../src/constants/prompts');

function closureBlock() {
  const s = prompts.getKhySpecificSection({});
  const start = s.indexOf('## Problem-solving closure');
  assert.ok(start >= 0, 'closure section must be present in the core profile');
  // Slice to the next heading so assertions stay scoped to this block.
  const rest = s.slice(start + 3);
  const nextHeading = rest.indexOf('\n## ');
  return nextHeading >= 0 ? rest.slice(0, nextHeading) : rest;
}

describe('Problem-solving closure protocol (always-on)', () => {
  test('heading frames the self-propelling loop (each step drives the next)', () => {
    const block = closureBlock();
    assert.match(block, /each step drives the next/i);
    assert.match(block, /loop closes|closes the loop|the loop/i);
  });

  test('leg 1: names the completion condition as the loop exit test', () => {
    const block = closureBlock();
    assert.match(block, /completion condition/i);
    assert.match(block, /exit test|what "done" means/i);
  });

  test('leg 2: each step derives the next from its result vs the condition', () => {
    const block = closureBlock();
    // The drive mechanic: read the result, pick the next step; never end a step
    // without either a next action or a proven closure.
    assert.match(block, /after every step/i);
    assert.match(block, /next step|next action/i);
    assert.match(block, /never end a step without/i);
  });

  test('leg 3: closure requires a verifiable check, not an impression', () => {
    const block = closureBlock();
    assert.match(block, /verifiab/i);
    assert.match(block, /concrete check|actually ran/i);
    assert.match(block, /impression/i);
  });

  test('bounds it: stop when met, do not over-polish (no scope contradiction)', () => {
    const block = closureBlock();
    assert.match(block, /stop/i);
    assert.match(block, /not keep polishing|do not keep polishing/i);
    // The three legitimate stop reasons remain.
    assert.match(block, /met and verified/i);
    assert.match(block, /constraint blocks you|real constraint/i);
    assert.match(block, /user stops/i);
  });

  test('still executes-first (does not regress the original directive)', () => {
    const block = closureBlock();
    assert.match(block, /do not stop at explanations/i);
    assert.match(block, /execute first, summarize after/i);
  });

  test('single closure section — no duplicate heading (single-layer noise principle)', () => {
    const s = prompts.getKhySpecificSection({});
    const occurrences = (s.match(/## Problem-solving closure/g) || []).length;
    assert.equal(occurrences, 1);
  });
});
