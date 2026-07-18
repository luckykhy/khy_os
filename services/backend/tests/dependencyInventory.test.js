'use strict';

/**
 * Tests for dependencyInventory + the /api/dependencies install分级.
 *
 * detectRuntime / listInventory exercise an injected runner seam (no real
 * processes). The install-tier guard is verified at the resolver/inventory
 * boundary the route handler relies on: high-risk / elevated / global-scope
 * plans must NOT be auto-installable, so the daemon refuses to run them.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const inventory = require('../src/services/dependencyInventory');
const resolver = require('../src/services/dependency/resolver');
const registry = require('../src/services/dependency/registry');

// A runner stub: map bin -> { code, stdout, stderr, error }.
function makeRunner(table) {
  return async (bin) => {
    const entry = table[bin];
    if (!entry) {
      const err = new Error('not found');
      err.code = 'ENOENT';
      return { code: 1, stdout: '', stderr: '', error: err };
    }
    return { code: 0, stdout: entry.stdout || '', stderr: entry.stderr || '', error: null };
  };
}

describe('detectRuntime', () => {
  test('parses version from stdout and reports present', async () => {
    const tool = { id: 'node', label: 'Node.js', bin: 'node', versionArgs: ['--version'], versionRegex: /v?(\d+\.\d+\.\d+)/, docsUrl: 'x', installHint: { linux: 'apt' } };
    const res = await inventory.detectRuntime(tool, {
      runner: makeRunner({ node: { stdout: 'v20.11.1\n' } }),
      searchExecutable: () => '/usr/bin/node',
      platform: 'linux',
    });
    assert.equal(res.present, true);
    assert.equal(res.version, '20.11.1');
    assert.equal(res.path, '/usr/bin/node');
    assert.equal(res.installable, false); // runtime never auto-installs
    assert.equal(res.category, 'runtime');
  });

  test('parses version from stderr (java -version writes to stderr)', async () => {
    const tool = { id: 'java', label: 'Java', bin: 'java', versionArgs: ['-version'], versionRegex: /version\s+"?(\d+(?:\.\d+){0,2})/, docsUrl: 'x', installHint: { linux: 'apt' } };
    const res = await inventory.detectRuntime(tool, {
      runner: makeRunner({ java: { stderr: 'openjdk version "21.0.2" 2024-01-16\n' } }),
      searchExecutable: () => '/usr/bin/java',
      platform: 'linux',
    });
    assert.equal(res.present, true);
    assert.equal(res.version, '21.0.2');
  });

  test('missing binary (ENOENT) → not present, not installable, no path', async () => {
    const tool = { id: 'gcc', label: 'GCC', bin: 'gcc', versionArgs: ['--version'], versionRegex: /(\d+\.\d+\.\d+)/, docsUrl: 'x', installHint: { linux: 'apt', win32: 'winget x' } };
    const res = await inventory.detectRuntime(tool, {
      runner: makeRunner({}), // nothing → ENOENT
      searchExecutable: () => null,
      platform: 'win32',
    });
    assert.equal(res.present, false);
    assert.equal(res.version, null);
    assert.equal(res.path, null);
    assert.equal(res.installHint, 'winget x'); // platform-specific hint
  });
});

describe('listInventory / install tiering', () => {
  test('all runtime entries are installable:false (only commands, never auto-elevate)', async () => {
    const data = await inventory.listInventory({
      runner: makeRunner({}), // everything missing — fine, we only assert tiering
      searchExecutable: () => null,
    });
    assert.ok(Array.isArray(data.runtime) && data.runtime.length > 0);
    assert.ok(data.runtime.every((r) => r.installable === false));
  });

  test('packages tier matches registry: project+non-high+no-elevation → installable', () => {
    const packages = inventory.listPackages();
    for (const p of packages) {
      const plan = resolver.buildInstallPlan(p.id);
      const expected = !!(plan && !plan.requiresElevation && plan.scope === 'project' && plan.risk !== 'high');
      assert.equal(p.installable, expected, `tier mismatch for ${p.id}`);
    }
  });

  test('a project-scope npm package (cheerio) is installable', () => {
    const packages = inventory.listPackages();
    const cheerio = packages.find((p) => p.id === 'cheerio');
    assert.ok(cheerio, 'cheerio should be in registry');
    assert.equal(cheerio.installable, true);
  });

  test('an elevated/global system package (ffmpeg) is NOT installable → manual only', () => {
    const packages = inventory.listPackages();
    const ffmpeg = packages.find((p) => p.id === 'ffmpeg');
    assert.ok(ffmpeg, 'ffmpeg should be in registry');
    assert.equal(ffmpeg.installable, false);
    assert.ok(ffmpeg.installHint, 'manual command must be shown');
  });
});

describe('_isPlanAutoInstallable guard', () => {
  test('rejects elevation, global scope, and high risk', () => {
    const g = inventory._isPlanAutoInstallable;
    assert.equal(g({ requiresElevation: false, scope: 'project', risk: 'low' }), true);
    assert.equal(g({ requiresElevation: true, scope: 'project', risk: 'low' }), false);
    assert.equal(g({ requiresElevation: false, scope: 'global', risk: 'low' }), false);
    assert.equal(g({ requiresElevation: false, scope: 'project', risk: 'high' }), false);
    assert.equal(g(null), false);
  });
});
