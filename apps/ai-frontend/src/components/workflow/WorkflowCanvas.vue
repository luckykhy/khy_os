<template>
  <div class="wf-canvas" @drop="onDrop" @dragover="onDragOver">
    <VueFlow
      :nodes="store.nodes"
      :edges="store.edges"
      :node-types="nodeTypes"
      :default-viewport="{ zoom: 1 }"
      :min-zoom="0.3"
      :max-zoom="2"
      fit-view-on-init
      @nodes-change="onNodesChange"
      @edges-change="onEdgesChange"
      @connect="onConnect"
      @node-click="onNodeClick"
      @pane-click="onPaneClick"
    >
      <Background :gap="16" />
      <Controls />
      <MiniMap pannable zoomable />
    </VueFlow>
  </div>
</template>

<script setup>
import { computed, markRaw, provide } from 'vue'
import {
  VueFlow, useVueFlow,
  applyNodeChanges, applyEdgeChanges, addEdge,
} from '@vue-flow/core'
import { Background } from '@vue-flow/background'
import { Controls } from '@vue-flow/controls'
import { MiniMap } from '@vue-flow/minimap'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import '@vue-flow/controls/dist/style.css'
import '@vue-flow/minimap/dist/style.css'

import BaseNode from './nodes/BaseNode.vue'
import { useWorkflowEditorStore } from '@/stores/workflowEditor'

const props = defineProps({
  catalog: { type: Object, default: () => ({ categories: [], nodes: [] }) },
  runStatus: { type: Object, default: () => ({}) },
})

const store = useWorkflowEditorStore()
const { screenToFlowCoordinate } = useVueFlow()

// Provide the catalog so BaseNode can resolve its port spec.
provide('wfCatalog', computed(() => props.catalog))

// Provide live run status (nodeId -> status) so BaseNode can overlay execution
// state without mutating the saved graph / dirty flag.
provide('wfRunStatus', computed(() => props.runStatus || {}))

// Every catalog type renders through the generic BaseNode (catalog-driven ports).
const nodeTypes = computed(() => {
  const map = {}
  for (const n of props.catalog?.nodes || []) {
    map[n.type] = markRaw(BaseNode)
  }
  return map
})

// ── Controlled flow: the Pinia store is the single source of truth ──

function onNodesChange(changes) {
  store.setNodes(applyNodeChanges(changes, store.nodes))
}

function onEdgesChange(changes) {
  store.setEdges(applyEdgeChanges(changes, store.edges))
}

function onConnect(connection) {
  store.setEdges(addEdge(connection, store.edges))
}

function onNodeClick({ node }) {
  store.select(node.id)
}

function onPaneClick() {
  store.select(null)
}

// ── Palette drag-drop ──

function onDragOver(event) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

function onDrop(event) {
  event.preventDefault()
  const type = event.dataTransfer.getData('application/khy-node-type')
  if (!type) return
  const def = (props.catalog?.nodes || []).find((n) => n.type === type)
  if (!def) return
  // Enforce single-instance nodes (e.g. only one start).
  if (def.single && store.nodes.some((n) => n.type === type)) return

  const position = screenToFlowCoordinate({ x: event.clientX, y: event.clientY })
  store.addNode(type, position, {
    label: def.label,
    data: clone(def.defaults || {}),
  })
}

function clone(obj) {
  try {
    return JSON.parse(JSON.stringify(obj))
  } catch {
    return { ...obj }
  }
}
</script>

<style scoped>
.wf-canvas {
  width: 100%;
  height: 100%;
  min-height: 480px;
}
</style>
