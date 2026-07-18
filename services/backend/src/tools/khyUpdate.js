const { defineTool } = require('./_baseTool');

/**
 * khyUpdate — 让 AI agent 在对话里检查 khyos 是否有新版本、并在合适位置执行更新的可调面。
 *
 * goal「用户问『可不可以更新 khyos』时,khy 若在合适的位置有新版本,要能操作完成更新」。
 * 之前 agent 没有这个面:`khy update` 是用户敲的 CLI 命令,agent 只能提示用户手动跑。
 * 本工具委托 khySelfUpdateService(门控 KHY_SELF_UPDATE 默认开、复用 versionService +
 * pipFailurePolicy 单一真源、绝不抛)。
 *
 * 两个 action:
 *   - check(默认,只读)  查当前版本 vs PyPI 最新版,报是否有更新。
 *   - apply(变更、高风险) 执行 pip 升级(curated 命令,包名取白名单,绝不取模型输入)。
 *
 * 风险声明为 high:框架据此对 apply 走更强审批;check 只读安全。执行前应先 check、并向用户
 * 确认后再 apply(变更系统安装,不可静默)。
 */
module.exports = defineTool({
  name: 'khyUpdate',
  description:
    'Check for and apply updates to khy-os itself. Action "check" (read-only) reports the '
    + 'installed version vs the latest on PyPI; action "apply" upgrades khy-os via pip. '
    + 'Use when the user asks whether khyos can be updated or to update it.',
  category: 'system',
  risk: 'high',
  isReadOnly: false,
  isConcurrencySafe: false,

  aliases: ['khy_update', 'self_update', 'update_khyos', 'upgrade_khy', 'khyos_update', 'check_update'],
  shouldDefer: true,
  searchHint:
    'update upgrade khyos khy-os self version check latest new version 更新升级 khyos 有没有新版本 能不能更新 '
    + 'pip install upgrade khy-os current version',

  prompt() {
    return `Check for and apply updates to khy-os itself.

Use this when the user asks:
- "可以更新 khyos 吗 / 有没有新版本?" / "Can khyos be updated? Is there a new version?"
- "更新一下 khyos" / "update khy" — perform the update.

action:
  "check" (default, READ-ONLY) — compares the installed version against the latest
      published on PyPI. Returns { updateAvailable, current, latest }. If the network
      or pip is unavailable it returns indeterminate:true rather than falsely claiming
      "up to date". ALWAYS run this first.
  "apply" (MUTATING, requires approval) — upgrades khy-os in place via
      \`pip install --upgrade\` (the package name is chosen from a fixed allowlist,
      never from your input). Returns { changed, from, to }. On failure it returns a
      deterministic, actionable diagnosis (proxy/network/permission), not a raw error.

Guidance:
- Run "check" first; only run "apply" after the user has confirmed they want to update.
- After a successful apply with changed:true, tell the user to restart the CLI to load
  the new version.
- Report results faithfully — do not claim an update succeeded unless the result says so.`;
  },

  inputSchema: {
    action: {
      type: 'string',
      required: false,
      enum: ['check', 'apply'],
      description: '"check" (default, read-only version check) or "apply" (perform the upgrade).',
    },
  },

  getActivityDescription(input) {
    return (input && input.action === 'apply') ? '更新 khyos' : '检查 khyos 更新';
  },

  async execute(params) {
    const toolErrorCodes = require('../services/toolErrorCodes');
    try {
      const svc = require('../services/khySelfUpdateService');
      const action = params && params.action === 'apply' ? 'apply' : 'check';
      const result = action === 'apply' ? svc.applyUpdate() : await svc.checkUpdate();
      if (result && result.success === false) {
        return toolErrorCodes.enrich({ success: false, error: result.error || result.diagnosis || 'khy update failed', data: result });
      }
      return { success: true, data: result };
    } catch (err) {
      return toolErrorCodes.enrich({ success: false, error: err.message });
    }
  },
});
