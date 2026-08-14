'use strict';

/**
 * agentLauncherRegistry — SSOT for `khy <agent>` backend launchers (node:test).
 *
 * Goal (「khy 不只能 khy claude,也要 khy opencode/codex/…」):
 *   Make the launchable agent-backend set a declarative registry that cannot
 *   drift from the gateway's real adapters, the router dispatch, the command
 *   schema, or the auth family. Adding a backend must stay a one-line entry.
 *
 * Guard invariants (locked against LIVE sources — not fixtures):
 *   ① every launcher.adapterKey is a registered gateway adapter key
 *   ② every launcher.command is in commandSchema ROUTER_COMMANDS
 *   ③ every launcher.command has a `case '<cmd>':` in the router dispatch
 *   ④ every launcher.command is in featureKeyBuilder IDE_FAMILY_KEYS
 *      (so `<cmd>.launch` resolves login-free, same as claude)
 *   ⑤ opencode is present as a 'direct' launcher (the concrete ask)
 * Plus synthetic checks: gate off → legacy 5, determinism, fail-soft.
 *
 * node:test (jest via rtk proxy reports Exec format error and is unavailable).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const reg = require('../../src/services/agentLauncherRegistry');
const { getRouterCommandNames } = require('../../src/constants/commandSchema');
const { IDE_FAMILY_KEYS } = require('../../src/services/featureKeyBuilder');
const ROUTER_COMMANDS = getRouterCommandNames();

const BACKEND_ROOT = path.resolve(__dirname, '../../');

// ── LIVE source parsing (no require of heavy gateway/router) ──────────────

/** Extract registered adapter keys from aiGateway's `this._adapters = [...]`. */
function liveGatewayAdapterKeys() {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/services/gateway/aiGateway.js'), 'utf8');
  const start = src.indexOf('this._adapters = [');
  assert.ok(start > -1, 'aiGateway _adapters array not found (parser drift)');
  const block = src.slice(start, src.indexOf('];', start));
  const keys = new Set();
  const re = /\bkey:\s*'([a-z0-9_]+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) keys.add(m[1]);
  assert.ok(keys.size >= 10, `expected many gateway adapters, got ${keys.size}`);
  return keys;
}

/** Extract `case '<cmd>':` names from the launcher dispatch block in router.js. */
function liveRouterLauncherCases() {
  const src = fs.readFileSync(
    path.join(BACKEND_ROOT, 'src/cli/router.js'), 'utf8');
  const anchor = src.indexOf('Agent-backend launchers');
  assert.ok(anchor > -1, 'router launcher dispatch block not found (parser drift)');
  // Grab from the anchor to the handleIdeCommand invocation that closes it.
  const block = src.slice(anchor, src.indexOf('handleIdeCommand(command', anchor));
  const cases = new Set();
  const re = /case\s+'([a-z0-9_]+)'\s*:/g;
  let m;
  while ((m = re.exec(block)) !== null) cases.add(m[1]);
  return cases;
}

// ── ① adapterKey ∈ live gateway adapters ──────────────────────────────────
test('every launcher.adapterKey is a registered gateway adapter', () => {
  const gatewayKeys = liveGatewayAdapterKeys();
  for (const l of reg.AGENT_LAUNCHERS) {
    assert.ok(
      gatewayKeys.has(l.adapterKey),
      `launcher '${l.command}' adapterKey '${l.adapterKey}' not registered in gateway`);
  }
});

// ── ② command ∈ ROUTER_COMMANDS ───────────────────────────────────────────
test('every launcher.command is in commandSchema ROUTER_COMMANDS', () => {
  const cmds = new Set(ROUTER_COMMANDS);
  for (const l of reg.AGENT_LAUNCHERS) {
    assert.ok(cmds.has(l.command),
      `launcher '${l.command}' missing from ROUTER_COMMANDS`);
  }
});

// ── ③ command has a router dispatch case ──────────────────────────────────
test('every launcher.command has a router dispatch case', () => {
  const cases = liveRouterLauncherCases();
  for (const l of reg.AGENT_LAUNCHERS) {
    assert.ok(cases.has(l.command),
      `launcher '${l.command}' has no case in router launcher block`);
  }
});

// ── ④ command ∈ IDE_FAMILY_KEYS (login parity) ────────────────────────────
test('every launcher.command is an IDE_FAMILY_KEY (login-free launch)', () => {
  const fam = new Set(IDE_FAMILY_KEYS);
  for (const l of reg.AGENT_LAUNCHERS) {
    assert.ok(fam.has(l.command),
      `launcher '${l.command}' missing from IDE_FAMILY_KEYS → would require login`);
  }
});

// ── ⑤ opencode is a direct launcher (the concrete ask) ────────────────────
test('opencode is present as a direct launcher', () => {
  const oc = reg.AGENT_LAUNCHERS.find(l => l.command === 'opencode');
  assert.ok(oc, 'opencode launcher missing');
  assert.strictEqual(oc.kind, 'direct');
  assert.strictEqual(oc.legacy, false);
  assert.ok(reg.isDirectLauncher('opencode'));
});

// ── model-select adapters must expose listModels(); direct ones need not ──
test('model-select adapters expose listModels; direct adapters do not require it', () => {
  for (const l of reg.AGENT_LAUNCHERS) {
    let adapterSrc = '';
    try {
      adapterSrc = fs.readFileSync(
        path.join(BACKEND_ROOT, `src/services/gateway/adapters/${l.adapterKey}Adapter.js`), 'utf8');
    } catch { /* adapter filename may differ; skip file check for that entry */ }
    if (!adapterSrc) continue;
    const hasListModels = /\blistModels\b/.test(adapterSrc);
    if (l.kind === 'model-select') {
      assert.ok(hasListModels,
        `model-select launcher '${l.command}' adapter lacks listModels()`);
    }
    // 'direct' launchers make no claim either way — opencode has none by design.
  }
});

// ── gate off → only the legacy five (byte-revert) ─────────────────────────
test('gate off returns only the legacy five launchers', () => {
  const off = reg.getLauncherCommands({ KHY_AGENT_LAUNCHERS: 'off' });
  assert.deepStrictEqual([...off].sort(), ['claude', 'codex', 'cursor', 'kiro', 'trae'].sort());
  // registry-added backends are gone
  assert.strictEqual(reg.resolveAgentLauncher('opencode', { KHY_AGENT_LAUNCHERS: 'off' }), null);
  assert.strictEqual(reg.isAgentLauncherCommand('warp', { KHY_AGENT_LAUNCHERS: '0' }), false);
  // legacy still resolve when off
  assert.ok(reg.resolveAgentLauncher('claude', { KHY_AGENT_LAUNCHERS: 'false' }));
});

// ── gate on (default) exposes the full set incl. opencode ─────────────────
test('gate on (default) exposes the full launcher set', () => {
  const on = reg.getLauncherCommands({});
  for (const c of ['claude', 'codex', 'cursor', 'kiro', 'trae', 'opencode', 'warp', 'vscode', 'windsurf']) {
    assert.ok(on.includes(c), `expected '${c}' in default launcher set`);
  }
});

// ── resolution is case-insensitive and fail-soft ──────────────────────────
test('resolveAgentLauncher is case-insensitive and never throws', () => {
  assert.ok(reg.resolveAgentLauncher('OpenCode', {}));
  assert.ok(reg.resolveAgentLauncher('  CLAUDE  ', {}));
  assert.strictEqual(reg.resolveAgentLauncher('', {}), null);
  assert.strictEqual(reg.resolveAgentLauncher(null), null);
  assert.strictEqual(reg.resolveAgentLauncher(undefined), null);
  assert.strictEqual(reg.resolveAgentLauncher('nonexistent-agent', {}), null);
});

// ── determinism: same env → identical command list ────────────────────────
test('getLauncherCommands is deterministic for a given env', () => {
  const a = reg.getLauncherCommands({});
  const b = reg.getLauncherCommands({});
  assert.deepStrictEqual(a, b);
});
