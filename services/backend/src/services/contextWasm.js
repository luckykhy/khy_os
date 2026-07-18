'use strict';

/**
 * contextWasm.js — Node.js loader for MoonBit WASM context utilities.
 *
 * Provides token estimation, FNV-1a hashing, and text truncation
 * compiled to WASM-GC for hot-path performance.
 *
 * Falls back to JS implementations if WASM is unavailable.
 */

const path = require('path');
const fs = require('fs');

// WASM binary built by `moon build --target wasm-gc`
const WASM_PATH = path.join(
  __dirname, '../../wasm-context/_build/wasm-gc/debug/build/cmd/main/main.wasm'
);
const MOONBIT_ENGINE = String(process.env.KHY_MOONBIT_ENGINE || 'auto').trim().toLowerCase();
const EXTERNAL_PROVIDER_MODULE = String(process.env.KHY_MOONBIT_PROVIDER_MODULE || '').trim();

let _instance = null;
let _loadError = null;
let _loading = null;
let _externalProvider = null;
let _externalProviderLoadError = null;
let _externalProviderLoadTried = false;

function _shouldTryWasm() {
  return MOONBIT_ENGINE !== 'js' && MOONBIT_ENGINE !== 'external';
}

function _loadExternalProvider() {
  if (_externalProviderLoadTried) return _externalProvider;
  _externalProviderLoadTried = true;
  if (!EXTERNAL_PROVIDER_MODULE) return null;
  try {
    const resolved = path.isAbsolute(EXTERNAL_PROVIDER_MODULE)
      ? EXTERNAL_PROVIDER_MODULE
      : path.resolve(process.cwd(), EXTERNAL_PROVIDER_MODULE);
    // eslint-disable-next-line import/no-dynamic-require, global-require
    _externalProvider = require(resolved);
    _externalProviderLoadError = null;
    return _externalProvider;
  } catch (err) {
    _externalProvider = null;
    _externalProviderLoadError = err;
    return null;
  }
}

function _tryExternal(methodName, args = []) {
  const provider = _loadExternalProvider();
  if (!provider || typeof provider[methodName] !== 'function') {
    return { hit: false, value: null };
  }
  try {
    return { hit: true, value: provider[methodName](...args) };
  } catch {
    return { hit: false, value: null };
  }
}

function _preferExternal() {
  return MOONBIT_ENGINE === 'external' || (MOONBIT_ENGINE === 'auto' && !!EXTERNAL_PROVIDER_MODULE);
}

async function _loadWasm() {
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(`WASM binary not found: ${WASM_PATH}`);
  }
  const buf = fs.readFileSync(WASM_PATH);
  // MoonBit wasm-gc modules require spectest.print_char import
  const { instance } = await WebAssembly.instantiate(buf, {
    spectest: { print_char() {} },
  });

  // Verify that exported functions are accessible
  // (MoonBit wasm-gc binary emitter may not emit exports; see WAT for reference)
  if (!instance.exports.estimate_tokens) {
    throw new Error('WASM module loaded but exports not available (moonc binary emitter limitation)');
  }
  return instance;
}

async function getInstance() {
  if (!_shouldTryWasm()) return null;
  if (_instance) return _instance;
  if (_loadError) return null;
  if (_loading) return _loading;

  _loading = _loadWasm()
    .then(inst => {
      _instance = inst;
      _loading = null;
      return inst;
    })
    .catch(err => {
      _loadError = err;
      _loading = null;
      return null;
    });

  return _loading;
}

// ── JS fallbacks ──

function _jsEstimateTokens(text) {
  if (!text) return 0;
  const len = String(text).length;
  const raw = Math.ceil(len / 4);
  return Math.ceil(raw * 1.2);
}

function _jsFnv1aHash(str) {
  // 32-bit FNV-1a (JS doesn't have native 64-bit int)
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

function _jsTruncateText(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return { text: s, omitted: 0 };

  // Find last newline before maxChars for clean cut
  let cutPos = maxChars;
  const lastNewline = s.lastIndexOf('\n', maxChars);
  if (lastNewline > maxChars * 0.5) {
    cutPos = lastNewline;
  }
  return {
    text: s.slice(0, cutPos),
    omitted: s.length - cutPos,
  };
}

// ── Public API (WASM with JS fallback) ──

/**
 * Estimate token count from text with 1.2x safety margin.
 * @param {string} text
 * @returns {number}
 */
function estimateTokens(text) {
  if (_preferExternal()) {
    const external = _tryExternal('estimateTokens', [text]);
    if (external.hit) return external.value;
  }
  // WASM instance may export the function directly
  if (_instance?.exports?.estimate_tokens) {
    try {
      return _instance.exports.estimate_tokens(String(text || '').length);
    } catch { /* fallback */ }
  }
  return _jsEstimateTokens(text);
}

/**
 * FNV-1a hash for stable dedup keys.
 * @param {string} str
 * @returns {string} hex hash
 */
function fnv1aHash(str) {
  if (_preferExternal()) {
    const external = _tryExternal('fnv1aHash', [str]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.fnv1a_hash) {
    try {
      const buf = Buffer.from(String(str), 'utf-8');
      // WASM expects Bytes — pass length and data pointer
      // For simplicity, use JS 32-bit FNV-1a which is fast enough
      // The WASM 64-bit version is used when GC-managed strings are supported
    } catch { /* fallback */ }
  }
  return _jsFnv1aHash(str);
}

/**
 * Truncate text at a clean boundary (newline-aware).
 * @param {string} text
 * @param {number} maxChars
 * @returns {{ text: string, omitted: number }}
 */
function truncateText(text, maxChars) {
  if (_preferExternal()) {
    const external = _tryExternal('truncateText', [text, maxChars]);
    if (external.hit) return external.value;
  }
  return _jsTruncateText(text, maxChars);
}

/**
 * Check if total tokens exceed budget with safety margin.
 * @param {number} totalTokens
 * @param {number} budget
 * @returns {number} overflow (positive = over budget)
 */
function checkOverflow(totalTokens, budget) {
  if (_preferExternal()) {
    const external = _tryExternal('checkOverflow', [totalTokens, budget]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.check_overflow) {
    try {
      return _instance.exports.check_overflow(totalTokens, budget, 12);
    } catch { /* fallback */ }
  }
  return Math.ceil(totalTokens * 1.2) - budget;
}

/**
 * Single tool result token cap (50% of budget).
 * @param {number} contextBudget
 * @returns {number}
 */
function singleToolResultCap(contextBudget) {
  if (_preferExternal()) {
    const external = _tryExternal('singleToolResultCap', [contextBudget]);
    if (external.hit) return external.value;
  }
  return Math.floor(contextBudget / 2);
}

/**
 * Preemptive overflow threshold (90% of budget).
 * @param {number} contextBudget
 * @returns {number}
 */
function preemptiveThreshold(contextBudget) {
  if (_preferExternal()) {
    const external = _tryExternal('preemptiveThreshold', [contextBudget]);
    if (external.hit) return external.value;
  }
  return Math.floor(contextBudget * 0.9);
}

function getRuntimeInfo() {
  return {
    engine: MOONBIT_ENGINE,
    wasmPath: WASM_PATH,
    wasmLoaded: !!_instance,
    wasmLoadError: _loadError ? String(_loadError.message || _loadError) : '',
    externalProviderModule: EXTERNAL_PROVIDER_MODULE || '',
    externalProviderLoaded: !!_externalProvider,
    externalProviderLoadError: _externalProviderLoadError ? String(_externalProviderLoadError.message || _externalProviderLoadError) : '',
  };
}

// Eagerly attempt to load WASM (non-blocking)
if (_shouldTryWasm()) {
  getInstance().catch(() => {});
}

module.exports = {
  getInstance,
  getRuntimeInfo,
  estimateTokens,
  fnv1aHash,
  truncateText,
  checkOverflow,
  singleToolResultCap,
  preemptiveThreshold,
};
