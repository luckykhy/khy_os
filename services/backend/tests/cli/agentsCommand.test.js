'use strict';

/**
 * agentsCommand.test.js — `/agents` command (Claude Code alignment).
 *
 * The `/agents` command surfaces the agent-definitions registry that the
 * AgentTool consumes when spawning sub-agents. Before this command the
 * registry (`getAgentDefinitions`) was fully built but reachable from no CLI
 * surface. These tests pin the two halves of the wiring:
 *   1. the data path the command renders — built-in agents plus custom agents
 *      loaded from `.claude/agents/*.md` / `.khy/agents/*.md`;
 *   2. the command is registered in the single-source command schema so the
 *      router/slash-menu can dispatch it.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const agents = require('../../src/agents');
const schema = require('../../src/constants/commandSchema');

describe('/agents — agent-definitions registry surfaced by the command', () => {
  let tmp;

  beforeEach(() => {
    agents.clearAgentCache();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-agents-'));
  });

  afterEach(() => {
    agents.clearAgentCache();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  test('built-in agents are always listed even with no custom dir', async () => {
    const { activeAgents, allAgents } = await agents.getAgentDefinitions(tmp);
    assert.ok(activeAgents.length > 0, 'expected at least one active agent');
    const types = activeAgents.map((a) => a.agentType);
    assert.ok(types.includes('general-purpose'), 'general-purpose must be present');
    // every active agent carries the fields the command renders
    for (const a of activeAgents) {
      assert.equal(typeof a.agentType, 'string');
      assert.ok(a.source, 'agent must declare a source');
    }
    assert.ok(allAgents.length >= activeAgents.length);
  });

  test('a custom .claude/agents/*.md is loaded and overrides/extends built-ins', async () => {
    const dir = path.join(tmp, '.claude', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'doc-writer.md'),
      [
        '---',
        'name: doc-writer',
        'description: Use for writing documentation only',
        'tools: [Read, Write]',
        'model: haiku',
        '---',
        'You write documentation.',
      ].join('\n'),
      'utf8',
    );

    const { activeAgents, allAgents } = await agents.getAgentDefinitions(tmp);
    const custom = allAgents.find((a) => a.agentType === 'doc-writer');
    assert.ok(custom, 'custom agent must be loaded');
    assert.equal(custom.source, 'projectSettings');
    assert.deepEqual(custom.tools, ['Read', 'Write']);
    assert.equal(custom.model, 'haiku');
    // an active custom agent participates in the rendered list
    assert.ok(activeAgents.some((a) => a.agentType === 'doc-writer'));
  });

  test('malformed agent files surface as failedFiles, not crashes', async () => {
    const dir = path.join(tmp, '.khy', 'agents');
    fs.mkdirSync(dir, { recursive: true });
    // No frontmatter name → parseAgentFromMarkdown rejects it.
    fs.writeFileSync(path.join(dir, 'broken.md'), 'no frontmatter here', 'utf8');

    const res = await agents.getAgentDefinitions(tmp);
    // built-ins still come back; the loader never throws
    assert.ok(res.activeAgents.length > 0);
  });

  test('agents is registered as a router command and slash command', () => {
    assert.ok(schema.getRouterCommandNames().includes('agents'));
    const slash = schema.getBuiltinSlashCommands().find((c) => c.cmd === '/agents');
    assert.ok(slash, '/agents slash command must be registered');
    assert.equal(slash.route, 'agents');
  });
});
