/**
 * Preflight Permission — batch tool approval before execution starts.
 *
 * Scans all tools a task needs, checks which require approval,
 * and presents a single grouped permission dialog instead of
 * interrupting per-tool during execution.
 *
 * Usage:
 *   const { runPreflight } = require('./preflightPermission');
 *   const { approved, denied } = await runPreflight(toolCalls);
 */

// ── Main Preflight Check ──────────────────────────────────────────

/**
 * Run preflight permission check on a set of tool calls.
 *
 * @param {Array<{name: string, params?: object}>} toolCalls - Parsed tool calls
 * @param {object} [options]
 * @param {boolean} [options.silent=false] - Skip interactive prompt (for testing)
 * @param {Function} [options.onControlRequest] - Ink/host interactive channel.
 *   When present, the classic raw-mode batch dialog is skipped entirely (it calls
 *   stdin.setRawMode(false) and corrupts the Ink TUI into cooked mode). Per-tool
 *   approval is instead handled by the Ink-routed requestPermission as each tool
 *   executes, so no batch decision is pre-resolved here.
 * @returns {Promise<{approved: Set<string>, denied: Set<string>}>}
 */
async function runPreflight(toolCalls, options = {}) {
  const approved = new Set();
  const denied = new Set();
  const needsApproval = [];

  // Ink/host channel present → defer to per-tool interactive approval (ink
  // PermissionsPrompt) and never run the classic raw-mode batch dialog.
  if (typeof options.onControlRequest === 'function') {
    return { approved, denied };
  }

  // Deduplicate tool names
  const uniqueTools = new Map();
  for (const call of toolCalls) {
    if (call.legacy || call.name === '_legacy_cmd') continue;
    if (!uniqueTools.has(call.name)) {
      uniqueTools.set(call.name, call);
    }
  }

  // Check each tool against permission store
  let permStore;
  try { permStore = require('./permissionStore'); } catch { permStore = null; }

  let toolCalling;
  try { toolCalling = require('./toolCalling'); } catch { toolCalling = null; }

  for (const [name] of uniqueTools) {
    // Check if already approved
    let alreadyApproved = false;

    // Check permission store
    if (permStore) {
      let risk = 'medium';
      let isReadOnly = false;
      try {
        const registry = require('../tools');
        const regTool = registry.get(name);
        if (regTool) {
          risk = regTool.risk || 'medium';
          isReadOnly = typeof regTool.isReadOnly === 'function' ? regTool.isReadOnly({}) : false;
        }
      } catch { /* registry not available */ }

      const decision = permStore.check(name, {}, { risk, isReadOnly });
      if (decision === 'allow') {
        alreadyApproved = true;
      } else if (decision === 'deny') {
        denied.add(name);
        continue;
      }
    }

    // Check toolCalling's isApproved / dangerousMode / safe-risk
    if (!alreadyApproved && toolCalling) {
      if (toolCalling.isDangerousMode()) {
        alreadyApproved = true;
      } else if (toolCalling.isApproved(name)) {
        alreadyApproved = true;
      } else {
        // Check if tool is safe risk (auto-approve)
        const tools = toolCalling.listTools ? toolCalling.listTools() : [];
        const toolDef = tools.find(t => t.name === name);
        if (toolDef && toolDef.risk === 'safe') {
          alreadyApproved = true;
        }
      }
    }

    if (alreadyApproved) {
      approved.add(name);
    } else {
      // Gather info for batch prompt
      let description = '';
      let risk = 'medium';
      try {
        const registry = require('../tools');
        const regTool = registry.get(name);
        if (regTool) {
          description = regTool.description || '';
          risk = regTool.risk || 'medium';
        }
      } catch { /* fallback */ }

      if (!description && toolCalling) {
        const tools = toolCalling.listTools ? toolCalling.listTools() : [];
        const toolDef = tools.find(t => t.name === name);
        if (toolDef) {
          description = toolDef.description || '';
          risk = toolDef.risk || 'medium';
        }
      }

      needsApproval.push({ name, risk, description });
    }
  }

  // If nothing needs approval, return early
  if (needsApproval.length === 0) {
    return { approved, denied };
  }

  // Silent mode (for testing or non-interactive contexts)
  if (options.silent) {
    for (const t of needsApproval) denied.add(t.name);
    return { approved, denied };
  }

  // Show batch approval dialog
  let dialogResult;
  try {
    // Dependency inversion (DESIGN-ARCH-057): batch dialog provided by
    // cli/ui/permissionDialog via permissionPromptPort, not required from the
    // service layer. Null when headless → caught below → deny all for safety.
    const _prompter = require('./permissionPromptPort').getPermissionPrompter();
    const formatBatchPermissionDialog = _prompter && _prompter.promptBatch;
    if (!formatBatchPermissionDialog) throw new Error('no interactive prompter registered');
    dialogResult = await formatBatchPermissionDialog(needsApproval);
  } catch {
    // Dialog not available — deny all for safety
    for (const t of needsApproval) denied.add(t.name);
    return { approved, denied };
  }

  if (dialogResult.decision === 'approve-all') {
    // Approve all for this run only
    for (const t of needsApproval) {
      approved.add(t.name);
    }
  } else if (dialogResult.decision === 'approve-all-always') {
    // Approve all permanently
    for (const t of needsApproval) {
      approved.add(t.name);
      if (permStore) {
        try { permStore.approve(t.name, 'forever'); } catch { /* best effort */ }
      }
    }
  } else {
    // deny-all
    for (const t of needsApproval) {
      denied.add(t.name);
      if (permStore) {
        try { permStore.deny(t.name, 'session'); } catch { /* best effort */ }
      }
    }
  }

  return { approved, denied };
}

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  runPreflight,
};
