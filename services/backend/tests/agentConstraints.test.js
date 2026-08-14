'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  EXECUTION_DISCIPLINE,
  HARD_PROHIBITIONS,
  readOnlyProhibitions,
} = require('../src/agents/constraints');
const {
  GENERAL_PURPOSE_AGENT,
  SHARED_GUIDELINES,
} = require('../src/agents/built-in/generalPurposeAgent');
const { EXPLORE_AGENT } = require('../src/agents/built-in/exploreAgent');
const { PLAN_AGENT } = require('../src/agents/built-in/planAgent');

const BUILT_IN_DIR = path.join(__dirname, '..', 'src', 'agents', 'built-in');

describe('agent constraints — single source of truth', () => {
  test('HARD_PROHIBITIONS is a crisp NEVER checklist', () => {
    const neverLines = HARD_PROHIBITIONS.split('\n').filter(l =>
      l.trim().startsWith('- NEVER')
    );
    // Every recorded detour must have a prohibition.
    assert.ok(neverLines.length >= 10, 'expected at least 10 NEVER rules');
    assert.match(HARD_PROHIBITIONS, /override any guideline/);
  });

  test('organize-directory red lines: no-delete + move-then-rewire', () => {
    // 整理目录铁律: tidying must never delete, and a move must carry its
    // references (env vars / config / scripts) along to the new path.
    const noDelete = HARD_PROHIBITIONS
      .split('\n')
      .find(l => l.includes('NEVER delete a file while organizing'));
    assert.ok(noDelete, 'missing the no-delete-while-organizing prohibition');
    assert.match(noDelete, /ask the user for explicit confirmation/);

    const rewire = HARD_PROHIBITIONS
      .split('\n')
      .find(l => l.includes('NEVER move a file without rewiring'));
    assert.ok(rewire, 'missing the move-then-rewire prohibition');
    assert.match(rewire, /environment variables/);
  });

  test('structured-rendering red line: display text must come from structured data, not model prose', () => {
    // Every user-facing surface (results/steps/status/reports) must be rendered
    // from the structured data the tool/system returned — never from the model's
    // free prose. Text-to-structure parsing is allowed only as a labeled fallback.
    const rule = HARD_PROHIBITIONS
      .split('\n')
      .find(l => l.includes('NEVER render user-facing display text'));
    assert.ok(rule, 'missing the structured-rendering prohibition');
    assert.match(rule, /STRUCTURED data/);
    assert.match(rule, /tool_use\/tool_result/);
    assert.match(rule, /labeled fallback/);
  });

  test('EXECUTION_DISCIPLINE is an ordered plan→minimal→verify→refine loop', () => {
    for (const step of [
      '1. Plan first',
      '2. Execute the minimal slice',
      '3. Verify with evidence',
      '4. Refine only then',
    ]) {
      assert.ok(EXECUTION_DISCIPLINE.includes(step), `missing step: ${step}`);
    }
  });

  test('general-purpose agent injects the loop before the prohibitions', () => {
    const prompt = GENERAL_PURPOSE_AGENT.getSystemPrompt();
    assert.ok(prompt.includes(EXECUTION_DISCIPLINE), 'must embed the execution loop');
    assert.ok(prompt.includes(HARD_PROHIBITIONS), 'must embed the prohibitions');
    // Positive loop is framed first; the red lines that override it come after.
    assert.ok(
      prompt.indexOf(EXECUTION_DISCIPLINE) < prompt.indexOf(HARD_PROHIBITIONS),
      'EXECUTION_DISCIPLINE must precede HARD_PROHIBITIONS'
    );
  });

  test('no single-layer duplication: moved rules live only in the canonical blocks', () => {
    // These phrases were lifted out of SHARED_GUIDELINES into the canonical
    // discipline/prohibition blocks; they must not also linger inline.
    const movedPhrases = [
      'Fix root causes', // → HARD_PROHIBITIONS (paper over a symptom)
      '2-3 adjusted attempts', // → HARD_PROHIBITIONS (retry the same step)
      'run focused verification', // → EXECUTION_DISCIPLINE (verify)
      'Define the completion condition', // → EXECUTION_DISCIPLINE (plan)
    ];
    for (const phrase of movedPhrases) {
      assert.ok(
        !SHARED_GUIDELINES.includes(phrase),
        `"${phrase}" must not be duplicated in SHARED_GUIDELINES`
      );
    }
  });

  test('read-only agents share the canonical read-only block', () => {
    const exploreBlock = readOnlyProhibitions({
      task: 'exploration',
      role: 'search and analyze existing code',
    });
    const planBlock = readOnlyProhibitions({
      task: 'planning',
      role: 'explore the codebase and design implementation plans',
    });
    assert.ok(EXPLORE_AGENT.getSystemPrompt().includes(exploreBlock));
    assert.ok(PLAN_AGENT.getSystemPrompt().includes(planBlock));
  });

  test('the read-only block is defined once, not duplicated in agent prompts', () => {
    // The literal header must live only in constraints.js. Any agent file that
    // still pastes it inline is a single-source regression.
    const sentinel = '=== CRITICAL: READ-ONLY MODE - NO FILE MODIFICATIONS ===';
    const offenders = fs
      .readdirSync(BUILT_IN_DIR)
      .filter(f => f.endsWith('.js'))
      .filter(f => fs.readFileSync(path.join(BUILT_IN_DIR, f), 'utf8').includes(sentinel));
    assert.deepEqual(
      offenders,
      [],
      `read-only block must be injected from constraints.js, not pasted into: ${offenders.join(', ')}`
    );
  });
});
