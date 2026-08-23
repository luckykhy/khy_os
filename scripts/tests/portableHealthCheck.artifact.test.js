'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 被测对象住在拓展 khy-portable 里（[DESIGN-ARCH-069]：删目录即卸载）。经 lib/ext-run
// 解析而不写死 extensions/ 下的路径——拓展被删掉时这里退化成一条说得清的 skip，
// 而不是一条 node 的 Cannot find module。
const { requireExtensionModule } = require('../lib/ext-run');
const _ext = requireExtensionModule('khy-portable', { file: 'artifact-manifest.js' });
const _ext2 = requireExtensionModule('khy-portable', { file: 'portable-health-check.js' });
if (!_ext || !_ext2) {
  test('拓展 khy-portable 未安装，本文件的被测对象随它一起消失', (ctx) =>
    ctx.skip('extensions/scripts/khy-portable/ 不在磁盘上；放回该目录即恢复，无需注册步骤'));
  return;
}
const { writeArtifactManifest } = _ext;
const { parseArgs, probeArtifact } = _ext2;

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
