import { defineStore } from 'pinia'
import { canvasToGraph, graphToCanvas } from '@/components/workflow/graphAdapters'

/**
 * Canvas editor state for a single open workflow.
 *
 * Holds the Vue Flow `nodes`/`edges`, the selected node id, dirty tracking, and
 * workflow meta (id/name/description/version). Mirrors the role of cc-wf-studio's
 * zustand store but uses the project's existing Pinia infra. `exportPayload()`
 * produces the canonical graph the backend PUT expects.
 */
let _seq = 0
function uid(prefix) {
  _seq += 1
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`
}

export const useWorkflowEditorStore = defineStore('workflowEditor', {
  state: () => ({
    meta: { id: null, name: '', description: '', version: 1 },
    nodes: [],
    edges: [],
    selectedId: null,
    dirty: false,
  }),

  getters: {
    selectedNode(state) {
      return state.nodes.find((n) => n.id === state.selectedId) || null
    },
  },

  actions: {
    // Load a full workflow record ({ id, name, description, version, graph }).
    loadWorkflow(record) {
      this.meta = {
        id: record.id,
        name: record.name || '',
        description: record.description || '',
        version: record.version || 1,
      }
      const { nodes, edges } = graphToCanvas(record.graph || {})
      this.nodes = nodes
      this.edges = edges
      this.selectedId = null
      this.dirty = false
    },

    markDirty() {
      this.dirty = true
    },

    select(id) {
      this.selectedId = id
    },

    addNode(type, position, defaults = {}) {
      const id = uid('n')
      const node = {
        id,
        type,
        position: { x: position?.x ?? 0, y: position?.y ?? 0 },
        label: defaults.label || type,
        data: { ...defaults.data, name: defaults.label || type },
      }
      this.nodes.push(node)
      this.selectedId = id
      this.markDirty()
      return node
    },

    // Apply Vue Flow's onNodesChange / onEdgesChange deltas (position, removal).
    setNodes(nodes) {
      this.nodes = nodes
      this.markDirty()
    },

    setEdges(edges) {
      this.edges = edges
      this.markDirty()
    },

    updateNodeData(id, patch) {
      const node = this.nodes.find((n) => n.id === id)
      if (!node) return
      node.data = { ...node.data, ...patch }
      this.markDirty()
    },

    renameNode(id, name) {
      const node = this.nodes.find((n) => n.id === id)
      if (!node) return
      node.label = name
      node.data = { ...node.data, name }
      this.markDirty()
    },

    removeNode(id) {
      this.nodes = this.nodes.filter((n) => n.id !== id)
      this.edges = this.edges.filter((e) => e.source !== id && e.target !== id)
      if (this.selectedId === id) this.selectedId = null
      this.markDirty()
    },

    // Canonical graph payload for PUT /api/workflow/:id.
    exportPayload() {
      return {
        name: this.meta.name,
        description: this.meta.description,
        graph: canvasToGraph(this.nodes, this.edges, {
          id: this.meta.id,
          name: this.meta.name,
          description: this.meta.description,
        }),
      }
    },

    markSaved(record) {
      if (record && record.version != null) this.meta.version = record.version
      this.dirty = false
    },
  },
})
