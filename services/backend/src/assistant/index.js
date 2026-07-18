/**
 * KAIROS Assistant Mode — persistent cross-session assistant.
 *
 * Features:
 * - Cross-session persistence via config
 * - Daily append-only markdown logs
 * - Auto-dream memory consolidation (4 phases)
 * - Proactive idle tick system
 *
 * Activation: KHYQUANT_ASSISTANT_MODE=true or config assistant: true
 *
 * Ported from Claude Code's assistant/index.ts.
 */
'use strict';

const { appendLog, readTodayLog, getRecentLogs, getLogFileCount } = require('./dailyLog');
const { shouldDream, runDream } = require('./autoDream');
const { activate: activateProactive, deactivate: deactivateProactive, isProactiveActive } = require('./proactive');
const { readLastConsolidatedAt } = require('./consolidationLock');

// ── Mode Detection ─────────────────────────────────────────────────

/**
 * Check if assistant mode is active.
 * @returns {boolean}
 */
function isAssistantMode() {
  // Environment variable
  const env = process.env.KHYQUANT_ASSISTANT_MODE;
  if (env === 'true' || env === '1') return true;
  if (env === 'false' || env === '0') return false;

  // Config file
  try {
    const fs = require('fs');
    const path = require('path');
    const { getDataHome } = require('../utils/dataHome');
    const configPath = path.join(getDataHome(), 'config.json');
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return !!config.assistant;
    }
  } catch { /* no config */ }

  return false;
}

// ── Activation ─────────────────────────────────────────────────────

let _activated = false;
let _dreamingEngine = null;

/**
 * Lazily construct the orphan MemoryDreaming engine with an EXPLICIT store
 * path. The constructor defaults `storePath` to null, which makes load()/save()
 * silent no-ops — so the path must be passed explicitly or the engine does
 * nothing. Store lives under the `.khy` memory root alongside auto-dream files.
 *
 * @returns {import('../services/memoryDreaming').MemoryDreaming}
 */
function _getDreamingEngine() {
  if (_dreamingEngine) return _dreamingEngine;
  const path = require('path');
  const { getDataDir } = require('../utils/dataHome');
  const { MemoryDreaming } = require('../services/memoryDreaming');

  const memDir = getDataDir('memory');
  let gateway = null;
  try {
    const ai = require('../cli/ai');
    // Adapt the assistant AI module to the gateway shape MemoryDreaming expects.
    if (ai && typeof ai.chat === 'function') {
      gateway = {
        generate: async (prompt, opts = {}) => {
          try {
            const resp = await ai.chat(prompt, { _isFollowUp: true, effort: 'high', ...opts });
            return { success: true, content: resp.reply || resp.text || '' };
          } catch (err) {
            return { success: false, error: err.message };
          }
        },
      };
    }
  } catch { /* AI not available — engine still runs dedup phases */ }

  _dreamingEngine = new MemoryDreaming({
    storePath: path.join(memDir, 'dream-store.json'),
    archivePath: path.join(memDir, 'dream-archive.json'),
    gateway,
    onPhaseComplete: (phase, stats) => {
      try { appendLog(`Dream phase '${phase}' complete: ${JSON.stringify(stats)}`); } catch { /* ignore */ }
    },
  });
  _dreamingEngine.load();
  return _dreamingEngine;
}

/**
 * Expose the orphan dreaming engine for CLI/status consumers.
 * @returns {import('../services/memoryDreaming').MemoryDreaming}
 */
function getDreamingEngine() {
  return _getDreamingEngine();
}

// ── Dream-insight promotion (orphan bridge) ────────────────────────
// The MemoryDreaming engine synthesizes cross-memory `deep`/`pattern` insights
// into its own JSON store with an incompatible schema — they were never turned
// into recallable markdown memories. `_promoteDreamInsights` bridges the highest
// -value ones into the markdown store via memoryEngine.addStructuredMemory (which
// already dedups / tiers / updates-in-place). Idempotent via a `dream-promoted.json`
// id ledger PLUS addStructuredMemory's own content-dedup. Fail-soft throughout.

/** KHY_MEMORY_DREAM_PROMOTE — default ON. */
function _dreamPromoteEnabled() {
  return !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_MEMORY_DREAM_PROMOTE == null ? '' : process.env.KHY_MEMORY_DREAM_PROMOTE).trim().toLowerCase());
}

/** KHY_MEMORY_DREAM_DEEP — default OFF (spends AI tokens on synthesis). */
function _dreamDeepEnabled() {
  return ['1', 'true', 'on', 'yes'].includes(
    String(process.env.KHY_MEMORY_DREAM_DEEP == null ? '' : process.env.KHY_MEMORY_DREAM_DEEP).trim().toLowerCase());
}

/**
 * Promote eligible dream insights into the markdown memory store.
 * Reads the `dream-promoted.json` ledger, selects promotable insights, writes
 * them via addStructuredMemory, then appends the promoted ids back to the ledger.
 *
 * @param {import('../services/memoryDreaming').MemoryDreaming} engine
 * @returns {Promise<void>}
 */
async function _promoteDreamInsights(engine) {
  const fs = require('fs');
  const path = require('path');
  const { getDataDir } = require('../utils/dataHome');
  const memoryEngine = require('../services/memoryEngine');
  const dreamPromote = memoryEngine.dreamPromote;

  const memDir = getDataDir('memory');
  const ledgerPath = path.join(memDir, 'dream-promoted.json');

  // Ledger of already-promoted dream ids (fail-soft → empty Set).
  let promoted = new Set();
  try {
    if (fs.existsSync(ledgerPath)) {
      const raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
      if (Array.isArray(raw)) promoted = new Set(raw.map(String));
    }
  } catch { promoted = new Set(); }

  let entries = [];
  try { entries = engine.snapshotMemories(); } catch { entries = []; }

  const selected = dreamPromote.selectPromotable(entries, promoted, process.env);
  if (!selected || selected.length === 0) return;

  const newlyPromoted = [];
  for (const s of selected) {
    try {
      const r = memoryEngine.addStructuredMemory({
        type: s.memdirType,
        name: s.name,
        description: s.description,
        content: s.content,
      });
      // Any success outcome (write / skip / skip-duplicate) means the insight is
      // now represented in the store → mark the dream id so we skip it next tick.
      if (r && r.success) newlyPromoted.push(s.id);
    } catch { /* per-entry fail-soft */ }
  }

  if (newlyPromoted.length === 0) return;
  for (const id of newlyPromoted) promoted.add(id);
  try {
    fs.writeFileSync(ledgerPath, JSON.stringify([...promoted], null, 2));
    appendLog(`Promoted ${newlyPromoted.length} dream insight(s) into markdown memory.`);
  } catch { /* ledger write best-effort */ }
}

/**
 * Activate assistant mode — starts daily logging and proactive ticks.
 */
function activate() {
  if (_activated) return;
  _activated = true;

  process.env.KHYQUANT_ASSISTANT_MODE = 'true';

  // Log activation
  appendLog('Assistant mode activated.');

  // Start proactive idle ticks
  activateProactive(undefined, async (tickInfo) => {
    if (tickInfo.dreamNeeded) {
      // Auto-dream (file-level consolidation) in background
      try {
        const ai = require('../cli/ai');
        runDream(ai).catch(() => {}); // Fire and forget
      } catch { /* AI not available */ }

      // Orphan engine: run the light dedup phase over the structured dream
      // store. Lossless — duplicates are archived, never destroyed.
      try {
        const engine = _getDreamingEngine();
        engine.runLightPhase().catch(() => {}); // Fire and forget
      } catch { /* engine unavailable */ }

      // Bridge high-value cross-memory dream insights into the recallable markdown
      // store (KHY_MEMORY_DREAM_PROMOTE, default on). Optionally run the deep
      // synthesis phase first so deep/pattern insights exist at all
      // (KHY_MEMORY_DREAM_DEEP, default OFF — it spends AI tokens). Fire-and-forget,
      // fail-soft: promotion must never disturb the tick.
      try {
        if (_dreamPromoteEnabled()) {
          const engine = _getDreamingEngine();
          if (_dreamDeepEnabled() && typeof engine.runDeepPhase === 'function') {
            engine.runDeepPhase()
              .then(() => _promoteDreamInsights(engine))
              .catch(() => {});
          } else {
            _promoteDreamInsights(engine).catch(() => {});
          }
        }
      } catch { /* promotion best-effort */ }
    }
  });
}

/**
 * Deactivate assistant mode.
 */
function deactivate() {
  if (!_activated) return;
  _activated = false;

  process.env.KHYQUANT_ASSISTANT_MODE = 'false';
  deactivateProactive();
  appendLog('Assistant mode deactivated.');
}

// ── Status ─────────────────────────────────────────────────────────

/**
 * Get assistant mode status summary.
 * @returns {object}
 */
function getStatus() {
  const lastDream = readLastConsolidatedAt();
  const dreamCheck = shouldDream();
  const logCount = getLogFileCount();

  return {
    active: isAssistantMode(),
    proactive: isProactiveActive(),
    logCount,
    lastDream: lastDream > 0 ? new Date(lastDream).toISOString() : 'never',
    dreamNeeded: dreamCheck.needed,
    dreamReason: dreamCheck.reason,
  };
}

// ── Log Session Activity ───────────────────────────────────────────

/**
 * Log a user interaction to the daily log.
 * @param {string} userInput - What the user asked
 * @param {string} [summary] - Brief summary of the response
 */
function logInteraction(userInput, summary) {
  if (!isAssistantMode()) return;

  const entry = summary
    ? `**User:** ${userInput.slice(0, 100)}\n**Summary:** ${summary.slice(0, 200)}`
    : `**User:** ${userInput.slice(0, 100)}`;

  appendLog(entry);
}

module.exports = {
  isAssistantMode,
  activate,
  deactivate,
  getStatus,
  logInteraction,
  getDreamingEngine,
  // Re-exports for convenience
  appendLog,
  readTodayLog,
  getRecentLogs,
  shouldDream,
  runDream,
};
