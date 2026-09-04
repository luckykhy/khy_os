'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const StreamZip = require('node-stream-zip');
const { requireFromProvider } = require('../../extensions/extensions/providerModule');
const { validateUpdateIndex } = require('../../../updateIndexProtocol');

const { UPDATE } = require('../../../../constants/serviceDefaults');

// 便携版产物的校验件已迁为拓展（khy-portable，服务名 portable-artifact）。这里**惰性**解析，
// 且缺席时 **fail-closed**：这两个函数是更新落地前的校验闸，跳过它们就等于装一个没验过的
// 更新——那比「更新失败」严重得多。所以拓展缺席报错，不降级、不静默放行。
function _portableArtifact(file) {
  const mod = requireFromProvider('portable-artifact', file);
  if (!mod) {
    throw new Error(
      `portable update requires a provider of the "portable-artifact" service (${file}); ` +
        'none is installed, so the artifact cannot be verified'
    );
  }
  return mod;
}

function verifyArtifactManifest(target) {
  return _portableArtifact('artifact-manifest.js').verifyArtifactManifest(target);
}

function normalizeTarget(platform, arch) {
  return _portableArtifact('artifact-manifest.js').normalizeTarget(platform, arch);
}

function runHealthCheck(options) {
  return _portableArtifact('portable-health-check.js').runHealthCheck(options);
}

function rootFor(state, opts = {}) {
  const base = opts.cacheDir || path.join(require('../../../../utils/dataHome').getDataHome(), 'updates', 'cache');
  const target = state.target && (state.target.version || state.target.commit) || 'unknown';
  return path.join(base, 'portable', String(target).replace(/[^A-Za-z0-9._-]/g, '_'));
}

function platformTarget() {
  return normalizeTarget(process.platform, process.arch === 'arm64' ? 'arm64' : 'x64');
}

function repositoryUrls(env = process.env) {
  const repository = env.KHY_UPDATE_GITHUB_REPOSITORY || UPDATE.GITHUB_REPOSITORY;
  const releaseBase = `https://github.com/${repository}/releases`;
  return {
    releasesApi: env.KHY_UPDATE_GITHUB_RELEASES_API || (repository === UPDATE.GITHUB_REPOSITORY
      ? UPDATE.GITHUB_RELEASES_API
      : `https://api.github.com/repos/${repository}/releases`),
    indexUrls: {
      stable: `${releaseBase}/latest/download/update-index-stable.json`,
      dev: `${releaseBase}/download/dev-channel/update-index-dev.json`,
    },
  };
}

async function fetchResponse(url, init, opts = {}) {
  const fetchImpl = opts.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('portable update requires fetch');
  return fetchImpl(url, init);
}

async function fetchJson(url, opts = {}) {
  const response = await fetchResponse(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'khy-os-updater/1' },
    signal: opts.signal,
  }, opts);
  if (!response || !response.ok) throw new Error(`update index request failed: HTTP ${response && response.status}`);
  return response.json();
}

async function resolveIndexUrl(channel, opts = {}) {
  const configured = opts.indexUrl || (opts.env || process.env).KHY_UPDATE_INDEX_URL;
  const defaults = repositoryUrls(opts.env || process.env);
  if (configured) {
    if (!/^https:\/\//i.test(configured)) throw new Error('portable update index URL must use HTTPS');
    return configured;
  }
  if (defaults.indexUrls[channel]) return defaults.indexUrls[channel];
  const releases = await fetchJson(defaults.releasesApi, opts);
  const release = Array.isArray(releases)
    ? releases.find(item => item && item.prerelease && !item.draft && Array.isArray(item.assets) &&
      item.assets.some(asset => asset && asset.name === 'update-index-preview.json'))
    : null;
  const asset = release && release.assets.find(item => item && item.name === 'update-index-preview.json');
  if (!asset || !/^https:\/\//i.test(asset.browser_download_url || '')) {
    throw new Error('preview update index is unavailable');
  }
  return asset.browser_download_url;
}

async function downloadFile(url, destination, expected, opts = {}) {
  if (!/^https:\/\//i.test(url)) throw new Error('portable artifact URL must use HTTPS');
  const response = await fetchResponse(url, { signal: opts.signal }, opts);
  if (!response || !response.ok || !response.body) throw new Error(`portable artifact request failed: HTTP ${response && response.status}`);
  const temporary = `${destination}.${process.pid}.tmp`;
  const hash = crypto.createHash('sha256');
  const idleTimeoutMs = Number(opts.downloadIdleTimeoutMs || UPDATE.DOWNLOAD_IDLE_TIMEOUT_MS);
  let size = 0;
  let startedAt = Date.now();
  const output = fs.createWriteStream(temporary, { flags: 'wx' });
  try {
    if (typeof response.body.getReader === 'function') {
      const reader = response.body.getReader();
      for (;;) {
        let timer;
        const read = reader.read();
        const idle = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`portable download idle timeout (${Math.ceil(idleTimeoutMs / 1000)}s)`)), idleTimeoutMs);
          if (typeof timer.unref === 'function') timer.unref();
        });
        let packet;
        try {
          packet = await Promise.race([read, idle]);
        } catch (error) {
          try { await reader.cancel(error.message); } catch { /* best effort */ }
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (packet.done) break;
        const chunk = Buffer.from(packet.value);
        size += chunk.length;
        hash.update(chunk);
        if (!output.write(chunk)) await new Promise(resolve => output.once('drain', resolve));
        if (typeof opts.onProgress === 'function') {
          const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
          opts.onProgress({ size, rate: Math.round(size / elapsedSeconds) });
        }
      }
    } else if (typeof response.arrayBuffer === 'function') {
      const chunk = Buffer.from(await response.arrayBuffer());
      size = chunk.length;
      hash.update(chunk);
      output.write(chunk);
    } else {
      throw new Error('portable artifact response body is unreadable');
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    if (Number.isSafeInteger(expected.size) && size !== expected.size) throw new Error('portable artifact size mismatch');
    const digest = hash.digest('hex');
    if (digest !== String(expected.sha256).toLowerCase()) throw new Error('portable artifact sha256 mismatch');
    fs.renameSync(temporary, destination);
    return { size, sha256: digest };
  } catch (error) {
    output.destroy();
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

async function extractZip(zipPath, destination) {
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const entries = await zip.entries();
    for (const entry of Object.values(entries)) {
      const name = String(entry.name || '').replace(/\\/g, '/');
      if (!name || name.startsWith('/') || name.split('/').includes('..')) throw new Error(`portable archive path escapes root: ${name}`);
      const target = path.resolve(destination, ...name.split('/'));
      if (target !== path.resolve(destination) && !target.startsWith(path.resolve(destination) + path.sep)) throw new Error(`portable archive path escapes root: ${name}`);
      if (entry.isDirectory) fs.mkdirSync(target, { recursive: true });
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zip.extract(entry.name, target);
      }
    }
  } finally {
    await zip.close();
  }
}

function locatePayload(root) {
  if (fs.existsSync(path.join(root, 'MANIFEST.json'))) return root;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const dirs = entries.filter(entry => entry.isDirectory()).map(entry => path.join(root, entry.name));
  const match = dirs.find(dir => fs.existsSync(path.join(dir, 'MANIFEST.json')));
  return match || null;
}

function selectArtifact(index, installation, opts = {}) {
  const target = platformTarget();
  const kind = installation.kind || 'portable-runtime';
  const matches = (index.portable || []).filter(item => item.kind === kind && item.target.platform === target.platform && item.target.arch === target.arch);
  if (matches.length !== 1) throw new Error(`no unique portable artifact for ${target.platform}-${target.arch}/${kind}`);
  const artifact = matches[0];
  if (artifact.version !== index.release.version || artifact.commit !== index.release.commit) throw new Error('portable index artifact does not match release metadata');
  return artifact;
}

async function checkPortable(installation, opts = {}) {
  try {
    const indexUrl = await resolveIndexUrl(opts.channel || installation.channel || 'stable', opts);
    const index = await fetchJson(indexUrl, opts);
    const validation = validateUpdateIndex(index, { channel: opts.channel });
    if (!validation.ok) return { indeterminate: true, error: `invalid portable update index: ${validation.errors.join('; ')}` };
    const artifact = selectArtifact(index, installation, opts);
    const current = installation.version || '0.0.0';
    const compare = require('../../../versionService').compareVersions;
    return {
      available: compare(index.release.version, current) > 0,
      current,
      targetVersion: index.release.version,
      targetCommit: index.release.commit,
      detail: { index, artifact },
    };
  } catch (error) {
    return { indeterminate: true, error: error.message };
  }
}

async function stagePortable(installation, opts = {}) {
  const indexUrl = opts.indexUrl || (opts.index ? null : await resolveIndexUrl(opts.channel || installation.channel || 'stable', opts));
  const index = opts.index || await fetchJson(indexUrl, opts);
  const validation = validateUpdateIndex(index, { channel: opts.channel });
  if (!validation.ok) return { success: false, error: `invalid portable update index: ${validation.errors.join('; ')}` };
  const artifact = opts.artifact || selectArtifact(index, installation, opts);
  const root = rootFor({ target: { version: index.release.version } }, opts);
  const downloadDir = path.join(root, 'download');
  const extractDir = path.join(root, 'payload');
  try {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(downloadDir, { recursive: true });
    const archive = path.join(downloadDir, path.basename(new URL(artifact.url).pathname) || 'portable.zip');
    await downloadFile(artifact.url, archive, artifact, opts);
    fs.mkdirSync(extractDir, { recursive: true });
    await extractZip(archive, extractDir);
    const payload = locatePayload(extractDir);
    if (!payload) throw new Error('portable archive has no MANIFEST.json payload');
    const manifest = await verifyArtifactManifest(payload);
    if (!manifest.ok) throw new Error(`portable manifest verification failed: ${manifest.issues.join('; ')}`);
    if (manifest.manifest.version !== index.release.version || manifest.manifest.source?.commit !== index.release.commit) throw new Error('portable manifest does not match update index');
    const descriptor = { schemaVersion: 1, type: 'portable', version: index.release.version, commit: index.release.commit, root: payload, archive, artifact };
    const descriptorPath = path.join(root, 'STAGED.json');
    fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    return { success: true, path: descriptorPath, detail: descriptor };
  } catch (error) {
    return { success: false, path: root, error: error.message };
  }
}

function copyState(oldRoot, newRoot) {
  const source = path.join(oldRoot, 'state');
  const target = path.join(newRoot, 'state');
  if (fs.existsSync(source)) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(source, target, { recursive: true });
  }
}

function isWindowsLockError(error, opts = {}) {
  const platform = opts.platform || process.platform;
  return platform === 'win32' && !!error && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
}

function scheduleDeferredSwap({ live, incoming, backup }, opts = {}) {
  if (typeof opts.scheduleDeferredSwap === 'function') {
    return {
      ...opts.scheduleDeferredSwap({ live, incoming, backup, parentPid: process.pid }),
      live,
      incoming,
      backup,
    };
  }
  const token = `${process.pid}-${Date.now()}`;
  const scriptPath = path.join(path.dirname(live), `.khy-update-${token}.ps1`);
  const resultPath = path.join(path.dirname(live), `.khy-update-${token}.json`);
  const script = [
    'param([int]$ParentPid, [string]$Live, [string]$Incoming, [string]$Backup, [string]$Result)',
    '$ErrorActionPreference = "Stop"',
    'try { Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue } catch {}',
    'try {',
    '  $LiveExists = Test-Path -LiteralPath $Live',
    '  $BackupExists = Test-Path -LiteralPath $Backup',
    '  if ($LiveExists) {',
    '    if ($BackupExists) { Remove-Item -LiteralPath $Backup -Recurse -Force }',
    '    Move-Item -LiteralPath $Live -Destination $Backup',
    '  } elseif (-not $BackupExists) {',
    '    throw "Neither the active nor backup portable directory exists."',
    '  }',
    '  try { Move-Item -LiteralPath $Incoming -Destination $Live } catch {',
    '    Move-Item -LiteralPath $Backup -Destination $Live',
    '    throw',
    '  }',
    '  @{ success = $true; backup = $Backup; completedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding UTF8',
    '} catch {',
    '  @{ success = $false; error = $_.Exception.Message; completedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $Result -Encoding UTF8',
    '}',
    'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
  ].join('\r\n');
  fs.writeFileSync(scriptPath, script, 'utf8');
  const spawnImpl = opts.spawn || spawn;
  const child = spawnImpl('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', scriptPath,
    '-ParentPid', String(process.pid),
    '-Live', live,
    '-Incoming', incoming,
    '-Backup', backup,
    '-Result', resultPath,
  ], { detached: true, stdio: 'ignore', windowsHide: true });
  if (child && typeof child.unref === 'function') child.unref();
  return { scheduled: true, resultPath, live, incoming, backup };
}

function scheduleDeferredRollback({ live, backup }, opts = {}) {
  if (!live || !backup) return { scheduled: false, error: 'deferred rollback paths are missing' };
  const rollbackBackup = `${live}.khy-rollback-${process.pid}-${Date.now()}`;
  return scheduleDeferredSwap({ live, incoming: backup, backup: rollbackBackup }, opts);
}

async function applyPortable(state, opts = {}) {
  const descriptor = JSON.parse(fs.readFileSync(state.stagedPath, 'utf8'));
  if (descriptor.schemaVersion !== 1 || descriptor.type !== 'portable' || descriptor.version !== state.target.version || !fs.existsSync(descriptor.root)) return { success: false, error: 'staged portable descriptor is invalid' };
  const live = state.source.root;
  const parent = path.dirname(live);
  const backup = path.join(parent, `.khy-old-${process.pid}-${Date.now()}`);
  const incoming = path.join(parent, `.khy-new-${process.pid}`);
  let postApplyStarted = false;
  let postApplyResult = null;
  try {
    fs.rmSync(incoming, { recursive: true, force: true });
    fs.cpSync(descriptor.root, incoming, { recursive: true });
    const verification = await verifyArtifactManifest(incoming);
    if (!verification.ok) throw new Error(`portable manifest verification failed: ${verification.issues.join('; ')}`);
    copyState(live, incoming);
    const healthCheck = typeof opts.healthCheck === 'function'
      ? opts.healthCheck
      : async root => (await runHealthCheck({ artifactRoot: root })).ok;
    if (!(await healthCheck(incoming))) throw new Error('portable health check failed');
    try {
      fs.renameSync(live, backup);
      try {
        fs.renameSync(incoming, live);
      } catch (error) {
        if (isWindowsLockError(error, opts)) {
          const deferred = scheduleDeferredSwap({ live, incoming, backup }, opts);
          return {
            success: true,
            changed: false,
            deferred: true,
            pendingRestart: true,
            to: descriptor.version,
            detail: deferred,
          };
        }
        fs.renameSync(backup, live);
        throw error;
      }
    } catch (error) {
      if (isWindowsLockError(error, opts)) {
        const deferred = scheduleDeferredSwap({ live, incoming, backup }, opts);
        return {
          success: true,
          changed: false,
          deferred: true,
          pendingRestart: true,
          to: descriptor.version,
          detail: deferred,
        };
      }
      throw error;
    }
    const postApply = typeof opts.postApply === 'function' ? opts.postApply : null;
    if (postApply) {
      postApplyStarted = true;
      postApplyResult = await postApply({ live, backup, incoming, descriptor, state });
      if (!postApplyResult || postApplyResult.success === false) {
        throw new Error((postApplyResult && postApplyResult.error) || 'portable post-apply validation failed');
      }
    }
    fs.rmSync(backup, { recursive: true, force: true });
    return { success: true, changed: true, to: descriptor.version, postApply: postApplyResult };
  } catch (error) {
    fs.rmSync(incoming, { recursive: true, force: true });
    if (fs.existsSync(backup)) {
      fs.rmSync(live, { recursive: true, force: true });
      fs.renameSync(backup, live);
    }
    if (postApplyStarted && typeof opts.rollbackPostApply === 'function') {
      try { await opts.rollbackPostApply(); } catch { /* preserve original failure */ }
    }
    return { success: false, error: error.message };
  }
}

module.exports = {
  checkPortable,
  stagePortable,
  applyPortable,
  _extractZip: extractZip,
  _selectArtifact: selectArtifact,
  _resolveIndexUrl: resolveIndexUrl,
  _downloadFile: downloadFile,
  _rootFor: rootFor,
  _scheduleDeferredRollback: scheduleDeferredRollback,
};
