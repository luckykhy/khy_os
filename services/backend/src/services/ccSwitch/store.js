'use strict';

/**
 * ccSwitch store — CC-Switch-style provider-card registry.
 *
 * Owns the persistent card model at <dataHome>/cc_switch.json:
 *   {
 *     "schemaVersion": 1,
 *     "cards": [
 *       {
 *         "id": "c_<hex>",
 *         "name": "DeepSeek",
 *         "baseUrl": "https://api.deepseek.com/v1",
 *         "keyId": "pool-key-id",            // reference into apiKeyPool's api_keys.json
 *         "protocol": "openai",               // see constants.PROTOCOLS
 *         "wireApi": "chat" | "responses",    // Codex-only nuance (openai_responses)
 *         "models": ["deepseek-chat"],
 *         "defaultModel": "deepseek-chat",
 *         "apps": ["claude-code", "opencode"],  // which apps this card may serve
 *         "enabled": true,
 *         "requiresOpenaiAuth": false,        // Codex OAuth fallback flags
 *         "createdAt": "…", "updatedAt": "…"
 *       }
 *     ],
 *     "active": { "claude-code": "c_abc", "codex": "c_def" },   // app → cardId
 *     "apps": { "claude-code": { "scanEnabled": true } }
 *   }
 *
 * Key material is NOT stored here: cards reference apiKeyPool entries by keyId
 * (the pool persists them in gitignored api_keys.json). The store stays
 * credential-free so it can be safely included in backups and exported.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');
const atomicWriteJson = require('../../utils/atomicWriteJson');
const { atomicWriteText } = require('../../utils/atomicWriteJson');
const { safeReadJsonSync } = require('../configGuard');
const { PROTOCOLS, APPS, DATA_FILE, SCHEMA_VERSION } = require('./constants');

const apiKeyPool = require('../apiKeyPool');

const DATA_DIR = getDataHome();
const STORE_FILE = path.join(DATA_DIR, DATA_FILE);
const LEGACY_STORE_FILE = path.join(getLegacyDataHome(), DATA_FILE);

let _cache = null;

// ── Legacy migration (same shape as customProviderRegistry) ────────────────
function _migrateLegacy() {
  try {
    if (
      STORE_FILE !== LEGACY_STORE_FILE &&
      !fs.existsSync(STORE_FILE) &&
      fs.existsSync(LEGACY_STORE_FILE)
    ) {
      const legacy = fs.readFileSync(LEGACY_STORE_FILE, 'utf-8');
      fs.mkdirSync(DATA_DIR, { recursive: true });
      atomicWriteText(STORE_FILE, legacy, { mode: 0o600 });
    }
  } catch {
    /* migration is best-effort */
  }
}

// ── Loading / saving ───────────────────────────────────────────────────────
function _defaultDoc() {
  return { schemaVersion: SCHEMA_VERSION, cards: [], active: {}, apps: {} };
}

function _load() {
  if (_cache) {
    return _cache;
  }
  _migrateLegacy();
  const { data } = safeReadJsonSync(STORE_FILE, { schema: _defaultDoc() });
  _cache = _normalizeDoc(data);
  return _cache;
}

function _save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    atomicWriteJson(STORE_FILE, _cache, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

// ── Normalization / validation ─────────────────────────────────────────────
function _normalizeDoc(doc) {
  if (!doc || typeof doc !== 'object') {
    return _defaultDoc();
  }
  return {
    schemaVersion: Number(doc.schemaVersion) || SCHEMA_VERSION,
    cards: Array.isArray(doc.cards) ? doc.cards.map(_normalizeCard).filter(Boolean) : [],
    active: _normalizeActive(doc.active),
    apps: _normalizeApps(doc.apps),
  };
}

function _normalizeCard(card) {
  if (!card || typeof card !== 'object' || !card.name) {
    return null;
  }
  const protocol = Object.values(PROTOCOLS).includes(card.protocol)
    ? card.protocol
    : PROTOCOLS.OPENAI;
  return {
    id: typeof card.id === 'string' && card.id ? card.id : _genId(),
    name: String(card.name).trim(),
    baseUrl: typeof card.baseUrl === 'string' ? card.baseUrl : '',
    keyId: typeof card.keyId === 'string' ? card.keyId : '',
    protocol,
    wireApi:
      protocol === PROTOCOLS.RESPONSES
        ? card.wireApi === 'chat'
          ? 'chat'
          : 'responses'
        : card.wireApi === 'responses'
          ? 'responses'
          : 'chat',
    models: Array.isArray(card.models) ? card.models.filter((m) => typeof m === 'string' && m) : [],
    defaultModel:
      typeof card.defaultModel === 'string' && card.defaultModel
        ? card.defaultModel
        : Array.isArray(card.models) && card.models.length
          ? card.models[0]
          : '',
    apps: Array.isArray(card.apps)
      ? card.apps.filter((a) => Object.values(APPS).includes(a))
      : Object.values(APPS).slice(),
    enabled: card.enabled !== false,
    requiresOpenaiAuth: card.requiresOpenaiAuth === true,
    createdAt: typeof card.createdAt === 'string' ? card.createdAt : new Date().toISOString(),
    updatedAt: typeof card.updatedAt === 'string' ? card.updatedAt : new Date().toISOString(),
  };
}

function _normalizeActive(active) {
  if (!active || typeof active !== 'object') {
    return {};
  }
  const out = {};
  for (const [app, cardId] of Object.entries(active)) {
    if (Object.values(APPS).includes(app) && typeof cardId === 'string' && cardId) {
      out[app] = cardId;
    }
  }
  return out;
}

function _normalizeApps(apps) {
  if (!apps || typeof apps !== 'object') {
    return {};
  }
  const out = {};
  for (const [app, cfg] of Object.entries(apps)) {
    if (!Object.values(APPS).includes(app) || !cfg || typeof cfg !== 'object') {
      continue;
    }
    out[app] = {
      scanEnabled: cfg.scanEnabled !== false,
    };
  }
  return out;
}

function _genId() {
  return `c_${crypto.randomBytes(8).toString('hex')}`;
}

// ── Card CRUD ──────────────────────────────────────────────────────────────
/**
 * Create a card. `key` (raw API key) is forwarded to apiKeyPool under a
 * dedicated provider namespace; only the returned keyId is stored in the card.
 *
 * @param {object} input normalized card fields
 * @returns {{ success: boolean, card?: object, error?: string }}
 */
function addCard(input = {}) {
  try {
    const { key, ...rest } = input;
    let card = _normalizeCard({ ...rest, id: _genId() });
    if (!card || !card.name) {
      return { success: false, error: '卡片名称是必填项' };
    }
    if (!card.baseUrl) {
      return { success: false, error: '卡片 baseUrl 是必填项' };
    }
    if (key) {
      const keyId = apiKeyPool.addKey(_poolProvider(card.id), {
        key: String(key),
        label: `cc-switch:${card.name}`,
        endpoint: card.baseUrl,
      });
      card.keyId = keyId;
    }
    card.updatedAt = new Date().toISOString();
    const doc = _load();
    doc.cards.push(card);
    _save();
    return { success: true, card };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
}

function listCards() {
  return _load().cards.slice();
}

function getCard(cardId) {
  return _load().cards.find((c) => c.id === cardId) || null;
}

/**
 * Update a card. `key` re-registers the API key (old key entry removed);
 * omitted key keeps the existing keyId.
 */
function updateCard(cardId, patch = {}) {
  try {
    const doc = _load();
    const idx = doc.cards.findIndex((c) => c.id === cardId);
    if (idx === -1) {
      return { success: false, error: `卡片不存在: ${cardId}` };
    }
    const prev = doc.cards[idx];
    const { key, ...rest } = patch;
    const merged = _normalizeCard({
      ...prev,
      ...rest,
      id: cardId,
      name: rest.name || prev.name,
    });
    if (!merged) {
      return { success: false, error: '卡片数据无效' };
    }
    if (key) {
      // Re-key: park the old key under a temporary namespace then drop it.
      if (prev.keyId) {
        try {
          apiKeyPool.removeKey(_poolProvider(cardId), prev.keyId);
        } catch {
          /* stale keyId is fine */
        }
      }
      merged.keyId = apiKeyPool.addKey(_poolProvider(cardId), {
        key: String(key),
        label: `cc-switch:${merged.name}`,
        endpoint: merged.baseUrl,
      });
    }
    merged.updatedAt = new Date().toISOString();
    doc.cards[idx] = merged;
    _save();
    return { success: true, card: merged };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
}

function removeCard(cardId) {
  try {
    const doc = _load();
    const idx = doc.cards.findIndex((c) => c.id === cardId);
    if (idx === -1) {
      return { success: false, error: `卡片不存在: ${cardId}` };
    }
    const card = doc.cards[idx];
    // Detach any app pointing at this card before deleting.
    for (const app of Object.keys(doc.active)) {
      if (doc.active[app] === cardId) {
        delete doc.active[app];
      }
    }
    if (card.keyId) {
      try {
        apiKeyPool.removeKey(_poolProvider(cardId), card.keyId);
      } catch {
        /* best effort */
      }
    }
    doc.cards.splice(idx, 1);
    _save();
    return { success: true };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
}

/**
 * Resolve a card's usable credential (returns the raw key from the pool).
 * Credential-free by default — callers must opt in with `includeKey`.
 */
function getCardCredential(cardId) {
  const card = getCard(cardId);
  if (!card) {
    return null;
  }
  if (!card.keyId) {
    return null;
  }
  try {
    const picked = apiKeyPool.pickById(_poolProvider(cardId), card.keyId);
    return picked ? picked.key : null;
  } catch {
    return null;
  }
}

// ── Per-app active state ───────────────────────────────────────────────────
function getActiveCardId(app) {
  const doc = _load();
  return doc.active[app] || null;
}

function setActiveCard(app, cardId) {
  const doc = _load();
  if (!Object.values(APPS).includes(app)) {
    return { success: false, error: `不支持的应用: ${app}` };
  }
  if (cardId == null) {
    delete doc.active[app];
    _save();
    return { success: true };
  }
  const card = doc.cards.find((c) => c.id === cardId);
  if (!card) {
    return { success: false, error: `卡片不存在: ${cardId}` };
  }
  if (!card.enabled) {
    return { success: false, error: `卡片「${card.name}」已禁用` };
  }
  if (!card.apps.includes(app)) {
    return { success: false, error: `卡片「${card.name}」不支持应用 ${app}` };
  }
  doc.active[app] = cardId;
  _save();
  return { success: true, card };
}

function getAppConfig(app) {
  const doc = _load();
  return doc.apps[app] || { scanEnabled: true };
}

function setAppConfig(app, cfg) {
  const doc = _load();
  if (!Object.values(APPS).includes(app)) {
    return { success: false, error: `不支持的应用: ${app}` };
  }
  doc.apps[app] = _normalizeApps({ [app]: cfg })[app];
  _save();
  return { success: true };
}

// ── Snapshot / export / import (backup + restore support) ─────────────────
function exportSnapshot() {
  const doc = _load();
  // Strip credential refs from the export shape (keyId stays — the pool entry
  // is what the restore must re-import; raw keys never appear here).
  return JSON.parse(JSON.stringify(doc));
}

function importSnapshot(snapshot, { replace = false } = {}) {
  try {
    const incoming = _normalizeDoc(snapshot);
    const doc = _load();
    if (replace) {
      doc.cards = incoming.cards;
      doc.active = incoming.active;
      doc.apps = incoming.apps;
    } else {
      for (const card of incoming.cards) {
        if (!doc.cards.some((c) => c.id === card.id)) {
          doc.cards.push(card);
        }
      }
      for (const [app, cardId] of Object.entries(incoming.active)) {
        if (doc.cards.some((c) => c.id === cardId)) {
          doc.active[app] = cardId;
        }
      }
    }
    _save();
    return { success: true, count: incoming.cards.length };
  } catch (e) {
    return { success: false, error: String((e && e.message) || e) };
  }
}

// apiKeyPool provider namespace for a card's keys (isolated from builtin pools).
function _poolProvider(cardId) {
  return `cc-switch:${cardId}`;
}

// Test helper.
function _reset() {
  _cache = null;
}

module.exports = {
  addCard,
  listCards,
  getCard,
  updateCard,
  removeCard,
  getCardCredential,
  getActiveCardId,
  setActiveCard,
  getAppConfig,
  setAppConfig,
  exportSnapshot,
  importSnapshot,
  _reset,
  _poolProvider,
  __test__: { _load, _save },
};
