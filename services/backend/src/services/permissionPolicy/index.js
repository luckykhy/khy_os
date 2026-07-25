/**
 * permissionPolicy — fine-grained, config-driven permission middleware.
 *
 * Public surface:
 *   evaluate(toolName, params, ctx) → decision object | null
 *   getCodeExecutionLimits()        → resource-limit hints for the executor
 *   admin helpers used by the /permissions command (setToolStrategy,
 *   setDefaultStrategy, addPathRule, addUrlRule, summarize, ...).
 *
 * Decision contract returned by evaluate():
 *   {
 *     decision: 'auto' | 'confirm' | 'deny',  // 'auto' ⇒ allow, 'confirm' ⇒ ask
 *     category,                               // coarse category (see matchers)
 *     reason,                                 // human-readable explanation
 *     matched,                                // what triggered the decision
 *     limits,                                 // code-exec resource limits (codeExec only)
 *   }
 *   or null when there is no active policy (file absent or feature disabled),
 *   in which case the caller MUST fall back to the existing permission flow
 *   unchanged.
 *
 * Safety contract (honors the project "只增不减保护" rule):
 *   - This layer can DENY or force CONFIRM (adds protection); when it says
 *     "auto-allow" the caller still applies the unbypassable critical gate.
 *   - A missing/invalid policy ⇒ null ⇒ zero behavior change.
 *   - Kill switch: KHY_PERMISSION_POLICY=off.
 */
'use strict';

const config = require('./config');
const matchers = require('./matchers');

/** True when the policy middleware is enabled (default on, file may be absent). */
function isEnabled() {
  return String(process.env.KHY_PERMISSION_POLICY || '').toLowerCase() !== 'off';
}

/**
 * Resolve the effective strategy for a tool from the per-tool overrides,
 * matching by exact name then by normalized (case/sep-insensitive) name.
 *
 * @returns {string|null} a strategy, or null when no override applies
 */
function _toolOverride(policy, toolName) {
  const tools = policy.tools || {};
  if (Object.prototype.hasOwnProperty.call(tools, toolName)) {
    return config.normalizeStrategy(tools[toolName]);
  }
  const norm = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
  for (const key of Object.keys(tools)) {
    if (key.toLowerCase().replace(/[\s_-]/g, '') === norm) {
      return config.normalizeStrategy(tools[key]);
    }
  }
  return null;
}

/**
 * Evaluate a tool call against the active policy.
 *
 * @param {string} toolName
 * @param {object} [params]
 * @param {object} [ctx] - { category, isReadOnly, isDestructive } registry hints
 * @returns {object|null}
 */
function evaluate(toolName, params = {}, ctx = {}) {
  if (!isEnabled()) return null;
  const policy = config.loadPolicy();
  if (!policy) return null; // no opt-in ⇒ no-op

  const category = matchers.detectCategory(toolName, params, ctx);
  const baseStrategy = _toolOverride(policy, toolName)
    || config.normalizeStrategy(policy.defaultPolicy)
    || 'confirm';

  // 1) Sensitive operations always escalate to at least 'confirm' (二次确认),
  //    unless an explicit 'deny' is already in force (deny is stricter).
  const sensitive = matchers.isSensitiveOperation(
    toolName, params, (policy.sensitiveOperations || {}).requireConfirm,
  );
  if (sensitive && baseStrategy !== 'deny') {
    return {
      decision: 'confirm',
      category,
      reason: '命中敏感操作清单，强制二次确认',
      matched: 'sensitiveOperations',
      limits: null,
    };
  }

  // 2) deny short-circuits everything below.
  if (baseStrategy === 'deny') {
    return { decision: 'deny', category, reason: '策略为 deny', matched: 'strategy', limits: null };
  }

  // 3) Code-execution language gate (independent of auto/confirm): when a
  //    language allowlist is configured, a disallowed language is denied.
  if (category === 'codeExec') {
    const ce = policy.codeExecution || {};
    const allowed = Array.isArray(ce.allowedLanguages) ? ce.allowedLanguages.map((l) => String(l).toLowerCase()) : [];
    const lang = matchers.extractLanguage(params);
    const limits = _normalizeLimits(ce.limits);
    if (allowed.length > 0 && lang && !allowed.includes(lang)) {
      return { decision: 'deny', category, reason: `语言 ${lang} 不在允许列表 [${allowed.join(', ')}]`, matched: 'codeExecution.allowedLanguages', limits };
    }
    // Language permitted (or no allowlist): honor base strategy, attaching limits.
    return _whitelistDecision(baseStrategy, category, true, 'codeExecution', limits);
  }

  // 4) Whitelist-gated categories. Under 'auto', membership decides:
  //    in-whitelist ⇒ allow, out-of-whitelist ⇒ deny. With no whitelist
  //    configured for the category, 'auto' imposes no restriction (allow).
  if (category === 'fileRead' || category === 'fileWrite' || category === 'fileDelete') {
    const fsCfg = policy.filesystem || {};
    const target = matchers.extractPath(params);
    const verbList = category === 'fileRead' ? fsCfg.readWhitelist
      : category === 'fileWrite' ? fsCfg.writeWhitelist
        : fsCfg.deleteWhitelist;
    const combined = [].concat(fsCfg.pathWhitelist || [], verbList || []);
    const hasWhitelist = combined.length > 0;
    const inList = hasWhitelist && target ? matchers.matchPath(target, combined) : false;
    return _whitelistDecision(baseStrategy, category, !hasWhitelist || inList, 'filesystem.pathWhitelist', null, { target, hasWhitelist });
  }

  if (category === 'network') {
    const net = policy.network || {};
    const url = matchers.extractUrl(params);
    const list = net.urlWhitelist || [];
    const hasWhitelist = list.length > 0;
    const inList = hasWhitelist && url ? matchers.matchUrl(url, list) : false;
    return _whitelistDecision(baseStrategy, category, !hasWhitelist || inList, 'network.urlWhitelist', null, { url, hasWhitelist });
  }

  // 5) Non-whitelist categories (shell, git, other): base strategy applies.
  //    Under 'auto' these have no whitelist concept, so 'auto' ⇒ allow.
  return _whitelistDecision(baseStrategy, category, true, 'strategy', null);
}

/**
 * Build the decision for a whitelist-gated category given the base strategy
 * and whether the target is allowed by the whitelist.
 */
function _whitelistDecision(strategy, category, allowed, matched, limits, extra = {}) {
  if (strategy === 'auto') {
    if (allowed) {
      return { decision: 'auto', category, reason: '白名单内/无限制，自动放行', matched, limits: limits || null, ...extra };
    }
    return { decision: 'deny', category, reason: '白名单外，auto 模式自动拒绝', matched, limits: limits || null, ...extra };
  }
  // confirm: prompt regardless of whitelist membership.
  return { decision: 'confirm', category, reason: 'confirm 模式，等待用户确认', matched, limits: limits || null, ...extra };
}

function _normalizeLimits(limits) {
  const l = limits && typeof limits === 'object' ? limits : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return { cpuSeconds: n(l.cpuSeconds), memoryMb: n(l.memoryMb), timeoutMs: n(l.timeoutMs) };
}

/**
 * Code-execution resource limits configured in the policy, for the executor to
 * honor. Returns zeroed limits when no policy / disabled.
 *
 * @returns {{cpuSeconds:number, memoryMb:number, timeoutMs:number}}
 */
function getCodeExecutionLimits() {
  if (!isEnabled()) return { cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 };
  const policy = config.loadPolicy();
  if (!policy) return { cpuSeconds: 0, memoryMb: 0, timeoutMs: 0 };
  return _normalizeLimits((policy.codeExecution || {}).limits);
}

// ── Admin helpers (backing the /permissions command) ────────────────────

function setDefaultStrategy(strategy) {
  const s = config.normalizeStrategy(strategy);
  if (!s) return { success: false, error: `无效策略: ${strategy}（应为 auto/confirm/deny）` };
  const policy = config.ensurePolicy();
  policy.defaultPolicy = s;
  return config.savePolicy(policy);
}

function setToolStrategy(toolName, strategy) {
  if (!toolName) return { success: false, error: '缺少工具名' };
  const s = config.normalizeStrategy(strategy);
  if (!s) return { success: false, error: `无效策略: ${strategy}（应为 auto/confirm/deny）` };
  const policy = config.ensurePolicy();
  policy.tools = policy.tools || {};
  policy.tools[toolName] = s;
  return config.savePolicy(policy);
}

function clearToolStrategy(toolName) {
  const policy = config.loadPolicy();
  if (!policy || !policy.tools || !(toolName in policy.tools)) {
    return { success: false, error: `工具 ${toolName} 没有覆盖策略` };
  }
  delete policy.tools[toolName];
  return config.savePolicy(policy);
}

function addPathRule(glob, verb = 'all') {
  if (!glob) return { success: false, error: '缺少路径模式' };
  const policy = config.ensurePolicy();
  policy.filesystem = policy.filesystem || {};
  const key = verb === 'read' ? 'readWhitelist'
    : verb === 'write' ? 'writeWhitelist'
      : verb === 'delete' ? 'deleteWhitelist' : 'pathWhitelist';
  policy.filesystem[key] = Array.from(new Set([].concat(policy.filesystem[key] || [], glob)));
  return config.savePolicy(policy);
}

function addUrlRule(pattern) {
  if (!pattern) return { success: false, error: '缺少 URL/域名模式' };
  const policy = config.ensurePolicy();
  policy.network = policy.network || {};
  policy.network.urlWhitelist = Array.from(new Set([].concat(policy.network.urlWhitelist || [], pattern)));
  return config.savePolicy(policy);
}

/** A compact, human-readable summary of the active policy for display. */
function summarize() {
  const policy = config.loadPolicy();
  return {
    enabled: isEnabled(),
    exists: config.policyExists(),
    path: config.getPolicyPath(),
    policy: policy || null,
  };
}

module.exports = {
  isEnabled,
  evaluate,
  getCodeExecutionLimits,
  setDefaultStrategy,
  setToolStrategy,
  clearToolStrategy,
  addPathRule,
  addUrlRule,
  summarize,
  // re-export config surface for the command + tests
  config,
  matchers,
};
