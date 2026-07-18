'use strict';

/**
 * execApproval.js — Multi-level command execution approval system.
 *
 * Ported from OpenClaw's exec-approval (500+ lines).
 * Provides a layered permission system for AI-executed commands with
 * glob-based allowlisting, risk classification, and expiring approval
 * requests. Complements the existing preflightPermission.js.
 *
 * Permission levels:
 * - deny:      command is blocked unconditionally
 * - allowlist: command must match an allowlist pattern
 * - ask:       prompt user for approval (with expiring request)
 * - full:      command is allowed without restriction
 *
 * Key features:
 * - Glob-based command pattern matching with arg patterns
 * - Risk classification (low/medium/high/critical)
 * - Expiring approval requests (30-minute TTL)
 * - Session-scoped "always allow" rules
 * - Audit trail of approval decisions
 */

const crypto = require('crypto');

// ── Risk levels ──
//
// These four string values are a strict SUBSET of the shared five-tier risk
// vocabulary in constants/riskOrder.js (safe/low/medium/high/critical). Commands
// are omitted the `safe` tier ON PURPOSE, not by oversight: a shell command
// always has side effects, so command risk starts at `low` and rises to
// `critical`. Only pure read-only *tools* (never commands) qualify as `safe`.
// The drift-guard test tests/services/riskVocabulary.test.js pins these values
// to the shared vocabulary and asserts the intentional absence of `safe`.
const RISK = {
  LOW:      'low',
  MEDIUM:   'medium',
  HIGH:     'high',
  CRITICAL: 'critical',
};

// ── Permission levels ──

const PERMISSION = {
  DENY:      'deny',
  ALLOWLIST: 'allowlist',
  ASK:       'ask',
  FULL:      'full',
};

// ── Default risk classification patterns ──

const DEFAULT_RISK_PATTERNS = [
  // Critical — destructive, irreversible
  { pattern: 'rm -rf *',      risk: RISK.CRITICAL },
  { pattern: 'rm -r /',       risk: RISK.CRITICAL },
  { pattern: 'dd if=*',       risk: RISK.CRITICAL },
  { pattern: 'mkfs*',         risk: RISK.CRITICAL },
  { pattern: 'format *',      risk: RISK.CRITICAL },
  { pattern: ':(){ :|:& };:', risk: RISK.CRITICAL },  // fork bomb
  { pattern: 'shutdown*',     risk: RISK.CRITICAL },
  { pattern: 'reboot*',       risk: RISK.CRITICAL },
  { pattern: 'git push --force*', risk: RISK.CRITICAL },
  { pattern: 'git reset --hard*', risk: RISK.CRITICAL },
  { pattern: 'DROP TABLE*',   risk: RISK.CRITICAL },
  { pattern: 'DROP DATABASE*', risk: RISK.CRITICAL },

  // High — system modification, network access
  { pattern: 'curl * | sh',   risk: RISK.HIGH },
  { pattern: 'curl * | bash', risk: RISK.HIGH },
  { pattern: 'wget * | sh',   risk: RISK.HIGH },
  { pattern: 'sudo *',        risk: RISK.HIGH },
  { pattern: 'chmod 777 *',   risk: RISK.HIGH },
  { pattern: 'chown *',       risk: RISK.HIGH },
  { pattern: 'npm publish*',  risk: RISK.HIGH },
  { pattern: 'docker rm *',   risk: RISK.HIGH },
  { pattern: 'kubectl delete*', risk: RISK.HIGH },

  // Medium — writes, installs
  { pattern: 'npm install*',  risk: RISK.MEDIUM },
  { pattern: 'pip install*',  risk: RISK.MEDIUM },
  { pattern: 'apt install*',  risk: RISK.MEDIUM },
  { pattern: 'git push*',     risk: RISK.MEDIUM },
  { pattern: 'git commit*',   risk: RISK.MEDIUM },
  { pattern: 'mv *',          risk: RISK.MEDIUM },
  { pattern: 'cp *',          risk: RISK.MEDIUM },

  // Low — read-only, informational
  { pattern: 'ls *',          risk: RISK.LOW },
  { pattern: 'cat *',         risk: RISK.LOW },
  { pattern: 'grep *',        risk: RISK.LOW },
  { pattern: 'find *',        risk: RISK.LOW },
  { pattern: 'git status',    risk: RISK.LOW },
  { pattern: 'git log*',      risk: RISK.LOW },
  { pattern: 'git diff*',     risk: RISK.LOW },
  { pattern: 'echo *',        risk: RISK.LOW },
  { pattern: 'pwd',           risk: RISK.LOW },
  { pattern: 'whoami',        risk: RISK.LOW },
  { pattern: 'node -e *',     risk: RISK.LOW },
];

// ── Approval request TTL ──

const REQUEST_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Match a command against a glob-like pattern.
 * Supports * as wildcard for any characters.
 *
 * @param {string} command
 * @param {string} pattern
 * @returns {boolean}
 */
function matchCommandPattern(command, pattern) {
  if (!command || !pattern) return false;

  // Escape regex special chars except *
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');

  try {
    return new RegExp(`^${regexStr}$`, 'i').test(command.trim());
  } catch {
    return false;
  }
}

/**
 * Classify the risk level of a command.
 *
 * @param {string} command
 * @param {Array<{pattern: string, risk: string}>} [riskPatterns]
 * @returns {{ risk: string, matchedPattern: string|null }}
 */
function classifyRisk(command, riskPatterns) {
  const patterns = riskPatterns || DEFAULT_RISK_PATTERNS;

  for (const { pattern, risk } of patterns) {
    if (matchCommandPattern(command, pattern)) {
      return { risk, matchedPattern: pattern };
    }
  }

  // Default: medium risk for unknown commands
  return { risk: RISK.MEDIUM, matchedPattern: null };
}

/**
 * @typedef {object} ApprovalRequest
 * @property {string} id
 * @property {string} command
 * @property {string} risk
 * @property {number} createdAt
 * @property {number} expiresAt
 * @property {string|null} decision - 'approved' | 'denied' | null
 * @property {string|null} decidedBy
 * @property {number|null} decidedAt
 */

class ExecApprovalManager {
  /**
   * @param {object} [opts]
   * @param {string} [opts.permissionLevel='ask'] - Default permission level
   * @param {string[]} [opts.allowPatterns=[]] - Glob patterns for allowlisted commands
   * @param {string[]} [opts.denyPatterns=[]] - Glob patterns for denied commands
   * @param {number} [opts.requestTtlMs=1800000] - Approval request TTL
   * @param {Array<{pattern: string, risk: string}>} [opts.riskPatterns]
   */
  constructor(opts = {}) {
    this._permissionLevel = opts.permissionLevel || PERMISSION.ASK;
    this._allowPatterns = opts.allowPatterns || [];
    this._denyPatterns = opts.denyPatterns || [];
    this._requestTtlMs = opts.requestTtlMs || REQUEST_TTL_MS;
    this._riskPatterns = opts.riskPatterns || DEFAULT_RISK_PATTERNS;

    /** @type {Map<string, ApprovalRequest>} */
    this._pendingRequests = new Map();

    /** @type {Set<string>} session-scoped always-allow patterns */
    this._sessionAllowed = new Set();

    /** @type {Array<{command: string, decision: string, risk: string, timestamp: number}>} */
    this._auditTrail = [];
    this._maxAudit = 200;
  }

  /**
   * Check if a command is allowed to execute.
   *
   * @param {string} command
   * @returns {{ allowed: boolean, reason: string, risk: string, requestId?: string }}
   */
  checkCommand(command) {
    if (!command || typeof command !== 'string') {
      return { allowed: false, reason: 'Empty command', risk: RISK.CRITICAL };
    }

    const trimmed = command.trim();

    // Unified risk source (s03 Phase ③): a single classifier reconciles the
    // virtual-tool mapping and the syntax safety validator (strictest-wins).
    // The legacy glob table (classifyRisk/DEFAULT_RISK_PATTERNS) is only a
    // fallback when the classifier is unavailable.
    let toolMapping = null;
    let risk;
    try {
      const { classifyCommandRisk } = require('./commandRiskClassifier');
      const verdict = classifyCommandRisk(trimmed);
      risk = verdict.risk;
      // Adapt to the legacy toolMapping shape consumed below (step 5b).
      toolMapping = {
        virtualTools: verdict.virtualTools,
        overallRisk: verdict.risk,
        overallReadOnly: verdict.isReadOnly,
        overallDestructive: verdict.isDestructive,
        hasCommandSubstitution: verdict.hasCommandSubstitution,
      };

      // Auto-deny command substitution ($() or ``) unless in full mode.
      // Shell-aware guard: `$(...)`/backticks are POSIX command substitution (an
      // injection surface worth hard-denying) ONLY in a POSIX context. In a
      // PowerShell/pwsh invocation they are that shell's NATIVE syntax
      // (subexpression / escape), so hard-denying every powershell command that
      // uses them is a false positive with no approval path. When the outer shell
      // is non-POSIX we skip the hard-deny and fall through to the normal approval
      // path (step 6) so the user can approve it — never a silent allow.
      // Fail-safe: gate off / parse error → treat as POSIX substitution (keep the
      // original hard-deny); bash behavior is byte-for-byte unchanged.
      if (toolMapping.hasCommandSubstitution && this._permissionLevel !== PERMISSION.FULL) {
        let denySubstitution = true;
        try {
          const { isPosixCommandSubstitution } = require('./commandSubstitutionContext');
          denySubstitution = isPosixCommandSubstitution(trimmed, process.env);
        } catch { denySubstitution = true; }
        if (denySubstitution) {
          this._audit(trimmed, 'denied', risk, 'command_substitution');
          return { allowed: false, reason: 'Command substitution ($() or ``) detected — potential injection risk', risk };
        }
        // else: non-POSIX shell ($()/`` are native) — fall through to approval.
      }
    } catch {
      // Classifier unavailable — fall back to the legacy glob table.
      risk = classifyRisk(trimmed, this._riskPatterns).risk;
    }

    // 1. Check deny patterns first
    for (const pattern of this._denyPatterns) {
      if (matchCommandPattern(trimmed, pattern)) {
        this._audit(trimmed, 'denied', risk, 'deny_pattern');
        return { allowed: false, reason: `Command matches deny pattern: ${pattern}`, risk };
      }
    }

    // 2. Full permission mode
    if (this._permissionLevel === PERMISSION.FULL) {
      this._audit(trimmed, 'approved', risk, 'full_permission');
      return { allowed: true, reason: 'Full permission mode', risk };
    }

    // 3. Deny permission mode
    if (this._permissionLevel === PERMISSION.DENY) {
      this._audit(trimmed, 'denied', risk, 'deny_mode');
      return { allowed: false, reason: 'Command execution denied', risk };
    }

    // 4. Check session-scoped always-allow
    for (const pattern of this._sessionAllowed) {
      if (matchCommandPattern(trimmed, pattern)) {
        this._audit(trimmed, 'approved', risk, 'session_allow');
        return { allowed: true, reason: 'Session-allowed', risk };
      }
    }

    // 5. Check allowlist patterns
    if (this._permissionLevel === PERMISSION.ALLOWLIST || this._allowPatterns.length > 0) {
      for (const pattern of this._allowPatterns) {
        if (matchCommandPattern(trimmed, pattern)) {
          this._audit(trimmed, 'approved', risk, 'allowlist');
          return { allowed: true, reason: `Matches allowlist: ${pattern}`, risk };
        }
      }

      if (this._permissionLevel === PERMISSION.ALLOWLIST) {
        this._audit(trimmed, 'denied', risk, 'not_in_allowlist');
        return { allowed: false, reason: 'Command not in allowlist', risk };
      }
    }

    // 5b. Read-only command auto-approve via virtual tool mapping
    if (toolMapping && toolMapping.overallReadOnly && !toolMapping.hasCommandSubstitution) {
      try {
        const permStore = require('./permissionStore');
        // Check if the primary virtual tool is auto-approved
        const primaryTool = toolMapping.virtualTools[0]?.tool || 'shell_command';
        const decision = permStore.check(primaryTool, {}, {
          risk: toolMapping.overallRisk,
          isReadOnly: true,
        });
        if (decision === 'allow') {
          this._audit(trimmed, 'approved', risk, 'read_only_auto');
          return { allowed: true, reason: `Read-only command (virtual: ${primaryTool})`, risk };
        }
      } catch { /* permissionStore not available */ }
    }

    // 6. Ask mode — create approval request
    const requestId = this._createRequest(trimmed, risk);
    return { allowed: false, reason: 'Approval required', risk, requestId };
  }

  /**
   * Create an approval request.
   */
  _createRequest(command, risk) {
    // Clean up expired requests
    this._cleanExpired();

    const id = crypto.randomBytes(6).toString('hex');
    this._pendingRequests.set(id, {
      id,
      command,
      risk,
      createdAt: Date.now(),
      expiresAt: Date.now() + this._requestTtlMs,
      decision: null,
      decidedBy: null,
      decidedAt: null,
    });

    return id;
  }

  /**
   * Approve or deny a pending request.
   *
   * @param {string} requestId
   * @param {'approved'|'denied'} decision
   * @param {object} [opts]
   * @param {string} [opts.decidedBy]
   * @param {boolean} [opts.alwaysAllow=false] - Add to session-allowed for this pattern
   * @returns {{ success: boolean, error?: string }}
   */
  decide(requestId, decision, opts = {}) {
    const req = this._pendingRequests.get(requestId);
    if (!req) return { success: false, error: 'Request not found or expired' };
    if (req.expiresAt < Date.now()) {
      this._pendingRequests.delete(requestId);
      return { success: false, error: 'Request expired' };
    }

    req.decision = decision;
    req.decidedBy = opts.decidedBy || 'user';
    req.decidedAt = Date.now();

    this._audit(req.command, decision, req.risk, 'user_decision');

    // Session-scoped always-allow
    if (decision === 'approved' && opts.alwaysAllow) {
      // Generate a pattern from the command (keep the command as-is for exact match)
      this._sessionAllowed.add(req.command);
    }

    return { success: true };
  }

  /**
   * Get a pending request.
   */
  getRequest(requestId) {
    const req = this._pendingRequests.get(requestId);
    if (!req || req.expiresAt < Date.now()) return null;
    return { ...req };
  }

  /**
   * List pending requests.
   */
  listPending() {
    this._cleanExpired();
    const pending = [];
    for (const req of this._pendingRequests.values()) {
      if (!req.decision) pending.push({ ...req });
    }
    return pending;
  }

  /**
   * Add allowlist patterns.
   */
  addAllowPatterns(...patterns) {
    for (const p of patterns) {
      if (typeof p === 'string' && !this._allowPatterns.includes(p)) {
        this._allowPatterns.push(p);
      }
    }
  }

  /**
   * Add deny patterns.
   */
  addDenyPatterns(...patterns) {
    for (const p of patterns) {
      if (typeof p === 'string' && !this._denyPatterns.includes(p)) {
        this._denyPatterns.push(p);
      }
    }
  }

  /**
   * Set permission level.
   */
  setPermissionLevel(level) {
    if (Object.values(PERMISSION).includes(level)) {
      this._permissionLevel = level;
    }
  }

  /**
   * Get audit trail.
   */
  getAuditTrail(limit) {
    const n = limit || this._auditTrail.length;
    return this._auditTrail.slice(-n);
  }

  /**
   * Get current configuration.
   */
  getConfig() {
    return {
      permissionLevel: this._permissionLevel,
      allowPatterns: [...this._allowPatterns],
      denyPatterns: [...this._denyPatterns],
      sessionAllowedCount: this._sessionAllowed.size,
      pendingRequests: this.listPending().length,
    };
  }

  // ── Internal ──

  _cleanExpired() {
    const now = Date.now();
    for (const [id, req] of this._pendingRequests) {
      if (req.expiresAt < now) {
        this._pendingRequests.delete(id);
      }
    }
  }

  _audit(command, decision, risk, source) {
    this._auditTrail.push({
      command: command.length > 200 ? command.slice(0, 200) + '...' : command,
      decision,
      risk,
      source,
      timestamp: Date.now(),
    });

    if (this._auditTrail.length > this._maxAudit) {
      this._auditTrail = this._auditTrail.slice(-this._maxAudit);
    }
  }
}

// Singleton
const execApproval = new ExecApprovalManager();

/**
 * Dedup token: a Symbol key stamped onto tool params once execApproval has
 * already resolved (approved) a command. Downstream permission gates honor it
 * to avoid double-prompting. A Symbol key cannot be forged by the model via
 * JSON params, so it is safe against approval-token spoofing.
 */
const EXEC_APPROVED = Symbol('execApproved');

/**
 * Dedup token: a Symbol key stamped onto tool params once PreToolUse hooks have
 * already been evaluated (and passed) for this specific call — set by the main
 * toolUseLoop after it triggers PreToolUse. executeTool's own PreToolUse hard
 * bottom honors it to avoid re-running the same hooks twice for loop-driven
 * calls, while any caller that bypasses the loop (localToolLoop, direct
 * executeTool, sub-agents) has no stamp and therefore still gets hooks run.
 * Like EXEC_APPROVED, a Symbol key cannot be forged by the model via JSON params.
 */
const HOOKS_EVALUATED = Symbol('hooksEvaluated');

module.exports = {
  RISK,
  PERMISSION,
  matchCommandPattern,
  classifyRisk,
  ExecApprovalManager,
  execApproval,
  DEFAULT_RISK_PATTERNS,
  EXEC_APPROVED,
  HOOKS_EVALUATED,
};
