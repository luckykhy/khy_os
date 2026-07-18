'use strict';

/**
 * updateVersionsNpmChannel.test.js — pins the fix where `khy publish --version`
 * (via _updateVersions) must bump the npm channel manifest
 * (packaging/npm/package.json) alongside pyproject.toml, the backend
 * package.json and the Python __init__.py literal.
 *
 * Regression context: _updateVersions historically wrote only pyproject +
 * backend package.json + __init__.py, silently leaving packaging/npm/package.json
 * behind. Since scripts/ci/check-version-sync.js enforces exactly those three
 * manifests (pyproject / packaging-npm / services-backend) as the version-sync
 * red line, a CLI bump left the npm channel drifted and check:version-sync would
 * fail. This test builds a full forest fixture and asserts all four sources land
 * on the target version — with a focused assertion on the npm channel manifest.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const publish = require('../../src/cli/handlers/publish');

// Build the forest layout _updateVersions/_resolveExisting expect (canonical
// candidates: platform/khy_platform, services/backend, packaging/npm).
function scaffoldForest(root, initialVersion) {
  fs.writeFileSync(
    path.join(root, 'pyproject.toml'),
    `[project]\nname = "khy-os"\nversion = "${initialVersion}"\n`
  );

  const pyPkgDir = path.join(root, 'platform', 'khy_platform');
  fs.mkdirSync(pyPkgDir, { recursive: true });
  fs.writeFileSync(path.join(pyPkgDir, '__init__.py'), `__version__ = "${initialVersion}"\n`);

  const backendDir = path.join(root, 'services', 'backend');
  fs.mkdirSync(backendDir, { recursive: true });
  fs.writeFileSync(
    path.join(backendDir, 'package.json'),
    `${JSON.stringify({ name: 'khy-backend', version: initialVersion }, null, 2)}\n`
  );

  const npmDir = path.join(root, 'packaging', 'npm');
  fs.mkdirSync(npmDir, { recursive: true });
  fs.writeFileSync(
    path.join(npmDir, 'package.json'),
    `${JSON.stringify({ name: '@khy-os/khy-os', version: initialVersion }, null, 2)}\n`
  );
}

function readJsonVersion(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8')).version;
}

describe('publish/_updateVersions — npm channel bump', () => {
  let tmp;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-updver-')); });
  afterEach(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  test('bumps ALL FOUR sources incl. packaging/npm/package.json', () => {
    scaffoldForest(tmp, '1.0.0');
    publish._updateVersions(tmp, '2.3.4');

    const pyproject = fs.readFileSync(path.join(tmp, 'pyproject.toml'), 'utf-8');
    assert.match(pyproject, /version\s*=\s*"2\.3\.4"/, 'pyproject bumped');

    const pyInit = fs.readFileSync(path.join(tmp, 'platform', 'khy_platform', '__init__.py'), 'utf-8');
    assert.match(pyInit, /__version__\s*=\s*"2\.3\.4"/, '__init__.py literal bumped');

    assert.equal(
      readJsonVersion(path.join(tmp, 'services', 'backend', 'package.json')),
      '2.3.4',
      'backend package.json bumped'
    );

    // The regression fix: the npm channel manifest must be bumped too.
    assert.equal(
      readJsonVersion(path.join(tmp, 'packaging', 'npm', 'package.json')),
      '2.3.4',
      'packaging/npm/package.json (npm channel) bumped — the fix'
    );
  });

  test('all three version-sync red-line sources agree after a bump', () => {
    scaffoldForest(tmp, '0.1.0');
    publish._updateVersions(tmp, '5.6.7');

    const pyproject = fs.readFileSync(path.join(tmp, 'pyproject.toml'), 'utf-8');
    const pyVersion = (pyproject.match(/version\s*=\s*"([^"]+)"/) || [])[1];
    const npmVersion = readJsonVersion(path.join(tmp, 'packaging', 'npm', 'package.json'));
    const backendVersion = readJsonVersion(path.join(tmp, 'services', 'backend', 'package.json'));

    const distinct = new Set([pyVersion, npmVersion, backendVersion]);
    assert.equal(distinct.size, 1, 'the three red-line sources are in sync');
    assert.equal(pyVersion, '5.6.7');
  });

  test('npm channel bump is fail-soft when the manifest is absent', () => {
    // Only the pyproject + backend sources; packaging/npm/package.json missing.
    fs.writeFileSync(
      path.join(tmp, 'pyproject.toml'),
      '[project]\nname = "khy-os"\nversion = "1.0.0"\n'
    );
    const backendDir = path.join(tmp, 'services', 'backend');
    fs.mkdirSync(backendDir, { recursive: true });
    fs.writeFileSync(
      path.join(backendDir, 'package.json'),
      `${JSON.stringify({ version: '1.0.0' }, null, 2)}\n`
    );

    assert.doesNotThrow(() => publish._updateVersions(tmp, '1.1.0'));
    assert.equal(readJsonVersion(path.join(backendDir, 'package.json')), '1.1.0');
    assert.equal(
      fs.existsSync(path.join(tmp, 'packaging', 'npm', 'package.json')),
      false,
      'absent npm manifest is not created'
    );
  });

  test('rejects an invalid version string before writing anything', () => {
    scaffoldForest(tmp, '1.0.0');
    assert.throws(() => publish._updateVersions(tmp, 'not-a-version'));
    // Unchanged on rejection.
    assert.equal(readJsonVersion(path.join(tmp, 'packaging', 'npm', 'package.json')), '1.0.0');
  });
});
