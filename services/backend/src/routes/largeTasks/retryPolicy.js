'use strict';

const {
  RETRY_POLICY_ALLOWED_KEYS,
  RETRY_POLICY_TOKEN_REGEX,
  RETRY_POLICY_MAX_LIST_ITEMS,
  RETRY_POLICY_MAX_TOKEN_LENGTH,
  RETRY_POLICY_AUDIT_DEFAULT_LIMIT,
  RETRY_POLICY_APPROVAL_DEFAULT_LIMIT,
  RETRY_POLICY_HIGH_RISK_ERROR_KINDS,
  RETRY_POLICY_GUARDRAIL_TRANSIENT_KINDS,
  RETRY_POLICY_APPROVAL_RETENTION_ALLOWED_KEYS,
  RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT,
  RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS,
  normalizeRetryPolicyToken,
  validateRetryPolicyStringList,
  validateRetryPolicyStatusCodeList,
  validateRetryPolicyPatch,
  validateRetentionInteger,
  validateRetryPolicyApprovalRetentionPatch,
} = require('./retryPolicyValidation');

function policyListAsSet(list = []) {
  const out = new Set();
  if (!Array.isArray(list)) {
    return out;
  }
  for (const item of list) {
    const token = normalizeRetryPolicyToken(item);
    if (token) {
      out.add(token);
    }
  }
  return out;
}

function policyCodeSet(list = []) {
  const out = new Set();
  if (!Array.isArray(list)) {
    return out;
  }
  for (const item of list) {
    const code = Number.parseInt(item, 10);
    if (Number.isFinite(code)) {
      out.add(code);
    }
  }
  return out;
}

function evaluateRetryPolicyRisk(currentPolicy = {}, patch = {}) {
  const triggers = [];
  let riskLevel = 'low';

  const currentDefaultRetryable = currentPolicy?.default_retryable !== false;
  if (patch.default_retryable === false && currentDefaultRetryable) {
    triggers.push('default_retryable_changed_to_false');
    riskLevel = 'critical';
  }

  const currentNonRetryKinds = policyListAsSet(currentPolicy?.non_retryable_error_kinds || []);
  const patchNonRetryKinds = Array.isArray(patch.non_retryable_error_kinds)
    ? patch.non_retryable_error_kinds
    : [];
  const addedHighRiskKinds = patchNonRetryKinds.filter((kind) => {
    const token = normalizeRetryPolicyToken(kind);
    return (
      token && RETRY_POLICY_HIGH_RISK_ERROR_KINDS.has(token) && !currentNonRetryKinds.has(token)
    );
  });
  if (addedHighRiskKinds.length > 0) {
    triggers.push(`non_retryable_error_kinds_add:${addedHighRiskKinds.join(',')}`);
    riskLevel = 'critical';
  }

  const currentNonRetryTypes = policyListAsSet(currentPolicy?.non_retryable_error_types || []);
  const patchNonRetryTypes = Array.isArray(patch.non_retryable_error_types)
    ? patch.non_retryable_error_types
    : [];
  if (
    patchNonRetryTypes.some((item) => normalizeRetryPolicyToken(item) === 'error') &&
    !currentNonRetryTypes.has('error')
  ) {
    triggers.push('non_retryable_error_types_add:error');
    if (riskLevel !== 'critical') {
      riskLevel = 'high';
    }
  }

  const currentNonRetryCodes = policyCodeSet(currentPolicy?.non_retryable_status_codes || []);
  const patchNonRetryCodes = Array.isArray(patch.non_retryable_status_codes)
    ? patch.non_retryable_status_codes
    : [];
  const addedServerCodes = patchNonRetryCodes
    .map((item) => Number.parseInt(item, 10))
    .filter((code) => Number.isFinite(code) && code >= 500 && !currentNonRetryCodes.has(code));
  if (addedServerCodes.length > 0) {
    triggers.push(`non_retryable_status_codes_add_5xx:${addedServerCodes.join(',')}`);
    if (riskLevel !== 'critical') {
      riskLevel = 'high';
    }
  }

  return {
    requires_approval: triggers.length > 0,
    risk_level: triggers.length > 0 ? riskLevel : 'low',
    reason:
      triggers.length > 0
        ? `High-risk retry policy change detected: ${triggers.join('; ')}`
        : 'No high-risk retry policy change detected.',
    triggers,
  };
}

function mergedRetryPolicy(currentPolicy = {}, patch = {}) {
  const currentDefaultRetryable = currentPolicy?.default_retryable !== false;
  return {
    non_retryable_error_types: Array.isArray(patch.non_retryable_error_types)
      ? patch.non_retryable_error_types
      : Array.isArray(currentPolicy?.non_retryable_error_types)
        ? currentPolicy.non_retryable_error_types
        : [],
    non_retryable_status_codes: Array.isArray(patch.non_retryable_status_codes)
      ? patch.non_retryable_status_codes
      : Array.isArray(currentPolicy?.non_retryable_status_codes)
        ? currentPolicy.non_retryable_status_codes
        : [],
    non_retryable_error_kinds: Array.isArray(patch.non_retryable_error_kinds)
      ? patch.non_retryable_error_kinds
      : Array.isArray(currentPolicy?.non_retryable_error_kinds)
        ? currentPolicy.non_retryable_error_kinds
        : [],
    retryable_error_kinds: Array.isArray(patch.retryable_error_kinds)
      ? patch.retryable_error_kinds
      : Array.isArray(currentPolicy?.retryable_error_kinds)
        ? currentPolicy.retryable_error_kinds
        : [],
    default_retryable:
      typeof patch.default_retryable === 'boolean'
        ? patch.default_retryable
        : currentDefaultRetryable,
  };
}

function evaluateRetryPolicyGuardrails(currentPolicy = {}, patch = {}) {
  const effectivePolicy = mergedRetryPolicy(currentPolicy, patch);
  const retryableKinds = policyListAsSet(effectivePolicy.retryable_error_kinds);
  const nonRetryableKinds = policyListAsSet(effectivePolicy.non_retryable_error_kinds);
  const violations = [];

  const hasTransientRetrySignal = RETRY_POLICY_GUARDRAIL_TRANSIENT_KINDS.some((kind) =>
    retryableKinds.has(kind)
  );
  if (effectivePolicy.default_retryable === false && !hasTransientRetrySignal) {
    violations.push({
      code: 'transient_retry_signal_missing',
      message:
        'default_retryable=false requires at least one transient retry kind in retryable_error_kinds.',
    });
  }

  const allTransientKindsDisabled = RETRY_POLICY_GUARDRAIL_TRANSIENT_KINDS.every((kind) =>
    nonRetryableKinds.has(kind)
  );
  if (effectivePolicy.default_retryable === false && allTransientKindsDisabled) {
    violations.push({
      code: 'all_transient_kinds_non_retryable',
      message:
        'Cannot mark timeout/network/rate_limit all non-retryable when default_retryable=false.',
    });
  }

  return {
    blocked: violations.length > 0,
    violations,
    effective_policy: effectivePolicy,
  };
}

module.exports = {
  RETRY_POLICY_APPROVAL_DEFAULT_LIMIT,
  RETRY_POLICY_AUDIT_DEFAULT_LIMIT,
  RETRY_POLICY_APPROVAL_RETENTION_ALLOWED_KEYS,
  RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS,
  RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT,
  RETRY_POLICY_ALLOWED_KEYS,
  RETRY_POLICY_GUARDRAIL_TRANSIENT_KINDS,
  RETRY_POLICY_HIGH_RISK_ERROR_KINDS,
  RETRY_POLICY_MAX_LIST_ITEMS,
  RETRY_POLICY_MAX_TOKEN_LENGTH,
  RETRY_POLICY_TOKEN_REGEX,
  evaluateRetryPolicyGuardrails,
  evaluateRetryPolicyRisk,
  mergedRetryPolicy,
  normalizeRetryPolicyToken,
  policyCodeSet,
  policyListAsSet,
  validateRetentionInteger,
  validateRetryPolicyApprovalRetentionPatch,
  validateRetryPolicyPatch,
  validateRetryPolicyStatusCodeList,
  validateRetryPolicyStringList,
};
