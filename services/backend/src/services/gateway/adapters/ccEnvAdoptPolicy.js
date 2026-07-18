'use strict';

/**
 * ccEnvAdoptPolicy.js — pure policy for `khy claude adopt-env`.
 *
 * Goal(承 [[project_claude_adapter_bearer_auth_scheme_relay_reuse]]):
 *   After `pip install -U khy-os`, khy should reuse the SAME credentials the user's
 *   Claude Code already uses (typically `ANTHROPIC_BASE_URL` relay + `ANTHROPIC_AUTH_TOKEN`),
 *   without re-entering anything. This module decides WHAT to persist; the thin IO shell
 *   (cli/handlers/claudeAdopt.js) writes it to `~/.khy/.env`.
 *
 * Why an env file (not the api-key pool):
 *   - `~/.khy/.env` lives OUTSIDE site-packages, so `pip install -U` never overwrites it
 *     → the user configures once and every future upgrade still works ("写一次不再配").
 *   - On startup khy reloads `~/.khy/.env` into process.env, which reproduces the EXACT
 *     env code path in runClaudeDirect. That path already resolves the source-aware auth
 *     scheme (ANTHROPIC_AUTH_TOKEN → `Authorization: Bearer`, ANTHROPIC_API_KEY → `x-api-key`),
 *     so no scheme logic has to be duplicated and relay tokens auth correctly.
 *   - The token stays on the user's machine and NEVER enters the published package.
 *
 * Pure: no fs, no process.env reads (env is passed in), no throwing.
 */

// Order matters for display; ANTHROPIC_AUTH_TOKEN is preferred as the active credential.
const ADOPTABLE_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL'];

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
 * @param {object} env - typically process.env
 * @param {{baseUrl?:string, model?:string}} [defaults] - non-secret preset fallbacks
 * @returns {{ok:false, reason:string, entries:[]} |
 *           {ok:true, credKind:string, authScheme:string, endpoint:string,
 *            model:(string|null), maskedToken:string, entries:{key:string,value:string}[]}}
 */
function planCcEnvAdoption(env = {}, defaults = {}) {
  const src = env || {};
  const def = defaults || {};
  const baseUrl = _clean(src.ANTHROPIC_BASE_URL) || _clean(def.baseUrl);
  const authToken = _clean(src.ANTHROPIC_AUTH_TOKEN);
  const apiKey = _clean(src.ANTHROPIC_API_KEY);
  const model = _clean(src.ANTHROPIC_MODEL) || _clean(def.model);

  // Need at least one credential to be worth persisting.
  if (!authToken && !apiKey) {
    return { ok: false, reason: 'no-credential', entries: [] };
  }

  // Prefer AUTH_TOKEN (relay / gateway → Bearer); fall back to API_KEY (official → x-api-key).
  const credKind = authToken ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  const authScheme = authToken ? 'bearer' : 'x-api-key';

  const entries = [];
  if (baseUrl) entries.push({ key: 'ANTHROPIC_BASE_URL', value: baseUrl });
  if (authToken) entries.push({ key: 'ANTHROPIC_AUTH_TOKEN', value: authToken });
  if (apiKey) entries.push({ key: 'ANTHROPIC_API_KEY', value: apiKey });
  if (model) entries.push({ key: 'ANTHROPIC_MODEL', value: model });

  return {
    ok: true,
    credKind,
    authScheme,
    endpoint: baseUrl || 'https://api.anthropic.com',
    model: model || null,
    maskedToken: maskSecret(authToken || apiKey),
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
  // end with exactly one newline. Trimming both ends also drops the phantom
  // empty line that splitting an empty input produces.
  const text = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length ? `${text}\n` : '';
}

/**
 * Resolve where `khy claude export-env` should drop a portable credential file.
 *
 * Pure path logic (no fs): the caller supplies homedir and an optional user-given
 * path. A user path wins verbatim; otherwise default to the Desktop with a clear,
 * self-describing filename. Callers still enforce chmod 600 and mask on display —
 * this only decides the location, never touches the token value.
 *
 * @param {string} homedir - os.homedir()
 * @param {string} [userPath] - explicit --file/positional path override
 * @returns {string} absolute-ish target path (caller resolves relative to cwd)
 */
function resolveExportTarget(homedir, userPath) {
  const explicit = _clean(userPath);
  if (explicit) return explicit;
  const home = _clean(homedir) || '.';
  return `${home}/Desktop/khy-cc-env.env`;
}

module.exports = {
  ADOPTABLE_KEYS,
  maskSecret,
  planCcEnvAdoption,
  renderEnvFilePatch,
  resolveExportTarget,
};
