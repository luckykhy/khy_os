'use strict';

/**
 * backgroundShellRegistry.js — registry for fire-and-forget background shell
 * commands dispatched via shellCommand's `run_in_background`.
 *
 * Lives in its own module because shellCommand is built with defineTool(), whose
 * returned object is Object.freeze()d — so the collector cannot be attached to
 * the tool instance after the fact. Both the producer (shellCommand) and the
 * consumer (toolUseLoop drain) import this module, giving one shared source of
 * truth and a uniform collectBackgroundResults() contract that mirrors
 * AgentTool's background-agent collector.
 *
 * Entry shape:
 *   { status: 'running'|'completed'|'failed', command, startedAt, kind: 'shell',
 *     result?: { output, exitCode }, error?, notified? }
 */

const backgroundShells = new Map();

/**
 * Drain newly-finished background shell commands as <task_notification>
 * descriptors. Delegates the (pure) drain/format + one-shot "notified"
 * bookkeeping to taskNotification so it stays in a single place.
 * @returns {Array<object>}
 */
function collectBackgroundResults() {
  try {
    return require('../services/query/taskNotification')
      .drainCompletedBackgroundAgents(backgroundShells);
  } catch {
    return [];
  }
}

module.exports = { backgroundShells, collectBackgroundResults };
