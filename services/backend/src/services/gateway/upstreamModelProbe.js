/**
 * Upstream model probe — read an OpenAI/Anthropic-compatible upstream's
 * advertised model list from its own `/models` endpoint.
 *
 * Single source for "what models does this configured upstream actually
 * expose": both the admin apiAdapter (legacy `_fetchRemoteModels`) and the
 * per-user detection service delegate here so probe semantics stay identical.
 *
 * Zero-fabrication + never-throw: on any timeout, non-2xx, malformed body, or
 * network error this returns `null` (probe failed → caller degrades, leaves the
 * model unset, never invents one). A successful probe returns the raw model ids
 * the upstream reported, nothing more. Endpoints are DERIVED from baseUrl +
 * apiFormat — no hardcoded provider URLs.
 *
 * @pattern Strategy
 */
'use strict';

const { fetchWithTimeout } = require('../fetchTimeout');

// '2023-06-01' is the published stable Anthropic API version; overridable so a
// relay pinned to a newer dated version can still be probed. Kept in sync with
// adapters/relayApiAdapter.js (single convention, not a magic literal).
const ANTHROPIC_VERSION = process.env.RELAY_ANTHROPIC_VERSION
  || process.env.ANTHROPIC_VERSION
  || '2023-06-01';

const PROBE_TIMEOUT_MS = parseInt(process.env.KHY_MODEL_PROBE_TIMEOUT_MS || '5000', 10);

/**
 * Build the `/models` URL for a given base + api format without double-/v1.
 * OpenAI-compatible: `{base}/models` (base normally already ends in /v1).
 * Anthropic: `{base}/v1/models` (anthropic has no published /models endpoint —
 * the probe is best-effort and degrades gracefully when it 404s).
 */
function buildModelsUrl(base, apiFormat) {
  const root = String(base || '').trim().replace(/\/+$/, '');
  if (!root) return '';
  if (apiFormat === 'anthropic') {
    // Avoid `/v1/v1/models` when the base already carries a version segment.
    return /\/v\d+$/.test(root) ? `${root}/models` : `${root}/v1/models`;
  }
  return `${root}/models`;
}

function buildHeaders(apiKey, apiFormat) {
  if (apiFormat === 'anthropic') {
    return { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

/**
 * Probe an upstream's `/models` endpoint.
 *
 * @param {object} opts
 * @param {string} [opts.baseUrl]   Upstream base (e.g. https://api.x.com/v1)
 * @param {string} [opts.endpoint]  Explicit endpoint base; takes precedence over baseUrl
 * @param {string} opts.apiKey      Bearer / x-api-key secret (server-side only, never returned)
 * @param {string} [opts.apiFormat] 'openai' | 'anthropic' (default 'openai')
 * @returns {Promise<Array<{id:string, contextWindow:number}>|null>}
 *   Reported models, or null when the probe could not be completed.
 */
async function fetchUpstreamModels({ baseUrl, endpoint, apiKey, apiFormat } = {}) {
  const base = endpoint || baseUrl;
  if (!base || !apiKey) return null;
  const format = String(apiFormat || 'openai').trim().toLowerCase();
  const url = buildModelsUrl(base, format);
  if (!url) return null;

  try {
    // fetchWithTimeout takes a (signal)=>Promise thunk + { timeoutMs }, NOT a
    // URL. (The legacy apiAdapter call passed a URL string and `timeout:` — both
    // wrong — so it silently always failed; this is the corrected form.)
    const resp = await fetchWithTimeout(
      (signal) => fetch(url, { method: 'GET', headers: buildHeaders(apiKey, format), signal }),
      { timeoutMs: PROBE_TIMEOUT_MS, operation: 'upstreamModelProbe' },
    );
    if (!resp || !resp.ok) return null;
    const body = await resp.json();
    // OpenAI shape: { data: [{ id, ... }] }. Anthropic (when present) also
    // returns { data: [{ id, ... }] }. Accept either; ignore anything else.
    const data = Array.isArray(body?.data) ? body.data : [];
    return data
      .filter((m) => m && m.id)
      .map((m) => ({
        id: m.id,
        contextWindow: m.context_window || m.context_length || m.max_context_length || 0,
      }));
  } catch {
    return null;
  }
}

module.exports = { fetchUpstreamModels, buildModelsUrl, ANTHROPIC_VERSION };
