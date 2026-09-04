'use strict';

/**
 * systemIntegration.js — Unified integration layer for all new modules.
 *
 * Provides a single entry point to initialize and wire together:
 * - ToolSpec protocol (toolSpec.js)
 * - Prompt cache optimizer (promptCacheOptimizer.js)
 * - Task scheduler (taskScheduler.js)
 * - Permission broker (permissionBroker.js)
 * - Lazy loader (lazyLoader.js)
 * - Memory bridge (memoryBridge.js)
 * - Memory dream enhancer (memoryDreamEnhancer.js)
 *
 * @module systemIntegration
 */

const { LazyLoader, ModuleState } = require('./lazyLoader');
const { MemoryBridge, MemoryType, createMemoryTools } = require('./memoryBridge');
const { DreamScheduler, DreamPhase, HealthThreshold, createDreamTools } = require('./memoryDreamEnhancer');
const { PermissionBroker, PermissionVerdict } = require('./permissionBroker');
const { PromptCacheOptimizer, estimateTokens } = require('./promptCacheOptimizer');
const { TaskScheduler, Task, TaskPriority } = require('./taskScheduler');
const { ToolSpec, ToolResult, ToolRegistry, ToolCategory, RiskLevel, globalRegistry } = require('./toolSpec');

// ── System Integration Class ─────────────────────────────────────────────

/**
 * Central integration point for all new modules.
 */
class SystemIntegration {
  /**
   * @param {object} options
   * @param {string} options.appHome - Application data directory
   * @param {object} [options.gateway] - AI gateway instance
   * @param {object} [options.logger]
   */
  constructor(options = {}) {
    this._appHome = options.appHome;
    this._gateway = options.gateway || null;
    this._logger = options.logger || console;

    // Initialize modules
    this._registry = globalRegistry;
    this._optimizer = new PromptCacheOptimizer(options.promptCache || {});
    this._scheduler = new TaskScheduler(options.scheduler || {});
    this._broker = new PermissionBroker(options.broker || {});
    this._loader = new LazyLoader(options.loader || {});
    this._memoryBridge = null;
    this._dreamScheduler = null;

    this._initialized = false;
  }

  // ── Properties ──────────────────────────────────────────────────────

  get registry() { return this._registry; }
  get optimizer() { return this._optimizer; }
  get scheduler() { return this._scheduler; }
  get broker() { return this._broker; }
  get loader() { return this._loader; }
  get memoryBridge() { return this._memoryBridge; }
  get isInitialized() { return this._initialized; }

  // ── Initialization ──────────────────────────────────────────────────

  /**
   * Initialize all modules and register tools.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this._initialized) return;

    // Initialize memory bridge
    this._memoryBridge = new MemoryBridge({
      appHome: this._appHome,
      registry: this._registry,
    });

    // Register memory tools
    const memoryTools = this._memoryBridge.getTools();
    for (const tool of memoryTools) {
      this._registry.register(tool);
    }

    // Initialize dream tools if dreaming is available
    try {
      const MemoryDreaming = require('./memoryDreaming');
      const dreaming = new MemoryDreaming({
        gateway: this._gateway,
        storePath: require('path').join(this._appHome, 'memory', 'dream-store.json'),
      });
      dreaming.load();

      const dreamTools = createDreamTools({
        dreaming,
        bridge: this._memoryBridge,
      });

      for (const tool of dreamTools) {
        this._registry.register(tool);
      }

      // Start dream scheduler
      this._dreamScheduler = new DreamScheduler({
        dreaming,
        logger: this._logger,
      });
      this._dreamScheduler.start();

      this._logger.info('Dream system initialized');
    } catch (err) {
      this._logger.warn('Dream system not available:', err.message);
    }

    this._initialized = true;
    this._logger.info('System integration initialized');
  }

  /**
   * Shutdown all modules gracefully.
   */
  shutdown() {
    if (this._dreamScheduler) {
      this._dreamScheduler.stop();
    }
    this._broker.cancelAll();
    this._scheduler.cancelAll();
    this._initialized = false;
  }

  // ── Convenience Methods ─────────────────────────────────────────────

  /**
   * Get system status overview.
   * @returns {object}
   */
  getStatus() {
    return {
      initialized: this._initialized,
      registry: this._registry.getStats(),
      optimizer: this._optimizer.getStats(),
      scheduler: this._scheduler.stats,
      broker: this._broker.stats,
      loader: this._loader.stats,
      memory: this._memoryBridge ? this._memoryBridge.getStatus() : null,
    };
  }

  /**
   * Create a new task scheduler with shared broker.
   * @param {object} options
   * @returns {TaskScheduler}
   */
  createScheduler(options = {}) {
    return new TaskScheduler({
      ...options,
      // Inherit broker for permission checks
      onTaskStart: async (task) => {
        if (task.requiresPermission) {
          const result = await this._broker.request({
            toolName: task.name,
            reason: `Task: ${task.name}`,
          });
          if (result.verdict !== PermissionVerdict.APPROVED) {
            throw new Error(`Permission denied for task: ${task.name}`);
          }
        }
      },
    });
  }

  /**
   * Register a lazy-loaded module.
   * @param {string} name
   * @param {function|string} loader
   * @param {object} options
   */
  registerLazyModule(name, loader, options = {}) {
    return this._loader.register(name, loader, options);
  }

  /**
   * Load a module (lazy).
   * @param {string} name
   * @returns {Promise<any>}
   */
  async loadModule(name) {
    return this._loader.load(name);
  }

  /**
   * Optimize messages for prompt caching.
   * @param {Array} messages
   * @param {string} systemPrompt
   * @returns {object}
   */
  optimizePrompt(messages, systemPrompt) {
    return this._optimizer.optimize(messages, systemPrompt);
  }

  /**
   * Request permission through broker.
   * @param {object} request
   * @returns {Promise<object>}
   */
  requestPermission(request) {
    return this._broker.request(request);
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  SystemIntegration,
  // Re-export all modules for convenience
  ToolSpec,
  ToolResult,
  ToolRegistry,
  ToolCategory,
  RiskLevel,
  globalRegistry,
  PromptCacheOptimizer,
  estimateTokens,
  TaskScheduler,
  Task,
  TaskPriority,
  PermissionBroker,
  PermissionVerdict,
  LazyLoader,
  ModuleState,
  MemoryBridge,
  MemoryType,
  createMemoryTools,
  DreamScheduler,
  DreamPhase,
  HealthThreshold,
  createDreamTools,
};
