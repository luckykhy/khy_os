'use strict';

/**
 * Tests for the FIX agent definition and its registration across the two
 * sources of truth (built-in registry + AgentTool role normalization).
 *
 * The fixer is the editing counterpart to the read-only auditor: it must KEEP
 * its editing tools (Edit/Write/Bash) — editing is its whole job — and only drop
 * Agent + ExitPlanMode so it can neither fan out nor re-enter plan mode.
 *
 * Uses node:test (run with `node --test`); jest auto-ignores node:test files.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { FIX_AGENT, FIX_SYSTEM_PROMPT } = require('../src/agents/built-in/fixAgent');
const { getBuiltInAgents } = require('../src/agents/builtInAgents');
const { normalizeAgentRole } = require('../src/services/claudeCompat');

describe('FIX_AGENT definition', () => {
  test('declares the canonical fix agentType and editing posture', () => {
    assert.equal(FIX_AGENT.agentType, 'fix');
    assert.equal(FIX_AGENT.model, 'inherit');
    assert.equal(FIX_AGENT.source, 'built-in');
    assert.equal(typeof FIX_AGENT.getSystemPrompt, 'function');
  });

  test('keeps editing tools — only Agent + ExitPlanMode are denied', () => {
    const denied = FIX_AGENT.disallowedTools || [];
    assert.deepEqual([...denied].sort(), ['Agent', 'ExitPlanMode'].sort());
    // Editing tools must NOT be on the denylist (editing is the job).
    for (const t of ['Edit', 'Write', 'Read', 'Bash', 'Grep']) {
      assert.ok(!denied.includes(t), `${t} must remain available to the fixer`);
    }
  });

  test('system prompt encodes the mandate and both failure modes', () => {
    assert.match(FIX_SYSTEM_PROMPT, /CRITICAL/);
    assert.match(FIX_SYSTEM_PROMPT, /HIGH/);
    assert.match(FIX_SYSTEM_PROMPT, /Scope creep/i);
    assert.match(FIX_SYSTEM_PROMPT, /Rubber-stamp/i);
    assert.match(FIX_SYSTEM_PROMPT, /FIX: <f> fixed, <d> deferred, <n> not-a-defect/);
  });
});

describe('FIX_AGENT registration (two sources of truth)', () => {
  test('is present in the built-in registry by default', () => {
    const types = getBuiltInAgents().map(a => a.agentType);
    assert.ok(types.includes('fix'), 'fix agent should be registered by default');
    // The audit counterpart must also be present (audit→fix pairing).
    assert.ok(types.includes('audit'), 'audit agent should still be registered');
  });

  test('can be disabled via enableFix:false without affecting others', () => {
    const types = getBuiltInAgents({ enableFix: false }).map(a => a.agentType);
    assert.ok(!types.includes('fix'));
    assert.ok(types.includes('audit'));
  });

  test('role aliases normalize to "fix"', () => {
    for (const alias of ['fix', 'Fix', 'fixer', 'repair']) {
      assert.equal(normalizeAgentRole(alias), 'fix', `${alias} → fix`);
    }
  });
});
