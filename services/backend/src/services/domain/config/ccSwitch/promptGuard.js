'use strict';

/**
 * ccSwitch promptGuard — 恢复时保护非受管的 prompt 文件（CC Switch #6810 语义）。
 *
 * 问题：备份/恢复流程如果接管了应用的 prompt 文件（CLAUDE.md / AGENTS.md /
 * GEMINI.md / SOUL.md），当快照里某应用没有任何「已启用 prompt」时，恢复会把它
 * 截断成空文件——摧毁用户手写、从未进入同步载荷的内容。
 *
 * 规则（与 cc-switch v3.20.1 #6810 一致）：
 *   - 快照里某应用没有任何已启用的 prompt → 恢复**完全不碰**该应用的 live
 *     prompt 文件（客户端继续加载旧内容）。
 *   - 从提示词面板禁用最后一条 prompt → 仍然照旧清空它（那是显式用户意图）。
 *
 * 本模块是纯决策叶子：给定快照中的应用 prompt 清单 + 目标文件，返回「写 / 跳过」。
 */

const fs = require('fs');

const PROMPT_FILES = Object.freeze({
  'claude-code': 'CLAUDE.md',
  codex: 'AGENTS.md',
  gemini: 'GEMINI.md',
  opencode: 'SOUL.md',
  'command-code': 'AGENTS.md',
  ycode: 'YCODE.md',
});

/**
 * 判定某应用的 prompt 文件在恢复时是否应当被跳过（保留本地手写内容）。
 *
 * @param {object} opts
 * @param {string} opts.app           应用 id（claude-code / codex / gemini / opencode）
 * @param {Array}  [opts.snapshotPrompts]  快照里该应用的 prompt 清单
 *                                         （空/缺省 = 没有任何已启用 prompt）
 * @param {string} [opts.livePath]     本地 live prompt 文件绝对路径（存在性检查用）
 * @returns {{ skip: boolean, reason: string }}
 */
function shouldSkipPromptFile({ app, snapshotPrompts, livePath } = {}) {
  const fileName = PROMPT_FILES[app];
  if (!fileName) {
    // 不认识的应用 → 不碰（保守：跳过，保护未知文件）。
    return { skip: true, reason: `未知应用「${app}」的 prompt 文件不接管` };
  }
  const prompts = Array.isArray(snapshotPrompts) ? snapshotPrompts : [];
  const hasEnabled = prompts.some((p) => {
    if (!p || typeof p !== 'object') {
      return false;
    }
    return p.enabled !== false;
  });
  if (!hasEnabled) {
    if (livePath && fs.existsSync(livePath)) {
      return {
        skip: true,
        reason: `快照中应用「${app}」没有任何已启用 prompt，保留本地手写 ${fileName}`,
      };
    }
    // 本地文件本来就不存在 → 无需保护。
    return { skip: false, reason: '' };
  }
  return { skip: false, reason: '' };
}

/**
 * 某应用在快照里的 prompt 文件清单（从快照中提取，供 shouldSkipPromptFile 用）。
 * 快照形状因同步载荷而异，这里做宽容提取：接受 [{name,enabled}] 或 {name:enabled}。
 *
 * @param {object} snapshot 该应用的快照节点（可为 null）
 * @returns {Array<{name?:string, enabled?:boolean}>}
 */
function extractSnapshotPrompts(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return [];
  }
  if (Array.isArray(snapshot.prompts)) {
    return snapshot.prompts;
  }
  if (snapshot.prompts && typeof snapshot.prompts === 'object') {
    return Object.entries(snapshot.prompts).map(([name, enabled]) => ({
      name,
      enabled: enabled !== false,
    }));
  }
  return [];
}

module.exports = { shouldSkipPromptFile, extractSnapshotPrompts, PROMPT_FILES };
