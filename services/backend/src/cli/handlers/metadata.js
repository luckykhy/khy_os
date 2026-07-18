'use strict';

/**
 * metadata handler — `khy metadata …`
 *
 * 手动生成/校验项目可维护性元数据（`.ai/` 种子文档）。与 agent 自动生成共用
 * 同一确定性生成器（projectMetadataService），供以下场景：
 *   - 给"AI 自动生成之前就已存在"的老项目补元数据。
 *   - CI/提交前强制门禁：`khy metadata check` 缺元数据时退出非零。
 *   - 维护者手动刷新：`khy metadata gen --force`。
 *
 *   khy metadata               等同 gen（对当前目录生成，已存在则跳过）
 *   khy metadata gen [--force] [path]
 *   khy metadata refresh [--force] [path]  随项目变化就地更新（非破坏，人工 .ai/ 只刷新派生骨架）
 *   khy metadata check [path]   缺失或 stale 时退出非零（CI 门禁）
 *   khy metadata show [path]    打印元数据位置与状态
 *   khy metadata link [path]    让 AI 入口文件(AGENTS/CLAUDE/copilot/cursor…)指向 .ai/
 *   khy metadata hook <install|uninstall|status> [path]  装/卸 git pre-commit 自动刷新钩子
 *
 * 别名：meta。
 * 注意：`khy maintain <gen|refresh|check|show|link|hook>` 也分流到本 handler（见 router），
 * 但裸 `khy maintain` / `khy maintain status|audit` 是维护者驾驶舱（handlers/maintain.js）。
 */

const path = require('path');
const fs = require('fs');

function fmt() {
  return require('../formatters');
}

function resolveRoot(args) {
  const cand = (args && args[0] && !String(args[0]).startsWith('--')) ? String(args[0]) : '';
  const base = process.env.KHYQUANT_CWD || process.cwd();
  return cand ? path.resolve(base, cand) : base;
}

const KNOWN_SUBS = new Set(['gen', 'refresh', 'check', 'show', 'hook', 'link']);

async function handleMetadata(parsed = {}) {
  const { printInfo, printSuccess, printError, printWarn } = fmt();
  const rawArgs = Array.isArray(parsed.args) ? parsed.args.slice() : [];
  const options = parsed.options || {};

  // Subcommand may arrive via the parser's SUB_COMMANDS extraction OR still be
  // sitting at args[0] (parser only extracts subcommands it knows). Handle both
  // so the command works regardless of registration.
  let sub = String(parsed.subCommand || '').toLowerCase();
  let pathArgs = rawArgs;
  if (!KNOWN_SUBS.has(sub)) {
    if (rawArgs.length && KNOWN_SUBS.has(String(rawArgs[0]).toLowerCase())) {
      sub = String(rawArgs[0]).toLowerCase();
      pathArgs = rawArgs.slice(1);
    } else {
      sub = 'gen';
    }
  }
  const args = pathArgs;

  const svc = require('../../services/projectMetadataService');

  // hook 子命令：装/卸 git pre-commit 自动刷新钩子（无需路径，作用于所在 git 仓库）。
  if (sub === 'hook') {
    return handleHook(args, { printInfo, printSuccess, printError, printWarn });
  }

  const root = resolveRoot(args);
  const aiDir = path.join(root, '.ai');
  const mapPath = path.join(aiDir, 'MAP.md');

  if (sub === 'check') {
    const status = svc.checkProjectMetadata(root);
    if (status.ok) {
      printSuccess(`元数据齐备且最新：${path.relative(process.cwd(), mapPath) || mapPath}`);
      return true;
    }
    if (!status.exists) {
      printError(`缺少可维护性元数据：${root}/.ai/MAP.md 不存在`);
      printInfo('补齐：khy metadata gen');
    } else {
      printError(`元数据已过期（结构已变更）：${root}/.ai/${status.mode === 'skeleton' ? 'SKELETON.auto.md' : 'MAP.md'}`);
      printInfo('更新：khy metadata refresh');
    }
    // CI 门禁：以非零退出。
    process.exitCode = 1;
    return true;
  }

  if (sub === 'show') {
    const status = svc.checkProjectMetadata(root);
    printInfo(`项目根：${root}`);
    for (const f of ['MAP.md', 'CONTEXT.yaml', 'GUARDS.md', 'SKELETON.auto.md', '.metahash.json']) {
      const p = path.join(aiDir, f);
      const exists = fs.existsSync(p);
      printInfo(`  ${exists ? '✓' : '✗'} .ai/${f}${exists ? '' : '（缺失）'}`);
    }
    if (status.exists) {
      printInfo(`  归属：${status.mode === 'skeleton' ? '人工撰写（机器只刷新派生骨架）' : '机器自有（可被 refresh 覆盖）'}`);
      printInfo(`  状态：${status.stale ? '⚠ 已过期，建议 khy metadata refresh' : '✓ 最新'}`);
    } else {
      printInfo('生成：khy metadata gen');
    }
    return true;
  }

  if (sub === 'link') {
    const pointers = require('../../services/metadataPointers');
    printInfo(`让 AI 入口文件指向 .ai/ → ${root}`);
    const r = pointers.linkAgentPointers(root, { log: (msg) => printInfo(`  ${msg}`) });
    if (!r.ok) {
      printError(`未写入：${r.reason || 'unknown'}`);
      return true;
    }
    if (r.written.length) printSuccess(`已写入/更新：${r.written.join(', ')}`);
    if (r.unchanged.length) printInfo(`已是最新：${r.unchanged.join(', ')}`);
    if (r.skipped.length) printWarn(`跳过（同名外部文件，未覆盖）：${r.skipped.join(', ')}`);
    if (!r.written.length && !r.unchanged.length) printWarn('无入口文件被处理（检查 KHY_META_POINTER_TARGETS）。');
    printInfo('此后 Claude Code/Codex/Cursor/Copilot 等会经各自入口文件读到 .ai/ 种子文档。');
    return true;
  }

  if (sub === 'refresh') {
    const force = options.force === true || args.includes('--force');
    printInfo(`刷新可维护性元数据 → ${root}/.ai/`);
    const result = await svc.refreshProjectMetadata(root, {
      force,
      log: (msg) => printInfo(`  ${msg}`),
    });
    if (result.changed) {
      printSuccess(`已更新（${result.reason}）：${result.files.join(', ')}`);
      return true;
    }
    switch (result.reason) {
      case 'unchanged':
      case 'skeleton_unchanged':
        printSuccess('结构未变化，元数据已是最新，无需更新。');
        break;
      case 'empty_project':
        printWarn('目录为空或无可扫描文件，未刷新。');
        break;
      case 'invalid_root':
        printError(`无效路径：${root}`);
        break;
      default:
        printError(`未更新：${result.reason}`);
    }
    return true;
  }

  // gen（默认）
  const force = options.force === true || args.includes('--force');
  printInfo(`生成可维护性元数据 → ${root}/.ai/`);
  const result = await svc.generateProjectMetadata(root, {
    force,
    log: (msg) => printInfo(`  ${msg}`),
  });

  if (result.generated) {
    printSuccess(`已生成：${result.files.join(', ')}`);
    printInfo('这三件套保证：即便没有 AI，维护者也能据此理解并安全维护本项目。');
    printInfo('保持同步：khy metadata hook install（每次提交自动刷新，无需 AI）。');
    return true;
  }
  switch (result.reason) {
    case 'already_exists':
      printWarn('已存在 .ai/MAP.md，跳过（用 --force 覆盖，或 khy metadata refresh 增量更新）。');
      break;
    case 'empty_project':
      printWarn('目录为空或无可扫描文件，未生成。');
      break;
    case 'invalid_root':
      printError(`无效路径：${root}`);
      break;
    default:
      printError(`未生成：${result.reason}`);
  }
  return true;
}

/** hook 子命令：作用于 args 路径（或 cwd）所在的 git 仓库。 */
function handleHook(args, { printInfo, printSuccess, printError, printWarn }) {
  const hookSvc = require('../../services/metadataHook');
  // args[0] 可能是 install/uninstall/status，其后是可选路径。
  const action = (args[0] && !String(args[0]).startsWith('--')) ? String(args[0]).toLowerCase() : 'status';
  const pathArg = (args[1] && !String(args[1]).startsWith('--')) ? String(args[1]) : '';
  const base = process.env.KHYQUANT_CWD || process.cwd();
  const startDir = pathArg ? path.resolve(base, pathArg) : base;

  if (action === 'install') {
    const r = hookSvc.installHook(startDir);
    if (r.ok) {
      printSuccess(`pre-commit 钩子已${r.action === 'updated' ? '更新' : '安装'}：${r.preCommit}`);
      printInfo('此后每次 git commit 都会确定性刷新 .ai/ 元数据并自动入暂存——无需 AI。');
      return true;
    }
    if (r.action === 'not_a_repo') {
      printError('当前目录不是 git 仓库，无法安装钩子。');
    } else if (r.action === 'foreign_hook') {
      printWarn(`检测到已有非 khy 的 pre-commit 钩子，未覆盖：${r.preCommit}`);
      printInfo('请手工把以下片段加入该钩子以启用自动刷新：');
      printInfo('');
      for (const line of String(r.snippet || '').split('\n')) printInfo(`  ${line}`);
    } else {
      printError(`安装失败：${r.reason || 'unknown'}`);
    }
    return true;
  }

  if (action === 'uninstall') {
    const r = hookSvc.uninstallHook(startDir);
    if (r.action === 'removed') printSuccess(`已移除 pre-commit 钩子：${r.preCommit}`);
    else if (r.action === 'absent') printInfo('未安装 pre-commit 钩子，无需移除。');
    else if (r.action === 'not_ours') printWarn(`pre-commit 钩子非本工具所装，未移除：${r.preCommit}`);
    else if (r.action === 'not_a_repo') printError('当前目录不是 git 仓库。');
    return true;
  }

  // status（默认）
  const s = hookSvc.hookStatus(startDir);
  if (!s.repo) { printError('当前目录不是 git 仓库。'); return true; }
  printInfo(`仓库：${s.repo}`);
  if (!s.installed) {
    printInfo('  ✗ 未安装 pre-commit 钩子（安装：khy metadata hook install）');
  } else if (s.ours) {
    printInfo(`  ✓ 已安装 khy 自动刷新钩子：${s.preCommit}`);
  } else {
    printWarn(`  ⚠ 存在非 khy 的 pre-commit 钩子：${s.preCommit}`);
  }
  return true;
}

module.exports = { handleMetadata };
