'use strict';

/**
 * anthropicRelayPresets.js — opt-in Anthropic relay presets (pure leaf).
 *
 * Why presets and NOT a package-wide default:
 *   The relay base URL is not a secret, so shipping the string in the published
 *   package is harmless. But setting it as the ACTIVE default `ANTHROPIC_BASE_URL`
 *   for everyone would silently route every other user's official ANTHROPIC_API_KEY
 *   to this third-party relay — leaking their keys. So the URL lives here as an
 *   INERT, named preset that a user must explicitly activate on their own machine
 *   (`khy claude use-relay <name>`), which writes it to that user's ~/.khy/.env only.
 *
 * A preset carries only non-secret fields (base URL + optional default model).
 * It NEVER carries a token — the token is always supplied by the user at runtime.
 *
 * Pure: frozen data + lookups; no IO, no env reads, no throwing.
 * 承 [[project_claude_adapter_bearer_auth_scheme_relay_reuse]].
 */

// Known relays, keyed by short name. Values are non-secret (endpoint + default model).
const RELAY_PRESETS = Object.freeze({
  mindflow: Object.freeze({
    baseUrl: 'https://ai.mindflow.com.cn',
    model: 'claude-opus-4-8',
    label: 'MindFlow 中转',
  }),
});

/** @returns {string[]} available preset names */
function listRelayPresetNames() {
  return Object.keys(RELAY_PRESETS);
}

/** @returns {Array<{name:string,baseUrl:string,model:(string|null),label:string}>} */
function listRelayPresets() {
  return listRelayPresetNames().map((name) => ({ name, ...RELAY_PRESETS[name] }));
}

/**
 * @param {string} name preset name (case-insensitive, trimmed)
 * @returns {{baseUrl:string, model:(string|null), label:string} | null}
 */
function getRelayPreset(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return null;
  const p = RELAY_PRESETS[key];
  if (!p) return null;
  return { baseUrl: p.baseUrl, model: p.model || null, label: p.label || key };
}

module.exports = {
  RELAY_PRESETS,
  listRelayPresetNames,
  listRelayPresets,
  getRelayPreset,
};
