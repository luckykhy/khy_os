/**
 * Pricing Service
 *
 * Group-based pricing for the AI gateway:
 *   - groups: { ratio, limits: { rpm, tpm } } — per-group cost multiplier + default limits
 *   - modelPricing: { "<model>": { input, output } } — CNY per 1M tokens, overrides defaults
 *
 * Base cost falls back to tokenUsageService.TOKEN_PRICING/calculateCost (USD→CNY);
 * modelPricing entries override the base. Final billed = baseCost × groupRatio.
 *
 * Persisted to ~/.khyquant/ai_gateway_pricing.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 数据家单一真源:复用主 backend 的 getAppHome()/getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppHome, getAppDataDir } = require('../utils/dataHome');
const KHY_DIR = getAppHome();
const PRICING_FILE = process.env.AI_GATEWAY_PRICING_FILE
  || getAppDataDir('ai_gateway_pricing.json');

let _tokenUsage = null;
function tokenUsage() {
  if (!_tokenUsage) _tokenUsage = require('./tokenUsageService');
  return _tokenUsage;
}

let _state = null;
let _loaded = false;

function defaultState() {
  return {
    version: 1,
    groups: {
      default: { ratio: 1, limits: { rpm: 0, tpm: 0 } },
    },
    modelPricing: {},
    updatedAt: new Date().toISOString(),
  };
}

// 收敛到 utils/ensureDirSync 单一真源(跨根委托,调用点不变)
const ensureDir = require('../../../backend/src/utils/ensureDirSync');

function ensureLoaded() {
  if (_loaded && _state) return;
  try {
    if (fs.existsSync(PRICING_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PRICING_FILE, 'utf-8'));
      _state = normalizeState(raw);
    } else {
      _state = defaultState();
    }
  } catch {
    _state = defaultState();
  }
  if (!_state.groups.default) _state.groups.default = { ratio: 1, limits: { rpm: 0, tpm: 0 } };
  _loaded = true;
}

function toNonNegNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function normalizeGroup(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const limits = src.limits && typeof src.limits === 'object' ? src.limits : {};
  return {
    ratio: toNonNegNumber(src.ratio, 1),
    limits: { rpm: toNonNegNumber(limits.rpm, 0), tpm: toNonNegNumber(limits.tpm, 0) },
  };
}

function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const groups = {};
  const groupsSrc = src.groups && typeof src.groups === 'object' ? src.groups : {};
  for (const [id, g] of Object.entries(groupsSrc)) {
    groups[String(id).toLowerCase()] = normalizeGroup(g);
  }
  if (!groups.default) groups.default = { ratio: 1, limits: { rpm: 0, tpm: 0 } };

  const modelPricing = {};
  const mpSrc = src.modelPricing && typeof src.modelPricing === 'object' ? src.modelPricing : {};
  for (const [model, p] of Object.entries(mpSrc)) {
    const ps = p && typeof p === 'object' ? p : {};
    modelPricing[String(model).toLowerCase()] = {
      input: toNonNegNumber(ps.input, 0),
      output: toNonNegNumber(ps.output, 0),
    };
  }

  return {
    version: 1,
    groups,
    modelPricing,
    updatedAt: src.updatedAt || new Date().toISOString(),
  };
}

function saveNow() {
  ensureLoaded();
  ensureDir(path.dirname(PRICING_FILE));
  _state.updatedAt = new Date().toISOString();
  fs.writeFileSync(PRICING_FILE, JSON.stringify(_state, null, 2), 'utf-8');
}

function getState() {
  ensureLoaded();
  return JSON.parse(JSON.stringify(_state));
}

function getGroupRatio(groupId) {
  ensureLoaded();
  const g = _state.groups[String(groupId || 'default').toLowerCase()] || _state.groups.default;
  return g ? g.ratio : 1;
}

function getGroupLimits(groupId) {
  ensureLoaded();
  const g = _state.groups[String(groupId || 'default').toLowerCase()] || _state.groups.default;
  return g ? { ...g.limits } : { rpm: 0, tpm: 0 };
}

/**
 * Compute cost for a request.
 * @returns {{ baseCostCny, billedCny, groupRatio, source }}
 */
function computeCost({ provider, model, input = 0, output = 0, groupId = 'default' }) {
  ensureLoaded();
  const ratio = getGroupRatio(groupId);
  const modelKey = String(model || '').toLowerCase();
  const override = _state.modelPricing[modelKey];

  let baseCostCny;
  let source;
  if (override) {
    // modelPricing is CNY per 1M tokens.
    baseCostCny = (input * override.input + output * override.output) / 1_000_000;
    source = 'modelPricing';
  } else {
    const { costCNY } = tokenUsage().calculateCost(provider || 'default', input, output);
    baseCostCny = costCNY;
    source = 'tokenPricing';
  }

  return {
    baseCostCny,
    billedCny: baseCostCny * ratio,
    groupRatio: ratio,
    source,
  };
}

/** Merge-update pricing config. */
function updatePricing(patch = {}) {
  ensureLoaded();
  if (patch.groups && typeof patch.groups === 'object') {
    for (const [id, g] of Object.entries(patch.groups)) {
      const key = String(id).toLowerCase();
      if (g === null) {
        if (key !== 'default') delete _state.groups[key]; // default is protected
        continue;
      }
      _state.groups[key] = normalizeGroup(g);
    }
    if (!_state.groups.default) _state.groups.default = { ratio: 1, limits: { rpm: 0, tpm: 0 } };
  }
  if (patch.modelPricing && typeof patch.modelPricing === 'object') {
    for (const [model, p] of Object.entries(patch.modelPricing)) {
      if (p === null) { delete _state.modelPricing[String(model).toLowerCase()]; continue; }
      const ps = p && typeof p === 'object' ? p : {};
      _state.modelPricing[String(model).toLowerCase()] = {
        input: toNonNegNumber(ps.input, 0),
        output: toNonNegNumber(ps.output, 0),
      };
    }
  }
  saveNow();
  return getState();
}

module.exports = {
  getState,
  getGroupRatio,
  getGroupLimits,
  computeCost,
  updatePricing,
  saveNow,
};
