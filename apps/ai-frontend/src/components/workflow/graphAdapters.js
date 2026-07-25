/**
 * Canvas <-> canonical-graph adapters.
 *
 * The backend stores the canonical graph `{ nodes, connections }` (the single
 * source of truth). Vue Flow works with `{ nodes, edges }` using slightly
 * different field names. These two pure functions convert between them so the
 * editor can round-trip: load graph -> canvas -> edit -> graph -> save.
 *
 * Mapping (mirrors cc-wf-studio createWorkflowFromCanvas / addGeneratedWorkflow):
 *   graph node {id,type,name,position,data} <-> vf node {id,type,position,label,data}
 *   graph conn {id,from,fromPort,to,toPort,condition}
 *                         <-> vf edge {id,source,sourceHandle,target,targetHandle,label}
 */

// Vue Flow nodes/edges -> canonical graph.
export function canvasToGraph(vfNodes = [], vfEdges = [], meta = {}) {
  const nodes = vfNodes.map((n) => ({
    id: n.id,
    type: n.type,
    name: n.label || (n.data && n.data.name) || n.type,
    position: { x: Math.round(n.position?.x ?? 0), y: Math.round(n.position?.y ?? 0) },
    data: stripInternal(n.data),
  }))

  const connections = vfEdges.map((e) => ({
    id: e.id,
    from: e.source,
    fromPort: e.sourceHandle || 'default',
    to: e.target,
    toPort: e.targetHandle || 'input',
    condition: e.label != null && e.label !== '' ? String(e.label) : null,
  }))

  return {
    ...(meta.id ? { id: meta.id } : {}),
    ...(meta.name ? { name: meta.name } : {}),
    ...(meta.description != null ? { description: meta.description } : {}),
    nodes,
    connections,
  }
}

// Canonical graph -> Vue Flow nodes/edges.
export function graphToCanvas(graph = {}) {
  const gNodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const gConns = Array.isArray(graph.connections) ? graph.connections : []

  const nodes = gNodes.map((n) => ({
    id: n.id,
    type: n.type,
    position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
    label: n.name || n.type,
    data: { ...(n.data || {}), name: n.name || n.type },
  }))

  const edges = gConns.map((c) => ({
    id: c.id,
    source: c.from,
    sourceHandle: c.fromPort || 'default',
    target: c.to,
    targetHandle: c.toPort || 'input',
    ...(c.condition ? { label: c.condition } : {}),
  }))

  return { nodes, edges }
}

// Drop the editor-only `name` mirror before persisting node.data.
function stripInternal(data) {
  if (!data || typeof data !== 'object') return {}
  const out = { ...data }
  delete out.name
  return out
}
