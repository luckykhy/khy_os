'use strict';

/**
 * Unified KhyOS update coordinator.
 * Detection and staging do not mutate the active installation. Applying an
 * update is a separate operation entered only after an explicit user choice.
 */

const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STATES = Object.freeze([
  'idle',
  'checking',
  'available',
  'staged',
  'blocked',
  'applying',
  'applied',
  'failed',
]);
const CHANNELS = Object.freeze(['stable', 'preview', 'dev']);
const OFF = new Set(['0', 'false', 'off', 'no']);
const DEFAULT_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

let memoryState = null;
let inFlight = null;

function enabled(env = process.env) {
  return !OFF.has(String((env && env.KHY_SELF_UPDATE) || '').trim().toLowerCase());
}

function normalizeChannel(value, fallback = 'stable') {
  const channel = String(value || '').trim().toLowerCase();
  return CHANNELS.includes(channel) ? channel : fallback;
}

function getDataHome() {
  try {
    return require('../utils/dataHome').getDataHome();
  } catch {
    return path.join(os.homedir(), '.khy');
  }
}

function getStateFile(opts = {}) {
  return opts.stateFile || path.join(getDataHome(), 'updates', 'state.json');
}

function blankState(overrides = {}) {
  return {
    schemaVersion: 1,
    state: 'idle',
    channel: 'stable',
    source: null,
    current: null,
    target: null,
    stagedPath: null,
    blockedReason: null,
    indeterminate: false,
    checkedAt: null,
    skippedTarget: null,
    pendingRestart: false,
    rollbackPendingRestart: false,
    appliedProcessId: null,
    rollback: null,
    rollbackConfirmedAt: null,
    lastApplied: null,
    channelResults: [],
    degradation: [],
    updateSource: null,
    error: null,
    ...overrides,
  };
}

function sanitizeState(value) {
  if (!value || typeof value !== 'object') return blankState();
  return blankState({
    ...value,
    schemaVersion: 1,
    state: STATES.includes(value.state) ? value.state : 'idle',
    channel: normalizeChannel(value.channel),
  });
}

function readState(opts = {}) {
  if (opts.memoryOnly && memoryState) return sanitizeState(memoryState);
  try {
    const parsed = JSON.parse((opts.fs || fs).readFileSync(getStateFile(opts), 'utf8'));
    memoryState = sanitizeState(parsed);
  } catch {
    if (!memoryState) memoryState = blankState();
  }
  return sanitizeState(memoryState);
}

function writeState(next, opts = {}) {
  const clean = sanitizeState(next);
  memoryState = clean;
  if (opts.memoryOnly) return clean;
  try {
    const fsImpl = opts.fs || fs;
    const file = getStateFile(opts);
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fsImpl.writeFileSync(temp, `${JSON.stringify(clean, null, 2)}\n`, 'utf8');
    fsImpl.renameSync(temp, file);
  } catch {
    // Update-state persistence never breaks startup or the active install.
  }
  return clean;
}

function runGit(args, cwd, opts = {}) {
  if (typeof opts.git === 'function') return String(opts.git(args, cwd) || '').trim();
  return String(execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: opts.gitTimeoutMs || 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
  }) || '').trim();
}

function findPortableRoot(start, fsImpl = fs) {
  let current = path.resolve(start || process.cwd());
  for (;;) {
    if (
      fsImpl.existsSync(path.join(current, '.portable')) &&
      fsImpl.existsSync(path.join(current, 'BUILD-INFO.json'))
    ) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function findSourceRoot(start, opts = {}) {
  try {
    const root = runGit(['rev-parse', '--show-toplevel'], start || process.cwd(), opts);
    if (!root) return null;
    const fsImpl = opts.fs || fs;
    return fsImpl.existsSync(path.join(root, 'services', 'backend', 'package.json')) ? root : null;
  } catch {
    return null;
  }
}

function readSourceVersion(root, fsImpl = fs) {
  try {
    const packageJson = JSON.parse(
      fsImpl.readFileSync(path.join(root, 'services', 'backend', 'package.json'), 'utf8')
    );
    return String(packageJson.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

function detectInstallation(opts = {}) {
  const fsImpl = opts.fs || fs;
  const cwd = opts.cwd || process.env.KHY_OS_ROOT || process.cwd();
  const portableRoot = findPortableRoot(opts.portableRoot || cwd, fsImpl);
  if (portableRoot) {
    try {
      const info = JSON.parse(fsImpl.readFileSync(path.join(portableRoot, 'BUILD-INFO.json'), 'utf8'));
      return {
        type: 'portable',
        root: portableRoot,
        kind: info.kind || 'portable-runtime',
        version: String(info.version || '0.0.0'),
        commit: String(info.sourceCommit || ''),
        channel: info.kind === 'portable-dev' ? 'dev' : 'stable',
        target: info.target || null,
      };
    } catch {
      return {
        type: 'portable',
        root: portableRoot,
        kind: 'portable-runtime',
        version: '0.0.0',
        commit: '',
        channel: 'stable',
        target: null,
      };
    }
  }

  const sourceRoot = findSourceRoot(cwd, opts);
  if (sourceRoot) {
    let commit = '';
    let branch = '';
    try { commit = runGit(['rev-parse', 'HEAD'], sourceRoot, opts); } catch { /* optional */ }
    try { branch = runGit(['symbolic-ref', '--short', '-q', 'HEAD'], sourceRoot, opts); } catch { /* detached */ }
    return {
      type: 'git',
      root: sourceRoot,
      version: readSourceVersion(sourceRoot, fsImpl),
      commit,
      branch,
      channel: 'dev',
    };
  }

  const selfUpdate = opts.selfUpdate || require('./khySelfUpdateService');
  const execImpl = opts.exec || execSync;
  const versionService = require('./versionService');
  const pipPackage = selfUpdate._detectInstalledPackage(execImpl, versionService.PACKAGE_CANDIDATES);
  const pipVersion = selfUpdate._readInstalledVersion(execImpl, pipPackage);
  const npmVersion = selfUpdate._npmGlobalVersion(execImpl);
  return {
    type: 'package',
    root: null,
    version: pipVersion || npmVersion || versionService.getCurrentVersion(),
    commit: '',
    channel: 'stable',
    packages: {
      pip: pipVersion ? { name: pipPackage, version: pipVersion } : null,
      npm: npmVersion ? { name: selfUpdate.NPM_PACKAGE, version: npmVersion } : null,
    },
  };
}

function getGitStatus(installation, opts = {}) {
  const root = installation.root;
  try {
    runGit(['fetch', '--prune'], root, opts);
  } catch (error) {
    return { indeterminate: true, error: `git fetch failed: ${error.message}` };
  }

  let upstream = '';
  try {
    upstream = runGit(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'],
      root,
      opts
    );
  } catch {
    // Reported as a deterministic blocked state below.
  }
  let dirty = '';
  try { dirty = runGit(['status', '--porcelain', '-uall'], root, opts); } catch { /* fail soft */ }
  const branch = installation.branch || '';
  if (!branch) return { blocked: true, reason: 'detached-head' };
  if (!upstream) return { blocked: true, reason: 'no-upstream' };
  if (dirty) return { blocked: true, reason: 'dirty-worktree' };

  try {
    const counts = runGit(
      ['rev-list', '--left-right', '--count', `HEAD...${upstream}`],
      root,
      opts
    ).split(/\s+/).map(Number);
    const ahead = Number.isFinite(counts[0]) ? counts[0] : 0;
    const behind = Number.isFinite(counts[1]) ? counts[1] : 0;
    const targetCommit = runGit(['rev-parse', upstream], root, opts);
    if (ahead > 0 && behind > 0) {
      return { blocked: true, reason: 'diverged', ahead, behind, upstream, targetCommit };
    }
    if (ahead > 0) {
      return { blocked: true, reason: 'local-ahead', ahead, behind, upstream, targetCommit };
    }
    return { available: behind > 0, ahead, behind, upstream, targetCommit };
  } catch (error) {
    return { indeterminate: true, error: `git comparison failed: ${error.message}` };
  }
}

async function checkPackage(installation, opts = {}) {
  const selfUpdate = opts.selfUpdate || require('./khySelfUpdateService');
  const result = await selfUpdate.checkUpdate({
    env: opts.env || process.env,
    _exec: opts.exec,
    _fetch: opts.fetch,
  });
  if (result.indeterminate) {
    return { indeterminate: true, current: result.current, error: result.notice };
  }
  return {
    available: !!result.updateAvailable,
    current: result.current,
    targetVersion: result.latest,
    package: result.package,
    detail: result,
  };
}

function installationMatchesTarget(installation, target) {
  if (!installation || !target) return false;
  if (target.commit) return !!installation.commit && installation.commit === target.commit;
  return !!target.version && installation.version === target.version;
}

function sourceForUpdateChannel(installation, updateSource) {
  if (!installation || installation.type !== 'package' || !installation.packages) return installation;
  if (updateSource === 'pypi') {
    return {
      ...installation,
      packages: { pip: installation.packages.pip, npm: null },
    };
  }
  if (updateSource === 'npm') {
    return {
      ...installation,
      packages: { pip: null, npm: installation.packages.npm },
    };
  }
  return installation;
}

function readDeferredResult(resultPath, opts = {}) {
  if (!resultPath) return { complete: false, error: 'deferred swap result path is missing' };
  const fsImpl = opts.deferredFs || fs;
  try {
    const raw = String(fsImpl.readFileSync(resultPath, 'utf8')).replace(new RegExp('^\\uFEFF'), '');
    const result = JSON.parse(raw);
    return result && result.success
      ? { complete: true, success: true, result }
      : { complete: true, success: false, error: (result && result.error) || 'deferred swap failed' };
  } catch (error) {
    if (error && error.code === 'ENOENT') return { complete: false, error: 'deferred swap is still pending' };
    return { complete: true, success: false, error: `deferred swap result is invalid: ${error.message}` };
  }
}

function schedulePortableRollback(detail, opts = {}) {
  if (typeof opts.scheduleDeferredRollback === 'function') {
    return opts.scheduleDeferredRollback(detail, opts);
  }
  return require('./updateAdapters/portableAdapter')._scheduleDeferredRollback(detail, opts);
}

async function checkUpdate(opts = {}) {
  if (inFlight && !opts.force) return inFlight;
  const task = (async () => {
    const env = opts.env || process.env;
    if (!enabled(env)) {
      return writeState(blankState({ state: 'idle', disabled: true }), opts);
    }
    const prior = readState(opts);
    const now = typeof opts.now === 'function' ? opts.now() : Date.now();
    const installation = detectInstallation(opts);
    if (
      prior.rollbackPendingRestart &&
      (!prior.appliedProcessId || prior.appliedProcessId !== process.pid)
    ) {
      const rollbackResult = readDeferredResult(prior.rollback && prior.rollback.resultPath, opts);
      if (!rollbackResult.complete) return prior;
      if (!rollbackResult.success) {
        return writeState({
          ...prior,
          state: 'failed',
          rollbackPendingRestart: false,
          appliedProcessId: null,
          error: `automatic rollback failed: ${rollbackResult.error}`,
        }, opts);
      }
      if (!installationMatchesTarget(installation, prior.current)) {
        return writeState({
          ...prior,
          state: 'failed',
          rollbackPendingRestart: false,
          appliedProcessId: null,
          error: 'automatic rollback completed but the previous version was not restored',
        }, opts);
      }
      try {
        const integrity = opts.integrity || require('./fileIntegrityService');
        const verification = integrity.rebuildAndVerify();
        if (!verification.verification || !verification.verification.verified) {
          throw new Error('rollback integrity verification failed');
        }
        return writeState({
          ...prior,
          state: 'failed',
          pendingRestart: false,
          rollbackPendingRestart: false,
          appliedProcessId: null,
          rollbackConfirmedAt: now,
        }, opts);
      } catch (error) {
        return writeState({ ...prior, state: 'failed', error: error.message }, opts);
      }
    }
    if (
      prior.pendingRestart &&
      (!prior.appliedProcessId || prior.appliedProcessId !== process.pid)
    ) {
      const deferredDetail = prior.result && prior.result.deferred && prior.result.detail;
      if (deferredDetail) {
        const swap = readDeferredResult(deferredDetail.resultPath, opts);
        if (!swap.complete) return prior;
        if (!swap.success) {
          return writeState({
            ...prior,
            state: 'failed',
            pendingRestart: false,
            error: swap.error,
          }, opts);
        }
      }
      if (!installationMatchesTarget(installation, prior.target)) {
        if (!deferredDetail) return prior;
        return writeState({
          ...prior,
          state: 'failed',
          pendingRestart: false,
          error: 'update swap completed but the target version is not active',
        }, opts);
      }
      try {
        const postApply = await runPostApplyChecks(opts);
        writeState(blankState({
          channel: prior.channel,
          source: installation,
          current: {
            version: installation.version || null,
            commit: installation.commit || null,
          },
          checkedAt: prior.checkedAt,
          skippedTarget: prior.skippedTarget || null,
          channelResults: prior.channelResults || [],
          degradation: prior.degradation || [],
          updateSource: prior.updateSource || null,
          lastApplied: {
            target: prior.target,
            confirmedAt: now,
            postApply,
          },
        }), opts);
      } catch (error) {
        const deferredDetail = prior.result && prior.result.deferred && prior.result.detail;
        if (deferredDetail && deferredDetail.live && deferredDetail.backup) {
          try {
            const rollback = schedulePortableRollback(deferredDetail, opts);
            if (rollback && rollback.scheduled) {
              return writeState({
                ...prior,
                state: 'failed',
                pendingRestart: false,
                rollbackPendingRestart: true,
                appliedProcessId: process.pid,
                error: error.message,
                rollback,
              }, opts);
            }
          } catch { /* preserve post-apply failure */ }
        }
        return writeState({
          ...prior,
          state: 'failed',
          pendingRestart: false,
          error: error.message,
        }, opts);
      }
    }
    const effectivePrior = readState(opts);
    const interval = Number(env.KHY_UPDATE_CHECK_INTERVAL_MS || DEFAULT_CHECK_INTERVAL_MS);
    if (
      !opts.force &&
      effectivePrior.checkedAt &&
      now - effectivePrior.checkedAt < interval &&
      effectivePrior.state !== 'failed'
    ) {
      return effectivePrior;
    }

    writeState({ ...effectivePrior, state: 'checking', error: null }, opts);
    const channel = normalizeChannel(opts.channel || env.KHY_UPDATE_CHANNEL, installation.channel);
    let result;
    const channelCheck = opts.channelCheck;
    if (channelCheck) {
      if (channelCheck.repaired) {
        result = {
          available: false,
          current: channelCheck.current,
          detail: channelCheck.detail,
        };
      } else if (channelCheck.available) {
        result = {
          available: true,
          current: channelCheck.current,
          targetVersion: channelCheck.target,
          targetCommit: channelCheck.targetCommit || (channelCheck.detail && (channelCheck.detail.targetCommit || (channelCheck.detail.index && channelCheck.detail.index.release.commit))),
          detail: channelCheck.detail,
        };
      } else {
        result = {
          available: false,
          indeterminate: channelCheck.channelResults.some(item => item.status === 'unavailable'),
          error: channelCheck.degradation.map(item => `${item.channel}: ${item.reason}`).join('; ') || null,
        };
      }
    } else if (installation.type === 'git') {
      result = getGitStatus(installation, opts);
    } else if (installation.type === 'package') {
      result = await checkPackage(installation, opts);
    } else {
      const checkPortable =
        typeof opts.checkPortable === 'function'
          ? opts.checkPortable
          : require('./updateAdapters/portableAdapter').checkPortable;
      result = await checkPortable(installation, { ...opts, channel });
    }

    let state = 'idle';
    if (result.blocked) state = 'blocked';
    else if (result.available) state = 'available';
    const target = {
      version: result.targetVersion || null,
      commit: result.targetCommit || null,
      upstream: result.upstream || null,
    };
    if (effectivePrior.skippedTarget && effectivePrior.skippedTarget === (target.commit || target.version)) {
      state = 'idle';
    }
    return writeState(blankState({
      state,
      channel,
      source: channelCheck ? sourceForUpdateChannel(installation, channelCheck.source) : installation,
      current: {
        version: installation.version || result.current || null,
        commit: installation.commit || null,
      },
      target,
      blockedReason: result.reason || null,
      indeterminate: !!result.indeterminate,
      checkedAt: now,
      error: result.error || null,
      detail: result.detail || null,
      channelResults: channelCheck ? channelCheck.channelResults : effectivePrior.channelResults || [],
      degradation: channelCheck ? channelCheck.degradation : effectivePrior.degradation || [],
      updateSource: channelCheck ? channelCheck.source : effectivePrior.updateSource || null,
      skippedTarget: effectivePrior.skippedTarget || null,
      pendingRestart: effectivePrior.pendingRestart,
      appliedProcessId: effectivePrior.appliedProcessId || null,
      lastApplied: effectivePrior.lastApplied || null,
    }), opts);
  })();
  inFlight = task;
  try {
    return await task;
  } finally {
    if (inFlight === task) inFlight = null;
  }
}

async function stageUpdate(opts = {}) {
  const current = opts.state || readState(opts);
  if (current.state !== 'available') return current;
  if (typeof opts.onStatus === 'function') {
    opts.onStatus({ action: '更新', target: current.target.version || current.target.commit || 'KhyOS', phase: '暂存', progress: '第 2/3 阶段' });
  }
  if (current.source && current.source.type === 'git') {
    return writeState({ ...current, state: 'staged', stagedPath: current.source.root }, opts);
  }
  if (current.source && current.source.type === 'package') {
    const stagePackage =
      typeof opts.stagePackage === 'function'
        ? opts.stagePackage
        : require('./updateAdapters/packageAdapter').stagePackageUpdate;
    const result = await stagePackage(current, {
      ...opts,
      onProgress: opts.onProgress,
      onStatus: opts.onStatus,
    });
    return writeState({
      ...current,
      state: result.success ? 'staged' : 'failed',
      stagedPath: result.path || null,
      error: result.error || null,
      detail: result.detail || current.detail || null,
    }, opts);
  }
  if (current.source && current.source.type === 'portable') {
    const stagePortable =
      typeof opts.stagePortable === 'function'
        ? opts.stagePortable
        : require('./updateAdapters/portableAdapter').stagePortable;
    const result = await stagePortable(current.source, {
      ...opts,
      channel: current.channel,
      index: current.detail && current.detail.index,
      artifact: current.detail && current.detail.artifact,
    });
    return writeState({
      ...current,
      state: result.success ? 'staged' : 'failed',
      stagedPath: result.path || null,
      error: result.error || null,
      detail: result.detail || current.detail || null,
    }, opts);
  }
  return writeState(
    { ...current, state: 'failed', error: 'no staging adapter for installation type' },
    opts
  );
}

async function runPostApplyChecks(opts = {}) {
  const migrations = opts.migrations || require('../bootstrap/migrations');
  const integrity = opts.integrity || require('./fileIntegrityService');
  const migrationResult = await migrations.runMigrations();
  if (migrationResult && Array.isArray(migrationResult.skipped) && migrationResult.skipped.length > 0) {
    throw new Error(`migrations failed: ${migrationResult.skipped.join(', ')}`);
  }
  const integrityResult = integrity.rebuildAndVerify();
  if (!integrityResult.verification || !integrityResult.verification.verified) {
    throw new Error('post-update integrity verification failed');
  }
  return { migrations: migrationResult, integrity: integrityResult.verification };
}

function rollbackPackage(current, opts = {}) {
  const packages = current.source && current.source.packages;
  if (!packages) return { success: false, error: 'previous package version is unknown' };
  try {
    if (packages.pip) {
      const pip = process.platform === 'win32' ? 'pip' : 'pip3';
      const execImpl = opts.exec || execSync;
      execImpl(`${pip} install --force-reinstall ${packages.pip.name}==${packages.pip.version}`, {
        encoding: 'utf8', timeout: 180000, env: opts.env || process.env,
      });
    }
    if (packages.npm) {
      const execFile = opts.execFile || execFileSync;
      execFile('npm', ['install', '-g', `${packages.npm.name}@${packages.npm.version}`], {
        encoding: 'utf8', timeout: 180000, env: opts.env || process.env,
      });
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function applyUpdate(opts = {}) {
  const current = opts.state || readState(opts);
  if (current.state !== 'staged') {
    return { ...current, success: false, error: 'update is not staged' };
  }
  if (typeof opts.onStatus === 'function') {
    opts.onStatus({ action: '更新', target: current.target.version || current.target.commit || 'KhyOS', phase: '安装', progress: '第 3/3 阶段' });
  }
  writeState({ ...current, state: 'applying', error: null }, opts);
  const integrity = opts.integrity || require('./fileIntegrityService');
  const previousIntegrityManifest = integrity.loadManifest();
  try {
    let result;
    if (current.source.type === 'git') {
      const live = getGitStatus(current.source, opts);
      if (live.blocked || live.indeterminate || live.targetCommit !== current.target.commit) {
        return writeState({
          ...current,
          state: 'blocked',
          blockedReason: live.reason || 'target-changed',
          error: live.error || null,
        }, opts);
      }
      runGit(['merge', '--ff-only', current.target.commit], current.source.root, opts);
      result = { success: true, changed: true, to: current.target.commit };
    } else if (current.source.type === 'package') {
      if (typeof opts.applyPackage === 'function') result = await opts.applyPackage(current, opts);
      else result = require('./updateAdapters/packageAdapter').applyPackageUpdate(current, opts);
    } else if (current.source.type === 'portable') {
      const portableOpts = {
        ...opts,
        rollbackPostApply: async () => {
          try { integrity.restoreManifest(previousIntegrityManifest); } catch { /* preserve original failure */ }
        },
        postApply: async () => {
          const postApply = await runPostApplyChecks(opts);
          return { success: true, ...postApply };
        },
      };
      if (typeof opts.applyPortable === 'function') result = await opts.applyPortable(current, portableOpts);
      else result = await require('./updateAdapters/portableAdapter').applyPortable(current, portableOpts);
      if (result && result.success && !result.deferred) result.postApplyHandled = true;
    } else {
      result = { success: false, error: 'unknown installation type' };
    }
    if (result && result.success && !result.deferred && !result.postApplyHandled) {
      try {
        result.postApply = await runPostApplyChecks(opts);
      } catch (error) {
        if (current.source.type === 'git' && current.source.commit) {
          try { runGit(['reset', '--hard', current.source.commit], current.source.root, opts); } catch { /* preserve original failure */ }
        } else if (current.source.type === 'portable' && opts.restorePortable) {
          try { await opts.restorePortable(current, opts); } catch { /* preserve original failure */ }
        } else if (current.source.type === 'package') {
          result.rollback = rollbackPackage(current, opts);
        }
        try { integrity.restoreManifest(previousIntegrityManifest); } catch { /* preserve original failure */ }
        result = { ...result, success: false, error: error.message };
      }
    }
    return writeState({
      ...current,
      state: result && result.success ? 'applied' : 'failed',
      pendingRestart: !!(result && result.success),
      appliedProcessId: result && result.success ? process.pid : null,
      error: result && !result.success ? result.error || result.diagnosis || 'update failed' : null,
      result,
    }, opts);
  } catch (error) {
    return writeState({ ...current, state: 'failed', error: error.message }, opts);
  }
}

function skipUpdate(opts = {}) {
  const current = opts.state || readState(opts);
  const target = current.target && (current.target.commit || current.target.version);
  return writeState({ ...current, state: 'idle', skippedTarget: target || null }, opts);
}

function resetForTests() {
  memoryState = null;
  inFlight = null;
}

module.exports = {
  STATES,
  CHANNELS,
  enabled,
  normalizeChannel,
  blankState,
  readState,
  writeState,
  detectInstallation,
  getGitStatus,
  checkUpdate,
  stageUpdate,
  applyUpdate,
  skipUpdate,
  _findPortableRoot: findPortableRoot,
  _findSourceRoot: findSourceRoot,
  _resetForTests: resetForTests,
};
