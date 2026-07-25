'use strict';

/**
 * gitWorkflowGuidance.js — 纯叶子:git 工作流「日常可见」意识块的单一真源。
 *
 * 背景:khyos 已具备全套 git 能力(EnterWorktree/ExitWorktree、gitCommit/gitPush、
 * main 分支探测、branch-first 纪律),但完整 Git Safety Protocol 走的是 on-demand
 * 段(仅用户消息命中 git 意图正则才注入系统提示词)。于是普通编码会话里模型看不到
 * 分支/main/worktree 概念,也不会在干完活后主动问是否提交——用户因此感觉「khy 缺少
 * git 概念,不会询问是否提交」。本叶子把「日常可见的 git 工作流意识 + 主动提交提醒」
 * 收敛为唯一真源,由 always-on 的 gitStatus 段在 repo 内每次会话追加。
 *
 * 注意:这里只补「概念可见性 + 提交提醒」,不复制完整安全宪章(那仍由 on-demand 的
 * getGitOperationsSection + repoDisciplineRisk 承载)。措辞与既有 branch-first /
 * no-commit-without-ask 纪律对齐。主动提交是「offer(询问)」,绝非自动提交——完全
 * 遵守既有「用户明确要求才提交」红线。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛、单一真源、无副作用。
 * 逃生阀 `KHY_GIT_WORKFLOW_GUIDANCE`(默认 on)。**关闭即返回 ''**(不追加任何内容,
 * gitStatus 段逐字节回退到改动前)。
 */

const _FALSY = ['0', 'false', 'off', 'no'];

/** 门控:仅当显式置为 0/false/off/no 时关闭,其余(含未设)均开启。 */
function isEnabled(env) {
  const raw = String((env || process.env).KHY_GIT_WORKFLOW_GUIDANCE || 'on')
    .trim().toLowerCase();
  return !_FALSY.includes(raw);
}

const HEADER = '## Git workflow (this repo)';

/**
 * 构建 git 工作流意识块。门关 / 异常 → '' (调用方据此不追加任何内容)。
 *
 * @param {object} [ctx]
 * @param {string} [ctx.branch]      当前分支名
 * @param {string} [ctx.mainBranch]  默认分支名(main/master)
 * @param {boolean} [ctx.dirty]      工作树是否有未提交改动
 * @returns {string}
 */
function buildWorkflowAwareness(ctx) {
  try {
    if (!isEnabled(ctx && ctx.env)) return '';
    const branch = (ctx && ctx.branch) ? String(ctx.branch) : '';
    const mainBranch = (ctx && ctx.mainBranch) ? String(ctx.mainBranch) : '';
    const dirty = !!(ctx && ctx.dirty);
    const onDefault = !!(branch && mainBranch && branch === mainBranch);

    const lines = [HEADER];

    // Branch / main —— 让模型每次都清楚自己在哪条分支、默认分支是什么。
    if (branch && mainBranch) {
      lines.push(`- You are on \`${branch}\`; the default branch is \`${mainBranch}\`.`);
    }
    if (onDefault) {
      lines.push('- You are currently ON the default branch. Before committing non-trivial work, create a feature branch first (branch-first) rather than committing straight to the default branch.');
    } else if (mainBranch) {
      lines.push(`- Keep committable work on feature branches; the default branch \`${mainBranch}\` is what you would open PRs against.`);
    }

    // Worktree —— 概念可见,直接点名既有工具。
    lines.push('- For parallel, risky, or long-running work you can isolate it in a git worktree via EnterWorktree / ExitWorktree instead of switching branches in place.');

    // 主动提交提醒 —— offer(询问),绝非自动提交。
    lines.push('- When you finish a coherent unit of work and the working tree has uncommitted changes, proactively offer once — in a single short line — to commit it (e.g. “要我把这些改动提交吗?”). Never commit until the user confirms, and never commit automatically.');
    if (dirty) {
      lines.push('- The working tree currently has uncommitted changes: once the current unit of work is complete, remember to offer to commit.');
    }

    return lines.join('\n');
  } catch {
    return '';
  }
}

module.exports = {
  isEnabled,
  buildWorkflowAwareness,
  // 暴露常量便于测试断言。
  HEADER,
};
