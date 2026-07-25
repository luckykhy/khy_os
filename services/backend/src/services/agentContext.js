'use strict';

/**
 * AgentContext — per-subagent isolation container.
 *
 * Each subagent (worker, forked child) holds its own AgentContext instance.
 * This isolates session-scoped state that should NOT be shared across agents:
 *   - revealedDeferred: which deferred tools have been revealed mid-session
 *   - fileReadCache: file content cache (avoids redundant reads within one agent)
 *   - config: agent configuration with prototype-chain inheritance from parent
 *
 * Config inheritance uses Object.create(parentConfig), so a child can override
 * individual keys without mutating the parent's config.
 *
 * Usage:
 *   const root = new AgentContext({ config: { maxTokens: 8192 } });
 *   const child = root.fork({ toolFilter: 'explore' });
 *   child.config.effort = 'low'; // does not affect root.config.effort
 */
const crypto = require('crypto');
const fs = require('fs');

// Symbol-keyed flag to prevent duplicate tool-pool rebuilds within a single context
const BUILT = Symbol('agentContext.built');

class AgentContext {
  /**
   * @param {object} [opts]
   * @param {string} [opts.id] - Unique agent ID (auto-generated if omitted)
   * @param {string|null} [opts.parentId] - Parent agent ID
   * @param {number} [opts.depth] - Nesting depth (0 = root)
   * @param {object} [opts.parentConfig] - Parent config for prototype chain
   * @param {object} [opts.config] - Own config overrides
   * @param {Iterable<string>} [opts.inheritRevealed] - Revealed tools from parent
   * @param {string|null} [opts.toolFilter] - Tool profile filter name
   * @param {Array<string>|null} [opts.disallowedTools] - Denylist of tool names this agent must not use
   * @param {string} [opts.role] - Agent role (explore, coder, reviewer, general)
   * @param {Array} [opts.systemPromptPrefix] - Shared system prompt prefix for cache reuse
   * @param {Array} [opts.conversationPrefix] - Read-only conversation prefix from parent (for API cache hits)
   * @param {Map} [opts.sharedFileCache] - Shared file read cache from parent (read-only reference)
   */
  constructor(opts = {}) {
    this.id = opts.id || crypto.randomBytes(4).toString('hex');
    this.parentId = opts.parentId || null;
    this.depth = opts.depth || 0;
    this.role = opts.role || 'general';

    // Config: prototype chain inheritance from parent
    if (opts.parentConfig && typeof opts.parentConfig === 'object') {
      this.config = Object.create(opts.parentConfig);
      // Apply own overrides
      if (opts.config) {
        for (const [key, value] of Object.entries(opts.config)) {
          this.config[key] = value;
        }
      }
    } else {
      this.config = {
        maxTokens: 8192,
        effort: 'medium',
        contextWindowTokens: 128000,
        ...(opts.config || {}),
      };
    }

    // Per-agent isolated state
    /** @type {Set<string>} Deferred tools revealed in this agent's session */
    this.revealedDeferred = new Set(opts.inheritRevealed || []);

    /** @type {Map<string, {content: string, mtime: number, accessCount: number}>} */
    this.fileReadCache = new Map();

    /**
     * Shared file read cache from parent for cross-agent cache reuse.
     * Child agents check this first before reading from disk, avoiding
     * redundant I/O for files the parent already loaded.
     * @type {Map|null}
     */
    this._sharedFileCache = opts.sharedFileCache || null;

    /**
     * System prompt prefix shared with child agents for prompt cache reuse.
     * When the parent and child share the same system prompt prefix, API
     * prompt caching can reuse the cached prefix (saves tokens + latency).
     * @type {Array|null}
     */
    this.systemPromptPrefix = opts.systemPromptPrefix || null;

    /**
     * Read-only conversation prefix from parent agent.
     * When child agents share the same conversation prefix as the parent,
     * the API prompt cache can reuse the parent's cached conversation history,
     * reducing tokens and latency for forked agents.
     * @type {Array|null}
     */
    this.conversationPrefix = opts.conversationPrefix || null;

    /** @type {string|null} Tool profile filter name */
    this.toolFilter = opts.toolFilter || null;

    /** @type {Array<string>|null} Denylist of tool names this agent must not use */
    this.disallowedTools = opts.disallowedTools || null;

    // Symbol-keyed flag to prevent double rebuild
    this[BUILT] = false;

    this.createdAt = Date.now();
  }

  // ── File read cache ─────────────────────────────────────────────

  /**
   * Read a file with caching. Returns cached content if file hasn't changed.
   * @param {string} filePath - Absolute file path
   * @returns {{ content: string, fromCache: boolean } | null}
   */
  readFile(filePath) {
    const cached = this.fileReadCache.get(filePath);

    // Check if file still matches cached version
    if (cached) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.mtimeMs === cached.mtime) {
          cached.accessCount++;
          return { content: cached.content, fromCache: true };
        }
      } catch {
        // File gone or inaccessible — evict cache
        this.fileReadCache.delete(filePath);
        return null;
      }
    }

    // Check shared parent cache (read-only, avoids redundant disk I/O)
    if (this._sharedFileCache) {
      const sharedEntry = this._sharedFileCache.get(filePath);
      if (sharedEntry) {
        try {
          const stat = fs.statSync(filePath);
          if (stat.mtimeMs === sharedEntry.mtime) {
            // Copy to own cache on first shared hit
            this.fileReadCache.set(filePath, {
              content: sharedEntry.content,
              mtime: sharedEntry.mtime,
              accessCount: 1,
            });
            return { content: sharedEntry.content, fromCache: true };
          }
        } catch {
          return null;
        }
      }
    }

    // Read fresh
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);
      this.fileReadCache.set(filePath, {
        content,
        mtime: stat.mtimeMs,
        accessCount: 1,
      });
      return { content, fromCache: false };
    } catch {
      return null;
    }
  }

  /**
   * Invalidate a specific file in the cache.
   * @param {string} filePath
   */
  invalidateFile(filePath) {
    this.fileReadCache.delete(filePath);
  }

  /**
   * Clear the entire file cache.
   */
  clearFileCache() {
    this.fileReadCache.clear();
  }

  // ── Deferred tool management ────────────────────────────────────

  /**
   * Reveal a deferred tool in this agent's session.
   * @param {string} toolName
   */
  revealTool(toolName) {
    this.revealedDeferred.add(toolName);
  }

  /**
   * Check if a deferred tool has been revealed.
   * @param {string} toolName
   * @returns {boolean}
   */
  isToolRevealed(toolName) {
    return this.revealedDeferred.has(toolName);
  }

  // ── Build guard ─────────────────────────────────────────────────

  /**
   * Mark this context as built (tool pool assembled).
   * Prevents redundant rebuilds within the same agent session.
   */
  markBuilt() {
    this[BUILT] = true;
  }

  /**
   * Check if this context has already been built.
   * @returns {boolean}
   */
  isBuilt() {
    return this[BUILT] === true;
  }

  // ── Forking ─────────────────────────────────────────────────────

  /**
   * Fork a child AgentContext.
   * Child inherits parent's config via prototype chain, copies revealed tools,
   * shares the parent's file cache (read-only) and system prompt prefix for
   * prompt cache reuse.
   *
   * @param {object} [childOpts]
   * @param {string} [childOpts.role] - Child agent role
   * @param {string} [childOpts.toolFilter] - Child tool profile filter
   * @param {object} [childOpts.config] - Config overrides for child
   * @param {boolean} [childOpts.shareFileCache=true] - Share parent's file cache with child
   * @param {boolean} [childOpts.sharePromptPrefix=true] - Share system prompt prefix
   * @param {Array} [childOpts.conversationPrefix] - Override conversation prefix for child
   * @returns {AgentContext}
   */
  fork(childOpts = {}) {
    const shareFileCache = childOpts.shareFileCache !== false;
    const sharePromptPrefix = childOpts.sharePromptPrefix !== false;

    return new AgentContext({
      parentId: this.id,
      depth: this.depth + 1,
      parentConfig: this.config,
      inheritRevealed: [...this.revealedDeferred],
      toolFilter: childOpts.toolFilter || this.toolFilter,
      disallowedTools: childOpts.disallowedTools || this.disallowedTools,
      role: childOpts.role || this.role,
      config: childOpts.config,
      sharedFileCache: shareFileCache ? this.fileReadCache : null,
      systemPromptPrefix: sharePromptPrefix ? this.systemPromptPrefix : null,
      conversationPrefix: childOpts.conversationPrefix || (sharePromptPrefix ? this.conversationPrefix : null),
    });
  }

  // ── Serialization ───────────────────────────────────────────────

  /**
   * Serialize context state for diagnostics / tracing.
   * @returns {object}
   */
  toJSON() {
    return {
      id: this.id,
      parentId: this.parentId,
      depth: this.depth,
      role: this.role,
      toolFilter: this.toolFilter,
      revealedCount: this.revealedDeferred.size,
      fileCacheSize: this.fileReadCache.size,
      built: this[BUILT],
      createdAt: this.createdAt,
    };
  }

  /**
   * Serialize to a plain JSON-safe object for cross-process IPC transfer.
   * Strips Maps, Symbols, functions, and file caches (child starts fresh).
   * @returns {object}
   */
  toSerializable() {
    // Flatten prototype-chain config into a plain object
    const flatConfig = {};
    for (const key in this.config) {
      flatConfig[key] = this.config[key];
    }

    return {
      _agentCtxVersion: 1,
      id: this.id,
      parentId: this.parentId,
      depth: this.depth,
      role: this.role,
      toolFilter: this.toolFilter,
      config: flatConfig,
      revealedDeferred: [...this.revealedDeferred],
      systemPromptPrefix: this.systemPromptPrefix,
      conversationPrefix: this.conversationPrefix,
      createdAt: this.createdAt,
    };
  }

  /**
   * Reconstruct an AgentContext from a serialized plain object.
   * Used in forked child processes after receiving context via IPC.
   * @param {object} json - Output of toSerializable()
   * @returns {AgentContext}
   */
  static fromSerializable(json) {
    if (!json || json._agentCtxVersion !== 1) {
      throw new Error('Invalid serialized AgentContext (version mismatch or missing)');
    }
    return new AgentContext({
      id: json.id,
      parentId: json.parentId,
      depth: json.depth,
      role: json.role,
      toolFilter: json.toolFilter,
      config: json.config || {},
      inheritRevealed: json.revealedDeferred || [],
      systemPromptPrefix: json.systemPromptPrefix || null,
      conversationPrefix: json.conversationPrefix || null,
    });
  }
}

// Expose the symbol for external use
AgentContext.BUILT = BUILT;

module.exports = { AgentContext };
