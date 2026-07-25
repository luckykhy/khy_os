'use strict';

/**
 * Deploy orchestrator — the single entrypoint that takes a project from a
 * source directory to a running deployment at a target location.
 *
 * Pipeline: detect → sync → install → build → start. Every stage is reported
 * through an `onStep` callback for full state transparency, and a blocking
 * stage that fails halts the pipeline immediately (fail-safe — never silently
 * continues past a broken install/build). The result and any launched process
 * are recorded in the deploy ledger so `status/stop/logs/list` can find them.
 */

const path = require('path');

const projectDetector = require('./projectDetector');
const syncEngine = require('./syncEngine');
const runners = require('./runners');
const ledger = require('./deployLedger');

function defaultDeps() {
  return {
    fs: require('fs'),
    cp: require('child_process'),
    platform: process.platform,
    detect: projectDetector.detectProject,
    sync: syncEngine.syncTree,
    runStep: runners.runStep,
    launch: runners.launch,
    ledger,
    now: () => new Date().toISOString(),
  };
}

/** Parse an explicit start-command override string into an argv command. */
function parseCommandOverride(str) {
  const parts = String(str).trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { exe: parts[0], args: parts.slice(1), display: parts.join(' ') };
}

function safeName(target) {
  return path.basename(path.resolve(target)).replace(/[^\w.-]/g, '_') || 'app';
}

/**
 * Deploy a project.
 *
 * @param {Object} opts
 * @param {string} opts.target        Required target directory.
 * @param {string} [opts.source]      Source dir (default cwd).
 * @param {string} [opts.name]        Deployment id (default basename of target).
 * @param {boolean} [opts.start=false] Launch the app after deploying.
 * @param {boolean} [opts.install=true]
 * @param {boolean} [opts.build=true]
 * @param {string} [opts.startCmd]    Explicit start command override.
 * @param {number} [opts.port]
 * @param {Object} [opts.env]         Extra env vars for install/build/start.
 * @param {(step:Object)=>void} [opts.onStep]
 * @param {Object} [opts.deps]
 * @returns {Object} deployment result
 */
function deployProject(opts = {}) {
  const deps = { ...defaultDeps(), ...(opts.deps || {}) };
  const onStep = typeof opts.onStep === 'function' ? opts.onStep : () => {};

  if (!opts.target) throw new Error('部署目标路径未指定 (target)');
  const source = path.resolve(opts.source || deps.cwd || process.cwd());
  const target = path.resolve(opts.target);
  const name = opts.name || safeName(target);
  const doInstall = opts.install !== false;
  const doBuild = opts.build !== false;
  const childEnv = { ...process.env, ...(opts.env || {}) };

  const steps = [];
  const record = (step) => {
    steps.push(step);
    onStep(step);
  };

  const result = {
    ok: false,
    name,
    source,
    target,
    type: 'unknown',
    signals: [],
    plan: null,
    steps,
    pid: null,
    port: opts.port || null,
    logFile: null,
    status: 'failed',
    notes: [],
  };

  // ── 1. detect ──────────────────────────────────────────────────────
  const plan = deps.detect(source, { fs: deps.fs, platform: deps.platform });
  result.plan = plan;
  result.type = plan.type;
  result.signals = plan.signals;
  result.notes = plan.notes.slice();
  if (opts.port == null && plan.port != null) result.port = plan.port;
  record({
    name: 'detect',
    status: 'ok',
    detail: `类型=${plan.type}${plan.signals.length ? ` 信号=[${plan.signals.join(', ')}]` : ''}`,
  });

  // ── 2. sync ────────────────────────────────────────────────────────
  let synced;
  try {
    synced = deps.sync(source, target, { fs: deps.fs });
    record({
      name: 'sync',
      status: 'ok',
      detail: `复制 ${synced.copied.length} 文件 / ${synced.dirs} 目录，跳过 ${synced.skipped.length} 项`,
    });
  } catch (err) {
    record({ name: 'sync', status: 'failed', detail: err.message });
    result.status = 'failed';
    return result;
  }

  // ── 3. install ─────────────────────────────────────────────────────
  if (doInstall && plan.install) {
    const r = deps.runStep(plan.install, { cwd: target, env: childEnv });
    if (!r.ok) {
      record({ name: 'install', status: 'failed', detail: `${r.command}\n${tail(r.output)}` });
      result.status = 'failed';
      return result; // fail-safe: do not build/start on broken deps
    }
    record({ name: 'install', status: 'ok', detail: r.command });
  } else {
    record({
      name: 'install',
      status: 'skipped',
      detail: doInstall ? '该项目类型无依赖安装步骤' : '已通过 --no-install 跳过',
    });
  }

  // ── 4. build ───────────────────────────────────────────────────────
  if (doBuild && plan.build) {
    const r = deps.runStep(plan.build, { cwd: target, env: childEnv });
    if (!r.ok) {
      record({ name: 'build', status: 'failed', detail: `${r.command}\n${tail(r.output)}` });
      result.status = 'failed';
      return result;
    }
    record({ name: 'build', status: 'ok', detail: r.command });
  } else {
    record({
      name: 'build',
      status: 'skipped',
      detail: doBuild ? '无构建步骤' : '已通过 --no-build 跳过',
    });
  }

  // Deployment of files succeeded even if we do not start.
  result.ok = true;
  result.status = 'deployed';

  // ── 5. start (optional) ────────────────────────────────────────────
  if (opts.start) {
    const startCommand = opts.startCmd ? parseCommandOverride(opts.startCmd) : plan.start;
    if (!startCommand) {
      record({
        name: 'start',
        status: 'failed',
        detail: '无法确定启动命令，请用 --cmd "<命令>" 指定',
      });
      result.status = 'deployed';
      persist(result, deps, { startCmd: null });
      return result;
    }
    const logFile = path.join(target, '.khy-deploy', `${name}.log`);
    const launched = deps.launch(startCommand, { cwd: target, env: childEnv, logFile });
    result.pid = launched.pid;
    result.logFile = launched.logFile;
    result.status = launched.pid ? 'running' : 'failed';
    record({
      name: 'start',
      status: launched.pid ? 'ok' : 'failed',
      detail: launched.pid
        ? `${launched.command} (pid ${launched.pid}) → 日志 ${launched.logFile}`
        : `启动失败: ${launched.command}`,
    });
    persist(result, deps, { startCmd: startCommand.display });
    return result;
  }

  record({ name: 'start', status: 'skipped', detail: '未指定 --start' });
  persist(result, deps, { startCmd: plan.start ? plan.start.display : null });
  return result;
}

function persist(result, deps, extra) {
  try {
    deps.ledger.upsert({
      name: result.name,
      source: result.source,
      target: result.target,
      type: result.type,
      startCmd: extra.startCmd,
      pid: result.pid,
      port: result.port,
      logFile: result.logFile,
      status: result.status,
      startedAt: result.pid ? deps.now() : null,
    });
  } catch {
    // Ledger persistence is best-effort; deployment itself already succeeded.
  }
}

function tail(text, n = 600) {
  const s = String(text || '');
  return s.length > n ? s.slice(-n) : s;
}

module.exports = {
  deployProject,
  parseCommandOverride,
  safeName,
  defaultDeps,
};
