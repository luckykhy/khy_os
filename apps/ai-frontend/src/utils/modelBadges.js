// Pure-function leaf: view-layer model badge helpers (no Vue dependency).
// Byte-identical bodies moved from views/AIChat.vue (AIGateway.vue held a
// semantically-equivalent copy, now aliased onto these exports).
//
// Source / verify provenance — state transparency: a hardcoded baseline model
// is labelled as such, never shown as a verified real one.
//
// SOURCE_LABELS domain here is model discovery provenance:
// local / remote / baseline / config / user.
// It is a DIFFERENT value domain from composables/useModelPivots.js
// SOURCE_LABELS (catalog edge domain: relay / provider / local / system).
// The two MUST NOT be merged.
export function kindLabel(kind) {
  if (kind === 'local') return '本地';
  if (kind === 'cloud') return '云端';
  return '';
}
export function kindTagType(kind) {
  if (kind === 'local') return 'success';
  if (kind === 'cloud') return 'primary';
  return 'info';
}

export const SOURCE_LABELS = {
  local: '实时',
  remote: '远程',
  baseline: '基线',
  config: '配置',
  user: '自定义',
};
export function sourceLabel(src) {
  if (!src) return '';
  return SOURCE_LABELS[src] || src;
}
export function sourceTagType(src) {
  if (src === 'local' || src === 'remote') return 'success';
  if (src === 'baseline') return 'warning';
  if (src === 'user') return 'primary';
  return 'info';
}
export function verifyLabel(s) {
  if (s === 'verified') return '已验证';
  if (s === 'failed') return '失败';
  return '未验证';
}
export function verifyTagType(s) {
  if (s === 'verified') return 'success';
  if (s === 'failed') return 'danger';
  return 'info';
}

// "Newly registered" badge: a local Ollama model that entered the registry
// within the TTL window (backend injects isNew from models-notify.jsonl).
// Distinct from verifyStatus (a connectivity check) — "new" is a freshness
// fact, not a health fact.
export function isNewBadge(m) {
  return m && m.isNew === true;
}
export function newLabel() {
  return '新';
}
export function newTagType() {
  return 'danger'; // eye-catching but not an error tone
}
