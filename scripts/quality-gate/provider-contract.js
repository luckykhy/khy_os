#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { FIXTURES } = require('./lib/providerContractFixtures');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ADAPTER_DIR = path.join(REPO_ROOT, 'services', 'backend', 'src', 'services', 'gateway', 'adapters');
const CHILD_RUNNER = path.join(__dirname, 'lib', 'providerContractChild.js');
const RESULT_PREFIX = '__KHY_PROVIDER_CONTRACT__=';
const TOKEN_FIELDS = Object.freeze(['inputTokens', 'outputTokens', 'totalTokens']);

function adapterFiles() {
  return fs.readdirSync(ADAPTER_DIR)
    .filter((name) => name.endsWith('.js'))
    .sort()
    .map((name) => path.join(ADAPTER_DIR, name));
}

function runIsolated(file, args = [], timeoutMs = 30000) {
  const result = spawnSync(process.execPath, [CHILD_RUNNER, file, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      KHY_QUALITY_GATE_FIXTURE: '1',
      KHY_QUALITY_GATE_NETWORK: 'blocked',
    },
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (result.error) throw new Error(`${path.basename(file)}: ${result.error.message}`);
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${path.basename(file)}: ${output || `child exited ${result.status}`}`);
  }
  const line = String(result.stdout || '').split(/\r?\n/).find((entry) => entry.startsWith(RESULT_PREFIX));
  if (!line) throw new Error(`${path.basename(file)}: child returned no contract result`);
  try {
    return JSON.parse(line.slice(RESULT_PREFIX.length));
  } catch (error) {
    throw new Error(`${path.basename(file)}: child returned invalid JSON: ${error.message}`);
  }
}

function discoverAdapters(files = adapterFiles()) {
  return files.filter((file) => runIsolated(file, ['--probe']).hasGenerate);
}

function validateFixtureCoverage(files) {
  const discovered = new Set(files.map((file) => path.basename(file)));
  const fixtureNames = new Set(Object.keys(FIXTURES));
  const missing = [...discovered].filter((name) => !fixtureNames.has(name));
  const stale = [...fixtureNames].filter((name) => !discovered.has(name));
  if (missing.length || stale.length) {
    const details = [];
    if (missing.length) details.push(`missing fixtures: ${missing.join(', ')}`);
    if (stale.length) details.push(`stale fixtures: ${stale.join(', ')}`);
    throw new Error(details.join('; '));
  }
}

function validateSourceContract(file) {
  const name = path.basename(file);
  const source = fs.readFileSync(file, 'utf8');
  const fixture = FIXTURES[name];
  if (!fixture) throw new Error(`${name}: missing fixture recipe`);
  if (!fixture.family || !Array.isArray(fixture.transports)) {
    throw new Error(`${name}: invalid fixture recipe`);
  }
  for (const marker of fixture.markers) {
    if (!source.includes(marker)) throw new Error(`${name}: fixture marker missing: ${marker}`);
  }
}

function runChild(file, timeoutMs = 30000) {
  return runIsolated(file, [], timeoutMs);
}

function validateResult(file, result) {
  const name = path.basename(file);
  if (!result || typeof result !== 'object') throw new Error(`${name}: generate returned no result object`);
  if (result.success !== true) throw new Error(`${name}: generate returned failure or omitted success=true`);
  if (!Object.hasOwn(result, 'content') && !Object.hasOwn(result, 'text')) {
    throw new Error(`${name}: missing text/content field`);
  }
  const text = result.text ?? result.content;
  if (typeof text !== 'string' || !text.trim()) throw new Error(`${name}: missing non-empty text/content`);
  if (!result.tokenUsage || typeof result.tokenUsage !== 'object' || Array.isArray(result.tokenUsage)) {
    throw new Error(`${name}: missing tokenUsage`);
  }
  for (const field of TOKEN_FIELDS) {
    const value = result.tokenUsage[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name}: invalid tokenUsage.${field}`);
    }
  }
  if (typeof result.model !== 'string' || !result.model.trim()) throw new Error(`${name}: missing model`);
  return { text, tokenUsage: result.tokenUsage, model: result.model };
}

function run() {
  const files = discoverAdapters();
  validateFixtureCoverage(files);
  const results = [];
  process.stdout.write(`[provider-contract] action=start target=adapters count=${files.length}\n`);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    validateSourceContract(file);
    const projected = validateResult(file, runChild(file));
    results.push({ adapter: path.basename(file), ...projected });
    process.stdout.write(`[provider-contract] action=pass target=${path.basename(file)} progress=${index + 1}/${files.length}\n`);
  }
  process.stdout.write(`[provider-contract] action=pass target=all-adapters count=${results.length}\n`);
  return results;
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`[provider-contract] action=fail target=adapters error=${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  ADAPTER_DIR,
  adapterFiles,
  discoverAdapters,
  validateFixtureCoverage,
  validateSourceContract,
  validateResult,
  runChild,
  run,
};
