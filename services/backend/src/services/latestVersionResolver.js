'use strict';

/**
 * latestVersionResolver.js — 「最新已发布版本」的单一真源:**同时**查 GitHub Releases / PyPI /
 * npm 三个公共仓库,取其中最高的版本号。
 *
 * 缺口(取证 2026-08):`versionService.checkForUpdate()` 只跑 `pip index versions`,于是启动
 * 横幅那行「最新 vX / 已是最新版本 / 领先于已发布版本」实际只以 **PyPI 一个渠道** 为准。
 * 真实发布是多渠道的(GitHub Release + PyPI `khy-os` + npm `@khy-os/khy-os`),任一渠道先发布或
 * 某渠道发布失败时,旧显示就会谎报「已是最新」/「领先于已发布版本」。本叶子把三个仓库都查,
 * 诚实报出**每个源各自的版本**与**取胜源**,供显示层原样呈现。
 *
 * 红线:
 *   - 只读、绝不抛。任一源取不到 → 该源 { version: null, error: 原因 },不臆测、不静默。
 *   - 三个源都取不到 → { latest: null, indeterminate: true },调用方必须诚实降级,
 *     **绝不**把「查不到」显示成「已是最新」。
 *   - 渠道门控复用 updateChannelRouter.isChannelEnabled(KHY_SELF_UPDATE + KHY_UPDATE_ENABLE_*),
 *     不另立一套开关。
 *   - 端点/包名取自 constants/serviceDefaults 的 UPDATE 与既有白名单常量,绝不取自模型输入。
 */

const { UPDATE } = require('../constants/serviceDefaults');

// 显示顺序 = 级联更新源的顺序(GitHub → PyPI → npm),与 updateChannelRouter 保持一致。
const SOURCES = Object.freeze(['github', 'pypi', 'npm']);

const LABELS = Object.freeze({
  github: 'GitHub Releases',
  pypi: 'PyPI',
  npm: 'npm',
});

function _router() {
  return require('./updateChannelRouter');
}

function _compare(a, b) {
  return require('./versionService').compareVersions(a, b);
}

/** 从 tag / 版本串里取出可比较的数字核(`v1.2.3` → `1.2.3`);取不到 → null。 */
function numericVersion(value) {
  const match = String(value || '').match(/\d+(?:\.\d+)*/);
  return match ? match[0] : null;
}

function reason(error) {
  if (error && error.name === 'AbortError') return '请求超时';
  return (error && error.message) || String(error || '未知错误');
}

async function fetchJson(url, opts = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('版本查询端点必须使用 HTTPS');
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  if (controller) {
    timer = setTimeout(() => controller.abort(), opts.timeoutMs || UPDATE.PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'khy-os-version-check/1' },
      signal: controller && controller.signal,
    });
    if (!response || !response.ok) {
      throw new Error(`HTTP ${(response && response.status) || 'unknown'}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

function githubRepositoryApiUrl(repository, env = process.env) {
  return env.KHY_UPDATE_GITHUB_REPOSITORY_API || `https://api.github.com/repos/${repository}`;
}

function githubManifestUrl(repository, branch, env = process.env) {
  const base = String(env.KHY_UPDATE_GITHUB_RAW_BASE_URL || UPDATE.GITHUB_RAW_BASE_URL).replace(/\/$/, '');
  const manifestPath = String(
    env.KHY_UPDATE_GITHUB_VERSION_MANIFEST_PATH || UPDATE.GITHUB_VERSION_MANIFEST_PATH
  )
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${base}/${repository}/${encodeURIComponent(branch)}/${manifestPath}`;
}

function highestReleaseVersion(releases) {
  if (!Array.isArray(releases)) return { version: null, raw: null };
  let best = null;
  let bestRaw = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const raw = release.tag_name || release.name;
    const version = numericVersion(raw);
    if (version && (!best || _compare(version, best) > 0)) {
      best = version;
      bestRaw = raw;
    }
  }
  return { version: best, raw: bestRaw };
}

/**
 * GitHub's published version is the higher of its formal Release and its default branch manifest.
 * The latter matters when `release: vX` has landed in main before a Release/tag is created.
 */
async function probeGithub(opts = {}) {
  const env = opts.env || process.env;
  const repository = env.KHY_UPDATE_GITHUB_REPOSITORY || UPDATE.GITHUB_REPOSITORY;
  const [releaseResult, repositoryResult] = await Promise.allSettled([
    fetchJson(_router()._githubApiUrl(repository, env), opts),
    fetchJson(githubRepositoryApiUrl(repository, env), opts),
  ]);
  const release = releaseResult.status === 'fulfilled'
    ? highestReleaseVersion(releaseResult.value)
    : { version: null, raw: null };
  const releaseError = releaseResult.status === 'rejected'
    ? reason(releaseResult.reason)
    : Array.isArray(releaseResult.value) && releaseResult.value.length === 0
      ? '仓库没有已发布 Release'
      : '没有可用的正式 Release';
  const defaultBranch = repositoryResult.status === 'fulfilled'
    ? repositoryResult.value && repositoryResult.value.default_branch
    : null;
  let branchVersion = null;
  let branchRaw = null;
  let branchError = null;
  if (defaultBranch) {
    try {
      const manifest = await fetchJson(githubManifestUrl(repository, defaultBranch, env), opts);
      branchRaw = manifest && manifest.version;
      branchVersion = numericVersion(branchRaw);
      if (!branchVersion) branchError = '默认分支版本清单缺少 version';
    } catch (error) {
      branchError = reason(error);
    }
  } else if (repositoryResult.status === 'rejected') {
    branchError = reason(repositoryResult.reason);
  } else {
    branchError = '仓库元数据缺少默认分支';
  }

  const winner = branchVersion && (!release.version || _compare(branchVersion, release.version) > 0)
    ? { version: branchVersion, raw: branchRaw }
    : release;
  const errors = [];
  if (!release.version) {
    errors.push(releaseError);
  }
  if (!branchVersion && branchError) errors.push(`默认分支: ${branchError}`);
  return {
    version: winner.version,
    raw: winner.raw,
    label: branchVersion && (!release.version || _compare(branchVersion, release.version) > 0)
      ? `GitHub ${defaultBranch || 'default branch'}`
      : 'GitHub Releases',
    repository,
    defaultBranch: defaultBranch || null,
    releaseVersion: release.version,
    branchVersion,
    error: winner.version ? null : errors.join('; ') || '没有可用的 GitHub 版本',
  };
}

/** PyPI 上首个能取到版本的候选包(白名单顺序,与自升级用的包一致)。 */
async function probePypi(opts = {}) {
  const candidates = require('./versionService').PACKAGE_CANDIDATES;
  const base = String(UPDATE.PYPI_BASE_URL).replace(/\/$/, '');
  const errors = [];
  for (const name of candidates) {
    try {
      const meta = await fetchJson(`${base}/${encodeURIComponent(name)}/json`, opts);
      const raw = meta && meta.info && meta.info.version;
      const version = numericVersion(raw);
      if (version) return { version, raw, package: name };
      errors.push(`${name}: 元数据缺少 version`);
    } catch (error) {
      errors.push(`${name}: ${reason(error)}`);
    }
  }
  return { version: null, error: errors.join('; ') || '没有可查的 PyPI 包' };
}

/** npm registry 上 @khy-os/khy-os 的 latest tag。 */
async function probeNpm(opts = {}) {
  const name = require('./khySelfUpdateService').NPM_PACKAGE;
  const base = String(UPDATE.NPM_REGISTRY_URL).replace(/\/$/, '');
  const meta = await fetchJson(`${base}/${encodeURIComponent(name)}/latest`, opts);
  const raw = meta && meta.version;
  const version = numericVersion(raw);
  if (!version) return { version: null, error: 'npm 元数据缺少 version', package: name };
  return { version, raw, package: name };
}

const DEFAULT_PROBES = Object.freeze({
  github: probeGithub,
  pypi: probePypi,
  npm: probeNpm,
});

/**
 * 并行查三个仓库并选出最高版本。只读、绝不抛。
 *
 * @param {object} [opts] { env?, fetch?, timeoutMs?, probes? } —— probes 供测试注入。
 * @returns {Promise<{latest:string|null, source:string|null, sourceLabel:string|null,
 *   sources:Array<{channel,label,enabled,version,raw,error}>, indeterminate:boolean, text:string}>}
 */
async function resolveLatestVersion(opts = {}) {
  const env = opts.env || process.env;
  const probes = opts.probes || DEFAULT_PROBES;
  const sources = await Promise.all(
    SOURCES.map(async (channel) => {
      const base = { channel, label: LABELS[channel], enabled: true, version: null, raw: null, error: null };
      if (!_router().isChannelEnabled(channel, env)) {
        return { ...base, enabled: false, error: '渠道已禁用' };
      }
      const probe = probes[channel] || DEFAULT_PROBES[channel];
      if (typeof probe !== 'function') return { ...base, error: '没有该渠道的探测实现' };
      try {
        const probed = (await probe({ ...opts, env, channel })) || {};
        return {
          ...base,
          ...(probed.label ? { label: probed.label } : {}),
          version: probed.version || null,
          raw: probed.raw || probed.version || null,
          error: probed.version ? null : probed.error || '未取到版本',
          ...(probed.package ? { package: probed.package } : {}),
          ...(probed.repository ? { repository: probed.repository } : {}),
        };
      } catch (error) {
        return { ...base, error: reason(error) };
      }
    })
  );

  let winner = null;
  for (const source of sources) {
    if (!source.version) continue;
    if (!winner || _compare(source.version, winner.version) > 0) winner = source;
  }
  return {
    latest: winner ? winner.version : null,
    source: winner ? winner.channel : null,
    sourceLabel: winner ? winner.label : null,
    sources,
    indeterminate: !winner,
    text: formatSources(sources),
  };
}

/** 把每个源的结果渲染成一行可读文本:`GitHub Releases v1.1.10 · PyPI v0.1.29 · npm 请求超时`。 */
function formatSources(sources = []) {
  return sources
    .map((source) => `${source.label} ${source.version ? `v${source.version}` : source.error || '未取到版本'}`)
    .join(' · ');
}

module.exports = {
  SOURCES,
  LABELS,
  resolveLatestVersion,
  formatSources,
  // 供测试(非稳定 API)。
  _numericVersion: numericVersion,
  _probeGithub: probeGithub,
  _probePypi: probePypi,
  _probeNpm: probeNpm,
};
