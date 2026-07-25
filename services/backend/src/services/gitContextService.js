/**
 * Git Context Service — memoized git context for system prompt injection.
 *
 * Collects git status, branch, recent log, and staged diff at session start
 * and caches the result. This mirrors Claude Code's behavior of injecting
 * git context into the system prompt rather than relying on tool calls.
 *
 * The cache is invalidated after a configurable TTL (default: 60s) or
 * when explicitly refreshed.
 */
'use strict';

const { execSync, spawnSync } = require('child_process');

const DEFAULT_TTL_MS = 60_000;
const MAX_DIFF_CHARS = 4000;
const MAX_LOG_ENTRIES = 15;

let _cache = null;
let _cacheTime = 0;
let _cacheCwd = null;
// In-flight background refresh guard (keyed by cwd) so a burst of stale-serving
// turns spawns exactly one async git refresh, not one per turn.
let _refreshInFlightCwd = null;

/** Whether async stale-while-revalidate refresh is enabled (default on). Gate
 *  off → collectGitContext runs the full synchronous collection every cache miss
 *  (byte-identical to today). Never throws. */
function _asyncRefreshEnabled() {
  try {
    return require('./flagRegistry').isFlagEnabled('KHY_GIT_CONTEXT_ASYNC_REFRESH', process.env);
  } catch {
    const raw = process.env.KHY_GIT_CONTEXT_ASYNC_REFRESH;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
  }
}

/**
 * @typedef {object} GitContext
 * @property {string} branch      - Current branch name
 * @property {string} mainBranch  - Detected main/master branch
 * @property {string} status      - Short git status output
 * @property {string} recentLog   - Recent commit log (oneline format)
 * @property {string} stagedDiff  - Staged diff preview (truncated)
 * @property {boolean} isDirty    - Whether working tree has uncommitted changes
 * @property {boolean} isGitRepo  - Whether cwd is inside a git repository
 */

/**
 * Run a git command and return stdout, or null on failure.
 *
 * Transport: when KHY_GIT_SHELL_FREE is on (default) and the subcommand can be
 * safely tokenized, spawn `git` directly via spawnSync (no shell) — on Windows
 * this drops the `cmd.exe → git` two-process pair down to a single `git.exe`,
 * halving the cold-start git spawn count without changing the git command or its
 * stdout. Gate off / non-tokenizable / any error → byte-identical fallback to the
 * historical `execSync('git …')` string path.
 *
 * Enhanced (2026-07-08): Windows 优先使用 Git Bash 的 git.exe（通过 gitExecutableDetector），
 * 回退到系统 PATH。无可用 git 时返回 null（fail-soft）。
 *
 * @param {string} cmd
 * @param {string} cwd
 * @returns {string|null}
 */
function _git(cmd, cwd) {
  // 检测 git 可执行文件路径。Git Bash 优先解析是 **Windows 专属** 关切
  // (Unix 无「特殊路径的 Git Bash」概念),故仅在 win32 上调用检测器;
  // 其它平台保持 'git'——与历史行为逐字节一致,且不引入额外 `git --version` 探针
  // (该探针会污染无 shell 派生序列并破坏 KHY_GIT_SHELL_FREE=off 的字节回退保证)。
  let gitPath = 'git'; // 默认回退
  if (process.platform === 'win32') {
    try {
      const detector = require('./gitExecutableDetector');
      const detected = detector.detectGitExecutable();
      if (detected) {
        gitPath = detected;
      } else {
        // 无可用 git → 直接返回 null
        return null;
      }
    } catch {
      // 检测失败 → 回退到 'git'（历史行为）
    }
  }

  // ── 无 shell 派生路径(减少 Windows 启动进程数)──────────────────────────────
  try {
    const plan = require('./gitSpawnPlan');
    if (plan.isShellFreeGitEnabled(process.env)) {
      const argv = plan.toGitArgv(cmd);
      if (argv) {
        const res = spawnSync(gitPath, argv, {
          cwd,
          encoding: 'utf-8',
          timeout: 5000,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        // 与 execSync 语义对齐:非零退出 / spawn 出错 / 被信号杀死 → 视作失败返回 null。
        if (res && !res.error && res.status === 0) {
          return String(res.stdout == null ? '' : res.stdout).trim();
        }
        return null;
      }
    }
  } catch {
    // 无 shell 路径任何异常 → 落到下方 execSync 逐字节回退。
  }

  // ── 逐字节回退:历史 execSync 字符串路径 ─────────────────────────────────────
  try {
    // 显式路径需要引号包裹（Windows 路径可能含空格）
    const quotedGit = gitPath === 'git' ? 'git' : `"${gitPath}"`;
    return execSync(`${quotedGit} ${cmd}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Detect the main branch name (main or master).
 * @param {string} cwd
 * @returns {string}
 */
function _detectMainBranch(cwd) {
  // Check remote HEAD
  const remoteHead = _git('symbolic-ref refs/remotes/origin/HEAD', cwd);
  if (remoteHead) {
    const match = remoteHead.match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }
  // Fallback: check if main or master exists
  const branches = _git('branch --list main master', cwd);
  if (branches) {
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
  }
  return 'main';
}

/** The empty (non-repo) context object. Kept in one place so sync + async agree. */
function _emptyContext() {
  return {
    branch: '',
    mainBranch: '',
    status: '',
    recentLog: '',
    stagedDiff: '',
    isDirty: false,
    isGitRepo: false,
  };
}

/**
 * Assemble the final GitContext from raw git command outputs. Pure — no I/O —
 * so the synchronous and asynchronous collectors produce byte-identical shapes.
 * @param {{branch:string, mainBranch:string, status:string, recentLog:string, stagedDiff:string}} raw
 * @returns {GitContext}
 */
function _assembleContext(raw) {
  const status = raw.status || '';
  const isDirty = status.split('\n').some(line => line.length > 0 && !line.startsWith('##'));
  let stagedDiff = raw.stagedDiff || '';
  if (stagedDiff && stagedDiff.length > MAX_DIFF_CHARS) {
    stagedDiff = stagedDiff.slice(0, MAX_DIFF_CHARS) + '\n... (truncated)';
  }
  return {
    branch: raw.branch || '',
    mainBranch: raw.mainBranch || 'main',
    status: status.slice(0, 2000),
    recentLog: (raw.recentLog || '').slice(0, 3000),
    stagedDiff,
    isDirty,
    isGitRepo: true,
  };
}

/** Store a freshly-collected context in the module cache. */
function _storeCache(ctx, cwd) {
  _cache = ctx;
  _cacheTime = Date.now();
  _cacheCwd = cwd;
}

// ── Async (non-blocking) git, mirroring _git but running exec on the event loop ──

/**
 * Async twin of `_git`: runs `git <cmd>` via the non-blocking exec shim so it
 * NEVER pins the event loop. Returns trimmed stdout, or null on any failure.
 * @param {string} cmd
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function _gitAsync(cmd, cwd) {
  try {
    const { execAsync } = require('../tools/_execCompat');
    const out = await execAsync(`git ${cmd}`, {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return String(out == null ? '' : out).trim();
  } catch {
    return null;
  }
}

/** Async twin of `_detectMainBranch`. */
async function _detectMainBranchAsync(cwd) {
  const remoteHead = await _gitAsync('symbolic-ref refs/remotes/origin/HEAD', cwd);
  if (remoteHead) {
    const match = remoteHead.match(/refs\/remotes\/origin\/(.+)/);
    if (match) return match[1];
  }
  const branches = await _gitAsync('branch --list main master', cwd);
  if (branches) {
    if (branches.includes('main')) return 'main';
    if (branches.includes('master')) return 'master';
  }
  return 'main';
}

/**
 * Background refresh: collect git context asynchronously (non-blocking exec) and
 * update the cache. Deduplicated per cwd via `_refreshInFlightCwd` so a burst of
 * stale-serving turns triggers exactly one refresh. Never throws.
 * @param {string} cwd
 * @returns {Promise<void>}
 */
async function _refreshInBackground(cwd) {
  if (_refreshInFlightCwd === cwd) return; // already refreshing this cwd
  _refreshInFlightCwd = cwd;
  try {
    const root = await _gitAsync('rev-parse --show-toplevel', cwd);
    if (!root) { _storeCache(_emptyContext(), cwd); return; }
    const [branch, mainBranch, status, recentLog, stagedDiff] = await Promise.all([
      _gitAsync('rev-parse --abbrev-ref HEAD', cwd),
      _detectMainBranchAsync(cwd),
      _gitAsync('status --short --branch -u', cwd),
      _gitAsync(`log --oneline -${MAX_LOG_ENTRIES} --no-decorate`, cwd),
      _gitAsync('diff --cached --stat', cwd),
    ]);
    _storeCache(_assembleContext({ branch, mainBranch, status, recentLog, stagedDiff }), cwd);
  } catch {
    // Refresh is best-effort; leave the stale cache in place on failure.
  } finally {
    _refreshInFlightCwd = null;
  }
}

/**
 * Collect git context for the given working directory.
 *
 * @param {string} [cwd] - Working directory (defaults to process.cwd())
 * @param {object} [options]
 * @param {number} [options.ttlMs] - Cache TTL in milliseconds
 * @param {boolean} [options.force] - Force refresh (ignore cache)
 * @returns {GitContext}
 */
function collectGitContext(cwd, options = {}) {
  cwd = cwd || process.cwd();
  const ttl = options.ttlMs || DEFAULT_TTL_MS;

  // Check cache
  if (!options.force && _cache && _cacheCwd === cwd && (Date.now() - _cacheTime) < ttl) {
    return _cache;
  }

  // Stale-while-revalidate: if we have a usable (same-cwd) but expired cache and
  // this isn't a forced refresh, serve the stale value IMMEDIATELY and refresh in
  // the background with non-blocking exec — so the per-turn system-prompt build
  // never blocks the event loop on synchronous git. Gate off → today's full sync
  // collection every miss (byte-identical).
  if (!options.force && _cache && _cacheCwd === cwd && _asyncRefreshEnabled()) {
    // Fire-and-forget; _refreshInBackground is self-deduplicating and never throws.
    Promise.resolve().then(() => _refreshInBackground(cwd)).catch(() => {});
    return _cache;
  }

  // Check if in a git repo
  const root = _git('rev-parse --show-toplevel', cwd);
  if (!root) {
    const empty = _emptyContext();
    _storeCache(empty, cwd);
    return empty;
  }

  const branch = _git('rev-parse --abbrev-ref HEAD', cwd) || '';
  const mainBranch = _detectMainBranch(cwd);
  const status = _git('status --short --branch -u', cwd) || '';

  const recentLog = _git(`log --oneline -${MAX_LOG_ENTRIES} --no-decorate`, cwd) || '';

  const stagedDiff = _git('diff --cached --stat', cwd) || '';

  const ctx = _assembleContext({ branch, mainBranch, status, recentLog, stagedDiff });

  _storeCache(ctx, cwd);
  return ctx;
}

/**
 * Format git context as a system prompt section.
 * @param {GitContext} ctx
 * @returns {string}
 */
function formatForSystemPrompt(ctx) {
  if (!ctx || !ctx.isGitRepo) return '';

  const lines = [
    '# Git Context',
    '',
    `Branch: ${ctx.branch}`,
    `Main branch: ${ctx.mainBranch}`,
    `Dirty: ${ctx.isDirty ? 'yes' : 'no'}`,
  ];

  if (ctx.status) {
    lines.push('', '## Status', '```', ctx.status, '```');
  }

  if (ctx.recentLog) {
    lines.push('', '## Recent Commits', '```', ctx.recentLog, '```');
  }

  if (ctx.stagedDiff) {
    lines.push('', '## Staged Changes', '```', ctx.stagedDiff, '```');
  }

  return lines.join('\n');
}

/**
 * Invalidate the cached git context.
 */
function invalidateCache() {
  _cache = null;
  _cacheTime = 0;
  _cacheCwd = null;
}

module.exports = {
  collectGitContext,
  formatForSystemPrompt,
  invalidateCache,
  DEFAULT_TTL_MS,
  // internal — exported for unit tests only.
  _assembleContext,
  _emptyContext,
  _asyncRefreshEnabled,
};
