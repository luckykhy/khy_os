'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeArtifactManifest,
  verifyArtifactManifest,
  listPayloadFiles,
  normalizeTarget,
  platformSlug,
} = require('../portable/artifact-manifest');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-artifact-manifest-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'web', 'ai'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'khy'), 'binary-fixture');
  fs.writeFileSync(path.join(root, 'web', 'ai', 'index.html'), '<main>Khy</main>');
  return root;
}

function metadata() {
  return {
    kind: 'portable-runtime',
    version: '1.2.3',
    platform: 'win32',
    arch: 'x64',
    runtimes: { node: '22.12.0' },
    frontends: { ai: { built: true, entry: 'web/ai/index.html' } },
    nativeModules: [],
    source: { commit: 'fixture' },
  };
}

test('normalizes the four supported release targets', () => {
  assert.deepEqual(normalizeTarget('windows', 'x64'), { platform: 'win32', arch: 'x64' });
  assert.equal(platformSlug('win32', 'x64'), 'win-x64');
  assert.equal(platformSlug('linux', 'x64'), 'linux-x64');
  assert.equal(platformSlug('darwin', 'x64'), 'macos-x64');
  assert.equal(platformSlug('macos', 'arm64'), 'macos-arm64');
  assert.throws(() => normalizeTarget('linux', 'arm64'), /linux-x64/);
});

test('writes and verifies deterministic payload hashes', async t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const manifest = await writeArtifactManifest(root, metadata());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.files.length, 2);
  assert.deepEqual(manifest.files.map(file => file.path), [
    'bin/khy',
    'web/ai/index.html',
  ]);
  assert.ok(fs.existsSync(path.join(root, 'MANIFEST.json')));
  assert.ok(fs.existsSync(path.join(root, 'SHA256SUMS')));

  const result = await verifyArtifactManifest(root);
  assert.equal(result.ok, true, result.issues.join('\n'));
});

test('detects payload tampering and untracked files', async t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await writeArtifactManifest(root, metadata());

  fs.appendFileSync(path.join(root, 'bin', 'khy'), '-tampered');
  fs.writeFileSync(path.join(root, 'unexpected.txt'), 'not manifested');
  const result = await verifyArtifactManifest(root);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.includes('size mismatch: bin/khy')));
  assert.ok(result.issues.some(issue => issue.includes('sha256 mismatch: bin/khy')));
  assert.ok(result.issues.some(issue => issue.includes('untracked file: unexpected.txt')));
});

test('detects SHA256SUMS tampering and missing checksum files', async t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await writeArtifactManifest(root, metadata());

  fs.writeFileSync(path.join(root, 'SHA256SUMS'), `${'0'.repeat(64)}  MANIFEST.json\n`);
  const tampered = await verifyArtifactManifest(root);
  assert.equal(tampered.ok, false);
  assert.ok(tampered.issues.some(issue => issue.includes('SHA256SUMS missing path: bin/khy')));
  assert.ok(tampered.issues.some(issue => issue.includes('manifest digest mismatch')));

  fs.rmSync(path.join(root, 'SHA256SUMS'));
  const missing = await verifyArtifactManifest(root);
  assert.equal(missing.ok, false);
  assert.ok(missing.issues.some(issue => issue.includes('SHA256SUMS unreadable')));
});

test('rejects symlinks rather than hashing content outside the artifact', async t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, '..', `${path.basename(root)}-outside`);
  fs.writeFileSync(outside, 'outside');
  t.after(() => fs.rmSync(outside, { force: true }));

  try {
    fs.symlinkSync(outside, path.join(root, 'outside-link'));
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  assert.throws(() => listPayloadFiles(root), /symbolic link/);
});
