'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const router = require('../src/services/updateChannelRouter');

function installation(overrides = {}) {
  return {
    type: 'package',
    version: '1.0.0',
    channel: 'stable',
    packages: { pip: { name: 'khy-os', version: '1.0.0' }, npm: null },
    ...overrides,
  };
}

function result(status, targetVersion, reason) {
  return { status, currentVersion: '1.0.0', targetVersion, reason };
}

test('GitHub package artifact wins and lower-priority probes are skipped', async () => {
  const calls = [];
  const artifact = {
    url: 'https://github.com/example/khy/releases/download/v2.0.0/khy.whl',
    filename: 'khy.whl',
    size: 12,
    sha256: 'a'.repeat(64),
  };
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => {
        calls.push('github');
        return result('available', '2.0.0', 'found');
      },
      pypi: async () => { calls.push('pypi'); return result('available', '3.0.0', 'found'); },
    },
  });
  assert.equal(checked.source, 'github');
  assert.deepEqual(calls, ['github']);

  assert.deepEqual(router._selectGithubPackageArtifacts({
    packages: { pip: { name: 'khy-os', version: '2.0.0', artifact } },
  }, installation({ version: '1.0.0' })), { pip: artifact });
});

test('GitHub package probe degrades when the current package has no artifact', async () => {
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => result('unavailable', '2.0.0', 'Release 索引缺少当前安装渠道的 GitHub 构件'),
      pypi: async () => result('available', '2.0.0', 'found'),
    },
  });
  assert.equal(checked.source, 'pypi');
  assert.equal(checked.degradation[0].channel, 'github');
});
test('scenario a: GitHub update wins and stops lower-priority probes', async () => {
  const calls = [];
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => { calls.push('github'); return result('available', '2.0.0', 'found'); },
      pypi: async () => { calls.push('pypi'); return result('available', '3.0.0', 'found'); },
    },
  });
  assert.equal(checked.source, 'github');
  assert.equal(checked.target, '2.0.0');
  assert.deepEqual(calls, ['github']);
});

test('scenario b: GitHub failure degrades to PyPI', async () => {
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => { throw new Error('GitHub API timeout'); },
      pypi: async () => result('available', '2.0.0', 'found'),
    },
  });
  assert.equal(checked.source, 'pypi');
  assert.equal(checked.available, true);
  assert.match(checked.degradation[0].reason, /GitHub API timeout/);
  assert.deepEqual(checked.channelResults.map(item => item.channel), ['github', 'pypi']);
});

test('scenario c: network sources unavailable and local snapshot repairs files', async () => {
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => { throw new Error('offline'); },
      pypi: async () => { throw new Error('offline'); },
      npm: async () => { throw new Error('offline'); },
      local: async () => ({ status: 'repaired', targetVersion: '1.0.0', reason: 'repaired 1' }),
    },
  });
  assert.equal(checked.source, 'local');
  assert.equal(checked.repaired, true);
  assert.equal(checked.available, false);
  assert.equal(checked.degradation.length, 3);
});

test('disabled channels are skipped independently', async () => {
  const checked = await router.checkAllChannels({
    env: { KHY_UPDATE_ENABLE_GITHUB: '0', KHY_UPDATE_ENABLE_PYPI: '0', KHY_UPDATE_ENABLE_NPM: '0' },
    installation: installation(),
    probes: {
      github: async () => { throw new Error('must not run'); },
      pypi: async () => { throw new Error('must not run'); },
      npm: async () => { throw new Error('must not run'); },
      local: async () => ({ status: 'healthy-no-update', targetVersion: '1.0.0', reason: 'healthy' }),
    },
  });
  assert.deepEqual(checked.channelResults.slice(0, 3).map(item => item.status), ['disabled', 'disabled', 'disabled']);
  assert.equal(checked.channelResults[3].status, 'healthy-no-update');
});

test('parent self-update gate disables every source without probing', async () => {
  let probes = 0;
  const disabledProbe = async () => { probes += 1; return result('available', '2.0.0', 'found'); };
  const checked = await router.checkAllChannels({
    env: { KHY_SELF_UPDATE: '0' },
    installation: installation(),
    probes: {
      github: disabledProbe,
      pypi: disabledProbe,
      npm: disabledProbe,
      local: disabledProbe,
    },
  });
  assert.equal(probes, 0);
  assert.equal(checked.available, false);
  assert.deepEqual(checked.channelResults.map(item => item.status), [
    'disabled', 'disabled', 'disabled', 'disabled',
  ]);
});

test('failed validation result never enters apply pipeline', async () => {
  let staged = false;
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => ({ status: 'failed-validation', reason: 'sha256 mismatch' }),
      pypi: async () => ({ status: 'no-update', reason: 'same version' }),
      npm: async () => ({ status: 'unavailable', reason: 'not installed' }),
      local: async () => ({ status: 'healthy-no-update', reason: 'healthy' }),
    },
  });
  const outcome = await router.applyFromBestChannel({
    checked,
    coordinator: {
      checkUpdate: async () => { staged = true; },
      stageUpdate: async () => { staged = true; },
      applyUpdate: async () => { staged = true; },
    },
  });
  assert.equal(outcome.applied, false);
  assert.equal(staged, false);
  assert.match(checked.channelResults[0].reason, /sha256 mismatch/);
});

test('source labels include action, target and progress for CLI diagnostics', async () => {
  const checked = await router.checkAllChannels({
    installation: installation(),
    probes: {
      github: async () => result('available', '2.0.0', 'found'),
    },
  });
  assert.deepEqual(
    Object.keys(checked.channelResults[0]).filter(key => ['action', 'target', 'progress'].includes(key)).sort(),
    ['action', 'progress', 'target']
  );
  assert.equal(checked.channelResults[0].progress, '1/4');
});
