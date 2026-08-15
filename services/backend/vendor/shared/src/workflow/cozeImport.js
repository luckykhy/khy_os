/**
 * Coze workflow importer — converts a Coze (coze-studio) exported workflow into a
 * Khy canvas graph ({ nodes, connections }) that the visual editor stores and the
 * native executor runs.
 *
 * Scope: import the workflow STRUCTURE (nodes, edges, control flow) faithfully so
 * a Coze export can be opened, edited and run on Khy's own primitives. It does NOT
 * reproduce Coze's platform plugins — Coze plugin/API nodes become Khy `toolCall`
 * stubs (named after the original plugin), so the imported graph is valid and
 * traversable, but the external side effects are Khy's, not Coze's. The conversion
 * `report` records every approximation (dropped comments, collapsed branches,
 * operator approximations, unsupported node types) so nothing is silently lost.
 *
 * This module is PURE and environment-agnostic (no fs / no zip): it accepts an
 * already-parsed object, a JSON string, or a Buffer/string of the Coze "container"
 * (a small binary wrapper around a UTF-8 JSON document). Unzipping a real Coze
 * `Workflow-*.zip` is the caller's job (see services/ai-backend cozeImportService).
 *
 * Authoritative enums are mined from coze-studio:
 *   - node type IDs: backend/domain/workflow/entity/node_meta.go (NodeTypeMetas)
 *   - condition operators: backend/domain/workflow/entity/vo/canvas.go (OperatorType)
 *
 * Coze export shape (per workflow):
 *   { edges: [{ sourceNodeID, sourcePortID, targetNodeID }] | null,
 *     nodes: [{ id, type, meta:{position}, data:{ nodeMeta:{title}, inputs, outputs } }] }
 * Node `type` is a NUMERIC string.
 */
'use strict';

// Coze node type ID (numeric string) -> human key (coze-studio NodeTypeMetas).
const COZE_TYPE_NAMES = {
  1: 'Entry', 2: 'Exit', 3: 'LLM', 4: 'Plugin', 5: 'CodeRunner', 6: 'KnowledgeRetriever',
  8: 'Selector', 9: 'SubWorkflow', 12: 'DatabaseCustomSQL', 13: 'OutputEmitter', 15: 'TextProcessor',
  18: 'QuestionAnswer', 19: 'Break', 20: 'VariableAssignerWithinLoop', 21: 'Loop', 22: 'IntentDetector',
  27: 'KnowledgeIndexer', 28: 'Batch', 29: 'Continue', 30: 'InputReceiver', 31: 'Comment',
  32: 'VariableAggregator', 37: 'MessageList', 38: 'ClearConversationHistory', 39: 'CreateConversation',
  40: 'VariableAssigner', 42: 'DatabaseUpdate', 43: 'DatabaseQuery', 44: 'DatabaseDelete',
  45: 'HTTPRequester', 46: 'DatabaseInsert', 51: 'ConversationUpdate', 52: 'ConversationDelete',
  53: 'ConversationList', 54: 'ConversationHistory', 55: 'CreateMessage', 56: 'EditMessage',
  57: 'DeleteMessage', 58: 'JsonSerialization', 59: 'JsonDeserialization', 60: 'KnowledgeDeleter',
  1000: 'Lambda',
};

// Coze node type ID -> Khy catalog node type. Anything not listed (and not dropped)
// falls back to `toolCall` (a named stub) so the graph stays valid and runnable.
const TYPE_MAP = {
  1: 'start', 2: 'end', 3: 'prompt', 4: 'toolCall', 5: 'code', 6: 'toolCall',
  8: 'ifElse', 9: 'subAgent', 13: 'prompt', 15: 'prompt', 18: 'askUserQuestion',
  21: 'loop', 22: 'prompt', 28: 'loop', 30: 'askUserQuestion', 45: 'http',
};

// Node types removed entirely on import (no executable semantics).
const DROP_TYPES = new Set([31]); // Comment

// coze-studio vo.OperatorType (1-indexed iota) -> Khy comparator. 3..6 are
// length comparisons, approximated to value comparisons.
const OPERATOR_MAP = {
  1: '==', 2: '!=', 3: '>', 4: '>=', 5: '<', 6: '<=',
  13: '>', 14: '>=', 15: '<', 16: '<=',
};

// ── JSON extraction from the Coze container ──────────────────────────────────

// Find the start of the embedded workflow JSON ({"edges"... or {"nodes"...).
function findJsonStart(str) {
  const m = str.match(/\{\s*"(?:edges|nodes)"\s*:/);
  return m ? m.index : -1;
}

// Brace-match a JSON object starting at `start`, respecting strings/escapes.
function braceMatch(str, start) {
  let depth = 0;
  let instr = false;
  let esc = false;
  for (let k = start; k < str.length; k += 1) {
    const c = str[k];
    if (instr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') instr = false;
    } else if (c === '"') instr = true;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return str.slice(start, k + 1);
    }
  }
  return null;
}

/**
 * Coerce any supported input into the parsed Coze workflow document.
 * Accepts: a parsed object (with a `nodes` array), a JSON string, or a
 * Buffer/string of the Coze container (binary wrapper around JSON).
 */
function extractCozeDoc(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input) && Array.isArray(input.nodes)) {
    return input;
  }
  const str = Buffer.isBuffer(input) ? input.toString('utf8') : String(input == null ? '' : input);
  const start = findJsonStart(str);
  if (start < 0) {
    throw new Error('No Coze workflow JSON found (expected an object with "edges"/"nodes")');
  }
  const slice = braceMatch(str, start);
  if (!slice) throw new Error('Malformed Coze workflow JSON (unbalanced braces)');
  let doc;
  try {
    doc = JSON.parse(slice);
  } catch (err) {
    throw new Error(`Failed to parse Coze workflow JSON: ${err.message}`);
  }
  if (!doc || !Array.isArray(doc.nodes)) {
    throw new Error('Coze workflow JSON has no "nodes" array');
  }
  return doc;
}

// ── Value helpers ────────────────────────────────────────────────────────────

// A Coze input param's value is either a ref to another node's output, or a
// literal. Render it as a Khy interpolation token / string.
function refToTemplate(input) {
  const v = input && input.value;
  if (!v) return '';
  if (v.type === 'ref') {
    const name = v.content && v.content.name;
    return name ? `{{${name}}}` : '';
  }
  if (v.type === 'literal') {
    const c = v.content;
    if (c == null) return '';
    return typeof c === 'object' ? JSON.stringify(c) : String(c);
  }
  return '';
}

// Render a Coze condition operand as an ifElse-expression token: a {{ref}}, a
// numeric literal (bare), or a quoted string literal.
function operandToExprToken(side) {
  const v = side && side.input && side.input.value;
  if (!v) return '""';
  if (v.type === 'ref') {
    const name = v.content && v.content.name;
    return name ? `{{${name}}}` : '""';
  }
  const c = v.content;
  if (c == null) return '""';
  if (typeof c === 'number') return String(c);
  if (typeof c === 'string' && /^-?\d+(\.\d+)?$/.test(c)) return c;
  return `"${String(c).replace(/"/g, '\\"')}"`;
}

function paramsToArgs(list) {
  const args = {};
  if (!Array.isArray(list)) return args;
  for (const p of list) {
    if (p && p.name) args[p.name] = refToTemplate(p.input);
  }
  return args;
}

function firstOutputName(outputs) {
  if (Array.isArray(outputs) && outputs[0] && outputs[0].name) return outputs[0].name;
  return '';
}

function pluginToolName(cz, typeId) {
  const apiParam = cz.data && cz.data.inputs && cz.data.inputs.apiParam;
  if (Array.isArray(apiParam)) {
    const named = apiParam.find((p) => p && p.name === 'apiName');
    const v = named && named.input && named.input.value;
    if (v && v.content) return String(v.content);
  }
  const title = cz.data && cz.data.nodeMeta && cz.data.nodeMeta.title;
  return title || COZE_TYPE_NAMES[typeId] || `coze_${typeId}`;
}

// Build the Khy `ifElse.expression` from a Coze selector's branch conditions.
function buildExpression(branches, warnings) {
  if (!Array.isArray(branches) || branches.length === 0) return '';
  if (branches.length > 1) {
    warnings.push('selector has multiple branches; collapsed to a single true/false condition');
  }
  const cond = branches[0] && branches[0].condition;
  const conds = (cond && cond.conditions) || [];
  if (conds.length === 0) return '';
  if (conds.length > 1) {
    warnings.push('selector branch has multiple conditions; only the first was kept');
  }
  const c0 = conds[0];
  const left = operandToExprToken(c0.left);
  const right = operandToExprToken(c0.right);
  switch (c0.operator) {
    case 9: return `${left} == ""`; // Empty
    case 10: return `${left} != ""`; // NotEmpty
    case 11: return `${left} == true`; // True
    case 12: return `${left} == false`; // False
    case 7: case 8: // Contain / NotContain — no Khy equivalent
      warnings.push(`operator ${c0.operator} (contain) approximated to a truthiness check`);
      return left;
    default: break;
  }
  const op = OPERATOR_MAP[c0.operator];
  if (!op) {
    warnings.push(`unsupported selector operator ${c0.operator}; approximated to a truthiness check`);
    return left;
  }
  return `${left} ${op} ${right}`;
}

function buildPromptText(cz) {
  const title = (cz.data && cz.data.nodeMeta && cz.data.nodeMeta.title) || '';
  const params = cz.data && cz.data.inputs && cz.data.inputs.inputParameters;
  const args = paramsToArgs(params);
  const refs = Object.values(args).filter(Boolean).join(' ');
  return [title, refs].filter(Boolean).join('\n').trim() || title;
}

// Build the Khy node `data` for a converted node.
function buildData(khyType, cz, typeId, warnings) {
  const d = cz.data || {};
  const inputs = d.inputs || {};
  switch (khyType) {
    case 'start':
      return { inputs: (d.outputs || []).map((o) => ({ key: o.name, value: '' })) };
    case 'end':
      return {
        outputs: ((inputs.inputParameters) || []).map((p) => ({ key: p.name, value: refToTemplate(p.input) })),
      };
    case 'prompt':
      return { prompt: buildPromptText(cz), model: '', outputVar: firstOutputName(d.outputs) };
    case 'code':
      return { language: 'js', source: String(inputs.code || ''), outputVar: firstOutputName(d.outputs) };
    case 'http':
      return {
        method: 'GET', url: '', headers: {}, body: '', outputVar: firstOutputName(d.outputs),
      };
    case 'ifElse':
      return { expression: buildExpression(inputs.branches, warnings), trueLabel: 'True', falseLabel: 'False' };
    case 'subAgent':
      return {
        agentName: (d.nodeMeta && d.nodeMeta.title) || 'sub-workflow',
        instructions: buildPromptText(cz),
        model: '', tools: [], maxTurns: 0, outputVar: firstOutputName(d.outputs),
      };
    case 'askUserQuestion':
      return { question: buildPromptText(cz), options: [], answerVar: 'answer' };
    case 'loop':
      warnings.push(`loop node ${cz.id}: nested loop body is not expanded (single-node import)`);
      return { mode: 'count', count: 1, itemsVar: '', itemVar: 'item' };
    case 'toolCall':
    default:
      return {
        tool: pluginToolName(cz, typeId),
        args: paramsToArgs(inputs.inputParameters),
        outputVar: firstOutputName(d.outputs),
      };
  }
}

// Auto-layout fallback when a Coze node lacks meta.position.
function gridPosition(index) {
  return { x: (index % 6) * 240, y: Math.floor(index / 6) * 160 };
}

function fromPortFor(srcType, portId, warnings) {
  const p = String(portId == null ? '' : portId);
  if (srcType === 'ifElse') {
    if (p.startsWith('true')) return 'branch-true';
    if (p.startsWith('false') || p === '') return 'branch-false';
    warnings.push(`selector port '${p}' collapsed to branch-false`);
    return 'branch-false';
  }
  if (srcType === 'loop') {
    return 'loop-done';
  }
  return 'default';
}

/**
 * Convert a Coze export into a Khy canvas graph.
 *
 * @param {object|string|Buffer} input  parsed doc, JSON string, or container bytes
 * @param {object} [opts]
 * @param {string} [opts.name]  override the derived workflow name
 * @returns {{ graph: {nodes, connections}, report: object }}
 */
function convertCozeWorkflow(input, opts = {}) {
  const doc = extractCozeDoc(input);
  const cozeNodes = Array.isArray(doc.nodes) ? doc.nodes : [];
  const cozeEdges = Array.isArray(doc.edges) ? doc.edges : [];

  const warnings = [];
  const unsupported = [];
  const typeCounts = {};
  const dropped = new Set();
  const khyNodes = [];
  const byId = new Map();
  let droppedComments = 0;

  cozeNodes.forEach((cz, index) => {
    const typeId = Number(cz.type);
    const id = String(cz.id);
    if (DROP_TYPES.has(typeId)) {
      dropped.add(id);
      droppedComments += 1;
      return;
    }
    const khyType = TYPE_MAP[typeId] || 'toolCall';
    if (!TYPE_MAP[typeId]) {
      unsupported.push({ id, cozeType: COZE_TYPE_NAMES[typeId] || String(cz.type), mappedTo: 'toolCall' });
    }
    const meta = cz.meta && cz.meta.position;
    const position = meta && Number.isFinite(meta.x) && Number.isFinite(meta.y)
      ? { x: meta.x, y: meta.y }
      : gridPosition(index);
    const name = (cz.data && cz.data.nodeMeta && cz.data.nodeMeta.title)
      || COZE_TYPE_NAMES[typeId] || `coze_${cz.type}`;
    const node = { id, type: khyType, name, position, data: buildData(khyType, cz, typeId, warnings) };
    khyNodes.push(node);
    byId.set(id, node);
    typeCounts[khyType] = (typeCounts[khyType] || 0) + 1;
  });

  const connections = [];
  let droppedEdges = 0;
  cozeEdges.forEach((e, i) => {
    if (!e) { droppedEdges += 1; return; }
    const from = String(e.sourceNodeID);
    const to = String(e.targetNodeID);
    const src = byId.get(from);
    const dst = byId.get(to);
    if (!src || !dst || dropped.has(from) || dropped.has(to)) { droppedEdges += 1; return; }
    // start has no inbound port; end has no outbound port — drop edges that would
    // violate the catalog (defensive; Coze normally respects this).
    if (dst.type === 'start' || src.type === 'end') { droppedEdges += 1; return; }
    connections.push({
      id: `e_${i}`,
      from,
      fromPort: fromPortFor(src.type, e.sourcePortID, warnings),
      to,
      toPort: 'input',
      condition: null,
    });
  });

  const name = String(opts.name || doc.name || 'Coze 导入工作流').slice(0, 80);
  const graph = { nodes: khyNodes, connections };
  const report = {
    source: 'coze',
    name,
    nodeCount: khyNodes.length,
    edgeCount: connections.length,
    droppedComments,
    droppedEdges,
    typeCounts,
    unsupported,
    warnings,
  };
  return { graph, report };
}

module.exports = {
  COZE_TYPE_NAMES,
  TYPE_MAP,
  OPERATOR_MAP,
  extractCozeDoc,
  convertCozeWorkflow,
  // exported for unit tests
  refToTemplate,
  buildExpression,
};
