'use strict';

/**
 * TopologyPanel — ink renderer for the 会话拓扑「森林」(/topology) in the TUI.
 *
 * 学自 Stello 的 starfield 直觉:一张网里,**活跃**分支更亮、**当前所在**节点高亮、
 * 越陈旧越暗。它自身**不拥有任何走树/字形逻辑**:├│└ 分支、标签 + (turns · status)
 * 文本全部来自纯叶子 cli/sessionTopology 的 `buildForestRows` / `nodeDisplayText`
 * ——与经典 REPL 文本树(renderForestTree)共享的**单一真源**——故同一张网在两个前端
 * 读起来一致。本模块只把语义行映射到 ink Box/Text + 颜色。
 *
 * 亮度映射(对齐 AgentTree.nameProps 的约定):
 *   - 当前所在(isCurrent)→ bold cyan + 「← you are here」
 *   - active  → 常规(亮)
 *   - idle    → dim
 *   - archived→ dim(更陈旧,同 dim 但前缀已隐含)
 */
const React = require('react');
const inkRuntime = require('../inkRuntime');
const topo = require('../../sessionTopology');

// 节点 status → ink 颜色 props(亮度映射)。当前节点优先 bold cyan。
function nodeProps(row) {
  if (row.isCurrent) return { bold: true, color: 'cyan' };
  switch (row.node && row.node.status) {
    case 'active': return {};            // 亮(常规)
    case 'idle': return { dimColor: true };
    case 'archived': return { dimColor: true };
    default: return {};
  }
}

/**
 * @param {object} props
 * @param {{roots:Array, nodes:Array}} props.forest  来自 sessionTopology.buildForest
 * @param {string} [props.currentId]
 * @param {boolean} [props.degraded]  门控关(KHY_SESSION_TOPOLOGY=0)→ 顶部诚实提示
 */
function TopologyPanel({ forest, currentId = null, degraded = false }) {
  const { Box, Text } = inkRuntime.get();
  const h = React.createElement;
  const f = forest && Array.isArray(forest.roots) ? forest : { roots: [], nodes: [] };
  const nodeCount = (f.nodes && f.nodes.length) || 0;
  if (nodeCount === 0) {
    return h(Box, null, h(Text, { dimColor: true },
      '暂无持久化会话——先聊几句,或用 /fork 分出一条岔路,这里就会长出一张网。'));
  }

  const rows = topo.buildForestRows(f, { currentId });
  const children = [
    h(Box, { key: 'head' },
      h(Text, { bold: true }, `会话拓扑(${nodeCount} 个节点 · ${f.roots.length} 条主干)`),
      degraded ? h(Text, { color: 'yellow' }, '  ⚠ 已退化为平铺列表') : null),
  ];

  rows.forEach((row, idx) => {
    const text = topo.nodeDisplayText(row.node, { markCurrent: row.isCurrent });
    children.push(
      h(Box, { key: `row-${idx}` },
        h(Text, { dimColor: true }, row.prefix + row.branch),
        h(Text, nodeProps(row), text)));
  });

  return h(Box, { flexDirection: 'column' }, ...children.filter(Boolean));
}

module.exports = TopologyPanel;
