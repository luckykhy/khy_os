'use strict';

const { UPDATE } = require('../constants/serviceDefaults');
const versionService = require('./versionService');

const SOURCE_CHANNELS = Object.freeze(['github', 'pypi', 'npm', 'local']);
const OFF = new Set(['0', 'false', 'off', 'no']);
const ENV_KEYS = Object.freeze({
  github: 'KHY_UPDATE_ENABLE_GITHUB',
  pypi: 'KHY_UPDATE_ENABLE_PYPI',
  npm: 'KHY_UPDATE_ENABLE_NPM',
  local: 'KHY_UPDATE_ENABLE_LOCAL',
});

function isChannelEnabled(channel, env = process.env) {
  if (!SOURCE_CHANNELS.includes(channel)) return false;
  if (OFF.has(String((env && env.KHY_SELF_UPDATE) || '').trim().toLowerCase())) return false;
  return !OFF.has(String((env && env[ENV_KEYS[channel]]) || '').trim().toLowerCase());
}

function elapsedReason(error) {
  if (error && error.code === 'UPDATE_PROBE_TIMEOUT') return error.message;
  return (error && error.message) || String(error || 'unknown error');
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} 超时 (${Math.ceil(timeoutMs / 1000)}s)`);
  error.code = 'UPDATE_PROBE_TIMEOUT';
  return error;
}

async function withTimeout(task, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function baseResult(channel, index, enabled) {
  return {
    channel,
    enabled,
    status: enabled ? 'checking' : 'disabled',
    action: '检查',
    target: channel === 'local' ? '本地打包快照' : channelLabel(channel),
    progress: `${index + 1}/${SOURCE_CHANNELS.length}`,
    currentVersion: null,
    targetVersion: null,
    reason: enabled ? null : '渠道已禁用',
    detail: null,
  };
}

function channelLabel(channel) {
  return {
    github: 'GitHub Releases',
    pypi: 'PyPI',
    npm: 'npm',
    local: '本地副本',
  }[channel] || channel;
}

function normalizeProbeResult(channel, index, enabled, result = {}) {
  return {
    ...baseResult(channel, index, enabled),
    ...result,
    channel,
    enabled,
    progress: `${index + 1}/${SOURCE_CHANNELS.length}`,
  };
}

function githubApiUrl(repository, env = process.env) {
  if (!repository || repository === UPDATE.GITHUB_REPOSITORY) return UPDATE.GITHUB_RELEASES_API;
  const configured = env.KHY_UPDATE_GITHUB_RELEASES_API;
  return configured || `https://api.github.com/repos/${repository}/releases`;
}

async function fetchJson(url, opts = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('更新端点必须使用 HTTPS');
  const fetchImpl = opts.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时没有 fetch');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  if (controller) {
    timer = setTimeout(() => controller.abort(), opts.timeoutMs || UPDATE.PROBE_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  try {
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'khy-os-updater/1' },
      signal: opts.signal || (controller && controller.signal),
    });
    if (!response || !response.ok) {
      const status = response && response.status;
      const error = new Error(`HTTP ${status || 'unknown'}`);
      error.status = status;
      throw error;
    }
    return response.json();
  } catch (error) {
    if (error && error.name === 'AbortError') throw timeoutError(channelLabel(opts.channel), opts.timeoutMs || UPDATE.PROBE_TIMEOUT_MS);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function releaseMatchesTrack(release, track) {
  if (!release || release.draft) return false;
  if (track === 'stable') return !release.prerelease;
  if (track === 'preview') return !!release.prerelease && release.tag_name !== 'dev-channel';
  return release.tag_name === 'dev-channel';
}

function assetFromRelease(release, name) {
  return Array.isArray(release && release.assets)
    ? release.assets.find(asset => asset && asset.name === name)
    : null;
}

function selectGithubPackageArtifacts(index, installation) {
  if (!installation || installation.type !== 'package') return null;
  const selected = {};
  for (const channel of ['pip', 'npm']) {
    const installed = installation.packages && installation.packages[channel];
    if (!installed) continue;
    const advertised = index.packages && index.packages[channel];
    if (!advertised || advertised.name !== installed.name || !advertised.artifact) {
      return null;
    }
    selected[channel] = advertised.artifact;
  }
  return Object.keys(selected).length > 0 ? selected : null;
}

async function probeGithub(context, opts = {}) {
  if (context.installation.type === 'git') {
    const coordinator = opts.coordinator || require('./updateCoordinator');
    const result = coordinator.getGitStatus(context.installation, opts);
    if (result.blocked) return { status: 'blocked', reason: result.reason, detail: result };
    if (result.indeterminate) throw new Error(result.error || 'git remote status is unavailable');
    return {
      status: result.available ? 'available' : 'no-update',
      currentVersion: context.installation.version,
      targetVersion: context.installation.version,
      targetCommit: result.targetCommit || null,
      reason: result.available ? '远端分支存在可快进提交' : '当前分支已是最新',
      detail: result,
    };
  }
  const repository = (context.env && context.env.KHY_UPDATE_GITHUB_REPOSITORY) || UPDATE.GITHUB_REPOSITORY;
  const releases = await fetchJson(githubApiUrl(repository, context.env), { ...opts, channel: 'github' });
  const release = Array.isArray(releases)
    ? releases.find(item => releaseMatchesTrack(item, context.releaseChannel))
    : null;
  if (!release) return { status: 'unavailable', reason: '所选轨道没有可用 Release' };

  const indexName = `update-index-${context.releaseChannel}.json`;
  const asset = assetFromRelease(release, indexName);
  if (!asset || !/^https:\/\//i.test(asset.browser_download_url || '')) {
    return { status: 'unavailable', reason: `Release 缺少 ${indexName}` };
  }
  const index = await fetchJson(asset.browser_download_url, { ...opts, channel: 'github' });
  const validation = require('./updateIndexProtocol').validateUpdateIndex(index, {
    channel: context.releaseChannel,
  });
  if (!validation.ok) throw new Error(`更新索引校验失败: ${validation.errors.join('; ')}`);
  const targetVersion = index.release.version;
  if (versionService.compareVersions(targetVersion, context.installation.version) <= 0) {
    return {
      status: 'no-update',
      currentVersion: context.installation.version,
      targetVersion,
      reason: '目标版本不高于当前版本',
      detail: { releaseTag: release.tag_name, index },
    };
  }

  let artifact = null;
  let packageArtifacts = null;
  if (context.installation.type === 'portable') {
    artifact = require('./domain/network/updateAdapters/portableAdapter')._selectArtifact(index, context.installation);
  } else if (context.installation.type === 'package') {
    packageArtifacts = selectGithubPackageArtifacts(index, context.installation);
    if (!packageArtifacts) {
      return {
        status: 'unavailable',
        currentVersion: context.installation.version,
        targetVersion,
        reason: 'Release 索引缺少当前安装渠道的 GitHub 构件',
        detail: { releaseTag: release.tag_name, index },
      };
    }
  }
  return {
    status: 'available',
    currentVersion: context.installation.version,
    targetVersion,
    reason: '发现更高版本',
    detail: { releaseTag: release.tag_name, index, artifact, packageArtifacts },
  };
}

async function probePypi(context, opts = {}) {
  if (context.installation.type !== 'package' || !context.installation.packages?.pip) {
    return { status: 'unavailable', reason: '当前安装形态未安装 pip 渠道' };
  }
  const selfUpdate = opts.selfUpdate || require('./khySelfUpdateService');
  const result = await selfUpdate.checkUpdate({
    env: context.env,
    _exec: opts.exec,
    _fetch: opts.fetch,
  });
  if (result.disabled) return { status: 'disabled', reason: result.error || '自更新已禁用' };
  if (!result.success || result.indeterminate) {
    throw new Error(result.notice || result.error || 'PyPI 返回不确定结果');
  }
  return {
    status: result.updateAvailable ? 'available' : 'no-update',
    currentVersion: result.current,
    targetVersion: result.latest,
    reason: result.updateAvailable ? '发现更高版本' : '目标版本不高于当前版本',
    detail: result,
  };
}

async function probeNpm(context, opts = {}) {
  if (context.installation.type !== 'package' || !context.installation.packages?.npm) {
    return { status: 'unavailable', reason: '当前安装形态未安装 npm 渠道' };
  }
  const packageName = (opts.selfUpdate || require('./khySelfUpdateService')).NPM_PACKAGE;
  const base = String(UPDATE.NPM_REGISTRY_URL).replace(/\/$/, '');
  const metadata = await fetchJson(`${base}/${encodeURIComponent(packageName)}/latest`, {
    ...opts,
    channel: 'npm',
  });
  const targetVersion = metadata && metadata.version;
  if (!targetVersion) throw new Error('npm 元数据缺少 version');
  const installed = context.installation.packages && context.installation.packages.npm;
  const currentVersion = installed ? installed.version : context.installation.version;
  const available = versionService.compareVersions(targetVersion, currentVersion) > 0;
  return {
    status: available ? 'available' : 'no-update',
    currentVersion,
    targetVersion,
    reason: available ? '发现更高版本' : '目标版本不高于当前版本',
    detail: { package: packageName },
  };
}

async function probeLocal(context, opts = {}) {
  const heal = opts.sourceHeal || require('./sourceHealService');
  const result = await Promise.resolve(heal.runStartupHeal({
    env: context.env,
    force: true,
    deep: true,
    silent: true,
  }));
  if (!result || !result.ok) throw new Error((result && result.error) || '本地快照验证失败');
  const healed = Number(result.healed || 0);
  return {
    status: healed > 0 ? 'repaired' : result.reason === 'no-snapshot' ? 'unavailable' : 'healthy-no-update',
    currentVersion: context.installation.version,
    targetVersion: context.installation.version,
    reason: healed > 0 ? `已修复 ${healed} 个程序文件` : result.reason === 'no-snapshot' ? '没有可用的本地打包快照' : '本地程序文件完整',
    detail: result,
  };
}

const DEFAULT_PROBES = Object.freeze({
  github: probeGithub,
  pypi: probePypi,
  npm: probeNpm,
  local: probeLocal,
});

function selectedSource(result) {
  return result && ['available', 'repaired'].includes(result.status);
}

async function checkAllChannels(opts = {}) {
  const env = opts.env || process.env;
  const coordinator = opts.coordinator || require('./updateCoordinator');
  const installation = opts.installation || coordinator.detectInstallation(opts);
  const releaseChannel = coordinator.normalizeChannel(
    opts.channel || env.KHY_UPDATE_CHANNEL,
    installation.channel
  );
  const channelResults = [];
  const degradation = [];
  const startedAt = Date.now();
  let best = null;

  for (let index = 0; index < SOURCE_CHANNELS.length; index += 1) {
    const channel = SOURCE_CHANNELS[index];
    const enabled = isChannelEnabled(channel, env);
    if (!enabled) {
      channelResults.push(baseResult(channel, index, false));
      continue;
    }
    const remaining = UPDATE.PROBE_TOTAL_TIMEOUT_MS - (Date.now() - startedAt);
    if (remaining <= 0) {
      const result = normalizeProbeResult(channel, index, true, {
        status: 'unavailable', reason: `整体探测超时 (${Math.ceil(UPDATE.PROBE_TOTAL_TIMEOUT_MS / 1000)}s)`,
      });
      channelResults.push(result);
      degradation.push({ channel, reason: result.reason });
      continue;
    }
    const probe = (opts.probes && opts.probes[channel]) || DEFAULT_PROBES[channel];
    try {
      const probed = await withTimeout(
        () => probe({ env, installation, releaseChannel }, opts),
        Math.min(UPDATE.PROBE_TIMEOUT_MS, remaining),
        channelLabel(channel)
      );
      const result = normalizeProbeResult(channel, index, true, probed);
      channelResults.push(result);
      if (selectedSource(result)) {
        best = result;
        break;
      }
      degradation.push({ channel, reason: result.reason || '没有可用更新' });
    } catch (error) {
      const result = normalizeProbeResult(channel, index, true, {
        status: 'unavailable', reason: elapsedReason(error),
      });
      channelResults.push(result);
      degradation.push({ channel, reason: result.reason });
    }
  }

  return {
    available: !!best && best.status === 'available',
    repaired: !!best && best.status === 'repaired',
    source: best ? best.channel : null,
    releaseChannel,
    current: installation.version || null,
    target: best ? best.targetVersion : null,
    targetCommit: best ? best.targetCommit || null : null,
    installation,
    channelResults,
    degradation,
    detail: best && best.detail,
  };
}

async function applyFromBestChannel(opts = {}) {
  const coordinator = opts.coordinator || require('./updateCoordinator');
  const checked = opts.checked || await checkAllChannels(opts);
  if (!checked.available) return { ...checked, applied: false };
  let state = opts.state || await coordinator.checkUpdate({
    ...opts,
    force: true,
    channel: checked.releaseChannel,
    channelCheck: checked,
  });
  if (state.state === 'available') state = await coordinator.stageUpdate({ ...opts, state });
  if (state.state !== 'staged') return { ...checked, applied: false, state };
  const applied = await coordinator.applyUpdate({ ...opts, state });
  return { ...checked, applied: applied.state === 'applied', state: applied };
}

module.exports = {
  SOURCE_CHANNELS,
  isChannelEnabled,
  checkAllChannels,
  applyFromBestChannel,
  _channelLabel: channelLabel,
  _githubApiUrl: githubApiUrl,
  _probeGithub: probeGithub,
  _probePypi: probePypi,
  _probeNpm: probeNpm,
  _probeLocal: probeLocal,
  _selectGithubPackageArtifacts: selectGithubPackageArtifacts,
  _withTimeout: withTimeout,
};
