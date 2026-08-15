'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeArtifactManifest } = require('../portable/artifact-manifest');
const { parseArgs, packArtifact } = require('../portable/pack-portable');

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy packed artifact-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'khy'), 'fixture');
  await writeArtifactManifest(root, {
    kind: 'portable-runtime',
    name: 'portable-runtime-fixture',
    version: '1.0.0',
    platform: 'linux',
    arch: 'x64',
  });
  return root;
}

test('pack parser requires an assembled artifact', () => {
  assert.throws(() => parseArgs([]), /--artifact/);
  assert.throws(() => parseArgs(['--no-modules']), /已淘汰/);
  const parsed = parseArgs(['--artifact', '目录 with spaces', '--dry-run']);
  assert.equal(parsed.artifact, path.resolve('目录 with spaces'));
  assert.equal(parsed.dryRun, true);
});

test('dry-run verifies an artifact without creating an archive', async t => {
  const root = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const result = await packArtifact({ artifact: root, out: '', dryRun: true });
  assert.equal(result.packed, false);
  assert.equal(result.manifest.name, 'portable-runtime-fixture');
  assert.equal(fs.existsSync(result.archivePath), false);
});

test('pack rejects payload tampering before invoking an archiver', async t => {
  const root = await fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.appendFileSync(path.join(root, 'bin', 'khy'), 'tampered');

  await assert.rejects(
    packArtifact({ artifact: root, out: '', dryRun: true }),
    /产物验证失败.*size mismatch/s
  );
});
