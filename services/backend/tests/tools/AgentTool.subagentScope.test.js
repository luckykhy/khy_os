'use strict';

/**
 * AgentTool.subagentScope.test.js — the "thinking stays with the main agent"
 * scope rule.
 *
 * A spawned sub-agent's system prompt must carry SUBAGENT_EXECUTION_SCOPE
 * (constraints.js, single source) prepended to its own role prompt, so every
 * sub-agent — whatever its role/type — is reminded it is an executor, not the
 * strategist. buildSubagentSystemPrompt is the single injection seam.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { AgentTool } = require('../../src/tools/AgentTool');
const { SUBAGENT_EXECUTION_SCOPE } = require('../../src/agents/constraints');

describe('SUBAGENT_EXECUTION_SCOPE constraint', () => {
  test('is a non-empty exported block with the layered-thinking semantics', () => {
    assert.equal(typeof SUBAGENT_EXECUTION_SCOPE, 'string');
    assert.ok(SUBAGENT_EXECUTION_SCOPE.length > 0);
    // Executor, not strategist.
    assert.match(SUBAGENT_EXECUTION_SCOPE, /executor/i);
    assert.match(SUBAGENT_EXECUTION_SCOPE, /MAIN agent owns the thinking/i);
    // May locally decompose, but bounded by the nesting limit.
    assert.match(SUBAGENT_EXECUTION_SCOPE, /your assigned chunk|YOUR assigned chunk/);
    assert.match(SUBAGENT_EXECUTION_SCOPE, /nesting limit|depth ceiling/i);
    // Independent context.
    assert.match(SUBAGENT_EXECUTION_SCOPE, /isolated context|cannot see the parent/i);
  });
});

describe('AgentTool.buildSubagentSystemPrompt', () => {
  test('prepends the scope rule to the role prompt', () => {
    const role = 'You are a codebase exploration agent. Do NOT modify files.';
    const sp = AgentTool.buildSubagentSystemPrompt(role);
    assert.ok(sp.includes(SUBAGENT_EXECUTION_SCOPE), 'must carry the scope rule');
    assert.ok(sp.includes(role), 'must preserve the role prompt');
    // Scope comes first so the executor framing is read before the role detail.
    assert.ok(sp.indexOf(SUBAGENT_EXECUTION_SCOPE) < sp.indexOf(role));
  });

  test('tolerates a non-string role prompt without throwing', () => {
    const sp = AgentTool.buildSubagentSystemPrompt(undefined);
    assert.ok(sp.includes(SUBAGENT_EXECUTION_SCOPE));
  });
});
