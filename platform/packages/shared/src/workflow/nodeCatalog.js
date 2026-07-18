/**
 * Workflow node-type catalog — the single source of truth.
 *
 * Describes every node type a workflow graph may contain: id, label, category,
 * input/output port spec, and the config-field schema the frontend property
 * panel renders. The SAME catalog drives:
 *   - the backend `/api/workflow/node-types` endpoint (palette + property panel)
 *   - graph validation (port checks in workflowService.validateGraph)
 *   - the Markdown exporter (node -> mermaid + instruction mapping)
 *
 * The frontend consumes it at runtime over HTTP (it cannot cleanly import this
 * CJS module from the separate Vite app), so there is exactly one definition and
 * no drift. Adding a node type = one entry here + one exporter mapping + one Vue
 * node component.
 *
 * Port handle ids are plain strings (mirrors cc-wf-studio). Non-branch nodes use
 * `input` (target) and `default` (source); branch nodes declare multiple source
 * handles (e.g. `branch-true` / `branch-false`).
 *
 * Field widgets: text | textarea | number | select | code | keyvalue-list |
 * string-list | var-ref. `options` lists choices for `select`.
 */
'use strict';

const CATEGORIES = [
  { id: 'control', label: '基础控制流' },
  { id: 'agent', label: 'Agent / 子代理' },
  { id: 'data', label: '数据 / 集成' },
  { id: 'human', label: '人机交互' },
];

// Reusable port shapes.
const IN = [{ id: 'input', label: '输入' }];
const OUT = [{ id: 'default', label: '下一步' }];

const NODE_CATALOG = [
  // ── 基础控制流 (control) ──────────────────────────────────────────────────
  {
    type: 'start',
    label: '开始',
    category: 'control',
    single: true,
    inputs: [],
    outputs: OUT,
    fields: [
      { name: 'inputs', label: '工作流输入', widget: 'keyvalue-list' },
    ],
    defaults: { inputs: [] },
  },
  {
    type: 'end',
    label: '结束',
    category: 'control',
    inputs: IN,
    outputs: [],
    fields: [
      { name: 'outputs', label: '工作流输出', widget: 'keyvalue-list' },
    ],
    defaults: { outputs: [] },
  },
  {
    type: 'prompt',
    label: '提示词',
    category: 'control',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'prompt', label: '提示词', widget: 'textarea' },
      { name: 'model', label: '模型(可选)', widget: 'text' },
      { name: 'outputVar', label: '结果变量', widget: 'text' },
    ],
    defaults: { prompt: '', model: '', outputVar: '' },
  },
  {
    type: 'ifElse',
    label: '条件分支',
    category: 'control',
    inputs: IN,
    outputs: [
      { id: 'branch-true', label: '真' },
      { id: 'branch-false', label: '假' },
    ],
    fields: [
      { name: 'expression', label: '条件表达式', widget: 'text' },
      { name: 'trueLabel', label: '真分支标签', widget: 'text' },
      { name: 'falseLabel', label: '假分支标签', widget: 'text' },
    ],
    defaults: { expression: '', trueLabel: 'True', falseLabel: 'False' },
  },
  {
    type: 'loop',
    label: '循环',
    category: 'control',
    inputs: IN,
    outputs: [
      { id: 'loop-body', label: '循环体' },
      { id: 'loop-done', label: '结束' },
    ],
    fields: [
      { name: 'mode', label: '模式', widget: 'select', options: ['count', 'forEach'] },
      { name: 'count', label: '次数(count)', widget: 'number' },
      { name: 'itemsVar', label: '集合变量(forEach)', widget: 'var-ref' },
      { name: 'itemVar', label: '元素变量(forEach)', widget: 'text' },
    ],
    defaults: { mode: 'count', count: 1, itemsVar: '', itemVar: 'item' },
  },

  // ── Agent / 子代理 (agent) ─────────────────────────────────────────────────
  {
    type: 'subAgent',
    label: '子代理',
    category: 'agent',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'agentName', label: '代理名称', widget: 'text' },
      { name: 'instructions', label: '指令', widget: 'textarea' },
      { name: 'model', label: '模型(可选)', widget: 'text' },
      { name: 'tools', label: '可用工具', widget: 'string-list' },
      { name: 'maxTurns', label: '最大轮数', widget: 'number' },
      { name: 'outputVar', label: '结果变量', widget: 'text' },
    ],
    defaults: { agentName: '', instructions: '', model: '', tools: [], maxTurns: 0, outputVar: '' },
  },
  {
    type: 'toolCall',
    label: '工具调用',
    category: 'agent',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'tool', label: '工具名', widget: 'text' },
      { name: 'args', label: '参数(JSON)', widget: 'code', language: 'json' },
      { name: 'outputVar', label: '结果变量', widget: 'text' },
    ],
    defaults: { tool: '', args: {}, outputVar: '' },
  },
  {
    type: 'skill',
    label: '技能',
    category: 'agent',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'skillName', label: '技能名', widget: 'text' },
      { name: 'args', label: '参数(JSON)', widget: 'code', language: 'json' },
    ],
    defaults: { skillName: '', args: {} },
  },

  // ── 数据 / 集成 (data) ─────────────────────────────────────────────────────
  {
    type: 'code',
    label: '代码',
    category: 'data',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'language', label: '语言', widget: 'select', options: ['bash', 'js'] },
      { name: 'source', label: '源码', widget: 'code', language: 'bash' },
      { name: 'outputVar', label: '结果变量', widget: 'text' },
    ],
    defaults: { language: 'bash', source: '', outputVar: '' },
  },
  {
    type: 'http',
    label: 'HTTP 请求',
    category: 'data',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'method', label: '方法', widget: 'select', options: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] },
      { name: 'url', label: 'URL', widget: 'text' },
      { name: 'headers', label: '请求头(JSON)', widget: 'code', language: 'json' },
      { name: 'body', label: '请求体', widget: 'textarea' },
      { name: 'outputVar', label: '响应变量', widget: 'text' },
    ],
    defaults: { method: 'GET', url: '', headers: {}, body: '', outputVar: '' },
  },

  // ── 人机交互 (human) ──────────────────────────────────────────────────────
  {
    type: 'askUserQuestion',
    label: '询问用户',
    category: 'human',
    inputs: IN,
    outputs: OUT,
    fields: [
      { name: 'question', label: '问题', widget: 'textarea' },
      { name: 'options', label: '选项', widget: 'string-list' },
      { name: 'answerVar', label: '回答变量', widget: 'text' },
    ],
    defaults: { question: '', options: [], answerVar: 'answer' },
  },
];

const BY_TYPE = new Map(NODE_CATALOG.map((n) => [n.type, n]));

function getCatalog() {
  return { categories: CATEGORIES, nodes: NODE_CATALOG };
}

function getNodeType(type) {
  return BY_TYPE.get(type) || null;
}

// Valid source/target handle ids for a node type (for graph validation).
function portsFor(type) {
  const def = BY_TYPE.get(type);
  if (!def) return { inputs: [], outputs: [] };
  return {
    inputs: (def.inputs || []).map((p) => p.id),
    outputs: (def.outputs || []).map((p) => p.id),
  };
}

module.exports = {
  CATEGORIES,
  NODE_CATALOG,
  getCatalog,
  getNodeType,
  portsFor,
};
