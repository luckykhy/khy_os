'use strict';

/**
 * Custom agent loader for khy OS.
 * Loads agent definitions from .khy/agents/ directory and project-level .claude/agents/.
 * Aligned with Claude Code's loadAgentsDir.ts markdown-based agent definitions.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { AGENT_COLORS } = require('./types');

// Cache for agent definitions
let _agentCache = null;
let _cacheKey = null;

/**
 * Parse YAML-like frontmatter from markdown content.
 * Simple parser — handles key: value pairs, not full YAML.
 *
 * @param {string} content
 * @returns {{ frontmatter: Record<string, unknown>, body: string }}
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const rawFM = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of rawFM.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Parse boolean-like
    if (value === 'true') value = true;
    else if (value === 'false') value = false;

    // Parse arrays (comma-separated inline)
    if (typeof value === 'string' && value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    }

    frontmatter[key] = value;
  }

  return { frontmatter, body };
}

/**
 * Parse an agent definition from a markdown file.
 *
 * Expected frontmatter:
 * ---
 * name: agent-type
 * description: When to use this agent
 * tools: [Tool1, Tool2]        (optional)
 * disallowedTools: [Agent]     (optional)
 * model: haiku                 (optional)
 * color: blue                  (optional)
 * background: true             (optional)
 * maxTurns: 10                 (optional)
 * permissionMode: dontAsk      (optional)
 * ---
 * System prompt content here...
 *
 * @param {string} filePath
 * @param {string} source
 * @returns {import('./types').CustomAgentDefinition|null}
 */
function parseAgentFromMarkdown(filePath, source) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(raw);

    const agentType = frontmatter.name;
    const whenToUse = frontmatter.description;

    if (!agentType || typeof agentType !== 'string') return null;
    if (!whenToUse || typeof whenToUse !== 'string') return null;

    const systemPrompt = body.trim();
    if (!systemPrompt) return null;

    // Parse tools
    let tools;
    if (frontmatter.tools) {
      tools = Array.isArray(frontmatter.tools)
        ? frontmatter.tools
        : typeof frontmatter.tools === 'string'
          ? frontmatter.tools.split(',').map(s => s.trim()).filter(Boolean)
          : undefined;
    }

    let disallowedTools;
    if (frontmatter.disallowedTools) {
      disallowedTools = Array.isArray(frontmatter.disallowedTools)
        ? frontmatter.disallowedTools
        : typeof frontmatter.disallowedTools === 'string'
          ? frontmatter.disallowedTools.split(',').map(s => s.trim()).filter(Boolean)
          : undefined;
    }

    const color = frontmatter.color;
    const model = frontmatter.model ? String(frontmatter.model) : undefined;
    const background = frontmatter.background === true || frontmatter.background === 'true' ? true : undefined;
    const maxTurns = frontmatter.maxTurns ? parseInt(frontmatter.maxTurns, 10) : undefined;
    const permissionMode = frontmatter.permissionMode || undefined;
    const filename = path.basename(filePath, '.md');

    return {
      agentType,
      whenToUse: typeof whenToUse === 'string' ? whenToUse.replace(/\\n/g, '\n') : whenToUse,
      ...(tools !== undefined ? { tools } : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      getSystemPrompt: () => systemPrompt,
      source,
      filename,
      baseDir: path.dirname(filePath),
      ...(color && AGENT_COLORS.includes(color) ? { color } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(background ? { background } : {}),
      ...(maxTurns && !isNaN(maxTurns) ? { maxTurns } : {}),
      ...(permissionMode ? { permissionMode } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Find every nested `agents/` directory under a plugin root (bounded walk).
 * Used by the CC agent bridge to locate plugin-shipped subagents, which live at
 * `<plugin>/.../agents/*.md`. Best-effort — unreadable dirs are skipped, depth
 * is capped to avoid pathological trees. Never throws.
 *
 * @param {string} rootDir
 * @param {number} [maxDepth=6]
 * @returns {string[]} absolute paths of directories named `agents`
 */
function _findNestedAgentDirs(rootDir, maxDepth = 6) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const sub = path.join(dir, entry.name);
      if (entry.name === 'agents') found.push(sub);
      walk(sub, depth + 1);
    }
  };
  walk(rootDir, 0);
  return found;
}

/**
 * Load custom agents from agent directories.
 * Searches:
 * 1. ~/.khy/agents/  (user-level)
 * 2. .claude/agents/ (project-level, for compatibility)
 * 3. .khy/agents/    (project-level, khy-specific)
 *
 * @param {string} cwd - Current working directory
 * @returns {Promise<{ agents: import('./types').CustomAgentDefinition[], failedFiles: Array<{path: string, error: string}> }>}
 */
async function loadCustomAgents(cwd) {
  const cacheKey = cwd;
  if (_agentCache && _cacheKey === cacheKey) {
    return _agentCache;
  }

  const agents = [];
  const failedFiles = [];

  const searchDirs = [
    { dir: path.join(os.homedir(), '.khy', 'agents'), source: 'userSettings' },
    { dir: path.join(cwd, '.claude', 'agents'), source: 'projectSettings' },
    { dir: path.join(cwd, '.khy', 'agents'), source: 'projectSettings' },
  ];

  // CC agent-marketplace bridge (gated, default ON): also reuse subagents that
  // Claude Code has installed — user-level ~/.claude/agents plus plugin-nested
  // agents/ dirs (~/.claude/plugins/cache, ~/.claude/local-plugins). khy's
  // parseAgentFromMarkdown already accepts CC's frontmatter. Appended AFTER khy
  // roots so khy/project agents keep priority. OFF → byte-identical legacy dirs.
  try {
    const ccBridge = require('./ccAgentBridge');
    if (ccBridge.isCcAgentBridgeEnabled()) {
      for (const root of ccBridge.ccAgentSearchDirs({ homedir: os.homedir() })) {
        if (!root.recursive) {
          searchDirs.push({ dir: root.dir, source: 'ccAgent' });
        } else {
          // Plugin roots: find every nested `agents/` directory and add it flat.
          for (const nested of _findNestedAgentDirs(root.dir)) {
            searchDirs.push({ dir: nested, source: 'ccPluginAgent' });
          }
        }
      }
    }
  } catch { /* bridge unavailable → khy-only agent discovery */ }

  for (const { dir, source } of searchDirs) {
    try {
      if (!fs.existsSync(dir)) continue;

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
      for (const file of files) {
        const filePath = path.join(dir, file);
        try {
          const agent = parseAgentFromMarkdown(filePath, source);
          if (agent) {
            agents.push(agent);
          }
        } catch (err) {
          failedFiles.push({ path: filePath, error: err.message || String(err) });
        }
      }
    } catch {
      // Directory not readable, skip
    }
  }

  const result = { agents, failedFiles };
  _agentCache = result;
  _cacheKey = cacheKey;
  return result;
}

/**
 * Clear the agent definitions cache.
 */
function clearAgentCache() {
  _agentCache = null;
  _cacheKey = null;
}

module.exports = {
  loadCustomAgents,
  clearAgentCache,
  parseAgentFromMarkdown,
  parseFrontmatter,
};
