'use strict';

/**
 * capabilityMatrix/index.js — the capability matrix (class + singleton).
 *
 * Single runtime entry point the loop seams consult instead of their old inline
 * `process.env.KHY_*` checks. Mirrors the API shape of services/gateway/
 * capabilityRegistry.js (class + singleton + env/file overrides) but for AGENT
 * capabilities rather than model adapters.
 *
 * Cut 1 responsibilities:
 *   - isEnabledAt(seam, capId, ctx): the drop-in replacement for each inline
 *     seam flag check. Resolves the descriptor's flag (via predicates) AND its
 *     preconditions. For wired seams the preconditions are a subset of the
 *     surrounding inline guards, so this is byte-identical to the old check.
 *   - composeRoute(input): build an inspectable route from descriptors.
 *   - selectPreset(modes): map request modes → named route preset.
 *   - meetsModelRequirements(descriptor, vector): capability-dimension match
 *     (inert in cut 1; default vector is all-max).
 *
 * Overrides (additive, never weakens byte-identity for wired flags unless the
 * operator explicitly sets one): KHY_CAPABILITY_MATRIX_JSON (inline JSON) and
 * ~/.khyquant/capability_matrix.json. Overrides may flip a descriptor's
 * `flag.default` or disable a capability; they cannot rename seams.
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const { DESCRIPTORS } = require('./descriptors');
const predicates = require('./predicates');
const { composeRoute, defaultRequirementsMatcher } = require('./composer');
const { selectPreset, getPreset } = require('./routePresets');

class CapabilityMatrix {
  /**
   * @param {object} [deps]
   * @param {object} [deps.env=process.env]
   * @param {Array}  [deps.descriptors]
   * @param {object} [deps.overrides] - { [id]: Partial<descriptor> } (DI for tests)
   */
  constructor(deps = {}) {
    this.env = deps.env || process.env;
    const base = deps.descriptors || DESCRIPTORS;
    const overrides = deps.overrides !== undefined ? deps.overrides : this._loadOverrides();
    this._byId = new Map();
    for (const d of base) {
      const merged = overrides && overrides[d.id] ? { ...d, ...overrides[d.id] } : d;
      this._byId.set(d.id, merged);
    }
  }

  getDescriptor(id) { return this._byId.get(id) || null; }
  getAll() { return [...this._byId.values()]; }
  bySeam(seam) { return this.getAll().filter((d) => d.seam === seam); }

  /**
   * Resolve a descriptor's enabled flag to the byte-identical boolean of its
   * original inline seam check. Does NOT evaluate preconditions.
   */
  resolveFlag(descriptor) {
    if (!descriptor) return false;
    return predicates.resolveFlag(descriptor.flag, {
      env: this.env,
      isEnabledFn: descriptor.isEnabledFn,
    });
  }

  /**
   * The drop-in seam check: enabled flag AND preconditions(ctx).
   * @param {string} seam
   * @param {string} capId
   * @param {object} [ctx]
   * @returns {boolean}
   */
  isEnabledAt(seam, capId, ctx = {}) {
    const d = this._byId.get(capId);
    if (!d) return false;
    // Guard against a descriptor/seam typo at the call site: the capability must
    // actually live at the seam it is being queried for.
    if (d.seam !== seam) return false;
    if (!this.resolveFlag(d)) return false;
    if (typeof d.preconditions === 'function') {
      try { if (!d.preconditions(ctx)) return false; } catch { return false; }
    }
    return true;
  }

  /** Capability-dimension match (inert in cut 1). */
  meetsModelRequirements(descriptor, vector) {
    if (!descriptor) return false;
    return defaultRequirementsMatcher(descriptor.requires || {}, vector || {});
  }

  selectPreset(modes) { return selectPreset(modes); }
  getPreset(id) { return getPreset(id); }

  /**
   * Build an inspectable route for a request. The flagResolver closes over this
   * matrix's env so the composer stays pure.
   */
  composeRoute({ signals = { modes: [] }, capabilityVector = null, budget = Infinity, ctx = {} } = {}) {
    const preset = this.selectPreset(signals.modes);
    return composeRoute({
      signals,
      capabilityVector,
      budget,
      ctx,
      descriptors: this.getAll(),
      preset,
      flagResolver: (d) => this.resolveFlag(d),
      requirementsMatcher: defaultRequirementsMatcher,
    });
  }

  _loadOverrides() {
    // Mirrors toolUseLoop.js _loadCapabilityPolicy override precedence:
    // inline env JSON wins over the home file; either may be absent.
    const out = {};
    const fileJson = this._readHomeOverrideFile();
    if (fileJson && typeof fileJson === 'object') Object.assign(out, fileJson);
    const inline = this.env.KHY_CAPABILITY_MATRIX_JSON;
    if (inline && String(inline).trim()) {
      try { Object.assign(out, JSON.parse(inline)); } catch { /* malformed inline override ignored */ }
    }
    return out;
  }

  _readHomeOverrideFile() {
    try {
      const p = path.join(os.homedir(), '.khyquant', 'capability_matrix.json');
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null; // unreadable/malformed override file is ignored, never fatal
    }
  }
}

// ── singleton ────────────────────────────────────────────────────────────────
let _singleton = null;

function getCapabilityMatrix() {
  if (!_singleton) _singleton = new CapabilityMatrix();
  return _singleton;
}

// DI factory for tests — never memoized.
function makeCapabilityMatrix(deps) {
  return new CapabilityMatrix(deps);
}

// Test/runtime hook to reset the memoized singleton (e.g. after env override).
function _resetCapabilityMatrix() { _singleton = null; }

module.exports = {
  CapabilityMatrix,
  getCapabilityMatrix,
  makeCapabilityMatrix,
  _resetCapabilityMatrix,
};
