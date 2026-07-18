<template>
  <div class="wf-node" :class="[`cat-${def?.category || 'control'}`, { selected }, runStatusClass]">
    <!-- target (input) handles on the left -->
    <Handle
      v-for="(p, i) in inputs"
      :key="`in-${p.id}`"
      :id="p.id"
      type="target"
      :position="Position.Left"
      :style="handleStyle(i, inputs.length)"
    />

    <div class="wf-node__head">
      <span class="wf-node__type">{{ def?.label || type }}</span>
      <span v-if="runStatus" class="wf-node__run" :class="`run-${runStatus}`">{{ RUN_BADGE[runStatus] || '' }}</span>
    </div>
    <div class="wf-node__name">{{ data?.name || type }}</div>

    <!-- source (output) handles on the right, labelled for branch nodes -->
    <Handle
      v-for="(p, i) in outputs"
      :key="`out-${p.id}`"
      :id="p.id"
      type="source"
      :position="Position.Right"
      :style="handleStyle(i, outputs.length)"
    />
    <div v-if="outputs.length > 1" class="wf-node__ports">
      <span v-for="p in outputs" :key="`lbl-${p.id}`" class="wf-node__port-label">{{ p.label }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, inject, unref } from 'vue'
import { Handle, Position } from '@vue-flow/core'

const props = defineProps({
  id: { type: String, required: true },
  type: { type: String, required: true },
  data: { type: Object, default: () => ({}) },
  selected: { type: Boolean, default: false },
})

// Catalog provided by WorkflowCanvas (single source of truth for ports).
// Injected as a ComputedRef → unwrap before use.
const catalog = inject('wfCatalog', { nodes: [] })
const def = computed(() => {
  const c = unref(catalog) || { nodes: [] }
  return (c.nodes || []).find((n) => n.type === props.type) || null
})
const inputs = computed(() => def.value?.inputs || [])
const outputs = computed(() => def.value?.outputs || [])

// Live run status (nodeId -> status) overlaid during a run; absent in pure edit.
const runStatusMap = inject('wfRunStatus', { value: {} })
const runStatus = computed(() => {
  const m = unref(runStatusMap) || {}
  return m[props.id] || ''
})
const runStatusClass = computed(() => (runStatus.value ? `run-state run-${runStatus.value}` : ''))

// Compact glyph badge per status (no extra icon deps).
const RUN_BADGE = {
  running: '▶',
  awaiting_input: '⏸',
  succeeded: '✓',
  failed: '✕',
  skipped: '–',
}

// Spread multiple handles vertically along the node edge.
function handleStyle(index, total) {
  if (total <= 1) return {}
  const pct = ((index + 1) / (total + 1)) * 100
  return { top: `${pct}%` }
}
</script>

<style scoped>
.wf-node {
  min-width: 140px;
  border-radius: 8px;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  padding: 8px 12px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  font-size: 12px;
}
.wf-node.selected {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-7);
}
.wf-node__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.wf-node__type {
  font-size: 11px;
  color: var(--el-text-color-secondary);
}
.wf-node__name {
  margin-top: 4px;
  font-weight: 600;
  color: var(--el-text-color-primary);
  word-break: break-all;
}
.wf-node__ports {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.wf-node__port-label {
  font-size: 10px;
  color: var(--el-text-color-secondary);
}
/* category accents (left border) */
.cat-control { border-left: 3px solid var(--el-color-primary); }
.cat-agent { border-left: 3px solid var(--el-color-success); }
.cat-data { border-left: 3px solid var(--el-color-warning); }
.cat-human { border-left: 3px solid var(--el-color-danger); }

/* ── live run-state overlay (active only during a run) ── */
.wf-node__run {
  font-size: 11px;
  line-height: 1;
  font-weight: 700;
}
.wf-node__run.run-running { color: var(--el-color-primary); }
.wf-node__run.run-awaiting_input { color: var(--el-color-warning); }
.wf-node__run.run-succeeded { color: var(--el-color-success); }
.wf-node__run.run-failed { color: var(--el-color-danger); }
.wf-node__run.run-skipped { color: var(--el-text-color-secondary); }

.wf-node.run-state { transition: box-shadow 0.2s ease, border-color 0.2s ease; }
.wf-node.run-running {
  border-color: var(--el-color-primary);
  box-shadow: 0 0 0 2px var(--el-color-primary-light-5);
  animation: wf-pulse 1.1s ease-in-out infinite;
}
.wf-node.run-awaiting_input {
  border-color: var(--el-color-warning);
  box-shadow: 0 0 0 2px var(--el-color-warning-light-5);
}
.wf-node.run-succeeded { border-color: var(--el-color-success); }
.wf-node.run-failed {
  border-color: var(--el-color-danger);
  box-shadow: 0 0 0 2px var(--el-color-danger-light-5);
}
.wf-node.run-skipped { opacity: 0.7; }

@keyframes wf-pulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--el-color-primary-light-5); }
  50% { box-shadow: 0 0 0 4px var(--el-color-primary-light-7); }
}
</style>
