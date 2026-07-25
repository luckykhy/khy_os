/**
 * Agent Renderer — tree-style display for multi-agent parallel execution.
 *
 * Shows Claude Code-style agent progress:
 *   ● Running 3 agents...  (ctrl+o to expand)
 *     ├ 基本面分析师 · 5 tool uses · 2.1k tokens
 *     │ └ Done
 *     ├ 技术面分析师 · 3 tool uses · 1.8k tokens
 *     │ └ Running...
 *     └ 风控经理 · pending
 *
 * Lazy-loads chalk for fast cold start.
 */
let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

// Single source of truth for the tree LAYOUT (branch glyphs, stats wording,
// detail selection) — shared with the ink TUI (AgentTree.js) via agentTreeView.
// This module only maps the semantic rows onto chalk colours + console.log.
const { buildAgentTreeRows, buildAgentHeader } = require('./agentTreeView');
// 汇总行三分段(tool uses · tokens · 时长)收敛到纯叶子 cli/agentStatLine.js
// (对齐 CC AgentTool/UI.tsx;门控 KHY_CC_FORMAT 默认开,关 → legacy 字节回退)。
const { agentToolUsesLabelOr, agentTokensLabelOr, agentDurationLabelOr } = require('./agentStatLine');

// status → name colour for the classic renderer.
function nameColorFor(status) {
  switch (status) {
    case 'completed': return c().green;
    case 'error': return c().red;
    case 'running': return c().bold.white;
    default: return c().dim;
  }
}

/**
 * Render the full agent tree display.
 * @param {Array<{name: string, status: string, toolCalls?: number, tokens?: number, elapsed?: number, detail?: string}>} agents
 * @returns {number} number of lines rendered
 */
function renderAgentTree(agents) {
  let lines = 0;
  for (const row of buildAgentTreeRows(agents)) {
    if (row.kind === 'agent') {
      const statsStr = row.stats.length > 0 ? c().dim(` · ${row.stats.join(' · ')}`) : '';
      console.log(`    ${row.branch} ${nameColorFor(row.status)(row.name)}${statsStr}`);
      lines++;
    } else if (row.kind === 'preview') { // 目录树 sub-line
      console.log(`    ${row.cont}   ${c().dim(row.text)}`);
      lines++;
    } else { // detail sub-line
      console.log(`    ${row.cont} ${c().dim(`└ ${row.text}`)}`);
      lines++;
    }
  }
  return lines;
}

/**
 * Render the agent header: "Running N agents... (ctrl+o to expand)"
 * @param {number} count
 * @param {boolean} [finished=false]
 */
function renderAgentHeader(count, finished = false) {
  // Honour the shared header wording (agentTreeView) so the classic REPL and the
  // ink TUI announce a fan-out identically. `finished` overrides allDone for
  // callers that pass an explicit count.
  const head = buildAgentHeader(Array.from({ length: count }, () => ({ status: finished ? 'completed' : 'running' })));
  const hint = c().dim('(ctrl+o to expand)');
  if (finished) {
    console.log(`  ${c().green(head.dot)} ${c().green(head.label)} ${hint}`);
  } else {
    console.log(`  ${c().dim(head.dot)} ${c().bold(head.label)} ${hint}`);
  }
}

/**
 * Render complete agent progress display with header + tree.
 * @param {Array} agents - agent state array
 * @param {boolean} [finished=false]
 * @returns {number} total lines rendered
 */
function renderAgentDisplay(agents, finished = false) {
  if (process.stdout.isTTY) return 0;
  renderAgentHeader(agents.length, finished);
  const treeLines = renderAgentTree(agents);
  return 1 + treeLines;
}

/**
 * Re-render agent display by moving cursor up and clearing.
 * @param {Array} agents
 * @param {number} previousLines - how many lines the previous render produced
 * @param {boolean} [finished=false]
 * @returns {number} new line count
 */
function rerenderAgentDisplay(agents, previousLines, finished = false) {
  if (process.stdout.isTTY) return 0;
  let _sw;
  try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
  if (typeof _sw !== 'function') _sw = (fn) => fn();
  let newLines = 0;
  _sw(() => {
    if (process.stdout.isTTY && previousLines > 0) {
      process.stdout.write('\x1b[1A\r\x1b[K'.repeat(previousLines));
    }
    newLines = renderAgentDisplay(agents, finished);
  });
  return newLines;
}

/**
 * Render the synthesis result with attribution.
 * @param {string} synthesized - synthesized text
 * @param {Array<{name: string, status: string}>} agents
 */
function renderSynthesisResult(synthesized, agents) {
  const renderer = require('./aiRenderer');

  // Show which agents contributed
  const contributors = agents.filter(a => a.status === 'completed').map(a => a.name);
  console.log('');
  console.log(c().dim(`  综合来源: ${contributors.join(' · ')}`));
  console.log(c().dim('  ┌──'));

  const rendered = renderer.renderAiResponse(synthesized);
  rendered.split('\n').forEach(l => console.log(c().dim('  │ ') + l));
  console.log(c().dim('  └──'));
}

/**
 * Render agent completion summary.
 * @param {Array} agents
 */
function renderAgentSummary(agents) {
  if (process.stdout.isTTY) return;
  const completed = agents.filter(a => a.status === 'completed').length;
  const failed = agents.filter(a => a.status === 'error').length;
  const totalTokens = agents.reduce((sum, a) => sum + (a.tokens || 0), 0);
  const totalToolCalls = agents.reduce((sum, a) => sum + (a.toolCalls || 0), 0);
  const maxElapsed = Math.max(...agents.map(a => a.elapsed || 0));

  const parts = [];
  parts.push(`${completed} completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (totalToolCalls > 0) {
    parts.push(agentToolUsesLabelOr(totalToolCalls, `${totalToolCalls} tool uses`, process.env));
  }
  if (totalTokens > 0) {
    parts.push(agentTokensLabelOr(totalTokens, `${(totalTokens / 1000).toFixed(1)}k tokens`, process.env));
  }
  if (maxElapsed > 0) {
    parts.push(agentDurationLabelOr(maxElapsed, `${(maxElapsed / 1000).toFixed(1)}s`, process.env));
  }

  console.log(`  ${c().dim('└')} ${c().green('Done')} ${c().dim(`(${parts.join(' · ')})`)}`);
}

module.exports = {
  renderAgentTree,
  renderAgentHeader,
  renderAgentDisplay,
  rerenderAgentDisplay,
  renderSynthesisResult,
  renderAgentSummary,
};
