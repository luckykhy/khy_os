'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const adapter = require('../src/services/updateAdapters/portableAdapter');
const { writeArtifactManifest } = require('../../../extensions/scripts/khy-portable/artifact-manifest');

const OLD_COMMIT = '1111111111111111111111111111111111111111';
const NEW_COMMIT = '2222222222222222222222222222222222222222';

async function artifact(root, version, commit, marker) {
  fs.mkdirSync(path.join(root, 'state', '.khy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.portable'), 'khy-portable-v1\n');
  fs.writeFileSync(path.join(root, 'BUILD-INFO.json'), JSON.stringify({
    schemaVersion: 1,
    kind: 'portable-runtime',
    version,
    sourceCommit: commit,
    target: { platform: process.platform, arch: process.arch },
  }));
  fs.writeFileSync(path.join(root, 'runtime.txt'), marker);
  await writeArtifactManifest(root, {
    kind: 'portable-runtime',
    version,
    platform: process.platform,
    arch: process.arch,
    source: { commit },
  });
}

function updateState(live, stagedPath) {
  return {
    state: 'staged',
    source: { type: 'portable', root: live, kind: 'portable-runtime' },
    target: { version: '2.0.0', commit: NEW_COMMIT },
    stagedPath,
  };
}

async function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-portable-apply-'));
  const live = path.join(parent, 'khy-live');
  const staged = path.join(parent, 'staged');
  await artifact(live, '1.0.0', OLD_COMMIT, 'old');
  await artifact(staged, '2.0.0', NEW_COMMIT, 'new');
  fs.writeFileSync(path.join(live, 'state', '.khy', 'user.json'), '{"kept":true}');
  const descriptorPath = path.join(parent, 'STAGED.json');
  fs.writeFileSync(descriptorPath, JSON.stringify({
    schemaVersion: 1,
    type: 'portable',
    version: '2.0.0',
    commit: NEW_COMMIT,
    root: staged,
  }));
  return { parent, live, staged, descriptorPath };
}

test('selects exactly the current portable kind and host target', () => {
  const target = { platform: process.platform, arch: process.arch };
  const wanted = {
    kind: 'portable-runtime', version: '2.0.0', commit: NEW_COMMIT, target,
    url: 'https://releases.example.test/runtime.zip', size: 10, sha256: 'a'.repeat(64),
  };
  const index = {
    release: { version: '2.0.0', commit: NEW_COMMIT },
    portable: [wanted, { ...wanted, kind: 'portable-dev' }],
  };
  assert.equal(adapter._selectArtifact(index, { kind: 'portable-runtime' }), wanted);
});

test('preview index lookup skips the fixed dev prerelease', async () => {
  const url = await adapter._resolveIndexUrl('preview', {
    fetch: async () => ({
      ok: true,
      json: async () => [
        {
          prerelease: true,
          draft: false,
          assets: [{ name: 'update-index-dev.json', browser_download_url: 'https://example.test/dev.json' }],
        },
        {
          prerelease: true,
          draft: false,
          assets: [{ name: 'update-index-preview.json', browser_download_url: 'https://example.test/preview.json' }],
        },
      ],
    }),
  });
  assert.equal(url, 'https://example.test/preview.json');
});

test('atomic portable apply preserves user state and replaces runtime', async t => {
  const value = await fixture();
  t.after(() => fs.rmSync(value.parent, { recursive: true, force: true }));
  const result = await adapter.applyPortable(updateState(value.live, value.descriptorPath), {
    healthCheck: async root => fs.readFileSync(path.join(root, 'runtime.txt'), 'utf8') === 'new',
  });
  assert.equal(result.success, true);
  assert.equal(fs.readFileSync(path.join(value.live, 'runtime.txt'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(value.live, 'state', '.khy', 'user.json'), 'utf8'), '{"kept":true}');
});

test('Windows file locks defer the portable swap until restart', async t => {
  const value = await fixture();
  t.after(() => fs.rmSync(value.parent, { recursive: true, force: true }));
  const originalRename = fs.renameSync;
  let scheduled = null;
  fs.renameSync = (source, destination) => {
    if (source === value.live) {
      const error = new Error('directory is in use');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename(source, destination);
  };
  t.after(() => { fs.renameSync = originalRename; });
  const result = await adapter.applyPortable(updateState(value.live, value.descriptorPath), {
    platform: 'win32',
    healthCheck: async () => true,
    scheduleDeferredSwap: paths => {
      scheduled = paths;
      return { scheduled: true, resultPath: path.join(value.parent, 'result.json') };
    },
  });
  assert.equal(result.success, true);
  assert.equal(result.changed, false);
  assert.equal(result.deferred, true);
  assert.equal(result.pendingRestart, true);
  assert.equal(scheduled.live, value.live);
  assert.equal(fs.existsSync(scheduled.incoming), true);
  assert.equal(fs.readFileSync(path.join(value.live, 'runtime.txt'), 'utf8'), 'old');
});

test('download aborts only after the configured byte-idle interval', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-portable-idle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let cancelled = false;
  const destination = path.join(root, 'artifact.zip');
  const result = adapter._downloadFile('https://example.test/artifact.zip', destination, {
    size: 1,
    sha256: '0'.repeat(64),
  }, {
    downloadIdleTimeoutMs: 20,
    fetch: async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise(() => {}),
          cancel: async () => { cancelled = true; },
        }),
      },
    }),
  });
  await assert.rejects(result, /idle timeout/);
  assert.equal(cancelled, true);
  assert.equal(fs.existsSync(destination), false);
});

test('scenario d: post-apply validation failure restores the previous portable tree', async t => {
  const value = await fixture();
  t.after(() => fs.rmSync(value.parent, { recursive: true, force: true }));
  const result = await adapter.applyPortable(updateState(value.live, value.descriptorPath), {
    healthCheck: async () => true,
    postApply: async () => ({ success: false, error: 'integrity validation failed' }),
  });
  assert.equal(result.success, false);
  assert.match(result.error, /integrity validation failed/);
  assert.equal(fs.readFileSync(path.join(value.live, 'runtime.txt'), 'utf8'), 'old');
  assert.equal(fs.readFileSync(path.join(value.live, 'state', '.khy', 'user.json'), 'utf8'), '{"kept":true}');
});

test('health-check failure leaves active portable tree unchanged', async t => {
  const value = await fixture();
  t.after(() => fs.rmSync(value.parent, { recursive: true, force: true }));
  const before = fs.readFileSync(path.join(value.live, 'runtime.txt'), 'utf8');
  const result = await adapter.applyPortable(updateState(value.live, value.descriptorPath), {
    healthCheck: async () => false,
  });
  assert.equal(result.success, false);
  assert.match(result.error, /health check failed/);
  assert.equal(fs.readFileSync(path.join(value.live, 'runtime.txt'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(value.live, 'state', '.khy', 'user.json'), 'utf8'), '{"kept":true}');
});
