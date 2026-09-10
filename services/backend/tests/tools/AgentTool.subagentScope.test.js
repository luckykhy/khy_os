'use strict';
/**
 * AgentTool.subagentScope.test.js â€?the "thinking stays with the main agent"
 * scope rule.
 *
 * A spawned sub-agent's system prompt must carry SUBAGENT_EXECUTION_SCOPE
 * (constraints.js, single source) prepended to its own role prompt, so every
 * sub-agent â€?whatever its role/type â€?is reminded it is an executor, not the
 * strategist. buildSubagentSystemPrompt is the single injection seam.
 */
const { AgentTool } = require('../../src/tools/AgentTool');
const { SUBAGENT_EXECUTION_SCOPE } = require('../../src/agents/constraints');
describe('SUBAGENT_EXECUTION_SCOPE constraint', () => {
});
describe('AgentTool.buildSubagentSystemPrompt', () => {
});

describe('Agent Tool subagent Scope', () => {
  test('is a non-empty exported block with the layered-thinking semantics', () => {
        expect(typeof SUBAGENT_EXECUTION_SCOPE).toBe('string');
        expect(SUBAGENT_EXECUTION_SCOPE.length > 0).toBeTruthy();
        // Executor, not strategist.
        expect(SUBAGENT_EXECUTION_SCOPE).toMatch(/executor/i);
        expect(SUBAGENT_EXECUTION_SCOPE).toMatch(/MAIN agent owns the thinking/i);
        // May locally decompose, but bounded by the nesting limit.
        expect(SUBAGENT_EXECUTION_SCOPE).toMatch(/your assigned chunk|YOUR assigned chunk/);
        expect(SUBAGENT_EXECUTION_SCOPE).toMatch(/nesting limit|depth ceiling/i);
        // Independent context.
        expect(SUBAGENT_EXECUTION_SCOPE).toMatch(/isolated context|cannot see the parent/i);
  });

  test('prepends the scope rule to the role prompt', () => {
        const role = 'You are a codebase exploration agent. Do NOT modify files.';
        const sp = AgentTool.buildSubagentSystemPrompt(role);
        expect(sp.includes(SUBAGENT_EXECUTION_SCOPE)).toBeTruthy();
        expect(sp.includes(role)).toBeTruthy();
        // Scope comes first so the executor framing is read before the role detail.
        expect(sp.indexOf(SUBAGENT_EXECUTION_SCOPE).toBeTruthy() < sp.indexOf(role));
  });

  test('tolerates a non-string role prompt without throwing', () => {
        const sp = AgentTool.buildSubagentSystemPrompt(undefined);
        expect(sp).toContain(SUBAGENT_EXECUTION_SCOPE);
  });

});

