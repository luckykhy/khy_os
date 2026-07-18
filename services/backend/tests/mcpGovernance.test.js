'use strict';

/**
 * mcpGovernance.test.js — pure-leaf governance SSOT. Zero IO; all inputs injected.
 */

const test = require('node:test');
const assert = require('node:assert');
const gov = require('../src/services/mcp/mcpGovernance');
const { ConfigScope } = require('../src/services/mcp/types');

test('describeConfigPrecedence: user<legacy ordering; project layers appended when projectDir given', () => {
  const noProj = gov.describeConfigPrecedence({ userPath: '/u/.khy/mcp.json', legacyPath: '/u/.khyquant/mcp.json' });
  assert.strictEqual(noProj.length, 2);
  assert.strictEqual(noProj[0].scope, ConfigScope.USER);
  assert.strictEqual(noProj[0].path, '/u/.khy/mcp.json');
  assert.strictEqual(noProj[0].overrides, null);

  const withProj = gov.describeConfigPrecedence({ userPath: '/u/.khy/mcp.json', projectDir: '/proj' });
  assert.strictEqual(withProj.length, 4);
  // Last entry = highest precedence (read last → overrides earlier).
  assert.strictEqual(withProj[2].scope, ConfigScope.LOCAL);
  assert.strictEqual(withProj[2].path, '/proj/.khy/mcp.json');
  assert.strictEqual(withProj[2].overrides, '用户级');
  // order is monotonic
  assert.deepStrictEqual(withProj.map((r) => r.order), [0, 1, 2, 3]);
});

test('describeConfigPrecedence: projectDir trailing slash does not double-separate', () => {
  const rows = gov.describeConfigPrecedence({ projectDir: '/proj/' });
  assert.strictEqual(rows[2].path, '/proj/.khy/mcp.json');
});

test('classifyServerScope: reads _scope/_disabled/_configPath/type with safe defaults', () => {
  const r = gov.classifyServerScope({ _scope: ConfigScope.LOCAL, _configPath: '/proj/.khy/mcp.json', type: 'http' });
  assert.strictEqual(r.scope, ConfigScope.LOCAL);
  assert.strictEqual(r.scopeLabel, '项目级');
  assert.strictEqual(r.disabled, false);
  assert.strictEqual(r.configPath, '/proj/.khy/mcp.json');
  assert.strictEqual(r.transport, 'http');

  const d = gov.classifyServerScope({ _disabled: true });
  assert.strictEqual(d.disabled, true);
  assert.strictEqual(d.scope, ConfigScope.USER); // default
  assert.strictEqual(d.scopeLabel, '用户级');
  assert.strictEqual(d.transport, 'stdio'); // default

  // fail-soft on garbage
  assert.strictEqual(gov.classifyServerScope(null).scope, ConfigScope.USER);
});

test('resolveApprovalPolicy: destructive → human gate, never auto/plan', () => {
  const r = gov.resolveApprovalPolicy({ isDestructive: true, isReadOnly: true });
  assert.strictEqual(r.humanGate, true);
  assert.strictEqual(r.planModeAllowed, false);
  assert.strictEqual(r.autoApprovable, false);
  assert.strictEqual(r.level, 'destructive');
});

test('resolveApprovalPolicy: read-only → plan allowed, auto-approvable, no human gate', () => {
  const r = gov.resolveApprovalPolicy({ isReadOnly: true });
  assert.strictEqual(r.humanGate, false);
  assert.strictEqual(r.planModeAllowed, true);
  assert.strictEqual(r.autoApprovable, true);
  assert.strictEqual(r.level, 'read-only');
});

test('resolveApprovalPolicy: no annotations → standard (needs approval, not plan-allowed)', () => {
  const r = gov.resolveApprovalPolicy({});
  assert.strictEqual(r.humanGate, false);
  assert.strictEqual(r.planModeAllowed, false);
  assert.strictEqual(r.autoApprovable, false);
  assert.strictEqual(r.level, 'standard');
  // fail-soft
  assert.strictEqual(gov.resolveApprovalPolicy(null).level, 'standard');
});

test('buildGovernanceView: aggregates servers, connection, tool counts, approval distribution', () => {
  const view = gov.buildGovernanceView({
    mcpServers: {
      fs: { _scope: ConfigScope.USER, type: 'stdio' },
      db: { _scope: ConfigScope.LOCAL, type: 'http', _disabled: true },
    },
    connected: ['fs'],
    tools: [
      { serverName: 'fs', isReadOnly: true },
      { serverName: 'fs', isDestructive: true },
      { serverName: 'fs' },
      { serverName: 'db', isReadOnly: true },
    ],
    paths: { userPath: '/u/.khy/mcp.json', projectDir: '/proj' },
  });

  assert.strictEqual(view.counts.configured, 2);
  assert.strictEqual(view.counts.connected, 1);
  assert.strictEqual(view.counts.disabled, 1);
  assert.strictEqual(view.counts.tools, 4);

  assert.deepStrictEqual(view.approval, { destructive: 1, readOnly: 2, standard: 1 });

  const fs = view.servers.find((s) => s.name === 'fs');
  assert.strictEqual(fs.connected, true);
  assert.strictEqual(fs.toolCount, 3);
  assert.strictEqual(fs.scopeLabel, '用户级');

  const db = view.servers.find((s) => s.name === 'db');
  assert.strictEqual(db.connected, false);
  assert.strictEqual(db.disabled, true);
  assert.strictEqual(db.toolCount, 1);

  assert.strictEqual(view.precedence.length, 4);
});

test('buildGovernanceView: empty/garbage input is safe', () => {
  const view = gov.buildGovernanceView();
  assert.deepStrictEqual(view.servers, []);
  assert.deepStrictEqual(view.approval, { destructive: 0, readOnly: 0, standard: 0 });
  assert.strictEqual(view.counts.configured, 0);
  assert.strictEqual(view.counts.tools, 0);
});

test('summarizeGovernance: human-readable lines reflect counts and the precedence rule', () => {
  const lines = gov.summarizeGovernance({
    counts: { configured: 2, connected: 1, disabled: 1, tools: 4 },
    approval: { destructive: 1, readOnly: 2, standard: 1 },
  });
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /配置 2/);
  assert.match(lines[1], /破坏性 1/);
  assert.match(lines[2], /项目级 > 用户级 > legacy/);
  // fail-soft
  assert.strictEqual(gov.summarizeGovernance(null).length, 3);
});
