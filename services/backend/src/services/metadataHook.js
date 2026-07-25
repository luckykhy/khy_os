'use strict';

/**
 * metadataHook — 确定性的 git pre-commit 钩子安装器（「不靠 AI 自动更新元数据」的机制层）。
 *
 * 落地用户 /goal：「ai 元数据要能随项目更新……产生变化就需要即时更新，最好不靠 AI 自动完成」。
 * 钩子在每次 `git commit` 前确定性地运行 `khy metadata refresh` 并把刷新后的 `.ai/` 重新入暂存，
 * 使元数据永远与即将提交的代码同步——全程无需任何模型/网络。
 *
 * 设计原则：
 *   - 非破坏性：已存在「非本工具」的 pre-commit 钩子时，绝不覆盖；返回待手工插入的片段。
 *   - 幂等：已是本工具的钩子则原地更新到最新模板。
 *   - Fail-soft：钩子脚本本身永不阻断提交（khy 不可用、刷新失败都静默放过）。
 *   - 纯 Node stdlib + git CLI 探测，无第三方依赖。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOOK_MARKER = 'khy-metadata-hook';
const HOOK_VERSION = 'v3';

// 刷新后需一并入暂存的路径：.ai/ 三件套 + 各 AI 工具入口文件（指向 .ai/ 的指针）。
// 静态枚举（钩子是纯 sh，无法动态发现）；不存在的路径用守卫跳过。
const STAGE_PATHS = [
  '.ai',
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursor/rules/khy-maintainability.mdc',
  '.windsurfrules',
  '.clinerules',
];

// 钩子脚本内容（POSIX sh）。marker 行用于探测/幂等/安全卸载。
function _hookScript() {
  const stageLines = STAGE_PATHS.map(
    p => `[ -e "$REPO_ROOT/${p}" ] && git add "$REPO_ROOT/${p}" >/dev/null 2>&1 || true`,
  );
  return [
    '#!/bin/sh',
    `# ${HOOK_MARKER} ${HOOK_VERSION}  (managed by \`khy metadata hook\`)`,
    '# Keeps .ai/ maintainability metadata + AI entry-point pointers in sync on every',
    '# commit — no AI required. Uninstall with: khy metadata hook uninstall',
    '',
    'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
    'RUNNER=""',
    'if command -v khy >/dev/null 2>&1; then RUNNER="khy"; fi',
    'if [ -n "$KHY_BIN" ]; then RUNNER="$KHY_BIN"; fi',
    'if [ -z "$RUNNER" ]; then',
    '  exit 0   # khy unavailable → skip silently (never block a commit)',
    'fi',
    '# Deterministic, AI-free refresh; failures are swallowed (fail-soft).',
    '$RUNNER metadata refresh "$REPO_ROOT" >/dev/null 2>&1 || true',
    '# Re-stage refreshed metadata + pointers so they land in this very commit.',
    ...stageLines,
    '# Docs freshness: after source changes, keep committed doc products / marked',
    '# values in sync and re-stage them (deterministic, offline, fail-soft; the',
    '# staleness reminder itself is warn-only and never blocks a commit).',
    '$RUNNER docs check --fix --staged >/dev/null 2>&1 || true',
    'exit 0',
    '',
  ].join('\n');
}

function _git(args, cwd) {
  return String(execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })).trim();
}

/** 解析包含 startDir 的 git 仓库顶层目录；非仓库返回 null。 */
function resolveGitRoot(startDir) {
  const cwd = path.resolve(startDir || process.cwd());
  try {
    const top = _git(['rev-parse', '--show-toplevel'], cwd);
    return top || null;
  } catch {
    return null;
  }
}

/** 解析 hooks 目录（兼容 worktree / 自定义 core.hooksPath）。 */
function _resolveHooksDir(repoRoot) {
  try {
    const p = _git(['rev-parse', '--git-path', 'hooks'], repoRoot);
    return path.isAbsolute(p) ? p : path.join(repoRoot, p);
  } catch {
    return path.join(repoRoot, '.git', 'hooks');
  }
}

function _isOurs(text) {
  return typeof text === 'string' && text.includes(HOOK_MARKER);
}

/**
 * 安装 pre-commit 钩子。
 * @returns {{ok:boolean, action:'installed'|'updated'|'foreign_hook'|'not_a_repo', preCommit?:string, snippet?:string, reason?:string}}
 */
function installHook(startDir) {
  const repoRoot = resolveGitRoot(startDir);
  if (!repoRoot) return { ok: false, action: 'not_a_repo', reason: 'not_a_git_repository' };

  const hooksDir = _resolveHooksDir(repoRoot);
  const preCommit = path.join(hooksDir, 'pre-commit');
  const script = _hookScript();

  let existed = false;
  let ours = false;
  if (fs.existsSync(preCommit)) {
    existed = true;
    ours = _isOurs(_readSafe(preCommit));
  }

  if (existed && !ours) {
    // 非破坏性：不覆盖外部钩子，给出可手工链入的片段。
    const snippet = [
      `# >>> ${HOOK_MARKER} ${HOOK_VERSION} >>>`,
      'REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)',
      'if command -v khy >/dev/null 2>&1; then khy metadata refresh "$REPO_ROOT" >/dev/null 2>&1 || true; git add "$REPO_ROOT/.ai" >/dev/null 2>&1 || true; khy docs check --fix --staged >/dev/null 2>&1 || true; fi',
      `# <<< ${HOOK_MARKER} ${HOOK_VERSION} <<<`,
    ].join('\n');
    return { ok: false, action: 'foreign_hook', preCommit, snippet, reason: 'existing_non_khy_pre_commit' };
  }

  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(preCommit, script, 'utf8');
  try { fs.chmodSync(preCommit, 0o755); } catch { /* non-fatal on platforms without chmod */ }
  return { ok: true, action: existed ? 'updated' : 'installed', preCommit };
}

/**
 * 卸载 pre-commit 钩子（仅当其为本工具所装）。
 * @returns {{ok:boolean, action:'removed'|'not_ours'|'absent'|'not_a_repo', preCommit?:string}}
 */
function uninstallHook(startDir) {
  const repoRoot = resolveGitRoot(startDir);
  if (!repoRoot) return { ok: false, action: 'not_a_repo' };
  const preCommit = path.join(_resolveHooksDir(repoRoot), 'pre-commit');
  if (!fs.existsSync(preCommit)) return { ok: true, action: 'absent', preCommit };
  if (!_isOurs(_readSafe(preCommit))) return { ok: false, action: 'not_ours', preCommit };
  fs.rmSync(preCommit, { force: true });
  return { ok: true, action: 'removed', preCommit };
}

/** 钩子状态。 */
function hookStatus(startDir) {
  const repoRoot = resolveGitRoot(startDir);
  if (!repoRoot) return { repo: null, installed: false, ours: false, foreign: false, preCommit: null };
  const preCommit = path.join(_resolveHooksDir(repoRoot), 'pre-commit');
  const exists = fs.existsSync(preCommit);
  const ours = exists && _isOurs(_readSafe(preCommit));
  return { repo: repoRoot, installed: exists, ours, foreign: exists && !ours, preCommit };
}

// 收敛到 utils/readFileSyncSafe 单一真源(逐字节委托,调用点不变)
const _readSafe = require('../utils/readFileSyncSafe');

module.exports = {
  installHook,
  uninstallHook,
  hookStatus,
  resolveGitRoot,
  HOOK_MARKER,
  HOOK_VERSION,
  _internal: { _hookScript, _resolveHooksDir, _isOurs },
};
