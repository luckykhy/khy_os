'use strict';

/**
 * bootstrapBudget.js — Bootstrap file injection budget management.
 *
 * Ported from OpenClaw's bootstrap-budget.ts.
 * Manages per-file and total character budgets for workspace context injection
 * into system prompts. Tracks truncation causes and deduplicates warnings.
 *
 * Constants:
 *   NEAR_LIMIT_RATIO = 0.85
 *   MAX_WARNING_FILES = 3
 *   SIGNATURE_HISTORY_MAX = 32
 */

const crypto = require('crypto');

const NEAR_LIMIT_RATIO = 0.85;
const MAX_WARNING_FILES = 3;
const SIGNATURE_HISTORY_MAX = 32;

// Track warning signatures to prevent duplicate alerts
const _emittedSignatures = new Set();

/**
 * Inject workspace bootstrap files with budget constraints.
 *
 * @param {Array<{path: string, content: string}>} files - Files to inject
 * @param {object} opts
 * @param {number} opts.perFileMaxChars - Max chars per individual file
 * @param {number} opts.totalMaxChars - Max chars across all files combined
 * @returns {{ injected: InjectionStat[], totalChars: number, truncated: boolean }}
 */
function injectWithBudget(files, { perFileMaxChars, totalMaxChars }) {
  const stats = [];
  let totalUsed = 0;

  for (const file of files) {
    const rawChars = file.content.length;
    const causes = [];

    let injectedContent = file.content;

    // Per-file limit
    if (injectedContent.length > perFileMaxChars) {
      injectedContent = _truncateAtBoundary(injectedContent, perFileMaxChars);
      causes.push('per-file-limit');
    }

    // Total limit
    const remaining = totalMaxChars - totalUsed;
    if (injectedContent.length > remaining) {
      injectedContent = _truncateAtBoundary(injectedContent, Math.max(0, remaining));
      causes.push('total-limit');
    }

    const injectedChars = injectedContent.length;
    totalUsed += injectedChars;

    stats.push({
      path: file.path,
      rawChars,
      injectedChars,
      injectedContent,
      truncated: injectedChars < rawChars,
      causes,
      reductionPct: rawChars > 0 ? Math.round((1 - injectedChars / rawChars) * 100) : 0,
    });

    // Stop if total budget exhausted
    if (totalUsed >= totalMaxChars) break;
  }

  return {
    injected: stats,
    totalChars: totalUsed,
    truncated: stats.some(s => s.truncated),
  };
}

/**
 * Analyze bootstrap budget and generate warnings if needed.
 *
 * @param {object} opts
 * @param {Array<InjectionStat>} opts.files - Injection stats from injectWithBudget
 * @param {number} opts.perFileMaxChars
 * @param {number} opts.totalMaxChars
 * @param {number} [opts.nearLimitRatio=0.85]
 * @returns {{ nearLimit: boolean, overLimit: boolean, warning: string|null, signature: string }}
 */
function analyzeBootstrapBudget({
  files,
  perFileMaxChars,
  totalMaxChars,
  nearLimitRatio = NEAR_LIMIT_RATIO,
}) {
  const totalUsed = files.reduce((sum, f) => sum + f.injectedChars, 0);
  const truncatedFiles = files.filter(f => f.truncated);
  const nearLimit = totalUsed >= totalMaxChars * nearLimitRatio;
  const overLimit = truncatedFiles.length > 0;

  // Generate signature for deduplication
  const signature = crypto.createHash('sha256')
    .update(JSON.stringify({
      perFileMaxChars,
      totalMaxChars,
      files: files.map(f => ({
        path: f.path,
        rawChars: f.rawChars,
        injectedChars: f.injectedChars,
        causes: [...(f.causes || [])].sort(),
      })),
    }))
    .digest('hex')
    .slice(0, 16);

  let warning = null;

  if (overLimit) {
    // Check if we already emitted this exact warning
    if (!_emittedSignatures.has(signature)) {
      const lines = ['[Bootstrap truncation warning]'];
      lines.push('Some workspace context files were truncated before injection.');
      lines.push('AI responses may be missing project context.\n');

      const showFiles = truncatedFiles.slice(0, MAX_WARNING_FILES);
      for (const f of showFiles) {
        const causeStr = f.causes.join(', ');
        lines.push(`- ${f.path}: ${f.rawChars} → ${f.injectedChars} chars (~${f.reductionPct}% removed; ${causeStr})`);
      }

      const moreCount = truncatedFiles.length - showFiles.length;
      if (moreCount > 0) {
        lines.push(`+ ${moreCount} more truncated file(s).`);
      }

      lines.push(`\nTotal context: ${totalUsed}/${totalMaxChars} chars (${Math.round(totalUsed / totalMaxChars * 100)}% used)`);

      warning = lines.join('\n');

      // Track signature
      _emittedSignatures.add(signature);
      if (_emittedSignatures.size > SIGNATURE_HISTORY_MAX) {
        // LRU eviction
        const first = _emittedSignatures.values().next().value;
        _emittedSignatures.delete(first);
      }
    }
  }

  return { nearLimit, overLimit, warning, signature, totalUsed, totalMaxChars };
}

/**
 * Truncate text at a clean boundary (newline or space).
 */
function _truncateAtBoundary(text, maxChars) {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return '';

  // Find last newline before maxChars
  const lastNewline = text.lastIndexOf('\n', maxChars);
  if (lastNewline > maxChars * 0.7) {
    return text.slice(0, lastNewline);
  }

  // Fallback: cut at space
  const lastSpace = text.lastIndexOf(' ', maxChars);
  if (lastSpace > maxChars * 0.8) {
    return text.slice(0, lastSpace);
  }

  return text.slice(0, maxChars);
}

/**
 * Reset warning deduplication (for testing or session restart).
 */
function resetWarningSignatures() {
  _emittedSignatures.clear();
}

module.exports = {
  injectWithBudget,
  analyzeBootstrapBudget,
  resetWarningSignatures,
  NEAR_LIMIT_RATIO,
  MAX_WARNING_FILES,
  SIGNATURE_HISTORY_MAX,
};
