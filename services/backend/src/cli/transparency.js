/**
 * Transparency Integration — thin rendering wrappers over transparencyService.
 *
 * Extracted from aiRenderer.js to keep the renderer focused on core output
 * while transparency concerns (cost, cascade, permissions, etc.) live here.
 */

let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

let _transparency;
function _getTransparency() {
  if (_transparency !== undefined) return _transparency;
  try { _transparency = require('../services/transparencyService'); } catch { _transparency = null; }
  return _transparency;
}

/**
 * Print per-turn cost/token summary after an AI response.
 * Claude Code style: dim line below the response with token counts, cost, model.
 *
 * @param {object} usage - { inputTokens, outputTokens, cacheReadTokens, model, adapter, costUSD, durationMs }
 */
function printTurnCost(usage) {
  const t = _getTransparency();
  if (!t || !usage) return;
  const line = t.formatPostResponseLine(usage);
  if (line) console.log(line);
}

/**
 * Print cascade/fallback transparency when multiple adapters were tried.
 *
 * @param {Array<{adapter: string, success: boolean, error?: string, durationMs?: number}>} steps
 */
function printCascadeSteps(steps) {
  const t = _getTransparency();
  if (!t || !steps || steps.length <= 1) return;
  const line = t.formatCascadeSteps(steps);
  if (line) console.log(`  ${c().dim('cascade:')} ${line}`);
}

/**
 * Print permission tier for a shell command (inline, before execution).
 *
 * @param {object} classification - { tier, matchedRule, approved }
 */
function printPermissionTier(classification) {
  const t = _getTransparency();
  if (!t || !classification) return;
  // Only show for dangerous/critical (safe/moderate are quiet)
  if (classification.tier === 'safe' || classification.tier === 'moderate') return;
  const line = t.formatPermissionTier(classification);
  if (line) console.log(`    ${line}`);
}

/**
 * Print session recap on exit.
 *
 * @param {object} session - { durationMs, totalInputTokens, totalOutputTokens, totalCostUSD, requestCount, toolCallCount, model, topTools }
 */
function printSessionRecap(session) {
  const t = _getTransparency();
  if (!t || !session) return;
  const text = t.formatSessionRecap(session);
  if (text) process.stdout.write(text);
}

/**
 * Print a quota warning if approaching limit.
 *
 * @param {object} quota - { used, limit }
 */
function printQuotaWarning(quota) {
  const t = _getTransparency();
  if (!t || !quota) return;
  const warning = t.checkQuotaWarning(quota);
  if (warning) console.log(`  ${warning}`);
}

/**
 * Print context compaction notification.
 *
 * @param {object} compaction - { beforeTokens, afterTokens, durationMs }
 */
function printCompactionResult(compaction) {
  const t = _getTransparency();
  if (!t || !compaction) return;
  const line = t.formatCompactionNotice(compaction);
  if (line) console.log(`  ${line}`);
}

/**
 * Print edit diff preview before applying changes.
 *
 * @param {object} edit - { filePath, oldContent, newContent, lineStart }
 * @returns {boolean} true if preview was printed
 */
function printEditPreview(edit) {
  const t = _getTransparency();
  if (!t || !edit) return false;
  const preview = t.formatEditPreview(edit);
  if (!preview) return false;
  console.log(`    ${preview.header}`);
  for (const line of preview.diffLines) {
    console.log(`    ${line}`);
  }
  console.log(c().dim(`    ${preview.stats.removed} removed, ${preview.stats.added} added`));
  return true;
}

module.exports = {
  printTurnCost,
  printCascadeSteps,
  printPermissionTier,
  printSessionRecap,
  printQuotaWarning,
  printCompactionResult,
  printEditPreview,
};
