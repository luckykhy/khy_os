'use strict';

/**
 * mermaid.js — Terminal rendering for Mermaid diagram code blocks.
 *
 * Supports: mindmap, pie chart, flowchart/graph, sequence diagram, gantt chart.
 * Also handles deeply nested list trees (3+ indent levels) via shared _renderTree.
 *
 * Extracted from aiRenderer.js for maintainability.
 */

let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));
const { displayWidth, padToWidth, truncateToWidth } = require('./formatters');
// Non-spreading Math.max/min so a mermaid pie/gantt/flowchart with ~130k
// segments/tasks/layers can't crash rendering with a spread RangeError.
const { maxOf, minOf } = require('./safeArrayMinMax');

// ── Mindmap / Tree Rendering ──────────────────────────────────────────

/**
 * Parse mermaid mindmap code block into a tree structure.
 * @param {string} code - content inside ```mermaid ... ```
 * @returns {{ label: string, children: object[] } | null}
 */
function _parseMermaidMindmap(code) {
  const lines = code.replace(/\t/g, '  ').split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*mindmap\s*$/i.test(lines[i])) { startIdx = i + 1; break; }
  }
  if (startIdx < 0) return null;

  // Collect non-blank content lines
  const contentLines = [];
  for (let i = startIdx; i < lines.length; i++) {
    if (lines[i].trim()) contentLines.push(lines[i]);
  }
  if (contentLines.length === 0) return null;

  // Detect indent unit
  const indents = contentLines.map(l => l.match(/^(\s*)/)[1].length);
  const baseIndent = indents[0];
  let unit = 2;
  for (let i = 1; i < indents.length; i++) {
    const diff = indents[i] - baseIndent;
    if (diff > 0) { unit = diff; break; }
  }

  // Strip mermaid shape markers: id((text)), id[text], id(text), id)text(, id{{text}}
  // Only strip when the shape wraps the ENTIRE label (not content like "模型 (Ollama)")
  function cleanLabel(raw) {
    let m;
    // Double-paren: root((Central Topic))
    if ((m = raw.match(/^(\w[\w-]*)?\(\((.+)\)\)$/))) return m[2].trim();
    // Double-brace: node{{Hexagon}}
    if ((m = raw.match(/^(\w[\w-]*)?\{\{(.+)\}\}$/))) return m[2].trim();
    // Square bracket: node[Box Label]
    if ((m = raw.match(/^(\w[\w-]*)?\[(.+)\]$/))) return m[2].trim();
    // Reversed paren: node)Stadium(
    if ((m = raw.match(/^(\w[\w-]*)?\)(.+)\($/))) return m[2].trim();
    // Single paren: only strip if it looks like an identifier + shape wrapper (id(text))
    // NOT "模型 (Ollama)" which has a space before the paren
    if ((m = raw.match(/^(\w[\w-]*)\((.+)\)$/))) return m[2].trim();
    return raw.trim();
  }

  // Build tree with stack
  const root = { label: cleanLabel(contentLines[0].trim()), children: [] };
  const stack = [{ depth: 0, node: root }];

  for (let i = 1; i < contentLines.length; i++) {
    const depth = Math.round((indents[i] - baseIndent) / unit);
    const label = cleanLabel(contentLines[i].trim());
    const node = { label, children: [] };

    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth, node });
  }

  return root;
}

/**
 * Render a tree structure as ASCII art with box-drawing branch lines.
 * - Root node in bordered box (mermaid) or bold text (list tree)
 * - Depth-based color coding (cyan/green/yellow/magenta/dim)
 * - Leaf nodes marked with dim dot
 * - Stats footer for larger trees
 * @param {{ label: string, children: object[] }} root
 * @param {{ maxWidth?: number, showStats?: boolean, rootBox?: boolean }} [opts]
 * @returns {string}
 */
function _renderTree(root, opts = {}) {
  const cols = opts.maxWidth || (process.stdout.columns || 80) - 6;
  const showStats = opts.showStats !== false;
  const rootBox = opts.rootBox !== false;
  const dim = c().dim.bind(c());
  const bold = c().bold.bind(c());

  let lwt = false;
  try { lwt = require('../tools/platformUtils').isLegacyWinTerminal(); } catch { /* ignore */ }
  const T = lwt
    ? { mid: '|-', last: '`-', dash: '-- ', pipe: '|   ', blank: '    ' }
    : { mid: '├─', last: '└─', dash: '─ ', pipe: '│   ', blank: '    ' };

  // Depth color palette
  const palette = [
    c().cyan.bind(c()),
    c().green.bind(c()),
    c().yellow.bind(c()),
    c().magenta.bind(c()),
    c().dim.bind(c()),
  ];
  function clr(d) { return palette[Math.min(d, palette.length - 1)]; }

  // Stats — depth-bounded to avoid stack overflow on pathological trees.
  // _renderTree runs on ASSISTANT/model output (mermaid fences + deeply nested
  // markdown lists via renderNestedListTrees); it is NOT reached by raw user
  // messages (those are char-capped and echoed without tree rendering). A model
  // emitting a 5000-deep list would blow the recursion stack and, at the one
  // unwrapped render site (repl.js:486), crash the REPL. Cap descent at
  // _MAX_TREE_DEPTH — far beyond any real diagram. Gate KHY_TREE_DEPTH_CAP
  // (default on); off → unbounded legacy recursion, byte-identical for real trees.
  const depthCapOn = !['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_TREE_DEPTH_CAP || '').trim().toLowerCase());
  const _MAX_TREE_DEPTH = 256;
  let totalNodes = 0, maxDepth = 0;
  function count(n, d) {
    totalNodes++;
    if (d > maxDepth) maxDepth = d;
    if (depthCapOn && d >= _MAX_TREE_DEPTH) return;
    for (const ch of n.children) count(ch, d + 1);
  }
  count(root, 0);

  const lines = [];

  // Root
  if (rootBox) {
    const w = Math.max(displayWidth(root.label) + 4, 12);
    lines.push(dim('  ╭') + dim('─'.repeat(w - 2)) + dim('╮'));
    lines.push(dim('  │ ') + bold(padToWidth(root.label, w - 4)) + dim(' │'));
    lines.push(dim('  ╰') + dim('┬'.repeat(1)) + dim('─'.repeat(w - 3)) + dim('╯'));
  } else {
    lines.push('  ' + bold(root.label));
  }

  function walk(node, prefix, isLast, depth) {
    const branch = isLast ? T.last : T.mid;
    const cont = isLast ? T.blank : T.pipe;
    const maxW = Math.max(10, cols - displayWidth(prefix) - 8);
    const label = truncateToWidth(node.label, maxW);
    const isLeaf = node.children.length === 0;
    const color = clr(depth);
    const branchStr = dim('  ' + prefix + branch + T.dash);

    if (isLeaf) {
      lines.push(branchStr + dim('· ') + color(label));
    } else {
      lines.push(branchStr + color(label));
    }

    // Stop descending past the depth cap (see count() above). The nodes exist in
    // the tree but are not rendered — a pathological deep chain can't overflow
    // the stack. Real diagrams never approach this depth.
    if (depthCapOn && depth >= _MAX_TREE_DEPTH) return;

    for (let i = 0; i < node.children.length; i++) {
      walk(node.children[i], prefix + cont, i === node.children.length - 1, depth + 1);
    }
  }

  for (let i = 0; i < root.children.length; i++) {
    walk(root.children[i], '', i === root.children.length - 1, 0);
  }

  if (showStats && totalNodes > 3) {
    lines.push(dim(`  ── ${totalNodes} 节点 · ${maxDepth} 层深度`));
  }

  return lines.join('\n');
}

// ── Mermaid Pie Chart ─────────────────────────────────────────────────

/**
 * Parse mermaid pie chart code.
 * @param {string} code
 * @returns {{ title: string, items: {label: string, value: number}[] } | null}
 */
function _parseMermaidPie(code) {
  const lines = code.replace(/\t/g, '  ').split('\n');
  let title = '';
  const items = [];

  let found = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!found) {
      const m = trimmed.match(/^pie\s*(title\s+(.+))?$/i);
      if (m) { found = true; title = (m[2] || '').trim(); continue; }
    }
    if (found) {
      const m = trimmed.match(/^["'](.+?)["']\s*:\s*([\d.]+)/);
      if (m) items.push({ label: m[1], value: parseFloat(m[2]) });
    }
  }

  if (!found || items.length === 0) return null;
  return { title, items };
}

/**
 * Render a pie chart as horizontal stacked bar + legend.
 * @param {{ title: string, items: {label: string, value: number}[] }} data
 * @returns {string}
 */
function _renderPieChart(data) {
  const dim = c().dim.bind(c());
  const bold = c().bold.bind(c());
  const cols = (process.stdout.columns || 80) - 8;
  const barWidth = Math.min(50, Math.max(20, cols - 20));
  const total = data.items.reduce((s, it) => s + it.value, 0) || 1;

  const colors = [
    c().cyan.bind(c()),
    c().green.bind(c()),
    c().yellow.bind(c()),
    c().magenta.bind(c()),
    c().red.bind(c()),
    c().blue.bind(c()),
    c().white.bind(c()),
    c().dim.bind(c()),
  ];
  const fills = ['█', '▓', '▒', '░', '▚', '▞', '╳', '·'];

  const lines = [];

  if (data.title) {
    lines.push('  ' + bold(data.title));
    lines.push('');
  }

  const segments = data.items.map((it, i) => {
    const pct = it.value / total;
    const w = Math.max(1, Math.round(pct * barWidth));
    const color = colors[i % colors.length];
    const fill = fills[i % fills.length];
    return { ...it, pct, w, color, fill };
  });

  let sumW = segments.reduce((s, seg) => s + seg.w, 0);
  while (sumW > barWidth && segments.length > 0) {
    const largest = segments.reduce((a, b) => a.w > b.w ? a : b);
    largest.w--;
    sumW--;
  }
  while (sumW < barWidth && segments.length > 0) {
    const smallest = segments.reduce((a, b) => a.w < b.w ? a : b);
    smallest.w++;
    sumW++;
  }

  let bar = '';
  for (const seg of segments) {
    bar += seg.color(seg.fill.repeat(seg.w));
  }

  lines.push('  ' + dim('╭') + dim('─'.repeat(barWidth)) + dim('╮'));
  lines.push('  ' + dim('│') + bar + dim('│'));
  lines.push('  ' + dim('╰') + dim('─'.repeat(barWidth)) + dim('╯'));
  lines.push('');

  const maxLabel = maxOf(segments.map(s => displayWidth(s.label)));
  for (const seg of segments) {
    const pctStr = (seg.pct * 100).toFixed(1) + '%';
    const marker = seg.color(seg.fill.repeat(2));
    const label = padToWidth(seg.label, maxLabel);
    const valStr = dim(seg.value.toString());
    lines.push(`  ${marker} ${label}  ${pctStr.padStart(6)}  ${valStr}`);
  }

  lines.push(dim(`  ── 合计: ${total}`));

  return lines.join('\n');
}

// ── Mermaid Flowchart ─────────────────────────────────────────────────

/**
 * Parse mermaid flowchart/graph code.
 * @param {string} code
 * @returns {{ direction: string, nodes: Map, edges: object[] } | null}
 */
function _parseMermaidFlowchart(code) {
  const lines = code.replace(/\t/g, '  ').split('\n');
  let direction = 'TD';
  let found = false;

  const nodes = new Map();
  const edges = [];

  function ensureNode(id, label) {
    if (!nodes.has(id)) nodes.set(id, { id, label: label || id });
    else if (label && nodes.get(id).label === id) nodes.get(id).label = label;
  }

  function extractNodeLabel(raw) {
    let m;
    if ((m = raw.match(/^([\w-]+)\(\((.+?)\)\)$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)\[\/(.+?)\/\]$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)\[\\(.+?)\\\]$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)\[(.+?)\]$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)\((.+?)\)$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)\{(.+?)\}$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)>(.+?)\]$/))) return { id: m[1], label: m[2] };
    if ((m = raw.match(/^([\w-]+)$/))) return { id: m[1], label: m[1] };
    return null;
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!found) {
      const m = trimmed.match(/^(?:graph|flowchart)\s+(TD|TB|BT|LR|RL)\s*$/i);
      if (m) { found = true; direction = m[1].toUpperCase(); continue; }
      if (/^(?:graph|flowchart)\s*$/i.test(trimmed)) { found = true; continue; }
    }
    if (!found) continue;
    if (!trimmed || trimmed.startsWith('%%') || trimmed.startsWith('style') ||
        trimmed.startsWith('class') || trimmed.startsWith('click') ||
        trimmed.startsWith('linkStyle') || trimmed.startsWith('subgraph') ||
        trimmed === 'end') continue;

    const edgeRe = /^(.+?)\s*(?:-->|==>|-\.->|---+>|--+)\s*(?:\|([^|]*)\|\s*)?(.+)$/;
    const edgeM = trimmed.match(edgeRe);
    if (edgeM) {
      let [, leftRaw, edgeLabel, rightRaw] = edgeM;
      if (!edgeLabel) {
        const textEdge = trimmed.match(/^(.+?)\s*--\s+(.+?)\s+-->\s*(.+)$/);
        if (textEdge) {
          leftRaw = textEdge[1];
          edgeLabel = textEdge[2];
          rightRaw = textEdge[3];
        }
      }
      const left = extractNodeLabel(leftRaw.trim());
      const right = extractNodeLabel(rightRaw.trim());
      if (left && right) {
        ensureNode(left.id, left.label);
        ensureNode(right.id, right.label);
        edges.push({ from: left.id, to: right.id, label: (edgeLabel || '').trim() });
      }
      continue;
    }

    const nodeInfo = extractNodeLabel(trimmed);
    if (nodeInfo) ensureNode(nodeInfo.id, nodeInfo.label);
  }

  if (!found || nodes.size === 0) return null;
  return { direction, nodes, edges };
}

/**
 * Render a flowchart as ASCII box-and-arrow diagram.
 * @param {{ direction: string, nodes: Map, edges: object[] }} data
 * @returns {string}
 */
function _renderFlowchart(data) {
  const dim = c().dim.bind(c());
  const bold = c().bold.bind(c());
  const cyan = c().cyan.bind(c());
  const isVertical = data.direction === 'TD' || data.direction === 'TB' || data.direction === 'BT';

  const nodeList = [...data.nodes.values()];
  const adj = new Map();
  const inDeg = new Map();
  for (const n of nodeList) { adj.set(n.id, []); inDeg.set(n.id, 0); }
  for (const e of data.edges) {
    if (adj.has(e.from)) adj.get(e.from).push(e);
    if (inDeg.has(e.to)) inDeg.set(e.to, inDeg.get(e.to) + 1);
  }

  // Topological sort (Kahn's algorithm) for layer assignment
  const queue = [];
  const layers = new Map();
  for (const [id, deg] of inDeg) { if (deg === 0) { queue.push(id); layers.set(id, 0); } }
  while (queue.length > 0) {
    const cur = queue.shift();
    const curLayer = layers.get(cur);
    for (const e of (adj.get(cur) || [])) {
      const newDeg = inDeg.get(e.to) - 1;
      inDeg.set(e.to, newDeg);
      layers.set(e.to, Math.max(layers.get(e.to) || 0, curLayer + 1));
      if (newDeg === 0) queue.push(e.to);
    }
  }

  for (const n of nodeList) { if (!layers.has(n.id)) layers.set(n.id, 0); }

  const maxLayer = maxOf(layers.values(), 0);
  const layerGroups = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of nodeList) {
    layerGroups[layers.get(n.id)].push(n);
  }

  const lines = [];

  if (isVertical) {
    for (let li = 0; li < layerGroups.length; li++) {
      const group = layerGroups[li];
      const boxes = group.map(n => {
        const w = Math.max(displayWidth(n.label) + 4, 8);
        const top = dim('╭') + dim('─'.repeat(w - 2)) + dim('╮');
        const mid = dim('│') + ' ' + cyan(padToWidth(n.label, w - 4)) + ' ' + dim('│');
        const bot = dim('╰') + dim('─'.repeat(w - 2)) + dim('╯');
        return { top, mid, bot, w };
      });

      const gap = '  ';
      lines.push('  ' + boxes.map(b => b.top).join(gap));
      lines.push('  ' + boxes.map(b => b.mid).join(gap));
      lines.push('  ' + boxes.map(b => b.bot).join(gap));

      if (li < layerGroups.length - 1) {
        const edgeLabels = [];
        for (const e of data.edges) {
          if (layers.get(e.from) === li && layers.get(e.to) === li + 1) {
            edgeLabels.push(e.label);
          }
        }
        const arrowLabel = edgeLabels.filter(Boolean).join(', ');
        const totalWidth = boxes.reduce((s, b) => s + b.w, 0) + (boxes.length - 1) * gap.length;
        const center = Math.floor(totalWidth / 2);
        const arrowPad = ' '.repeat(Math.max(0, center));

        lines.push('  ' + arrowPad + dim('│'));
        if (arrowLabel) {
          lines.push('  ' + arrowPad + dim('│ ') + dim(arrowLabel));
        }
        lines.push('  ' + arrowPad + dim('▼'));
      }
    }
  } else {
    for (let li = 0; li < layerGroups.length; li++) {
      const group = layerGroups[li];
      for (let ni = 0; ni < group.length; ni++) {
        const n = group[ni];
        const w = Math.max(displayWidth(n.label) + 4, 8);
        lines.push('  ' + dim('╭') + dim('─'.repeat(w - 2)) + dim('╮'));
        lines.push('  ' + dim('│') + ' ' + cyan(padToWidth(n.label, w - 4)) + ' ' + dim('│'));
        lines.push('  ' + dim('╰') + dim('─'.repeat(w - 2)) + dim('╯'));
      }
      if (li < layerGroups.length - 1) {
        const edgeLabels = [];
        for (const e of data.edges) {
          if (layers.get(e.from) === li && layers.get(e.to) === li + 1) {
            edgeLabels.push(e.label);
          }
        }
        const arrowLabel = edgeLabels.filter(Boolean).join(', ');
        if (arrowLabel) {
          lines.push('    ' + dim('│ ') + dim(arrowLabel));
        } else {
          lines.push('    ' + dim('│'));
        }
        lines.push('    ' + dim('▼'));
      }
    }
  }

  lines.push(dim(`  ── ${data.nodes.size} 节点 · ${data.edges.length} 连接`));

  return lines.join('\n');
}

// ── Mermaid Sequence Diagram ──────────────────────────────────────────

/**
 * Parse mermaid sequenceDiagram code.
 * @param {string} code
 * @returns {{ participants: string[], messages: object[] } | null}
 */
function _parseMermaidSequence(code) {
  const lines = code.replace(/\t/g, '  ').split('\n');
  let found = false;
  const participantOrder = [];
  const participantSet = new Set();
  const messages = [];

  function addParticipant(name) {
    if (!participantSet.has(name)) { participantSet.add(name); participantOrder.push(name); }
  }

  for (const line of lines) {
    const trimmed = line.trim();
    if (!found) {
      if (/^sequenceDiagram\s*$/i.test(trimmed)) { found = true; continue; }
    }
    if (!found) continue;
    if (!trimmed || trimmed.startsWith('%%') || trimmed.startsWith('Note') ||
        trimmed.startsWith('activate') || trimmed.startsWith('deactivate') ||
        trimmed.startsWith('rect') || trimmed === 'end' ||
        trimmed.startsWith('loop') || trimmed.startsWith('alt') ||
        trimmed.startsWith('else') || trimmed.startsWith('opt') ||
        trimmed.startsWith('par') || trimmed.startsWith('and') ||
        trimmed.startsWith('critical') || trimmed.startsWith('break')) continue;

    const partM = trimmed.match(/^(?:participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i);
    if (partM) { addParticipant(partM[2] || partM[1]); continue; }

    const msgM = trimmed.match(/^(.+?)\s*(->>|-->>|-\)|--\)|->|-->|-x|--x)\s*(.+?):\s*(.*)$/);
    if (msgM) {
      const [, from, arrow, to, label] = msgM;
      const fromName = from.trim();
      const toName = to.trim();
      addParticipant(fromName);
      addParticipant(toName);
      const type = arrow.includes('--') ? 'dashed' : 'solid';
      messages.push({ from: fromName, to: toName, label: label.trim(), type });
      continue;
    }
  }

  if (!found || messages.length === 0) return null;
  return { participants: participantOrder, messages };
}

/**
 * Render a sequence diagram in the terminal.
 * @param {{ participants: string[], messages: object[] }} data
 * @returns {string}
 */
function _renderSequenceDiagram(data) {
  const dim = c().dim.bind(c());
  const bold = c().bold.bind(c());
  const cyan = c().cyan.bind(c());
  const cols = (process.stdout.columns || 80) - 4;

  const parts = data.participants;
  if (parts.length === 0) return null;

  const colWidth = Math.max(12, Math.min(24, Math.floor((cols - 4) / parts.length)));
  const positions = {};
  parts.forEach((p, i) => { positions[p] = i * colWidth + Math.floor(colWidth / 2); });

  const lines = [];

  // Participant boxes
  let headerLine = '';
  for (const p of parts) {
    const pos = positions[p];
    const w = Math.max(displayWidth(p) + 4, 8);
    const start = Math.max(0, pos - Math.floor(w / 2));
    while (headerLine.length < start) headerLine += ' ';
    headerLine += dim('╭') + dim('─'.repeat(w - 2)) + dim('╮');
  }
  lines.push('  ' + headerLine);

  let labelLine = '';
  for (const p of parts) {
    const pos = positions[p];
    const w = Math.max(displayWidth(p) + 4, 8);
    const start = Math.max(0, pos - Math.floor(w / 2));
    while (labelLine.length < start) labelLine += ' ';
    labelLine += dim('│') + ' ' + bold(padToWidth(p, w - 4)) + ' ' + dim('│');
  }
  lines.push('  ' + labelLine);

  let bottomLine = '';
  for (const p of parts) {
    const pos = positions[p];
    const w = Math.max(displayWidth(p) + 4, 8);
    const start = Math.max(0, pos - Math.floor(w / 2));
    while (bottomLine.length < start) bottomLine += ' ';
    bottomLine += dim('╰') + dim('─'.repeat(w - 2)) + dim('╯');
  }
  lines.push('  ' + bottomLine);

  // Lifelines + messages
  for (const msg of data.messages) {
    const fromPos = positions[msg.from];
    const toPos = positions[msg.to];
    if (fromPos === undefined || toPos === undefined) continue;

    let lifeline = '';
    for (const p of parts) {
      const pos = positions[p];
      while (lifeline.length < pos) lifeline += ' ';
      if (lifeline.length === pos) lifeline += dim('│');
    }
    lines.push('  ' + lifeline);

    const left = Math.min(fromPos, toPos);
    const right = Math.max(fromPos, toPos);
    const goingRight = toPos > fromPos;
    const arrowLen = right - left;

    if (arrowLen === 0) {
      // Self-message
      let arrowLine = '';
      while (arrowLine.length < fromPos) arrowLine += ' ';
      arrowLine += dim('╭──╮ ') + cyan(msg.label);
      lines.push('  ' + arrowLine);
      let returnLine = '';
      while (returnLine.length < fromPos) returnLine += ' ';
      returnLine += dim('◄──╯');
      lines.push('  ' + returnLine);
    } else {
      let arrowLine = '';
      while (arrowLine.length < left) arrowLine += ' ';
      const dashChar = msg.type === 'dashed' ? '╌' : '─';
      if (goingRight) {
        arrowLine += dim(dashChar.repeat(Math.max(1, arrowLen - 1))) + dim('▶');
      } else {
        arrowLine += dim('◀') + dim(dashChar.repeat(Math.max(1, arrowLen - 1)));
      }
      if (msg.label) {
        const labelPos = left + Math.floor(arrowLen / 2) - Math.floor(displayWidth(msg.label) / 2);
        let labelLine2 = '';
        while (labelLine2.length < Math.max(0, labelPos)) labelLine2 += ' ';
        labelLine2 += cyan(msg.label);
        lines.push('  ' + labelLine2);
      }
      lines.push('  ' + arrowLine);
    }
  }

  // Final lifeline
  let finalLifeline = '';
  for (const p of parts) {
    const pos = positions[p];
    while (finalLifeline.length < pos) finalLifeline += ' ';
    if (finalLifeline.length === pos) finalLifeline += dim('│');
  }
  lines.push('  ' + finalLifeline);

  lines.push(dim(`  ── ${parts.length} 参与者 · ${data.messages.length} 消息`));

  return lines.join('\n');
}

// ── Mermaid Gantt Chart ───────────────────────────────────────────────

/**
 * Parse mermaid gantt chart code.
 * @param {string} code
 * @returns {{ title: string, sections: object[] } | null}
 */
function _parseMermaidGantt(code) {
  const lines = code.replace(/\t/g, '  ').split('\n');
  let found = false;
  let title = '';
  const sections = [];
  let currentSection = { name: '', tasks: [] };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!found) {
      if (/^gantt\s*$/i.test(trimmed)) { found = true; continue; }
    }
    if (!found) continue;
    if (!trimmed || trimmed.startsWith('%%')) continue;

    const titleM = trimmed.match(/^title\s+(.+)$/i);
    if (titleM) { title = titleM[1].trim(); continue; }

    if (/^(?:dateFormat|axisFormat|excludes|todayMarker|tickInterval)\s+/i.test(trimmed)) continue;

    const secM = trimmed.match(/^section\s+(.+)$/i);
    if (secM) {
      if (currentSection.tasks.length > 0) sections.push(currentSection);
      currentSection = { name: secM[1].trim(), tasks: [] };
      continue;
    }

    const taskM = trimmed.match(/^(.+?)\s*:\s*(.*)$/);
    if (taskM) {
      const label = taskM[1].trim();
      const meta = taskM[2].trim();
      let status = 'pending';
      if (/\bdone\b/i.test(meta)) status = 'done';
      else if (/\bactive\b/i.test(meta)) status = 'active';
      else if (/\bcrit\b/i.test(meta)) status = 'critical';
      currentSection.tasks.push({ label, status });
    }
  }

  if (currentSection.tasks.length > 0) sections.push(currentSection);
  if (!found || sections.length === 0) return null;
  return { title, sections };
}

/**
 * Render gantt chart as terminal timeline.
 * @param {{ title: string, sections: object[] }} data
 * @returns {string}
 */
function _renderGanttChart(data) {
  const dim = c().dim.bind(c());
  const bold = c().bold.bind(c());
  const cols = (process.stdout.columns || 80) - 8;
  const barWidth = Math.min(30, Math.max(12, cols - 30));

  const statusStyle = {
    done: { color: c().green.bind(c()), fill: '█', icon: '✓' },
    active: { color: c().cyan.bind(c()), fill: '▓', icon: '▶' },
    critical: { color: c().red.bind(c()), fill: '█', icon: '!' },
    pending: { color: c().dim.bind(c()), fill: '░', icon: '○' },
  };

  const lines = [];

  if (data.title) {
    lines.push('  ' + bold(data.title));
    lines.push('');
  }

  const allTasks = data.sections.flatMap(s => s.tasks);
  const taskCount = allTasks.length;

  for (const section of data.sections) {
    if (section.name) {
      lines.push('  ' + bold(section.name));
    }

    const maxLabel = maxOf(section.tasks.map(t => displayWidth(t.label)), 0);

    for (const task of section.tasks) {
      const style = statusStyle[task.status] || statusStyle.pending;

      const progress = task.status === 'done' ? 1.0 :
                       task.status === 'active' ? 0.6 :
                       task.status === 'critical' ? 0.4 : 0.0;
      const filled = Math.round(progress * barWidth);
      const empty = barWidth - filled;

      const label = padToWidth(task.label, maxLabel);
      const icon = style.color(style.icon);
      const bar = style.color(style.fill.repeat(filled)) + dim('░'.repeat(empty));
      lines.push(`  ${icon} ${label}  ${bar}`);
    }

    lines.push('');
  }

  const doneCount = allTasks.filter(t => t.status === 'done').length;
  const activeCount = allTasks.filter(t => t.status === 'active').length;
  lines.push(dim(`  ── ${taskCount} 任务 · ${doneCount} 完成 · ${activeCount} 进行中`));

  return lines.join('\n');
}

// ── Mermaid Dispatcher ────────────────────────────────────────────────

/**
 * Attempt to render a mermaid code block as terminal-friendly output.
 * Supports: mindmap, pie, flowchart/graph, sequenceDiagram, gantt.
 * Returns null if unsupported (fallback to code block).
 * @param {string} code
 * @returns {string | null}
 */
function renderMermaidBlock(code) {
  const mindmap = _parseMermaidMindmap(code);
  if (mindmap) return _renderTree(mindmap, { rootBox: true, showStats: true });

  const pie = _parseMermaidPie(code);
  if (pie) return _renderPieChart(pie);

  const flow = _parseMermaidFlowchart(code);
  if (flow) return _renderFlowchart(flow);

  const seq = _parseMermaidSequence(code);
  if (seq) return _renderSequenceDiagram(seq);

  const gantt = _parseMermaidGantt(code);
  if (gantt) return _renderGanttChart(gantt);

  return null;
}

// ── Nested List Trees ─────────────────────────────────────────────────

/**
 * Detect deeply nested list blocks (3+ indent levels) for tree rendering.
 * @param {string} text
 * @returns {{ startLine: number, endLine: number, root: object }[]}
 */
function _detectNestedListTree(text) {
  const lines = text.split('\n');
  const results = [];
  let i = 0;
  let inFence = false;

  while (i < lines.length) {
    if (/^```/.test(lines[i].trim())) { inFence = !inFence; i++; continue; }
    if (inFence) { i++; continue; }

    if (/^\s*[-*]\s+/.test(lines[i])) {
      const startLine = i;
      const listLines = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        listLines.push(lines[i]);
        i++;
      }
      const indentSet = new Set(listLines.map(l => l.match(/^(\s*)/)[1].length));
      if (indentSet.size >= 3 && listLines.length >= 4) {
        const indents = listLines.map(l => l.match(/^(\s*)/)[1].length);
        const labels = listLines.map(l => l.replace(/^\s*[-*]\s+/, '').trim());
        const minIndent = minOf(indents);
        const indentArr = [...indentSet].sort((a, b) => a - b);
        const unit = indentArr.length > 1 ? indentArr[1] - indentArr[0] : 2;

        const root = { label: labels[0], children: [] };
        const stack = [{ depth: 0, node: root }];

        for (let j = 1; j < listLines.length; j++) {
          const depth = Math.round((indents[j] - minIndent) / unit);
          const node = { label: labels[j], children: [] };
          while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
          stack[stack.length - 1].node.children.push(node);
          stack.push({ depth, node });
        }

        results.push({ startLine, endLine: i, root });
      }
    } else {
      i++;
    }
  }
  return results;
}

/**
 * Replace deeply nested list blocks with tree renderings.
 * @param {string} text
 * @returns {string}
 */
function renderNestedListTrees(text) {
  const blocks = _detectNestedListTree(text);
  if (blocks.length === 0) return text;

  const lines = text.split('\n');
  for (let b = blocks.length - 1; b >= 0; b--) {
    const { startLine, endLine, root } = blocks[b];
    const tree = _renderTree(root, { rootBox: false, showStats: false });
    lines.splice(startLine, endLine - startLine, tree);
  }
  return lines.join('\n');
}

module.exports = {
  renderMermaidBlock,
  renderNestedListTrees,
};
