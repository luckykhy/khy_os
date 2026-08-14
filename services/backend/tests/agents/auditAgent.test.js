'use strict';

/**
 * auditAgent.test.js (node:test)
 *
 * Goal「教 Khy 专门有个审计智能体，专门挑刺找问题」. The audit agent is a
 * READ-ONLY adversarial critic — sibling to the verification agent but it picks
 * the work apart by inspection (bugs/security/edge-cases/smells, severity-ranked
 * with evidence) instead of running builds. These tests pin the contract:
 *   - the agent definition is read-only and adversarial,
 *   - it is registered in the built-in registry behind enableAudit,
 *   - the spawn tool (AgentTool) exposes 'audit' as a type / sub-task role,
 *   - role aliasing + proactive role inference route fault-finding to 'audit'.
 * Pure (no spawning, no model calls) — fully unit-testable.
 */

const test = require('node:test');
const assert = require('node:assert');

const { AUDIT_AGENT, AUDIT_SYSTEM_PROMPT } = require('../../src/agents/built-in/auditAgent');
const { getBuiltInAgents, formatAgentLine } = require('../../src/agents/builtInAgents');
const claudeCompat = require('../../src/services/claudeCompat');
const agentTool = require('../../src/tools/AgentTool');
const { inferRole } = require('../../src/services/proactiveCollaboration/delegationPlanner');

// ── agent definition shape ──────────────────────────────────────────────────

test('AUDIT_AGENT is a read-only adversarial critic definition', () => {
  assert.strictEqual(AUDIT_AGENT.agentType, 'audit');
  assert.strictEqual(AUDIT_AGENT.source, 'built-in');
  assert.strictEqual(AUDIT_AGENT.model, 'inherit'); // needs reasoning to find subtle bugs
  // Read-only: the mutating + spawn tools are denied.
  for (const denied of ['Edit', 'Write', 'NotebookEdit', 'Agent', 'ExitPlanMode']) {
    assert.ok(AUDIT_AGENT.disallowedTools.includes(denied), `expected ${denied} denied`);
  }
  // It does NOT deny Bash — read-only repo inspection (git diff/log) is allowed.
  assert.ok(!AUDIT_AGENT.disallowedTools.includes('Bash'));
});

test('the audit system prompt is adversarial and read-only, with a parseable verdict', () => {
  const p = AUDIT_AGENT.getSystemPrompt();
  assert.strictEqual(p, AUDIT_SYSTEM_PROMPT);
  assert.ok(typeof p === 'string' && p.length > 200);
  // Adversarial framing: find problems, do not approve.
  assert.match(p, /find what is wrong|find.*problem/i);
  // Guards against both failure modes.
  assert.match(p, /[Rr]ubber-stamp/);
  assert.match(p, /false positive/i);
  // Read-only contract.
  assert.match(p, /READ-ONLY|read-only/);
  // Severity-ranked, evidence-bearing findings + parseable summary line.
  assert.match(p, /CRITICAL/);
  assert.match(p, /AUDIT: <n> findings/);
});

test('AUDIT_AGENT carries the read-only critical reminder', () => {
  assert.match(AUDIT_AGENT.criticalSystemReminder_EXPERIMENTAL || '', /READ-ONLY AUDIT/i);
  assert.match(AUDIT_AGENT.criticalSystemReminder_EXPERIMENTAL || '', /AUDIT: <n> findings|AUDIT:/);
});

// ── registry registration (enableAudit gate) ──────────────────────────────────

test('audit agent is registered by default and removable via enableAudit:false', () => {
  const withAudit = getBuiltInAgents().find(a => a.agentType === 'audit');
  assert.ok(withAudit, 'audit present by default');
  assert.strictEqual(withAudit, AUDIT_AGENT);

  const without = getBuiltInAgents({ enableAudit: false }).find(a => a.agentType === 'audit');
  assert.strictEqual(without, undefined, 'audit absent when gate is off');
});

test('formatAgentLine renders the audit agent as an all-tools-except line', () => {
  const line = formatAgentLine(AUDIT_AGENT);
  assert.match(line, /^- audit:/);
  assert.match(line, /All tools except .*Edit/);
});

// ── AgentTool spawn surface ───────────────────────────────────────────────────

test('AgentTool exposes audit as a subagent_type and a sub-task role', () => {
  const schema = agentTool.inputSchema;
  const typeEnum = schema.properties.subagent_type.enum;
  assert.ok(typeEnum.includes('audit'));
  assert.ok(typeEnum.includes('Audit'));
  const roleEnum = schema.properties.subtasks.items.properties.role.enum;
  assert.ok(roleEnum.includes('audit'));
});

test('AgentTool prompt() documents the audit type as a read-only critic', () => {
  const prompt = agentTool.prompt();
  assert.match(prompt, /"audit"/);
  assert.match(prompt, /audit[\s\S]*nitpick|nitpick[\s\S]*audit/i);
});

// ── role aliasing + proactive role inference ──────────────────────────────────

test('normalizeAgentRole maps audit/auditor/critic to the audit role', () => {
  for (const alias of ['audit', 'Audit', 'auditor', 'critic', 'AUDITOR']) {
    assert.strictEqual(claudeCompat.normalizeAgentRole(alias), 'audit', `alias ${alias}`);
  }
});

test('proactive inferRole routes fault-finding intent to audit, not implement/planner/verify', () => {
  assert.strictEqual(inferRole('挑刺找问题'), 'audit');
  assert.strictEqual(inferRole('审计这个模块'), 'audit');
  assert.strictEqual(inferRole('find bugs in the parser'), 'audit');
  assert.strictEqual(inferRole('code review the diff'), 'audit');
  // The narrow audit bucket must NOT steal neighbouring intents.
  assert.strictEqual(inferRole('实现登录功能'), 'implement');
  assert.strictEqual(inferRole('分析架构设计'), 'planner');
  assert.strictEqual(inferRole('跑测试验证一下'), 'verify');
});
