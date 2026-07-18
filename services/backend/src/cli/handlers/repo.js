'use strict';

/**
 * CLI Handler: repo — beginner-safe version-management entry.
 *
 * Goal: give non-expert users a small, clear, low-risk surface over Git,
 * using plain language ("保存版本快照" instead of "commit"). This is NOT a
 * full Git wrapper — it intentionally omits high-blast-radius operations
 * (reset --hard, clean, rebase, cherry-pick, complex stash, conflict resolve).
 *
 * Subcommands:
 *   khy repo status                 # 用人话说明当前状态
 *   khy repo save "<说明>"          # add -A + commit（保存一个版本快照）
 *   khy repo history [--limit <n>]  # 看最近保存过哪些版本
 *   khy repo branch list            # 列出分支
 *   khy repo branch switch <name>   # 切换分支（仅安全切换）
 *   khy repo publish [...]          # 发布到远程（接现有 publish git-push 能力）
 *
 * All Git invocations go through execFileSync('git', [...]) so user-provided
 * text (e.g. commit messages, branch names) is passed as argv and never
 * interpreted by a shell.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk').default || require('chalk');
const {
  printSuccess, printError, printWarn, printInfo,
} = require('../formatters');
const repoDiscipline = require('../../services/repoDisciplineRisk');

const DEFAULT_HISTORY_LIMIT = 15;

// ─── Git helpers ─────────────────────────────────────────────────────────────

function _cwd() {
  return process.cwd();
}

/**
 * Run a git command and return trimmed stdout. Throws on non-zero exit.
 */
function _git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: _cwd(),
    encoding: 'utf-8',
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).toString();
}

/**
 * Run a git command, returning { ok, out, err } instead of throwing. Useful
 * for commands whose failure is an expected branch (e.g. no commits yet).
 */
function _gitSoft(args, options = {}) {
  try {
    const out = _git(args, options);
    return { ok: true, out: out.trim(), err: '' };
  } catch (err) {
    const stderr = (err && err.stderr ? err.stderr.toString() : '') || '';
    return { ok: false, out: '', err: (stderr || err.message || String(err)).trim() };
  }
}

function _isGitRepo() {
  const res = _gitSoft(['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.out === 'true';
}

function _requireRepo() {
  if (_isGitRepo()) return true;
  printError('当前目录还不是一个版本库（没有用 Git 管理）。');
  printInfo('如果想开始管理版本，可以先在项目目录运行: git init');
  printInfo('然后用 `khy repo save "第一个版本"` 保存第一个快照。');
  return false;
}

function _currentBranch() {
  const res = _gitSoft(['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!res.ok) return null;
  return res.out === 'HEAD' ? null : res.out; // detached HEAD
}

/**
 * Parse `git status --porcelain` into beginner-friendly counts.
 */
function _statusSummary() {
  const res = _gitSoft(['status', '--porcelain']);
  const lines = res.ok ? res.out.split(/\r?\n/).filter(Boolean) : [];
  let modified = 0;
  let created = 0;
  let deleted = 0;
  let staged = 0;
  for (const line of lines) {
    const index = line[0]; // staged side
    const work = line[1]; // working-tree side
    const code = line.slice(0, 2);
    if (code === '??') {
      created += 1;
      continue;
    }
    if (index !== ' ' && index !== '?') staged += 1;
    if (index === 'A' || work === 'A') created += 1;
    else if (index === 'D' || work === 'D') deleted += 1;
    else if (index === 'M' || work === 'M' || index === 'R' || work === 'R') modified += 1;
  }
  return {
    total: lines.length,
    modified,
    created,
    deleted,
    staged,
    clean: lines.length === 0,
  };
}

// ─── status ──────────────────────────────────────────────────────────────────

function handleStatus() {
  if (!_requireRepo()) return true;

  const branch = _currentBranch();
  const s = _statusSummary();
  const last = _gitSoft(['log', '-1', '--pretty=%h｜%s']);

  console.log(chalk.bold('\n  📂 当前项目状态\n'));
  console.log(`  当前分支:   ${branch ? chalk.cyan(branch) : chalk.yellow('（游离状态，未在分支上）')}`);

  if (s.clean) {
    console.log(`  改动情况:   ${chalk.green('干净 — 没有未保存的改动')}`);
  } else {
    const parts = [];
    if (s.modified) parts.push(`改了 ${chalk.yellow(s.modified)} 个文件`);
    if (s.created) parts.push(`新建 ${chalk.yellow(s.created)} 个文件`);
    if (s.deleted) parts.push(`删除 ${chalk.yellow(s.deleted)} 个文件`);
    console.log(`  改动情况:   ${parts.join('，') || `${s.total} 处改动`}`);
    console.log(`  是否已保存: ${chalk.yellow('有未保存的改动')} — 用 \`khy repo save "说明"\` 保存一个版本`);
  }

  if (last.ok && last.out) {
    const [hash, ...rest] = last.out.split('｜');
    console.log(`  最近版本:   ${chalk.dim(hash)}  ${rest.join('｜') || ''}`);
  } else {
    console.log(`  最近版本:   ${chalk.dim('还没有保存过任何版本')}`);
  }
  console.log('');
  return true;
}

// ─── save ────────────────────────────────────────────────────────────────────

function handleSave(args = [], options = {}) {
  if (!_requireRepo()) return true;

  const message = (options.m || options.message || args.join(' ') || '').trim();
  if (!message) {
    printError('请为这个版本写一句说明。');
    printInfo('用法: khy repo save "说明你这次改了什么"');
    return true;
  }

  const s = _statusSummary();
  if (s.clean) {
    printInfo('没有需要保存的改动 — 当前已经是最新版本。');
    return true;
  }

  const add = _gitSoft(['add', '-A']);
  if (!add.ok) {
    printError(`保存失败（添加文件时出错）: ${add.err}`);
    return true;
  }

  // 提交前自检:检出密钥/大文件/产物则醒目提示(默认只提示不阻断;
  // KHY_COMMIT_PRECHECK_BLOCK=on 时阻断),并把「本不该提交的文件」入 /gitignore 待审核队列。
  // fail-soft:自检本身出错绝不阻塞保存。
  const noVerify = !!(options['no-verify'] || options.noVerify);
  try {
    const precheck = require('../../services/precommitCheck');
    const chk = precheck.runPrecommitCheck({
      cwd: _cwd(),
      message,
      addAll: true,
      noVerify,
      log: (line, style) => {
        const paint = _VERDICT_STYLE[style] || ((t) => t);
        console.log(style === 'info' ? chalk.dim(line) : paint(line));
      },
    });
    if (chk && chk.shouldBlock) {
      printError('保存被自检阻断（KHY_COMMIT_PRECHECK_BLOCK=on）：存在严重风险。解决后重试，或用 `--no-verify` 跳过自检。');
      return true;
    }
  } catch { /* fail-soft */ }

  const commit = _gitSoft(['commit', '-m', message]);
  if (!commit.ok) {
    printError(`保存失败: ${commit.err}`);
    return true;
  }

  const head = _gitSoft(['log', '-1', '--pretty=%h']);
  printSuccess(`已保存一个版本快照${head.ok ? `（${head.out}）` : ''}`);
  printInfo(`说明: ${message}`);
  printInfo('想回看历史版本，用 `khy repo history`。');
  return true;
}

// ─── history ─────────────────────────────────────────────────────────────────

function handleHistory(args = [], options = {}) {
  if (!_requireRepo()) return true;

  let limit = parseInt(options.limit || options.n || args[0], 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_HISTORY_LIMIT;

  const res = _gitSoft(['log', `-n`, String(limit), '--pretty=%h｜%cr｜%s']);
  if (!res.ok || !res.out) {
    printInfo('还没有保存过任何版本。用 `khy repo save "说明"` 保存第一个。');
    return true;
  }

  console.log(chalk.bold('\n  🕑 最近保存的版本\n'));
  for (const line of res.out.split(/\r?\n/).filter(Boolean)) {
    const [hash, when, ...rest] = line.split('｜');
    console.log(`  ${chalk.yellow(hash)}  ${chalk.dim((when || '').padEnd(12))}  ${rest.join('｜') || ''}`);
  }
  console.log('');
  return true;
}

// ─── branch ──────────────────────────────────────────────────────────────────

function _branchList() {
  if (!_requireRepo()) return true;
  const res = _gitSoft(['branch']);
  const current = _currentBranch();
  console.log(chalk.bold('\n  🌿 分支列表\n'));
  if (!res.ok || !res.out) {
    printInfo('  还没有任何分支记录。');
    console.log('');
    return true;
  }
  for (const raw of res.out.split(/\r?\n/).filter(Boolean)) {
    const name = raw.replace(/^[*+]?\s*/, '').trim();
    const isCurrent = name === current;
    const mark = isCurrent ? chalk.green('● ') : '  ';
    console.log(`  ${mark}${isCurrent ? chalk.green(name) : name}`);
  }
  if (current) console.log(chalk.dim(`\n  ● = 当前所在分支 (${current})`));
  console.log('');
  return true;
}

function _branchSwitch(args = []) {
  if (!_requireRepo()) return true;
  const name = (args[0] || '').trim();
  if (!name) {
    printError('请告诉我要切换到哪个分支。');
    printInfo('用法: khy repo branch switch <分支名>（先用 `khy repo branch list` 看有哪些）');
    return true;
  }

  const s = _statusSummary();
  if (!s.clean) {
    printWarn('当前有未保存的改动。建议先 `khy repo save "说明"` 保存，再切换分支。');
  }

  // Prefer `git switch` (safe, refuses to overwrite local changes); fall back
  // to `git checkout` on older Git. Neither flag here is destructive.
  let res = _gitSoft(['switch', name]);
  if (!res.ok) {
    const fallback = _gitSoft(['checkout', name]);
    if (fallback.ok) res = fallback;
  }

  if (!res.ok) {
    printError(`切换分支失败: ${res.err}`);
    if (/local changes|overwritten|未提交|local modifications/i.test(res.err)) {
      printInfo('原因通常是有未保存的改动。先 `khy repo save "说明"` 保存后再试。');
    } else {
      printInfo('确认分支名是否正确，可用 `khy repo branch list` 查看。');
    }
    return true;
  }

  printSuccess(`已切换到分支: ${name}`);
  return true;
}

function handleBranch(args = [], options = {}) {
  const verb = (args[0] || 'list').toLowerCase();
  const rest = args.slice(1);
  switch (verb) {
    case 'list':
    case 'ls':
      return _branchList();
    case 'switch':
    case 'checkout':
    case 'use':
      return _branchSwitch(rest, options);
    default:
      // `khy repo branch <name>` with no verb → treat as switch target.
      if (verb && !['list', 'switch'].includes(verb)) {
        return _branchSwitch([verb, ...rest], options);
      }
      return _branchList();
  }
}

// ─── workspace overview ────────────────────────────────────────────────────

/**
 * `khy repo workspace` — show the first-class workspace context: where you are,
 * the branch, the remote, how far ahead/behind, and what's unsaved. This is the
 * human-facing surface of services/workspace/workspaceContext.js (the same data
 * object that grounds pre-execution explanations), so the two never diverge.
 */
function handleWorkspaceOverview() {
  let ctx;
  try {
    const { collectWorkspaceContext } = require('../../services/workspace/workspaceContext');
    ctx = collectWorkspaceContext(_cwd(), { force: true });
  } catch (err) {
    printError(`读取工作区信息失败: ${err.message || String(err)}`);
    return true;
  }

  console.log(chalk.bold('\n  🗂  当前工作区\n'));
  console.log(`  位置:       ${chalk.cyan(ctx.root)}`);

  if (!ctx.isGitRepo) {
    console.log(`  版本控制:   ${chalk.yellow('未启用（这里不是 git 仓库）')}`);
    if (ctx.additionalDirs && ctx.additionalDirs.length) {
      console.log(`  额外目录:   ${chalk.dim(`${ctx.additionalDirs.length} 个`)}`);
    }
    console.log(chalk.dim('\n  提示: 在项目根目录运行 `git init` 即可启用版本管理。\n'));
    return true;
  }

  console.log(`  当前分支:   ${ctx.branch ? chalk.cyan(ctx.branch) : chalk.yellow('（游离状态）')}`
    + (ctx.mainBranch && ctx.mainBranch !== ctx.branch ? chalk.dim(`  (主分支 ${ctx.mainBranch})`) : ''));

  if (ctx.hasRemote) {
    const sync = [];
    if (ctx.ahead) sync.push(chalk.yellow(`领先 ${ctx.ahead} 个提交`));
    if (ctx.behind) sync.push(chalk.yellow(`落后 ${ctx.behind} 个提交`));
    const syncTxt = !ctx.hasUpstream ? chalk.dim('尚未设置上游分支')
      : sync.length ? sync.join('、') : chalk.green('与远端同步');
    console.log(`  远端:       ${chalk.dim(ctx.remoteUrlSafe || ctx.remoteUrl)}`);
    console.log(`  同步状态:   ${syncTxt}`);
  } else {
    console.log(`  远端:       ${chalk.yellow('未配置')} ${chalk.dim('— 发布前需先添加 origin')}`);
  }

  if (ctx.isDirty) {
    const c = ctx.dirtyCounts;
    console.log(`  改动情况:   ${chalk.yellow(`${c.total} 项待保存`)} `
      + chalk.dim(`(已暂存 ${c.staged}、未暂存 ${c.unstaged}、未跟踪 ${c.untracked})`));
    console.log(chalk.dim('              用 `khy repo save "说明"` 保存一个版本快照。'));
  } else {
    console.log(`  改动情况:   ${chalk.green('干净 — 没有未保存的改动')}`);
  }

  if (ctx.additionalDirs && ctx.additionalDirs.length) {
    console.log(`  额外目录:   ${chalk.dim(`${ctx.additionalDirs.length} 个`)}`);
  }
  console.log('');
  return true;
}

// ─── publish ─────────────────────────────────────────────────────────────────

async function handlePublishToRemote(args = [], options = {}) {
  if (!_requireRepo()) return true;
  printInfo('准备把你保存的版本发布到远程仓库…');
  const s = _statusSummary();
  if (!s.clean) {
    printWarn('当前还有未保存的改动，它们不会被发布。如需一起发布，先 `khy repo save "说明"`。');
  }
  try {
    const { handlePublish } = require('./publish');
    // Reuse the existing, battle-tested git-push capability.
    return await handlePublish('git-push', args, options);
  } catch (err) {
    printError(`发布失败: ${err.message || String(err)}`);
    printInfo('如果还没配置远程，可加 --repo owner/repo 指定要发布到的仓库。');
    return true;
  }
}

// ─── audit (discipline & risk) ───────────────────────────────────────────────

function _detectMainBranch() {
  const ref = _gitSoft(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  if (ref.ok && ref.out.includes('/')) return ref.out.split('/').pop();
  return undefined;
}

function _statSize(rel) {
  try {
    return fs.statSync(path.join(_cwd(), rel)).size;
  } catch {
    return undefined;
  }
}

const _VERDICT_STYLE = {
  clean: (t) => chalk.green(t),
  caution: (t) => chalk.yellow(t),
  block: (t) => chalk.red(t),
};
const _SEV_ICON = { critical: '⛔', high: '⚠️', medium: '•', low: '·' };

function handleAudit(args = [], options = {}) {
  if (!_requireRepo()) return true;

  const branch = _currentBranch() || undefined;
  const mainBranch = _detectMainBranch();

  const staged = _gitSoft(['diff', '--cached', '--name-only']);
  const stagedFiles = staged.ok && staged.out ? staged.out.split(/\r?\n/).filter(Boolean) : [];
  const useStaged = stagedFiles.length > 0;
  const diff = _gitSoft(useStaged ? ['diff', '--cached'] : ['diff']);
  const names = _gitSoft(useStaged ? ['diff', '--cached', '--name-only'] : ['diff', '--name-only']);
  const fileList = names.ok && names.out ? names.out.split(/\r?\n/).filter(Boolean) : [];
  const files = fileList.map((rel) => ({ path: rel, size: _statSize(rel) }));

  const report = repoDiscipline.assessRepoRisk({
    branch,
    mainBranch,
    force: !!(options.force || options.f),
    noVerify: !!(options['no-verify'] || options.noVerify),
    amend: !!options.amend,
    files,
    diffText: diff.ok ? diff.out : '',
    message: options.m || options.message,
  });

  console.log(chalk.bold('\n  🛡  仓库纪律与风险体检\n'));
  if (!report.enabled) {
    printInfo(report.summary);
    return true;
  }
  console.log(`  范围:   ${useStaged ? '已暂存改动(即将提交)' : '工作区改动(未暂存)'} · ${files.length} 个文件`);
  console.log(`  分支:   ${branch ? chalk.cyan(branch) : chalk.yellow('(游离)')}`);
  const vstyle = _VERDICT_STYLE[report.verdict] || ((t) => t);
  console.log(`  裁决:   ${vstyle(report.verdict.toUpperCase())} — ${report.summary}\n`);

  if (report.findings.length === 0) {
    printSuccess('没有发现明显的纪律或风险问题。');
  } else {
    for (const f of report.findings) {
      const icon = _SEV_ICON[f.severity] || '•';
      const where = f.path ? chalk.dim(` [${f.path}${f.line ? `:${f.line}` : ''}]`) : '';
      console.log(`  ${icon} ${f.message}${where}`);
    }
  }
  console.log('');
  if (report.verdict === 'block') {
    printWarn('存在须立即处理的严重风险,建议解决后再提交/推送。');
  }
  printInfo('看完整纪律清单: `khy repo charter`');
  return true;
}

function handleCharter() {
  const c = repoDiscipline.describeDisciplineCharter();
  console.log(chalk.bold('\n  📜 仓库纪律宪章'));
  console.log(chalk.dim(`  门控 ${c.gate} · 当前${c.enabled ? '已启用' : '已关闭'}\n`));
  for (const r of c.rules) {
    const icon = _SEV_ICON[r.severity] || '•';
    console.log(`  ${icon} ${chalk.bold(r.rule)}`);
    console.log(`     ${chalk.dim(r.why)}`);
  }
  console.log('');
  printInfo('对当前改动做一次体检: `khy repo audit`');
  return true;
}

// ─── usage / dispatch ────────────────────────────────────────────────────────

function _usage() {
  printInfo('用法（小白安全版版本管理）:');
  printInfo('  khy repo workspace              # 看当前工作区全貌（位置/分支/远端/改动）');
  printInfo('  khy repo status                 # 用人话说明当前状态');
  printInfo('  khy repo save "<说明>"          # 保存一个版本快照（= commit）');
  printInfo('  khy repo history [--limit <n>]  # 看最近保存过哪些版本');
  printInfo('  khy repo branch list            # 列出分支');
  printInfo('  khy repo branch switch <name>   # 切换分支');
  printInfo('  khy repo publish [--repo owner/repo]  # 发布到远程（= push）');
  printInfo('  khy repo audit                  # 提交前体检：密钥/大文件/提交信息/分支纪律');
  printInfo('  khy repo charter                # 看仓库纪律宪章（所有红线规则）');
}

async function handleRepo(subCommand, args = [], options = {}) {
  const sub = (subCommand || '').toLowerCase();
  switch (sub) {
    case 'status':
    case '':
      return handleStatus();
    case 'workspace':
    case 'ws':
    case 'info':
      return handleWorkspaceOverview();
    case 'save':
    case 'commit':
      return handleSave(args, options);
    case 'history':
    case 'log':
      return handleHistory(args, options);
    case 'branch':
      return handleBranch(args, options);
    case 'publish':
    case 'push':
      return handlePublishToRemote(args, options);
    case 'audit':
    case 'risk':
    case 'check':
      return handleAudit(args, options);
    case 'charter':
    case 'rules':
    case 'discipline':
      return handleCharter();
    case 'help':
      _usage();
      return true;
    default:
      printError(`未知子命令: repo ${subCommand}`);
      _usage();
      return true;
  }
}

module.exports = {
  handleRepo,
  // Exported for tests.
  _statusSummary,
  _isGitRepo,
};
