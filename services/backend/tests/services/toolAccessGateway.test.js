'use strict';

// Claude Code SDK alignment: --allowedTools / --disallowedTools gateway.
// Verifies the shared leaf, the native getToolDefinitions()/executeTool()
// enforcement (via toolCalling), and the external Claude Code arg propagation.

const test = require('node:test');
const assert = require('node:assert');

const gw = require('../../src/services/toolAccessGateway');
const tc = require('../../src/services/toolCalling');

test.afterEach(() => gw.clearToolAccessGateway());

// ── Leaf: filterToolDefs / gatewayDecision ──────────────────────────────────

test('leaf: inactive gate is a no-op', () => {
  gw.clearToolAccessGateway();
  assert.strictEqual(gw.isGatewayActive(), false);
  const defs = [{ name: 'Read' }, { name: 'Write' }];
  assert.strictEqual(gw.filterToolDefs(defs), defs);
  assert.strictEqual(gw.gatewayDecision('Write'), null);
});

test('leaf: allowlist keeps only listed (case/underscore-insensitive)', () => {
  gw.setToolAccessGateway({ allowed: ['read', 'web_fetch'] });
  const defs = [{ name: 'Read' }, { name: 'Write' }, { name: 'WebFetch' }];
  assert.deepStrictEqual(gw.filterToolDefs(defs).map((d) => d.name), ['Read', 'WebFetch']);
  assert.match(gw.gatewayDecision('Write'), /--allowedTools/);
  assert.strictEqual(gw.gatewayDecision('Read'), null);
});

test('leaf: denylist removes; deny wins over allow', () => {
  gw.setToolAccessGateway({ allowed: ['Read', 'Write'], disallowed: ['Write'] });
  const defs = [{ name: 'Read' }, { name: 'Write' }];
  assert.deepStrictEqual(gw.filterToolDefs(defs).map((d) => d.name), ['Read']);
  assert.match(gw.gatewayDecision('Write'), /--disallowedTools/);
});

// ── Leaf: external Claude Code arg propagation ──────────────────────────────

const DEFAULT_ALLOW = ['Bash', 'Read', 'Write', 'Edit'];

test('buildClaudeAllowDenyArgs: inactive → default allow pair', () => {
  gw.clearToolAccessGateway();
  assert.deepStrictEqual(gw.buildClaudeAllowDenyArgs(DEFAULT_ALLOW), ['--allowedTools', 'Bash,Read,Write,Edit']);
});

test('buildClaudeAllowDenyArgs: allowlist → exactly the user names', () => {
  gw.setToolAccessGateway({ allowed: ['Read', 'Grep'] });
  assert.deepStrictEqual(gw.buildClaudeAllowDenyArgs(DEFAULT_ALLOW), ['--allowedTools', 'Read,Grep']);
});

test('buildClaudeAllowDenyArgs: denylist prunes default allow AND emits --disallowedTools', () => {
  gw.setToolAccessGateway({ disallowed: ['Write', 'Edit'] });
  const args = gw.buildClaudeAllowDenyArgs(DEFAULT_ALLOW);
  assert.deepStrictEqual(args, ['--allowedTools', 'Bash,Read', '--disallowedTools', 'Write,Edit']);
});

test('buildClaudeAllowDenyArgs: deny wins inside an allowlist', () => {
  gw.setToolAccessGateway({ allowed: ['Read', 'Write'], disallowed: ['Write'] });
  const args = gw.buildClaudeAllowDenyArgs(DEFAULT_ALLOW);
  assert.deepStrictEqual(args, ['--allowedTools', 'Read', '--disallowedTools', 'Write']);
});

// ── Native path through toolCalling ─────────────────────────────────────────

test('toolCalling: allowlist filters getToolDefinitions', () => {
  const base = tc.getToolDefinitions();
  const sample = base[0].name;
  tc.setToolAccessGateway({ allowed: [sample.toUpperCase()] });
  const gated = tc.getToolDefinitions();
  const norm = (n) => String(n).toLowerCase().replace(/_/g, '');
  assert.ok(gated.every((d) => norm(d.name) === norm(sample)));
  assert.ok(gated.some((d) => d.name === sample));
});

test('toolCalling: executeTool refuses a disallowed tool', async () => {
  const base = tc.getToolDefinitions();
  const victim = base[0].name;
  tc.setToolAccessGateway({ disallowed: [victim] });
  const res = await tc.executeTool(victim, {});
  assert.strictEqual(res.success, false);
  assert.match(res.error, /--disallowedTools/);
});

test('toolCalling: executeTool refuses a tool absent from the allowlist', async () => {
  tc.setToolAccessGateway({ allowed: ['definitely_not_a_real_tool_xyz'] });
  const res = await tc.executeTool('Read', { file_path: '/tmp/nope' });
  assert.strictEqual(res.success, false);
  assert.match(res.error, /--allowedTools/);
});

test('toolCalling: clearToolAccessGateway restores the full list', () => {
  const base = tc.getToolDefinitions();
  tc.setToolAccessGateway({ allowed: [base[0].name] });
  tc.clearToolAccessGateway();
  assert.strictEqual(tc.getToolDefinitions().length, base.length);
});
