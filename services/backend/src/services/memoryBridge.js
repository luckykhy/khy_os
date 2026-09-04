'use strict';

/**
 * memoryBridge.js — Bridge between ToolSpec protocol and existing memory systems.
 *
 * Integrates the new ToolSpec protocol with Khy OS's existing memory
 * infrastructure (memoryKairos, memoryEngine, memoryCompressor, etc.)
 *
 * Architecture:
 *   - MemoryBridge: unified interface for memory operations
 *   - MemoryTool: ToolSpec-compatible memory tools
 *   - MemoryRecall: intelligent memory retrieval
 *
 * Key capabilities:
 *   1. ToolSpec-compatible memory read/write tools
 *   2. Automatic memory triggering from tool results
 *   3. Session priming with relevant memories
 *   4. Background memory consolidation
 *   5. Memory-aware context injection
 *
 * @module memoryBridge
 */

const fs = require('fs');
const path = require('path');

const { ToolSpec, ToolResult, ToolCategory, RiskLevel } = require('./toolSpec');

// ── Memory Types ─────────────────────────────────────────────────────────

const MemoryType = Object.freeze({
  USER: 'user',           // User profile, preferences
  FEEDBACK: 'feedback',   // Corrections, guidance
  PROJECT: 'project',     // Ongoing work, decisions
  REFERENCE: 'reference', // External resources
  SESSION: 'session',     // Session-scoped ephemeral
});

// ── Memory Tool Factory ──────────────────────────────────────────────────

/**
 * Create ToolSpec-compatible memory tools.
 * @param {object} options
 * @param {string} options.appHome - Application data directory
 * @param {function} options.llmClient - LLM client for consolidation
 * @returns {ToolSpec[]}
 */
function createMemoryTools(options = {}) {
  const { appHome } = options;
  const memoryDir = path.join(appHome || '', 'memory');

  // Ensure memory directory exists
  function ensureMemoryDir() {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    for (const sub of ['logs', 'user', 'feedback', 'project', 'reference']) {
      const dir = path.join(memoryDir, sub);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  // Get daily log path
  function getDailyLogPath() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const dir = path.join(memoryDir, 'logs', String(year), month);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return path.join(dir, `${year}-${month}-${day}.md`);
  }

  // Read memory index
  function readMemoryIndex() {
    const indexPath = path.join(memoryDir, 'MEMORY.md');
    try {
      if (fs.existsSync(indexPath)) {
        return fs.readFileSync(indexPath, 'utf-8');
      }
    } catch {
      // Ignore read errors
    }
    return '';
  }

  // Append to daily log
  function appendDailyLog(entry) {
    ensureMemoryDir();
    const logPath = getDailyLogPath();
    const timestamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const logEntry = `\n## ${timestamp}\n${entry}\n`;
    fs.appendFileSync(logPath, logEntry, 'utf-8');
  }

  // Find relevant memories
  function findRelevantMemories(query, limit = 5) {
    const results = [];
    const queryLower = query.toLowerCase();

    // Search in each memory type directory
    for (const type of Object.values(MemoryType)) {
      if (type === MemoryType.SESSION) continue;
      const typeDir = path.join(memoryDir, type);
      if (!fs.existsSync(typeDir)) continue;

      try {
        const files = fs.readdirSync(typeDir).filter(f => f.endsWith('.md'));
        for (const file of files) {
          const filePath = path.join(typeDir, file);
          const content = fs.readFileSync(filePath, 'utf-8');
          const contentLower = content.toLowerCase();

          // Simple keyword matching
          const words = queryLower.split(/\s+/);
          let score = 0;
          for (const word of words) {
            if (word.length > 2 && contentLower.includes(word)) {
              score += 1;
            }
          }

          if (score > 0) {
            results.push({
              type,
              file: file.slice(0, -3), // Remove .md
              path: filePath,
              score,
              preview: content.slice(0, 200),
            });
          }
        }
      } catch {
        // Ignore read errors
      }
    }

    // Sort by score and limit
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ── Memory Tools ────────────────────────────────────────────────────

  const readMemoryTool = new ToolSpec({
    name: 'read_memory',
    description: 'Read from long-term memory. Search for relevant memories by keyword, read daily logs, or browse memory categories (user/feedback/project/reference).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to find relevant memories' },
        type: { type: 'string', description: 'Memory type filter: user, feedback, project, reference' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
    },
    execute: async (params) => {
      const query = params.query || '';
      const limit = params.limit || 5;

      if (!query) {
        // Return memory index
        const index = readMemoryIndex();
        return ToolResult.success({
          index: index || '(Memory index is empty)',
          categories: Object.values(MemoryType).filter(t => t !== MemoryType.SESSION),
        });
      }

      const memories = findRelevantMemories(query, limit);
      return ToolResult.success({
        query,
        found: memories.length,
        memories: memories.map(m => ({
          type: m.type,
          name: m.file,
          preview: m.preview,
        })),
      });
    },
    readOnly: true,
    mutatesFiles: false,
    requiresPermission: false,
    parallelSafe: true,
    category: ToolCategory.LOCAL,
    risk: RiskLevel.SAFE,
    aliases: ['recall_memory', 'search_memory'],
    activityDescription: '检索记忆',
  });

  const writeMemoryTool = new ToolSpec({
    name: 'write_memory',
    description: 'Write to long-term memory. Store user preferences, project context, feedback, or reference information for future recall.',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description: 'Memory type: user, feedback, project, reference',
          enum: ['user', 'feedback', 'project', 'reference'],
        },
        name: { type: 'string', description: 'Memory name/identifier (e.g., "user-preferences", "project-khyos")' },
        content: { type: 'string', description: 'Memory content to store' },
        append: { type: 'boolean', description: 'Append to existing memory instead of overwriting' },
      },
      required: ['type', 'name', 'content'],
    },
    execute: async (params) => {
      const { type, name, content, append } = params;

      if (!Object.values(MemoryType).includes(type)) {
        return ToolResult.error(`Invalid memory type: ${type}. Must be one of: ${Object.values(MemoryType).join(', ')}`);
      }

      ensureMemoryDir();
      const typeDir = path.join(memoryDir, type);
      if (!fs.existsSync(typeDir)) {
        fs.mkdirSync(typeDir, { recursive: true });
      }

      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100);
      const filePath = path.join(typeDir, `${safeName}.md`);

      try {
        let finalContent = content;
        if (append && fs.existsSync(filePath)) {
          const existing = fs.readFileSync(filePath, 'utf-8');
          finalContent = `${existing}\n\n---\n\n${content}`;
        }

        // Atomic write
        const tmpPath = `${filePath}.tmp`;
        fs.writeFileSync(tmpPath, finalContent, 'utf-8');
        fs.renameSync(tmpPath, filePath);

        // Log the write
        appendDailyLog(`[write_memory] ${type}/${name}: ${content.slice(0, 100)}...`);

        return ToolResult.success({
          type,
          name,
          path: filePath,
          action: append ? 'appended' : 'written',
          bytes: finalContent.length,
        });
      } catch (err) {
        return ToolResult.error(`Failed to write memory: ${err.message}`);
      }
    },
    readOnly: false,
    mutatesFiles: true,
    requiresPermission: false,
    parallelSafe: false,
    category: ToolCategory.LOCAL,
    risk: RiskLevel.LOW,
    aliases: ['store_memory', 'remember'],
    activityDescription: '写入记忆',
  });

  const logActivityTool = new ToolSpec({
    name: 'log_activity',
    description: 'Log an activity or event to the daily log. Useful for tracking decisions, milestones, or notable events.',
    inputSchema: {
      type: 'object',
      properties: {
        entry: { type: 'string', description: 'Activity entry to log' },
        tag: { type: 'string', description: 'Optional tag (e.g., "decision", "milestone", "bug")' },
      },
      required: ['entry'],
    },
    execute: async (params) => {
      const { entry, tag } = params;
      const taggedEntry = tag ? `[${tag}] ${entry}` : entry;

      try {
        appendDailyLog(taggedEntry);
        return ToolResult.success({
          logged: true,
          entry: entry.slice(0, 100),
          tag: tag || null,
        });
      } catch (err) {
        return ToolResult.error(`Failed to log activity: ${err.message}`);
      }
    },
    readOnly: false,
    mutatesFiles: true,
    requiresPermission: false,
    parallelSafe: false,
    category: ToolCategory.LOCAL,
    risk: RiskLevel.SAFE,
    aliases: ['log_event', 'daily_log'],
    activityDescription: '记录日志',
  });

  return [readMemoryTool, writeMemoryTool, logActivityTool];
}

// ── Memory Bridge Class ──────────────────────────────────────────────────

/**
 * Bridge between ToolSpec protocol and memory systems.
 */
class MemoryBridge {
  /**
   * @param {object} options
   * @param {string} options.appHome
   * @param {object} options.registry - ToolRegistry instance
   */
  constructor(options = {}) {
    this._appHome = options.appHome;
    this._registry = options.registry;
    this._tools = createMemoryTools(options);

    if (this._registry) {
      for (const tool of this._tools) {
        this._registry.register(tool);
      }
    }
  }

  /**
   * Get memory tools.
   * @returns {ToolSpec[]}
   */
  getTools() {
    return this._tools;
  }

  /**
   * Get memory system status.
   * @returns {object}
   */
  getStatus() {
    const memoryDir = path.join(this._appHome || '', 'memory');
    const exists = fs.existsSync(memoryDir);

    return {
      memoryDir,
      exists,
      tools: this._tools.map(t => t.name),
    };
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  MemoryBridge,
  MemoryType,
  createMemoryTools,
};
