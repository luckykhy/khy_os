/**
 * Plugin import (Coze-compatible) — normalize an OpenAPI-3 plugin into a
 * marketplace catalog row.
 *
 * Three entry shapes (all converge on the same normalized output):
 *   - raw OpenAPI-3 document (JSON object, JSON string, or YAML string)
 *   - a URL pointing at an OpenAPI document (fetched with SSRF guard + size cap)
 *   - a Coze/ChatGPT-lineage plugin package: { manifest, openapi } where the
 *     manifest is ai-plugin.json (name_for_model / description_for_model / auth /
 *     api). If the manifest's api.url points at the spec, we fetch it.
 *
 * Output (preview or persisted MarketplacePlugin): a normalized internal manifest
 * (Coze-compatible field names) + the OpenAPI doc + the projected operation list.
 * Each OpenAPI operation = one callable tool (see @khy/shared/plugins/openapiTools).
 *
 * curl/Postman → OpenAPI conversion is a deliberate post-v1 enhancement.
 *
 * @module services/pluginImportService
 * @pattern Service
 */
'use strict';

const path = require('path');
const yaml = require('js-yaml');

const { MarketplacePlugin } = require('@khy/shared/models');
const { listOperations } = require('@khy/shared/plugins/openapiTools');
const { httpError } = require('./workflowService');

// SSRF guard lives in the trading backend; reuse it rather than reimplement
// (ai-backend already imports backend services this way — see userGatewayConfigService).
const urlSafety = require(path.resolve(__dirname, '../../../backend/src/services/urlSafety'));

const MAX_SPEC_BYTES = Number(process.env.KHY_PLUGIN_MAX_SPEC_BYTES || 2 * 1024 * 1024); // 2 MB
const FETCH_TIMEOUT_MS = Number(process.env.KHY_PLUGIN_FETCH_TIMEOUT_MS || 15000);

// ── Parsing helpers ─────────────────────────────────────────────────────────

/** Parse a JSON or YAML document from a string, or pass through an object. */
function _parseDoc(input, label) {
  if (input && typeof input === 'object') return input;
  if (typeof input !== 'string' || !input.trim()) {
    throw httpError(400, `${label} is empty`);
  }
  const text = input.trim();
  // Try JSON first (strict), then YAML (superset that also accepts JSON).
  try {
    return JSON.parse(text);
  } catch {
    try {
      const doc = yaml.load(text);
      if (doc && typeof doc === 'object') return doc;
    } catch (err) {
      throw httpError(400, `${label} is not valid JSON or YAML: ${err.message}`);
    }
  }
  throw httpError(400, `${label} did not parse to an object`);
}

/** Fetch an OpenAPI/manifest document over HTTP with SSRF + size guards. */
async function _fetchDoc(url, label) {
  let parsedUrl;
  try {
    parsedUrl = new URL(String(url));
  } catch {
    throw httpError(400, `${label} is not a valid URL`);
  }
  // DNS-resolved SSRF check (rejects private/loopback/metadata + rebinding).
  try {
    await urlSafety.assertPublicHttpUrlResolved(parsedUrl, label);
  } catch (err) {
    throw httpError(400, `${label} blocked: ${err.message}`);
  }

  const axios = require('axios');
  const res = await axios({
    method: 'GET',
    url: parsedUrl.toString(),
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_SPEC_BYTES,
    maxBodyLength: MAX_SPEC_BYTES,
    responseType: 'text',
    transformResponse: [(d) => d], // keep raw text; we parse ourselves
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw httpError(502, `Failed to fetch ${label} (${res.status})`);
  }
  const body = typeof res.data === 'string' ? res.data : JSON.stringify(res.data || {});
  if (Buffer.byteLength(body, 'utf8') > MAX_SPEC_BYTES) {
    throw httpError(413, `${label} exceeds size limit`);
  }
  return _parseDoc(body, label);
}

// ── Normalization ───────────────────────────────────────────────────────────

function _slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100) || 'plugin';
}

/**
 * Normalize a Coze/ChatGPT manifest into khy's internal manifest. Tolerates
 * partial manifests (raw-OpenAPI imports synthesize one from info{}).
 */
function _normalizeManifest(manifest, openapi) {
  const m = manifest && typeof manifest === 'object' ? manifest : {};
  const info = (openapi && openapi.info) || {};
  const nameForModel = m.name_for_model || m.name_for_human || info.title || 'plugin';
  return {
    schema_version: m.schema_version || 'v1',
    name_for_human: m.name_for_human || info.title || nameForModel,
    name_for_model: nameForModel,
    description_for_human: m.description_for_human || info.description || '',
    description_for_model: m.description_for_model || info.description || '',
    auth: _normalizeAuth(m.auth),
    api: { type: 'openapi' },
    logo_url: m.logo_url || '',
    contact_email: m.contact_email || '',
    legal_info_url: m.legal_info_url || '',
  };
}

/**
 * Normalize the manifest auth block into khy's auth descriptor. This declares
 * the auth TYPE only — the user supplies concrete secrets at install time
 * (UserInstalledPlugin.authConfigJson). Coze/ChatGPT auth families:
 *   none | service_http (api key/bearer) | oauth
 */
function _normalizeAuth(auth) {
  const a = auth && typeof auth === 'object' ? auth : {};
  const type = String(a.type || 'none').toLowerCase();
  if (type === 'none' || type === '') return { type: 'none' };
  if (type === 'oauth') {
    return {
      type: 'oauth',
      authorization_url: a.authorization_url || a.client_url || '',
      token_url: a.token_url || a.authorization_url || '',
      scope: a.scope || '',
      // grant hint; the install config can override.
      grant: a.grant || (a.authorization_url ? 'authorization_code' : 'client_credentials'),
    };
  }
  // service_http / api_key / bearer all collapse to a key-based descriptor.
  const sub = String(a.authorization_type || a.sub_type || '').toLowerCase();
  if (sub === 'bearer' || type === 'bearer') {
    return { type: 'bearer' };
  }
  return {
    type: 'apiKey',
    in: a.in || (a.location === 'query' ? 'query' : 'header'),
    name: a.name || a.key || 'Authorization',
  };
}

/** Assert the parsed doc is recognizably OpenAPI-3 with at least one operation. */
function _assertOpenapi(openapi) {
  if (!openapi || typeof openapi !== 'object') {
    throw httpError(400, 'OpenAPI document is not an object');
  }
  const ver = String(openapi.openapi || openapi.swagger || '');
  if (!ver.startsWith('3')) {
    throw httpError(400, `Only OpenAPI 3.x is supported (got "${ver || 'unknown'}")`);
  }
  const ops = listOperations(openapi);
  if (!ops.length) {
    throw httpError(400, 'OpenAPI document declares no operations (paths)');
  }
  return ops;
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Build a normalized plugin from one of the supported inputs WITHOUT persisting.
 * @param {object} body { openapi?, openapiUrl?|url?, manifest?, manifestUrl?, name?, slug?, category? }
 * @returns {Promise<{slug,name,description,category,version,manifest,openapi,operations}>}
 */
async function preview(body = {}) {
  let manifest = null;
  let openapi = null;

  // 1) Resolve the manifest (optional).
  if (body.manifest != null) {
    manifest = _parseDoc(body.manifest, 'manifest');
  } else if (body.manifestUrl) {
    manifest = await _fetchDoc(body.manifestUrl, 'manifest');
  }

  // 2) Resolve the OpenAPI doc (required): explicit > url > manifest.api.url.
  if (body.openapi != null) {
    openapi = _parseDoc(body.openapi, 'openapi');
  } else if (body.openapiUrl || body.url) {
    openapi = await _fetchDoc(body.openapiUrl || body.url, 'openapi');
  } else if (manifest && manifest.api && manifest.api.url) {
    openapi = await _fetchDoc(manifest.api.url, 'openapi');
  } else {
    throw httpError(400, 'Provide an OpenAPI document via openapi, openapiUrl/url, or a manifest with api.url');
  }

  const operations = _assertOpenapi(openapi);
  const normManifest = _normalizeManifest(manifest, openapi);

  const info = openapi.info || {};
  const name = String(body.name || normManifest.name_for_human || info.title || 'Imported plugin').slice(0, 120);
  const slug = _slugify(body.slug || name);
  const description = String(
    normManifest.description_for_human || info.description || '',
  ).slice(0, 1000);
  const version = String(info.version || normManifest.schema_version || '1.0.0').slice(0, 32);

  return {
    slug,
    name,
    description,
    category: String(body.category || 'general').slice(0, 64),
    author: String(body.author || (info.contact && info.contact.name) || '').slice(0, 120),
    version,
    manifest: normManifest,
    openapi,
    operations,
  };
}

/**
 * Import (normalize + persist) a plugin as a marketplace catalog row.
 * @param {number|string} userId  publisher (null/0 → official build path via opts.official)
 * @param {object} body           same as preview() input + { official? }
 * @returns {Promise<MarketplacePlugin>}
 */
async function importPlugin(userId, body = {}) {
  const norm = await preview(body);

  // Slug must be unique in the shared catalog.
  const existing = await MarketplacePlugin.findOne({ where: { slug: norm.slug } });
  if (existing) {
    throw httpError(409, `A plugin with slug "${norm.slug}" already exists`);
  }

  const row = await MarketplacePlugin.create({
    slug: norm.slug,
    name: norm.name,
    description: norm.description,
    category: norm.category,
    author: norm.author,
    official: !!body.official,
    version: norm.version,
    publisherId: body.official ? null : (userId != null ? userId : null),
    manifestJson: norm.manifest,
    openapiJson: norm.openapi,
  });
  return row;
}

module.exports = {
  preview,
  importPlugin,
  // exported for tests
  _parseDoc,
  _normalizeManifest,
  _normalizeAuth,
  _slugify,
};
