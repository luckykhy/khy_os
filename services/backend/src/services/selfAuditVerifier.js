'use strict';

/**
 * selfAuditVerifier.js — runtime evidence verification for the khyos self-audit report.
 *
 * Division of labor (keeps the leaf contract intact):
 *   - selfAuditRegistry = pure data SSOT (zero IO, deterministic, never throws).
 *     It only DECLARES evidence anchors (evidenceAnchors: module basenames + env gates).
 *   - selfAuditVerifier (this module) = the IO verification layer. It CHECKS those
 *     anchors against the live filesystem/flag registry, so the AI can prove the
 *     self-audit report is grounded instead of circularly quoting static data.
 *
 * Contract: synchronous, read-only, never throws (any per-item failure → that item
 * verified:false + reason; whole call fail-soft). Session-level TTL cache (default
 * 300000ms, tunable via KHY_AUDIT_VERIFY_TTL_MS) so system-prompt rebuilds do not
 * re-stat the disk on every turn. Gate KHY_AUDIT_DYNAMIC_VERIFY (default ON, only
 * explicit 0/false/off/no turns it off — same semantics as KHY_SELF_AUDIT_AWARENESS,
 * flagRegistry-first with local CANON fallback); OFF → verifyAll returns null.
 *
 * @module services/selfAuditVerifier
 */

const fs = require('fs');
const path = require('path');

const _FALSY = new Set(['0', 'false', 'off', 'no']);
const _DEFAULT_TTL_MS = 300000;

/**
 * Gate check. flagRegistry-first (central priority + dogfood), local CANON
 * fallback when the registry is unavailable. Default ON, only 0/false/off/no OFF.
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_AUDIT_DYNAMIC_VERIFY', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e.KHY_AUDIT_DYNAMIC_VERIFY;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * Resolve the cache TTL in ms. flagRegistry numeric resolution first, local
 * parse fallback. Never throws; bad values → default.
 * @param {object} [env]
 * @returns {number}
 */
function _resolveTtlMs(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.resolveNumeric === 'function'
    ) {
      return reg.resolveNumeric('KHY_AUDIT_VERIFY_TTL_MS', e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const n = Number.parseInt(
    String(e.KHY_AUDIT_VERIFY_TTL_MS == null ? '' : e.KHY_AUDIT_VERIFY_TTL_MS).trim(),
    10
  );
  return Number.isFinite(n) && n >= 0 ? n : _DEFAULT_TTL_MS;
}

/**
 * Check whether an env gate flag is effectively ON. flagRegistry-first,
 * local CANON fallback (default ON, only explicit falsy word OFF).
 * @param {string} gate
 * @param {object} e
 * @returns {boolean}
 */
function _gateEnabled(gate, e) {
  try {
    const reg = require('./flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled(gate, e);
    }
  } catch {
    /* registry unavailable → local fallback */
  }
  const v = e[gate];
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * Verify one audit item's declared evidence anchors. Never throws.
 * @param {object} item  frozen item from selfAuditRegistry (may carry evidenceAnchors)
 * @param {object} e     env
 * @returns {{verified:boolean, checks:Array, reason:string}}
 */
function _verifyItem(item, e) {
  const checks = [];
  const failures = [];
  try {
    const anchors = item && item.evidenceAnchors;
    if (!anchors || typeof anchors !== 'object') {
      return { verified: false, checks, reason: '该项未声明证据锚点(evidenceAnchors 缺失)' };
    }
    // Module existence checks: anchor names are relative to this services/ dir
    // (may contain subpaths like 'commandCatalog/commandCatalog' or '../tools/x').
    const modules = Array.isArray(anchors.modules) ? anchors.modules : [];
    for (const name of modules) {
      let ok = false;
      let target = String(name);
      try {
        const abs = path.join(__dirname, String(name) + '.js');
        target = path.relative(path.join(__dirname, '..'), abs).replace(/\\/g, '/');
        ok = fs.existsSync(abs);
      } catch {
        ok = false;
      }
      checks.push({
        type: 'module',
        target,
        ok,
        detail: ok ? '缓解模块文件存在' : '缓解模块文件缺失',
      });
      if (!ok) {
        failures.push(`模块缺失:${target}`);
      }
    }
    // Gate checks: the declared env gates must currently resolve to ON.
    const gates = Array.isArray(anchors.gates) ? anchors.gates : [];
    for (const gate of gates) {
      let ok = false;
      try {
        ok = _gateEnabled(String(gate), e);
      } catch {
        ok = false;
      }
      checks.push({
        type: 'gate',
        target: String(gate),
        ok,
        detail: ok ? '门控当前为开' : '门控当前为关',
      });
      if (!ok) {
        failures.push(`门控为关:${gate}`);
      }
    }
    if (checks.length === 0) {
      return { verified: false, checks, reason: '证据锚点为空(无模块/门控可核验)' };
    }
    return failures.length === 0
      ? { verified: true, checks, reason: '全部证据锚点核验通过' }
      : { verified: false, checks, reason: failures.join(';') };
  } catch (err) {
    // Fail-soft: any unexpected error → honest verified:false, never throw.
    return {
      verified: false,
      checks,
      reason: `核验过程异常:${err && err.message ? err.message : String(err)}`,
    };
  }
}

// Session-level TTL cache: repeated system-prompt rebuilds within the TTL reuse
// the SAME object (including the same checkedAt) instead of re-statting disk.
let _cache = null; // { checkedAt, results }
let _cacheAtMs = 0;

/** Reset the TTL cache (test-only escape hatch). */
function _resetCache() {
  _cache = null;
  _cacheAtMs = 0;
}

/**
 * Verify all self-audit items against their declared evidence anchors.
 * @param {object} [opts]  {env}
 * @returns {{checkedAt:string, results:object}|null}  null when the gate is OFF
 *   or the registry is unresolvable. results: id → {verified, checks, reason}.
 */
function verifyAll(opts = {}) {
  try {
    const o = opts || {};
    const e = o.env || process.env || {};
    if (!isEnabled(e)) {
      return null;
    }

    const ttl = _resolveTtlMs(e);
    const now = Date.now();
    if (_cache && now - _cacheAtMs < ttl) {
      return _cache;
    }

    let items = [];
    try {
      const sar = require('./selfAuditRegistry');
      items = typeof sar.getSelfAuditItems === 'function' ? sar.getSelfAuditItems() : [];
    } catch {
      return null; /* no SSOT → honest null, not fabricated results */
    }
    if (!Array.isArray(items) || items.length === 0) {
      return null;
    }

    const results = {};
    for (const it of items) {
      if (!it || typeof it.id !== 'string') {
        continue;
      }
      results[it.id] = _verifyItem(it, e);
    }

    _cache = { checkedAt: new Date(now).toISOString(), results };
    _cacheAtMs = now;
    return _cache;
  } catch {
    return null; /* fail-soft: verification must never break callers */
  }
}

module.exports = {
  isEnabled,
  verifyAll,
  _resetCache,
};
