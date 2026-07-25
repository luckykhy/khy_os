/**
 * Skill Search Service — Discovery and relevance matching for skills.
 *
 * Provides intelligent skill discovery by matching user queries against
 * available skills using trigger patterns, tags, descriptions, and
 * prompt content. Results are ranked by relevance.
 *
 * Integrates with the MCP system to include MCP-provided skills in search.
 *
 * Public API:
 *   searchSkills(query)        — Find relevant skills for a task
 *   surfaceRelevantSkills(msg) — Extract skill suggestions from a user message
 *   buildSystemReminder()      — Build the skill listing for system prompts
 */
const path = require('path');

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search for skills matching a query string.
 * Scores results by relevance across name, trigger, tags, description, and category.
 *
 * @param {string} query - Free-text search query
 * @param {object} [options]
 * @param {number} [options.limit=10] - Maximum results to return
 * @param {string} [options.category] - Filter by category
 * @param {string[]} [options.tags] - Filter by tags (any match)
 * @param {boolean} [options.userInvocableOnly=false] - Only show user-invocable skills
 * @param {boolean} [options.includeMcp=true] - Include MCP-provided tools
 * @returns {Array<{ skill: object, score: number, matchType: string }>}
 */
function searchSkills(query, options = {}) {
  const {
    limit = 10,
    category = null,
    tags = null,
    userInvocableOnly = false,
    includeMcp = true,
  } = options;

  const q = (query || '').toLowerCase().trim();
  if (!q) return [];

  const results = [];

  // Search manifest-based skills
  try {
    const skillModule = require('../skills/index');
    const skills = skillModule.getCachedSkills();

    for (const skill of skills.values()) {
      // Apply filters
      if (userInvocableOnly && !skill.userInvocable) continue;
      if (category && skill.category !== category) continue;
      if (tags && tags.length > 0) {
        const hasTag = tags.some(t => (skill.tags || []).includes(t));
        if (!hasTag) continue;
      }

      const score = _scoreSkill(skill, q);
      if (score > 0) {
        results.push({
          skill: _toSearchResult(skill),
          score,
          matchType: _getMatchType(skill, q),
        });
      }
    }
  } catch { /* skill module not available */ }

  // Search legacy registry skills
  try {
    const registry = require('./skillRegistry');
    const builtinSkills = registry.BUILTIN_SKILLS || [];
    for (const skill of builtinSkills) {
      // Avoid duplicates (if already found via manifest-based loading)
      if (results.some(r => r.skill.name === skill.id)) continue;

      const score = _scoreLegacySkill(skill, q);
      if (score > 0) {
        results.push({
          skill: {
            name: skill.id,
            description: skill.description || '',
            trigger: skill.trigger,
            category: 'quant',
            source: 'builtin-legacy',
          },
          score,
          matchType: 'legacy',
        });
      }
    }
  } catch { /* registry not available */ }

  // Search MCP tools
  if (includeMcp) {
    try {
      const mcp = require('./mcp/index');
      const mcpTools = mcp.listMCPTools();
      for (const tool of mcpTools) {
        const score = _scoreMcpTool(tool, q);
        if (score > 0) {
          results.push({
            skill: {
              name: tool.name,
              description: tool.description || '',
              trigger: null,
              category: 'mcp',
              source: `mcp:${tool.serverName}`,
              inputSchema: tool.inputJSONSchema,
            },
            score: score * 0.8, // Slight penalty vs native skills for relevance
            matchType: 'mcp-tool',
          });
        }
      }
    } catch { /* MCP not available */ }
  }

  // Sort by score descending, then truncate
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Extract skill suggestions from a user message.
 * Detects explicit triggers (e.g., "/commit") and implicit intent.
 *
 * @param {string} message - The user's message text
 * @returns {{ explicit: object|null, suggestions: object[] }}
 */
function surfaceRelevantSkills(message) {
  const result = { explicit: null, suggestions: [] };
  if (!message || typeof message !== 'string') return result;

  // Check for explicit slash command trigger
  const triggerMatch = message.match(/^\/(\S+)/);
  if (triggerMatch) {
    const trigger = triggerMatch[0];
    try {
      const skillModule = require('../skills/index');
      const skill = skillModule.findSkill(trigger);
      if (skill) {
        result.explicit = _toSearchResult(skill);
        return result;
      }
    } catch { /* ignore */ }
  }

  // Implicit intent matching via keyword search
  const keywords = _extractKeywords(message);
  if (keywords.length === 0) return result;

  const matches = searchSkills(keywords.join(' '), {
    limit: 3,
    userInvocableOnly: true,
  });

  result.suggestions = matches
    .filter(m => m.score >= 0.3) // Only reasonably confident matches
    .map(m => m.skill);

  return result;
}

/**
 * Build the skill listing block for system prompt injection.
 * Includes both native skills and MCP-provided tools.
 *
 * @param {object} [options]
 * @param {number} [options.charBudget=8000] - Maximum characters
 * @param {boolean} [options.includeMcp=true] - Include MCP tools
 * @returns {string}
 */
function buildSystemReminder(options = {}) {
  const { charBudget = 8000, includeMcp = true } = options;
  const sections = [];

  // Native skills
  try {
    const skillModule = require('../skills/index');
    const listing = skillModule.formatSkillListing(Math.floor(charBudget * 0.7), {
      cwd: process.cwd(),
    });
    if (listing) {
      sections.push(listing);
    }
  } catch { /* ignore */ }

  // MCP tools
  if (includeMcp) {
    try {
      const mcp = require('./mcp/index');
      const tools = mcp.listMCPTools();
      if (tools.length > 0) {
        const mcpBudget = charBudget - sections.reduce((s, sec) => s + sec.length, 0);
        const mcpLines = tools.map(t => {
          const desc = (t.description || '').length > 120
            ? t.description.slice(0, 119) + '\u2026'
            : (t.description || '');
          return `- ${t.name}: ${desc}`;
        });

        let mcpSection = mcpLines.join('\n');
        if (mcpSection.length > mcpBudget) {
          // Truncate tool list to fit budget
          mcpSection = '';
          for (const line of mcpLines) {
            if (mcpSection.length + line.length + 1 > mcpBudget) break;
            mcpSection += (mcpSection ? '\n' : '') + line;
          }
        }

        if (mcpSection) {
          sections.push(mcpSection);
        }
      }
    } catch { /* MCP not available */ }
  }

  // MCP server instructions
  if (includeMcp) {
    try {
      const mcp = require('./mcp/index');
      const instructions = mcp.getMCPInstructions();
      if (instructions.length > 0) {
        sections.push('\n' + instructions.join('\n\n'));
      }
    } catch { /* ignore */ }
  }

  return sections.join('\n');
}

// ── Scoring Functions ───────────────────────────────────────────────────────

/**
 * Score a manifest-based skill against a query.
 * @private
 */
function _scoreSkill(skill, query) {
  let score = 0;
  const q = query.toLowerCase();

  // Exact name match
  if (skill.name.toLowerCase() === q) return 1.0;

  // Trigger match
  if (skill.trigger === `/${q}` || skill.trigger === q) return 0.95;

  // Alias match
  if (skill.aliases) {
    for (const alias of skill.aliases) {
      if (alias === `/${q}` || alias === q) return 0.9;
    }
  }

  // Name contains query
  if (skill.name.toLowerCase().includes(q)) score = Math.max(score, 0.7);

  // Description match
  if (skill.description && skill.description.toLowerCase().includes(q)) {
    score = Math.max(score, 0.5);
  }

  // Tag match
  if (skill.tags) {
    for (const tag of skill.tags) {
      if (tag.toLowerCase() === q) { score = Math.max(score, 0.6); break; }
      if (tag.toLowerCase().includes(q)) { score = Math.max(score, 0.4); break; }
    }
  }

  // Category match
  if (skill.category && skill.category.toLowerCase().includes(q)) {
    score = Math.max(score, 0.3);
  }

  // Multi-word query: check each word
  const words = q.split(/\s+/).filter(w => w.length >= 2);
  if (words.length > 1) {
    const text = `${skill.name} ${skill.description} ${(skill.tags || []).join(' ')} ${skill.category}`.toLowerCase();
    const matchCount = words.filter(w => text.includes(w)).length;
    const wordScore = (matchCount / words.length) * 0.6;
    score = Math.max(score, wordScore);
  }

  return score;
}

/**
 * Score a legacy registry skill against a query.
 * @private
 */
function _scoreLegacySkill(skill, query) {
  let score = 0;
  const q = query.toLowerCase();

  if (skill.id && skill.id.toLowerCase() === q) return 0.9;
  if (skill.trigger === `/${q}` || skill.trigger === q) return 0.85;
  if (skill.aliases) {
    for (const alias of skill.aliases) {
      if (alias === `/${q}` || alias === q) return 0.8;
    }
  }
  if (skill.description && skill.description.toLowerCase().includes(q)) score = 0.4;
  if (skill.id && skill.id.toLowerCase().includes(q)) score = Math.max(score, 0.5);

  return score;
}

/**
 * Score an MCP tool against a query.
 * @private
 */
function _scoreMcpTool(tool, query) {
  let score = 0;
  const q = query.toLowerCase();
  const name = (tool.originalToolName || tool.name || '').toLowerCase();

  if (name === q) return 0.9;
  if (name.includes(q)) score = Math.max(score, 0.6);
  if (tool.description && tool.description.toLowerCase().includes(q)) {
    score = Math.max(score, 0.4);
  }

  return score;
}

// ── Internal Helpers ────────────────────────────────────────────────────────

/**
 * Determine the primary match type for a result.
 * @private
 */
function _getMatchType(skill, query) {
  const q = query.toLowerCase();
  if (skill.name.toLowerCase() === q) return 'name-exact';
  if (skill.trigger === `/${q}`) return 'trigger';
  if (skill.aliases && skill.aliases.some(a => a === `/${q}`)) return 'alias';
  if (skill.name.toLowerCase().includes(q)) return 'name-partial';
  if (skill.tags && skill.tags.some(t => t.toLowerCase().includes(q))) return 'tag';
  if (skill.description && skill.description.toLowerCase().includes(q)) return 'description';
  return 'keyword';
}

/**
 * Convert a skill object to a search result shape.
 * @private
 */
function _toSearchResult(skill) {
  return {
    name: skill.name,
    description: skill.description,
    trigger: skill.trigger,
    aliases: skill.aliases,
    category: skill.category,
    tags: skill.tags,
    source: skill.source,
    userInvocable: skill.userInvocable,
  };
}

/**
 * Extract meaningful keywords from a message for implicit skill matching.
 * @private
 */
function _extractKeywords(message) {
  // Common stop words to filter out
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'these',
    'those', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'she',
    'they', 'them', 'and', 'or', 'but', 'not', 'no', 'if', 'then',
    'please', 'help', 'want', 'need', 'like', 'just', 'also',
  ]);

  return message
    .toLowerCase()
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !stopWords.has(w))
    .slice(0, 8); // Limit to top 8 keywords
}

module.exports = {
  searchSkills,
  surfaceRelevantSkills,
  buildSystemReminder,
};
