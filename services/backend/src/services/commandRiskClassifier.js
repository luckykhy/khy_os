'use strict';

/**
 * commandRiskClassifier.js — Single source of truth for shell command risk.
 *
 * s03 permission pipeline (Phase ③ minimal slice): historically three separate
 * risk tables judged the same command and could disagree —
 *   1. execApproval.DEFAULT_RISK_PATTERNS (glob → low/medium/high/critical)
 *   2. shellToToolMapper (base-command sets + git awareness → risk/readOnly/destructive)
 *   3. shellSafetyValidator.analyzeCommand (regex + syntax AST → severity)
 * Only execApproval reconciled (1) and (2); the validator (3) ran independently.
 *
 * This module composes (2) and (3) behind one function so that approval-time
 * risk has a single authority. It does NOT reimplement their logic — it calls
 * the existing analyzers and reconciles them (strictest-wins). The legacy glob
 * table in execApproval is downgraded to a non-authoritative fallback.
 *
 * Dependency direction: classifier → { shellToToolMapper, shellSafetyValidator }.
 * Those modules never require this one, and execApproval requires this lazily,
 * so there is no require cycle.
 */

// Unified risk ordering across both source vocabularies — single source of truth
// in the zero-dependency leaf constants/riskOrder.js (no require cycle: leaf has
// no dependencies). Re-exported below for back-compat.
const { RISK_ORDER } = require('../constants/riskOrder');

// shellSafetyValidator severity → risk vocabulary. 'info' is the baseline
// (no risk detected), so it imposes no floor and maps to 'safe'.
const SEVERITY_TO_RISK = { info: 'safe', warning: 'high', critical: 'critical' };

function maxRisk(a, b) {
  return (RISK_ORDER[a] || 0) >= (RISK_ORDER[b] || 0) ? (a || 'safe') : (b || 'safe');
}

/**
 * Classify a shell command's risk from the combined judgement of the virtual
 * tool mapper and the syntax safety validator.
 *
 * @param {string} command
 * @returns {{
 *   risk: string,                    // safe|low|medium|high|critical (strictest of both sources)
 *   severity: string,                // validator severity: info|warning|critical
 *   isReadOnly: boolean,
 *   isDestructive: boolean,
 *   hasCommandSubstitution: boolean,
 *   virtualTools: Array<object>,
 *   reason: string,
 * }}
 */
function classifyCommandRisk(command) {
  if (!command || typeof command !== 'string') {
    return {
      risk: 'critical',
      severity: 'critical',
      isReadOnly: false,
      isDestructive: false,
      hasCommandSubstitution: false,
      virtualTools: [],
      reason: 'Empty or invalid command',
    };
  }

  const trimmed = command.trim();

  // Source A: virtual tool mapping (per-segment, strictest-wins inside).
  let mapping = {
    virtualTools: [],
    overallRisk: 'medium',
    overallReadOnly: false,
    overallDestructive: false,
    hasCommandSubstitution: false,
  };
  try {
    const { mapCommandToVirtualTools } = require('./shellToToolMapper');
    mapping = mapCommandToVirtualTools(trimmed) || mapping;
  } catch { /* mapper unavailable — fall back to defaults */ }

  // Source B: syntax/AST safety validator (severity + substitution detection).
  let report = { maxSeverity: 'info', hasCommandSubstitution: false, risks: [] };
  try {
    const { analyzeCommand } = require('./shellSafetyValidator');
    report = analyzeCommand(trimmed) || report;
  } catch { /* validator unavailable — fall back to defaults */ }

  const validatorRisk = SEVERITY_TO_RISK[report.maxSeverity] || 'low';
  const risk = maxRisk(mapping.overallRisk, validatorRisk);

  const hasCommandSubstitution = !!(mapping.hasCommandSubstitution || report.hasCommandSubstitution);

  // Build a human-readable reason from the strictest contributing source.
  const reasons = [];
  if (RISK_ORDER[validatorRisk] >= RISK_ORDER[mapping.overallRisk] && Array.isArray(report.risks)) {
    const top = report.risks.find(r => SEVERITY_TO_RISK[r.severity] === validatorRisk);
    if (top && top.detail) reasons.push(top.detail);
  }
  if (mapping.virtualTools && mapping.virtualTools.length) {
    reasons.push(`virtual tools: ${mapping.virtualTools.map(v => v.tool).join(', ')}`);
  }

  return {
    risk,
    severity: report.maxSeverity || 'info',
    isReadOnly: !!mapping.overallReadOnly,
    isDestructive: !!mapping.overallDestructive,
    hasCommandSubstitution,
    virtualTools: mapping.virtualTools || [],
    reason: reasons.join('; ') || `risk=${risk}`,
  };
}

module.exports = {
  classifyCommandRisk,
  RISK_ORDER,
  SEVERITY_TO_RISK,
  maxRisk,
};
