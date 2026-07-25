'use strict';

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');

function compactText(value, maxLen = 320) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen - 1)}…` : text;
}

function inferCategory(payload = {}) {
  const explicit = String(payload.category || '').trim().toLowerCase();
  if (explicit) return explicit;

  const trigger = String(payload.trigger || '').trim().toLowerCase();
  if (!trigger) return payload.healed ? 'recovery' : '';
  if (payload.healed) return 'recovery';
  if (
    trigger.includes('first_response_timeout')
    || trigger.includes('handshake_timeout')
    || trigger.includes('idle_timeout')
    || trigger.includes('stall')
  ) {
    return 'stall';
  }
  if (trigger.includes('reconnect') || trigger.includes('bridge_canceled') || trigger.includes('bridge_no_stream')) {
    return 'transport';
  }
  if (trigger.includes('fallback') || trigger.includes('recovered') || trigger.includes('self_heal')) {
    return 'recovery';
  }
  return '';
}

function createAdapterRuntimeDiagnosticsStore(adapterKey = '') {
  const normalizedAdapterKey = String(adapterKey || '').trim().toLowerCase() || 'unknown';

  // In-memory merge cache ([MGMT-RPT-020] REQ-2026-004). The previous
  // read-modify-write did a sync readFileSync + JSON.parse on EVERY diagnostic
  // event (gateway error/stall hot path). We keep the last-persisted state in
  // memory so the per-event merge in writeDiagnostic no longer hits disk; this
  // instance owns its file, so its own writes keep the cache authoritative.
  //
  // The cache is NOT consulted by the public readState(): on-demand reads (used
  // for display, and by gatewayAdapters.stability.test.js after an out-of-band
  // file write) must reflect disk truth, including external/cross-process
  // writes. Writes stay synchronous because a freshly required adapter must read
  // the just-persisted diagnostics off disk with no flush step.
  let _cachedState = null;

  function createEmptyDiagnostic() {
    return {
      adapterKey: normalizedAdapterKey,
      at: 0,
      requestId: '',
      healed: false,
      diagnosis: '',
      lastError: '',
      trigger: '',
      category: '',
      phase: '',
      summary: '',
    };
  }

  function normalizeDiagnostic(payload = {}, fallbackTrigger = '') {
    const at = Number(payload?.at || 0);
    const normalizedTrigger = String(payload?.trigger || fallbackTrigger || '').trim();
    return {
      adapterKey: normalizedAdapterKey,
      at: Number.isFinite(at) && at > 0 ? at : 0,
      requestId: compactText(payload?.requestId || '', 96),
      healed: !!payload?.healed,
      diagnosis: compactText(payload?.diagnosis || '', 640),
      lastError: compactText(payload?.lastError || '', 640),
      trigger: normalizedTrigger,
      category: inferCategory({ ...payload, trigger: normalizedTrigger }),
      phase: compactText(payload?.phase || '', 80),
      summary: compactText(payload?.summary || '', 240),
    };
  }

  function createEmptyState() {
    return {
      adapterKey: normalizedAdapterKey,
      latest: createEmptyDiagnostic(),
      latestByTrigger: {},
      latestByCategory: {},
    };
  }

  function normalizeState(payload = null) {
    const emptyState = createEmptyState();
    if (!payload || typeof payload !== 'object') return emptyState;

    if (payload.latest || payload.latestByTrigger || payload.latestByCategory) {
      const latestByTrigger = {};
      for (const [key, value] of Object.entries(payload.latestByTrigger || {})) {
        const normalized = normalizeDiagnostic(value);
        if (normalized.at > 0) latestByTrigger[String(key).trim().toLowerCase()] = normalized;
      }
      const latestByCategory = {};
      for (const [key, value] of Object.entries(payload.latestByCategory || {})) {
        const normalized = normalizeDiagnostic(value);
        if (normalized.at > 0) latestByCategory[String(key).trim().toLowerCase()] = normalized;
      }
      return {
        adapterKey: normalizedAdapterKey,
        latest: normalizeDiagnostic(payload.latest),
        latestByTrigger,
        latestByCategory,
      };
    }

    const legacyLatest = normalizeDiagnostic(payload);
    const legacyState = {
      adapterKey: normalizedAdapterKey,
      latest: legacyLatest,
      latestByTrigger: {},
      latestByCategory: {},
    };
    if (legacyLatest.at > 0 && legacyLatest.trigger) {
      legacyState.latestByTrigger[legacyLatest.trigger.toLowerCase()] = legacyLatest;
    }
    if (legacyLatest.at > 0 && legacyLatest.category) {
      legacyState.latestByCategory[legacyLatest.category.toLowerCase()] = legacyLatest;
    }
    if (payload.lastFirstResponseTimeout) {
      const stall = normalizeDiagnostic(payload.lastFirstResponseTimeout);
      if (stall.at > 0) {
        legacyState.latestByTrigger.first_response_timeout = stall;
        if (stall.category) legacyState.latestByCategory[stall.category.toLowerCase()] = stall;
      }
    }
    return legacyState;
  }

  function getFile() {
    return path.join(getDataDir('gateway'), `${normalizedAdapterKey}_runtime_diagnostics.json`);
  }

  function writeState(payload = null) {
    const normalizedState = normalizeState(payload);
    _cachedState = normalizedState;
    try {
      fs.writeFileSync(getFile(), `${JSON.stringify(normalizedState, null, 2)}\n`, 'utf-8');
    } catch { /* best effort */ }
  }

  function readState() {
    let state;
    try {
      const raw = JSON.parse(fs.readFileSync(getFile(), 'utf-8'));
      state = normalizeState(raw);
    } catch {
      state = createEmptyState();
    }
    _cachedState = state;
    return state;
  }

  // Merge base for the per-event hot path. Uses the in-memory cache when warm so
  // writeDiagnostic does not read disk on every event; cold path seeds from disk.
  function readMergeBase() {
    if (_cachedState) return _cachedState;
    return readState();
  }

  function clear() {
    _cachedState = null;
    try { fs.unlinkSync(getFile()); } catch { /* ignore */ }
  }

  function writeDiagnostic(payload = null) {
    const diagnostic = normalizeDiagnostic(payload || createEmptyDiagnostic());
    const state = readMergeBase();
    const nextState = {
      adapterKey: normalizedAdapterKey,
      latest: diagnostic,
      latestByTrigger: { ...(state.latestByTrigger || {}) },
      latestByCategory: { ...(state.latestByCategory || {}) },
    };
    if (diagnostic.at > 0 && diagnostic.trigger) {
      nextState.latestByTrigger[diagnostic.trigger.toLowerCase()] = diagnostic;
    }
    if (diagnostic.at > 0 && diagnostic.category) {
      nextState.latestByCategory[diagnostic.category.toLowerCase()] = diagnostic;
    }
    writeState(nextState);
  }

  function readDiagnostic(options = {}) {
    const state = readState();
    const preferTrigger = String(options?.preferTrigger || '').trim().toLowerCase();
    if (preferTrigger) {
      return normalizeDiagnostic(state.latestByTrigger?.[preferTrigger]);
    }
    const preferCategory = String(options?.preferCategory || '').trim().toLowerCase();
    if (preferCategory) {
      return normalizeDiagnostic(state.latestByCategory?.[preferCategory]);
    }
    return normalizeDiagnostic(state.latest);
  }

  function record(currentDiagnostic, payload = {}, options = {}) {
    const diagnostic = normalizeDiagnostic({
      ...payload,
      at: Date.now(),
    }, options?.fallbackTrigger || 'unknown');
    if (options?.persist !== false) writeDiagnostic(diagnostic);
    return diagnostic;
  }

  function get(currentDiagnostic, options = {}) {
    const current = normalizeDiagnostic(currentDiagnostic);
    if (options?.includePersisted !== true) return current;

    const preferTrigger = String(options?.preferTrigger || '').trim().toLowerCase();
    if (preferTrigger) {
      const currentPreferred = current.trigger.toLowerCase() === preferTrigger ? current : createEmptyDiagnostic();
      const persistedPreferred = readDiagnostic({ preferTrigger });
      return Number(persistedPreferred.at || 0) > Number(currentPreferred.at || 0)
        ? persistedPreferred
        : currentPreferred;
    }

    const preferCategory = String(options?.preferCategory || '').trim().toLowerCase();
    if (preferCategory) {
      const currentPreferred = current.category.toLowerCase() === preferCategory ? current : createEmptyDiagnostic();
      const persistedPreferred = readDiagnostic({ preferCategory });
      return Number(persistedPreferred.at || 0) > Number(currentPreferred.at || 0)
        ? persistedPreferred
        : currentPreferred;
    }

    const persisted = readDiagnostic();
    return Number(persisted.at || 0) > Number(current.at || 0)
      ? persisted
      : current;
  }

  return {
    adapterKey: normalizedAdapterKey,
    compactText,
    createEmptyDiagnostic,
    normalizeDiagnostic,
    createEmptyState,
    normalizeState,
    getFile,
    writeState,
    readState,
    clear,
    writeDiagnostic,
    readDiagnostic,
    record,
    get,
  };
}

module.exports = {
  createAdapterRuntimeDiagnosticsStore,
};
