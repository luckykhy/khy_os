'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('../src/services/updateAdapters/packageAdapter');

function state(root) {
  return {
    state: 'available',
    target: { version: '1.2.3' },
    source: {
      type: 'package',
      packages: {
        pip: { name: 'khy-os', version: '1.2.2' },
        npm: { name: '@khy-os/khy-os', version: '1.2.2' },
      },
    },
    _root: root,
  };
}

test('stages pip and npm artifacts without installing either channel', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-package-stage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const result = await adapter.stagePackageUpdate(state(root), {
    cacheDir: root,
    execFile(file, args) {
      calls.push([file, ...args]);
      const destination = args.includes('--dest')
        ? args[args.indexOf('--dest') + 1]
        : args[args.indexOf('--pack-destination') + 1];
      fs.mkdirSync(destination, { recursive: true });
      if (file.startsWith('pip')) fs.writeFileSync(path.join(destination, 'khy_os-1.2.3-py3-none-any.whl'), 'wheel');
      if (file === 'npm') fs.writeFileSync(path.join(destination, 'khy-os-khy-os-1.2.3.tgz'), 'tgz');
      return '';
    },
  });

  assert.equal(result.success, true);
  assert.ok(calls.some(call => call.includes('download')));
  assert.ok(calls.some(call => call.includes('pack')));
  assert.ok(!calls.some(call => call.includes('install')));
  const descriptor = adapter.readDescriptor(result.path);
  assert.equal(descriptor.version, '1.2.3');
  assert.ok(path.isAbsolute(descriptor.artifacts.pip));
  assert.ok(path.isAbsolute(descriptor.artifacts.npm));
});

test('downloads GitHub package artifacts with hash, size and progress verification', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-package-github-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('verified wheel bytes');
  const artifact = {
    url: 'https://github.com/example/khy/releases/download/v1.2.3/khy_os-1.2.3-py3-none-any.whl',
    filename: 'khy_os-1.2.3-py3-none-any.whl',
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
  const update = state(root);
  update.updateSource = 'github';
  update.source.packages.npm = null;
  update.detail = { packageArtifacts: { pip: artifact } };
  const progress = [];
  const result = await adapter.stagePackageUpdate(update, {
    cacheDir: root,
    fetch: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    }),
    onProgress(event) { progress.push(event); },
    execFile() { throw new Error('registry fallback must not execute'); },
  });
  assert.equal(result.success, true);
  assert.equal(result.detail.source, 'github');
  assert.equal(fs.readFileSync(result.detail.artifacts.pip, 'utf8'), bytes.toString());
  assert.deepEqual(result.detail.artifactMeta.pip, artifact);
  assert.equal(progress.at(-1).size, bytes.length);
  assert.equal(progress.at(-1).total, bytes.length);
});

test('rejects GitHub package hash mismatch and removes the temporary file', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-package-github-bad-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from('wrong bytes');
  const update = state(root);
  update.updateSource = 'github';
  update.source.packages.npm = null;
  update.detail = { packageArtifacts: { pip: {
    url: 'https://github.com/example/khy/releases/download/v1.2.3/khy_os-1.2.3.whl',
    filename: 'khy_os-1.2.3.whl',
    size: bytes.length,
    sha256: '0'.repeat(64),
  } } };
  const result = await adapter.stagePackageUpdate(update, {
    cacheDir: root,
    fetch: async () => ({
      ok: true,
      status: 200,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    }),
  });
  assert.equal(result.success, false);
  assert.match(result.error, /sha256 mismatch/);
  assert.equal(fs.readdirSync(result.path).some(name => name.endsWith('.tmp')), false);
});
test('apply delegates only after descriptor and target validation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-package-apply-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wheel = path.join(root, 'khy_os-1.2.3.whl');
  fs.writeFileSync(wheel, 'wheel');
  const descriptorPath = path.join(root, 'STAGED.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    schemaVersion: 1,
    type: 'package',
    version: '1.2.3',
    package: 'khy-os',
    artifacts: { pip: wheel },
  }));
  const update = { ...state(root), state: 'staged', stagedPath: descriptorPath };
  let received;
  const result = adapter.applyPackageUpdate(update, {
    selfUpdate: { applyUpdate(opts) { received = opts.staged; return { success: true }; } },
  });
  assert.equal(result.success, true);
  assert.equal(received.artifacts.pip, wheel);

  const mismatch = adapter.applyPackageUpdate({ ...update, target: { version: '9.9.9' } }, {
    selfUpdate: { applyUpdate() { throw new Error('must not execute'); } },
  });
  assert.equal(mismatch.success, false);
  assert.match(mismatch.error, /does not match/);
});

test('applies both staged GitHub channels without registry synchronization', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-package-apply-both-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wheel = path.join(root, 'khy_os-1.2.3.whl');
  const tgz = path.join(root, 'khy-os-1.2.3.tgz');
  fs.writeFileSync(wheel, 'wheel');
  fs.writeFileSync(tgz, 'tgz');
  const descriptorPath = path.join(root, 'STAGED.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    schemaVersion: 1,
    type: 'package',
    version: '1.2.3',
    package: 'khy-os',
    source: 'github',
    artifacts: { pip: wheel, npm: tgz },
  }));
  const update = { ...state(root), state: 'staged', stagedPath: descriptorPath };
  let selfUpdateOptions;
  const calls = [];
  const result = adapter.applyPackageUpdate(update, {
    selfUpdate: {
      applyUpdate(opts) {
        selfUpdateOptions = opts;
        return { success: true, changed: true, channels: [{ channel: 'pip', success: true }] };
      },
    },
    execFile(file, args) { calls.push([file, ...args]); return 'installed'; },
  });
  assert.equal(result.success, true);
  assert.equal(selfUpdateOptions.env.KHY_MULTI_CHANNEL_SYNC, '0');
  assert.deepEqual(calls, [['npm', 'install', '-g', tgz]]);
  assert.deepEqual(result.channels.map(item => item.channel), ['pip', 'npm']);
});

test('rejects pip packages outside the update allowlist', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-package-allowlist-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const update = state(root);
  update.source.packages.pip.name = 'other-package';
  let executed = false;
  const result = await adapter.stagePackageUpdate(update, {
    cacheDir: root,
    execFile() { executed = true; },
  });
  assert.equal(result.success, false);
  assert.equal(executed, false);
  assert.match(result.error, /allowlist/);
});
