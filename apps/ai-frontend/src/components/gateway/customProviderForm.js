/**
 * customProviderForm — pure, dependency-free helpers behind CustomProviderCard's
 * add form. Kept out of the .vue SFC so the normalization + validation can be
 * unit-tested with the built-in Node runner (apps/ai-frontend is type:module):
 *
 *   node --test src/components/gateway/customProviderForm.test.js
 *
 * Two jobs:
 *   1. parseModelSeed — turn the optional "初始模型" free-text field (comma /
 *      newline / whitespace separated) into a clean, de-duplicated id list so a
 *      brand-new provider+key can seed its models in ONE submit.
 *   2. validateProviderDraft / buildProviderPayload — the single source of the
 *      provider-key payload shape the card emits, so the component stays a thin
 *      view over tested logic.
 */

/**
 * Split the free-text model field into a de-duplicated, order-preserving list of
 * model ids. Separators: comma, Chinese comma, semicolon, newline, or runs of
 * whitespace. Model ids are case-SENSITIVE (e.g. `gpt-4o` vs `GPT-4o` may differ
 * upstream), so de-dup compares the trimmed value verbatim — only exact repeats
 * are dropped.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function parseModelSeed(text) {
  const raw = String(text == null ? '' : text);
  const parts = raw.split(/[,，;；\n\r]+|\s{2,}/);
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    const id = String(p || '').trim();
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Validate the raw draft. Returns an error message (Chinese, for ElMessage) when
 * invalid, or null when the draft is good to submit. Provider + key are the only
 * hard requirements; everything else is optional.
 *
 * @param {object} draft
 * @returns {string|null}
 */
export function validateProviderDraft(draft = {}) {
  const provider = String(draft.provider || '').trim();
  if (!provider) return '请填写 provider';
  const key = String(draft.key || '').trim();
  if (!key) return '请填写 API Key';
  return null;
}

/**
 * Build the emit payload from a (validated) draft. Provider is lower-cased to
 * stay consistent with the by-provider grouping; optional upstream metadata
 * (baseUrl / apiFormat / endpoint) is carried only when present so free-text
 * adds stay minimal. `models` is always an array (possibly empty) parsed from
 * the seed field — the orchestrator seeds them after the key is created.
 *
 * @param {object} draft
 * @returns {{provider:string,displayName:string,key:string,models:string[],baseUrl?:string,apiFormat?:string,endpoint?:string}}
 */
export function buildProviderPayload(draft = {}) {
  const payload = {
    provider: String(draft.provider || '').trim().toLowerCase(),
    displayName: String(draft.displayName || '').trim(),
    key: String(draft.key || '').trim(),
    models: parseModelSeed(draft.models),
  };
  const baseUrl = String(draft.baseUrl || '').trim();
  const apiFormat = String(draft.apiFormat || '').trim();
  const endpoint = String(draft.endpoint || '').trim();
  if (baseUrl) payload.baseUrl = baseUrl;
  if (apiFormat) payload.apiFormat = apiFormat;
  if (endpoint) payload.endpoint = endpoint;
  return payload;
}
