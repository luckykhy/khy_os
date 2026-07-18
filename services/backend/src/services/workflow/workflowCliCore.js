/**
 * workflowCliCore.js — 纯叶子:`khy workflow` CLI 的确定性核心。
 *
 * 契约:零 IO、确定性、fail-soft 绝不抛、env 门控默认开(`KHY_WORKFLOW_CLI`,
 * 仅 `0/false/off/no` 关闭即字节回退)、单一真源。所有读写文件 / 调 runGraph /
 * 调 cozeImport 的副作用都留在调用方(`cli/handlers/workflow.js`);本叶子只对
 * 已读入的 canonical 图 `{ nodes, connections }` 做纯数据变换:输入解析、结构校验、
 * 摘要、Mermaid 渲染、导入报告格式化、文件名 slug 化。
 *
 * 设计动机:khy 已在生产侧具备完整工作流子系统(canonical 解释器 workflowExecutor
 * + Coze 导入器 @khy/shared/workflow/cozeImport + REST + Vue 编辑器),唯独缺一个
 * 从 khy CLI 直接 import/list/run/validate 的可达面。本叶子承载该 CLI 的纯逻辑,
 * 复用既有 Engine A,绝不另造第二套引擎。
 *
 * 端口词汇是 nodeCatalog(SSOT)的:source `default`/`branch-true`/`branch-false`/
 * `loop-body`/`loop-done`,target `input`。为保持纯净,`validateGraph` 把
 * `portsFor`/`knownTypes` 作为参数注入,不在叶子里 require catalog。
 */
'use strict';

function _enabled() {
  const v = String(process.env.KHY_WORKFLOW_CLI == null ? '' : process.env.KHY_WORKFLOW_CLI)
    .trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

// ── 输入解析 ────────────────────────────────────────────────────────────────

// 解析一个标量 token:JSON(数字/布尔/null/对象/数组/带引号字符串)优先,失败则原样字符串。
function _coerceScalar(raw) {
  if (raw == null) return '';
  const s = String(raw);
  const t = s.trim();
  if (t === '') return s;
  // 仅对看起来像 JSON 标量/容器的串尝试 JSON.parse,避免把裸字符串误判。
  if (/^-?\d+(\.\d+)?$/.test(t) || t === 'true' || t === 'false' || t === 'null'
    || (t[0] === '"' && t[t.length - 1] === '"')
    || (t[0] === '{' && t[t.length - 1] === '}')
    || (t[0] === '[' && t[t.length - 1] === ']')) {
    try { return JSON.parse(t); } catch { /* 原样字符串 */ }
  }
  return s;
}

/**
 * 把 `["k=v", "n=3", "flag=true"]` 解析为初始变量袋。
 * - 只在第一个 `=` 处切分(值里允许含 `=`)。
 * - 无 `=` 的项忽略(fail-soft)。
 * - 门控关 → 返回 {}(字节回退:CLI 不注入任何初始变量)。
 * @param {string[]} pairs
 * @returns {object}
 */
function parseInputs(pairs) {
  const out = {};
  if (!_enabled() || !Array.isArray(pairs)) return out;
  for (const item of pairs) {
    if (item == null) continue;
    const s = String(item);
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    if (!key) continue;
    out[key] = _coerceScalar(s.slice(eq + 1));
  }
  return out;
}

// ── 结构校验(端口感知,纯·把 catalog 能力注入)────────────────────────────

/**
 * 校验 canonical 图。镜像 ai-backend workflowService.validateGraph 的判据,但
 * **返回** `{ ok, errors }` 而非抛(fail-soft),且把 catalog 能力作为参数注入。
 * @param {object} graph  `{ nodes, connections }`
 * @param {object} [opts]
 * @param {(type:string)=>{inputs:string[],outputs:string[]}} [opts.portsFor]
 * @param {Set<string>|string[]} [opts.knownTypes]  已知节点类型集合
 * @param {boolean} [opts.strict]  额外要求恰好一个 start、≥1 end、端点无非法入/出边
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateGraph(graph, opts = {}) {
  const errors = [];
  if (!graph || typeof graph !== 'object') {
    return { ok: false, errors: ['graph 必须是对象'] };
  }
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const conns = Array.isArray(graph.connections) ? graph.connections : [];
  const portsFor = typeof opts.portsFor === 'function' ? opts.portsFor : null;
  const known = opts.knownTypes instanceof Set
    ? opts.knownTypes
    : (Array.isArray(opts.knownTypes) ? new Set(opts.knownTypes) : null);

  const nodeById = new Map();
  for (const n of nodes) {
    if (!n || typeof n !== 'object') { errors.push('非法节点条目'); continue; }
    if (!n.id) { errors.push('节点缺少 id'); continue; }
    if (nodeById.has(n.id)) { errors.push(`重复节点 id: ${n.id}`); continue; }
    nodeById.set(n.id, n);
    if (known && !known.has(n.type)) errors.push(`未知节点类型 '${n.type}'(节点 ${n.id})`);
  }

  const connIds = new Set();
  const inbound = new Map();
  const outbound = new Map();
  for (const c of conns) {
    if (!c || typeof c !== 'object') { errors.push('非法连接条目'); continue; }
    if (c.id) {
      if (connIds.has(c.id)) errors.push(`重复连接 id: ${c.id}`);
      else connIds.add(c.id);
    }
    const src = nodeById.get(c.from);
    const dst = nodeById.get(c.to);
    if (!src) { errors.push(`连接 ${c.id || ''} 引用了不存在的源节点 '${c.from}'`); continue; }
    if (!dst) { errors.push(`连接 ${c.id || ''} 引用了不存在的目标节点 '${c.to}'`); continue; }
    const fromPort = c.fromPort || 'default';
    const toPort = c.toPort || 'input';
    if (portsFor) {
      if (!portsFor(src.type).outputs.includes(fromPort)) {
        errors.push(`非法源端口 '${fromPort}' on ${src.type}(节点 ${src.id})`);
      }
      if (!portsFor(dst.type).inputs.includes(toPort)) {
        errors.push(`非法目标端口 '${toPort}' on ${dst.type}(节点 ${dst.id})`);
      }
    }
    outbound.set(c.from, (outbound.get(c.from) || 0) + 1);
    inbound.set(c.to, (inbound.get(c.to) || 0) + 1);
  }

  if (opts.strict) {
    const starts = nodes.filter((n) => n && n.type === 'start');
    const ends = nodes.filter((n) => n && n.type === 'end');
    if (starts.length !== 1) errors.push(`图必须恰好有一个 start 节点(实际 ${starts.length})`);
    for (const s of starts) {
      if (inbound.get(s.id)) errors.push(`start 节点 ${s.id} 不应有入边`);
    }
    if (ends.length < 1) errors.push('图必须至少有一个 end 节点');
    for (const e of ends) {
      if (outbound.get(e.id)) errors.push(`end 节点 ${e.id} 不应有出边`);
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── 摘要 ────────────────────────────────────────────────────────────────────

/**
 * 把图压缩成可读摘要(用于 `show` / `list`)。
 * @param {object} graph
 * @returns {{nodeCount:number, edgeCount:number, typeCounts:object, start:?string,
 *           ends:string[], nodes:Array<{id,type,name}>}}
 */
function summarizeGraph(graph) {
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const conns = (graph && Array.isArray(graph.connections)) ? graph.connections : [];
  const typeCounts = {};
  const list = [];
  let start = null;
  const ends = [];
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const type = n.type == null ? 'unknown' : String(n.type);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (type === 'start' && start == null) start = n.id;
    if (type === 'end') ends.push(n.id);
    list.push({ id: n.id, type, name: n.name || type });
  }
  return { nodeCount: list.length, edgeCount: conns.length, typeCounts, start, ends, nodes: list };
}

// ── Mermaid 渲染(用于 `show --mermaid`)─────────────────────────────────────

function _mmId(id) {
  // Mermaid 节点 id 只允许字母数字下划线;其余字符替换。
  return 'n_' + String(id == null ? '' : id).replace(/[^A-Za-z0-9_]/g, '_');
}

function _mmLabel(text) {
  return String(text == null ? '' : text).replace(/"/g, "'").replace(/[\r\n]+/g, ' ').slice(0, 40);
}

const _PORT_LABELS = {
  'branch-true': '真',
  'branch-false': '假',
  'loop-body': '循环体',
  'loop-done': '结束',
};

/**
 * 渲染为 Mermaid flowchart 文本。确定性、零 IO。
 * @param {object} graph
 * @returns {string}
 */
function toMermaid(graph) {
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const conns = (graph && Array.isArray(graph.connections)) ? graph.connections : [];
  const lines = ['flowchart TD'];
  for (const n of nodes) {
    if (!n || n.id == null) continue;
    const label = `${_mmLabel(n.name || n.type)} (${n.type})`;
    const nid = _mmId(n.id);
    if (n.type === 'ifElse') lines.push(`  ${nid}{"${label}"}`);
    else if (n.type === 'start' || n.type === 'end') lines.push(`  ${nid}(["${label}"])`);
    else lines.push(`  ${nid}["${label}"]`);
  }
  for (const c of conns) {
    if (!c || c.from == null || c.to == null) continue;
    const port = c.fromPort && c.fromPort !== 'default' ? c.fromPort : '';
    const lbl = _PORT_LABELS[port] || '';
    const arrow = lbl ? `-- ${lbl} -->` : '-->';
    lines.push(`  ${_mmId(c.from)} ${arrow} ${_mmId(c.to)}`);
  }
  return lines.join('\n');
}

// ── 导入报告格式化 ──────────────────────────────────────────────────────────

/**
 * 把 cozeImport.convertCozeWorkflow 的 report 渲染为可读行(供 handler 打印)。
 * @param {object} report
 * @returns {string[]}
 */
function formatReport(report) {
  const r = report || {};
  const lines = [];
  lines.push(`来源:${r.source || '?'}  名称:${r.name || '?'}`);
  lines.push(`节点:${r.nodeCount || 0}  连接:${r.edgeCount || 0}`);
  if (r.droppedComments) lines.push(`已丢弃注释节点:${r.droppedComments}`);
  if (r.droppedEdges) lines.push(`已丢弃悬空/非法边:${r.droppedEdges}`);
  if (r.typeCounts && Object.keys(r.typeCounts).length) {
    const parts = Object.entries(r.typeCounts).map(([k, v]) => `${k}×${v}`);
    lines.push(`节点类型:${parts.join('  ')}`);
  }
  if (Array.isArray(r.unsupported) && r.unsupported.length) {
    lines.push(`不支持→映射为 toolCall 占位(${r.unsupported.length}):`);
    for (const u of r.unsupported.slice(0, 20)) {
      lines.push(`  · ${u.cozeType || '?'}(节点 ${u.id})→ ${u.mappedTo || 'toolCall'}`);
    }
    if (r.unsupported.length > 20) lines.push(`  …另有 ${r.unsupported.length - 20} 个`);
  }
  if (Array.isArray(r.warnings) && r.warnings.length) {
    lines.push(`近似/告警(${r.warnings.length}):`);
    for (const w of r.warnings.slice(0, 20)) lines.push(`  ⚠ ${w}`);
    if (r.warnings.length > 20) lines.push(`  …另有 ${r.warnings.length - 20} 条`);
  }
  return lines;
}

// ── 文件名 slug ─────────────────────────────────────────────────────────────

/**
 * 把工作流名规整为安全文件名(不含扩展名)。fail-soft:空 → 'workflow'。
 * @param {string} name
 * @returns {string}
 */
function slugify(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return 'workflow';
  // 保留中文/字母数字,其余(含路径分隔/空白)→ '-';压缩并去首尾 '-'。
  const cleaned = s
    .replace(/[ -]/g, '')
    .replace(/[/\\:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || 'workflow';
}

module.exports = {
  parseInputs,
  validateGraph,
  summarizeGraph,
  toMermaid,
  formatReport,
  slugify,
  _enabled,
};
