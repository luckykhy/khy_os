/**
 * AI Gateway — central service that routes AI requests through
 * a priority-ordered cascade of adapters:
 *   1. CLI tools (Claude Code, Codex, Aider)
 *   2. Cloud API providers (MultiFreeService)
 *   3. Web relay (manual browser-based relay, always available)
 *
 * Singleton export — matches project convention.
 */
const cliToolAdapter = require('./adapters/cliToolAdapter');
const kiroAdapter = require('./adapters/kiroAdapter');
const cursorAdapter = require('./adapters/cursorAdapter');
const traeAdapter = require('./adapters/traeAdapter');
const claudeAdapter = require('./adapters/claudeAdapter');
const codexAdapter = require('./adapters/codexAdapter');
const windsurfAdapter = require('./adapters/windsurfAdapter');
const vscodeAdapter = require('./adapters/vscodeAdapter');
const ollamaAdapter = require('./adapters/ollamaAdapter');
const relayApiAdapter = require('./adapters/relayApiAdapter');
const apiAdapter = require('./adapters/apiAdapter');
const webRelayAdapter = require('./adapters/webRelayAdapter');
const clipboardRelayAdapter = require('./adapters/clipboardRelayAdapter');

// ── Error classification ─────────────────────────────────────────────
function classifyError(status, message = '') {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status === 400) return 'bad_request';
  if (status === 529) return 'overloaded';
  if (status >= 500 && status < 600) return 'server_error';

  const msg = (message || '').toLowerCase();
  if (msg.includes('etimedout') || msg.includes('timeout') || msg.includes('aborted')) return 'timeout';
  if (msg.includes('econnrefused') || msg.includes('enotfound') || msg.includes('network')) return 'network';
  if (msg.includes('rate') && msg.includes('limit')) return 'rate_limit';
  if (msg.includes('unauthorized') || /invalid.*key/i.test(msg) || msg.includes('api key')) return 'auth';

  return 'unknown';
}

class AIGateway {
  constructor() {
    this._adapters = [
      { key: 'cli', adapter: cliToolAdapter, priority: 1, enabled: true },
      { key: 'kiro', adapter: kiroAdapter, priority: 2, enabled: true },
      { key: 'cursor', adapter: cursorAdapter, priority: 3, enabled: true },
      { key: 'trae', adapter: traeAdapter, priority: 4, enabled: true },
      { key: 'claude', adapter: claudeAdapter, priority: 5, enabled: true },
      { key: 'codex', adapter: codexAdapter, priority: 6, enabled: true },
      { key: 'windsurf', adapter: windsurfAdapter, priority: 7, enabled: true },
      { key: 'vscode', adapter: vscodeAdapter, priority: 8, enabled: true },
      { key: 'ollama', adapter: ollamaAdapter, priority: 9, enabled: true },
      { key: 'relay_api', adapter: relayApiAdapter, priority: 10, enabled: true },
      { key: 'api', adapter: apiAdapter, priority: 11, enabled: true },
      { key: 'relay', adapter: webRelayAdapter, priority: 12, enabled: true },
      { key: 'clipboard', adapter: clipboardRelayAdapter, priority: 13, enabled: true },
    ];
    this._initialized = false;
    this._initPromise = null;
    // Anti-ban: token bucket rate limiter (per adapter)
    this._requestLog = {};          // key → timestamps of recent requests
    this._consecutiveFailures = 0;  // for exponential backoff
    this._lastRefreshTime = 0;      // last adapter re-detection time
    // Local adapters that don't need rate limiting
    this._localAdapters = new Set(['ollama']);
  }

  /**
   * Re-detect all adapters (called periodically or after failures).
   * Useful when IDEs update and new auth tokens become available.
   */
  async refreshAdapters() {
    for (const entry of this._adapters) {
      if (!entry.enabled) continue;
      try {
        if (entry.adapter.detectAsync) {
          entry.available = await entry.adapter.detectAsync();
        } else {
          entry.available = entry.adapter.detect(true); // force refresh
        }
      } catch {
        entry.available = false;
      }
    }
    this._lastRefreshTime = Date.now();
  }

  /**
   * Anti-ban: enforce minimum request interval with jitter (per adapter).
   * Uses token bucket algorithm — max 10 requests per minute per adapter.
   * Skips rate limiting for local adapters (e.g. Ollama).
   */
  async _enforceRateLimit(adapterKey) {
    // Skip rate limiting for local adapters
    if (this._localAdapters.has(adapterKey)) return;

    const now = Date.now();
    const WINDOW_MS = 60_000; // 1 minute window
    const MAX_REQUESTS = 10;

    // Initialize per-adapter log if needed
    if (!this._requestLog[adapterKey]) this._requestLog[adapterKey] = [];
    const log = this._requestLog[adapterKey];

    // Clean old entries
    this._requestLog[adapterKey] = log.filter(t => now - t < WINDOW_MS);

    if (this._requestLog[adapterKey].length >= MAX_REQUESTS) {
      // Wait until oldest request expires + random jitter
      const waitMs = (this._requestLog[adapterKey][0] + WINDOW_MS - now) + Math.random() * 2000;
      await new Promise(r => setTimeout(r, Math.max(100, waitMs)));
    }

    // Exponential backoff on consecutive failures
    if (this._consecutiveFailures > 0) {
      const backoffMs = Math.min(30000, 1000 * Math.pow(2, this._consecutiveFailures - 1));
      const jitter = Math.random() * backoffMs * 0.5;
      await new Promise(r => setTimeout(r, backoffMs + jitter));
    }

    this._requestLog[adapterKey].push(Date.now());
  }

  /**
   * Initialize the gateway: detect available adapters.
   * Safe to call multiple times (idempotent after first, race-safe).
   */
  async init() {
    if (this._initialized) return;
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInit();
    return this._initPromise;
  }

  async _doInit() {

    // Respect environment toggles
    if (process.env.GATEWAY_CLI_ENABLED === 'false') {
      this._adapters.find(a => a.key === 'cli').enabled = false;
    }
    if (process.env.GATEWAY_OLLAMA_ENABLED === 'false') {
      this._adapters.find(a => a.key === 'ollama').enabled = false;
    }
    if (process.env.GATEWAY_RELAY_ENABLED === 'false') {
      this._adapters.find(a => a.key === 'relay').enabled = false;
    }

    // Respect IDE adapter toggles
    for (const ideKey of ['kiro', 'cursor', 'trae', 'claude', 'codex', 'windsurf', 'vscode']) {
      const envKey = `GATEWAY_${ideKey.toUpperCase()}_ENABLED`;
      if (process.env[envKey] === 'false') {
        const entry = this._adapters.find(a => a.key === ideKey);
        if (entry) entry.enabled = false;
      }
    }

    // Run detection on each enabled adapter
    for (const entry of this._adapters) {
      if (!entry.enabled) continue;
      try {
        // Async detection for adapters that need network calls
        if (entry.adapter.detectAsync) {
          entry.available = await entry.adapter.detectAsync();
        } else {
          entry.available = entry.adapter.detect();
        }
      } catch {
        entry.available = false;
      }
    }

    this._initialized = true;
    this._initPromise = null;
  }

  /**
   * Generate a response by cascading through adapters.
   * Returns the same shape as MultiFreeService.generateResponse().
   */
  async generate(prompt, options = {}) {
    if (!this._initialized) await this.init();

    // AI Monitor: start trace
    const monitor = require('../aiMonitor');
    const traceId = monitor.startTrace({ prompt, model: options.model, adapter: options.adapter, options });

    // Plugin Chain: onBeforeRequest
    const pluginChain = require('./pluginChain');
    let pluginCtx = await pluginChain.executeBeforeRequest({ prompt, options, adapter: null, cancelled: false });
    if (pluginCtx.cancelled) {
      monitor.endTrace(traceId, null, { error: 'Cancelled by plugin' });
      return { success: false, content: 'Request cancelled by gateway plugin', provider: 'plugin', attempts: [] };
    }
    prompt = pluginCtx.prompt || prompt;
    options = pluginCtx.options || options;

    // ── Gateway-level app launch interception ─────────────────────────
    try {
      const { tryAppLaunchIntent } = require('./appLaunchInterceptor');
      const appLaunchResult = await tryAppLaunchIntent(prompt, options);
      if (appLaunchResult) {
        monitor.endTrace(traceId, appLaunchResult, {});
        return appLaunchResult;
      }
    } catch { /* interceptor load failure — continue to adapter cascade */ }

    // ── Per-user upstream override (multi-tenant data plane) ──────────
    // When an explicit apiEndpoint is supplied (by the proxy from a resolved
    // UserGatewayConfig), route straight to the relay adapter with that user's
    // key/endpoint/format and SKIP global accountPool/apiKeyPool selection
    // entirely. On failure we return a structured error and deliberately do
    // NOT fall back to the global cascade — a tenant's request must never be
    // served by global keys. Absent options.apiEndpoint this block is inert
    // and the cascade below is byte-identical to before.
    if (options.apiEndpoint) {
      const relayEntry = this._adapters.find(a => a.key === 'relay_api' || a.key === 'relay');
      if (relayEntry && relayEntry.adapter) {
        try {
          await this._enforceRateLimit(relayEntry.key);
          const result = await relayEntry.adapter.generate(prompt, { ...options });
          if (result && result.success) {
            this._consecutiveFailures = 0;
            monitor.endTrace(traceId, { content: result.content, model: result.model, provider: result.provider, tokens: result.tokenUsage });
            await pluginChain.executeAfterResponse({ prompt, options, response: result, adapter: relayEntry.key });
            return {
              success: true,
              content: result.content,
              provider: result.provider,
              adapter: result.adapter,
              model: result.model || null,
              tokenUsage: result.tokenUsage || null,
              attempts: result.attempts || [],
            };
          }
          monitor.endTrace(traceId, null, { error: (result && result.error) || 'user upstream failed' });
          return {
            success: false,
            content: (result && result.content) || 'User gateway upstream request failed',
            provider: (result && result.provider) || 'relay',
            adapter: (result && result.adapter) || relayEntry.key,
            model: (result && result.model) || options.model || null,
            statusCode: result && result.statusCode,
            error: result && result.error,
            errorType: (result && result.errorType) || classifyError(result && result.statusCode, result && result.error),
            attempts: (result && result.attempts) || [],
          };
        } catch (err) {
          const sc = err.status || err.statusCode || err.response?.status || 0;
          monitor.endTrace(traceId, null, { error: err.message });
          return {
            success: false,
            content: `User gateway upstream request failed: ${err.message}`,
            provider: 'relay',
            adapter: relayEntry.key,
            model: options.model || null,
            statusCode: sc,
            error: err.message,
            errorType: classifyError(sc, err.message),
            attempts: [],
          };
        }
      }
    }

    // Periodic adapter re-detection (every 30 minutes)
    const REFRESH_INTERVAL = 30 * 60 * 1000;
    if (Date.now() - this._lastRefreshTime > REFRESH_INTERVAL) {
      await this.refreshAdapters();
    }

    const allAttempts = [];

    // Use preferred adapter/model from env if set
    const preferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    const preferredModel = process.env.GATEWAY_PREFERRED_MODEL;

    // Auto mode: select best adapter for this task
    let orderedAdapters = this._adapters;
    if (preferredAdapter === 'auto') {
      const autoResult = this.autoSelectModel(options.taskType || 'conversation');
      if (autoResult.adapter !== 'relay') {
        options = { ...options, model: autoResult.model || options.model };
        // Reorder to try auto-selected first
        orderedAdapters = [
          ...this._adapters.filter(a => a.key === autoResult.adapter),
          ...this._adapters.filter(a => a.key !== autoResult.adapter),
        ];
      }
    } else if (preferredAdapter) {
      if (!options.model && preferredModel) {
        options = { ...options, model: preferredModel };
      }
      orderedAdapters = [
        ...this._adapters.filter(a => a.key === preferredAdapter),
        ...this._adapters.filter(a => a.key !== preferredAdapter),
      ];
    } else {
      // Habit-based preference: if no env override, use learned preference
      let habitPreferred = null;
      try {
        const { getPreferredModel } = require('../usageHabitService');
        habitPreferred = getPreferredModel('conversation');
      } catch { /* best effort */ }

      if (habitPreferred && habitPreferred.adapter) {
        orderedAdapters = [
          ...this._adapters.filter(a => a.key === habitPreferred.adapter),
          ...this._adapters.filter(a => a.key !== habitPreferred.adapter),
        ];
        if (habitPreferred.model && !options.model) {
          options = { ...options, model: habitPreferred.model };
        }
      }
    }

    for (const entry of orderedAdapters) {
      if (!entry.enabled) continue;

      // Re-check availability for api adapter (keys might have changed)
      if (entry.key === 'api') {
        entry.available = entry.adapter.detect();
      }

      if (!entry.available && entry.key !== 'relay') continue;

      // Account Pool integration (Antigravity-style): for 'api' adapter, try multi-account routing
      if (entry.key === 'api') {
        try {
          const accountPool = require('../accountPool');
          await accountPool.init();
          const apProvider = options.provider || process.env.DEFAULT_AI_PROVIDER || 'deepseek';
          const maxPoolRetries = 5;
          for (let pi = 0; pi < maxPoolRetries; pi++) {
            const picked = accountPool.pick(apProvider, { sessionId: options.sessionId, model: options.model });
            if (!picked) break;

            try {
              await this._enforceRateLimit(entry.key);
              const result = await entry.adapter.generate(prompt, {
                ...options,
                apiKey: picked.key,
                apiEndpoint: picked.endpoint || undefined,
              });
              // Only push adapter's internal sub-attempts (avoid double-counting)
              if (result.attempts) allAttempts.push(...result.attempts);

              if (result.success) {
                accountPool.markSuccess(picked.accountId);
                this._consecutiveFailures = 0;
                monitor.endTrace(traceId, { content: result.content, model: result.model, provider: result.provider, tokens: result.tokenUsage });
                await pluginChain.executeAfterResponse({ prompt, options, response: result, adapter: entry.key });
                return {
                  success: true,
                  content: result.content,
                  provider: result.provider + (picked.label ? ` [${picked.label}]` : '') + ` (${picked.tier})`,
                  adapter: result.adapter,
                  model: result.model || null,
                  tokenUsage: result.tokenUsage || null,
                  attempts: allAttempts,
                };
              }

              const sc = result.statusCode || 0;
              const resHeaders = result.headers || null;
              accountPool.markFailure(picked.accountId, sc, result.error || '', resHeaders);
              // Only add our own attempt record if adapter didn't already include it
              if (!result.attempts || result.attempts.length === 0) {
                allAttempts.push({
                  provider: entry.adapter.getStatus().name,
                  success: false,
                  error: result.error || 'unknown',
                  statusCode: sc,
                  errorType: result.errorType || classifyError(sc, result.error),
                });
              }
              monitor.addCascadeAttempt(traceId, { adapter: entry.key, success: false, error: result.error, model: options.model });
            } catch (err) {
              const sc = err.status || err.statusCode || err.response?.status || 0;
              const errHeaders = err.response?.headers || null;
              accountPool.markFailure(picked.accountId, sc, err.message, errHeaders);
              allAttempts.push({
                provider: entry.adapter.getStatus().name,
                success: false,
                error: err.message,
                statusCode: sc,
                errorType: classifyError(sc, err.message),
              });
              if (![429, 403, 401, 529].includes(sc) && !/rate.?limit|overloaded/i.test(err.message)) {
                break;
              }
            }
          }
          // Account pool exhausted — notify caller and fall through to standard single-key flow
          if (options.onFallback) {
            const nextEntry = orderedAdapters.find(a =>
              a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
            );
            options.onFallback({
              failedAdapter: entry.adapter.getStatus().name,
              failedError: 'all account pool entries exhausted',
              failedErrorType: 'pool_exhausted',
              nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
            });
          }
        } catch { /* accountPool not available, fall through */ }
      }

      // Legacy API Key Pool integration: for relay/api adapters, try multiple keys
      let poolProvider = null;
      let poolKeyId = null;
      try {
        const pool = require('../apiKeyPool');
        pool.init();
        // Map adapter key to pool provider
        if (entry.key === 'relay_api' || entry.key === 'relay') poolProvider = 'relay';
        else if (entry.key === 'api') poolProvider = null; // handled by multiFreeService
        // Check if pool has keys for this provider
        if (poolProvider && pool.hasAvailableKeys(poolProvider)) {
          // Pool-based multi-key retry loop
          const maxPoolRetries = 5;
          const slots = require('../concurrencySlots');
          for (let pi = 0; pi < maxPoolRetries; pi++) {
            const picked = pool.pick(poolProvider);
            if (!picked) break;
            poolKeyId = picked.keyId;

            // Acquire concurrency slot
            const releaseSlot = slots.acquire(picked.keyId);

            try {
              await this._enforceRateLimit(entry.key);
              const result = await entry.adapter.generate(prompt, {
                ...options,
                apiKey: picked.key,
                apiEndpoint: picked.endpoint || undefined,
              });
              if (releaseSlot) releaseSlot();
              if (result.attempts) allAttempts.push(...result.attempts);

              if (result.success) {
                pool.markSuccess(picked.keyId);
                this._consecutiveFailures = 0;
                monitor.endTrace(traceId, { content: result.content, model: result.model, provider: result.provider, tokens: result.tokenUsage });
                await pluginChain.executeAfterResponse({ prompt, options, response: result, adapter: entry.key });
                return {
                  success: true,
                  content: result.content,
                  provider: result.provider + (picked.label ? ` [${picked.label}]` : ''),
                  adapter: result.adapter,
                  model: result.model || null,
                  tokenUsage: result.tokenUsage || null,
                  attempts: allAttempts,
                };
              }

              // Failed but no exception
              const sc = result.statusCode || 0;
              const resHeaders = result.headers || null;
              pool.markFailure(picked.keyId, sc, result.error || '', resHeaders);
              allAttempts.push({
                provider: entry.adapter.getStatus().name,
                success: false,
                error: result.error || 'unknown',
                statusCode: sc,
                errorType: result.errorType || classifyError(sc, result.error),
              });
              monitor.addCascadeAttempt(traceId, { adapter: entry.key, success: false, error: result.error, model: options.model });
              // Continue to next pool key
            } catch (err) {
              if (releaseSlot) releaseSlot();
              const sc = err.status || err.statusCode || err.response?.status || 0;
              const errHeaders = err.response?.headers || null;
              pool.markFailure(picked.keyId, sc, err.message, errHeaders);
              allAttempts.push({
                provider: entry.adapter.getStatus().name,
                success: false,
                error: err.message,
                statusCode: sc,
                errorType: classifyError(sc, err.message),
              });
              // Continue to next pool key for retryable errors
              if (![429, 403, 401, 529].includes(sc) && !/rate.?limit|overloaded/i.test(err.message)) {
                break; // Non-retryable, move to next adapter
              }
            }
          }
          // Pool exhausted for this adapter, notify and move to next adapter
          if (options.onFallback) {
            const nextEntry = orderedAdapters.find(a =>
              a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
            );
            options.onFallback({
              failedAdapter: entry.adapter.getStatus().name,
              failedError: 'all pool keys exhausted',
              failedErrorType: 'pool_exhausted',
              nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
            });
          }
          continue; // Move to next adapter in cascade
        }
      } catch { /* pool not available, fall through to normal flow */ }

      // Standard single-key flow (no pool or pool not applicable)
      // Attempt with one auto-retry for transient errors
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          // Anti-ban: enforce per-adapter rate limit with jitter
          await this._enforceRateLimit(entry.key);

          const result = await entry.adapter.generate(prompt, { ...options });
          if (result.attempts) allAttempts.push(...result.attempts);

          if (result.success) {
            this._consecutiveFailures = 0; // reset on success
            monitor.endTrace(traceId, { content: result.content, model: result.model, provider: result.provider, tokens: result.tokenUsage });
            await pluginChain.executeAfterResponse({ prompt, options, response: result, adapter: entry.key });
            return {
              success: true,
              content: result.content,
              provider: result.provider,
              adapter: result.adapter,
              model: result.model || null,
              tokenUsage: result.tokenUsage || null,
              attempts: allAttempts,
            };
          }

          // Not success but no exception — extract error info if present
          const errType = result.errorType || classifyError(result.statusCode, result.error);
          allAttempts.push({
            provider: entry.adapter.getStatus().name,
            success: false,
            error: result.error || 'unknown',
            statusCode: result.statusCode,
            errorType: errType,
          });

          // Notify caller about fallback (don't silently switch)
          if (options.onFallback) {
            const nextEntry = orderedAdapters.find(a =>
              a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
            );
            options.onFallback({
              failedAdapter: entry.adapter.getStatus().name,
              failedError: result.error || 'unknown',
              failedErrorType: errType,
              failedStatusCode: result.statusCode,
              nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
            });
          }
          break; // non-exception failure, move to next adapter
        } catch (err) {
          const status = err.status || err.statusCode || err.response?.status;
          const errorType = classifyError(status, err.message);

          allAttempts.push({
            provider: entry.adapter.getStatus().name,
            success: false,
            error: err.message,
            statusCode: status,
            errorType,
          });

          // Auto-retry once for transient errors (rate_limit, server_error, overloaded)
          if (attempt === 0 && (errorType === 'rate_limit' || errorType === 'server_error' || errorType === 'overloaded')) {
            const baseDelay = errorType === 'rate_limit' ? 3000 : 1500;
            const jitter = Math.random() * baseDelay * 0.5; // random jitter up to 50%
            await new Promise(r => setTimeout(r, baseDelay + jitter));
            continue; // retry same adapter
          }

          // Notify caller about fallback (don't silently switch)
          if (options.onFallback) {
            const nextEntry = orderedAdapters.find(a =>
              a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
            );
            options.onFallback({
              failedAdapter: entry.adapter.getStatus().name,
              failedError: err.message,
              failedErrorType: errorType,
              failedStatusCode: status,
              nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
            });
          }
          break; // non-retryable or already retried, move to next adapter
        }
      }
    }

    // All adapters failed — trigger refresh for next attempt and track failures
    this._consecutiveFailures++;
    if (this._consecutiveFailures >= 2) {
      // Force re-detect adapters on next call (IDE might have updated tokens)
      this.refreshAdapters().catch(() => {});
    }

    monitor.endTrace(traceId, null, { error: 'All adapters failed' });

    // Build detailed failure report
    return {
      success: false,
      content: [
        '所有 AI 通道均不可用。',
        '',
        '🆓 免费方案 (推荐):',
        '  • Kiro IDE — 免费 Claude 4 额度: https://kiro.dev',
        '  • Trae IDE — 免费 Claude/GPT 额度: https://trae.ai',
        '  • Ollama 本地模型 — 无需网络，运行 /models 安装',
        '',
        '💰 付费订阅:',
        '  • Claude: https://claude.ai/pricing',
        '  • OpenAI: https://platform.openai.com',
        '  • Cursor: https://cursor.com/pricing',
        '  • 智谱AI (国内直连): https://open.bigmodel.cn',
        '  • 通义千问 (国内直连): https://dashscope.aliyun.com',
        '',
        '⚡ 快速配置:',
        '  • ai config — 配置 API 密钥',
        '  • /proxy — 配置代理 (Clash/VPN)',
        '  • gateway relay — 启动 Web 中转服务',
      ].join('\n'),
      provider: 'none',
      adapter: 'none',
      attempts: allAttempts,
      errorType: allAttempts.length > 0 ? allAttempts[allAttempts.length - 1].errorType : 'unknown',
    };
  }

  /**
   * Auto-select the best available model.
   * Priority: user preference > habit > capability score > priority order.
   * @param {string} [taskType] - 'conversation', 'analysis', 'code', 'reasoning'
   * @returns {{ adapter: string, model: string|null, reason: string }}
   */
  autoSelectModel(taskType = 'conversation') {
    if (!this._initialized) {
      // Quick sync check
      for (const entry of this._adapters) {
        if (entry.enabled && entry.adapter.detect()) {
          entry.available = true;
        }
      }
    }

    // 1. Check user preference
    const preferred = process.env.GATEWAY_PREFERRED_ADAPTER;
    if (preferred && preferred !== 'auto') {
      const entry = this._adapters.find(a => a.key === preferred && a.enabled);
      if (entry && (entry.available || entry.adapter.detect())) {
        return {
          adapter: preferred,
          model: process.env.GATEWAY_PREFERRED_MODEL || null,
          reason: 'user_preference',
        };
      }
    }

    // 2. Check habit-based preference
    try {
      const { getPreferredModel } = require('../usageHabitService');
      const habit = getPreferredModel(taskType);
      if (habit && habit.adapter) {
        const entry = this._adapters.find(a => a.key === habit.adapter && a.enabled);
        if (entry && entry.available) {
          return { adapter: habit.adapter, model: habit.model || null, reason: 'learned_habit' };
        }
      }
    } catch { /* best effort */ }

    // 3. Task-based capability matching
    const TASK_PREFERENCES = {
      reasoning: ['claude', 'codex', 'cursor', 'api', 'ollama'],
      code: ['claude', 'codex', 'cursor', 'kiro', 'api'],
      analysis: ['api', 'claude', 'cursor', 'ollama', 'windsurf'],
      conversation: null, // use default priority
    };

    const taskOrder = TASK_PREFERENCES[taskType];
    if (taskOrder) {
      for (const key of taskOrder) {
        const entry = this._adapters.find(a => a.key === key && a.enabled && a.available);
        if (entry) {
          return { adapter: key, model: null, reason: `best_for_${taskType}` };
        }
      }
    }

    // 4. Fallback: first available by priority
    for (const entry of this._adapters) {
      if (!entry.enabled || !entry.available) continue;
      if (entry.key === 'relay') continue; // relay is last resort
      return { adapter: entry.key, model: null, reason: 'priority_order' };
    }

    // 5. Relay as absolute fallback
    return { adapter: 'relay', model: null, reason: 'fallback' };
  }

  /**
   * Generate with a specific sub-model (for delegation from main model).
   * @param {string} prompt
   * @param {string} adapterKey - specific adapter to use
   * @param {object} [options]
   * @returns {Promise<object>}
   */
  async generateWithSubModel(prompt, adapterKey, options = {}) {
    if (!this._initialized) await this.init();

    const entry = this._adapters.find(a => a.key === adapterKey && a.enabled);
    if (!entry || !entry.available) {
      return {
        success: false,
        content: `Sub-model adapter "${adapterKey}" is not available.`,
        provider: 'none',
        adapter: adapterKey,
        attempts: [{ provider: adapterKey, success: false, error: 'not_available' }],
      };
    }

    try {
      const result = await entry.adapter.generate(prompt, options);
      return result;
    } catch (err) {
      return {
        success: false,
        content: err.message,
        provider: entry.adapter.getStatus().name,
        adapter: adapterKey,
        attempts: [{ provider: adapterKey, success: false, error: err.message }],
      };
    }
  }

  /**
   * Get status of all adapters (for display).
   */
  getStatus() {
    return this._adapters.map(entry => {
      const status = entry.adapter.getStatus();
      return {
        ...status,
        enabled: entry.enabled,
        priority: entry.priority,
      };
    });
  }

  /**
   * Get the first available adapter (for banner display).
   * Returns status object with activeModel if a preferred model is set.
   */
  getActiveAdapter() {
    const preferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    const preferredModel = process.env.GATEWAY_PREFERRED_MODEL;

    if (!this._initialized) {
      // Quick sync detection (no async needed for status display)
      try {
        for (const entry of this._adapters) {
          if (!entry.enabled) continue;
          if (entry.adapter.detect()) {
            const status = entry.adapter.getStatus();
            status.activeModel = preferredModel || null;
            return status;
          }
        }
      } catch { /* ignore */ }
      return null;
    }

    // If preferred adapter is set, try it first
    if (preferredAdapter) {
      const entry = this._adapters.find(a => a.key === preferredAdapter && a.enabled);
      if (entry) {
        const status = entry.adapter.getStatus();
        if (status.available) {
          status.activeModel = preferredModel || null;
          return status;
        }
      }
    }

    for (const entry of this._adapters) {
      if (!entry.enabled) continue;
      const status = entry.adapter.getStatus();
      if (status.available) {
        status.activeModel = preferredModel || null;
        return status;
      }
    }
    return null;
  }

  /**
   * Get the web relay adapter directly (for `gateway relay` command).
   */
  getRelayAdapter() {
    return webRelayAdapter;
  }

  /**
   * Get a specific adapter by key (for IDE commands).
   */
  getAdapter(key) {
    const entry = this._adapters.find(a => a.key === key);
    return entry ? entry.adapter : null;
  }

  /**
   * Generate using a specific adapter + model (for IDE commands).
   */
  async generateWithAdapter(adapterKey, prompt, options = {}) {
    const adapter = this.getAdapter(adapterKey);
    if (!adapter) throw new Error(`Adapter "${adapterKey}" not found`);
    return adapter.generate(prompt, options);
  }

  /**
   * List models from a specific IDE adapter.
   */
  async listModels(adapterKey) {
    const adapter = this.getAdapter(adapterKey);
    if (!adapter?.listModels) return [];
    return adapter.listModels();
  }

  /**
   * Tear down all adapters.
   */
  async destroy() {
    for (const entry of this._adapters) {
      if (entry.adapter.destroy) {
        await entry.adapter.destroy();
      }
    }
    this._initialized = false;
  }

  /**
   * Test adapter connectivity with a lightweight request.
   * Two-step test pattern (inspired by cc-haha ProviderTestResult):
   *   Step 1: detect() — is the adapter reachable?
   *   Step 2: listModels() or generate ping — can it actually serve requests?
   * @param {string} adapterKey
   * @returns {Promise<{connectivity: {success,latencyMs,error?}, models?: {success,latencyMs,error?,count?}}>}
   */
  async testAdapter(adapterKey) {
    const entry = this._adapters.find(a => a.key === adapterKey);
    if (!entry || !entry.adapter) {
      return { connectivity: { success: false, latencyMs: 0, error: 'Adapter not found' } };
    }

    const result = { connectivity: null, models: null };

    // Step 1: Basic detection / connectivity
    const t1 = Date.now();
    let step1Timer = null;
    try {
      let ok;
      if (entry.adapter.detectAsync) {
        ok = await Promise.race([
          entry.adapter.detectAsync(),
          new Promise((_, rej) => {
            step1Timer = setTimeout(() => rej(new Error('timeout (10s)')), 10000);
          }),
        ]);
      } else {
        ok = entry.adapter.detect();
      }
      result.connectivity = { success: !!ok, latencyMs: Date.now() - t1 };
      if (!ok) result.connectivity.error = 'not detected';
    } catch (err) {
      result.connectivity = { success: false, latencyMs: Date.now() - t1, error: err.message };
    } finally {
      if (step1Timer) clearTimeout(step1Timer);
    }

    if (!result.connectivity.success) return result;

    // Step 2: Model listing (if supported) — verifies API actually works
    if (entry.adapter.listModels) {
      const t2 = Date.now();
      let step2Timer = null;
      try {
        const models = await Promise.race([
          entry.adapter.listModels(),
          new Promise((_, rej) => {
            step2Timer = setTimeout(() => rej(new Error('timeout (10s)')), 10000);
          }),
        ]);
        result.models = {
          success: true,
          latencyMs: Date.now() - t2,
          count: Array.isArray(models) ? models.length : 0,
          list: Array.isArray(models) ? models.slice(0, 10) : [],
        };
      } catch (err) {
        result.models = { success: false, latencyMs: Date.now() - t2, error: err.message };
      } finally {
        if (step2Timer) clearTimeout(step2Timer);
      }
    }

    return result;
  }
}

const gateway = new AIGateway();
gateway.classifyError = classifyError;
module.exports = gateway;
