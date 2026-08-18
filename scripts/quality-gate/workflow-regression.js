#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEST_ROOT = path.join(REPO_ROOT, 'scripts', 'tests');
const WORKFLOW_TESTS = Object.freeze([
  'agentRestorePlan.test.js',
  'restoreAutonomyGate.test.js',
  'restoreConflictDetector.test.js',
  'restoreConflictResolver.test.js',
  'restoreConvergenceVerifier.test.js',
  'restoreNavigator.test.js',
  'restoreReadiness.test.js',
  'restoreRecoursePlan.test.js',
]);

function resolveTests() {
  return WORKFLOW_TESTS.map((name) => {
    const file = path.join(TEST_ROOT, name);
    if (!fs.existsSync(file)) throw new Error(`workflow regression test is missing: ${name}`);
    return file;
  });
}

function run(spawn = spawnSync) {
  let files;
  try {
    files = resolveTests();
  } catch (error) {
    process.stderr.write(`[workflow-regression] action=fail target=manifest error=${error.message}\n`);
    return 1;
  }
  process.stdout.write(`[workflow-regression] action=start target=agent-workflows count=${files.length}\n`);
  const result = spawn(process.execPath, ['--test', ...files], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  const code = result.error ? 1 : result.status ?? 1;
  process.stdout.write(`[workflow-regression] action=${code === 0 ? 'pass' : 'fail'} target=agent-workflows code=${code}\n`);
  return code;
}

if (require.main === module) process.exitCode = run();

module.exports = { WORKFLOW_TESTS, resolveTests, run };
