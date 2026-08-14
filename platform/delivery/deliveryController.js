/**
 * DeliveryController — main entry point for cross-platform delivery.
 *
 * Wires together: Orchestrator + Adapters + DiffEngine + TaskStore + TaskQueue
 *
 * Usage:
 *   const controller = new DeliveryController(config);
 *   await controller.init();
 *   const report = await controller.deliver({ content: '...', platforms: ['slack', 'notion'] });
 */

const { DeliveryOrchestrator } = require('./orchestrator/orchestratorAgent');
const { SlackAdapter } = require('./adapters/slackAdapter');
const { NotionAdapter } = require('./adapters/notionAdapter');
const { MarkdownAdapter } = require('./adapters/markdownAdapter');
const { WebhookAdapter } = require('./adapters/webhookAdapter');
const { EmailAdapter } = require('./adapters/emailAdapter');
const { ApiAdapter } = require('./adapters/apiAdapter');
const { DiffEngine } = require('./diff/diffEngine');
const { createTaskStore } = require('./tasks/taskStore');
const { TaskQueue } = require('./tasks/taskQueue');
const { TemplateRegistry } = require('./templates/templateRegistry');
const fs = require('fs');
const path = require('path');

class DeliveryController {
  /**
   * @param {object} config
   * @param {object} config.platforms  — per-platform config objects
   * @param {string} config.dataDir   — data directory for task store
   * @param {number} config.maxConcurrency — max parallel deliveries
   */
  constructor(config = {}) {
    this.config = config;
    this.initialized = false;
  }

  /**
   * Initialize all components.
   */
  async init() {
    if (this.initialized) return this;

    // Template registry
    this.templateRegistry = new TemplateRegistry({
      templatesDir: path.join(__dirname, 'adapters', 'prompts'),
      variables: { env: process.env.NODE_ENV || 'development' },
    });

    // Task store
    this.taskStore = createTaskStore({ dataDir: this.config.dataDir });

    // Task queue
    this.taskQueue = new TaskQueue({
      maxConcurrency: this.config.maxConcurrency || 3,
      maxRetries: this.config.maxRetries || 3,
    });

    // Diff engine
    this.diffEngine = new DiffEngine();

    // Orchestrator
    this.orchestrator = new DeliveryOrchestrator({
      adapters: new Map(),
      diffEngine: this.diffEngine,
      taskStore: this.taskStore,
      taskQueue: this.taskQueue,
      promptLoader: (name) => this.templateRegistry.get(name),
      logger: console,
    });

    // Register adapters
    const platformConfigs = this.config.platforms || {};
    this._registerAdapter('slack', new SlackAdapter(platformConfigs.slack || {}, console));
    this._registerAdapter('notion', new NotionAdapter(platformConfigs.notion || {}, console));
    this._registerAdapter('markdown', new MarkdownAdapter(platformConfigs.markdown || {}, console));
    this._registerAdapter('webhook', new WebhookAdapter(platformConfigs.webhook || {}, console));
    this._registerAdapter('email', new EmailAdapter(platformConfigs.email || {}, console));
    this._registerAdapter('api', new ApiAdapter(platformConfigs.api || {}, console));

    this.initialized = true;
    console.log(`[DeliveryController] Initialized with ${this.orchestrator.adapters.size} adapters`);
    return this;
  }

  /**
   * Deliver content to specified platforms.
   * @param {object} input
   * @returns {Promise<object>} delivery report
   */
  async deliver(input) {
    if (!this.initialized) throw new Error('DeliveryController not initialized. Call init() first.');
    return this.orchestrator.deliver(input);
  }

  /**
   * Get task by ID.
   */
  getTask(taskId) {
    return this.taskStore?.get(taskId) || null;
  }

  /**
   * List tasks.
   */
  listTasks(filter = {}) {
    return this.taskStore?.list(filter) || [];
  }

  /**
   * Get adapter statuses.
   */
  getAdapterStatus() {
    return this.orchestrator.getAdapterStatus();
  }

  /**
   * Load a prompt template.
   */
  getPrompt(name) {
    return this.templateRegistry?.get(name) || null;
  }

  /**
   * List available prompt templates.
   */
  listTemplates() {
    return this.templateRegistry?.list() || [];
  }

  // ── Internal ──────────────────────────────────────────────────────────

  _registerAdapter(name, adapter) {
    this.orchestrator.registerAdapter(adapter);
  }
}

module.exports = { DeliveryController };
