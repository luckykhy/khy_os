'use strict';

/**
 * riskGate.js — Single judgement facade for risk level + step type.
 *
 * Motivation (learned from DesireCore's "固化/灵活/人闸门" model): every tool
 * execution should carry an explicit step type so that trust and review can be
 * located precisely:
 *   - hardened   (固化): deterministic, read-only or rule-based — auto-runnable.
 *   - flexible   (灵活): needs model reasoning/generation — runs within bounds.
 *   - human-gate (人闸门): high risk or destructive — must pause for confirmation.
 *
 * This module does NOT introduce a new risk vocabulary. It reuses the existing
 * single source of truth:
 *   - shell commands → commandRiskClassifier.classifyCommandRisk()
 *   - other tools    → the tool's static `risk` + registry isReadOnly/isDestructive
 * and derives a step type from the reconciled judgement. It is a pure read-only
 * classifier with no side effects, so it can be called from the permission gate,
 * the receipt recorder, and the workflow engine alike.
 *
 * Dependency direction: riskGate → { commandRiskClassifier, tools registry }.
 * All requires are lazy to avoid cycles with toolCalling.js.
 */

const STEP_TYPES = Object.freeze({
  HARDENED: 'hardened',
  FLEXIBLE: 'flexible',
  HUMAN_GATE: 'human-gate',
});

// Risk-level ordinal scale. Single source of truth lives in the zero-dependency
// leaf constants/riskOrder.js (formerly duplicated here as a cheap fallback to
// avoid depending on commandRiskClassifier — the leaf preserves that intent
// while removing the duplication). Re-exported below for back-compat.
const { RISK_ORDER } = require('../constants/riskOrder');

// Tool names (canonical or common aliases) whose primary payload is a shell
// command and therefore should be judged by the shell classifier.
// NOTE(dogfood 实测 bug): the REGISTERED tool is `shellCommand` (camelCase), but this
// set only carried the snake_case `shell_command`. `isShellTool('shellCommand')` was
// therefore FALSE, so every shell command fell through to the STATIC path and inherited
// the tool's worst-case static `risk:'critical'` → resourceClassifier L2 红灯 → in a
// non-interactive (headless `khy -p`/pipe/background) run the syscall gateway fail-closed
// EVERY command (echo/node/sleep/timeout/git/npm), making khy unable to run any shell
// command headlessly. Root fix: separator-insensitive matching so `shellCommand`,
// `shell_command`, `shell-command` all route to the DYNAMIC classifyCommandRisk (echo→safe,
// rm -rf→critical) — this TIGHTENS precision without weakening the red line (destructive
// commands still classify critical/destructive dynamically → L2). PowerShell already
// matched (`powershell` has no separator). Local gate (mirrors changeWatchService's
// _repoRootAnchorEnabled precedent) preserves riskGate's documented dependency direction
// (riskGate → {commandRiskClassifier, tools registry}); gate off → byte-revert to the
// snake_case-only匹配.
const SHELL_TOOL_NAMES = new Set([
  'bash', 'shell', 'shell_command', 'execute_code', 'powershell', 'cmd', 'run_command',
]);
// Separator-free variants for camelCase/kebab tool names (KHY_SHELL_TOOL_RISK_MATCH).
const SHELL_TOOL_NAMES_NORMALIZED = new Set(
  Array.from(SHELL_TOOL_NAMES, (n) => n.replace(/[\s_-]/g, '')),
);
const _SHELL_MATCH_OFF = ['0', 'false', 'off', 'no'];
function _shellToolRiskMatchEnabled(env = process.env) {
  const v = String((env && env.KHY_SHELL_TOOL_RISK_MATCH) || '').trim().toLowerCase();
  return !_SHELL_MATCH_OFF.includes(v);
}

// Param keys that may carry the shell command string, in priority order.
const COMMAND_PARAM_KEYS = ['command', 'cmd', 'script', 'code'];

function rank(risk) {
  return RISK_ORDER[risk] != null ? RISK_ORDER[risk] : RISK_ORDER.medium;
}

function isShellTool(name) {
  if (!name) return false;
  const raw = String(name).toLowerCase();
  if (SHELL_TOOL_NAMES.has(raw)) return true;
  // Gate on: separator-insensitive match so the camelCase `shellCommand` (and
  // `shell-command`) route to the dynamic shell classifier instead of inheriting the
  // tool's static critical risk. Gate off → byte-revert (snake_case-only, today's bug).
  if (_shellToolRiskMatchEnabled()) {
    return SHELL_TOOL_NAMES_NORMALIZED.has(raw.replace(/[\s_-]/g, ''));
  }
  return false;
}

function extractCommand(params) {
  if (!params || typeof params !== 'object') return '';
  for (const key of COMMAND_PARAM_KEYS) {
    const v = params[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

/**
 * Derive the step type from the reconciled risk signals.
 *
 * @param {{ risk:string, isReadOnly:boolean, isDestructive:boolean }} sig
 * @returns {string} one of STEP_TYPES
 */
function deriveStepType({ risk, isReadOnly, isDestructive }) {
  // Highest priority: anything irreversible or high-stakes is a human gate.
  if (isDestructive || rank(risk) >= RISK_ORDER.high) return STEP_TYPES.HUMAN_GATE;
  // Read-only or trivially-low-risk operations are deterministic enough to run.
  if (isReadOnly || rank(risk) <= RISK_ORDER.low) return STEP_TYPES.HARDENED;
  // Everything else needs model judgement within the configured bounds.
  return STEP_TYPES.FLEXIBLE;
}

/**
 * Read the static risk and behavioral declarations of a non-shell tool.
 *
 * @param {string} toolName
 * @param {object} params
 * @param {object|null} descriptor  resolved tool descriptor (optional)
 * @returns {{ risk:string, isReadOnly:boolean, isDestructive:boolean, reason:string }}
 */
function classifyToolRisk(toolName, params, descriptor) {
  const tool = descriptor && descriptor.tool ? descriptor.tool : null;
  const staticRisk = (tool && tool.risk) || 'medium';

  let isReadOnly = false;
  let isDestructive = false;
  try {
    const registry = require('../tools');
    const key = (descriptor && descriptor.resolvedName) || toolName;
    const regTool = registry.get(key);
    if (regTool) {
      if (typeof regTool.isReadOnly === 'function') isReadOnly = !!regTool.isReadOnly(params);
      if (typeof regTool.isDestructive === 'function') isDestructive = !!regTool.isDestructive(params);
    }
  } catch { /* registry unavailable — rely on static risk only */ }

  return {
    risk: staticRisk,
    isReadOnly,
    isDestructive,
    reason: `static risk=${staticRisk}${isDestructive ? ', destructive' : ''}${isReadOnly ? ', read-only' : ''}`,
  };
}

/**
 * Assess a tool call and return its risk level plus derived step type.
 *
 * @param {string} toolName
 * @param {object} [params]
 * @param {object|null} [descriptor]  optional pre-resolved descriptor to avoid re-resolving
 * @returns {{
 *   riskLevel: string,      // safe|low|medium|high|critical
 *   isReadOnly: boolean,
 *   isDestructive: boolean,
 *   stepType: string,       // hardened|flexible|human-gate
 *   reason: string,
 *   source: string,         // 'shell' | 'tool'
 * }}
 */
function assess(toolName, params = {}, descriptor = null) {
  let signals;
  let source;

  if (isShellTool(toolName)) {
    source = 'shell';
    const command = extractCommand(params);
    try {
      const { classifyCommandRisk } = require('./commandRiskClassifier');
      const c = classifyCommandRisk(command);
      signals = { risk: c.risk, isReadOnly: c.isReadOnly, isDestructive: c.isDestructive, reason: c.reason };
    } catch {
      // Classifier unavailable — fail safe to a human gate for shell.
      signals = { risk: 'high', isReadOnly: false, isDestructive: false, reason: 'shell classifier unavailable' };
    }
  } else {
    source = 'tool';
    signals = classifyToolRisk(toolName, params, descriptor);
  }

  const stepType = deriveStepType(signals);
  return {
    riskLevel: signals.risk || 'medium',
    isReadOnly: !!signals.isReadOnly,
    isDestructive: !!signals.isDestructive,
    stepType,
    reason: signals.reason || `risk=${signals.risk}`,
    source,
  };
}

/**
 * Whether a step type must pause for explicit human confirmation.
 * @param {string} stepType
 */
function requiresHumanGate(stepType) {
  return stepType === STEP_TYPES.HUMAN_GATE;
}

/**
 * Whether an assessed step is an UNBYPASSABLE human gate — one that even the
 * bypass / acceptEdits / yolo permission modes must NOT auto-approve, so it
 * always reaches explicit human consent.
 *
 * This is deliberately STRICTER than a plain human-gate but LOOSER than the
 * old `critical`-only rule. The motivation (closing the bypass safety gap):
 *   - Ordinary high-risk but reversible ops (e.g. a network call, a `mv a b`'s
 *     non-destructive cousins) stay auto-runnable under bypass, so autonomous
 *     Goal Mode keeps working without nagging.
 *   - Anything IRREVERSIBLE (isDestructive: rm, kill, drop table, git reset
 *     --hard) OR explicitly `critical` is unbypassable — even when the syscall
 *     gateway is disabled (KHY_SYSCALL_GATEWAY=off), this remains the backstop
 *     that prevents bypass from auto-approving destructive data loss.
 *
 * Single source of truth: both the permission gate (requestPermission) and the
 * gateway L1 pre-authorization read THIS function, so the "unbypassable" line is
 * defined exactly once.
 *
 * @param {{stepType?:string, riskLevel?:string, isDestructive?:boolean}} assessment
 * @returns {boolean}
 */
function isUnbypassableGate(assessment) {
  if (!assessment || assessment.stepType !== STEP_TYPES.HUMAN_GATE) return false;
  return assessment.riskLevel === 'critical' || assessment.isDestructive === true;
}

module.exports = {
  assess,
  deriveStepType,
  requiresHumanGate,
  isUnbypassableGate,
  isShellTool,
  _shellToolRiskMatchEnabled,
  STEP_TYPES,
  RISK_ORDER,
};
