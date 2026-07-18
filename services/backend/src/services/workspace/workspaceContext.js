'use strict';

/**
 * workspaceContext.js — khy-os「工作区」一等概念的单一数据真源。
 *
 * 把「我现在在哪个工作区、它的 git 状态如何、还挂了哪些额外目录」聚成一个
 * 结构化对象。它有两个消费方：
 *   1) git commit / push 等版本操作——知道工作区根、分支、远端、领先/落后。
 *   2) 执行前说明器（preExecutionExplainer，Part D）——「必须基于 khyos 获取的
 *      数据」，本对象就是那份数据；缺了就在这里主动获取（gather-if-missing）。
 *
 * 复用 gitContextService.collectGitContext 作为 git 真源，绝不另起一套 git 解析；
 * 本模块只在其上补「工作区」语义：远端 URL、ahead/behind、脏文件计数、额外目录。
 *
 * 全程 fail-soft：任何一项采集失败都降级为安全默认，绝不抛出——执行前说明永远
 * 拿得到一个可渲染的对象，哪怕信息不全。
 */

const { execSync } = require('child_process');
const gitContextService = require('../gitContextService');

let _additionalDirectories = null;
function _getAdditionalDirs() {
  // 懒加载并 fail-soft：额外目录子系统缺失不应拖垮工作区采集。
  try {
    if (!_additionalDirectories) _additionalDirectories = require('../additionalDirectories');
    return _additionalDirectories.getDirectories() || [];
  } catch {
    return [];
  }
}

/**
 * Redact embedded credentials from a remote URL before display.
 * `https://user:token@host/x.git` → `https://***@host/x.git`. Many remotes
 * (GitLab PAT, oauth2 tokens) carry secrets in the userinfo; never echo them
 * to a beginner's terminal where they may be screenshotted or pasted.
 * @param {string} url
 * @returns {string}
 */
function redactRemote(url) {
  if (!url) return '';
  // Strip the userinfo segment between the scheme's `//` and the `@`.
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, '$1***@');
}

/** Run a git command, return trimmed stdout or null on any failure. */
function _git(cmd, cwd) {
  try {
    // Git Bash 优先解析是 Windows 专属关切(Unix 无特殊路径的 Git Bash 概念)。
    // 仅在 win32 调用检测器,其它平台保持 'git'(字节回退兼容,不引入探针噪声)。
    let quotedGit = 'git';
    if (process.platform === 'win32') {
      try {
        const detector = require('../gitExecutableDetector');
        const detected = detector.detectGitExecutable();
        if (!detected) return null;
        quotedGit = detected === 'git' ? 'git' : `"${detected}"`;
      } catch { /* 检测失败 → 回退 'git' */ }
    }
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
 * Parse `git status --short` (no branch header) into dirty-file counters.
 * @param {string} status
 * @returns {{ staged:number, unstaged:number, untracked:number, total:number }}
 */
function _countDirty(status) {
  const counts = { staged: 0, unstaged: 0, untracked: 0, total: 0 };
  if (!status) return counts;
  for (const raw of status.split('\n')) {
    if (!raw || raw.startsWith('##')) continue;
    counts.total += 1;
    const x = raw[0];
    const y = raw[1];
    if (x === '?' && y === '?') { counts.untracked += 1; continue; }
    if (x && x !== ' ' && x !== '?') counts.staged += 1;
    if (y && y !== ' ' && y !== '?') counts.unstaged += 1;
  }
  return counts;
}

/**
 * Read ahead/behind counts versus the upstream tracking branch.
 * @returns {{ ahead:number, behind:number, hasUpstream:boolean }}
 */
function _aheadBehind(cwd) {
  // `git rev-list --count --left-right @{upstream}...HEAD` → "behind\tahead".
  const out = _git('rev-list --count --left-right @{upstream}...HEAD', cwd);
  if (!out) return { ahead: 0, behind: 0, hasUpstream: false };
  const m = out.split(/\s+/);
  const behind = Number.parseInt(m[0], 10);
  const ahead = Number.parseInt(m[1], 10);
  if (Number.isNaN(behind) || Number.isNaN(ahead)) {
    return { ahead: 0, behind: 0, hasUpstream: false };
  }
  return { ahead, behind, hasUpstream: true };
}

/**
 * @typedef {object} WorkspaceContext
 * @property {string}  root              - Workspace root (git toplevel, else cwd)
 * @property {string}  cwd               - The working directory used for collection
 * @property {boolean} isGitRepo         - Whether root is inside a git repo
 * @property {string}  branch            - Current branch name ('' if none)
 * @property {string}  mainBranch        - Detected main/master branch
 * @property {string}  remoteUrl         - origin push URL ('' if no remote)
 * @property {boolean} hasRemote         - Whether an 'origin' remote exists
 * @property {boolean} hasUpstream       - Whether the branch tracks an upstream
 * @property {number}  ahead             - Commits ahead of upstream
 * @property {number}  behind            - Commits behind upstream
 * @property {boolean} isDirty           - Working tree has uncommitted changes
 * @property {{staged:number,unstaged:number,untracked:number,total:number}} dirtyCounts
 * @property {string}  recentLog         - Recent commit log (oneline)
 * @property {string[]} additionalDirs   - Extra granted directories (/add-dir)
 */

/**
 * Collect a first-class workspace context object. Fail-soft throughout.
 *
 * @param {string} [cwd] - Working directory (defaults to KHYQUANT_CWD or process.cwd()).
 * @param {object} [options]
 * @param {boolean} [options.force] - Force-refresh the underlying git cache.
 * @returns {WorkspaceContext}
 */
function collectWorkspaceContext(cwd, options = {}) {
  cwd = cwd || process.env.KHYQUANT_CWD || process.cwd();

  let git;
  try {
    git = gitContextService.collectGitContext(cwd, { force: !!options.force });
  } catch {
    git = { branch: '', mainBranch: '', status: '', recentLog: '', isDirty: false, isGitRepo: false };
  }

  if (!git || !git.isGitRepo) {
    return {
      root: cwd,
      cwd,
      isGitRepo: false,
      branch: '',
      mainBranch: '',
      remoteUrl: '',
      remoteUrlSafe: '',
      hasRemote: false,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      isDirty: false,
      dirtyCounts: { staged: 0, unstaged: 0, untracked: 0, total: 0 },
      recentLog: '',
      additionalDirs: _getAdditionalDirs(),
    };
  }

  const root = _git('rev-parse --show-toplevel', cwd) || cwd;
  const remoteUrl = _git('remote get-url origin', cwd) || '';
  const status = _git('status --short -u', cwd) || '';
  const { ahead, behind, hasUpstream } = _aheadBehind(cwd);

  return {
    root,
    cwd,
    isGitRepo: true,
    branch: git.branch || '',
    mainBranch: git.mainBranch || '',
    remoteUrl,
    remoteUrlSafe: redactRemote(remoteUrl),
    hasRemote: remoteUrl.length > 0,
    hasUpstream,
    ahead,
    behind,
    isDirty: !!git.isDirty,
    dirtyCounts: _countDirty(status),
    recentLog: git.recentLog || '',
    additionalDirs: _getAdditionalDirs(),
  };
}

/**
 * Render a compact, beginner-friendly Chinese summary of the workspace.
 * Used by the pre-execution explainer and `khy repo`/`/git` overviews.
 * @param {WorkspaceContext} ctx
 * @returns {string}
 */
function formatSummary(ctx) {
  if (!ctx) return '工作区信息不可用';
  if (!ctx.isGitRepo) {
    const extra = ctx.additionalDirs && ctx.additionalDirs.length
      ? `；额外目录 ${ctx.additionalDirs.length} 个` : '';
    return `工作区：${ctx.root}（非 git 仓库，版本控制不可用）${extra}`;
  }

  const lines = [];
  lines.push(`工作区：${ctx.root}`);
  lines.push(`分支：${ctx.branch}${ctx.mainBranch && ctx.mainBranch !== ctx.branch ? `（主分支 ${ctx.mainBranch}）` : ''}`);

  if (ctx.hasRemote) {
    const sync = [];
    if (ctx.ahead) sync.push(`领先 ${ctx.ahead} 个提交`);
    if (ctx.behind) sync.push(`落后 ${ctx.behind} 个提交`);
    const syncTxt = !ctx.hasUpstream ? '尚未设置上游分支'
      : sync.length ? sync.join('、') : '与远端同步';
    lines.push(`远端：${ctx.remoteUrlSafe || redactRemote(ctx.remoteUrl)}（${syncTxt}）`);
  } else {
    lines.push('远端：未配置（push 前需先添加 origin）');
  }

  if (ctx.isDirty) {
    const c = ctx.dirtyCounts;
    lines.push(`改动：已暂存 ${c.staged}、未暂存 ${c.unstaged}、未跟踪 ${c.untracked}（共 ${c.total} 项待保存）`);
  } else {
    lines.push('改动：工作区干净，无未保存内容');
  }

  if (ctx.additionalDirs && ctx.additionalDirs.length) {
    lines.push(`额外目录：${ctx.additionalDirs.length} 个`);
  }

  return lines.join('\n');
}

module.exports = {
  collectWorkspaceContext,
  formatSummary,
  redactRemote,
  // test seams
  _countDirty,
  _aheadBehind,
};
