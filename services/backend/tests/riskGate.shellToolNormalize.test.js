/**
 * Fix E1 — riskGate shell-tool name normalization.
 *
 * The camelCase tool name `shellCommand` was NOT in the snake_case-only
 * SHELL_TOOL_NAMES set, so isShellTool('shellCommand') was FALSE. Shell calls
 * then fell through to the STATIC path and inherited the tool's worst-case
 * static risk:'critical' → L2 red → non-interactive fail-closed EVERY command.
 *
 * Fix: separator-insensitive matching routes shellCommand/shell-command to the
 * DYNAMIC classifyCommandRisk (echo→safe, rm -rf→critical). This tightens
 * precision without weakening the red line. Gate off → byte-revert (snake_case
 * only). Gate: KHY_SHELL_TOOL_RISK_MATCH (local, default-on).
 */
'use strict';

const assert = require('assert');
const riskGate = require('../src/services/riskGate');
const { isShellTool, _shellToolRiskMatchEnabled } = riskGate;

function run(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
    return true;
  } catch (err) {
    console.error(`  FAIL - ${name}\n        ${err && err.message}`);
    return false;
  }
}

const results = [];

results.push(run('_shellToolRiskMatchEnabled defaults ON / OFF for 0-false-off-no', () => {
  assert.strictEqual(_shellToolRiskMatchEnabled({}), true);
  assert.strictEqual(_shellToolRiskMatchEnabled({ KHY_SHELL_TOOL_RISK_MATCH: 'off' }), false);
  assert.strictEqual(_shellToolRiskMatchEnabled({ KHY_SHELL_TOOL_RISK_MATCH: '0' }), false);
}));

results.push(run('snake_case shell names always match (unchanged)', () => {
  for (const n of ['bash', 'shell', 'shell_command', 'powershell', 'cmd', 'run_command', 'execute_code']) {
    assert.strictEqual(isShellTool(n), true, `expected ${n} to be a shell tool`);
  }
}));

results.push(run('case-insensitive on the canonical set', () => {
  assert.strictEqual(isShellTool('Bash'), true);
  assert.strictEqual(isShellTool('PowerShell'), true);
  assert.strictEqual(isShellTool('SHELL_COMMAND'), true);
}));

results.push(run('gate ON: camelCase / kebab variants now match (the bug fix)', () => {
  const saved = process.env.KHY_SHELL_TOOL_RISK_MATCH;
  delete process.env.KHY_SHELL_TOOL_RISK_MATCH; // default ON
  try {
    assert.strictEqual(isShellTool('shellCommand'), true, 'shellCommand must route to dynamic shell classifier');
    assert.strictEqual(isShellTool('shell-command'), true);
    assert.strictEqual(isShellTool('runCommand'), true);
    assert.strictEqual(isShellTool('executeCode'), true);
  } finally {
    if (saved === undefined) delete process.env.KHY_SHELL_TOOL_RISK_MATCH;
    else process.env.KHY_SHELL_TOOL_RISK_MATCH = saved;
  }
}));

results.push(run('gate OFF: byte-revert — camelCase falls back to NOT-a-shell-tool', () => {
  const saved = process.env.KHY_SHELL_TOOL_RISK_MATCH;
  process.env.KHY_SHELL_TOOL_RISK_MATCH = 'off';
  try {
    assert.strictEqual(isShellTool('shellCommand'), false, 'gate off must reproduce the historical miss');
    // snake_case still matches even with gate off (direct set hit)
    assert.strictEqual(isShellTool('shell_command'), true);
  } finally {
    if (saved === undefined) delete process.env.KHY_SHELL_TOOL_RISK_MATCH;
    else process.env.KHY_SHELL_TOOL_RISK_MATCH = saved;
  }
}));

results.push(run('non-shell tools never match (no over-broadening)', () => {
  for (const n of ['Read', 'Write', 'Edit', 'webFetch', 'recognizeImage', '', null, undefined]) {
    assert.strictEqual(isShellTool(n), false, `expected ${n} NOT to be a shell tool`);
  }
}));

const failed = results.filter((r) => !r).length;
console.log(`\nriskGate.shellToolNormalize: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
