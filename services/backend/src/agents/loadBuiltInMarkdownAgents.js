'use strict';

/**
 * Markdown-based built-in agent loader.
 *
 * Scans the built-in/ directory for .md files that declare `builtin: true`
 * in their frontmatter and converts them to BuiltInAgentDefinition objects.
 *
 * This allows new built-in agents to be added as simple markdown files
 * without writing JavaScript. The .js agent files remain fully supported
 * and take priority on name collisions (they are loaded first).
 *
 * Frontmatter fields (subset of what parseAgentFromMarkdown supports):
 *   builtin: true          (required — gates the file as a built-in agent)
 *   name: agent-type       (required)
 *   description: ...       (required)
 *   tools: [Tool1, Tool2]  (optional)
 *   disallowedTools: [...] (optional)
 *   model: sonnet          (optional — haiku/sonnet/opus/inherit)
 *   color: blue            (optional — must be in AGENT_COLORS)
 *   background: true       (optional)
 *   maxTurns: 10           (optional)
 *   permissionMode: dontAsk (optional)
 *
 * The markdown body becomes the system prompt.
 */

const fs = require('fs');
const path = require('path');
const { parseAgentFromMarkdown } = require('./loadAgents');
const { AGENT_COLORS } = require('./types');

// Cache to avoid re-scanning on every call
let _markdownBuiltInCache = null;

/**
 * Scan the built-in/ directory for markdown agents.
 * Pure function: reads from disk, never throws — returns [] on any error.
 *
 * @returns {Array<import('./types').BuiltInAgentDefinition>}
 */
function loadBuiltInMarkdownAgents() {
  if (_markdownBuiltInCache !== null) {
    return _markdownBuiltInCache;
  }

  const agents = [];
  const dir = path.join(__dirname, 'built-in');

  try {
    if (!fs.existsSync(dir)) {
      _markdownBuiltInCache = agents;
      return agents;
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      const filePath = path.join(dir, file);
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = parseAgentFromMarkdown(filePath, 'built-in');

        if (!parsed) {
          continue; // missing name/description/body — skip silently
        }

        // Gate: only files explicitly marked as builtin are auto-loaded
        // We re-parse the raw frontmatter to check the builtin flag
        const builtinFlag = _extractBuiltinFlag(raw);
        if (!builtinFlag) {
          continue;
        }

        // Convert CustomAgentDefinition → BuiltInAgentDefinition
        const builtInAgent = {
          agentType: parsed.agentType,
          whenToUse: parsed.whenToUse,
          source: 'built-in',
          baseDir: 'built-in',
          getSystemPrompt: parsed.getSystemPrompt,
          ...(parsed.tools !== undefined ? { tools: parsed.tools } : {}),
          ...(parsed.disallowedTools !== undefined ? { disallowedTools: parsed.disallowedTools } : {}),
          ...(parsed.color && AGENT_COLORS.includes(parsed.color) ? { color: parsed.color } : {}),
          ...(parsed.model !== undefined ? { model: parsed.model } : {}),
          ...(parsed.background ? { background: true } : {}),
          ...(parsed.maxTurns && !isNaN(parsed.maxTurns) ? { maxTurns: parsed.maxTurns } : {}),
          ...(parsed.permissionMode ? { permissionMode: parsed.permissionMode } : {}),
        };

        agents.push(builtInAgent);
      } catch {
        // Skip unreadable files silently
      }
    }
  } catch {
    // Directory not readable — return empty
  }

  _markdownBuiltInCache = agents;
  return agents;
}

/**
 * Quick check: does this markdown content have `builtin: true` in frontmatter?
 * Doesn't do full parsing — just a string scan for the flag.
 *
 * @param {string} raw
 * @returns {boolean}
 */
function _extractBuiltinFlag(raw) {
  // Extract the frontmatter block (between --- markers)
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    return false;
  }
  // Look for builtin: true (case-insensitive for the key)
  return /\bbuiltin\s*:\s*true\b/i.test(match[1]);
}

/**
 * Clear the markdown built-in agent cache.
 * Exposed for testing.
 */
function clearMarkdownBuiltInCache() {
  _markdownBuiltInCache = null;
}

module.exports = {
  loadBuiltInMarkdownAgents,
  clearMarkdownBuiltInCache,
};
