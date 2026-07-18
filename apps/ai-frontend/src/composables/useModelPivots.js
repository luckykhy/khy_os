/**
 * useModelPivots — client-side multi-pivot grouping over the flat catalog "edge"
 * list returned by the backend `/api/ai-gateway/catalog` (global) and
 * `/api/user-gateway/catalog` (per-user) endpoints.
 *
 * This is a faithful JS mirror of the backend
 * `services/backend/src/services/gateway/modelCatalogPivots.js`: the SAME eight
 * views, the SAME group-by semantics, the SAME label maps. Keeping one canonical
 * implementation per language (not per surface) is what stops Web and CLI from
 * drifting — both render from the one joined edge list, only the presentation
 * differs.
 *
 * No I/O, no Vue reactivity here — pure functions. The views import this and wrap
 * the result in their own computed()s.
 *
 * Edge shape (from the backend graph):
 *   { provider, providerLabel, model, keyIds[], keyCount, capability, tier,
 *     status, connectionMode, isDefault, source }
 */

// Order mirrors the backend VIEWS array; `by-provider` first so it can be the
// default that maps onto the existing per-provider management cards.
export const VIEWS = [
  { value: 'by-provider', label: '按供应商' },
  { value: 'by-model', label: '按模型' },
  { value: 'by-key', label: '按 Key' },
  { value: 'by-capability', label: '按能力' },
  { value: 'by-tier', label: '按档位' },
  { value: 'by-status', label: '按状态' },
  { value: 'by-connection', label: '按连接' },
  { value: 'flat', label: '全部/搜索' },
]

const VIEW_VALUES = VIEWS.map(v => v.value)

// Synthetic bucket labels for the by-key view. A system/global key is real but
// its id is hidden on the user plane (tenant isolation) → "(系统密钥)". An edge
// with genuinely no key → "(无 Key)". Exported so surfaces can CLASSIFY a group
// (system / no-key / own-key) without re-hardcoding these strings.
export const SYSTEM_KEY_BUCKET = '(系统密钥)'
export const NO_KEY_BUCKET = '(无 Key)'

export const CAPABILITY_LABELS = { text: '文本', audio: '语音', image: '图片', video: '视频' }
export const STATUS_LABELS = {
  active: '可用',
  cooldown: '冷却中',
  disabled: '不可用',
  'needs-key': '待配 Key',
  'system-ready': '系统可用',
  // System/global key exists but is not currently servable — distinct from
  // "needs-key" (no key at all), so a configured-but-failing key is not
  // mislabelled as missing.
  'system-cooldown': '系统密钥冷却',
  'system-error': '系统密钥失效',
}
export const CONNECTION_LABELS = {
  direct: '直连',
  'account-pool': '账号池',
  proxy: '代理路由',
  system: '系统',
}
// Where an edge came from (state transparency: the user sees auto-detected own
// models vs live local Ollama vs system/global offerings, never conflated).
export const SOURCE_LABELS = {
  relay: '中转上游',
  provider: '我的供应商',
  local: '本地 Ollama',
  system: '系统/全局',
}

export function capabilityLabel(c) { return CAPABILITY_LABELS[c] || c || '' }
export function statusLabel(s) { return STATUS_LABELS[s] || s || '' }
export function connectionLabel(c) { return CONNECTION_LABELS[c] || c || '' }
export function sourceLabel(s) { return SOURCE_LABELS[s] || s || '' }

/** Element-Plus tag type for a status value (state transparency in colour). */
export function statusTagType(s) {
  if (s === 'active' || s === 'system-ready') return 'success'
  if (s === 'cooldown' || s === 'needs-key' || s === 'system-cooldown') return 'warning'
  if (s === 'system-error') return 'danger'
  return 'info'
}

/** Element-Plus tag type for a source value. */
export function sourceTagType(s) {
  if (s === 'relay' || s === 'provider') return 'primary'
  if (s === 'local') return 'success'
  if (s === 'system') return 'info'
  return ''
}

/** Stable sort groups by key for deterministic rendering (mirrors backend). */
function sortGroups(groups) {
  return groups.sort((a, b) => String(a.groupKey).localeCompare(String(b.groupKey)))
}

/** Generic single-axis group-by. keyFn may return a string or array of strings. */
function groupBy(edges, keyFn, labelFn) {
  const map = new Map()
  for (const edge of edges) {
    const keys = keyFn(edge)
    const list = Array.isArray(keys) ? keys : [keys]
    for (const k of list) {
      if (k === undefined || k === null || k === '') continue
      const key = String(k)
      if (!map.has(key)) map.set(key, { groupKey: key, groupLabel: labelFn ? labelFn(key) : key, edges: [] })
      map.get(key).edges.push(edge)
    }
  }
  return sortGroups([...map.values()])
}

/**
 * Pivot the flat edge list into grouped views. Faithful mirror of the backend
 * `pivot()`.
 * @param {Array} edges
 * @param {string} viewMode one of VIEW_VALUES
 * @param {{search?: string}} [opts] substring filter over model/provider/label
 * @returns {Array<{groupKey:string, groupLabel:string, edges:Array}>}
 */
export function pivotEdges(edges, viewMode, opts = {}) {
  const view = VIEW_VALUES.includes(viewMode) ? viewMode : 'by-provider'
  let rows = Array.isArray(edges) ? edges : []

  const q = String(opts.search || '').trim().toLowerCase()
  if (q) {
    rows = rows.filter(e =>
      String(e.model || '').toLowerCase().includes(q)
      || String(e.provider || '').toLowerCase().includes(q)
      || String(e.providerLabel || '').toLowerCase().includes(q))
  }

  switch (view) {
    case 'by-model':
      return groupBy(rows, e => e.model)
    case 'by-provider':
      return groupBy(rows, e => e.provider, k => {
        const first = rows.find(e => e.provider === k)
        return first ? first.providerLabel : k
      })
    case 'by-key':
      // One group per key id; an edge with N keys appears under each. An edge with
      // no own key id falls into one of two synthetic buckets: a system/global key
      // exists (status system-*) but its id is hidden for tenant isolation → group
      // under "(系统密钥)"; otherwise there is genuinely no key → "(无 Key)". This
      // keeps the bucket honest — a configured system key is no longer mislabelled
      // as missing just because its id is not exposed to the user plane.
      return groupBy(rows, e => {
        if (e.keyIds && e.keyIds.length) return e.keyIds
        if (typeof e.status === 'string' && e.status.startsWith('system-')) return [SYSTEM_KEY_BUCKET]
        return [NO_KEY_BUCKET]
      })
    case 'by-capability':
      return groupBy(rows, e => e.capability, k => capabilityLabel(k))
    case 'by-tier':
      return groupBy(rows, e => e.tier)
    case 'by-status':
      return groupBy(rows, e => e.status, k => statusLabel(k))
    case 'by-connection':
      return groupBy(rows, e => e.connectionMode, k => connectionLabel(k))
    case 'flat':
    default:
      return [{ groupKey: 'all', groupLabel: '全部', edges: rows }]
  }
}
