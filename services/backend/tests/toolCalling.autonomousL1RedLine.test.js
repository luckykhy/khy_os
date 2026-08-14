/**
 * Fix E2 — autonomous / non-interactive L1 auto-approve (red line intact).
 *
 * In a headless `khy -p` run there is no control channel (onCtrl missing), so
 * the approval router historically fail-closed EVERY L1 (yellow) tool, meaning
 * khy could not run node/sleep/timeout/npm test/git add. E2 auto-approves L1 in
 * that autonomous context — but ONLY when the step is NOT an unbypassable gate.
 *
 * The safety property E2 rests on is `riskGate.assess()` + `isUnbypassableGate()`:
 * destructive / critical commands must STAY unbypassable (reach a human) while
 * safe / low commands (echo/node/sleep/timeout) must be bypassable. This test
 * pins that red line deterministically, independent of the heavy evaluate path.
 */
'use strict';

const assert = require('assert');
const riskGate = require('../src/services/riskGate');

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

// The autonomous-L1 predicate as wired in toolCalling.js: auto-approve only
// when the assessed step is NOT an unbypassable gate.
function autonomousL1Approvable(toolName, params) {
  const a = riskGate.assess(toolName, params);
  return !riskGate.isUnbypassableGate(a);
}

const results = [];

results.push(run('safe headless commands are approvable (echo/node/sleep/timeout/printf)', () => {
  for (const command of [
    'echo hello-khy',
    'node -e "console.log(1)"',
    'sleep 1',
    'timeout 5 echo hi',
    'printf "%s" ok',
  ]) {
    assert.strictEqual(
      autonomousL1Approvable('Bash', { command }),
      true,
      `expected "${command}" to be auto-approvable in headless`,
    );
  }
}));

results.push(run('RED LINE: destructive commands remain UNBYPASSABLE', () => {
  for (const command of [
    'rm -rf /',
    'rm -rf ~/data',
    'git reset --hard origin/main',
  ]) {
    const a = riskGate.assess('Bash', { command });
    assert.strictEqual(
      riskGate.isUnbypassableGate(a),
      true,
      `expected "${command}" to be unbypassable (red line), got ${JSON.stringify(a)}`,
    );
    assert.strictEqual(autonomousL1Approvable('Bash', { command }), false);
  }
}));

results.push(run('camelCase shellCommand routes to the SAME dynamic classifier (Fix E1 synergy)', () => {
  const saved = process.env.KHY_SHELL_TOOL_RISK_MATCH;
  delete process.env.KHY_SHELL_TOOL_RISK_MATCH; // default ON
  try {
    assert.strictEqual(autonomousL1Approvable('shellCommand', { command: 'echo hi' }), true);
    const destructive = riskGate.assess('shellCommand', { command: 'rm -rf /' });
    assert.strictEqual(riskGate.isUnbypassableGate(destructive), true);
  } finally {
    if (saved === undefined) delete process.env.KHY_SHELL_TOOL_RISK_MATCH;
    else process.env.KHY_SHELL_TOOL_RISK_MATCH = saved;
  }
}));

results.push(run('isUnbypassableGate: non-human-gate steps are never unbypassable', () => {
  assert.strictEqual(riskGate.isUnbypassableGate({ stepType: 'hardened', riskLevel: 'safe' }), false);
  assert.strictEqual(riskGate.isUnbypassableGate({ stepType: 'flexible', riskLevel: 'medium' }), false);
  assert.strictEqual(riskGate.isUnbypassableGate(null), false);
}));

results.push(run('isUnbypassableGate: human-gate + critical OR destructive → unbypassable', () => {
  assert.strictEqual(riskGate.isUnbypassableGate({ stepType: 'human-gate', riskLevel: 'critical' }), true);
  assert.strictEqual(riskGate.isUnbypassableGate({ stepType: 'human-gate', isDestructive: true }), true);
  // human-gate but merely high & reversible → bypassable (autonomous mode keeps working)
  assert.strictEqual(riskGate.isUnbypassableGate({ stepType: 'human-gate', riskLevel: 'high' }), false);
}));

const failed = results.filter((r) => !r).length;
console.log(`\ntoolCalling.autonomousL1RedLine: ${results.length - failed}/${results.length} passed`);
if (failed > 0) process.exit(1);
