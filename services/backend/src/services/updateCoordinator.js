'use strict';

/**
 * Unified KhyOS update coordinator.
 * Detection and staging do not mutate the active installation. Applying an
 * update is a separate operation entered only after an explicit user choice.
 */

const { execFile, execFileSync, execSync } = require('child_process');
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

/**
 * runGit 的异步版本：不阻塞事件循环。供启动横幅在 Ink 渲染体之外（mount 后
 * 一次性 effect）取 provenance，避免同步 spawn 把 TUI 卡死。
 * 契约与 runGit 对齐：注入的 opts.git 返回 { stdout } 或字符串均可。
 */
function runGitAsync(args, cwd, opts = {}) {
  const git = opts.git;
  if (typeof git === 'function') {
    const out = git(args, cwd);
    return Promise.resolve(out).then((s) => String((s && s.stdout) || s || '').trim());
  }
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: opts.gitTimeoutMs || 15000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      // 与 execFileSync 行为对齐：非零退出时 execFileSync 抛错、这里 resolve ''
      // 让调用方走各自的空值语义（fail-soft），而不是把异常传播回渲染路径。
      if (err) return resolve('');
      resolve(String(stdout || '').trim());
    });
  });
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

/**
 * findSourceRoot 的异步版本：git 走 execFile（不阻塞事件循环），供启动横幅使用。
 * 只 await git 探测；收尾的 existsSync 是毫秒级本地 fs，保持同步。
 */
async function findSourceRootAsync(start, opts = {}) {
  try {
    const root = await runGitAsync(['rev-parse', '--show-toplevel'], start || process.cwd(), opts);
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

/**
 * 从运行中模块自身推算 khy-os 源码根。
 *
 * CLI 的 provenance 描述的是「正在运行这份代码」的来源，而非用户敲 `khy` 时所在的
 * cwd（例如从 D:\ 或 ~ 启动时，git rev-parse 在 cwd 上找不到仓库 → 更新行为空）。
 * 本函数沿 __filename 向上找「含 services/backend/package.json 且含 .git」的目录，
 * 只在确实是一个源码仓安装（dev/git-clone）时返回它；安装在 node_modules / wheel
 * （无 .git）时返回 null，交由 cwd 路径兜底，行为逐字节回退旧逻辑。
 */
function moduleSourceRoot(fsImpl = fs) {
  let candidate = path.dirname(__filename);
  for (let i = 0; i < 8; i += 1) {
    try {
      if (
        fsImpl.existsSync(path.join(candidate, 'services', 'backend', 'package.json')) &&
        fsImpl.existsSync(path.join(candidate, '.git'))
      ) {
        return candidate;
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return null;
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

/**
 * 纯函数：从 `git log --format=%D` 的引用装饰里挑出最能代表「来源」的一个。
 *
 * 装饰形如 `HEAD -> main, origin/main, origin/HEAD, gitee/main, tag: v1.1.11`。
 * 优先远程跟踪引用（它说明这份代码已同步到哪里），其次本地分支名。
 *
 * 本地分支靠 `HEAD ->` 标记识别，而不是「含斜杠即远程」——`feature/x` 这类
 * 带斜杠的本地分支会被那种猜法误判成远程引用，报出一个并不存在的同步来源。
 * 裸 HEAD（detached）、`origin/HEAD` 这类别名和 tag 都不是同步来源，剔除。
 *
 * @param {string} decoration %D 的原始输出
 * @returns {?string} 形如 'origin/main' 或 'main'；无可用引用时 null
 */
function pickSourceRef(decoration) {
  let local = null;
  const remotes = [];
  for (const raw of String(decoration || '').split(',')) {
    const ref = raw.trim();
    if (!ref || ref === 'HEAD' || /\/HEAD$/.test(ref) || ref.startsWith('tag:')) continue;
    const headed = /^HEAD\s*->\s*(.+)$/.exec(ref);
    if (headed) local = headed[1].trim() || null;
    else remotes.push(ref);
  }
  return remotes[0] || local;
}

/**
 * 只读本地元数据的「上次更新时间 + 来源」探测——绝不联网、绝不抛。
 *
 * 三种时间必须分开，混为一谈就会把「查过更新」冒充成「更新过代码」：
 *   - updatedAt：当前工作树 HEAD 的提交时间（git log -1 --format=%cI）。
 *     它是「这份代码有多新」唯一可核验的答案。
 *   - source：该提交跟踪的上游引用（如 origin/main）；无上游时退回本地分支名。
 *     @{upstream} 只读本地 config 与远程跟踪引用，不发网络请求。
 *   - checkedAt：更新检查发生的时间，来自 updates/state.json，且**仅当快照
 *     记录的 commit 与当前 HEAD 一致时**才可信；否则它是旧分支留下的陈旧
 *     快照（本仓库就出现过 state.json 停在已切走的分支上），此时标 stateStale。
 *
 * 不走 detectInstallation：它的 package 分支会 spawn pip/npm 探测版本，把一个
 * 展示字段变成启动期的进程开销。这里只走便携根（纯 fs）与源码仓（一次
 * git rev-parse）两条廉价路径，都不命中则直接认不出来。
 *
 * @param {object} [opts] { cwd?, fs?, git?, stateFile?, memoryOnly? } — git/fs 可注入供测试桩
 * @returns {{kind: ?string, version: ?string, commit: string, shortCommit: string,
 *   updatedAt: ?string, source: ?string, dirty: boolean, checkedAt: ?number,
 *   stateStale: boolean}}
 */
function getSourceProvenance(opts = {}) {
  const blank = {
    kind: null,
    version: null,
    commit: '',
    shortCommit: '',
    updatedAt: null,
    source: null,
    dirty: false,
    checkedAt: null,
    stateStale: false,
  };
  const result = { ...blank };
  try {
    const fsImpl = opts.fs || fs;
    // provenance 默认优先本仓源码根（见 moduleSourceRoot），其次 KHY_OS_ROOT，
    // 最后才是用户 cwd —— 这样从任意目录启动 khy，横幅都能读到本仓的提交时间。
    const cwd = opts.cwd || process.env.KHY_OS_ROOT || moduleSourceRoot(fsImpl) || process.cwd();
    // 与 detectInstallation 同序：便携运行时优先于源码仓。
    const portableRoot = findPortableRoot(opts.portableRoot || cwd, fsImpl);
    if (portableRoot) {
      result.kind = 'portable';
      try {
        const info = JSON.parse(
          fsImpl.readFileSync(path.join(portableRoot, 'BUILD-INFO.json'), 'utf8')
        );
        result.version = String(info.version || '') || null;
        result.commit = String(info.sourceCommit || '');
        result.shortCommit = result.commit.slice(0, 7);
        // BUILD-INFO.json 没有构建时间字段，宁可不显示时间也不编一个出来。
        result.source = String(info.kind || 'portable-runtime');
      } catch {
        result.source = 'portable-runtime';
      }
    } else {
      const sourceRoot = findSourceRoot(cwd, opts);
      if (sourceRoot) {
        result.kind = 'git';
        result.version = readSourceVersion(sourceRoot, fsImpl);
        // 每个 git 子进程在 Windows 上都是一次 CreateProcess（见
        // extensions/scripts/khy-diagnostics/bench/git_spawn_bench.js），而这段
        // 代码在启动首屏同步执行，所以三条信息压进一次调用：
        //   %H 提交 SHA / %cI 提交时间 / %D 指向该提交的引用装饰
        // 用 %D 而非 @{upstream}：它回答的是「这份代码正是哪个引用上的内容」。
        // 本地领先于 origin 时 origin/main 不会出现在装饰里，此时退回分支名，
        // 而不是标一个并不包含当前代码的远程引用。
        try {
          const head = runGit(
            ['log', '-1', '--format=%H%n%cI%n%D'], sourceRoot, opts
          ).split('\n');
          result.commit = (head[0] || '').trim();
          result.shortCommit = result.commit.slice(0, 7);
          result.updatedAt = (head[1] || '').trim() || null;
          result.source = pickSourceRef((head[2] || '').trim());
        } catch { /* 空仓/无提交 → 字段保持空 */ }
        // 脏检测默认关闭：git status 要遍历工作树（本仓实测 ~147ms，是 git log
        // 的两倍多），启动首屏不值当。需要时由调用方显式 includeDirty 打开。
        // -uno：只看已跟踪文件，未跟踪的嵌套仓/草稿不该让横幅永久报脏。
        if (opts.includeDirty) {
          try {
            result.dirty = runGit(
              ['status', '--porcelain', '-uno'], sourceRoot, opts
            ).length > 0;
          } catch { /* fail soft */ }
        }
      }
    }

    // 检查时间：与当前 HEAD 同源才展示，否则只标陈旧。
    try {
      const state = readState(opts);
      const recorded = String(
        (state.current && state.current.commit) || (state.source && state.source.commit) || ''
      );
      if (state.checkedAt) {
        if (!result.commit || !recorded || recorded === result.commit) {
          result.checkedAt = state.checkedAt;
        } else {
          result.stateStale = true;
        }
      }
    } catch { /* 状态文件不可读不影响其余字段 */ }
    return result;
  } catch {
    return blank;
  }
}

/**
 * getSourceProvenance 的异步版本：git 探测走 execFile（回调式、绝不阻塞事件循环），
 * 供启动横幅在 Ink 渲染体之外（App mount 后的一次性 effect）取 provenance。
 * 与同步版逐字段同构，只把两处 git spawn 换成 runGitAsync；本地 fs 读仍是毫秒级，
 * 保持同步。git 慢/失效时不抛，返回 blank 字面量——banner 整行省略而非卡死 UI。
 *
 * @param {object} [opts] 与同步版同字段（cwd/fs/git/stateFile/memoryOnly/includeDirty）
 * @returns {Promise<object>} getSourceProvenance 同形状
 */
async function getSourceProvenanceAsync(opts = {}) {
  const blank = {
    kind: null,
    version: null,
    commit: '',
    shortCommit: '',
    updatedAt: null,
    source: null,
    dirty: false,
    checkedAt: null,
    stateStale: false,
  };
  const result = { ...blank };
  try {
    const fsImpl = opts.fs || fs;
    // 与同步版同序：只读本地 git 时先落源码根，其次 KHY_OS_ROOT，最后 cwd。
    const cwd = opts.cwd || process.env.KHY_OS_ROOT || moduleSourceRoot(fsImpl) || process.cwd();
    const portableRoot = findPortableRoot(opts.portableRoot || cwd, fsImpl);
    if (portableRoot) {
      result.kind = 'portable';
      try {
        const info = JSON.parse(
          fsImpl.readFileSync(path.join(portableRoot, 'BUILD-INFO.json'), 'utf8')
        );
        result.version = String(info.version || '') || null;
        result.commit = String(info.sourceCommit || '');
        result.shortCommit = result.commit.slice(0, 7);
        result.source = String(info.kind || 'portable-runtime');
      } catch {
        result.source = 'portable-runtime';
      }
    } else {
      const sourceRoot = await findSourceRootAsync(cwd, opts);
      if (sourceRoot) {
        result.kind = 'git';
        result.version = readSourceVersion(sourceRoot, fsImpl);
        const head = (await runGitAsync(
          ['log', '-1', '--format=%H%n%cI%n%D'], sourceRoot, opts
        )).split('\n');
        result.commit = (head[0] || '').trim();
        result.shortCommit = result.commit.slice(0, 7);
        result.updatedAt = (head[1] || '').trim() || null;
        result.source = pickSourceRef((head[2] || '').trim());
        if (opts.includeDirty) {
          try {
            result.dirty = (await runGitAsync(
              ['status', '--porcelain', '-uno'], sourceRoot, opts
            )).length > 0;
          } catch { /* fail soft */ }
        }
      }
    }

    try {
      const state = readState(opts);
      const recorded = String(
        (state.current && state.current.commit) || (state.source && state.source.commit) || ''
      );
      if (state.checkedAt) {
        if (!result.commit || !recorded || recorded === result.commit) {
          result.checkedAt = state.checkedAt;
        } else {
          result.stateStale = true;
        }
      }
    } catch { /* 状态文件不可读不影响其余字段 */ }
    return result;
  } catch {
    return blank;
  }
}

/**
 * 纯函数：把 getSourceProvenance() 的结果渲成一行启动横幅文本。零 IO、绝不抛。
 *
 * 时间按 ISO 字面截取（不转本机时区）：%cI 带的是提交者当时的时区偏移，保留它
 * 才能与 git log 看到的值逐字对上，也让输出不随运行机器的时区漂移。
 *
 * @param {object} [provenance] getSourceProvenance() 的返回值
 * @returns {string} 形如 "2026-08-23 18:04 · origin/main@6b3babe"；无可展示信息时为 ''
 */
function formatProvenance(provenance) {
  try {
    if (!provenance || typeof provenance !== 'object') return '';
    const parts = [];
    const iso = String(provenance.updatedAt || '');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso)) {
      parts.push(`${iso.slice(0, 10)} ${iso.slice(11, 16)}`);
    }
    const source = String(provenance.source || '');
    const short = String(provenance.shortCommit || '');
    if (source && short) parts.push(`${source}@${short}`);
    else if (source) parts.push(source);
    else if (short) parts.push(short);
    if (!parts.length) return '';
    let text = parts.join(' · ');
    if (provenance.dirty) text += '（有未提交改动）';
    return text;
  } catch {
    return '';
  }
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
  getSourceProvenance,
  getSourceProvenanceAsync,
  formatProvenance,
  checkUpdate,
  stageUpdate,
  applyUpdate,
  skipUpdate,
  _findPortableRoot: findPortableRoot,
  _findSourceRoot: findSourceRoot,
  _resetForTests: resetForTests,
};
