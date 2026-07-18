'use strict';

const KEY_FIELD_CANDIDATES = Object.freeze([
  'key',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'access_token',
  'value',
]);

function _dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values || []) {
    const token = String(value || '').trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function _stripWrappingQuotes(raw) {
  let text = String(raw || '').trim();
  while (
    text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"'))
      || (text.startsWith('\'') && text.endsWith('\''))
      || (text.startsWith('`') && text.endsWith('`')))
  ) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function _cleanToken(raw, options = {}) {
  const stripBearerPrefix = options.stripBearerPrefix !== false;
  let token = _stripWrappingQuotes(raw);
  if (!token) return '';

  token = token.replace(
    /^(?:api[_-]?key|apikey|key|token|access[_-]?token|authorization)\s*[:=]\s*/i,
    ''
  ).trim();
  if (stripBearerPrefix) {
    token = token.replace(/^(?:bearer|token)\s+/i, '').trim();
  }
  token = _stripWrappingQuotes(token);
  return token;
}

function _tryParseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (!((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']')))) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function _splitLooseText(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (!/[\r\n,;]/.test(text)) return [text];
  return text
    .split(/[\r\n,;]+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function _parseKeyFromObject(obj, options = {}) {
  for (const field of KEY_FIELD_CANDIDATES) {
    if (!(field in obj)) continue;
    const token = _cleanToken(obj[field], options);
    if (token) return token;
  }
  return '';
}

function parseApiKeyList(input, options = {}) {
  const walk = (node) => {
    if (node === null || node === undefined) return [];

    if (Array.isArray(node)) {
      return node.flatMap(item => walk(item));
    }

    if (typeof node === 'object') {
      const direct = _parseKeyFromObject(node, options);
      if (direct) return [direct];
      if (Array.isArray(node.keys)) return walk(node.keys);
      if (Array.isArray(node.items)) return walk(node.items);
      if (Array.isArray(node.entries)) return walk(node.entries);
      const nested = [];
      for (const value of Object.values(node)) nested.push(...walk(value));
      return nested;
    }

    const text = String(node || '').trim();
    if (!text) return [];

    const parsedJson = _tryParseJson(text);
    if (parsedJson !== null) return walk(parsedJson);

    const tokens = [];
    for (const chunk of _splitLooseText(text)) {
      let token = chunk;
      const kv = chunk.match(/^\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*[:=]\s*(.+)\s*$/);
      if (kv) {
        const field = String(kv[1] || '').toLowerCase();
        if (['key', 'apikey', 'api_key', 'token', 'access_token', 'accesstoken', 'authorization', 'bearer'].includes(field)) {
          token = kv[2];
        }
      }
      const cleaned = _cleanToken(token, options);
      if (cleaned) tokens.push(cleaned);
    }
    return tokens;
  };

  return _dedupe(walk(input));
}

function extractPrimaryApiKey(input, fallback = '', options = {}) {
  const list = parseApiKeyList(input, options);
  if (list.length > 0) return list[0];
  return _cleanToken(fallback, options);
}

function _toNumericPriority(value, fallback) {
  const num = Number(value);
  if (Number.isFinite(num)) return num;
  return fallback;
}

function parseApiKeyEntries(input, defaults = {}, options = {}) {
  const fallbackPriority = _toNumericPriority(defaults.priority, 0);
  const baseLabel = String(defaults.label || '');
  const baseEndpoint = String(defaults.endpoint || '');
  const out = [];

  const pushEntry = (key, meta = {}) => {
    const cleaned = _cleanToken(key, options);
    if (!cleaned) return;
    out.push({
      key: cleaned,
      endpoint: meta.endpoint !== undefined ? String(meta.endpoint || '') : baseEndpoint,
      priority: _toNumericPriority(meta.priority, fallbackPriority),
      label: meta.label !== undefined ? String(meta.label || '') : baseLabel,
    });
  };

  const walk = (node, inherited = {}) => {
    if (node === null || node === undefined) return;

    if (Array.isArray(node)) {
      for (const item of node) walk(item, inherited);
      return;
    }

    if (typeof node === 'object') {
      const merged = {
        endpoint: node.endpoint !== undefined ? node.endpoint : inherited.endpoint,
        priority: node.priority !== undefined ? node.priority : inherited.priority,
        label: node.label !== undefined ? node.label : inherited.label,
      };

      const direct = _parseKeyFromObject(node, options);
      if (direct) {
        pushEntry(direct, merged);
        return;
      }

      if (Array.isArray(node.keys)) {
        walk(node.keys, merged);
        return;
      }
      if (Array.isArray(node.items)) {
        walk(node.items, merged);
        return;
      }
      if (Array.isArray(node.entries)) {
        walk(node.entries, merged);
        return;
      }

      for (const [k, v] of Object.entries(node)) {
        if (k === 'endpoint' || k === 'priority' || k === 'label') continue;
        if (typeof v === 'string') {
          pushEntry(v, { ...merged, label: merged.label || k });
          continue;
        }
        if (v && typeof v === 'object') {
          walk(v, { ...merged, label: merged.label || k });
        }
      }
      return;
    }

    const keys = parseApiKeyList(node, options);
    for (const key of keys) pushEntry(key, inherited);
  };

  walk(input, {
    endpoint: baseEndpoint,
    priority: fallbackPriority,
    label: baseLabel,
  });

  const deduped = [];
  const seen = new Set();
  for (const item of out) {
    if (!item.key || seen.has(item.key)) continue;
    seen.add(item.key);
    deduped.push(item);
  }
  return deduped;
}

module.exports = {
  parseApiKeyList,
  extractPrimaryApiKey,
  parseApiKeyEntries,
};

