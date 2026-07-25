'use strict';

/**
 * modelCatalogPivots — pure group-by transforms over the flat edge list from
 * modelCatalogGraph.buildCatalogGraph(). Defines all eight views in ONE place so
 * CLI rendering, the HTTP endpoint, and tests share identical grouping logic
 * (the Web layer mirrors this in JS). No I/O, no state — given edges in, groups
 * out.
 *
 * Views:
 *   by-model       group by model id              → providers offering it
 *   by-provider    group by provider              → its models (today's default)
 *   by-key         group by key id                → models that key supports
 *                  (derived: a key's models = its provider's models)
 *   by-capability  group by text|audio|image|video
 *   by-tier        group by T0|T1|T2|T3
 *   by-status      group by active|cooldown|disabled
 *   by-connection  group by direct|account-pool|proxy
 *   flat           single group, optional substring search over provider/model/label
 */

const VIEWS = [
  'by-model', 'by-provider', 'by-key', 'by-capability',
  'by-tier', 'by-status', 'by-connection', 'flat',
];

const CAPABILITY_LABELS = { text: '文本', audio: '语音', image: '图片', video: '视频' };
const STATUS_LABELS = { active: '可用', cooldown: '冷却中', disabled: '不可用' };
const CONNECTION_LABELS = { direct: '直连', 'account-pool': '账号池', proxy: '代理路由' };

/** Stable sort groups by label for deterministic rendering. */
function _sortGroups(groups) {
  return groups.sort((a, b) => String(a.groupKey).localeCompare(String(b.groupKey)));
}

/** Generic single-axis group-by. keyFn may return a string or array of strings. */
function _groupBy(edges, keyFn, labelFn) {
  const map = new Map();
  for (const edge of edges) {
    const keys = keyFn(edge);
    const list = Array.isArray(keys) ? keys : [keys];
    for (const k of list) {
      if (k === undefined || k === null || k === '') continue;
      const key = String(k);
      if (!map.has(key)) map.set(key, { groupKey: key, groupLabel: labelFn ? labelFn(key) : key, edges: [] });
      map.get(key).edges.push(edge);
    }
  }
  return _sortGroups([...map.values()]);
}

/**
 * Pivot the flat edge list into grouped view.
 * @param {Array} edges
 * @param {string} viewMode one of VIEWS
 * @param {{search?: string}} [opts] substring filter (applies to all views; the
 *   flat view is the primary consumer but search is honored everywhere)
 * @returns {Array<{groupKey:string, groupLabel:string, edges:Array}>}
 */
function pivot(edges, viewMode, opts = {}) {
  const view = VIEWS.includes(viewMode) ? viewMode : 'by-provider';
  let rows = Array.isArray(edges) ? edges : [];

  const q = String(opts.search || '').trim().toLowerCase();
  if (q) {
    rows = rows.filter(e =>
      String(e.model || '').toLowerCase().includes(q)
      || String(e.provider || '').toLowerCase().includes(q)
      || String(e.providerLabel || '').toLowerCase().includes(q));
  }

  switch (view) {
    case 'by-model':
      return _groupBy(rows, e => e.model);
    case 'by-provider':
      return _groupBy(rows, e => e.provider, k => {
        const first = rows.find(e => e.provider === k);
        return first ? first.providerLabel : k;
      });
    case 'by-key':
      // One group per key id; an edge with N keys appears under each. An edge with
      // no own key id falls into one of two synthetic buckets: a system/global key
      // exists (status system-*) but its id is hidden for tenant isolation →
      // '(system key)'; otherwise there is genuinely no key → '(no key)'. This
      // keeps a configured system key from being mislabelled as missing on the
      // user plane just because its id is not exposed.
      return _groupBy(rows, (e) => {
        if (e.keyIds && e.keyIds.length) return e.keyIds;
        if (typeof e.status === 'string' && e.status.startsWith('system-')) return ['(system key)'];
        return ['(no key)'];
      });
    case 'by-capability':
      return _groupBy(rows, e => e.capability, k => CAPABILITY_LABELS[k] || k);
    case 'by-tier':
      return _groupBy(rows, e => e.tier);
    case 'by-status':
      return _groupBy(rows, e => e.status, k => STATUS_LABELS[k] || k);
    case 'by-connection':
      return _groupBy(rows, e => e.connectionMode, k => CONNECTION_LABELS[k] || k);
    case 'flat':
    default:
      return [{ groupKey: 'all', groupLabel: '全部', edges: rows }];
  }
}

module.exports = {
  pivot,
  VIEWS,
  CAPABILITY_LABELS,
  STATUS_LABELS,
  CONNECTION_LABELS,
};
