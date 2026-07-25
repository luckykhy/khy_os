<template>
  <div class="node-palette">
    <div v-for="cat in categories" :key="cat.id" class="palette-group">
      <div class="palette-group__title">{{ cat.label }}</div>
      <div
        v-for="node in nodesByCategory(cat.id)"
        :key="node.type"
        class="palette-item"
        :class="`cat-${cat.id}`"
        draggable="true"
        @dragstart="onDragStart($event, node)"
      >
        {{ node.label }}
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  catalog: { type: Object, default: () => ({ categories: [], nodes: [] }) },
})

const categories = computed(() => props.catalog?.categories || [])

function nodesByCategory(catId) {
  return (props.catalog?.nodes || []).filter((n) => n.category === catId)
}

// HTML5 drag payload: the node type the canvas should instantiate on drop.
function onDragStart(event, node) {
  event.dataTransfer.setData('application/khy-node-type', node.type)
  event.dataTransfer.effectAllowed = 'move'
}
</script>

<style scoped>
.node-palette {
  width: 180px;
  padding: 8px;
  overflow-y: auto;
  border-right: 1px solid var(--el-border-color-light);
}
.palette-group__title {
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-secondary);
  margin: 10px 0 6px;
}
.palette-item {
  padding: 6px 10px;
  margin-bottom: 6px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  background: var(--el-bg-color);
  font-size: 12px;
  cursor: grab;
  user-select: none;
}
.palette-item:hover {
  border-color: var(--el-color-primary);
}
.palette-item.cat-control { border-left: 3px solid var(--el-color-primary); }
.palette-item.cat-agent { border-left: 3px solid var(--el-color-success); }
.palette-item.cat-data { border-left: 3px solid var(--el-color-warning); }
.palette-item.cat-human { border-left: 3px solid var(--el-color-danger); }
</style>
