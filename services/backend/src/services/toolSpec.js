'use strict';

/**
 * toolSpec.js — Unified Tool Specification Protocol.
 *
 * Inspired by Y-code's frozen ToolSpec dataclass. Provides a unified
 * protocol for AI-discoverable tools with metadata for intelligent
 * scheduling (read-only, parallel-safe, cancellable, etc.).
 *
 * Architecture:
 *   - ToolSpec: immutable tool definition with metadata
 *   - ToolResult: standardized tool execution result
 *   - ToolRegistry: unified registration and discovery
 *
 * Key capabilities:
 *   1. Tools declare read_only/parallel_safe/cancellable metadata
 *   2. AI can dynamically discover available tools
 *   3. Results are uniformly structured for caching/compression
 *   4. Permission metadata is co-located with tool definition
 *
 * @module toolSpec
 */

const crypto = require('crypto');

// ── Tool Category Constants ──────────────────────────────────────────────

const ToolCategory = Object.freeze({
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  SHELL: 'shell',
  SEARCH: 'search',
  WEB: 'web',
  GIT: 'git',
  AI: 'ai',
  LOCAL: 'local',
  SYSTEM: 'system',
  MCP: 'mcp',
  PLUGIN: 'plugin',
});

// ── Risk Level Constants ─────────────────────────────────────────────────

const RiskLevel = Object.freeze({
  SAFE: 'safe',       // No side effects, always auto-approved
  LOW: 'low',         // Minimal risk, logged
  MEDIUM: 'medium',   // Moderate risk, user confirmation
  HIGH: 'high',       // High risk, explicit confirmation
  CRITICAL: 'critical', // Destructive, requires explicit confirmation
});

// ── ToolSpec Class ───────────────────────────────────────────────────────

/**
 * Immutable tool specification.
 *
 * Mirrors Y-code's frozen ToolSpec dataclass. All fields are set at
 * construction time and cannot be modified thereafter.
 */
class ToolSpec {
  /**
   * @param {object} config
   * @param {string} config.name - Canonical tool name
   * @param {string} config.description - Human-readable description
   * @param {object} config.inputSchema - JSON Schema for parameters
   * @param {function} config.execute - Async function (params) => ToolResult
   * @param {boolean} [config.readOnly=true] - Does not mutate state
   * @param {boolean} [config.mutatesFiles=false] - Modifies filesystem
   * @param {boolean} [config.requiresPermission=true] - Needs user approval
   * @param {boolean} [config.cancellable=true] - Can be cancelled mid-execution
   * @param {boolean} [config.parallelSafe=false] - Safe to run concurrently
   * @param {string} [config.category='system'] - Tool category
   * @param {string} [config.risk='medium'] - Risk level
   * @param {string[]} [config.aliases=[]] - Alternative names
   * @param {string} [config.activityDescription=''] - Progress indicator text
   */
  constructor(config) {
    if (!config || typeof config !== 'object') {
      throw new TypeError('ToolSpec requires a config object');
    }
    if (!config.name || typeof config.name !== 'string') {
      throw new TypeError('ToolSpec.name is required (string)');
    }
    if (!config.description || typeof config.description !== 'string') {
      throw new TypeError('ToolSpec.description is required (string)');
    }
    if (!config.inputSchema || typeof config.inputSchema !== 'object') {
      throw new TypeError('ToolSpec.inputSchema is required (object)');
    }
    if (typeof config.execute !== 'function') {
      throw new TypeError('ToolSpec.execute is required (function)');
    }

    this._name = config.name;
    this._description = config.description;
    this._inputSchema = config.inputSchema;
    this._execute = config.execute;
    this._readOnly = config.readOnly !== false;
    this._mutatesFiles = config.mutatesFiles === true;
    this._requiresPermission = config.requiresPermission !== false;
    this._cancellable = config.cancellable !== false;
    this._parallelSafe = config.parallelSafe === true;
    this._category = config.category || ToolCategory.SYSTEM;
    this._risk = config.risk || RiskLevel.MEDIUM;
    this._aliases = Array.isArray(config.aliases) ? config.aliases.slice() : [];
    this._activityDescription = config.activityDescription || '';

    // Freeze to prevent mutation (Y-code frozen dataclass pattern)
    Object.freeze(this._aliases);
    Object.freeze(this);
  }

  // ── Getters ─────────────────────────────────────────────────────────

  get name() { return this._name; }
  get description() { return this._description; }
  get inputSchema() { return this._inputSchema; }
  get readOnly() { return this._readOnly; }
  get mutatesFiles() { return this._mutatesFiles; }
  get requiresPermission() { return this._requiresPermission; }
  get cancellable() { return this._cancellable; }
  get parallelSafe() { return this._parallelSafe; }
  get category() { return this._category; }
  get risk() { return this._risk; }
  get aliases() { return this._aliases; }
  get activityDescription() { return this._activityDescription; }

  // ── Computed Properties ─────────────────────────────────────────────

  /**
   * Whether this tool can be safely executed in parallel with others.
   * @returns {boolean}
   */
  get isParallelSafe() {
    return this._parallelSafe && this._readOnly && !this._mutatesFiles;
  }

  /**
   * Whether this tool is a read-only query.
   * @returns {boolean}
   */
  get isReadOnly() {
    return this._readOnly && !this._mutatesFiles;
  }

  // ── Methods ─────────────────────────────────────────────────────────

  /**
   * Execute the tool with given parameters.
   * @param {object} params - Tool parameters
   * @param {object} [context] - Execution context (abort signal, etc.)
   * @returns {Promise<ToolResult>}
   */
  async execute(params, context = {}) {
    const result = await this._execute(params, context);
    if (!(result instanceof ToolResult)) {
      return ToolResult.success(result);
    }
    return result;
  }

  /**
   * Convert to a JSON-serializable definition for AI consumption.
   * @returns {object}
   */
  toDefinition() {
    return {
      name: this._name,
      description: this._description,
      input_schema: this._inputSchema,
      category: this._category,
      risk: this._risk,
      read_only: this._readOnly,
      mutates_files: this._mutatesFiles,
      parallel_safe: this._parallelSafe,
      cancellable: this._cancellable,
    };
  }

  /**
   * Convert to OpenAI function-calling format.
   * @returns {object}
   */
  toOpenAIFunction() {
    return {
      type: 'function',
      function: {
        name: this._name,
        description: this._description,
        parameters: this._inputSchema,
      },
    };
  }

  /**
   * Convert to Anthropic tool format.
   * @returns {object}
   */
  toAnthropicTool() {
    return {
      name: this._name,
      description: this._description,
      input_schema: this._inputSchema,
    };
  }

  /**
   * Create a unique cache key for this tool's definition.
   * @returns {string}
   */
  getCacheKey() {
    const data = JSON.stringify(this.toDefinition());
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
  }
}

// ── ToolResult Class ─────────────────────────────────────────────────────

/**
 * Standardized tool execution result.
 *
 * Mirrors Y-code's ToolResult dataclass. Provides uniform structure
 * for tool outputs, enabling caching, compression, and intelligent
 * scheduling.
 */
class ToolResult {
  /**
   * @param {object} config
   * @param {string|object} config.content - Result content
   * @param {boolean} [config.isError=false] - Whether this is an error
   * @param {string[]} [config.changedFiles=[]] - Files modified
   * @param {string} [config.diff=null] - Diff of changes
   * @param {object} [config.metadata={}] - Additional metadata
   * @param {number} [config.tokenCount=0] - Token count of result
   */
  constructor(config) {
    this._content = config.content;
    this._isError = config.isError === true;
    this._changedFiles = Array.isArray(config.changedFiles) ? config.changedFiles.slice() : [];
    this._diff = config.diff || null;
    this._metadata = config.metadata || {};
    this._tokenCount = config.tokenCount || 0;
    this._timestamp = Date.now();
  }

  // ── Factory Methods ─────────────────────────────────────────────────

  /**
   * Create a success result.
   * @param {string|object} content
   * @param {object} [opts]
   * @returns {ToolResult}
   */
  static success(content, opts = {}) {
    return new ToolResult({
      content,
      isError: false,
      ...opts,
    });
  }

  /**
   * Create an error result.
   * @param {string} errorMessage
   * @param {object} [opts]
   * @returns {ToolResult}
   */
  static error(errorMessage, opts = {}) {
    return new ToolResult({
      content: errorMessage,
      isError: true,
      ...opts,
    });
  }

  // ── Getters ─────────────────────────────────────────────────────────

  get content() { return this._content; }
  get isError() { return this._isError; }
  get changedFiles() { return this._changedFiles; }
  get diff() { return this._diff; }
  get metadata() { return this._metadata; }
  get tokenCount() { return this._tokenCount; }
  get timestamp() { return this._timestamp; }

  // ── Methods ─────────────────────────────────────────────────────────

  /**
   * Convert to Anthropic tool_result format.
   * @param {string} toolUseId
   * @returns {object}
   */
  toAnthropic(toolUseId) {
    return {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: this._content,
      is_error: this._isError,
    };
  }

  /**
   * Convert to OpenAI tool response format.
   * @param {string} toolCallId
   * @returns {object}
   */
  toOpenAI(toolCallId) {
    return {
      tool_call_id: toolCallId,
      role: 'tool',
      content: typeof this._content === 'string' ? this._content : JSON.stringify(this._content),
    };
  }

  /**
   * Estimate token count of this result.
   * @returns {number}
   */
  estimateTokens() {
    if (this._tokenCount > 0) return this._tokenCount;
    const text = typeof this._content === 'string' ? this._content : JSON.stringify(this._content);
    // Rough estimate: 1 token ≈ 4 characters
    return Math.ceil(text.length / 4);
  }
}

// ── ToolRegistry Class ───────────────────────────────────────────────────

/**
 * Unified tool registry with discovery and metadata-based filtering.
 *
 * Provides a single source of truth for all available tools,
 * supporting both built-in and dynamically registered tools.
 */
class ToolRegistry {
  constructor() {
    /** @type {Map<string, ToolSpec>} */
    this._tools = new Map();
    /** @type {Map<string, string>} alias -> canonical name */
    this._aliases = new Map();
  }

  /**
   * Register a tool specification.
   * @param {ToolSpec} spec
   * @returns {ToolRegistry} this (for chaining)
   */
  register(spec) {
    if (!(spec instanceof ToolSpec)) {
      throw new TypeError('ToolRegistry.register requires a ToolSpec instance');
    }
    this._tools.set(spec.name, spec);
    for (const alias of spec.aliases) {
      this._aliases.set(alias.toLowerCase(), spec.name);
    }
    return this;
  }

  /**
   * Unregister a tool by name.
   * @param {string} name
   * @returns {boolean} true if removed
   */
  unregister(name) {
    const spec = this._tools.get(name);
    if (!spec) return false;
    this._tools.delete(name);
    for (const alias of spec.aliases) {
      this._aliases.delete(alias.toLowerCase());
    }
    return true;
  }

  /**
   * Look up a tool by name or alias.
   * @param {string} name
   * @returns {ToolSpec|null}
   */
  get(name) {
    const spec = this._tools.get(name);
    if (spec) return spec;
    const canonical = this._aliases.get(name.toLowerCase());
    return canonical ? this._tools.get(canonical) : null;
  }

  /**
   * Check if a tool is registered.
   * @param {string} name
   * @returns {boolean}
   */
  has(name) {
    return this._tools.has(name) || this._aliases.has(name.toLowerCase());
  }

  /**
   * Get all registered tools.
   * @returns {ToolSpec[]}
   */
  getAll() {
    return Array.from(this._tools.values());
  }

  /**
   * Get tools filtered by category.
   * @param {string} category
   * @returns {ToolSpec[]}
   */
  getByCategory(category) {
    return this.getAll().filter(t => t.category === category);
  }

  /**
   * Get read-only tools (safe for parallel execution).
   * @returns {ToolSpec[]}
   */
  getReadOnlyTools() {
    return this.getAll().filter(t => t.isReadOnly);
  }

  /**
   * Get parallel-safe tools.
   * @returns {ToolSpec[]}
   */
  getParallelSafeTools() {
    return this.getAll().filter(t => t.isParallelSafe);
  }

  /**
   * Get tools that mutate files.
   * @returns {ToolSpec[]}
   */
  getMutationTools() {
    return this.getAll().filter(t => t.mutatesFiles);
  }

  /**
   * Get tools filtered by risk level.
   * @param {string} risk
   * @returns {ToolSpec[]}
   */
  getByRisk(risk) {
    return this.getAll().filter(t => t.risk === risk);
  }

  /**
   * Get all tool definitions for AI consumption.
   * @param {object} [filter]
   * @param {boolean} [filter.readOnlyOnly]
   * @param {string} [filter.category]
   * @returns {object[]}
   */
  getDefinitions(filter = {}) {
    let tools = this.getAll();
    if (filter.readOnlyOnly) {
      tools = tools.filter(t => t.isReadOnly);
    }
    if (filter.category) {
      tools = tools.filter(t => t.category === filter.category);
    }
    return tools.map(t => t.toDefinition());
  }

  /**
   * Get all tools in OpenAI function-calling format.
   * @returns {object[]}
   */
  getOpenAIFunctions() {
    return this.getAll().map(t => t.toOpenAIFunction());
  }

  /**
   * Get all tools in Anthropic tool format.
   * @returns {object[]}
   */
  getAnthropicTools() {
    return this.getAll().map(t => t.toAnthropicTool());
  }

  /**
   * Get registry statistics.
   * @returns {object}
   */
  getStats() {
    const all = this.getAll();
    return {
      total: all.length,
      byCategory: all.reduce((acc, t) => {
        acc[t.category] = (acc[t.category] || 0) + 1;
        return acc;
      }, {}),
      byRisk: all.reduce((acc, t) => {
        acc[t.risk] = (acc[t.risk] || 0) + 1;
        return acc;
      }, {}),
      readOnly: all.filter(t => t.isReadOnly).length,
      parallelSafe: all.filter(t => t.isParallelSafe).length,
      mutation: all.filter(t => t.mutatesFiles).length,
    };
  }

  /**
   * Clear all registered tools.
   */
  clear() {
    this._tools.clear();
    this._aliases.clear();
  }
}

// ── Singleton Instance ───────────────────────────────────────────────────

const globalRegistry = new ToolRegistry();

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  ToolSpec,
  ToolResult,
  ToolRegistry,
  ToolCategory,
  RiskLevel,
  globalRegistry,
};
