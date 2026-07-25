'use strict';

/**
 * codexEnvAdoptPolicy.js — pure policy for `khy codex adopt-env`.
 *
 * Goal(与 [[project_claude_adapter_bearer_auth_scheme_relay_reuse]] 的 codex 对偶):
 *   Make `khy codex` reach parity with `khy claude`: after `pip install -U khy-os`,
 *   khy should reuse the SAME credentials the user's `codex` CLI already uses
 *   (typically an OpenAI-compatible relay `OPENAI_BASE_URL` / `CODEX_DIRECT_BASE_URL`
 *   plus `CODEX_API_KEY` / `OPENAI_API_KEY`), without re-entering anything. This module
 *   decides WHAT to persist; the thin IO shell (cli/handlers/codexAdopt.js) writes it
 *   to `~/.khy/.env`.
 *
 * Why an env file (not the api-key pool) — same reasoning as the claude side:
 *   - `~/.khy/.env` lives OUTSIDE site-packages, so `pip install -U` never overwrites it
 *     → the user configures once and every future upgrade still works ("写一次不再配").
 *   - On startup khy reloads `~/.khy/.env` into process.env, which reproduces the EXACT
 *     env code path in codexAdapter.runCodexDirect. That path resolves the base URL
 *     (CODEX_DIRECT_BASE_URL > OPENAI_BASE_URL > api.openai.com/v1) and the API key
 *     (CODEX_API_KEY > OPENAI_API_KEY) itself, and always uses `Authorization: Bearer`.
 *   - The token stays on the user's machine and NEVER enters the published package.
 *
 * Difference from the claude policy:
 *   Codex is OpenAI-compatible and always authenticates with a single Bearer key —
 *   there is no x-api-key/AUTH_TOKEN split. So the credential is unconditionally
 *   `bearer`, and both CODEX_API_KEY and OPENAI_API_KEY are treated as the same secret.
 *
 * Pure: no fs, no process.env reads (env is passed in), no throwing.
 */

// Order matters for display. CODEX_* is preferred (codex-native); OPENAI_* is the
// OpenAI-SDK-compatible fallback the same CLI understands. Both base-URL and key
// variants are persisted so the reloaded env reproduces the adapter's own precedence.
const ADOPTABLE_KEYS = [
  'CODEX_DIRECT_BASE_URL',
  'OPENAI_BASE_URL',
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_DIRECT_MODEL',
];

function _clean(v) {
  return v == null ? '' : String(v).trim();
}

/** Mask a secret for display: keep a short head + tail, never the middle. */
function maskSecret(v) {
  const s = _clean(v);
  if (!s) return '';
  if (s.length <= 10) return `${s.slice(0, 2)}…(len=${s.length})`;
  return `${s.slice(0, 6)}…${s.slice(-3)}(len=${s.length})`;
}

/**
 * Decide what to persist from a given env object.
 *
 * `defaults` supplies NON-SECRET fallbacks (base URL + model) that fill ONLY when
 * the env does not already carry them. This is how an opt-in relay preset ships a
 * base URL in the package without becoming an active global default: env always
 * wins, and the preset only fills the endpoint/model the user did not set.
 * A preset MUST NOT carry a token — the credential still comes from env.
 *
 * The base URL is resolved with the adapter's precedence (CODEX_DIRECT_BASE_URL
 * over OPENAI_BASE_URL) and the key with CODEX_API_KEY over OPENAI_API_KEY. The
 * chosen base URL is persisted under BOTH env names so whichever precedence branch
 * the adapter takes at runtime resolves to the same endpoint; likewise for the key.
 *
 * @param {object} env - typically process.env
 * @param {{baseUrl?:string, model?:string}} [defaults] - non-secret preset fallbacks
 * @returns {{ok:false, reason:string, entries:[]} |
 *           {ok:true, credKind:string, authScheme:string, endpoint:string,
 *            model:(string|null), maskedToken:string, entries:{key:string,value:string}[]}}
 */
function planCodexEnvAdoption(env = {}, defaults = {}) {
  const src = env || {};
  const def = defaults || {};
  const baseUrl =
    _clean(src.CODEX_DIRECT_BASE_URL) ||
    _clean(src.OPENAI_BASE_URL) ||
    _clean(def.baseUrl);
  const apiKey = _clean(src.CODEX_API_KEY) || _clean(src.OPENAI_API_KEY);
  const model =
    _clean(src.CODEX_DIRECT_MODEL) ||
    _clean(src.OPENAI_MODEL) ||
    _clean(def.model);

  // Need a credential to be worth persisting (base URL alone is not a login).
  if (!apiKey) {
    return { ok: false, reason: 'no-credential', entries: [] };
  }

  // Codex is OpenAI-compatible → always Bearer. CODEX_API_KEY is the native name;
  // display it if present, else the OpenAI-SDK name.
  const credKind = _clean(src.CODEX_API_KEY) ? 'CODEX_API_KEY' : 'OPENAI_API_KEY';

  const entries = [];
  // Persist the chosen base URL under both names so either adapter branch resolves it.
  if (baseUrl) {
    entries.push({ key: 'CODEX_DIRECT_BASE_URL', value: baseUrl });
    entries.push({ key: 'OPENAI_BASE_URL', value: baseUrl });
  }
  // Persist the key under both names for the same reason.
  entries.push({ key: 'CODEX_API_KEY', value: apiKey });
  entries.push({ key: 'OPENAI_API_KEY', value: apiKey });
  if (model) entries.push({ key: 'CODEX_DIRECT_MODEL', value: model });

  return {
    ok: true,
    credKind,
    authScheme: 'bearer',
    endpoint: baseUrl || 'https://api.openai.com/v1',
    model: model || null,
    maskedToken: maskSecret(apiKey),
    entries,
  };
}

/**
 * Merge managed KEY=VALUE entries into existing .env file content.
 * - Replaces an existing line for a managed key in place (first occurrence),
 *   drops any later duplicates of that same managed key.
 * - Appends managed keys that were not present.
 * - Preserves all unrelated lines and comments verbatim.
 * Idempotent: applying the same entries twice yields byte-identical output.
 *
 * @param {string} existingContent
 * @param {{key:string,value:string}[]} entries
 * @returns {string} new file content (single trailing newline)
 */
function renderEnvFilePatch(existingContent, entries) {
  const managed = new Map((entries || []).map((e) => [e.key, e.value]));
  const lines = String(existingContent || '').split(/\r?\n/);
  const out = [];
  const written = new Set();

  for (const line of lines) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && managed.has(m[1])) {
      if (!written.has(m[1])) {
        out.push(`${m[1]}=${managed.get(m[1])}`);
        written.add(m[1]);
      }
      // Drop duplicate managed lines to keep the file canonical.
      continue;
    }
    out.push(line);
  }

  // Append managed keys that were not already present (preserve entry order).
  for (const e of entries || []) {
    if (!written.has(e.key)) {
      out.push(`${e.key}=${e.value}`);
      written.add(e.key);
    }
  }

  // Normalize: collapse 3+ blank lines, trim leading/trailing blank lines,
  // end with exactly one newline.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length ? `${text}\n` : '';
}

/**
 * Resolve where `khy codex export-env` should drop a portable credential file.
 *
 * Pure path logic (no fs): a user path wins verbatim; otherwise default to the
 * Desktop with a clear, self-describing filename. Callers enforce chmod 600 and
 * mask on display — this only decides the location, never touches the token value.
 *
 * @param {string} homedir - os.homedir()
 * @param {string} [userPath] - explicit --file/positional path override
 * @returns {string} target path
 */
function resolveExportTarget(homedir, userPath) {
  const explicit = _clean(userPath);
  if (explicit) return explicit;
  const home = _clean(homedir) || '.';
  return `${home}/Desktop/khy-codex-env.env`;
}

module.exports = {
  ADOPTABLE_KEYS,
  maskSecret,
  planCodexEnvAdoption,
  renderEnvFilePatch,
  resolveExportTarget,
};
