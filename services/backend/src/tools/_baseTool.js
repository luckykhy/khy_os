/**
 * Base Tool — standardized tool definition interface with parameter validation.
 *
 * Each tool file in backend/src/tools/ exports a frozen tool definition created
 * via defineTool(). The registry (index.js) auto-discovers and registers them.
 *
 * Tool interface:
 *   { name, description, category, risk, inputSchema, execute }
 *
 * InputSchema is a plain object describing parameters with validation rules:
 *   { symbol: { type: 'string', required: true, maxLength: 20 } }
 *
 * Additionally, tools can be defined as ES-class subclasses of BaseTool:
 *
 *   class MyTool extends BaseTool {
 *     static toolName = 'MyTool';
 *     prompt() { return 'description'; }
 *     get inputSchema() { return { type: 'object', properties: { ... } }; }
 *     async execute(params, context) { ... }
 *   }
 *
 * No external validation library (Zod, Joi) — pure JS implementation.
 */

// ── Constants ───────────────────────────────────────────────────────

const { normalizeToolResult, maybePersistLargeResult, ensureNonEmptyContent } = require('./_toolResultNormalizer');

// The five risk-tier names come from the zero-dependency single source of truth
// (constants/riskOrder.js), not a local copy — so this validator can never drift
// from the ordinal scale used across the risk-aware modules. Re-exported below
// for back-compat with existing consumers of _baseTool's RISK_LEVELS.
const { RISK_LEVELS } = require('../constants/riskOrder');

// ── toFunctionDef() memoization (Ch2「不要每轮重建可复用结构」) ──────────────
// defineTool() 产出的 tool 是 Object.freeze 冻结的不可变对象:inputSchema/name/
// description 在其生命周期内静态,故 toFunctionDef() 是「不可变值的纯函数」——同一
// tool 每次都产出内容等价的 def。但 getDefinitions/getEnabledDefinitions/claudeAdapter
// 每轮对话、每次模型往返都对全量 ~100+ 工具逐个 t.toFunctionDef() 深建一份全新对象。
// 按 tool 对象身份(冻结即恒等)用 WeakMap 记忆 def,首建后复用同一引用;零失效面
// (tool 不可变,无需 version 计数器),tool 被 GC 时缓存条目随之释放。门关 → 每次现建
// (逐字节回退)。仅 defineTool 的冻结 tool 走此路径;class BaseTool 无此方法,不受影响。
const _funcDefCache = new WeakMap();
function _isFunctionDefMemoEnabled() {
  const v = String(process.env.KHY_TOOL_FUNCTION_DEF_MEMO || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}

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
  custom: 'User-defined custom tools',
};

// ── Behavioral Defaults (fail-closed) ──────────────────────────────

const BEHAVIOR_DEFAULTS = {
  isReadOnly: false,           // assume writes unless declared otherwise
  isDestructive: false,        // assume non-destructive
  isConcurrencySafe: false,    // assume NOT safe for parallel execution
  isEnabled: () => true,       // always available by default
  interruptBehavior: 'cancel', // 'cancel' or 'block'
};

// ── Extended Field Defaults ────────────────────────────────────────

const EXTENDED_DEFAULTS = {
  aliases: [],                      // alternative names for tool discovery
  searchHint: undefined,            // keyword for deferred tool search
  shouldDefer: false,               // tool can be deferred (not loaded into initial prompt)
  alwaysLoad: false,                // tool is never deferred (overrides shouldDefer)
  maxResultSizeChars: undefined,    // per-tool result size limit (undefined = system default)
};

const VALID_INTERRUPT_BEHAVIORS = ['cancel', 'block'];

// ── isGitRepo helper (10s TTL cache) ───────────────────────────────

let _gitRepoCache = { value: null, expiry: 0 };

/**
 * Check whether the current working directory is inside a git repository.
 * Result is cached for 10 seconds to avoid repeated execSync calls.
 *
 * @returns {boolean}
 */
function isGitRepo() {
  const now = Date.now();
  if (_gitRepoCache.expiry > now) return _gitRepoCache.value;
  try {
    // Git Bash 优先解析是 Windows 专属关切(Unix 无特殊路径的 Git Bash 概念)。
    // 仅在 win32 调用检测器,其它平台保持 'git'(字节回退兼容,不引入探针噪声)。
    let quotedGit = 'git';
    if (process.platform === 'win32') {
      try {
        const detector = require('../services/gitExecutableDetector');
        const detected = detector.detectGitExecutable();
        if (!detected) { _gitRepoCache = { value: false, expiry: now + 10000 }; return false; }
        quotedGit = detected === 'git' ? 'git' : `"${detected}"`;
      } catch { /* 检测失败 → 回退 'git' */ }
    }
    require('child_process').execSync(`${quotedGit} rev-parse --is-inside-work-tree`, {
      stdio: 'ignore',
      timeout: 3000,
    });
    _gitRepoCache = { value: true, expiry: now + 10000 };
    return true;
  } catch {
    _gitRepoCache = { value: false, expiry: now + 10000 };
    return false;
  }
}

// ── Parameter Validation ────────────────────────────────────────────

/**
 * Validate parameters against a schema definition.
 *
 * @param {object} schema - Input schema definition
 * @param {object} params - Actual parameters to validate
 * @returns {{ valid: boolean, errors: string[] }}
 *
 * Supported types: string, number, boolean, array, object
 * Supported constraints: required, minLength, maxLength, min, max, enum, pattern, description
 */
function validateParams(schema, params) {
  if (!schema || typeof schema !== 'object') return { valid: true, errors: [] };
  if (!params || typeof params !== 'object') params = {};

  const errors = [];
  // Structured, classified issues parallel to `errors` (additive — `errors` stays
  // byte-identical so the legacy/gate-off message path is unchanged). Consumed by
  // ccValidationError.formatValidationError to build the CC-aligned grouped message
  // (`<tool> failed due to the following issue(s):` + missing/type/constraint lines).
  const issues = [];

  for (const [key, rule] of Object.entries(schema)) {
    if (!rule || typeof rule !== 'object') continue;

    const value = params[key];
    const hasValue = value !== undefined && value !== null && value !== '';

    // Required check
    if (rule.required && !hasValue) {
      errors.push(`${key} is required`);
      issues.push({ kind: 'missing', param: key });
      continue;
    }

    // Skip further checks if no value and not required
    if (!hasValue) continue;

    // Type check
    if (rule.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rule.type) {
        errors.push(`${key} must be of type ${rule.type}, got ${actualType}`);
        issues.push({ kind: 'type', param: key, expected: rule.type, received: actualType });
        continue;
      }
    }

    // Constraint failures (length/range/enum/pattern) carry no CC type/missing
    // classification — record them as `other` with the original message so the
    // CC-aligned formatter preserves their precise text verbatim.
    const _pushConstraint = (msg) => { errors.push(msg); issues.push({ kind: 'other', param: key, message: msg }); };

    // String constraints
    if (rule.type === 'string' && typeof value === 'string') {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        _pushConstraint(`${key} must be at least ${rule.minLength} characters`);
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        _pushConstraint(`${key} must be at most ${rule.maxLength} characters`);
      }
      if (rule.pattern) {
        const re = typeof rule.pattern === 'string' ? new RegExp(rule.pattern) : rule.pattern;
        if (!re.test(value)) {
          _pushConstraint(`${key} does not match required pattern`);
        }
      }
    }

    // Number constraints
    if (rule.type === 'number' && typeof value === 'number') {
      if (rule.min !== undefined && value < rule.min) {
        _pushConstraint(`${key} must be >= ${rule.min}`);
      }
      if (rule.max !== undefined && value > rule.max) {
        _pushConstraint(`${key} must be <= ${rule.max}`);
      }
    }

    // Enum check
    if (rule.enum && Array.isArray(rule.enum)) {
      if (!rule.enum.includes(value)) {
        _pushConstraint(`${key} must be one of: ${rule.enum.join(', ')}`);
      }
    }

    // Array constraints
    if (rule.type === 'array' && Array.isArray(value)) {
      if (rule.minLength !== undefined && value.length < rule.minLength) {
        _pushConstraint(`${key} must have at least ${rule.minLength} items`);
      }
      if (rule.maxLength !== undefined && value.length > rule.maxLength) {
        _pushConstraint(`${key} must have at most ${rule.maxLength} items`);
      }
    }
  }

  return { valid: errors.length === 0, errors, issues };
}

// ── Tool Definition Factory ─────────────────────────────────────────

/**
 * Define a tool with standardized interface. Returns a frozen object.
 *
 * @param {object} config
 * @param {string} config.name - Unique tool name (alphanumeric + underscores)
 * @param {string} config.description - Human-readable description
 * @param {string} [config.category='custom'] - Tool category
 * @param {string} [config.risk='medium'] - Risk level
 * @param {object} [config.inputSchema={}] - Parameter schema
 * @param {function} config.execute - async (params, context) => result
 * @param {object} [config.capability] - Optional "capability-as-code" metadata.
 *   Marks this tool as a first-class, learned capability that ships with the
 *   product (code + tests + auto-discovery) rather than living as an assistant
 *   memory note. Shape: `{ summary, learnedFrom, tests: string[], surfaces: string[] }`.
 *   `tests` are repo-relative paths (relative to the package root) so the
 *   capability registry can prove the capability is covered. This field is
 *   purely descriptive metadata — it is NEVER emitted in `toFunctionDef()` and
 *   thus never reaches the model.
 * @returns {object} Frozen tool definition
 */
function defineTool(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('defineTool requires a config object');
  }
  if (!config.name || typeof config.name !== 'string') {
    throw new Error('Tool name is required and must be a string');
  }
  if (!config.execute || typeof config.execute !== 'function') {
    throw new Error(`Tool "${config.name}": execute function is required`);
  }

  const category = config.category || 'custom';
  if (!(category in CATEGORIES)) {
    throw new Error(`Tool "${config.name}": invalid category "${category}". Valid: ${Object.keys(CATEGORIES).join(', ')}`);
  }

  const risk = config.risk || 'medium';
  if (!RISK_LEVELS.includes(risk)) {
    throw new Error(`Tool "${config.name}": invalid risk "${risk}". Valid: ${RISK_LEVELS.join(', ')}`);
  }

  // ── Resolve behavioral declarations ──────────────────────────────
  const interruptBehavior = config.interruptBehavior || BEHAVIOR_DEFAULTS.interruptBehavior;
  if (!VALID_INTERRUPT_BEHAVIORS.includes(interruptBehavior)) {
    throw new Error(`Tool "${config.name}": invalid interruptBehavior "${interruptBehavior}". Valid: ${VALID_INTERRUPT_BEHAVIORS.join(', ')}`);
  }

  // Normalize boolean-or-function fields into callable methods
  const _wrapBehavior = (val, fallback) => {
    if (typeof val === 'function') return val;
    if (typeof val === 'boolean') return () => val;
    return fallback;
  };

  const _isReadOnly = _wrapBehavior(config.isReadOnly, () => BEHAVIOR_DEFAULTS.isReadOnly);
  const _isDestructive = _wrapBehavior(config.isDestructive, () => BEHAVIOR_DEFAULTS.isDestructive);
  const _isConcurrencySafe = _wrapBehavior(config.isConcurrencySafe, () => BEHAVIOR_DEFAULTS.isConcurrencySafe);
  const _isEnabled = typeof config.isEnabled === 'function' ? config.isEnabled : BEHAVIOR_DEFAULTS.isEnabled;

  // ── Resolve extended fields ────────────────────────────────────
  const aliases = Array.isArray(config.aliases) ? config.aliases : EXTENDED_DEFAULTS.aliases;
  const searchHint = config.searchHint || EXTENDED_DEFAULTS.searchHint;
  const shouldDefer = config.shouldDefer || EXTENDED_DEFAULTS.shouldDefer;
  const alwaysLoad = config.alwaysLoad || EXTENDED_DEFAULTS.alwaysLoad;
  const maxResultSizeChars = config.maxResultSizeChars !== undefined
    ? config.maxResultSizeChars
    : EXTENDED_DEFAULTS.maxResultSizeChars;

  // Optional extended methods (undefined = not provided)
  const _prompt = typeof config.prompt === 'function' ? config.prompt : null;
  const _validateInput = typeof config.validateInput === 'function' ? config.validateInput : null;
  const _getActivityDescription = typeof config.getActivityDescription === 'function' ? config.getActivityDescription : null;
  const _getToolUseSummary = typeof config.getToolUseSummary === 'function' ? config.getToolUseSummary : null;

  // Wrap execute to guarantee normalized result with `content` field,
  // large result persistence, and empty result placeholder.
  const _rawExecute = config.execute;
  const _toolName = config.name;
  const _normalizedExecute = async (params, context) => {
    const raw = await _rawExecute(params, context);
    let result = normalizeToolResult(raw);
    result = maybePersistLargeResult(result, _toolName);
    result = ensureNonEmptyContent(result, _toolName);
    return result;
  };

  const tool = {
    name: config.name,
    description: config.description || '',
    category,
    risk,
    inputSchema: config.inputSchema || {},
    execute: _normalizedExecute,

    // ── Extended metadata ─────────────────────────────────────────
    aliases,
    searchHint,
    shouldDefer,
    alwaysLoad,
    maxResultSizeChars,

    // ── Behavioral declarations ──────────────────────────────────
    /** @param {object} [input] - Tool params (for dynamic checks) */
    isReadOnly(input) { return _isReadOnly(input); },
    /** @param {object} [input] - Tool params (for dynamic checks) */
    isDestructive(input) { return _isDestructive(input); },
    /** @param {object} [input] - Tool params (for dynamic checks) */
    isConcurrencySafe(input) { return _isConcurrencySafe(input); },
    /** @returns {boolean} Whether the tool is available in the current environment */
    isEnabled() { return _isEnabled(); },
    interruptBehavior,

    // ── Sandbox-escape declaration ───────────────────────────────
    // Tool-level intent to run OUTSIDE the OS sandbox / with full access.
    // Read by toolCalling at the syscall-gateway call site and forced to L2
    // (typed-YES, unbypassable, fail-closed). NEVER taken from model params.
    // Static `sandboxEscape:true` or dynamic `requiresSandboxEscape(input)`.
    sandboxEscape: config.sandboxEscape === true,
    ...(typeof config.requiresSandboxEscape === 'function'
      ? { requiresSandboxEscape: config.requiresSandboxEscape }
      : {}),

    // ── Extended methods (optional) ──────────────────────────────
    /**
     * Rich tool description with usage notes/warnings.
     * @returns {Promise<string>}
     */
    async prompt() {
      if (_prompt) return _prompt();
      return this.description;
    },

    /**
     * Pre-execution semantic validation beyond schema checks.
     * @param {object} input - Tool parameters
     * @param {object} [context] - Execution context
     * @returns {Promise<{ valid: boolean, message?: string }>}
     */
    async validateInput(input, context) {
      if (_validateInput) return _validateInput(input, context);
      return { valid: true };
    },

    /**
     * Human-readable description of what this tool call will do.
     * @param {object} input
     * @returns {string|null}
     */
    getActivityDescription(input) {
      if (_getActivityDescription) return _getActivityDescription(input);
      return null;
    },

    /**
     * Brief summary for logs/audit.
     * @param {object} input
     * @returns {string|null}
     */
    getToolUseSummary(input) {
      if (_getToolUseSummary) return _getToolUseSummary(input);
      return null;
    },

    // Convenience: validate params against this tool's schema
    validate(params) {
      return validateParams(this.inputSchema, params);
    },

    // Convert to Claude/OpenAI function-calling format
    toFunctionDef() {
      const memoOn = _isFunctionDefMemoEnabled();
      if (memoOn) {
        const cached = _funcDefCache.get(this);
        if (cached) return cached;
      }

      const properties = {};
      const required = [];

      for (const [key, rule] of Object.entries(this.inputSchema)) {
        const prop = { type: rule.type || 'string' };
        if (rule.description) prop.description = rule.description;
        if (rule.enum) prop.enum = rule.enum;
        // Preserve nested structure for array / object parameters so that
        // function-calling clients receive the element/field schema (e.g.
        // MultiEdit's `edits: [{ old_string, new_string }]`). Without this the
        // model sees a bare `array` with no item shape and cannot fill it.
        if (rule.items) prop.items = rule.items;
        if (rule.properties) prop.properties = rule.properties;
        if (rule.default !== undefined) prop.default = rule.default;
        properties[key] = prop;
        if (rule.required) required.push(key);
      }

      const def = {
        name: this.name,
        description: this.description,
        parameters: {
          type: 'object',
          properties,
          required: required.length > 0 ? required : undefined,
        },
      };

      if (this.aliases.length > 0) {
        def.aliases = this.aliases;
      }

      if (memoOn) _funcDefCache.set(this, def);
      return def;
    },
  };

  // Store pending commands if provided (for commandRegistry integration)
  if (Array.isArray(config.commands) && config.commands.length > 0) {
    Object.defineProperty(tool, '_pendingCommands', {
      value: Object.freeze(config.commands),
      enumerable: false,
    });
  }

  // ── Capability-as-code metadata (optional) ───────────────────────
  // `defineTool` builds `tool` as an explicit literal and does NOT spread
  // `config`, so an unknown `capability` field would be silently dropped.
  // Attach it explicitly here (BEFORE the freeze below) so the capability
  // registry can discover it. Enumerable (plain assignment, unlike the
  // non-enumerable `_pendingCommands`) so it survives a shallow scan.
  if (config.capability && typeof config.capability === 'object') {
    tool.capability = Object.freeze({ ...config.capability });
  }

  // ── Optional param-normalization hook ────────────────────────────
  // `defineTool` builds `tool` as an explicit literal (no config spread), so a
  // `normalizeParams` field would be dropped. Attach it explicitly (BEFORE the
  // freeze) so callers can clamp/canonicalize params BEFORE schema validation.
  // Used e.g. by shellCommand to clamp an over-max timeout to the cap instead of
  // hard-rejecting it (a weak model setting timeout=600000 should get a 60s-capped
  // run, not an opaque "Invalid tool parameters"). Purely additive; tools without
  // the hook are unaffected.
  if (typeof config.normalizeParams === 'function') {
    tool.normalizeParams = config.normalizeParams;
  }

  return Object.freeze(tool);
}

// ── ToolResult Wrapper ──────────────────────────────────────────────

/**
 * Wrap a tool execution result into the enhanced ToolResult format.
 *
 * Existing tools return flat { success, data/error } objects. This wrapper
 * adds optional newMessages and contextModifier fields for tools that need
 * to inject messages into the conversation or modify execution context.
 *
 * @param {object} output - The tool's raw output (e.g. { success: true, data: ... })
 * @param {object} [extras]
 * @param {Array} [extras.newMessages] - Messages to inject into conversation
 * @param {function} [extras.contextModifier] - Context modification callback
 * @returns {{ data: object, newMessages?: Array, contextModifier?: function }}
 */
function wrapResult(output, extras = {}) {
  const result = { data: output };
  if (extras.newMessages && extras.newMessages.length > 0) {
    result.newMessages = extras.newMessages;
  }
  if (typeof extras.contextModifier === 'function') {
    result.contextModifier = extras.contextModifier;
  }
  return result;
}

// ── BaseTool Class ─────────────────────────────────────────────────
//
// An alternative to the functional defineTool() factory.  Tools can
// subclass BaseTool and provide prompt(), inputSchema, execute(), etc.
// The registry converts them via toToolDef() into the same frozen
// shape used by defineTool().

/**
 * Base class for Claude Code-aligned tool definitions.
 *
 * Subclasses must provide:
 *   - static toolName  — the canonical tool name (e.g. 'Read', 'Edit')
 *   - prompt()         — returns the system prompt description string
 *   - inputSchema      — JSON Schema object (getter or property)
 *   - execute(params, context) — async, runs the tool
 *
 * Optional overrides:
 *   - static category / risk / aliases / searchHint / etc.
 *   - validateInput(params) — semantic pre-exec validation
 *   - getActivityDescription(input) — short progress label
 *   - getToolUseSummary(input) — brief audit label
 */
class BaseTool {
  /* ── Identity (override in subclass) ─────────────────────────────── */

  /** Canonical tool name, e.g. 'Read'. */
  static toolName = 'BaseTool';

  /** Tool category — must be a key in CATEGORIES. */
  static category = 'custom';

  /** Risk level — one of RISK_LEVELS. */
  static risk = 'medium';

  /** Alternative names for tool search / discovery. */
  static aliases = [];

  /** Keyword for deferred tool search. */
  static searchHint = undefined;

  /** Whether this tool should be deferred from initial prompt. */
  static shouldDefer = false;

  /** Whether this tool must always be loaded. */
  static alwaysLoad = false;

  /** Per-tool max result size. undefined = system default. */
  static maxResultSizeChars = undefined;

  /* ── Behavioral declarations ─────────────────────────────────────── */

  /** @returns {boolean} */
  isReadOnly() { return false; }

  /** @param {object} [input] @returns {boolean} */
  isDestructive(_input) { return false; }

  /** @returns {boolean} */
  isConcurrencySafe() { return false; }

  /** @returns {boolean} */
  isEnabled() { return true; }

  /** 'cancel' or 'block' */
  get interruptBehavior() { return 'cancel'; }

  /* ── Core interface ──────────────────────────────────────────────── */

  /**
   * System prompt description for the AI.
   * Override in subclass.
   * @returns {string}
   */
  prompt() {
    return '';
  }

  /**
   * 弱模型调工具要点(单句)——供高误用风险工具在 prompt() 末尾可选追加。
   * [AI-弱模型] 单一真源:文案来自 weakModelGuidance 叶子;门控 KHY_WEAK_MODEL_GUIDANCE 关时
   * 返回空串(逐字节回退,prompt() 不含此句)。fail-soft:叶子缺失/异常也返回空串,绝不阻断 prompt()。
   * 用法:`prompt() { return [...].join('\n') + this.weakModelToolNote(); }`(空串时零副作用)。
   * @returns {string} 前置换行的单句,或空串
   */
  weakModelToolNote() {
    try {
      const wmg = require('../services/weakModelGuidance');
      if (!wmg.isEnabled(process.env)) return '';
      return '\n' + wmg.toolCallHint();
    } catch {
      return '';
    }
  }

  /**
   * JSON Schema describing the tool's input parameters.
   * Override in subclass (getter or property).
   * @returns {object}
   */
  get inputSchema() {
    return { type: 'object', properties: {}, required: [] };
  }

  /**
   * Validate input beyond schema checks (semantic validation).
   * @param {object} params
   * @returns {Promise<{valid: boolean, message?: string}>}
   */
  async validateInput(_params) {
    return { valid: true };
  }

  /**
   * Execute the tool.
   * @param {object} params - Validated parameters
   * @param {object} context - Execution context
   * @returns {Promise<object>}
   */
  async execute(_params, _context) {
    throw new Error(`${this.constructor.toolName}.execute() not implemented`);
  }

  /* ── Metadata helpers ────────────────────────────────────────────── */

  /**
   * Human-readable description of what this tool call will do.
   * @param {object} input
   * @returns {string|null}
   */
  getActivityDescription(_input) { return null; }

  /**
   * Brief summary for logs/audit.
   * @param {object} input
   * @returns {string|null}
   */
  getToolUseSummary(_input) { return null; }

  /* ── Serialization ───────────────────────────────────────────────── */

  /**
   * Return the Claude/Anthropic API tool schema.
   * @returns {{ name: string, description: string, input_schema: object }}
   */
  toAPISchema() {
    return {
      name: this.constructor.toolName,
      description: this.prompt(),
      input_schema: this.inputSchema,
    };
  }

  /**
   * Convert this class-based tool into a frozen defineTool()-compatible
   * object that the existing registry can consume.
   * @returns {object}
   */
  toToolDef() {
    const Ctor = this.constructor;
    const instance = this;

    // Convert JSON Schema inputSchema to the legacy flat schema format
    // so that validateParams() works.
    const jsonSchema = instance.inputSchema;
    const legacySchema = {};
    if (jsonSchema && jsonSchema.properties) {
      const requiredSet = new Set(jsonSchema.required || []);
      for (const [key, prop] of Object.entries(jsonSchema.properties)) {
        legacySchema[key] = {
          type: prop.type || 'string',
          required: requiredSet.has(key),
          description: prop.description || '',
        };
        if (prop.enum) legacySchema[key].enum = prop.enum;
        // Carry nested array/object schema through the legacy flat format so
        // toFunctionDef() can re-emit it (array `items`, object `properties`).
        if (prop.items) legacySchema[key].items = prop.items;
        if (prop.properties) legacySchema[key].properties = prop.properties;
        if (prop.minLength !== undefined) legacySchema[key].minLength = prop.minLength;
        if (prop.maxLength !== undefined) legacySchema[key].maxLength = prop.maxLength;
        if (prop.minimum !== undefined) legacySchema[key].min = prop.minimum;
        if (prop.maximum !== undefined) legacySchema[key].max = prop.maximum;
        if (prop.default !== undefined) legacySchema[key].default = prop.default;
      }
    }

    return defineTool({
      name: Ctor.toolName,
      description: instance.prompt(),
      category: Ctor.category || 'custom',
      risk: Ctor.risk || 'medium',
      inputSchema: legacySchema,
      execute: (params, ctx) => instance.execute(params, ctx),
      isReadOnly: (input) => instance.isReadOnly(input),
      isDestructive: (input) => instance.isDestructive(input),
      isConcurrencySafe: (input) => instance.isConcurrencySafe(input),
      isEnabled: () => instance.isEnabled(),
      interruptBehavior: instance.interruptBehavior,
      aliases: Ctor.aliases || [],
      searchHint: Ctor.searchHint,
      shouldDefer: Ctor.shouldDefer || false,
      alwaysLoad: Ctor.alwaysLoad || false,
      maxResultSizeChars: Ctor.maxResultSizeChars,
      prompt: () => instance.prompt(),
      validateInput: (input, ctx) => instance.validateInput(input, ctx),
      getActivityDescription: (input) => instance.getActivityDescription(input),
      getToolUseSummary: (input) => instance.getToolUseSummary(input),
    });
  }
}

// ── Exports ─────────────────────────────────────────────────────────

module.exports = {
  defineTool,
  validateParams,
  wrapResult,
  isGitRepo,
  BaseTool,
  RISK_LEVELS,
  CATEGORIES,
  BEHAVIOR_DEFAULTS,
  EXTENDED_DEFAULTS,
};
