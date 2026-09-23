'use strict';

const RETRY_POLICY_ALLOWED_KEYS = new Set([
  'non_retryable_error_types',
  'non_retryable_status_codes',
  'non_retryable_error_kinds',
  'retryable_error_kinds',
  'default_retryable',
]);
const RETRY_POLICY_TOKEN_REGEX = /^[a-z0-9:_-]+$/;
const RETRY_POLICY_MAX_LIST_ITEMS = 128;
const RETRY_POLICY_MAX_TOKEN_LENGTH = 64;
const RETRY_POLICY_AUDIT_DEFAULT_LIMIT = 50;
const RETRY_POLICY_APPROVAL_DEFAULT_LIMIT = 100;
const RETRY_POLICY_HIGH_RISK_ERROR_KINDS = new Set(['timeout', 'network', 'rate_limit']);
const RETRY_POLICY_GUARDRAIL_TRANSIENT_KINDS = ['timeout', 'network', 'rate_limit'];
const RETRY_POLICY_APPROVAL_RETENTION_ALLOWED_KEYS = new Set([
  'ticket_max_total',
  'event_max_total',
  'terminal_ticket_max_count',
  'terminal_ticket_max_age_ms',
  'event_max_age_ms',
]);
const RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT = 200_000;
const RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS = 365 * 24 * 60 * 60_000;

function normalizeRetryPolicyToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function validateRetryPolicyStringList(fieldName, value, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array.`);
    return [];
  }
  if (value.length > RETRY_POLICY_MAX_LIST_ITEMS) {
    errors.push(`${fieldName} exceeds max length ${RETRY_POLICY_MAX_LIST_ITEMS}.`);
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const token = normalizeRetryPolicyToken(raw);
    if (!token) {
      continue;
    }
    if (token.length > RETRY_POLICY_MAX_TOKEN_LENGTH) {
      errors.push(`${fieldName} token exceeds max length ${RETRY_POLICY_MAX_TOKEN_LENGTH}.`);
      continue;
    }
    if (!RETRY_POLICY_TOKEN_REGEX.test(token)) {
      errors.push(`${fieldName} contains invalid token "${token}".`);
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    out.push(token);
  }
  return out;
}

function validateRetryPolicyStatusCodeList(fieldName, value, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array.`);
    return [];
  }
  if (value.length > RETRY_POLICY_MAX_LIST_ITEMS) {
    errors.push(`${fieldName} exceeds max length ${RETRY_POLICY_MAX_LIST_ITEMS}.`);
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const code = Number.parseInt(raw, 10);
    if (!Number.isFinite(code)) {
      errors.push(`${fieldName} contains non-integer status code.`);
      continue;
    }
    if (code < 100 || code > 599) {
      errors.push(`${fieldName} contains out-of-range status code ${code}.`);
      continue;
    }
    if (seen.has(code)) {
      continue;
    }
    seen.add(code);
    out.push(code);
  }
  out.sort((a, b) => a - b);
  return out;
}

function validateRetryPolicyPatch(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      errors: ['retry_policy must be an object.'],
      patch: null,
    };
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (!RETRY_POLICY_ALLOWED_KEYS.has(key)) {
      errors.push(`retry_policy contains unknown key "${key}".`);
    }
  }

  const patch = {};
  if (value.non_retryable_error_types !== undefined) {
    patch.non_retryable_error_types = validateRetryPolicyStringList(
      'non_retryable_error_types',
      value.non_retryable_error_types,
      errors
    );
  }
  if (value.non_retryable_status_codes !== undefined) {
    patch.non_retryable_status_codes = validateRetryPolicyStatusCodeList(
      'non_retryable_status_codes',
      value.non_retryable_status_codes,
      errors
    );
  }
  if (value.non_retryable_error_kinds !== undefined) {
    patch.non_retryable_error_kinds = validateRetryPolicyStringList(
      'non_retryable_error_kinds',
      value.non_retryable_error_kinds,
      errors
    );
  }
  if (value.retryable_error_kinds !== undefined) {
    patch.retryable_error_kinds = validateRetryPolicyStringList(
      'retryable_error_kinds',
      value.retryable_error_kinds,
      errors
    );
  }
  if (value.default_retryable !== undefined) {
    if (typeof value.default_retryable !== 'boolean') {
      errors.push('default_retryable must be a boolean.');
    } else {
      patch.default_retryable = value.default_retryable;
    }
  }

  if (Object.keys(patch).length === 0) {
    errors.push('retry_policy must include at least one supported field.');
  }

  return {
    errors,
    patch: errors.length > 0 ? null : patch,
  };
}

function validateRetentionInteger(fieldName, value, min, max, errors) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    errors.push(`${fieldName} must be an integer.`);
    return null;
  }
  if (parsed < min || parsed > max) {
    errors.push(`${fieldName} must be between ${min} and ${max}.`);
    return null;
  }
  return parsed;
}

function validateRetryPolicyApprovalRetentionPatch(value) {
  const errors = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {
      errors: ['retry_policy_approval_retention must be an object.'],
      patch: null,
    };
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (!RETRY_POLICY_APPROVAL_RETENTION_ALLOWED_KEYS.has(key)) {
      errors.push(`retry_policy_approval_retention contains unknown key "${key}".`);
    }
  }

  const patch = {};
  if (value.ticket_max_total !== undefined) {
    patch.ticket_max_total = validateRetentionInteger(
      'ticket_max_total',
      value.ticket_max_total,
      100,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT,
      errors
    );
  }
  if (value.event_max_total !== undefined) {
    patch.event_max_total = validateRetentionInteger(
      'event_max_total',
      value.event_max_total,
      100,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT,
      errors
    );
  }
  if (value.terminal_ticket_max_count !== undefined) {
    patch.terminal_ticket_max_count = validateRetentionInteger(
      'terminal_ticket_max_count',
      value.terminal_ticket_max_count,
      0,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_COUNT,
      errors
    );
  }
  if (value.terminal_ticket_max_age_ms !== undefined) {
    patch.terminal_ticket_max_age_ms = validateRetentionInteger(
      'terminal_ticket_max_age_ms',
      value.terminal_ticket_max_age_ms,
      0,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS,
      errors
    );
  }
  if (value.event_max_age_ms !== undefined) {
    patch.event_max_age_ms = validateRetentionInteger(
      'event_max_age_ms',
      value.event_max_age_ms,
      0,
      RETRY_POLICY_APPROVAL_RETENTION_MAX_AGE_MS,
      errors
    );
  }

  if (Object.keys(patch).length === 0) {
    errors.push('retry_policy_approval_retention must include at least one supported field.');
  }

  return {
    errors,
    patch: errors.length > 0 ? null : patch,
  };
}

module.exports = {
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
};
