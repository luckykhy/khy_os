'use strict';

const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const STAGES = Object.freeze({
  agentRules: { target: 'agent-rules', script: 'scripts/ci/check-agent-rules.js', args: ['--changed'] },
  providerContract: { target: 'provider-contract', script: 'scripts/quality-gate/provider-contract.js', args: [] },
  workflowRegression: { target: 'workflow-regression', script: 'scripts/quality-gate/workflow-regression.js', args: [] },
  coverage: { target: 'backend-coverage', script: 'scripts/quality-gate/coverage.js', args: [] },
  versionSync: { target: 'version-sync', script: 'scripts/ci/check-version-sync.js', args: [] },
  scriptTests: {
    target: 'script-tests',
    command: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: ['run', 'test:scripts'],
  },
});

const MODE_STAGES = Object.freeze({
  pr: [STAGES.agentRules, STAGES.providerContract, STAGES.workflowRegression, STAGES.coverage],
  release: [STAGES.agentRules, STAGES.providerContract, STAGES.workflowRegression, STAGES.coverage, STAGES.versionSync, STAGES.scriptTests],
});

function parseMode(argv) {
  const args = argv.slice(2);
  const modeIndex = args.indexOf('--mode');
  if (modeIndex === -1 || !args[modeIndex + 1] || args.length !== 2) {
    throw new Error('usage: node scripts/quality-gate/index.js --mode pr|release');
  }
  const mode = args[modeIndex + 1];
  if (!Object.hasOwn(MODE_STAGES, mode)) {
    throw new Error(`invalid mode "${mode}"; expected pr or release`);
  }
  return mode;
}

function selectStages(mode) {
  if (!Object.hasOwn(MODE_STAGES, mode)) throw new Error(`unknown quality-gate mode: ${mode}`);
  return MODE_STAGES[mode].map((stage) => ({ ...stage, args: [...stage.args] }));
}

function resolveStageCommand(stage) {
  if (stage.script) {
    return { command: process.execPath, args: [path.join(REPO_ROOT, stage.script), ...stage.args] };
  }
  return { command: stage.command, args: [...stage.args] };
}

module.exports = { REPO_ROOT, parseMode, selectStages, resolveStageCommand };
