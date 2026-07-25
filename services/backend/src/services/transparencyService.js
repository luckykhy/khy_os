'use strict';

/**
 * transparencyService.js — Centralized transparency layer for KHY OS.
 *
 * Provides user-facing transparency for:
 *   - Per-turn token cost (after each AI response)
 *   - Model/adapter routing (which model answered)
 *   - Permission tier display (sandbox classification per command)
 *   - Session recap on exit (total tokens, cost, tools used)
 *   - Cascade/fallback visibility (adapter cascade steps)
 *   - Context compaction notification
 *   - Quota warnings (approaching limit)
 *   - Edit diff preview before apply
 *
 * Design: pure functions that return formatted strings — no direct console.log.
 * Callers (aiRenderer, repl, hudRenderer) decide when/where to display.
 *
 * Reference alignment:
 *   - Claude Code: per-turn cost in status line, model display, compaction notice
 *   - Qwen Code: model display in status, subagent transparency
 *   - LibreChat: token counts per message, rate limit headers, admin dashboard
 */

let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

// ── Per-Turn Cost Display ─────────────────────────────────────────

/**
 * Format a per-turn cost/token summary line.
 * Shown after each AI response, inline with the output.
 *
 * Example: "↑ 2.1k ↓ 0.4k tokens · $0.0023 · claude-3.5-sonnet via relay"
 *
 * @param {object} usage
 * @param {number} usage.inputTokens
 * @param {number} usage.outputTokens
 * @param {number} [usage.cacheReadTokens]
 * @param {number} [usage.cacheWriteTokens]
 * @param {string} [usage.model]
 * @param {string} [usage.adapter]
 * @param {number} [usage.costUSD]
 * @param {number} [usage.durationMs]
 * @returns {string} Formatted line (ANSI colored)
 */
function formatTurnCost(usage) {
  if (!usage) return '';
  const chalk = c();
  const parts = [];

  const fmtK = (n) => {
    if (!n || n <= 0) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  // Token counts
  const input = fmtK(usage.inputTokens || 0);
  const output = fmtK(usage.outputTokens || 0);
  parts.push(chalk.dim(`↑ ${input} ↓ ${output} tokens`));

  // Cache hit indicator
  if (usage.cacheReadTokens > 0) {
    const cached = fmtK(usage.cacheReadTokens);
    parts.push(chalk.green(`⚡ ${cached} cached`));
  }

  // Cost
  if (usage.costUSD != null && usage.costUSD > 0) {
    const cost = usage.costUSD >= 0.01
      ? `$${usage.costUSD.toFixed(2)}`
      : `$${usage.costUSD.toFixed(4)}`;
    parts.push(chalk.yellow(cost));
  }

  // Model + adapter
  if (usage.model) {
    let modelStr = chalk.cyan(usage.model);
    if (usage.adapter) modelStr += chalk.dim(` via ${usage.adapter}`);
    parts.push(modelStr);
  }

  // Duration
  if (usage.durationMs > 0) {
    const sec = (usage.durationMs / 1000).toFixed(1);
    parts.push(chalk.dim(`${sec}s`));
  }

  return parts.join(chalk.dim(' · '));
}

// ── Model/Adapter Routing Display ─────────────────────────────────

/**
 * Format adapter cascade steps for transparency.
 * Shows which adapters were tried and why they failed.
 *
 * Example:
 *   "✗ deepseek (timeout) → ✗ openai (rate_limit) → ✓ relay (200ms)"
 *
 * @param {Array<{adapter: string, success: boolean, error?: string, durationMs?: number}>} steps
 * @returns {string}
 */
function formatCascadeSteps(steps) {
  if (!steps || steps.length === 0) return '';
  if (steps.length === 1 && steps[0].success) return ''; // single success, nothing to show
  const chalk = c();

  return steps.map(step => {
    const icon = step.success ? chalk.green('✓') : chalk.red('✗');
    const name = chalk.white(step.adapter || 'unknown');
    const detail = step.success
      ? (step.durationMs ? chalk.dim(`(${step.durationMs}ms)`) : '')
      : chalk.dim(`(${step.error || 'failed'})`);
    return `${icon} ${name} ${detail}`.trim();
  }).join(chalk.dim(' → '));
}

// ── Permission Tier Display ───────────────────────────────────────

/**
 * Format sandbox permission tier for user visibility.
 *
 * @param {object} classification
 * @param {string} classification.tier - safe/moderate/dangerous/critical/unknown
 * @param {string} [classification.matchedRule]
 * @param {boolean} [classification.approved]
 * @returns {string}
 */
function formatPermissionTier(classification) {
  if (!classification) return '';
  const chalk = c();
  const { tier, matchedRule, approved } = classification;

  const tierColors = {
    safe: chalk.green('safe'),
    moderate: chalk.blue('moderate'),
    dangerous: chalk.yellow('⚠ dangerous'),
    critical: chalk.red('⛔ critical'),
    unknown: chalk.dim('unknown'),
  };

  const tierLabel = tierColors[tier] || chalk.dim(tier);
  const rule = matchedRule ? chalk.dim(` [${matchedRule}]`) : '';
  const status = approved === false
    ? chalk.red(' → blocked')
    : approved === true
      ? chalk.green(' → approved')
      : '';

  return `${chalk.dim('tier:')} ${tierLabel}${rule}${status}`;
}

// ── Session Recap ─────────────────────────────────────────────────

/**
 * Generate a session recap summary for display on exit.
 *
 * @param {object} session
 * @param {number} session.durationMs
 * @param {number} session.totalInputTokens
 * @param {number} session.totalOutputTokens
 * @param {number} session.totalCostUSD
 * @param {number} session.requestCount
 * @param {number} session.toolCallCount
 * @param {string} [session.model]
 * @param {Array<{name: string, count: number}>} [session.topTools]
 * @returns {string} Multi-line formatted recap
 */
function formatSessionRecap(session) {
  if (!session) return '';
  const chalk = c();
  const lines = [];

  const fmtK = (n) => {
    if (!n) return '0';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
    return String(n);
  };

  const fmtDur = (ms) => {
    const sec = Math.floor(ms / 1000);
    if (sec >= 3600) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    if (sec >= 60) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    return `${sec}s`;
  };

  lines.push('');
  lines.push(chalk.dim('─'.repeat(50)));
  lines.push(chalk.bold(' Session Summary'));
  lines.push(chalk.dim('─'.repeat(50)));

  // Duration + requests
  const dur = session.durationMs > 0 ? fmtDur(session.durationMs) : 'N/A';
  lines.push(`  Duration:    ${chalk.white(dur)}  ·  ${chalk.white(session.requestCount || 0)} requests`);

  // Tokens
  const input = fmtK(session.totalInputTokens || 0);
  const output = fmtK(session.totalOutputTokens || 0);
  const total = fmtK((session.totalInputTokens || 0) + (session.totalOutputTokens || 0));
  lines.push(`  Tokens:      ${chalk.dim('↑')} ${chalk.white(input)}  ${chalk.dim('↓')} ${chalk.white(output)}  ${chalk.dim('Σ')} ${chalk.bold(total)}`);

  // Cost
  if (session.totalCostUSD > 0) {
    const usd = session.totalCostUSD >= 0.01
      ? `$${session.totalCostUSD.toFixed(2)}`
      : `$${session.totalCostUSD.toFixed(4)}`;
    const cny = `¥${(session.totalCostUSD * 7.25).toFixed(2)}`;
    lines.push(`  Cost:        ${chalk.yellow(usd)} ${chalk.dim(`(${cny})`)}`);
  }

  // Model
  if (session.model) {
    lines.push(`  Model:       ${chalk.cyan(session.model)}`);
  }

  // Tool calls
  if (session.toolCallCount > 0) {
    lines.push(`  Tool calls:  ${chalk.white(session.toolCallCount)}`);
  }

  // Top tools
  if (session.topTools && session.topTools.length > 0) {
    const toolStrs = session.topTools.slice(0, 5).map(t =>
      `${t.name}(${t.count})`
    );
    lines.push(`  Top tools:   ${chalk.dim(toolStrs.join(', '))}`);
  }

  lines.push(chalk.dim('─'.repeat(50)));
  lines.push('');

  return lines.join('\n');
}

// ── Quota Warning ─────────────────────────────────────────────────

/**
 * Check if quota is approaching limit and return a warning string.
 *
 * @param {object} quota
 * @param {number} quota.used
 * @param {number} quota.limit - -1 means unlimited
 * @param {number} [warningThreshold=80] - percentage to start warning
 * @returns {string|null} Warning string or null
 */
function checkQuotaWarning(quota, warningThreshold = 80) {
  if (!quota || quota.limit <= 0) return null;
  const pct = Math.round((quota.used / quota.limit) * 100);
  if (pct < warningThreshold) return null;

  const chalk = c();
  if (pct >= 95) {
    return chalk.red(`⚠ Quota nearly exhausted: ${pct}% used (${quota.used.toLocaleString()}/${quota.limit.toLocaleString()} tokens)`);
  }
  if (pct >= 90) {
    return chalk.yellow(`⚠ Quota high: ${pct}% used (${quota.used.toLocaleString()}/${quota.limit.toLocaleString()} tokens)`);
  }
  return chalk.yellow(`Quota: ${pct}% used`);
}

// ── Context Compaction Notification ───────────────────────────────

/**
 * Format a context compaction notification.
 *
 * @param {object} compaction
 * @param {number} compaction.beforeTokens
 * @param {number} compaction.afterTokens
 * @param {number} compaction.durationMs
 * @returns {string}
 */
function formatCompactionNotice(compaction) {
  if (!compaction) return '';
  const chalk = c();

  const fmtK = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
  const before = fmtK(compaction.beforeTokens || 0);
  const after = fmtK(compaction.afterTokens || 0);
  const saved = fmtK((compaction.beforeTokens || 0) - (compaction.afterTokens || 0));
  const dur = compaction.durationMs > 0 ? ` (${(compaction.durationMs / 1000).toFixed(1)}s)` : '';

  return chalk.hex('#FFC107')(`✻ Context compacted: ${before} → ${after} tokens (saved ${saved})${dur}`);
}

// ── Edit Diff Preview ─────────────────────────────────────────────

/**
 * Format an edit preview showing what will change.
 * Returns a structured object for the caller to render.
 *
 * @param {object} edit
 * @param {string} edit.filePath
 * @param {string} edit.oldContent - Content being replaced
 * @param {string} edit.newContent - Replacement content
 * @param {number} [edit.lineStart] - Line number where change starts
 * @returns {{ header: string, diffLines: string[], stats: { added: number, removed: number } }}
 */
function formatEditPreview(edit) {
  if (!edit) return null;
  const chalk = c();

  const oldLines = (edit.oldContent || '').split('\n');
  const newLines = (edit.newContent || '').split('\n');

  const header = chalk.dim(`Preview edit: ${edit.filePath}`) +
    (edit.lineStart ? chalk.dim(`:${edit.lineStart}`) : '');

  const diffLines = [];
  const maxShow = 12;

  // Show removed lines (red)
  for (const line of oldLines.slice(0, maxShow)) {
    diffLines.push(chalk.red(`- ${line}`));
  }
  if (oldLines.length > maxShow) {
    diffLines.push(chalk.dim(`  ... +${oldLines.length - maxShow} removed lines`));
  }

  // Show added lines (green)
  for (const line of newLines.slice(0, maxShow)) {
    diffLines.push(chalk.green(`+ ${line}`));
  }
  if (newLines.length > maxShow) {
    diffLines.push(chalk.dim(`  ... +${newLines.length - maxShow} added lines`));
  }

  return {
    header,
    diffLines,
    stats: {
      added: newLines.length,
      removed: oldLines.length,
    },
  };
}

// ── Aggregate: enriched status line ───────────────────────────────

/**
 * Build an enriched post-response status line combining:
 * per-turn cost + model + duration.
 *
 * Designed to be printed once after each AI response completes.
 *
 * @param {object} turnData
 * @returns {string}
 */
function formatPostResponseLine(turnData) {
  if (!turnData) return '';
  return `  ${c().dim('╰─')} ${formatTurnCost(turnData)}`;
}

module.exports = {
  formatTurnCost,
  formatCascadeSteps,
  formatPermissionTier,
  formatSessionRecap,
  checkQuotaWarning,
  formatCompactionNotice,
  formatEditPreview,
  formatPostResponseLine,
};
