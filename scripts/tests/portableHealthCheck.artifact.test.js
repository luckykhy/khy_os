'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { writeArtifactManifest } = require('../portable/artifact-manifest');
const { parseArgs, probeArtifact } = require('../portable/portable-health-check');

function hostTarget() {
  return { platform: process.platform, arch: process.arch };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy artifact health-'));
  const launcher = process.platform === 'win32' ? 'launch.bat' : 'launch.sh';
  const required = process.platform === 'win32'
    ? ['runtime/node/node.exe', 'runtime/python/python.exe']
    : ['runtime/node/bin/node', 'runtime/python/bin/python3'];
  required.push('runtime/khy/bundle.mjs', 'web/ai/index.html', 'web/quant/index.html');
  for (const relative of [launcher, ...required]) {
    const absolute = path.join(root, ...relative.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, relative);
  }
  return root;
}

async function writeRuntimeManifest(root, target = hostTarget()) {
  return writeArtifactManifest(root, {
    kind: 'portable-runtime',
    version: '1.0.0',
    platform: target.platform,
    arch: target.arch,
    runtimes: { node: '22.12.0', python: 'embedded' },
    frontends: {
      ai: { built: true, entry: 'web/ai/index.html' },
      quant: { built: true, entry: 'web/quant/index.html' },
    },
  });
}

test('artifact verifier accepts a complete host runtime fixture', async t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await writeRuntimeManifest(root);

  const result = await probeArtifact(root);
  assert.equal(result.ok, true, result.issues.join('\n'));
  assert.match(result.detail, /portable-runtime/);
});

test('artifact verifier rejects a missing required entry even with fresh hashes', async t => {
  const root = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = process.platform === 'win32' ? 'runtime/node/node.exe' : 'runtime/node/bin/node';
  fs.rmSync(path.join(root, ...executable.split('/')));
  await writeRuntimeManifest(root);

  const result = await probeArtifact(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some(issue => issue.includes(`必需入口缺失: ${executable}`)));
});

test('health-check CLI parser resolves artifact roots and rejects incomplete options', () => {
  const parsed = parseArgs(['--artifact', path.join('目录 with spaces', 'artifact')]);
  assert.equal(parsed.artifactRoot, path.resolve('目录 with spaces', 'artifact'));
  assert.throws(() => parseArgs(['--artifact']), /requires a directory/);
  assert.throws(() => parseArgs(['--unknown']), /未知参数/);
});
