/**
 * Service Registry — lazy-loaded, centralized service discovery.
 *
 * Instead of scattered require() calls throughout the codebase, services
 * register here with a factory function. Instances are created on first
 * access (lazy initialization) and cached for singleton behavior.
 *
 * Does NOT replace existing require() — this is an optional layer that
 * enables health checks, introspection, and future dependency injection.
 */
const path = require('path');

// ── Registry state ─────────────────────────────────────────────────

const _entries = new Map();  // name → { factory, instance, category, description, loaded }

// ── Public API ─────────────────────────────────────────────────────

/**
 * Register a service.
 *
 * @param {string} name - Unique service name
 * @param {function} factory - () => require('./someService') — lazy loader
 * @param {object} [meta]
 * @param {string} [meta.category] - Service category (e.g., 'core', 'gateway', 'cli')
 * @param {string} [meta.description] - Human-readable description
 */
function register(name, factory, meta = {}) {
  if (!name || typeof name !== 'string') {
    throw new Error('Service name must be a non-empty string');
  }
  if (typeof factory !== 'function') {
    throw new Error(`Service "${name}": factory must be a function`);
  }

  _entries.set(name, {
    factory,
    instance: null,
    category: meta.category || 'general',
    description: meta.description || '',
    loaded: false,
    error: null,
  });
}

/**
 * Get a service instance (lazy-loaded on first access).
 *
 * @param {string} name
 * @returns {*} The service module/instance
 * @throws {Error} If service is not registered or fails to load
 */
function get(name) {
  const entry = _entries.get(name);
  if (!entry) {
    throw new Error(`Service not registered: "${name}"`);
  }

  if (!entry.loaded) {
    try {
      entry.instance = entry.factory();
      entry.loaded = true;
      entry.error = null;
    } catch (err) {
      entry.error = err.message;
      throw new Error(`Failed to load service "${name}": ${err.message}`);
    }
  }

  return entry.instance;
}

/**
 * Check if a service is registered.
 * @param {string} name
 * @returns {boolean}
 */
function has(name) {
  return _entries.has(name);
}

/**
 * Get services by category.
 * @param {string} category
 * @returns {Map<string, object>}
 */
function getByCategory(category) {
  const result = new Map();
  for (const [name, entry] of _entries) {
    if (entry.category === category) {
      result.set(name, entry);
    }
  }
  return result;
}

/**
 * List all registered services with metadata.
 * @returns {Array<{name, category, description, loaded, error}>}
 */
function list() {
  return [..._entries.entries()].map(([name, entry]) => ({
    name,
    category: entry.category,
    description: entry.description,
    loaded: entry.loaded,
    error: entry.error,
  }));
}

/**
 * Run a health check on all loaded services.
 * Services that expose a healthCheck() method will be tested.
 *
 * @returns {Array<{name, healthy, error?, latency?}>}
 */
async function healthCheck() {
  const results = [];

  for (const [name, entry] of _entries) {
    if (!entry.loaded || !entry.instance) {
      results.push({ name, healthy: null, note: 'not loaded' });
      continue;
    }

    const start = Date.now();

    // Check if service has a health check method
    const svc = entry.instance;
    if (typeof svc.healthCheck === 'function') {
      try {
        await svc.healthCheck();
        results.push({ name, healthy: true, latency: Date.now() - start });
      } catch (err) {
        results.push({ name, healthy: false, error: err.message, latency: Date.now() - start });
      }
    } else if (typeof svc.getStatus === 'function') {
      // Fallback: try getStatus()
      try {
        const status = svc.getStatus();
        results.push({
          name,
          healthy: status.available !== false,
          latency: Date.now() - start,
        });
      } catch (err) {
        results.push({ name, healthy: false, error: err.message });
      }
    } else {
      // Service is loaded but has no health check — assume healthy
      results.push({ name, healthy: true, note: 'no health check method' });
    }
  }

  return results;
}

/**
 * Get the count of registered services.
 * @returns {{ total: number, loaded: number, errored: number }}
 */
function stats() {
  let loaded = 0, errored = 0;
  for (const entry of _entries.values()) {
    if (entry.loaded) loaded++;
    if (entry.error) errored++;
  }
  return { total: _entries.size, loaded, errored };
}

// ── Auto-register known services ───────────────────────────────────
// Only registers factories — nothing is loaded until get() is called.

function _autoRegister() {
  const svcDir = path.join(__dirname);

  const known = [
    ['aiGateway', () => require('./gateway/aiGateway'), { category: 'gateway', description: 'AI request routing (multi-adapter cascade)' }],
    ['multiFreeService', () => require('./multiFreeService'), { category: 'core', description: 'Free-tier AI provider aggregation' }],
    ['strategyEngine', () => require('./strategyEngine'), { category: 'core', description: 'Trading strategy execution engine' }],
    ['backtestEngine', () => require('./backtestEngine'), { category: 'core', description: 'Strategy backtesting engine' }],
    ['marketDataService', () => require('./marketDataService'), { category: 'data', description: 'Market data access layer' }],
    ['klineDataService', () => require('./klineDataService'), { category: 'data', description: 'K-line data service' }],
    ['akshareDataService', () => require('./akshareDataService'), { category: 'data', description: 'AKShare data integration' }],
    ['toolCalling', () => require('./toolCalling'), { category: 'core', description: 'Tool execution with permission system' }],
    ['permissionStore', () => require('./permissionStore'), { category: 'security', description: 'Profile-aware permission management' }],
    ['auditLog', () => require('./auditLog'), { category: 'security', description: 'Tool execution audit trail' }],
    ['toolSandbox', () => require('./toolSandbox'), { category: 'security', description: 'Sandboxed code/shell execution' }],
    ['toolUseLoop', () => require('./toolUseLoop'), { category: 'core', description: 'Iterative AI ↔ tool execution loop' }],
    ['agenticHarnessService', () => require('./agenticHarnessService'), { category: 'core', description: 'Unified context/loop/skills/memory harness runtime' }],
    ['securityGuardService', () => require('./securityGuardService'), { category: 'security', description: 'Input/output security scanning' }],
    ['resourceGuard', () => require('./resourceGuard'), { category: 'security', description: 'Resource limits and safe execution' }],
    ['baseSelfCheckService', () => require('./baseSelfCheckService'), { category: 'monitoring', description: 'Periodic base reliability self-check loop' }],
    ['webSearchService', () => require('./webSearchService'), { category: 'data', description: 'Web search integration' }],
    ['tradingAgentsService', () => require('./tradingAgentsService'), { category: 'core', description: 'Multi-agent trading system' }],
    ['tokenUsageService', () => require('./tokenUsageService'), { category: 'monitoring', description: 'Token usage tracking' }],
    ['growthService', () => require('./growthService'), { category: 'user', description: 'User growth and engagement tracking' }],
    ['versionService', () => require('./versionService'), { category: 'system', description: 'Version management and updates' }],
    ['cloudSync', () => require('./cloudSync'), { category: 'system', description: 'Cloud data synchronization' }],
    // Bootstrap-level services (used early in startup, registering for unified health/discovery)
    ['hardwareProfileService', () => require('./hardwareProfileService'), { category: 'system', description: 'Hardware detection and model recommendations' }],
    ['networkDetector', () => require('./networkDetector'), { category: 'system', description: 'Network availability and proxy detection' }],
    ['cacheService', () => require('./cacheService'), { category: 'core', description: 'Multi-tier cache (memory/Redis/file)' }],
    ['cleanupService', () => require('./cleanupService'), { category: 'system', description: 'Periodic data and temp file cleanup' }],
    ['projectMemoryService', () => require('./projectMemoryService'), { category: 'core', description: 'Project-level persistent memory (khy.md)' }],
    ['fileIntegrityService', () => require('./fileIntegrityService'), { category: 'security', description: 'File integrity verification (hash checksums)' }],
    ['adminService', () => require('./adminService'), { category: 'security', description: 'Admin authentication and user management' }],
    ['skillLearningService', () => require('./skillLearningService'), { category: 'core', description: 'Skill usage tracking and auto-learning' }],
  ];

  for (const [name, factory, meta] of known) {
    if (!_entries.has(name)) {
      _entries.set(name, {
        factory,
        instance: null,
        category: meta.category || 'general',
        description: meta.description || '',
        loaded: false,
        error: null,
      });
    }
  }
}

// Auto-register on module load
_autoRegister();

// Publish stats through the zero-dependency provider sink so low-level
// consumers (telemetry) can read service health without importing this module
// — inverts the telemetry → serviceRegistry edge out of the giant SCC
// ([DESIGN-ARCH-051] §6.7).
require('./serviceStatsSink').setServiceStatsProvider(stats);

// ── Exports ────────────────────────────────────────────────────────

module.exports = {
  register,
  get,
  has,
  getByCategory,
  list,
  healthCheck,
  stats,
};
