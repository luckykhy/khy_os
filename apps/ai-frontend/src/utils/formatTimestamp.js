// Pure-function leaf: timestamp formatting shared by list views.
// Byte-identical body moved from views/Projects.vue / views/Workflows.vue
// (the two copies were verified byte-identical before extraction).
export function formatTime(t) {
  if (!t) return '-';
  try {
    return new Date(t).toLocaleString();
  } catch {
    return String(t);
  }
}
