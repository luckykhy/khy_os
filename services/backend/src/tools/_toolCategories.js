'use strict';

/**
 * _toolCategories — single source of truth for the tool-category taxonomy.
 *
 * Historically the validator (_baseTool: `category` must be a key of
 * CATEGORIES) and the repair layer (_toolHealer: fuzzy-match of invalid
 * values) each kept their own copy; the 09-05 multimodal regression was
 * exactly that two-copy drift. Now: CATEGORIES (key → user-facing
 * description) is the one authoritative map and VALID_CATEGORIES is
 * derived from its keys, so the two can no longer diverge.
 *
 * Contract: pure data leaf — zero IO, deterministic.
 */

// key → user-facing description
const CATEGORIES = {
  data: 'Data retrieval & market information',
  analysis: 'Quantitative analysis & backtesting',
  execution: 'Code execution & shell commands',
  filesystem: 'File read/write operations',
  git: 'Git version control operations',
  system: 'System administration & configuration',
  optimization: 'Configuration optimization & code proposals',
  coordinator: 'Multi-agent coordination & orchestration',
  mcp: 'MCP protocol tools',
  multimodal: 'Multimodal content generation (image/audio/video)',
  storage: 'Data persistence & vector storage',
  ai: 'AI model management (import/export/list/download)',
  training: 'Model training & fine-tuning',
  realtime: 'Real-time streaming & WebSocket APIs',
  custom: 'User-defined custom tools',
};

// Derived — adding a key above automatically extends the valid set.
const VALID_CATEGORIES = Object.freeze(Object.keys(CATEGORIES));

module.exports = { CATEGORIES, VALID_CATEGORIES };
