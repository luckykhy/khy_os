'use strict';

/**
 * Chat latency auto tuner.
 *
 * Uses rolling TTFT telemetry to dynamically adjust interactive gateway knobs:
 * - preflight budget
 * - adapter probe timeout
 * - rate-limit max wait
 * - activity pulse interval
 * - status dedup interval
 *
 * Tuning is conservative:
 * - requires minimum sample count
 * - clamps values within safe bounds
 * - applies at most once per interval unless profile changes
 */

const telemetry = require('./telemetryService');

const PROFILE_DEFAULT = 'default_chat';
const PROFILE_KHY = 'khy_chat_interactive';

const PROFILE_PRESETS = Object.freeze({
  aggressive: Object.freeze({
    KHY_PREFLIGHT_MAX_MS: 1200,
    KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: 700,
    KHY_PREFLIGHT_MAX_CANDIDATES: 1,
    GATEWAY_RATE_LIMIT_MAX_WAIT_MS: 1800,
    GATEWAY_ACTIVITY_PULSE_MS: 3000,
    GATEWAY_STATUS_DEDUP_MS: 500,
  }),
  balanced: Object.freeze({
    KHY_PREFLIGHT_MAX_MS: 1800,
    KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: 900,
    KHY_PREFLIGHT_MAX_CANDIDATES: 2,
    GATEWAY_RATE_LIMIT_MAX_WAIT_MS: 2500,
    GATEWAY_ACTIVITY_PULSE_MS: 4000,
    GATEWAY_STATUS_DEDUP_MS: 700,
  }),
  stable: Object.freeze({
    KHY_PREFLIGHT_MAX_MS: 2400,
    KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: 1200,
    KHY_PREFLIGHT_MAX_CANDIDATES: 2,
    GATEWAY_RATE_LIMIT_MAX_WAIT_MS: 3600,
    GATEWAY_ACTIVITY_PULSE_MS: 4200,
    GATEWAY_STATUS_DEDUP_MS: 850,
  }),
});

const PARAM_BOUNDS = Object.freeze({
  KHY_PREFLIGHT_MAX_MS: [900, 3200],
  KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: [600, 1800],
  KHY_PREFLIGHT_MAX_CANDIDATES: [1, 4],
  GATEWAY_RATE_LIMIT_MAX_WAIT_MS: [1200, 6000],
  GATEWAY_ACTIVITY_PULSE_MS: [2500, 12000],
  GATEWAY_STATUS_DEDUP_MS: [300, 2500],
});

const _runtimeState = {
  lastAppliedAt: 0,
  lastPreset: '',
  lastProfile: '',
  lastDecision: null,
};

function recordChatFirstTokenSample(entry = {}) {
  const profile = _resolveProfile(entry.profile);
  const summary = telemetry.trackChatFirstTokenLatency({
    profile,
    elapsedMs: entry.elapsedMs,
    success: entry.success !== false,
    hasFirstToken: entry.hasFirstToken !== false,
    adapter: entry.adapter || '',
    errorType: entry.errorType || '',
  });

  if (!_isAutoTuneEnabled(profile)) {
    return {
      profile,
      summary,
      tuned: false,
      reason: 'disabled',
      applied: null,
    };
  }

  const decision = _decidePreset(summary);
  const applyResult = _applyDecision(profile, decision, summary);
  return {
    profile,
    summary,
    tuned: applyResult.applied,
    reason: applyResult.reason,
    applied: applyResult.appliedConfig,
    preset: decision.preset,
  };
}

function getAutoTuneSnapshot(profile) {
  const resolvedProfile = _resolveProfile(profile);
  const summary = telemetry.getChatFirstTokenLatencySummary(resolvedProfile);
  return {
    profile: resolvedProfile,
    summary,
    lastAppliedAt: _runtimeState.lastAppliedAt || 0,
    lastPreset: _runtimeState.lastPreset || '',
    lastProfile: _runtimeState.lastProfile || '',
    lastDecision: _runtimeState.lastDecision || null,
    currentConfig: _readCurrentConfig(),
  };
}

function _resolveProfile(raw) {
  const value = String(raw || '').trim();
  if (value) return value;
  const runtimeIsKhy = String(process.env.KHY_RUNTIME_MODE || '').trim().toLowerCase() === 'khy';
  return runtimeIsKhy ? PROFILE_KHY : PROFILE_DEFAULT;
}

function _isAutoTuneEnabled(profile) {
  const explicit = String(process.env.KHY_CHAT_AUTOTUNE || '').trim().toLowerCase();
  if (explicit === 'false' || explicit === '0' || explicit === 'off' || explicit === 'no') return false;
  if (explicit === 'true' || explicit === '1' || explicit === 'on' || explicit === 'yes') return true;
  return profile === PROFILE_KHY;
}

function _asNumber(value, fallback) {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return n;
}

function _clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function _getMinSamples() {
  return Math.max(6, _asNumber(process.env.KHY_CHAT_AUTOTUNE_MIN_SAMPLES, 12));
}

function _getMinIntervalMs() {
  return Math.max(10000, _asNumber(process.env.KHY_CHAT_AUTOTUNE_MIN_INTERVAL_MS, 120000));
}

function _isAdaptiveFineTuneEnabled(profile) {
  const explicit = String(process.env.KHY_CHAT_AUTOTUNE_ADAPTIVE || '').trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(explicit)) return false;
  if (['true', '1', 'on', 'yes'].includes(explicit)) return true;
  return profile === PROFILE_KHY;
}

function _buildAdaptiveOverrides(profile, preset, summary) {
  if (!_isAdaptiveFineTuneEnabled(profile)) {
    return { delta: null, tag: '' };
  }
  const p50 = Math.max(0, Number(summary && summary.p50) || 0);
  const p95 = Math.max(0, Number(summary && summary.p95) || 0);
  const count = Math.max(1, Number(summary && summary.count) || 1);
  const failureRate = Math.max(0, Number(summary && summary.failureCount) || 0) / count;
  const noTokenRate = Math.max(0, Number(summary && summary.noFirstTokenCount) || 0) / count;

  if (
    preset === 'aggressive'
    && p50 <= 850
    && p95 <= 1600
    && failureRate <= 0.03
    && noTokenRate <= 0.03
  ) {
    return {
      delta: {
        KHY_PREFLIGHT_MAX_MS: -180,
        KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: -90,
        GATEWAY_RATE_LIMIT_MAX_WAIT_MS: -260,
      },
      tag: 'micro-fast',
    };
  }

  if (
    preset === 'balanced'
    && p50 <= 1200
    && p95 <= 2200
    && failureRate <= 0.05
    && noTokenRate <= 0.05
  ) {
    return {
      delta: {
        KHY_PREFLIGHT_MAX_MS: -140,
        KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: -70,
        GATEWAY_RATE_LIMIT_MAX_WAIT_MS: -220,
      },
      tag: 'balanced-fast',
    };
  }

  if (
    preset === 'balanced'
    && (p95 >= 5000 || failureRate >= 0.12 || noTokenRate >= 0.12)
  ) {
    return {
      delta: {
        KHY_PREFLIGHT_MAX_MS: 220,
        KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: 120,
        GATEWAY_RATE_LIMIT_MAX_WAIT_MS: 420,
      },
      tag: 'balanced-stability-boost',
    };
  }

  if (
    preset === 'stable'
    && count >= Math.max(12, _getMinSamples())
    && (p95 >= 16000 || failureRate >= 0.35 || noTokenRate >= 0.3)
  ) {
    return {
      delta: {
        KHY_PREFLIGHT_MAX_MS: 380,
        KHY_PREFLIGHT_ADAPTER_TIMEOUT_MS: 150,
        GATEWAY_RATE_LIMIT_MAX_WAIT_MS: 520,
        GATEWAY_ACTIVITY_PULSE_MS: 300,
        GATEWAY_STATUS_DEDUP_MS: 120,
      },
      tag: 'stable-guard',
    };
  }

  return { delta: null, tag: '' };
}

function _decidePreset(summary) {
  const count = Math.max(0, Number(summary && summary.count) || 0);
  const minSamples = _getMinSamples();
  if (count < minSamples) {
    return {
      preset: _runtimeState.lastPreset || 'balanced',
      ready: false,
      reason: `insufficient samples (${count}/${minSamples})`,
    };
  }

  const samples = Math.max(0, Number(summary && summary.sampleCount) || 0);
  const p50 = Math.max(0, Number(summary && summary.p50) || 0);
  const p95 = Math.max(0, Number(summary && summary.p95) || 0);
  const failureRate = count > 0 ? (Math.max(0, Number(summary.failureCount) || 0) / count) : 0;
  const noTokenRate = count > 0 ? (Math.max(0, Number(summary.noFirstTokenCount) || 0) / count) : 0;

  if (failureRate >= 0.22 || noTokenRate >= 0.2 || p95 >= 12000) {
    return { preset: 'stable', ready: true, reason: 'stability protection' };
  }
  if (samples < Math.max(4, Math.floor(minSamples * 0.5))) {
    return {
      preset: _runtimeState.lastPreset || 'balanced',
      ready: false,
      reason: `insufficient token samples (${samples}/${Math.max(4, Math.floor(minSamples * 0.5))})`,
    };
  }
  if (p50 <= 1400 && p95 <= 2600 && failureRate <= 0.08 && noTokenRate <= 0.08) {
    return { preset: 'aggressive', ready: true, reason: 'fast path available' };
  }
  return { preset: 'balanced', ready: true, reason: 'balanced latency/reliability' };
}

function _applyDecision(profile, decision, summary) {
  if (!decision || !decision.preset || !PROFILE_PRESETS[decision.preset]) {
    return { applied: false, reason: 'invalid decision', appliedConfig: null };
  }
  if (!decision.ready) {
    _runtimeState.lastDecision = {
      at: Date.now(),
      profile,
      preset: decision.preset,
      reason: decision.reason || 'not ready',
      count: summary && summary.count ? summary.count : 0,
      p50: summary && summary.p50 ? summary.p50 : 0,
      p95: summary && summary.p95 ? summary.p95 : 0,
    };
    return { applied: false, reason: decision.reason || 'not ready', appliedConfig: null };
  }

  const now = Date.now();
  const minIntervalMs = _getMinIntervalMs();
  const presetChanged = decision.preset !== _runtimeState.lastPreset || profile !== _runtimeState.lastProfile;
  if (!presetChanged && _runtimeState.lastAppliedAt > 0 && (now - _runtimeState.lastAppliedAt) < minIntervalMs) {
    return { applied: false, reason: 'interval guard', appliedConfig: null };
  }

  const rawPreset = PROFILE_PRESETS[decision.preset];
  const adaptive = _buildAdaptiveOverrides(profile, decision.preset, summary);
  const appliedConfig = {};
  for (const [key, value] of Object.entries(rawPreset)) {
    const delta = adaptive.delta && Number.isFinite(Number(adaptive.delta[key]))
      ? Number(adaptive.delta[key])
      : 0;
    const target = Number(value) + delta;
    const bounds = PARAM_BOUNDS[key];
    const min = Array.isArray(bounds) ? bounds[0] : value;
    const max = Array.isArray(bounds) ? bounds[1] : value;
    const clamped = _clamp(target, min, max);
    process.env[key] = String(clamped);
    appliedConfig[key] = clamped;
  }

  _runtimeState.lastAppliedAt = now;
  _runtimeState.lastPreset = decision.preset;
  _runtimeState.lastProfile = profile;
  _runtimeState.lastDecision = {
    at: now,
    profile,
    preset: decision.preset,
    reason: decision.reason || '',
    adaptiveTag: adaptive.tag || '',
    count: summary && summary.count ? summary.count : 0,
    p50: summary && summary.p50 ? summary.p50 : 0,
    p95: summary && summary.p95 ? summary.p95 : 0,
    failureCount: summary && summary.failureCount ? summary.failureCount : 0,
    noFirstTokenCount: summary && summary.noFirstTokenCount ? summary.noFirstTokenCount : 0,
  };

  return {
    applied: true,
    reason: adaptive.tag
      ? `${decision.reason || 'applied'} (${adaptive.tag})`
      : (decision.reason || 'applied'),
    appliedConfig,
  };
}

function _readCurrentConfig() {
  const out = {};
  for (const key of Object.keys(PARAM_BOUNDS)) {
    const [min, max] = PARAM_BOUNDS[key];
    out[key] = _clamp(_asNumber(process.env[key], PROFILE_PRESETS.balanced[key]), min, max);
  }
  return out;
}

function __resetForTest() {
  _runtimeState.lastAppliedAt = 0;
  _runtimeState.lastPreset = '';
  _runtimeState.lastProfile = '';
  _runtimeState.lastDecision = null;
}

module.exports = {
  PROFILE_DEFAULT,
  PROFILE_KHY,
  PROFILE_PRESETS,
  recordChatFirstTokenSample,
  getAutoTuneSnapshot,
  __resetForTest,
};
