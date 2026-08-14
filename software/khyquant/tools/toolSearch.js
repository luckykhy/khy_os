/**
 * ToolSearch — discover and load deferred tools by keyword.
 *
 * When the tool count grows (with MCP tools), not all tool schemas
 * fit in the initial prompt. Deferred tools (shouldDefer: true) only
 * show their name; the model uses ToolSearch to get full descriptions.
 *
 * Supports two query modes:
 *   "select:readFile,writeFile"  — exact name selection
 *   "file editing"               — keyword search with scoring
 *
 * Feature gate: KHY_TOOL_SEARCH=true to enable.
 */
const { defineTool } = require('./_baseTool');
// Single source of truth for name-parsing + keyword scoring lives in the pure
// leaf toolRecommend.js (which also exposes the programmatic recommendTools()).
// ToolSearch reuses it so the scoring weights never drift between the two.
const { scoreTool } = require('./toolRecommend');

// ── Tool Definition ────────────────────────────────────────────────

module.exports = defineTool({
  name: 'toolSearch',
  description: 'Search and discover available tools by keyword or select by name',
  category: 'system',
  risk: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  alwaysLoad: true,  // ToolSearch itself is never deferred

  isEnabled() {
    return true; // Always enabled — deferral gating is in the registry
  },

  inputSchema: {
    query: {
      type: 'string',
      required: true,
      description: 'Search query (keywords) or "select:tool1,tool2" for exact selection',
    },
  },

  async execute(params) {
    const query = (params.query || '').trim();
    if (!query) {
      return { success: false, error: 'Query is required' };
    }

    let toolRegistry;
    try { toolRegistry = require('./index'); } catch {
      return { success: false, error: 'Tool registry not available' };
    }

    // Mode 1: Direct selection — "select:readFile,writeFile"
    if (query.startsWith('select:')) {
      const names = query.slice(7).split(',').map(n => n.trim()).filter(Boolean);
      return await handleSelect(names, toolRegistry);
    }

    // Mode 2: Keyword search
    return await handleSearch(query, toolRegistry);
  },
});

// ── Handlers ───────────────────────────────────────────────────────

async function handleSelect(names, registry) {
  const results = [];
  const allTools = registry.getAll();

  for (const name of names) {
    // Try exact match first
    let tool = allTools.get(name);

    // Try alias match
    if (!tool) {
      for (const [, t] of allTools) {
        if (t.aliases && t.aliases.includes(name)) {
          tool = t;
          break;
        }
      }
    }

    if (tool) {
      // Auto-reveal deferred tools
      if (tool.shouldDefer && !tool.alwaysLoad && registry.ensureTool) {
        await registry.ensureTool(tool.name);
      }
      const prompt = await tool.prompt();
      results.push({
        name: tool.name,
        description: prompt,
        schema: tool.toFunctionDef(),
        category: tool.category,
        risk: tool.risk,
        activated: tool.shouldDefer || false,
      });
    } else {
      results.push({ name, error: `Tool not found: ${name}` });
    }
  }

  return {
    success: true,
    mode: 'select',
    tools: results,
    count: results.filter(r => !r.error).length,
  };
}

async function handleSearch(query, registry) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const allTools = registry.getAll();
  const scored = [];

  for (const [name, tool] of allTools) {
    if (name === 'toolSearch') continue; // Don't return self
    const score = scoreTool(tool, queryTerms);
    if (score > 0) {
      scored.push({ tool, score });
    }
  }

  // Sort by score descending, take top 10
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 10);

  const results = [];
  for (const { tool, score } of top) {
    // Auto-reveal deferred tools found by search
    if (tool.shouldDefer && !tool.alwaysLoad && registry.ensureTool) {
      await registry.ensureTool(tool.name);
    }
    const prompt = await tool.prompt();
    results.push({
      name: tool.name,
      score,
      description: prompt,
      schema: tool.toFunctionDef(),
      category: tool.category,
      risk: tool.risk,
      deferred: tool.shouldDefer || false,
      activated: tool.shouldDefer || false,
    });
  }

  return {
    success: true,
    mode: 'search',
    query,
    tools: results,
    count: results.length,
    totalAvailable: allTools.size,
  };
}
