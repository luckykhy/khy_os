'use strict';

/**
 * lazyLoader.js — Intelligent lazy loading system for startup optimization.
 *
 * Provides deferred module loading, prefetch scheduling, and startup
 * performance tracking. Inspired by Y-code's lazy loading patterns.
 *
 * Architecture:
 *   - LazyLoader: central registry for lazy modules
 *   - LoadTracker: tracks load times and dependencies
 *   - PrefetchQueue: background prefetch scheduling
 *
 * Key capabilities:
 *   1. Deferred module loading (load on first use)
 *   2. Background prefetch after startup
 *   3. Load time tracking and diagnostics
 *   4. Dependency-aware loading order
 *   5. Cache for loaded modules
 *
 * @module lazyLoader
 */

const { EventEmitter } = require('events');

// ── Module State ─────────────────────────────────────────────────────────

const ModuleState = Object.freeze({
  PENDING: 'pending',
  LOADING: 'loading',
  LOADED: 'loaded',
  FAILED: 'failed',
});

// ── Lazy Module ───────────────────────────────────────────────────────────

/**
 * Wrapper for a lazily-loaded module.
 */
class LazyModule {
  /**
   * @param {object} config
   * @param {string} config.name - Module name
   * @param {function} config.loader - Function that returns the module
   * @param {number} [config.priority=5] - Load priority (lower = sooner)
   * @param {string[]} [config.dependencies=[]] - Dependent module names
   * @param {number} [config.timeoutMs=30000] - Load timeout
   */
  constructor(config) {
    this.name = config.name;
    this.loader = config.loader;
    this.priority = config.priority || 5;
    this.dependencies = config.dependencies || [];
    this.timeoutMs = config.timeoutMs || 30000;

    this.state = ModuleState.PENDING;
    this.module = null;
    this.error = null;
    this.loadedAt = null;
    this.loadTimeMs = 0;
    this._promise = null;
  }

  /**
   * Load the module (idempotent).
   * @returns {Promise<any>}
   */
  async load() {
    if (this.state === ModuleState.LOADED) return this.module;
    if (this.state === ModuleState.LOADING) return this._promise;

    this.state = ModuleState.LOADING;
    const start = Date.now();

    this._promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.state = ModuleState.FAILED;
        this.error = new Error(`Module "${this.name}" load timed out after ${this.timeoutMs}ms`);
        reject(this.error);
      }, this.timeoutMs);

      Promise.resolve()
        .then(() => this.loader())
        .then(mod => {
          clearTimeout(timer);
          this.module = mod;
          this.state = ModuleState.LOADED;
          this.loadedAt = Date.now();
          this.loadTimeMs = this.loadedAt - start;
          resolve(mod);
        })
        .catch(err => {
          clearTimeout(timer);
          this.state = ModuleState.FAILED;
          this.error = err;
          reject(err);
        });
    });

    return this._promise;
  }

  /**
   * Get the module, loading it if necessary.
   * @returns {Promise<any>}
   */
  get() {
    return this.load();
  }
}

// ── Lazy Loader ───────────────────────────────────────────────────────────

/**
 * Central lazy module registry and loader.
 */
class LazyLoader extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.concurrency=2] - Max parallel loads
   * @param {number} [options.defaultTimeoutMs=30000] - Default load timeout
   * @param {function} [options.onLoad] - Callback on module load
   */
  constructor(options = {}) {
    super();
    this._concurrency = options.concurrency || 2;
    this._defaultTimeoutMs = options.defaultTimeoutMs || 30000;
    this._onLoad = options.onLoad || null;

    /** @type {Map<string, LazyModule>} */
    this._modules = new Map();
    this._stats = {
      totalRegistered: 0,
      totalLoaded: 0,
      totalFailed: 0,
      totalLoadTimeMs: 0,
    };
  }

  // ── Properties ──────────────────────────────────────────────────────

  get stats() {
    return {
      ...this._stats,
      totalPending: this._countByState(ModuleState.PENDING),
      totalLoading: this._countByState(ModuleState.LOADING),
      totalLoaded: this._countByState(ModuleState.LOADED),
      totalFailed: this._countByState(ModuleState.FAILED),
    };
  }

  // ── Registration ────────────────────────────────────────────────────

  /**
   * Register a module for lazy loading.
   * @param {string} name - Module name
   * @param {function|string} loader - Loader function or require path
   * @param {object} [options]
   * @returns {LazyModule}
   */
  register(name, loader, options = {}) {
    if (this._modules.has(name)) {
      throw new Error(`Module "${name}" already registered`);
    }

    const loaderFn = typeof loader === 'string'
      ? () => require(loader)
      : loader;

    const mod = new LazyModule({
      name,
      loader: loaderFn,
      priority: options.priority,
      dependencies: options.dependencies,
      timeoutMs: options.timeoutMs || this._defaultTimeoutMs,
    });

    this._modules.set(name, mod);
    this._stats.totalRegistered++;
    this.emit('register', mod);

    return mod;
  }

  /**
   * Register multiple modules at once.
   * @param {Array<{name: string, loader: function|string, options?: object}>} modules
   */
  registerAll(modules) {
    for (const mod of modules) {
      this.register(mod.name, mod.loader, mod.options || {});
    }
  }

  // ── Loading ─────────────────────────────────────────────────────────

  /**
   * Load a module by name.
   * @param {string} name
   * @returns {Promise<any>}
   */
  async load(name) {
    const mod = this._modules.get(name);
    if (!mod) {
      throw new Error(`Module "${name}" not registered`);
    }

    // Load dependencies first
    for (const depName of mod.dependencies) {
      await this.load(depName);
    }

    const result = await mod.load();
    this._stats.totalLoaded++;
    this._stats.totalLoadTimeMs += mod.loadTimeMs;

    if (this._onLoad) {
      this._onLoad(name, mod);
    }

    this.emit('load', name, mod);
    return result;
  }

  /**
   * Load a module synchronously (must already be loaded).
   * @param {string} name
   * @returns {any}
   */
  get(name) {
    const mod = this._modules.get(name);
    if (!mod || mod.state !== ModuleState.LOADED) {
      throw new Error(`Module "${name}" not loaded yet`);
    }
    return mod.module;
  }

  /**
   * Check if a module is loaded.
   * @param {string} name
   * @returns {boolean}
   */
  isLoaded(name) {
    const mod = this._modules.get(name);
    return mod && mod.state === ModuleState.LOADED;
  }

  /**
   * Load all registered modules in dependency order.
   * @param {object} [options]
   * @param {boolean} [options.parallel=true] - Enable parallel loading
   * @returns {Promise<Map<string, any>>}
   */
  async loadAll(options = {}) {
    const parallel = options.parallel !== false;
    const modules = Array.from(this._modules.values());

    // Sort by priority
    modules.sort((a, b) => a.priority - b.priority);

    if (parallel) {
      return this._loadAllParallel(modules);
    } else {
      return this._loadAllSequential(modules);
    }
  }

  /**
   * Load all modules in dependency order (sequential).
   * @private
   */
  async _loadAllSequential(modules) {
    const results = new Map();
    for (const mod of modules) {
      const m = await this.load(mod.name);
      results.set(mod.name, m);
    }
    return results;
  }

  /**
   * Load all modules with parallelism (respecting dependencies).
   * @private
   */
  async _loadAllParallel(modules) {
    const results = new Map();

    const loadWithDeps = async (mod) => {
      if (results.has(mod.name)) return results.get(mod.name);

      // Wait for dependencies
      for (const dep of mod.dependencies) {
        const depMod = this._modules.get(dep);
        if (depMod) {
          await loadWithDeps(depMod);
        }
      }

      // Load this module
      const m = await this.load(mod.name);
      results.set(mod.name, m);
      return m;
    };

    // Start all (dependencies will be awaited internally)
    await Promise.all(modules.map(mod => loadWithDeps(mod)));
    return results;
  }

  // ── Prefetch ────────────────────────────────────────────────────────

  /**
   * Schedule a module for background loading.
   * @param {string} name
   * @returns {Promise<any>}
   */
  prefetch(name) {
    return new Promise((resolve, reject) => {
      // Use setImmediate to defer to after current work
      setImmediate(async () => {
        try {
          const mod = await this.load(name);
          resolve(mod);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Prefetch multiple modules in background.
   * @param {string[]} names
   * @returns {Promise<void>}
   */
  prefetchAll(names) {
    return new Promise((resolve) => {
      setImmediate(async () => {
        for (const name of names) {
          try {
            await this.load(name);
          } catch {
            // Best-effort prefetch
          }
        }
        resolve();
      });
    });
  }

  // ── Diagnostics ─────────────────────────────────────────────────────

  /**
   * Get load time report.
   * @returns {Array<{name: string, loadTimeMs: number, state: string}>}
   */
  getLoadReport() {
    return Array.from(this._modules.values())
      .map(mod => ({
        name: mod.name,
        loadTimeMs: mod.loadTimeMs,
        state: mod.state,
        priority: mod.priority,
      }))
      .sort((a, b) => b.loadTimeMs - a.loadTimeMs);
  }

  /**
   * Get slowest-loading modules.
   * @param {number} [limit=10]
   * @returns {Array}
   */
  getSlowestModules(limit = 10) {
    return this.getLoadReport()
      .filter(m => m.state === ModuleState.LOADED)
      .slice(0, limit);
  }

  // ── Utility ─────────────────────────────────────────────────────────

  _countByState(state) {
    let count = 0;
    for (const mod of this._modules.values()) {
      if (mod.state === state) count++;
    }
    return count;
  }

  /**
   * Reset loader state.
   */
  reset() {
    this._modules.clear();
    this._stats = {
      totalRegistered: 0,
      totalLoaded: 0,
      totalFailed: 0,
      totalLoadTimeMs: 0,
    };
  }
}

// ── Module Exports ────────────────────────────────────────────────────────

module.exports = {
  LazyLoader,
  LazyModule,
  ModuleState,
};
