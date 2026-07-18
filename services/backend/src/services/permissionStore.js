/**
 * Permission Store — profile-aware, persistent permission management.
 *
 * Six permission profiles (CC-aligned — see toolCallingPermissions._MODE_TO_PROFILE):
 *   - strict:      All tools require confirmation, including 'safe' tools
 *   - normal:      Safe tools auto-approved, everything else asks (default)
 *   - acceptEdits: normal + non-destructive filesystem edits auto-approved
 *                  (shell/execution and destructive ops still ask). This is
 *                  Claude Code's "auto-accept edits" sweet-spot mode.
 *   - auto:        Routine calls auto-approved (incl. safe shell); destructive or
 *                  high/critical-risk actions still ask. Deterministic analog of
 *                  Claude Code's classifier-gated `auto` — khy has no classifier
 *                  model, so it gates on riskGate's risk/isDestructive signals.
 *   - dontAsk:     Inverse of yolo — deny everything not EXPLICITLY allowed
 *                  (persistent forever-rule / session approval). Fails loudly for
 *                  scripted/CI runs; CC's `dontAsk`.
 *   - yolo:        All tools auto-approved (equivalent to --dangerous)
 *
 * Approvals persist across sessions in ~/.khyquant/permissions.json.
 * Migrates from legacy tool_permissions.json on first load.
 *
 * Inspired by Claude Code's multi-layer permission system.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const PERMISSIONS_FILE = path.join(os.homedir(), '.khyquant', 'permissions.json');
const LEGACY_FILE = path.join(os.homedir(), '.khyquant', 'tool_permissions.json');

const VALID_PROFILES = ['strict', 'normal', 'acceptEdits', 'auto', 'dontAsk', 'yolo'];
const VALID_SCOPES = ['once', 'session', 'forever'];

// Risk levels that `auto` mode still routes to a prompt. Everything below —
// safe/low/moderate non-destructive — is auto-approved under `auto`. This is
// khy's deterministic threshold analog of CC's classifier-gated auto mode
// (khy has no classifier model); the unbypassable red line in toolCalling
// (criticalGate / isUnbypassableGate) stays in force regardless of profile.
const _AUTO_ASK_RISKS = new Set(['high', 'critical']);

// ── In-memory state ─────────────────────────────────────────────────

let _profile = 'normal';
let _rules = {};           // { toolName: { decision, scope, since, conditions? } }
let _sessionApprovals = new Set(); // Session-only approvals (cleared on restart)
let _sessionDenials = new Set();
let _loaded = false;

// ── Persistence ─────────────────────────────────────────────────────

function _ensureDir() {
  const dir = path.dirname(PERMISSIONS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function _load() {
  if (_loaded) return;
  _loaded = true;

  // Try loading new format first
  try {
    if (fs.existsSync(PERMISSIONS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'));
      _profile = VALID_PROFILES.includes(data.profile) ? data.profile : 'normal';
      _rules = data.rules || {};
      return;
    }
  } catch { /* fall through to migration */ }

  // Migrate from legacy format
  _migrateLegacy();
}

function _save() {
  try {
    _ensureDir();
    const data = {
      profile: _profile,
      rules: _rules,
      version: 2,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(data, null, 2));
  } catch { /* best effort */ }
}

/**
 * Migrate from legacy tool_permissions.json format.
 * Legacy: { approved: { toolName: true }, denied: {}, dangerousAcknowledged: bool }
 */
function _migrateLegacy() {
  try {
    if (!fs.existsSync(LEGACY_FILE)) return;

    const legacy = JSON.parse(fs.readFileSync(LEGACY_FILE, 'utf-8'));

    // Convert approved tools
    if (legacy.approved && typeof legacy.approved === 'object') {
      for (const [toolName, value] of Object.entries(legacy.approved)) {
        if (value) {
          _rules[toolName] = {
            decision: 'allow',
            scope: 'forever',
            since: new Date().toISOString(),
            migrated: true,
          };
        }
      }
    }

    // Convert denied tools
    if (legacy.denied && typeof legacy.denied === 'object') {
      for (const [toolName, value] of Object.entries(legacy.denied)) {
        if (value) {
          _rules[toolName] = {
            decision: 'deny',
            scope: 'forever',
            since: new Date().toISOString(),
            migrated: true,
          };
        }
      }
    }

    // If dangerous mode was acknowledged, set profile to normal
    // (don't auto-enable yolo — user should opt in explicitly)
    _profile = 'normal';

    // Save migrated data
    _save();
  } catch { /* migration failure is non-critical */ }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Set the permission profile.
 * @param {'strict'|'normal'|'acceptEdits'|'yolo'} profileName
 * @param {{persist?: boolean}} [opts] persist=false sets the in-memory profile
 *   ONLY (no disk write). Used by toolCalling.setPermissionMode to keep the two
 *   permission vocabularies coherent within a session without overwriting the
 *   user's durable on-disk profile. Defaults to true (back-compat).
 */
function setProfile(profileName, opts = {}) {
  _load();
  if (!VALID_PROFILES.includes(profileName)) {
    throw new Error(`Invalid profile: ${profileName}. Valid: ${VALID_PROFILES.join(', ')}`);
  }
  _profile = profileName;
  if (opts.persist !== false) _save();
}

/**
 * Get the current permission profile.
 * @returns {string}
 */
function getProfile() {
  _load();
  return _profile;
}

/**
 * Check if a tool call should be allowed, denied, or needs to ask.
 *
 * Decision flow:
 * 1. Profile 'yolo' → always allow
 * 2. Session denial → deny
 * 3. Persistent rules → apply
 * 4. Session approval → allow
 * 5. Profile 'strict' → ask (even for safe tools)
 * 6. Profile 'normal'/'acceptEdits' + safe/readOnly → allow
 * 7. Profile 'acceptEdits' + non-destructive filesystem edit → allow
 * 8. Default → ask
 *
 * @param {string} toolName
 * @param {object} [params]
 * @param {object} [options]
 * @param {string} [options.risk] - Tool risk level
 * @param {string} [options.category] - Tool category (e.g. 'filesystem', 'execution')
 * @returns {'allow'|'deny'|'ask'}
 */
function check(toolName, params, options = {}) {
  _load();

  // Yolo mode = approve everything
  if (_profile === 'yolo') return 'allow';

  // Session denial overrides everything else
  if (_sessionDenials.has(toolName)) return 'deny';

  // Persistent rules
  const rule = _rules[toolName];
  if (rule) {
    if (rule.decision === 'allow' && rule.scope === 'forever') return 'allow';
    if (rule.decision === 'deny' && rule.scope === 'forever') return 'deny';
  }

  // Session approval
  if (_sessionApprovals.has(toolName)) return 'allow';

  // dontAsk mode (CC-aligned, inverse of yolo): deny everything not EXPLICITLY
  // allowed. Explicit allows above (persistent forever-rule + session approval)
  // survive; the learned-ledger and virtual-tool implicit approvals below are
  // intentionally skipped so a scripted/CI run fails loudly rather than silently
  // proceeding on a heuristic. Reachable via KHY_PERMISSION_MODE=dontAsk.
  if (_profile === 'dontAsk') return 'deny';

  // Learned auto-approval (借鉴分析 #6): opt-in, low-risk, non-destructive,
  // repeatedly approved with zero denials. Hard-gated inside approvalLedger;
  // critical-risk calls are still caught by toolCalling's criticalGate, which
  // ignores a learned 'allow'. Best-effort: ledger unavailable → skip.
  try {
    const ledger = require('./approvalLedger');
    if (ledger.shouldAutoApprove({ key: toolName, risk: options.risk, isDestructive: options.isDestructive })) {
      return 'allow';
    }
  } catch { /* approvalLedger unavailable — fall through */ }

  // Virtual tool mapping: if a shell command maps to a known tool,
  // check that tool's permission as a transparent fallback
  if (options.virtualTool && options.virtualTool !== toolName) {
    const virtualRule = _rules[options.virtualTool];
    if (virtualRule?.decision === 'allow' && virtualRule.scope === 'forever') return 'allow';
    if (_sessionApprovals.has(options.virtualTool)) return 'allow';
  }

  // Strict mode: ask for everything
  if (_profile === 'strict') return 'ask';

  // auto mode (CC-aligned): auto-approve routine tool calls (incl. safe shell),
  // but destructive or high/critical-risk actions still ask. khy has no
  // classifier model like CC's `auto`; the deterministic risk signals
  // (isDestructive + risk, derived upstream by riskGate/commandRiskClassifier)
  // are the honest analog. The unbypassable red line in toolCalling stays in
  // force regardless, so a routine 'allow' here never overrides a critical gate.
  if (_profile === 'auto') {
    if (options.isDestructive === true) return 'ask';
    if (_AUTO_ASK_RISKS.has(options.risk)) return 'ask';
    return 'allow';
  }

  // Normal & acceptEdits: auto-approve safe tools
  if ((_profile === 'normal' || _profile === 'acceptEdits') && options.risk === 'safe') return 'allow';

  // Normal & acceptEdits: auto-approve readOnly tools (behavioral declaration)
  if ((_profile === 'normal' || _profile === 'acceptEdits') && options.isReadOnly === true) return 'allow';

  // acceptEdits sweet spot: auto-approve non-destructive filesystem edits
  // (Edit/Write/MultiEdit/apply_patch/NotebookEdit are category 'filesystem').
  // Shell ('execution') and destructive ops fall through and still ask —
  // criticalGate in toolCalling stays an unbypassable red line regardless.
  if (_profile === 'acceptEdits'
      && options.category === 'filesystem'
      && options.isReadOnly !== true
      && options.isDestructive !== true) {
    return 'allow';
  }

  // Destructive tools require explicit approval (unless yolo or already authorized)
  if (options.isDestructive === true && _profile !== 'yolo') {
    const destructiveRule = _rules[toolName];
    if (destructiveRule?.decision === 'allow' && destructiveRule.scope === 'forever') return 'allow';
    if (_sessionApprovals.has(toolName)) return 'allow';
    return 'ask';
  }

  return 'ask';
}

/**
 * Record an approval decision.
 * @param {string} toolName
 * @param {'once'|'session'|'forever'} scope
 * @param {{ risk?:string }} [meta] - optional risk for the learned ledger
 */
function approve(toolName, scope = 'once', meta = {}) {
  _load();

  if (scope === 'session') {
    _sessionApprovals.add(toolName);
    _sessionDenials.delete(toolName);
  } else if (scope === 'forever') {
    _rules[toolName] = {
      decision: 'allow',
      scope: 'forever',
      since: new Date().toISOString(),
    };
    _sessionApprovals.add(toolName);
    _sessionDenials.delete(toolName);
    _save();
  }
  // 'once' = no persistence, just allow this call
  try { require('./approvalLedger').record({ key: toolName, decision: 'allow', risk: meta && meta.risk }); } catch { /* best effort */ }
}

/**
 * Record a denial decision.
 * @param {string} toolName
 * @param {'once'|'session'|'forever'} scope
 * @param {{ risk?:string }} [meta] - optional risk for the learned ledger
 */
function deny(toolName, scope = 'once', meta = {}) {
  _load();

  if (scope === 'session') {
    _sessionDenials.add(toolName);
    _sessionApprovals.delete(toolName);
  } else if (scope === 'forever') {
    _rules[toolName] = {
      decision: 'deny',
      scope: 'forever',
      since: new Date().toISOString(),
    };
    _sessionDenials.add(toolName);
    _sessionApprovals.delete(toolName);
    _save();
  }
  try { require('./approvalLedger').record({ key: toolName, decision: 'deny', risk: meta && meta.risk }); } catch { /* best effort */ }
}

/**
 * Get list of all approved tool names.
 * @returns {string[]}
 */
function getApprovedTools() {
  _load();
  const approved = new Set(_sessionApprovals);
  for (const [name, rule] of Object.entries(_rules)) {
    if (rule.decision === 'allow') approved.add(name);
  }
  return [...approved];
}

/**
 * Get list of all denied tool names.
 * @returns {string[]}
 */
function getDeniedTools() {
  _load();
  const denied = new Set(_sessionDenials);
  for (const [name, rule] of Object.entries(_rules)) {
    if (rule.decision === 'deny') denied.add(name);
  }
  return [...denied];
}

/**
 * Get all rules for display.
 * @returns {object}
 */
function getAllRules() {
  _load();
  return {
    profile: _profile,
    persistent: { ..._rules },
    sessionApproved: [..._sessionApprovals],
    sessionDenied: [..._sessionDenials],
  };
}

/**
 * Reset all permissions (profile stays, rules cleared).
 */
function reset() {
  _load();
  _rules = {};
  _sessionApprovals.clear();
  _sessionDenials.clear();
  _save();
}

/**
 * Revoke a specific tool's persistent rule.
 * @param {string} toolName
 */
function revoke(toolName) {
  _load();
  delete _rules[toolName];
  _sessionApprovals.delete(toolName);
  _sessionDenials.delete(toolName);
  _save();
}

module.exports = {
  setProfile,
  getProfile,
  check,
  approve,
  deny,
  getApprovedTools,
  getDeniedTools,
  getAllRules,
  reset,
  revoke,
  VALID_PROFILES,
};
