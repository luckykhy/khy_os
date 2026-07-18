'use strict';

/**
 * publishProjectState.test.js — pins the pure project-version-state reader
 * extracted from the cli/handlers/publish.js god-file (B1 split).
 *
 * Covers: project-root discovery (walk up to pyproject.toml/setup.py),
 * pyproject [project] field parsing, multi-manifest version-state assembly
 * with alignment detection, and the release-version format guard. Also asserts
 * publish.js re-exports the very same function objects (import-back identity),
 * so existing callers and the publish module surface are unchanged.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ps = require('../../src/services/publish/projectState');

describe('publish/projectState — project root discovery', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-projstate-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('walks up to the directory holding pyproject.toml', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "demo"\n');
    const nested = path.join(tmp, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(ps._findProjectRoot(nested), fs.realpathSync(tmp));
  });

  test('falls back to startDir when no marker is found', () => {
    const nested = path.join(tmp, 'x', 'y');
    fs.mkdirSync(nested, { recursive: true });
    assert.equal(ps._findProjectRoot(nested), path.resolve(nested));
  });
});

describe('publish/projectState — manifest parsing and version state', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-projstate-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('_extractProjectField reads a quoted field from the [project] block', () => {
    const content = '[build-system]\nrequires = ["x"]\n\n[project]\nname = "khy-os"\nversion = "0.1.109"\n';
    assert.equal(ps._extractProjectField(content, 'name'), 'khy-os');
    assert.equal(ps._extractProjectField(content, 'version'), '0.1.109');
    assert.equal(ps._extractProjectField(content, 'missing'), '');
  });

  test('_readState assembles aligned version state across manifests', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "khy-os"\nversion = "1.2.3"\n');
    fs.mkdirSync(path.join(tmp, 'khy_platform'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'khy_platform', '__init__.py'), '__version__ = "1.2.3"\n');
    fs.mkdirSync(path.join(tmp, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'backend', 'package.json'), JSON.stringify({ version: '1.2.3' }));

    const st = ps._readState(tmp);
    assert.equal(st.packageName, 'khy-os');
    assert.deepEqual(st.versions, { pyproject: '1.2.3', python: '1.2.3', backend: '1.2.3' });
    assert.equal(st.versionAligned, true);
  });

  test('_readState flags a drift between manifests as not aligned', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[project]\nname = "khy-os"\nversion = "1.2.3"\n');
    fs.mkdirSync(path.join(tmp, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'backend', 'package.json'), JSON.stringify({ version: '9.9.9' }));
    const st = ps._readState(tmp);
    assert.equal(st.versionAligned, false);
  });

  test('_readFileSafe returns empty string for a missing file', () => {
    assert.equal(ps._readFileSafe(path.join(tmp, 'nope.txt')), '');
  });
});

describe('publish/projectState — version format guard', () => {
  test('_isLikelyVersion accepts release formats, rejects junk', () => {
    // The pre-release group is a single letter + digits ([abrc]\d+), so 'a1'/'b1'
    // pass but a two-letter 'rc1' does not — pinned to the real regex contract.
    for (const v of ['0.1.0', '1.2.3', '1.2.3a1', '1.2.3.post1', '1.2.3.dev1']) {
      assert.equal(ps._isLikelyVersion(v), true, `${v} should be valid`);
    }
    for (const v of ['', 'latest', 'v1.2', 'abc', '1.2.3rc1']) {
      assert.equal(ps._isLikelyVersion(v), false, `${v} should be invalid`);
    }
  });
});

describe('publish/projectState — import-back identity from publish.js', () => {
  test('publish.js re-exports the same function objects', () => {
    const pub = require('../../src/cli/handlers/publish');
    assert.equal(pub._findProjectRoot, ps._findProjectRoot);
    assert.equal(pub._readState, ps._readState);
  });
});
