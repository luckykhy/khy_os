#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(__dirname, 'c8.config.json');

const DEFAULT_THRESHOLDS = Object.freeze({ unit: 60, integration: 70 });

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function parseThreshold(env = process.env) {
  if (!Object.hasOwn(env, 'KHY_COVERAGE_THRESHOLD')) return null;
  const raw = String(env.KHY_COVERAGE_THRESHOLD).trim();
  if (!raw) throw new Error('KHY_COVERAGE_THRESHOLD must be a number from 0 to 100');
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error('KHY_COVERAGE_THRESHOLD must be a number from 0 to 100');
  }
  return value;
}

const TEST_SCOPES = Object.freeze({
  unit: [
    'tests/apiAdapter.keyOverride.test.js',
    'tests/apiAdapter.poolMarkWiring.test.js',
    'tests/gateway/clipboardRelayAdapter.detect.test.js',
    'tests/gateway/traeAdapter.strictAvailability.test.js',
    'tests/gateway/warpAdapter.strictAvailability.test.js',
    'tests/services/codexAdapter.fileOps.test.js',
    'tests/windsurfAdapter.tokenFallback.test.js',
  ],
  integration: ['tests/**/*.integration.test.js'],
});

function parseScope(argv = process.argv) {
  const raw = argv.find((arg) => arg.startsWith('--scope='));
  const scope = raw ? raw.slice('--scope='.length) : 'unit';
  if (!Object.hasOwn(TEST_SCOPES, scope)) {
    throw new Error(`invalid coverage scope "${scope}"; expected unit or integration`);
  }
  return scope;
}

function buildInvocation(env = process.env, argv = process.argv) {
  const scope = parseScope(argv);
  const threshold = parseThreshold(env) ?? DEFAULT_THRESHOLDS[scope];
  const c8Bin = require.resolve('c8/bin/c8.js', { paths: [REPO_ROOT] });
  const reportDir = path.join(REPO_ROOT, '.cache', 'quality-gate', `coverage-${scope}`);
  const tempDir = path.join(REPO_ROOT, '.cache', 'quality-gate', `v8-${scope}`);
  const args = [
    c8Bin, '--config', CONFIG_PATH,
    '--reports-dir', reportDir,
    '--temp-directory', tempDir,
  ];
  for (const metric of ['lines', 'functions', 'branches', 'statements']) {
    args.push(`--${metric}`, String(threshold));
  }
  args.push(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    'exec', '--workspace', 'services/backend', '--', 'jest',
    '--runInBand', '--config', 'jest.config.js', ...TEST_SCOPES[scope]
  );
  return { command: process.execPath, args, threshold, scope };
}

function run(env = process.env, spawn = spawnSync, argv = process.argv) {
  let invocation;
  try {
    invocation = buildInvocation(env, argv);
  } catch (error) {
    process.stderr.write(`[coverage] ${error.message}\n`);
    return 2;
  }
  const config = readConfig();
  const effective = invocation.threshold ?? config.lines;
  process.stdout.write(`[coverage] action=start scope=${invocation.scope} target=services/backend/src threshold=${effective}%\n`);
  const result = spawn(invocation.command, invocation.args, {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(`[coverage] action=fail target=services/backend/src error=${result.error.message}\n`);
    return 1;
  }
  const code = result.status ?? 1;
  process.stdout.write(`[coverage] action=${code === 0 ? 'pass' : 'fail'} scope=${invocation.scope} target=services/backend/src code=${code}\n`);
  return code;
}

if (require.main === module) process.exitCode = run();

module.exports = {
  CONFIG_PATH,
  TEST_SCOPES,
  readConfig,
  parseThreshold,
  parseScope,
  buildInvocation,
  run,
};
