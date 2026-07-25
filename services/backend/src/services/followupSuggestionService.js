'use strict';

/**
 * Follow-up Suggestion Service
 *
 * Generates 2-3 intelligent follow-up suggestions after an AI response.
 * Uses a combination of:
 *   1. Pattern-based extraction (questions, lists, code mentions)
 *   2. Context-aware heuristics (file paths, errors, commands)
 *   3. Optional lightweight AI call for complex responses
 *
 * @module followupSuggestionService
 */

const log = require('../utils/logger');

// ── Pattern Extractors ──

const PATTERNS = [
  // Code file references → suggest reading/editing
  {
    regex: /(?:^|\s)([a-zA-Z0-9_/.-]+\.[a-zA-Z]{1,6}):(\d+)/gm,
    generate: (matches) => {
      const file = matches[0][1];
      return `Read ${file} and explain the relevant code`;
    },
    category: 'code',
  },
  // Error messages → suggest fixing
  {
    regex: /(?:error|Error|ERROR|exception|Exception|failed|Failed|FAILED)[:\s](.{10,80})/g,
    generate: (matches) => {
      const err = matches[0][1].trim().replace(/[.!]+$/, '');
      return `Fix the error: ${err.substring(0, 60)}`;
    },
    category: 'error',
  },
  // TODO/FIXME → suggest addressing
  {
    regex: /(?:TODO|FIXME|HACK|XXX)[:\s](.{5,80})/gi,
    generate: (matches) => {
      const todo = matches[0][1].trim();
      return `Address: ${todo.substring(0, 60)}`;
    },
    category: 'todo',
  },
  // Test mentions → suggest running tests
  {
    regex: /(?:test|spec|__tests__|\.test\.|\.spec\.)/gi,
    generate: () => 'Run the related tests to verify the changes',
    category: 'test',
  },
  // Git/commit suggestions
  {
    regex: /(?:commit|staged|unstaged|modified|untracked)/gi,
    generate: () => 'Commit the current changes with a descriptive message',
    category: 'git',
  },
  // Performance mentions
  {
    regex: /(?:slow|performance|optimize|latency|bottleneck|O\(n[²³]?\))/gi,
    generate: () => 'Profile and optimize the performance bottleneck',
    category: 'perf',
  },
  // Security mentions
  {
    regex: /(?:vulnerability|injection|XSS|CSRF|SQL injection|insecure|CVE-)/gi,
    generate: () => 'Review and fix the security vulnerability',
    category: 'security',
  },
  // Numbered lists → suggest "continue with next step"
  {
    regex: /^\s*(?:\d+[.)]\s+|[-*]\s+)/gm,
    generate: (_m, text) => {
      const steps = text.match(/^\s*\d+[.)]\s+/gm);
      if (steps && steps.length >= 3) {
        return 'Implement the next step from the plan';
      }
      return null;
    },
    category: 'plan',
  },
];

// ── Context-Aware Templates ──

const CONTEXT_TEMPLATES = {
  // After code generation
  codeGenerated: [
    'Run the code to verify it works',
    'Add tests for the new code',
    'Review the code for edge cases',
  ],
  // After explanation
  explanation: [
    'Show me a concrete example',
    'What are the alternatives?',
    'How would this change in a production environment?',
  ],
  // After file editing
  fileEdit: [
    'Run the related tests',
    'Show the diff of all changes so far',
    'Commit the changes',
  ],
  // After error/debugging
  debugging: [
    'Show me the full stack trace',
    'Check if there are related issues',
    'Add logging to trace the root cause',
  ],
  // Default
  general: [
    'Explain this in more detail',
    'What are the next steps?',
    'Are there any potential issues?',
  ],
};

// ── Suggestion Generator ──

/**
 * Detect the response category based on content analysis.
 * @param {string} text - The AI response text
 * @param {object} [context] - Additional context (toolCalls, messages, etc.)
 * @returns {string}
 */
function _detectCategory(text, context) {
  if (!text) return 'general';

  const lower = text.toLowerCase();
  const ctx = context || {};

  // Check tool calls first
  if (ctx.toolCalls && ctx.toolCalls.length > 0) {
    const toolNames = ctx.toolCalls.map((t) => t.name || '');
    if (toolNames.some((n) => /write|edit|create/i.test(n))) return 'fileEdit';
    if (toolNames.some((n) => /bash|shell|exec/i.test(n))) return 'codeGenerated';
    if (toolNames.some((n) => /read|glob|grep/i.test(n))) return 'explanation';
  }

  // Content heuristics
  if (/```[\s\S]{30,}```/.test(text)) return 'codeGenerated';
  if (/error|exception|failed|traceback|stack trace/i.test(lower)) return 'debugging';
  if (/created|written|saved|updated.*file/i.test(lower)) return 'fileEdit';
  if (/because|therefore|this means|in other words|essentially/i.test(lower)) return 'explanation';

  return 'general';
}

/**
 * Extract pattern-based suggestions from the response text.
 * @param {string} text
 * @returns {string[]}
 */
function _extractPatternSuggestions(text) {
  if (!text || text.length < 20) return [];

  const suggestions = [];
  const seenCategories = new Set();

  for (const pattern of PATTERNS) {
    if (seenCategories.has(pattern.category)) continue;

    const matches = [...text.matchAll(pattern.regex)];
    if (matches.length > 0) {
      const suggestion = pattern.generate(matches, text);
      if (suggestion) {
        suggestions.push(suggestion);
        seenCategories.add(pattern.category);
      }
    }
    if (suggestions.length >= 2) break;
  }

  return suggestions;
}

/**
 * Generate follow-up suggestions for an AI response.
 *
 * @param {string} responseText - The AI response content
 * @param {object} [context] - Additional context
 * @param {Array<{name: string}>} [context.toolCalls] - Tools that were called
 * @param {Array<{role: string, content: string}>} [context.messages] - Conversation history
 * @param {string} [context.userPrompt] - The original user prompt
 * @returns {Promise<string[]>} 0-3 suggestions
 */
async function generateFollowUpSuggestions(responseText, context) {
  try {
    if (!responseText || responseText.length < 30) return [];

    const suggestions = [];

    // 1. Pattern-based extraction
    const patternSuggestions = _extractPatternSuggestions(responseText);
    suggestions.push(...patternSuggestions);

    // 2. Context-aware templates
    const category = _detectCategory(responseText, context);
    const templates = CONTEXT_TEMPLATES[category] || CONTEXT_TEMPLATES.general;

    // Fill up to 3 suggestions from templates
    for (const tmpl of templates) {
      if (suggestions.length >= 3) break;
      // Avoid duplicates by checking string similarity
      const isDuplicate = suggestions.some((s) => {
        const a = s.toLowerCase();
        const b = tmpl.toLowerCase();
        return a.includes(b.substring(0, 20)) || b.includes(a.substring(0, 20));
      });
      if (!isDuplicate) {
        suggestions.push(tmpl);
      }
    }

    return suggestions.slice(0, 3);
  } catch (err) {
    log.debug('Follow-up suggestion generation failed:', err.message);
    return [];
  }
}

/**
 * Format suggestions for CLI display.
 * @param {string[]} suggestions
 * @param {object} [options]
 * @param {Function} [options.chalk] - Chalk instance for coloring
 * @returns {string}
 */
function formatSuggestions(suggestions, options) {
  if (!suggestions || suggestions.length === 0) return '';

  const c = (options && options.chalk) || ((t) => t);
  const lines = [];
  lines.push('');
  lines.push(typeof c.hex === 'function'
    ? c.hex('#D77757')('  Suggestions:')
    : '  Suggestions:');

  suggestions.forEach((s, i) => {
    const label = typeof c.dim === 'function' ? c.dim(`    ${i + 1}. `) : `    ${i + 1}. `;
    const text = typeof c.white === 'function' ? c.white(s) : s;
    lines.push(label + text);
  });

  return lines.join('\n');
}

/**
 * Format suggestions as a protocol message for SDK/non-interactive mode.
 * @param {string[]} suggestions
 * @param {string} [requestId]
 * @returns {object}
 */
function toProtocolMessage(suggestions, requestId) {
  return {
    type: 'suggestions',
    suggestions: suggestions || [],
    requestId: requestId || undefined,
  };
}

module.exports = {
  generateFollowUpSuggestions,
  formatSuggestions,
  toProtocolMessage,
  // Exported for testing
  _detectCategory,
  _extractPatternSuggestions,
};
