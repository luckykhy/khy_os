/**
 * DeliveryOrchestrator — main orchestrator for cross-platform delivery.
 *
 * Coordinates adapters, runs DiffEngine, manages task lifecycle.
 */

const { v4: uuidv4 } = require('uuid') || { v4: () => `${Date.now()}-${Math.random().toString(36).slice(2, 9)}` };

class DeliveryOrchestrator {
  /**
   * @param {object} options
   * @param {Map<string, BaseAdapter>} options.adapters  — platform name → adapter instance
   * @param {DiffEngine}               options.diffEngine
   * @param {TaskStore}                options.taskStore
   * @param {TaskQueue}                options.taskQueue
   * @param {object}                   options.logger
   */
  constructor(options = {}) {
    this.adapters = options.adapters || new Map();
    this.diffEngine = options.diffEngine || null;
    this.taskStore = options.taskStore || null;
    this.taskQueue = options.taskQueue || null;
    this.logger = options.logger || console;
    this._promptLoader = options.promptLoader || null;
  }

  /**
   * Register an adapter.
   */
  registerAdapter(adapter) {
    const name = adapter.getPlatform();
    this.adapters.set(name, adapter);
    this.logger.info(`[Orchestrator] Registered adapter: ${name}`);
  }

  /**
   * Main entry point — deliver content to specified platforms.
   * @param {object} input — { content, format, platforms, priority, metadata }
   * @returns {Promise<DeliveryReport>}
   */
  async deliver(input) {
    const taskId = input.task_id || uuidv4();
    const startTime = Date.now();

    this.logger.info(`[Orchestrator] Starting task ${taskId} → platforms: ${input.platforms?.join(', ') || 'default'}`);

    // Step 1: Validate input
    if (!input.content) {
      return this._buildReport(taskId, 'failed', startTime, [], null, 'No content provided.', 'aborted');
    }

    const targetPlatforms = input.platforms && input.platforms.length > 0
      ? input.platforms
      : ['markdown', 'notion', 'slack', 'webhook'];

    // Step 2: Detect available adapters
    const availableAdapters = targetPlatforms
      .filter((name) => this.adapters.has(name))
      .map((name) => ({ name, adapter: this.adapters.get(name) }));

    const missingAdapters = targetPlatforms.filter((name) => !this.adapters.has(name));
    if (missingAdapters.length > 0) {
      this.logger.warn(`[Orchestrator] No adapter registered for: ${missingAdapters.join(', ')}`);
    }

    if (availableAdapters.length === 0) {
      return this._buildReport(taskId, 'failed', startTime, [], null, 'No adapters available for requested platforms.', 'aborted');
    }

    // Step 3: Validate configurations
    const validAdapters = [];
    for (const { name, adapter } of availableAdapters) {
      const validation = adapter.validateConfig();
      if (validation.valid) {
        validAdapters.push({ name, adapter });
      } else {
        this.logger.warn(`[Orchestrator] Adapter ${name} config invalid: ${validation.errors.join(', ')}`);
      }
    }

    if (validAdapters.length === 0) {
      return this._buildReport(taskId, 'failed', startTime, [], null, 'All adapters have invalid configuration.', 'aborted');
    }

    // Step 4: Deliver in parallel
    const deliveryPromises = validAdapters.map(async ({ name, adapter }) => {
      const platformStart = Date.now();
      try {
        const result = await adapter.deliver({
          text: input.content,
          content: input.content,
          format: input.format || 'markdown',
          platforms: targetPlatforms,
          metadata: input.metadata,
        });
        return {
          platform: name,
          success: result.success,
          result,
          duration_ms: Date.now() - platformStart,
        };
      } catch (err) {
        this.logger.error(`[Orchestrator] Adapter ${name} threw: ${err.message}`);
        return {
          platform: name,
          success: false,
          result: { error: err.message },
          duration_ms: Date.now() - platformStart,
        };
      }
    });

    const deliveries = await Promise.allSettled(deliveryPromises);
    const deliveryResults = deliveries.map((d) => d.status === 'fulfilled' ? d.value : {
      platform: 'unknown',
      success: false,
      result: { error: d.reason?.message || 'Unknown error' },
      duration_ms: 0,
    });

    // Step 5: DiffEngine consistency check
    let diffReport = null;
    if (this.diffEngine) {
      this.logger.info(`[Orchestrator] Running DiffEngine for task ${taskId}`);
      const successfulDeliveries = deliveryResults
        .filter((d) => d.success)
        .map((d) => ({
          platform: d.platform,
          result: d.result,
          rendered_content: d.result?.text || d.result?.filepath ? 'content' : '',
          rendered_blocks: d.result?.blocks_created ? [] : [],
        }));

      diffReport = this.diffEngine.check({
        task_id: taskId,
        content_source: input.content,
        deliveries: [
          ...successfulDeliveries,
          ...deliveryResults.filter((d) => !d.success).map((d) => ({
            platform: d.platform,
            result: d.result,
            rendered_content: '',
          })),
        ],
      });

      this.logger.info(`[Orchestrator] DiffEngine result: ${diffReport.overall_status} (${diffReport.summary.failures} failures, ${diffReport.summary.warnings} warnings)`);
    }

    // Step 6: Decision
    let finalDecision = 'delivered';
    if (diffReport?.overall_status === 'fail') finalDecision = 'aborted';
    else if (diffReport?.overall_status === 'warn') finalDecision = 'delivered_with_warnings';

    // Step 7: Persist task
    if (this.taskStore) {
      this.taskStore.create({
        id: taskId,
        status: finalDecision === 'aborted' ? 'failed' : 'completed',
        content: input.content,
        format: input.format || 'markdown',
        platforms: targetPlatforms,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        result: { deliveries: deliveryResults, diff: diffReport },
        retries: 0,
        metadata: input.metadata,
      });
    }

    // Step 8: Build report
    const report = this._buildReport(taskId, finalDecision, startTime, deliveryResults, diffReport);
    this.logger.info(`[Orchestrator] Task ${taskId} completed: ${finalDecision}`);
    return report;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  _buildReport(taskId, status, startTime, deliveries, diffReport, error, decision) {
    return {
      task_id: taskId,
      orchestrator_status: status,
      execution_time_ms: Date.now() - startTime,
      deliveries,
      diff_report: diffReport,
      error,
      final_decision: decision || status,
      next_actions: this._suggestNextActions(status, deliveries, diffReport),
    };
  }

  _suggestNextActions(status, deliveries, diffReport) {
    const actions = [];
    const failed = deliveries.filter((d) => !d.success);
    if (failed.length > 0) {
      actions.push({ action: 'check_credentials', platforms: failed.map((f) => f.platform) });
    }
    if (diffReport?.issues?.some((i) => i.auto_fixable && i.severity === 'critical')) {
      actions.push({ action: 'apply_auto_fixes', issues: diffReport.issues.filter((i) => i.auto_fixable) });
    }
    if (diffReport?.overall_status === 'fail') {
      actions.push({ action: 'notify_admin', reason: 'DiffEngine detected critical issues' });
    }
    return actions;
  }

  /**
   * Load a prompt template (delegates to prompt loader).
   */
  loadPrompt(templateName) {
    if (this._promptLoader) return this._promptLoader(templateName);
    const fs = require('fs');
    const path = require('path');
    const p = path.join(__dirname, 'orchestrator.prompt.md');
    return fs.readFileSync(p, 'utf-8');
  }

  /**
   * Get status of all registered adapters.
   */
  getAdapterStatus() {
    const statuses = [];
    for (const [name, adapter] of this.adapters) {
      statuses.push({
        platform: name,
        available: adapter.detect(),
        configValid: adapter.validateConfig()?.valid,
        supportedFormats: adapter.getSupportedFormats(),
      });
    }
    return statuses;
  }
}

module.exports = { DeliveryOrchestrator };
