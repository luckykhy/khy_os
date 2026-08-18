'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdateIndex, validateUpdateIndex } = require('../release/update-index');

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-update-index-'));
  for (const [platform, arch, slug] of [
    ['win32', 'x64', 'win-x64'],
    ['linux', 'x64', 'linux-x64'],
  ]) {
    const name = `portable-runtime-1.2.3-${slug}`;
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'BUILD-INFO.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'portable-runtime',
      version: '1.2.3',
      sourceCommit: COMMIT,
      target: { platform, arch },
    }));
    fs.writeFileSync(path.join(root, `${name}.zip`), `archive:${slug}`);
  }
  return root;
}

test('generates a validated index from portable build metadata', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const index = createUpdateIndex({
    artifactsRoot: root,
    baseUrl: 'https://github.com/kodehu03/khy-os/releases/download/v1.2.3',
    channel: 'stable',
    version: '1.2.3',
    commit: COMMIT,
    publishedAt: '2026-08-15T10:00:00.000Z',
  });
  assert.equal(index.portable.length, 2);
  assert.equal(index.portable[0].sha256.length, 64);
  assert.equal(validateUpdateIndex(index).ok, true);
});

test('package artifacts are optional in schema v1 and verified when present', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wheel = path.join(root, 'khy_os-1.2.3-py3-none-any.whl');
  const npm = path.join(root, 'khy-os-1.2.3.tgz');
  fs.writeFileSync(wheel, 'wheel bytes');
  fs.writeFileSync(npm, 'npm bytes');

  const legacy = createUpdateIndex({
    artifactsRoot: root,
    baseUrl: 'https://releases.example.test/v1.2.3',
    channel: 'stable',
    version: '1.2.3',
    commit: COMMIT,
    publishedAt: '2026-08-15T10:00:00.000Z',
  });
  assert.equal(legacy.packages.pip.artifact, undefined);
  assert.equal(validateUpdateIndex(legacy).ok, true);

  const index = createUpdateIndex({
    artifactsRoot: root,
    baseUrl: 'https://releases.example.test/v1.2.3',
    channel: 'stable',
    version: '1.2.3',
    commit: COMMIT,
    publishedAt: '2026-08-15T10:00:00.000Z',
    pipArtifact: wheel,
    npmArtifact: npm,
  });
  assert.equal(index.packages.pip.artifact.filename, path.basename(wheel));
  assert.equal(index.packages.pip.artifact.size, Buffer.byteLength('wheel bytes'));
  assert.match(index.packages.pip.artifact.sha256, /^[a-f0-9]{64}$/);
  assert.equal(index.packages.npm.artifact.filename, path.basename(npm));
  assert.equal(validateUpdateIndex(index).ok, true);

  index.packages.pip.artifact.filename = '../outside.whl';
  index.packages.npm.artifact.url = 'http://releases.example.test/khy.tgz';
  const invalid = validateUpdateIndex(index);
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join('\n'), /filename must be a basename/);
  assert.match(invalid.errors.join('\n'), /url must use HTTPS/);
});
test('dev release index matches flattened four-platform upload assets', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-dev-release-contract-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layouts = [
    ['win32', 'x64', 'win-x64'],
    ['linux', 'x64', 'linux-x64'],
    ['darwin', 'x64', 'macos-x64'],
    ['darwin', 'arm64', 'macos-arm64'],
  ];
  const uploadedNames = new Set();
  for (const [platform, arch, slug] of layouts) {
    const artifactRoot = path.join(root, `khy-os-${slug}`);
    const name = `portable-dev-1.2.3-${slug}`;
    const buildRoot = path.join(artifactRoot, name);
    fs.mkdirSync(buildRoot, { recursive: true });
    fs.writeFileSync(path.join(buildRoot, 'BUILD-INFO.json'), JSON.stringify({
      schemaVersion: 1,
      kind: 'portable-dev',
      version: '1.2.3',
      sourceCommit: COMMIT,
      target: { platform, arch },
    }));
    const archiveName = `${name}.zip`;
    fs.writeFileSync(path.join(artifactRoot, archiveName), `archive:${slug}`);
    uploadedNames.add(archiveName);
  }

  const baseUrl = 'https://github.com/kodehu03/khy-os/releases/download/dev-channel';
  const index = createUpdateIndex({
    artifactsRoot: root,
    baseUrl,
    channel: 'dev',
    commit: COMMIT,
    publishedAt: '2026-08-15T10:00:00.000Z',
  });
  assert.equal(index.portable.length, 4);
  assert.equal(validateUpdateIndex(index, { channel: 'dev', commit: COMMIT }).ok, true);
  assert.deepEqual(new Set(index.portable.map(item => path.basename(new URL(item.url).pathname))), uploadedNames);
  assert.equal(new Set(index.portable.map(item => `${item.target.platform}-${item.target.arch}`)).size, 4);
  for (const item of index.portable) {
    assert.equal(item.kind, 'portable-dev');
    assert.equal(item.commit, COMMIT);
    assert.equal(item.url, `${baseUrl}/${path.basename(new URL(item.url).pathname)}`);
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
  }
});

test('rejects unknown schema, insecure assets, missing digests, and target mismatch', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const index = createUpdateIndex({
    artifactsRoot: root,
    baseUrl: 'https://releases.example.test/v1.2.3',
    channel: 'preview',
    publishedAt: '2026-08-15T10:00:00.000Z',
  });
  index.schemaVersion = 99;
  index.portable[0].url = 'http://releases.example.test/archive.zip';
  index.portable[0].sha256 = '';
  index.portable[0].version = '9.9.9';
  const result = validateUpdateIndex(index);
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /schemaVersion/);
  assert.match(result.errors.join('\n'), /HTTPS/);
  assert.match(result.errors.join('\n'), /sha256/);
  assert.match(result.errors.join('\n'), /does not match release/);
});

test('rejects platform-filter mismatch and duplicate kind/target pairs', t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const index = createUpdateIndex({
    artifactsRoot: root,
    baseUrl: 'https://releases.example.test/v1.2.3',
    channel: 'dev',
    publishedAt: '2026-08-15T10:00:00.000Z',
  });
  index.portable.push({ ...index.portable[0] });
  const result = validateUpdateIndex(index, { platform: 'darwin', arch: 'arm64' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /platform mismatch/);
  assert.match(result.errors.join('\n'), /architecture mismatch/);
  assert.match(result.errors.join('\n'), /duplicate portable target/);
});
