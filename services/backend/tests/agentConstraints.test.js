'use strict';
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
});

describe('Agent Constraints', () => {
  test('HARD_PROHIBITIONS is a crisp NEVER checklist', () => {
        const neverLines = HARD_PROHIBITIONS.split('\n').filter(l =>
          l.trim().startsWith('- NEVER')
        );
        // Every recorded detour must have a prohibition.
        expect(neverLines.length >= 10).toBeTruthy();
        expect(HARD_PROHIBITIONS).toMatch(/override any guideline/);
  });

  test('organize-directory red lines: no-delete + move-then-rewire', () => {
        // 整理目录铁律: tidying must never delete, and a move must carry its
        // references (env vars / config / scripts) along to the new path.
        const noDelete = HARD_PROHIBITIONS
          .split('\n')
          .find(l => l.includes('NEVER delete a file while organizing'));
        expect(noDelete).toBeTruthy();
        expect(noDelete).toMatch(/ask the user for explicit confirmation/);
    
        const rewire = HARD_PROHIBITIONS
          .split('\n')
          .find(l => l.includes('NEVER move a file without rewiring'));
        expect(rewire).toBeTruthy();
        expect(rewire).toMatch(/environment variables/);
  });

  test('structured-rendering red line: display text must come from structured data, not model prose', () => {
        // Every user-facing surface (results/steps/status/reports) must be rendered
        // from the structured data the tool/system returned — never from the model's
        // free prose. Text-to-structure parsing is allowed only as a labeled fallback.
        const rule = HARD_PROHIBITIONS
          .split('\n')
          .find(l => l.includes('NEVER render user-facing display text'));
        expect(rule).toBeTruthy();
        expect(rule).toMatch(/STRUCTURED data/);
        expect(rule).toMatch(/tool_use\/tool_result/);
        expect(rule).toMatch(/labeled fallback/);
  });

  test('EXECUTION_DISCIPLINE is an ordered plan→minimal→verify→refine loop', () => {
        for (const step of [
          '1. Plan first',
          '2. Execute the minimal slice',
          '3. Verify with evidence',
          '4. Refine only then',
        ]) {
          expect(EXECUTION_DISCIPLINE.includes(step)).toBeTruthy();
        }
  });

  test('general-purpose agent injects the loop before the prohibitions', () => {
        const prompt = GENERAL_PURPOSE_AGENT.getSystemPrompt();
        expect(prompt.includes(EXECUTION_DISCIPLINE)).toBeTruthy();
        expect(prompt.includes(HARD_PROHIBITIONS)).toBeTruthy();
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
        expect(EXPLORE_AGENT.getSystemPrompt()).toBe(exploreBlock);
        expect(PLAN_AGENT.getSystemPrompt()).toBe(planBlock);
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
