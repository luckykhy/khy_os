/**
 * BaseAdapter — interface contract for all platform delivery adapters.
 *
 * Every adapter MUST implement these four methods:
 *   detect()        → boolean          (can this adapter run right now?)
 *   deliver(task)   → DeliveryResult   (execute the delivery)
 *   getPlatform()   → string           (e.g. 'slack', 'notion')
 *   validateConfig() → ValidationResult (are credentials/config valid?)
 *
 * The orchestrator calls these in order: detect → validateConfig → deliver.
 */

class BaseAdapter {
  /**
   * @param {object} config  - Platform-specific config (API keys, channel IDs, etc.)
   * @param {object} logger  - Shared logger instance
   */
  constructor(config = {}, logger = console) {
    if (new.target === BaseAdapter) {
      throw new Error('BaseAdapter is abstract — extend it, do not instantiate directly.');
    }
    this.config = config;
    this.logger = logger;
    this._available = null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /**
   * Quick check: is the adapter available (CLI installed, API reachable, etc.)?
   * Cache the result; pass forceRefresh=true to re-detect.
   */
  detect(forceRefresh = false) {
    throw new Error('detect() must be implemented by subclass.');
  }

  /**
   * Validate that required credentials/config are present and valid.
   * Returns { valid: boolean, errors: string[], warnings: string[] }
   */
  validateConfig() {
    throw new Error('validateConfig() must be implemented by subclass.');
  }

  /**
   * Execute delivery for the given task.
   * @param {DeliveryTask} task
   * @returns {Promise<DeliveryResult>}
   */
  async deliver(task) {
    throw new Error('deliver() must be implemented by subclass.');
  }

  // ── Metadata ─────────────────────────────────────────────────────────

  /** Human-readable platform name. */
  getPlatform() {
    throw new Error('getPlatform() must be implemented by subclass.');
  }

  /** Supported delivery formats for this platform. */
  getSupportedFormats() {
    return [];
  }

  // ── Helpers ──────────────────────────────────────────────────────────

  /**
   * Build a standard delivery result envelope.
   */
  buildResult(ok, data = {}) {
    return {
      success: ok,
      platform: this.getPlatform(),
      timestamp: new Date().toISOString(),
      ...data,
    };
  }

  /**
   * Wrap an async operation with timeout protection.
   */
  async withTimeout(fn, ms = 30_000) {
    const { PromiseTimeout } = require('./promiseTimeout');
    return PromiseTimeout(fn, ms);
  }

  /**
   * Load a prompt template by name from the templates directory.
   */
  loadPrompt(templateName) {
    const fs = require('fs');
    const path = require('path');
    const templatePath = path.join(
      __dirname, 'prompts', `${templateName}.prompt.md`
    );
    if (!fs.existsSync(templatePath)) {
      this.logger.warn(`[${this.getPlatform()}] Prompt template not found: ${templateName}`);
      return null;
    }
    return fs.readFileSync(templatePath, 'utf-8');
  }
}

module.exports = { BaseAdapter };
