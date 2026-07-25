'use strict';

/**
 * chainWasm.js — Node.js loader for MoonBit WASM chain primitives.
 *
 * Provides prompt template rendering, memory buffer management,
 * ReAct protocol parsing, and token estimation compiled to WASM-GC.
 *
 * Falls back to JS implementations if WASM is unavailable.
 */

const path = require('path');
const fs = require('fs');

// WASM binary built by `cd backend/wasm-chain && moon build --target wasm-gc`
const WASM_PATH = path.join(
  __dirname, '../../wasm-chain/_build/wasm-gc/debug/build/cmd/main/main.wasm'
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
  // Allow hot-swap to JS/external provider without changing call sites.
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
    throw new Error(`Chain WASM binary not found: ${WASM_PATH}`);
  }
  const buf = fs.readFileSync(WASM_PATH);
  const { instance } = await WebAssembly.instantiate(buf, {
    spectest: { print_char() {} },
  });

  if (!instance.exports.render_template) {
    throw new Error('Chain WASM loaded but exports not available');
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

// ── JS fallbacks ──────────────────────────────────────────────────

function _jsRenderTemplate(template, keys, values) {
  let result = template;
  const count = Math.min(keys.length, values.length);
  for (let i = 0; i < count; i++) {
    result = result.split(`{${keys[i]}}`).join(values[i]);
  }
  return result;
}

function _jsCountPlaceholders(template) {
  const matches = template.match(/\{[^{}]+\}/g);
  return matches ? matches.length : 0;
}

function _jsExtractPlaceholders(template) {
  const matches = template.match(/\{([^{}]+)\}/g);
  if (!matches) return [];
  return matches.map(m => m.slice(1, -1));
}

function _jsFormatHistory(inputs, outputs, maxTurns) {
  const total = Math.min(inputs.length, outputs.length);
  const start = (maxTurns > 0 && total > maxTurns) ? total - maxTurns : 0;
  const lines = [];
  for (let i = start; i < total; i++) {
    lines.push(`Human: ${inputs[i]}\nAI: ${outputs[i]}`);
  }
  return lines.join('\n');
}

function _jsEstimateHistoryTokens(inputs, outputs, maxTurns) {
  const total = Math.min(inputs.length, outputs.length);
  const start = (maxTurns > 0 && total > maxTurns) ? total - maxTurns : 0;
  let chars = 0;
  for (let i = start; i < total; i++) {
    chars += 7 + inputs[i].length + 5 + outputs[i].length + 1;
  }
  const raw = Math.ceil(chars / 4);
  return Math.ceil(raw * 1.2);
}

function _jsMaxTurnsForBudget(inputs, outputs, tokenBudget) {
  const total = Math.min(inputs.length, outputs.length);
  let turns = 0;
  let tokensUsed = 0;
  for (let i = total - 1; i >= 0; i--) {
    const turnChars = 7 + inputs[i].length + 5 + outputs[i].length + 1;
    const turnTokens = Math.ceil(Math.ceil(turnChars / 4) * 1.2);
    if (tokensUsed + turnTokens > tokenBudget) break;
    tokensUsed += turnTokens;
    turns++;
  }
  return turns;
}

function _jsParseReactResponse(response) {
  const finalIdx = response.indexOf('Final Answer:');
  if (finalIdx >= 0) {
    const answer = response.slice(finalIdx + 13).trim();
    return { type: 'final', answer };
  }

  const actionIdx = response.indexOf('Action:');
  const inputIdx = response.indexOf('Action Input:');

  if (actionIdx >= 0 && inputIdx >= 0) {
    const actionEnd = inputIdx > actionIdx + 7 ? inputIdx : response.length;
    const tool = response.slice(actionIdx + 7, actionEnd).trim();

    const inputStart = inputIdx + 13;
    const nlIdx = response.indexOf('\n', inputStart);
    const inputEnd = nlIdx >= 0 ? nlIdx : response.length;
    const toolInput = response.slice(inputStart, inputEnd).trim();

    return { type: 'action', tool, input: toolInput };
  }

  return { type: 'text', content: response };
}

function _jsValidateInput(input, maxLength) {
  if (!input || input.length === 0) return -2;
  if (maxLength > 0 && input.length > maxLength) return -1;
  return 0;
}

function _jsEstimateChainTokens(templateLen, inputLen, historyTokens) {
  const textTokens = Math.ceil(Math.ceil((templateLen + inputLen) / 4) * 1.2);
  return textTokens + historyTokens;
}

// ── Public API (WASM with JS fallback) ────────────────────────────

/**
 * Render a prompt template with variable substitution.
 * @param {string} template - template with {key} placeholders
 * @param {string[]} keys
 * @param {string[]} values
 * @returns {string}
 */
function renderTemplate(template, keys, values) {
  if (_preferExternal()) {
    const external = _tryExternal('renderTemplate', [template, keys, values]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.render_template) {
    try {
      return _instance.exports.render_template(template, keys, values);
    } catch { /* fallback */ }
  }
  return _jsRenderTemplate(template, keys, values);
}

/**
 * Count placeholders in a template.
 * @param {string} template
 * @returns {number}
 */
function countPlaceholders(template) {
  if (_preferExternal()) {
    const external = _tryExternal('countPlaceholders', [template]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.count_placeholders) {
    try {
      return _instance.exports.count_placeholders(template);
    } catch { /* fallback */ }
  }
  return _jsCountPlaceholders(template);
}

/**
 * Extract placeholder names from a template.
 * @param {string} template
 * @returns {string[]}
 */
function extractPlaceholders(template) {
  if (_preferExternal()) {
    const external = _tryExternal('extractPlaceholders', [template]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.extract_placeholders) {
    try {
      const json = _instance.exports.extract_placeholders(template);
      return JSON.parse(json);
    } catch { /* fallback */ }
  }
  return _jsExtractPlaceholders(template);
}

/**
 * Format conversation history into prompt-friendly string.
 * @param {string[]} inputs
 * @param {string[]} outputs
 * @param {number} maxTurns
 * @returns {string}
 */
function formatHistory(inputs, outputs, maxTurns) {
  if (_preferExternal()) {
    const external = _tryExternal('formatHistory', [inputs, outputs, maxTurns]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.format_history) {
    try {
      return _instance.exports.format_history(inputs, outputs, maxTurns);
    } catch { /* fallback */ }
  }
  return _jsFormatHistory(inputs, outputs, maxTurns);
}

/**
 * Estimate token count for a history buffer.
 * @param {string[]} inputs
 * @param {string[]} outputs
 * @param {number} maxTurns
 * @returns {number}
 */
function estimateHistoryTokens(inputs, outputs, maxTurns) {
  if (_preferExternal()) {
    const external = _tryExternal('estimateHistoryTokens', [inputs, outputs, maxTurns]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.estimate_history_tokens) {
    try {
      return _instance.exports.estimate_history_tokens(inputs, outputs, maxTurns);
    } catch { /* fallback */ }
  }
  return _jsEstimateHistoryTokens(inputs, outputs, maxTurns);
}

/**
 * Calculate maximum turns that fit within a token budget.
 * @param {string[]} inputs
 * @param {string[]} outputs
 * @param {number} tokenBudget
 * @returns {number}
 */
function maxTurnsForBudget(inputs, outputs, tokenBudget) {
  if (_preferExternal()) {
    const external = _tryExternal('maxTurnsForBudget', [inputs, outputs, tokenBudget]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.max_turns_for_budget) {
    try {
      return _instance.exports.max_turns_for_budget(inputs, outputs, tokenBudget);
    } catch { /* fallback */ }
  }
  return _jsMaxTurnsForBudget(inputs, outputs, tokenBudget);
}

/**
 * Parse a ReAct-style LLM response.
 * @param {string} response
 * @returns {{ type: 'final'|'action'|'text', answer?: string, tool?: string, input?: string, content?: string }}
 */
function parseReactResponse(response) {
  if (_preferExternal()) {
    const external = _tryExternal('parseReactResponse', [response]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.parse_react_response) {
    try {
      const json = _instance.exports.parse_react_response(response);
      return JSON.parse(json);
    } catch { /* fallback */ }
  }
  return _jsParseReactResponse(response);
}

/**
 * Validate chain input.
 * @param {string} input
 * @param {number} maxLength - 0 = no limit
 * @returns {number} 0 = valid, -1 = too long, -2 = empty
 */
function validateInput(input, maxLength) {
  if (_preferExternal()) {
    const external = _tryExternal('validateInput', [input, maxLength]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.validate_input) {
    try {
      return _instance.exports.validate_input(input, maxLength);
    } catch { /* fallback */ }
  }
  return _jsValidateInput(input, maxLength);
}

/**
 * Estimate total prompt tokens for a chain call.
 * @param {number} templateLen
 * @param {number} inputLen
 * @param {number} historyTokens
 * @returns {number}
 */
function estimateChainTokens(templateLen, inputLen, historyTokens) {
  if (_preferExternal()) {
    const external = _tryExternal('estimateChainTokens', [templateLen, inputLen, historyTokens]);
    if (external.hit) return external.value;
  }
  if (_instance?.exports?.estimate_chain_tokens) {
    try {
      return _instance.exports.estimate_chain_tokens(templateLen, inputLen, historyTokens);
    } catch { /* fallback */ }
  }
  return _jsEstimateChainTokens(templateLen, inputLen, historyTokens);
}

/**
 * Check if WASM is loaded and available.
 * @returns {boolean}
 */
function isWasmAvailable() {
  return _instance !== null;
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
  isWasmAvailable,
  getRuntimeInfo,
  renderTemplate,
  countPlaceholders,
  extractPlaceholders,
  formatHistory,
  estimateHistoryTokens,
  maxTurnsForBudget,
  parseReactResponse,
  validateInput,
  estimateChainTokens,
};
