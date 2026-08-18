'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const { UPDATE } = require('../../constants/serviceDefaults');

const PIP_EXTENSIONS = ['.whl', '.tar.gz', '.zip'];

function safeSegment(value) {
  return String(value || '').replace(/[^A-Za-z0-9._-]/g, '_');
}

function cacheRoot(state, opts = {}) {
  const base = opts.cacheDir || path.join(require('../../utils/dataHome').getDataHome(), 'updates', 'cache');
  const target = state.target && (state.target.version || state.target.commit);
  return path.join(base, 'package', safeSegment(target || 'unknown'));
}

function run(file, args, opts = {}) {
  if (typeof opts.execFile === 'function') return opts.execFile(file, args, opts);
  return execFileSync(file, args, {
    encoding: 'utf8',
    timeout: opts.timeoutMs || 180000,
    env: opts.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function normalizedDistribution(name) {
  return String(name || '').toLowerCase().replace(/[-_.]+/g, '-');
}

function findPipArtifact(files, packageName, version) {
  const pkg = normalizedDistribution(packageName).replace(/-/g, '_');
  const rawVersion = String(version || '').toLowerCase();
  const versionVariants = new Set([rawVersion, rawVersion.replace(/\./g, '_'), rawVersion.replace(/\./g, '-')]);
  return (files || []).find((name) => {
    const lower = String(name).toLowerCase();
    const stem = lower.endsWith('.tar.gz') ? lower.slice(0, -7) : lower.replace(/\.(?:whl|zip)$/i, '');
    const normalizedStem = stem.replace(/[-_.]+/g, '_');
    return PIP_EXTENSIONS.some(ext => lower.endsWith(ext)) &&
      Array.from(versionVariants).some(v => normalizedStem.startsWith(`${pkg}_${v}_`) || normalizedStem.startsWith(`${pkg}_${v}`));
  }) || null;
}

function findNpmArtifact(files, version) {
  const suffix = `-${String(version || '').toLowerCase()}.tgz`;
  return (files || []).find(name => String(name).toLowerCase().endsWith(suffix)) || null;
}

function packageArtifactFilename(artifact) {
  const fromUrl = path.basename(new URL(artifact.url).pathname);
  const filename = artifact.filename || fromUrl;
  if (!filename || filename !== path.basename(filename) || filename.includes('\\')) {
    throw new Error('package artifact filename must be a basename');
  }
  return filename;
}

async function downloadPackageArtifact(artifact, destination, opts = {}) {
  if (!artifact || !/^https:\/\//i.test(artifact.url || '')) throw new Error('package artifact URL must use HTTPS');
  const fetchImpl = opts.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('package update requires fetch');
  const response = await fetchImpl(artifact.url, { headers: { 'User-Agent': 'khy-os-updater/1' } });
  if (!response || !response.ok || !response.body) throw new Error(`package artifact request failed: HTTP ${response && response.status}`);
  const fsImpl = opts.fs || fs;
  const temporary = `${destination}.${process.pid}.tmp`;
  const output = fsImpl.createWriteStream(temporary, { flags: 'wx' });
  const hash = crypto.createHash('sha256');
  const idleTimeoutMs = Number(opts.downloadIdleTimeoutMs || UPDATE.DOWNLOAD_IDLE_TIMEOUT_MS);
  let size = 0;
  const startedAt = Date.now();
  try {
    if (typeof response.body.getReader !== 'function') throw new Error('package artifact response body is unreadable');
    const reader = response.body.getReader();
    for (;;) {
      let timer;
      let packet;
      try {
        packet = await Promise.race([
          reader.read(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`package download idle timeout (${Math.ceil(idleTimeoutMs / 1000)}s)`)),
              idleTimeoutMs
            );
            if (typeof timer.unref === 'function') timer.unref();
          }),
        ]);
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
        const elapsed = Math.max((Date.now() - startedAt) / 1000, 0.001);
        opts.onProgress({ size, total: artifact.size, rate: Math.round(size / elapsed) });
      }
    }
    await new Promise((resolve, reject) => output.end(error => error ? reject(error) : resolve()));
    const digest = hash.digest('hex');
    if (size !== artifact.size) throw new Error('package artifact size mismatch');
    if (digest !== String(artifact.sha256).toLowerCase()) throw new Error('package artifact sha256 mismatch');
    fsImpl.renameSync(temporary, destination);
    return { size, sha256: digest };
  } catch (error) {
    output.destroy();
    fsImpl.rmSync(temporary, { force: true });
    throw error;
  }
}

async function stagePackageUpdate(state, opts = {}) {
  const fsImpl = opts.fs || fs;
  const version = state.target && state.target.version;
  const pip = state.source && state.source.packages && state.source.packages.pip;
  const npm = state.source && state.source.packages && state.source.packages.npm;
  if (!version || (!pip && !npm)) {
    return { success: false, error: 'package target or installed channel is missing' };
  }

  const allowed = require('../versionService').PACKAGE_CANDIDATES;
  if (pip && !allowed.includes(pip.name)) {
    return { success: false, error: 'pip package is outside the update allowlist' };
  }

  const root = cacheRoot(state, opts);
  try {
    fsImpl.mkdirSync(root, { recursive: true });
    const artifacts = {};
    const artifactMeta = {};
    const githubArtifacts = state.updateSource === 'github' && state.detail && state.detail.packageArtifacts;
    if (pip) {
      if (githubArtifacts && githubArtifacts.pip) {
        const meta = githubArtifacts.pip;
        const file = packageArtifactFilename(meta);
        artifacts.pip = path.join(root, file);
        fsImpl.rmSync(artifacts.pip, { force: true });
        artifactMeta.pip = { ...meta };
        await downloadPackageArtifact(meta, artifacts.pip, opts);
      } else {
        const pipCmd = process.platform === 'win32' ? 'pip' : 'pip3';
        run(pipCmd, ['download', '--no-deps', '--dest', root, `${pip.name}==${version}`], opts);
        const file = findPipArtifact(fsImpl.readdirSync(root), pip.name, version);
        if (!file) throw new Error('pip download did not produce the expected package and version');
        artifacts.pip = path.join(root, file);
      }
    }
    if (npm) {
      if (githubArtifacts && githubArtifacts.npm) {
        const meta = githubArtifacts.npm;
        const file = packageArtifactFilename(meta);
        artifacts.npm = path.join(root, file);
        fsImpl.rmSync(artifacts.npm, { force: true });
        artifactMeta.npm = { ...meta };
        await downloadPackageArtifact(meta, artifacts.npm, opts);
      } else {
        run('npm', ['pack', `@khy-os/khy-os@${version}`, '--pack-destination', root], opts);
        const file = findNpmArtifact(fsImpl.readdirSync(root), version);
        if (!file) throw new Error('npm pack did not produce the expected package and version');
        artifacts.npm = path.join(root, file);
      }
    }
    const descriptor = {
      schemaVersion: 1,
      type: 'package',
      version,
      package: pip ? pip.name : null,
      source: state.updateSource || null,
      artifacts,
      artifactMeta,
    };
    const descriptorPath = path.join(root, 'STAGED.json');
    fsImpl.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    return { success: true, path: descriptorPath, detail: descriptor };
  } catch (error) {
    return { success: false, path: root, error: error.message };
  }
}

function readDescriptor(stagedPath, opts = {}) {
  const fsImpl = opts.fs || fs;
  try {
    const descriptor = JSON.parse(fsImpl.readFileSync(stagedPath, 'utf8'));
    if (descriptor.schemaVersion !== 1 || descriptor.type !== 'package') return null;
    return descriptor;
  } catch {
    return null;
  }
}

function validateDescriptor(state, descriptor, opts = {}) {
  if (!descriptor || descriptor.version !== (state.target && state.target.version)) {
    return { ok: false, error: 'staged package descriptor does not match the update target' };
  }
  const allowed = require('../versionService').PACKAGE_CANDIDATES;
  if (descriptor.package && !allowed.includes(descriptor.package)) {
    return { ok: false, error: 'staged pip package is outside the update allowlist' };
  }
  const fsImpl = opts.fs || fs;
  for (const [channel, file] of Object.entries(descriptor.artifacts || {})) {
    if (!['pip', 'npm'].includes(channel) || !path.isAbsolute(file) || !fsImpl.existsSync(file)) {
      return { ok: false, error: `staged ${channel} artifact is missing or invalid` };
    }
  }
  if (!descriptor.artifacts || Object.keys(descriptor.artifacts).length === 0) {
    return { ok: false, error: 'staged package descriptor contains no artifacts' };
  }
  return { ok: true };
}

function applyPackageUpdate(state, opts = {}) {
  const descriptor = readDescriptor(state.stagedPath, opts);
  const validation = validateDescriptor(state, descriptor, opts);
  if (!validation.ok) return { success: false, error: validation.error };
  const pip = state.source && state.source.packages && state.source.packages.pip;
  const npm = state.source && state.source.packages && state.source.packages.npm;
  if (!pip && npm && descriptor.artifacts.npm) {
    try {
      const output = String(run('npm', ['install', '-g', descriptor.artifacts.npm], opts) || '');
      return {
        success: true,
        changed: npm.version !== descriptor.version,
        from: npm.version,
        to: descriptor.version,
        package: npm.name,
        output,
      };
    } catch (error) {
      return { success: false, error: `npm update failed: ${error.message}` };
    }
  }
  const localNpm = npm && descriptor.artifacts.npm;
  const selfUpdate = opts.selfUpdate || require('../khySelfUpdateService');
  const pipResult = selfUpdate.applyUpdate({
    env: localNpm
      ? { ...(opts.env || process.env), KHY_MULTI_CHANNEL_SYNC: '0' }
      : opts.env || process.env,
    _exec: opts.exec,
    _sleep: opts.sleep,
    onProgress: opts.onProgress,
    onStatus: opts.onStatus,
    staged: descriptor,
  });
  if (!pipResult.success || !localNpm) return pipResult;
  try {
    if (typeof opts.onStatus === 'function') {
      opts.onStatus({ action: '更新', target: npm.name, phase: '安装包', progress: '第 2/2 个渠道' });
    }
    const output = String(run('npm', ['install', '-g', localNpm], opts) || '');
    const npmResult = {
      channel: 'npm',
      success: true,
      changed: npm.version !== descriptor.version,
      from: npm.version,
      to: descriptor.version,
      package: npm.name,
      output,
    };
    return {
      ...pipResult,
      changed: !!pipResult.changed || npmResult.changed,
      alreadyLatest: !pipResult.changed && !npmResult.changed,
      channels: [...(pipResult.channels || []), npmResult],
    };
  } catch (error) {
    return {
      ...pipResult,
      success: false,
      error: `npm update failed: ${error.message}`,
      channels: [...(pipResult.channels || []), { channel: 'npm', success: false, error: error.message }],
    };
  }
}

module.exports = {
  stagePackageUpdate,
  applyPackageUpdate,
  readDescriptor,
  validateDescriptor,
  _cacheRoot: cacheRoot,
  _findPipArtifact: findPipArtifact,
  _findNpmArtifact: findNpmArtifact,
  _downloadPackageArtifact: downloadPackageArtifact,
  _packageArtifactFilename: packageArtifactFilename,
};
