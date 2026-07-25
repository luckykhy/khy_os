/**
 * gatewayInlineEdit — pure, dependency-free helpers that turn the read-only
 * multi-pivot "edge" rows into inline-editable rows on BOTH gateway planes,
 * WITHOUT any backend change.
 *
 * The catalog "edge" list (from /api/ai-gateway/catalog and
 * /api/user-gateway/catalog) is a flat projection. Editing has to flow through
 * the EXISTING mutation paths, so each edge must be mapped back to its editable
 * record:
 *
 *   • Admin plane — every chat edge is served by the single gateway adapter
 *     `'api'`; its curation override store keys models by the QUALIFIED id
 *     `api:<poolKey>:<model>`. So an edit on any chat edge becomes
 *     applyModelPatch('api', …) with id `api:${edge.provider}:${edge.model}`.
 *     Image/video edges are not registry-backed → read-only.
 *
 *   • User plane — `provider`/`relay` edges are derived from the user's own
 *     `user_provider_models` rows, which carry the row `id`. Mapping an edge to
 *     its row id by (provider, model) lets the row drive updateModel/removeModel.
 *     system/local edges and rowless edges (relay default, empty placeholder)
 *     stay read-only (tenant isolation + state transparency).
 *
 * Catalog edges are RAW (overrides are applied only to gw.modelCatalog, not to
 * edges). So `applyApiOverridesToEdges` re-applies the `api` override bucket to
 * the edge list client-side, so admin pivot edits (hide/rename/add/default)
 * reflect immediately in every pivot view.
 *
 * Hard rule: no helper ever emits real key id material — synthetic edges always
 * carry keyIds:[] / keyCount cloned only as a number.
 */

export const API_ADAPTER = 'api';

/** Case-insensitive, trimmed string equality (model ids / provider names). */
function _eq(a, b) {
  return String(a == null ? '' : a).trim().toLowerCase()
    === String(b == null ? '' : b).trim().toLowerCase();
}
export function sameModel(a, b) { return _eq(a, b); }
export function sameProvider(a, b) { return _eq(a, b); }

// ── User plane ────────────────────────────────────────────────────────────

/**
 * Map a user-plane edge back to the id of its backing user_provider_models row.
 * @param {object} edge catalog edge
 * @param {Array<{id:any, provider:string, model:string}>} models gw.models rows
 * @returns {any|null} the row id, or null when the edge has no backing row
 *   (model:'' placeholder, relay default model with no persisted row, etc.)
 */
export function userEdgeRowId(edge, models) {
  if (!edge || !edge.model) return null;
  const list = Array.isArray(models) ? models : [];
  const hit = list.find(r => r && sameProvider(r.provider, edge.provider) && sameModel(r.model, edge.model));
  return hit ? hit.id : null;
}

/** A user-plane edge is editable iff it is one of the user's own models AND it
 *  maps to a concrete row (so updateModel/removeModel have an id to act on). */
export function userEdgeEditable(edge, models) {
  if (!edge) return false;
  if (edge.source !== 'relay' && edge.source !== 'provider') return false;
  return userEdgeRowId(edge, models) != null;
}

/**
 * Join a by-key own-key group back to the user's OWN provider/key row, so the
 * pivot header can show a *masked* key preview (sk-…xxxx) + label instead of the
 * bare opaque id. The user-plane catalog builds own-key edge keyIds from the
 * provider row id (userModelCatalogGraph: keyIds.push(String(p.id))), so the
 * group key equals String(row.id) — we join on that.
 *
 * Tenant isolation: system/global keys never expose their ids on the user plane,
 * so their groups can never match a row here → no system secret can surface. The
 * returned row only ever carries `keyMasked` (already masked server-side), never
 * a raw secret.
 *
 * @param {string|number} groupKey the by-key group's groupKey (an own key id)
 * @param {Array<{id:any, provider:string, displayName?:string, keyMasked?:string, label?:string}>} providers gw.providers rows
 * @returns {object|null} the matching masked provider row, or null
 */
export function ownKeyRowForGroup(groupKey, providers) {
  if (groupKey == null || groupKey === '') return null;
  const list = Array.isArray(providers) ? providers : [];
  const target = String(groupKey);
  return list.find(p => p && p.id != null && String(p.id) === target) || null;
}

/**
 * Admin plane: join a by-key pivot group (groupKey = a real pool key id) back to
 * its MASKED preview + label from the API key pool, so the by-key header can show
 * each key as `sk-…xxxx` (with its models listed underneath) instead of the
 * opaque internal id. Catalog edge keyIds come from apiKeyPool.getPoolStatus
 * (keyId) — the SAME ids the "API 密钥池" card renders — so the join is exact.
 *
 * Admin-only: the admin plane already holds these masked previews (the pool
 * card), so this surfaces no NEW secret material and never the raw key value.
 *
 * @param {string|number} groupKey by-key group's groupKey (a pool key id)
 * @param {Object<string, Array<{keyId:any, keyPreview?:string, label?:string}>>} pool gw.pool.value (provider → key rows)
 * @returns {{keyId:any, keyPreview:string, label:string, provider:string}|null}
 */
export function poolKeyForGroup(groupKey, pool) {
  if (groupKey == null || groupKey === '') return null;
  if (!pool || typeof pool !== 'object') return null;
  const target = String(groupKey);
  for (const [provider, keys] of Object.entries(pool)) {
    for (const k of (Array.isArray(keys) ? keys : [])) {
      if (k && k.keyId != null && String(k.keyId) === target) {
        return { keyId: k.keyId, keyPreview: k.keyPreview || '', label: k.label || '', provider };
      }
    }
  }
  return null;
}

/** Read-only tag text for a non-editable user-plane edge (state transparency). */
export function userEdgeReadonlyTag(edge) {
  if (!edge) return '只读';
  if (edge.source === 'system') return '系统/全局';
  if (edge.source === 'local') return '本地 Ollama';
  return '只读';
}

// ── Admin plane ───────────────────────────────────────────────────────────

/** The qualified override id for a chat edge: `api:<poolKey>:<model>`. */
export function adminQualifiedId(edge) {
  if (!edge || !edge.model) return '';
  return `${API_ADAPTER}:${edge.provider}:${edge.model}`;
}

/** A chat edge with a concrete model is editable via the `api` override bucket.
 *  image/video edges are not registry-backed → read-only. */
export function adminEdgeEditable(edge) {
  return Boolean(edge && edge.source === 'chat' && edge.model);
}

/**
 * Resolve the override target for an admin edge.
 * @param {object} edge
 * @param {object} overridesMap gw.modelOverrides.value (keyed by adapter)
 * @returns {{adapter:string, qualifiedId:string, custom:boolean}|null}
 */
export function adminEdgeTarget(edge, overridesMap) {
  if (!adminEdgeEditable(edge)) return null;
  const qualifiedId = adminQualifiedId(edge);
  const bucket = (overridesMap && overridesMap[API_ADAPTER]) || {};
  const added = Array.isArray(bucket.added) ? bucket.added : [];
  const custom = added.some(m => m && m.id === qualifiedId);
  return { adapter: API_ADAPTER, qualifiedId, custom };
}

/** Parse `api:<poolKey>:<model>` → {provider, model} (or null). */
function _parseQualified(id) {
  const m = /^api:([^:]+):(.+)$/.exec(String(id || ''));
  return m ? { provider: m[1], model: m[2] } : null;
}

/**
 * Re-apply the `api` curation override bucket onto a RAW edge list so admin
 * pivot edits are visible: drop hidden, relabel renamed, re-derive default, and
 * inject `added` models not already present as synthetic edges.
 *
 * Never mutates its inputs. Chat edges gain {editable, qualifiedId, custom,
 * displayName, isDefault}; non-chat edges pass through with editable:false.
 * Synthetic edges carry keyIds:[] (no key material ever leaks).
 *
 * @param {Array} edges raw catalog edges
 * @param {object} overridesMap gw.modelOverrides.value
 * @returns {Array} new annotated edge list
 */
export function applyApiOverridesToEdges(edges, overridesMap) {
  const list = Array.isArray(edges) ? edges : [];
  const bucket = (overridesMap && overridesMap[API_ADAPTER]) || {};
  const hidden = new Set((Array.isArray(bucket.hidden) ? bucket.hidden : []).map(String));
  const renamed = (bucket.renamed && typeof bucket.renamed === 'object') ? bucket.renamed : {};
  const added = Array.isArray(bucket.added) ? bucket.added : [];
  const defaultModel = bucket.defaultModel ? String(bucket.defaultModel) : '';

  const out = [];
  const presentChatIds = new Set();

  for (const edge of list) {
    if (!edge || edge.source !== 'chat' || !edge.model) {
      // Non-chat (image/video) or empty: read-only, untouched.
      out.push({ ...edge, editable: false });
      continue;
    }
    const qid = adminQualifiedId(edge);
    if (hidden.has(qid)) continue; // hidden → removed from every view
    presentChatIds.add(qid);
    const customAdded = added.some(m => m && m.id === qid);
    out.push({
      ...edge,
      editable: true,
      qualifiedId: qid,
      custom: customAdded,
      displayName: renamed[qid] != null ? String(renamed[qid]) : edge.model,
      isDefault: defaultModel ? (qid === defaultModel) : Boolean(edge.isDefault),
    });
  }

  // Inject user-added models that aren't in the live edge list yet, cloning the
  // pivot dimensions from a sibling edge of the same provider when available.
  for (const a of added) {
    if (!a || !a.id || hidden.has(String(a.id)) || presentChatIds.has(a.id)) continue;
    const parsed = _parseQualified(a.id);
    if (!parsed) continue;
    const sibling = out.find(e => e.source === 'chat' && sameProvider(e.provider, parsed.provider));
    out.push({
      provider: parsed.provider,
      providerLabel: sibling ? sibling.providerLabel : parsed.provider,
      model: parsed.model,
      keyIds: [],
      keyCount: sibling ? (sibling.keyCount || 0) : 0,
      capability: sibling ? sibling.capability : 'text',
      tier: sibling ? sibling.tier : '',
      status: sibling ? sibling.status : 'active',
      connectionMode: sibling ? sibling.connectionMode : 'direct',
      source: 'chat',
      editable: true,
      qualifiedId: a.id,
      custom: true,
      displayName: a.name != null ? String(a.name) : parsed.model,
      isDefault: defaultModel ? (a.id === defaultModel) : Boolean(a.isDefault),
    });
    presentChatIds.add(a.id);
  }

  return out;
}
