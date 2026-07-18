/**
 * Workflow -> Markdown export pipeline (Phase 1 payoff).
 *
 * The canvas graph is the single source of truth; this service derives a
 * Markdown SKILL.md (plus one agent .md per subAgent node) that the EXISTING
 * KHY agent harness discovers without any harness change:
 *
 *   - main skill  -> ~/.khyquant/skills/<slug>/SKILL.md   (skillLoader scans here)
 *   - sub-agents  -> ~/.khy/agents/<agentName>.md         (loadAgents scans here)
 *
 * `slug = wf-<userId>-<kebab(name)>` encodes ownership while keeping per-user
 * logical isolation. ai-backend shares the OS user / home with the harness, so a
 * file written here is immediately visible to skill discovery and Goal Mode.
 *
 * The Markdown is a one-way derived artifact: edit the canvas, re-export. We
 * never read it back. Strict validation (exactly one start, >=1 end) gates
 * export — a half-built graph cannot produce a runnable skill.
 *
 * @pattern Builder
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const svc = require('./workflowService');
const { getNodeType } = require('@khy/shared/workflow/nodeCatalog');
const { getProvider } = require('@khy/shared/workflow/exportProviders');

// ── Slug / name helpers ──────────────────────────────────────────────────────

function kebab(raw) {
  const s = String(raw == null ? '' : raw)
    .trim()
    .toLowerCase()
    .replace(/[^\w一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'untitled';
}

function safeFilename(raw) {
  return String(raw == null ? '' : raw).trim().replace(/[^\w.\-一-龥]+/g, '-').replace(/^-+|-+$/g, '');
}

function slugFor(userId, name) {
  return `wf-${userId}-${kebab(name)}`;
}

// ── Mermaid flowchart ────────────────────────────────────────────────────────

// Sanitize a node id into a mermaid-safe token.
function mmId(id) {
  return String(id).replace(/[^A-Za-z0-9_]/g, '_');
}

// Escape a label for use inside a quoted mermaid shape.
function mmLabel(text) {
  return String(text == null ? '' : text).replace(/"/g, "'").replace(/\n/g, ' ').slice(0, 60);
}

// Shape wrapper per node type.
function mmShape(node) {
  const label = mmLabel(node.name || node.type);
  switch (node.type) {
    case 'start':
    case 'end':
      return `(["${label}"])`;
    case 'ifElse':
      return `{"${label}"}`;
    case 'loop':
      return `{{"${label}"}}`;
    case 'subAgent':
      return `[["${label}"]]`;
    default:
      return `["${label}"]`;
  }
}

// Human label for a source port (used on mermaid edges + step annotations).
function portLabel(node, portId) {
  const def = getNodeType(node.type);
  const out = (def && def.outputs) || [];
  const found = out.find((p) => p.id === portId);
  if (found && found.label && portId !== 'default') return found.label;
  return '';
}

function buildMermaid(graph) {
  const lines = ['```mermaid', 'flowchart TD'];
  for (const n of graph.nodes) {
    lines.push(`  ${mmId(n.id)}${mmShape(n)}`);
  }
  for (const c of graph.connections) {
    const src = graph.nodes.find((n) => n.id === c.from);
    const label = c.condition || (src ? portLabel(src, c.fromPort || 'default') : '');
    const arrow = label ? `-->|${mmLabel(label)}|` : '-->';
    lines.push(`  ${mmId(c.from)} ${arrow} ${mmId(c.to)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

// ── Execution steps ──────────────────────────────────────────────────────────

// Breadth-first order from the start node; unreachable nodes appended last.
function orderNodes(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const adj = new Map();
  for (const c of graph.connections) {
    if (!adj.has(c.from)) adj.set(c.from, []);
    adj.get(c.from).push({ to: c.to, port: c.fromPort || 'default', condition: c.condition });
  }
  const start = graph.nodes.find((n) => n.type === 'start');
  const order = [];
  const seen = new Set();
  const queue = start ? [start.id] : [];
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    order.push(byId.get(id));
    for (const e of adj.get(id) || []) if (!seen.has(e.to)) queue.push(e.to);
  }
  for (const n of graph.nodes) if (!seen.has(n.id)) order.push(n);
  return { order, adj, byId };
}

function oneLine(text, max = 120) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Per-type instruction body for a single step.
function instructionFor(node) {
  const d = node.data || {};
  switch (node.type) {
    case 'start':
      return '工作流开始。';
    case 'end':
      return '工作流结束，返回结果。';
    case 'prompt':
      return `执行提示词：${oneLine(d.prompt) || '(空)'}` +
        (d.model ? `（模型 ${d.model}）` : '') +
        (d.outputVar ? `；结果存入变量 \`${d.outputVar}\`` : '');
    case 'ifElse':
      return `判断条件：\`${oneLine(d.expression) || '(未设置)'}\``;
    case 'loop':
      return d.mode === 'forEach'
        ? `遍历集合 \`${d.itemsVar || '?'}\`，每个元素绑定到 \`${d.itemVar || 'item'}\``
        : `循环 ${d.count != null ? d.count : '?'} 次`;
    case 'subAgent':
      return `调用子代理 \`${d.agentName || '(未命名)'}\`（定义见 ~/.khy/agents/${safeFilename(d.agentName)}.md）`;
    case 'toolCall':
      return `调用工具 \`${d.tool || '?'}\`` + (d.outputVar ? `；结果存入 \`${d.outputVar}\`` : '');
    case 'skill':
      return `运行技能 \`${d.skillName || '?'}\``;
    case 'code':
      return `执行 ${d.language || 'bash'} 代码` + (d.outputVar ? `；结果存入 \`${d.outputVar}\`` : '');
    case 'http':
      return `发起 HTTP 请求：${d.method || 'GET'} ${oneLine(d.url) || '(无 URL)'}`;
    case 'askUserQuestion':
      return `向用户提问：${oneLine(d.question) || '(空)'}` +
        (Array.isArray(d.options) && d.options.length ? `（选项：${d.options.join(' / ')}）` : '') +
        (d.answerVar ? `；回答存入 \`${d.answerVar}\`` : '');
    default:
      return node.type;
  }
}

function buildSteps(graph) {
  const { order, adj } = orderNodes(graph);
  const stepNo = new Map(order.map((n, i) => [n.id, i + 1]));
  const def = (n) => getNodeType(n.type);

  const lines = [];
  order.forEach((node, i) => {
    const label = node.name || node.type;
    const typeLabel = (def(node) && def(node).label) || node.type;
    lines.push(`${i + 1}. **${label}** (${typeLabel}) — ${instructionFor(node)}`);

    // Branch / next annotations referencing target step numbers.
    const edges = adj.get(node.id) || [];
    if (edges.length) {
      for (const e of edges) {
        const target = stepNo.has(e.to) ? `step ${stepNo.get(e.to)}` : e.to;
        const lbl = e.condition || portLabel(node, e.port) || (e.port !== 'default' ? e.port : '');
        lines.push(lbl ? `   - ${lbl} → ${target}` : `   - 下一步 → ${target}`);
      }
    }
  });
  return lines.join('\n');
}

// ── Execution legend (provider-specific tool names) ──────────────────────────

/**
 * Per-node-type execution legend, mirroring cc-wf-studio's "Execution Methods
 * by Node Type" section. The per-step prose (instructionFor) stays
 * provider-agnostic; only this legend names each provider's native tools, so a
 * skill exported for Codex/Gemini/Cursor tells that agent which tool backs each
 * node shape. Only node types actually present in the graph are listed.
 */
function buildExecutionLegend(graph, provider) {
  const present = new Set(graph.nodes.map((n) => n.type));
  const t = provider.tools;
  const rows = [];
  if (present.has('subAgent')) rows.push(`- **子代理节点**：用${t.subAgent}执行`);
  if (present.has('askUserQuestion')) rows.push(`- **询问用户节点**：用${t.askUserQuestion}向用户提问并按回答分支`);
  if (present.has('skill')) rows.push(`- **技能节点**：调用${t.skill}`);
  if (present.has('code')) rows.push(`- **代码节点**：用${t.shell}执行`);
  if (present.has('http')) rows.push(`- **HTTP 节点**：用${t.http}发起请求`);
  if (present.has('toolCall')) rows.push('- **工具调用节点**：调用指定的工具');
  if (present.has('ifElse') || present.has('loop')) {
    rows.push('- **条件 / 循环节点**：依据上一步结果自动判断并选择分支');
  }
  if (!rows.length) return '';
  return [`## 执行方式（${provider.agentName}）`, '', ...rows, ''].join('\n');
}

// ── SKILL.md / agent.md composition ──────────────────────────────────────────

function buildSkillMarkdown(wf, graph, provider) {
  const slug = slugFor(wf.userId, wf.name);
  const description = oneLine(wf.description) || `可视化工作流「${wf.name}」（由 KHY 工作流编辑器导出）`;
  const fm = [
    '---',
    `name: ${slug}`,
    `version: 1.0.${wf.version || 1}`,
    `description: ${description}`,
    'layer: application',
    'lifecycle: operations',
    'tags: [workflow, khy-visual]',
    'platforms: [khy-quant]',
    '---',
  ].join('\n');

  const legend = buildExecutionLegend(graph, provider);
  const body = [
    `# ${wf.name}`,
    '',
    description,
    '',
    '> 本技能由可视化工作流编辑器导出。画布 JSON 为唯一真源，请勿手工编辑本文件——在编辑器中修改后重新导出。',
    '',
    '## Flowchart',
    '',
    buildMermaid(graph),
    '',
    ...(legend ? [legend] : []),
    '## Execution Steps',
    '',
    buildSteps(graph),
    '',
  ].join('\n');

  return `${fm}\n\n${body}`;
}

function buildAgentMarkdown(node) {
  const d = node.data || {};
  const name = safeFilename(d.agentName);
  const description = oneLine(d.instructions, 80) || `工作流子代理 ${name}`;
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${description}`,
    ...(d.model ? [`model: ${d.model}`] : []),
    ...(Array.isArray(d.tools) && d.tools.length ? [`tools: [${d.tools.join(', ')}]`] : []),
    ...(Number(d.maxTurns) > 0 ? [`maxTurns: ${Number(d.maxTurns)}`] : []),
    '---',
  ].join('\n');
  const body = String(d.instructions || '请根据上下文完成子任务。').trim();
  return `${fm}\n\n${body}\n`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Export a saved workflow to agent-discoverable Markdown.
 *
 * @param {number|string} userId  owner; scopes the lookup and the slug
 * @param {number|string} id      workflow id
 * @param {Object} [opts]
 * @param {string} [opts.provider='khy']  target agent (see exportProviders)
 * @param {string} [opts.homeDir]  override home root for `home: true` providers
 * @param {string} [opts.rootDir]  output root for `home: false` providers
 *                                  (project dirs like .claude/, .codex/);
 *                                  defaults to process.cwd()
 * @returns {Promise<{ provider, slug, files: Array<{path, kind}>, summary }>}
 */
async function exportWorkflow(userId, id, opts = {}) {
  const provider = getProvider(opts.provider);
  const home = opts.homeDir || os.homedir();
  const root = opts.rootDir || process.cwd();
  const baseDir = provider.dirs.home ? home : root;

  const record = await svc.get(userId, id); // 404 if not owned/missing
  const graph = record.graph || svc.emptyGraph();

  // Completeness gate: only a runnable graph may be exported.
  svc.validateGraph(graph, { strict: true });

  const wf = { userId, name: record.name, description: record.description, version: record.version };
  const slug = slugFor(userId, wf.name);

  const files = [];

  // 1) main skill
  const skillDir = path.join(baseDir, ...provider.dirs.skill.split('/'), slug);
  const skillPath = path.join(skillDir, 'SKILL.md');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, buildSkillMarkdown(wf, graph, provider), 'utf-8');
  files.push({ path: skillPath, kind: 'skill' });

  // 2) one agent file per subAgent node with a usable name — only for providers
  //    that have a dedicated agent directory (Claude Code, Cursor, KHY). For
  //    providers without one, sub-agent instructions stay inline in the skill.
  const subAgents = graph.nodes.filter((n) => n.type === 'subAgent' && safeFilename(n.data && n.data.agentName));
  if (provider.dirs.agent && subAgents.length) {
    const agentDir = path.join(baseDir, ...provider.dirs.agent.split('/'));
    fs.mkdirSync(agentDir, { recursive: true });
    for (const node of subAgents) {
      const agentPath = path.join(agentDir, `${safeFilename(node.data.agentName)}.md`);
      fs.writeFileSync(agentPath, buildAgentMarkdown(node), 'utf-8');
      files.push({ path: agentPath, kind: 'agent' });
    }
  }

  return {
    provider: provider.id,
    slug,
    files,
    summary: {
      nodes: graph.nodes.length,
      connections: graph.connections.length,
      agents: files.filter((f) => f.kind === 'agent').length,
      run: provider.invoke(slug),
    },
  };
}

module.exports = {
  exportWorkflow,
  // exported for unit tests
  buildMermaid,
  buildSteps,
  buildExecutionLegend,
  buildSkillMarkdown,
  buildAgentMarkdown,
  slugFor,
  kebab,
};
