/**
 * /worktree command subsystem: manual isolated git-worktree control for the MAIN
 * session (enter | exit | list | status).
 *
 * Khy already ships git-worktree isolation, but only AgentTool wires it (opt-in
 * subagent sandboxing). The main REPL edited files directly, protected only by the
 * cross-process file lock and the red/green write diff — there was no "open an
 * isolated branch, work, then merge or discard" seam. This module exposes exactly
 * that on the main session, reusing `worktreeManager` for the git lifecycle.
 *
 * Critically it keeps the session's DUAL cwd source in sync on every switch:
 *   - `process.env.KHYQUANT_CWD` — honored by file tools, the file lock
 *     (_fileLock.resolveTargetPath), the red/green diff (_captureWriteFileDiffContext),
 *     and auto-checkpoint.
 *   - `process.chdir` — honored by the prompt and any `process.cwd()` consumer.
 * The pre-existing EnterWorktreeTool switched only `process.chdir`, which would
 * leave file tools anchored at the old root; this module fixes that duality.
 *
 * Pure dispatch + cwd bookkeeping. All git work is delegated to worktreeManager,
 * and every external dependency is injectable so the dispatcher is unit-testable
 * without touching a real repo. `_atCurrentDir` lives in the repl startRepl
 * closure, so the caller passes an `onCwdChange` callback to keep it aligned.
 */

'use strict';

const path = require('path');

let _formatters = null;
const fmt = () => (_formatters ??= require('../formatters'));

// Session-scoped: the root to return to when exiting the active worktree. Set on
// `enter`, cleared on `exit`. Mirrors repl.js's own `_atCurrentDir` lifecycle.
let _returnCwd = null;

const USAGE = [
  '用法: /worktree <子命令>',
  '  enter [名称]         开一个隔离的 git worktree 并切入（不传名称则自动生成）',
  '  exit [keep|remove]   退出当前隔离工作区（默认 keep 保留待合并；remove 删除）',
  '  exit remove --force  即使有未提交改动也强制删除',
  '  list                 列出所有 worktree',
  '  status               显示当前是否在隔离工作区及其路径',
].join('\n');

function _parseArgs(argStr) {
  const parts = String(argStr || '').trim().split(/\s+/).filter(Boolean);
  return { sub: (parts[0] || '').toLowerCase(), rest: parts.slice(1) };
}

function _defaultOut() {
  const { printSuccess, printInfo, printWarn, printError } = fmt();
  return {
    // Plain detail/usage lines print without an icon; status headlines keep theirs.
    info: (m) => console.log(m),
    success: (m) => printSuccess(m),
    warn: (m) => printWarn(m),
    error: (m) => printError(m),
    _printInfo: printInfo,
  };
}

// Fallback to compute the main working tree root when `_returnCwd` is unknown
// (e.g. the session was started already inside a worktree). Uses git's common-dir.
function _mainRootFallback(here) {
  try {
    const { execSync } = require('child_process');
    const commonDir = execSync('git rev-parse --git-common-dir', { cwd: here, encoding: 'utf-8' }).trim();
    return path.resolve(here, commonDir, '..');
  } catch {
    return null;
  }
}

/**
 * Dispatch a `/worktree` subcommand.
 *
 * @param {string} argStr - everything after `/worktree` (may be empty → usage)
 * @param {object} [deps]
 * @param {object} [deps.worktreeManager] - injected for tests
 * @param {object} [deps.env] - defaults to process.env
 * @param {(dir:string)=>void} [deps.chdir] - defaults to process.chdir
 * @param {()=>string} [deps.cwd] - defaults to process.cwd
 * @param {object} [deps.out] - {info,success,warn,error}
 * @param {(dir:string)=>void} [deps.onCwdChange] - keep repl `_atCurrentDir` in sync
 * @returns {Promise<{status:string, [k:string]:any}>}
 */
async function runWorktreeCommand(argStr, deps = {}) {
  const wm = deps.worktreeManager || require('../../services/worktreeManager');
  const env = deps.env || process.env;
  const chdir = deps.chdir || ((d) => process.chdir(d));
  const rawCwd = deps.cwd || (() => process.cwd());
  const out = deps.out || _defaultOut();
  const onCwdChange = deps.onCwdChange || (() => {});

  const cwdOf = () => env.KHYQUANT_CWD || rawCwd();
  // Switch BOTH cwd sources so file tools, lock, diff, checkpoint and the prompt agree.
  const switchCwd = (target) => {
    env.KHYQUANT_CWD = target;
    try { chdir(target); } catch { /* KHYQUANT_CWD is authoritative for tools; chdir best-effort */ }
    onCwdChange(target);
  };

  const { sub, rest } = _parseArgs(argStr);

  if (sub === 'enter') {
    const here = cwdOf();
    if (!wm.getGitRoot(here)) {
      out.warn('当前不是 git 仓库，无法开隔离工作区。');
      return { status: 'not-git' };
    }
    if (wm.isInsideWorktree(here)) {
      out.warn('已在隔离工作区内。先 /worktree exit 再开新的。');
      return { status: 'already-inside' };
    }
    try {
      const result = wm.createWorktree({ name: rest[0], cwd: here });
      _returnCwd = here;
      switchCwd(result.path);
      out.success(`已进入隔离工作区: ${result.name}`);
      out.info(`  分支: ${result.branch}`);
      out.info(`  路径: ${result.path}`);
      out.info('  干完后用 /worktree exit remove（丢弃）或 exit keep（保留待合并）。');
      return { status: 'entered', name: result.name, branch: result.branch, path: result.path };
    } catch (e) {
      out.error(`开隔离工作区失败: ${e.message}`);
      return { status: 'error', error: e.message };
    }
  }

  if (sub === 'exit') {
    const here = cwdOf();
    if (!wm.isInsideWorktree(here)) {
      out.warn('当前不在隔离工作区。');
      return { status: 'not-in-worktree' };
    }
    const action = rest.some((r) => r.toLowerCase() === 'remove') ? 'remove' : 'keep';
    const force = rest.some((r) => r === '--force' || r === '-f');
    const back = _returnCwd || _mainRootFallback(here);

    if (action === 'remove') {
      let res;
      try {
        res = wm.removeWorktree(here, { force });
      } catch (e) {
        out.error(`删除隔离工作区失败: ${e.message}`);
        return { status: 'error', error: e.message };
      }
      if (!res.removed) {
        out.warn('隔离工作区有未提交改动，未删除。');
        out.info('  先提交，或用 /worktree exit remove --force 强制丢弃。');
        return { status: 'blocked', uncommittedChanges: res.uncommittedChanges };
      }
      if (back) switchCwd(back);
      _returnCwd = null;
      out.success('已退出并删除隔离工作区。');
      return { status: 'removed', returnedTo: back };
    }

    // keep — leave the worktree + branch on disk for manual review/merge.
    const name = path.basename(here);
    try { wm.keepWorktree(name, { cwd: back || undefined }); } catch { /* audit only */ }
    if (back) switchCwd(back);
    _returnCwd = null;
    out.success(`已退出隔离工作区（保留待合并）: ${name}`);
    return { status: 'kept', name, returnedTo: back };
  }

  if (sub === 'list') {
    const items = wm.listWorktrees(cwdOf()) || [];
    if (!items.length) {
      out.info('没有 worktree。');
    } else {
      out.info('Worktree 列表:');
      for (const w of items) out.info(`  ${w.path}${w.branch ? '  [' + w.branch + ']' : ''}`);
    }
    return { status: 'list', items };
  }

  if (sub === 'status') {
    const here = cwdOf();
    const inside = wm.isInsideWorktree(here);
    out.info(`隔离工作区: ${inside ? '是' : '否'}`);
    out.info(`  当前路径: ${here}`);
    if (inside && _returnCwd) out.info(`  退出将返回: ${_returnCwd}`);
    return { status: 'status', inside, path: here };
  }

  // bare /worktree or unknown subcommand → usage.
  out.info(USAGE);
  return { status: 'usage' };
}

// Test hooks — reset/inspect the session-scoped return-cwd between cases.
function __resetForTest() { _returnCwd = null; }
function __stateForTest() { return { returnCwd: _returnCwd }; }

module.exports = { runWorktreeCommand, USAGE, __resetForTest, __stateForTest };
