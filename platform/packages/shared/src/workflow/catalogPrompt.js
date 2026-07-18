/**
 * LLM-facing projection of the workflow node catalog.
 *
 * Derives a compact, prompt-friendly specification of every node type from the
 * SAME `NODE_CATALOG` that drives the palette, the property panel, and graph
 * validation (see nodeCatalog.js). Adding a node type there automatically flows
 * into this projection — there is no second list to keep in sync.
 *
 * Consumed by workflowGenerateService to instruct an LLM to emit a canonical
 * `{ nodes, connections }` graph that passes `workflowService.validateGraph`.
 *
 * @module workflow/catalogPrompt
 */
'use strict';

const { CATEGORIES, NODE_CATALOG } = require('./nodeCatalog');

/**
 * One line per config field: `name (widget[: opt|opt])`.
 */
function _fieldSpec(field) {
  if (!field || !field.name) return '';
  let s = field.name;
  const meta = [];
  if (field.widget) meta.push(field.widget);
  if (Array.isArray(field.options) && field.options.length) {
    meta.push(field.options.join('|'));
  }
  if (meta.length) s += ` (${meta.join(': ')})`;
  return s;
}

function _portIds(ports) {
  return (Array.isArray(ports) ? ports : []).map((p) => p.id);
}

/**
 * Structured projection (machine-readable) — the basis for the text prompt and
 * useful for tests / introspection.
 * @returns {Array<{type,label,category,single,inputs:string[],outputs:string[],fields:string[],defaults:object}>}
 */
function getNodeSpecs() {
  return NODE_CATALOG.map((n) => ({
    type: n.type,
    label: n.label,
    category: n.category,
    single: !!n.single,
    inputs: _portIds(n.inputs),
    outputs: _portIds(n.outputs),
    fields: (n.fields || []).map(_fieldSpec).filter(Boolean),
    defaults: n.defaults || {},
  }));
}

/**
 * The strict output contract an LLM must follow. Mirrors the graph shape that
 * validateGraph accepts: node `{ id, type, name, position, data }` and
 * connection `{ id, from, fromPort, to, toPort }`.
 */
function getOutputContract() {
  return [
    'Return ONLY a single JSON object, no markdown fences, no prose. Shape:',
    '{',
    '  "name": "<short workflow name, 1-80 chars>",',
    '  "description": "<one-line description>",',
    '  "nodes": [',
    '    { "id": "n1", "type": "<one of the node types>", "name": "<label>",',
    '      "position": { "x": 0, "y": 0 },',
    '      "data": { /* config fields for this node type (see catalog) */ } }',
    '  ],',
    '  "connections": [',
    '    { "id": "c1", "from": "<source node id>", "fromPort": "<source output port>",',
    '      "to": "<target node id>", "toPort": "<target input port>" }',
    '  ]',
    '}',
    '',
    'Hard rules:',
    '- Use EXACTLY one "start" node (no inbound connections) and at least one "end" node (no outbound connections).',
    '- Every node id must be unique. Every connection must reference existing node ids.',
    '- fromPort must be one of the source node type\'s outputs; toPort one of the target node type\'s inputs.',
    '- Non-branch nodes use output port "default" and input port "input".',
    '- ifElse branches on outputs "branch-true"/"branch-false"; loop on "loop-body"/"loop-done".',
    '- Only use node types listed in the catalog. Put node config under "data" using the listed field names.',
    '- "position" may be {x:0,y:0}; the server auto-lays-out the canvas.',
    '- Keep the graph minimal but complete for the described task.',
  ].join('\n');
}

/**
 * Build the full catalog section of the system prompt: categories + per-node
 * spec (ports + config fields), followed by the output contract.
 * @returns {string}
 */
function buildCatalogPrompt() {
  const catLabel = new Map(CATEGORIES.map((c) => [c.id, c.label]));
  const lines = ['Available workflow node types (the ONLY types you may use):', ''];

  for (const cat of CATEGORIES) {
    const inCat = NODE_CATALOG.filter((n) => n.category === cat.id);
    if (!inCat.length) continue;
    lines.push(`## ${cat.label} (${cat.id})`);
    for (const n of inCat) {
      const ins = _portIds(n.inputs);
      const outs = _portIds(n.outputs);
      const fields = (n.fields || []).map(_fieldSpec).filter(Boolean);
      const parts = [`- ${n.type} — ${n.label}`];
      if (n.single) parts.push('[single: at most one]');
      parts.push(`| inputs: [${ins.join(', ') || 'none'}]`);
      parts.push(`outputs: [${outs.join(', ') || 'none'}]`);
      lines.push(parts.join(' '));
      if (fields.length) lines.push(`    config: ${fields.join('; ')}`);
    }
    lines.push('');
  }

  // Reference categories not already printed (defensive; keeps catLabel used).
  void catLabel;

  lines.push(getOutputContract());
  return lines.join('\n');
}

module.exports = {
  getNodeSpecs,
  getOutputContract,
  buildCatalogPrompt,
};
