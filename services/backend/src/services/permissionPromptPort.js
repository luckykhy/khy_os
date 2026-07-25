'use strict';

/**
 * permissionPromptPort.js — neutral port for interactive permission prompts.
 *
 * Breaks the confirmed 2-cycle and the broader service→cli layering inversion
 * called out by REQ-2026-001 (DESIGN-ARCH-057):
 *
 *   services/toolCalling.js        → cli/ui/permissionDialog.formatPermissionDialog
 *   services/preflightPermission.js → cli/ui/permissionDialog.formatBatchPermissionDialog
 *
 * Both were reverse edges: the service layer reached up into the cli presentation
 * layer to render an approval dialog, while cli/ui/permissionDialog reaches back
 * down into services/toolCalling (getReadlineProvider) — a true import-time cycle
 * previously masked by in-function lazy `require`.
 *
 * The dependency is inverted here: cli/ui/permissionDialog self-registers its
 * prompter on load (legit cli → services direction); the service layer asks for a
 * decision through this port and never requires any cli/* module. When nothing is
 * registered (backend-server / headless / SDK / unit test) the getter returns null
 * and each caller falls back to its existing non-interactive path — exactly the
 * degrade the prior `try { require(...) } catch {}` provided, but without dragging
 * the TUI-coupled cli module graph into a non-cli process.
 *
 * Zero dependencies — a true leaf, so it can never participate in a cycle.
 * Same範式 as compactionUiPort / aiChatPort / commandDispatchPort.
 *
 * Prompter contract: `{ prompt, promptBatch }`
 *   prompt(toolName, params, riskInfo, reasoning, diffInfo)
 *     → Promise<'allow' | 'allow-always' | 'deny'>
 *   promptBatch(needsApproval)
 *     → Promise<{ decision, ... }>   (batch preflight dialog shape)
 */

let _prompter = null; // { prompt, promptBatch } — from cli/ui/permissionDialog

/**
 * Register the interactive permission prompter. Called by cli/ui/permissionDialog
 * on load. A partial impl is accepted; missing members simply stay unavailable.
 * @param {{ prompt?: Function, promptBatch?: Function }} impl
 */
function registerPermissionPrompter(impl) {
  if (!impl || typeof impl !== 'object') {
    _prompter = null;
    return;
  }
  _prompter = {
    prompt: typeof impl.prompt === 'function' ? impl.prompt : null,
    promptBatch: typeof impl.promptBatch === 'function' ? impl.promptBatch : null,
  };
}

/**
 * @returns {{ prompt: Function|null, promptBatch: Function|null } | null}
 *   the registered prompter, or null when no cli prompter is wired (headless).
 */
function getPermissionPrompter() {
  return _prompter;
}

/** @internal Reset registration for testing. */
function _resetForTest() {
  _prompter = null;
}

module.exports = {
  registerPermissionPrompter,
  getPermissionPrompter,
  _resetForTest,
};
