'use strict';

/**
 * latestVersionResolver.test.js — 回归「最新已发布版本」跨仓库判定。
 *
 * 覆盖:三源取最高版本、取胜源标注、单源失败仍出结论、全源失败诚实 indeterminate、
 * 渠道门控跳过探测、GitHub 草稿/预发布不算已发布、tag 里的 `v` 前缀归一。
 * 全部走注入的 probes / fetch,零真实网络。
 */
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const resolver = require('../../src/services/latestVersionResolver');

describe('latestVersionResolver', () => {
  test('highest version across GitHub / PyPI / npm wins and names its source', async () => {
    const r = await resolver.resolveLatestVersion({
      env: {},
      probes: {
        github: async () => ({ version: '1.1.10', raw: 'v1.1.10' }),
        pypi: async () => ({ version: '0.1.29', package: 'khy-os' }),
        npm: async () => ({ version: '1.1.9', package: '@khy-os/khy-os' }),
      },
    });
    assert.equal(r.latest, '1.1.10');
    assert.equal(r.source, 'github');
    assert.equal(r.sourceLabel, 'GitHub Releases');
    assert.equal(r.indeterminate, false);
    assert.deepEqual(
      r.sources.map((s) => [s.channel, s.version]),
      [['github', '1.1.10'], ['pypi', '0.1.29'], ['npm', '1.1.9']]
    );
    assert.match(r.text, /GitHub Releases v1\.1\.10 · PyPI v0\.1\.29 · npm v1\.1\.9/);
  });

  test('npm ahead of pip is reported as the latest (the pip-only display bug)', async () => {
    const r = await resolver.resolveLatestVersion({
      env: {},
      probes: {
        github: async () => ({ version: null, error: '仓库没有已发布 Release' }),
        pypi: async () => ({ version: '0.1.29' }),
        npm: async () => ({ version: '0.1.31' }),
      },
    });
    assert.equal(r.latest, '0.1.31');
    assert.equal(r.source, 'npm');
  });

  test('one failing source never blocks a verdict from the others', async () => {
    const r = await resolver.resolveLatestVersion({
      env: {},
      probes: {
        github: async () => { throw new Error('offline'); },
        pypi: async () => ({ version: '0.1.29' }),
        npm: async () => ({ version: null, error: 'HTTP 404' }),
      },
    });
    assert.equal(r.latest, '0.1.29');
    assert.equal(r.source, 'pypi');
    assert.equal(r.sources[0].error, 'offline');
    assert.match(r.text, /GitHub Releases offline/);
  });

  test('every source failing is indeterminate, never a false "up to date"', async () => {
    const r = await resolver.resolveLatestVersion({
      env: {},
      probes: {
        github: async () => { throw new Error('offline'); },
        pypi: async () => { throw new Error('offline'); },
        npm: async () => { throw new Error('offline'); },
      },
    });
    assert.equal(r.latest, null);
    assert.equal(r.source, null);
    assert.equal(r.indeterminate, true);
  });

  test('disabled channels are skipped without probing', async () => {
    let probed = 0;
    const count = async () => { probed += 1; return { version: '9.9.9' }; };
    const r = await resolver.resolveLatestVersion({
      env: { KHY_UPDATE_ENABLE_GITHUB: '0', KHY_UPDATE_ENABLE_NPM: '0' },
      probes: { github: count, npm: count, pypi: async () => ({ version: '0.1.29' }) },
    });
    assert.equal(probed, 0);
    assert.equal(r.latest, '0.1.29');
    assert.deepEqual(r.sources.map((s) => s.enabled), [false, true, false]);
  });

  test('self-update gate off disables every source', async () => {
    const r = await resolver.resolveLatestVersion({
      env: { KHY_SELF_UPDATE: '0' },
      probes: { github: async () => ({ version: '9.9.9' }) },
    });
    assert.equal(r.latest, null);
    assert.equal(r.indeterminate, true);
    assert.deepEqual(r.sources.map((s) => s.enabled), [false, false, false]);
  });

  test('GitHub probe ignores drafts and prereleases and strips the tag prefix', async () => {
    const releases = [
      { tag_name: 'v2.0.0-rc1', prerelease: true },
      { tag_name: 'v9.9.9', draft: true },
      { tag_name: 'v1.1.10' },
      { tag_name: 'v1.0.9' },
    ];
    const fetch = async () => ({ ok: true, status: 200, async json() { return releases; } });
    const probed = await resolver._probeGithub({ env: {}, fetch });
    assert.equal(probed.version, '1.1.10');
    assert.equal(probed.raw, 'v1.1.10');
  });

  test('GitHub branch manifest wins when it is ahead of the latest formal Release', async () => {
    const fetch = async (url) => {
      if (url.endsWith('/releases')) {
        return { ok: true, status: 200, async json() { return [{ tag_name: 'v1.1.8' }]; } };
      }
      if (url === 'https://api.github.com/repos/luckykhy/khy_os') {
        return { ok: true, status: 200, async json() { return { default_branch: 'main' }; } };
      }
      if (url.endsWith('/luckykhy/khy_os/main/services/backend/package.json')) {
        return { ok: true, status: 200, async json() { return { version: '1.1.10' }; } };
      }
      throw new Error(`unexpected URL: ${url}`);
    };
    const probed = await resolver._probeGithub({ env: {}, fetch });
    assert.equal(probed.releaseVersion, '1.1.8');
    assert.equal(probed.branchVersion, '1.1.10');
    assert.equal(probed.version, '1.1.10');
    assert.equal(probed.raw, '1.1.10');
  });

  test('GitHub probe reports an empty release list instead of guessing', async () => {
    const fetch = async () => ({ ok: true, status: 200, async json() { return []; } });
    const probed = await resolver._probeGithub({ env: {}, fetch });
    assert.equal(probed.version, null);
    assert.match(probed.error, /没有已发布 Release/);
  });

  test('npm probe reads the latest dist-tag of the scoped package', async () => {
    let requested = '';
    const fetch = async (url) => {
      requested = url;
      return { ok: true, status: 200, async json() { return { version: '0.1.31' }; } };
    };
    const probed = await resolver._probeNpm({ env: {}, fetch });
    assert.equal(probed.version, '0.1.31');
    assert.equal(probed.package, '@khy-os/khy-os');
    assert.match(requested, /registry\.npmjs\.org\/%40khy-os%2Fkhy-os\/latest$/);
  });

  test('PyPI probe walks the package allowlist in order', async () => {
    const urls = [];
    const fetch = async (url) => {
      urls.push(url);
      if (/khy-os/.test(url)) throw new Error('HTTP 404');
      return { ok: true, status: 200, async json() { return { info: { version: '1.8.0' } }; } };
    };
    const probed = await resolver._probePypi({ env: {}, fetch });
    assert.equal(probed.version, '1.8.0');
    assert.equal(probed.package, 'khy-quant');
    assert.equal(urls.length, 2);
  });

  test('numeric core extraction tolerates tag and prerelease decoration', () => {
    assert.equal(resolver._numericVersion('v1.2.3'), '1.2.3');
    assert.equal(resolver._numericVersion('1.0.0rc1'), '1.0.0');
    assert.equal(resolver._numericVersion('release-2.4'), '2.4');
    assert.equal(resolver._numericVersion('nightly'), null);
    assert.equal(resolver._numericVersion(null), null);
  });
});
