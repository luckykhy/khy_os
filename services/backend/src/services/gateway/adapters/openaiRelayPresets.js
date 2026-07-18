'use strict';

/**
 * openaiRelayPresets.js — opt-in OpenAI/Codex relay presets (pure leaf).
 *
 * The codex-side counterpart of anthropicRelayPresets.js. Why presets and NOT a
 * package-wide default:
 *   A relay base URL is not a secret, so shipping the string in the package is
 *   harmless. But setting it as the ACTIVE default `OPENAI_BASE_URL` for everyone
 *   would silently route every other user's official OpenAI key to a third-party
 *   relay — leaking their keys. So a URL lives here only as an INERT, named preset
 *   that a user must explicitly activate on their own machine
 *   (`khy codex use-relay <name>`), which writes it to that user's ~/.khy/.env only.
 *
 * A preset carries only non-secret fields (base URL + optional default model).
 * It NEVER carries a token — the token is always supplied by the user at runtime.
 *
 * ── HOW TO EXTEND ──────────────────────────────────────────────────────────────
 * To add a known OpenAI-compatible relay, add ONE frozen entry to RELAY_PRESETS:
 *   myrelay: Object.freeze({ baseUrl: 'https://...', model: 'gpt-...', label: '...' }),
 * `baseUrl` MUST be a real, non-secret endpoint (never a token). `model` is optional.
 * Ship NOTHING you cannot verify — an empty table is correct until a real relay is known.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * Pure: frozen data + lookups; no IO, no env reads, no throwing.
 */

// Known OpenAI/Codex relays, keyed by short name. Values are non-secret
// (endpoint + default model). Intentionally empty: no third-party OpenAI relay
// endpoint is shipped by default — users add their own via HOW-TO-EXTEND above,
// or use `khy codex adopt-env` to reuse whatever their `codex` CLI already has.
const RELAY_PRESETS = Object.freeze({});

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
