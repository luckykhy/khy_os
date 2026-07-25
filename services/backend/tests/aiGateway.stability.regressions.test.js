'use strict';

function createAdapterEntry(key, generateImpl, options = {}) {
  const {
    available = true,
    enabled = true,
    detail = 'ok',
  } = options;

  const generate = jest.fn(generateImpl);
  return {
    key,
    enabled,
    available,
    priority: 1,
    adapter: {
      detect: () => available,
      getStatus: () => ({ name: key, available, detail }),
      generate,
    },
    _generateMock: generate,
  };
}

describe('aiGateway stability regressions', () => {
  let gateway;
  let pluginChain;
  let aiMonitor;
  let modelSwitch;
  let originalBeforeRequest;
  let originalAfterResponse;
  let originalOnStream;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    gateway = require('../src/services/gateway/aiGateway');
    pluginChain = require('../src/services/gateway/pluginChain');
    aiMonitor = require('../src/services/aiMonitor');
    modelSwitch = require('../src/services/liveModelSwitch').getInstance();

    originalBeforeRequest = pluginChain.executeBeforeRequest;
    originalAfterResponse = pluginChain.executeAfterResponse;
    originalOnStream = pluginChain.executeOnStream;

    pluginChain.executeBeforeRequest = async (ctx) => ctx;
    pluginChain.executeAfterResponse = async (ctx) => ctx;
    pluginChain.executeOnStream = (chunk) => chunk;

    aiMonitor.clearTraces();
    modelSwitch.reset();

    if (gateway._cleanupInterval) {
      clearInterval(gateway._cleanupInterval);
      gateway._cleanupInterval = null;
    }

    gateway._initialized = true;
    gateway._initPromise = null;

    delete process.env.GATEWAY_PREFERRED_ADAPTER;
    delete process.env.GATEWAY_PREFERRED_STRICT;
  });

  afterEach(() => {
    pluginChain.executeBeforeRequest = originalBeforeRequest;
    pluginChain.executeAfterResponse = originalAfterResponse;
    pluginChain.executeOnStream = originalOnStream;

    if (gateway._cleanupInterval) {
      clearInterval(gateway._cleanupInterval);
      gateway._cleanupInterval = null;
    }

    gateway._initialized = false;
    gateway._initPromise = null;
    gateway._adapters = [];

    aiMonitor.clearTraces();
    modelSwitch.reset();

    delete process.env.GATEWAY_PREFERRED_ADAPTER;
    delete process.env.GATEWAY_PREFERRED_STRICT;
    delete process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE;

    jest.restoreAllMocks();
  });

  test('strict preferred missing adapter ends trace once and clears generating state', async () => {
    process.env.GATEWAY_PREFERRED_ADAPTER = '__missing__';
    process.env.GATEWAY_PREFERRED_STRICT = 'true';
    gateway._adapters = [createAdapterEntry('fallback', async () => ({ success: true, content: 'ok', provider: 'fallback', adapter: 'fallback', attempts: [] }))];

    const endTraceSpy = jest.spyOn(aiMonitor, 'endTrace');

    const result = await gateway.generate('ping');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('unavailable');
    expect(endTraceSpy).toHaveBeenCalledTimes(1);
    expect(modelSwitch.getState().generating).toBe(false);
  });

  test('gateway injects KHY highest-priority protocol into adapter prompt and system', async () => {
    const seen = [];
    gateway._adapters = [
      createAdapterEntry('api', async (prompt, options) => {
        seen.push({ prompt, system: options.system });
        return {
          success: true,
          content: 'ok',
          provider: 'api',
          adapter: 'api',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('USER: 你好', {
      preferredAdapter: 'api',
      preferredStrict: true,
      strictPreferred: true,
      system: '# Language\nUse Chinese by default for all user-facing replies.',
    });

    expect(result.success).toBe(true);
    expect(seen).toHaveLength(1);
    expect(String(seen[0].system || '')).toContain('# KHY Protocol Priority');
    expect(String(seen[0].system || '')).toContain('Default to Chinese for user-facing replies');
    expect(String(seen[0].prompt || '')).toContain('[KHY PRIORITY DIRECTIVE]');
    expect(String(seen[0].prompt || '')).toContain('USER: 你好');
  });

  test('gateway writes prompt injection debug summary to file when configured', async () => {
    const appendSpy = jest.spyOn(require('fs'), 'appendFileSync').mockImplementation(() => {});
    const mkdirSpy = jest.spyOn(require('fs'), 'mkdirSync').mockImplementation(() => {});
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';

    gateway._adapters = [
      createAdapterEntry('api', async () => ({
        success: true,
        content: 'ok',
        provider: 'api',
        adapter: 'api',
        attempts: [],
      })),
    ];

    const result = await gateway.generate('USER: 你好', {
      preferredAdapter: 'api',
      preferredStrict: true,
      strictPreferred: true,
      system: '# Language\nUse Chinese by default for all user-facing replies.',
    });

    expect(result.success).toBe(true);
    expect(mkdirSpy).toHaveBeenCalledWith('/tmp', { recursive: true });
    const debugWrite = appendSpy.mock.calls.find((call) => call[0] === '/tmp/khy_prompt_debug.log');
    expect(debugWrite).toBeTruthy();
    const written = String(debugWrite?.[1] || '');
    expect(written).toContain('adapter=api');
    expect(written).toContain('system_length=');
    expect(written).toContain('prompt_preview=');
    expect(written).toContain('[KHY PRIORITY DIRECTIVE]');
  });

  test('gateway exposes protocol priority risk classification for adapters', () => {
    expect(gateway.getKhyProtocolPriorityRisk({ type: 'codex', name: 'Codex CLI' })).toMatchObject({
      risky: true,
      level: 'warn',
      reason: 'upstream_hidden_system_prompt',
    });
    expect(gateway.getKhyProtocolPriorityRisk({ type: 'api', name: 'API 池' })).toMatchObject({
      risky: false,
      level: 'info',
      reason: 'gateway_enforced',
    });
  });

  test('strict preferred timeout does not cascade to other adapters', async () => {
    const timeoutEntry = createAdapterEntry('localLLM', async () => {
      throw new Error('adapter localLLM timeout (12000ms)');
    });
    const fallbackEntry = createAdapterEntry('relay', async () => ({
      success: true,
      content: 'should-not-run',
      provider: 'relay',
      adapter: 'relay',
      attempts: [],
    }));
    gateway._adapters = [timeoutEntry, fallbackEntry];

    const result = await gateway.generate('ping', {
      preferredAdapter: 'localLLM',
      preferredStrict: true,
      strictPreferred: true,
    });

    expect(result.success).toBe(false);
    expect(String(result.content || '')).toContain('已选择模型通道请求失败');
    expect(timeoutEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(fallbackEntry._generateMock).toHaveBeenCalledTimes(0);
  });

  test('strict preferred generic "canceled" is treated as process failure (not user-cancel)', async () => {
    const oldRelax = process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
    process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'false';
    try {
      const claudeEntry = createAdapterEntry('claude', async () => {
        throw new Error('canceled');
      });
      const relayEntry = createAdapterEntry('relay_api', async () => ({
        success: true,
        content: 'relay ok',
        provider: 'relay_api',
        adapter: 'relay_api',
        attempts: [],
      }));
      gateway._adapters = [claudeEntry, relayEntry];

      const result = await gateway.generate('ping', {
        preferredAdapter: 'claude',
        preferredStrict: true,
        strictPreferred: true,
      });

      expect(result.success).toBe(false);
      expect(result.errorType).toBe('process');
      expect(String(result.content || '')).toContain('已选择模型通道请求失败');
      expect(String(result.content || '').toLowerCase()).toContain('canceled');
      expect(claudeEntry._generateMock).toHaveBeenCalledTimes(1);
      expect(relayEntry._generateMock).toHaveBeenCalledTimes(0);
    } finally {
      if (oldRelax === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
      else process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = oldRelax;
    }
  });

  test('strict preferred fast-fail cooldown emits retry-window status', async () => {
    const codexEntry = createAdapterEntry('codex', async () => ({
      success: true,
      content: 'should-not-run',
      provider: 'codex',
      adapter: 'codex',
      attempts: [],
    }));
    gateway._adapters = [codexEntry];
    await gateway._recordAdapterFailure(
      'codex',
      'process',
      'codex backend reconnecting/channel closed'
    );

    const chunks = [];
    const result = await gateway.generate('ping', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.success).toBe(false);
    expect(codexEntry._generateMock).toHaveBeenCalledTimes(0);
    const statusTexts = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusTexts.some(s => s.includes('重试中（等待冷却窗口'))).toBe(true);
    expect(statusTexts.some(s => s.includes('跳过不稳定通道'))).toBe(true);
  });

  // ── User-pinned channel: process/queue failures stay IN-CHANNEL (no spill) ──
  //
  // These two cases assert the authoritative channel-pinning contract introduced
  // by the 0.1.100 fix ("渠道钉选修复", commit 0437b6b) and exhaustively specified
  // in tests/gateway/preferredChannelPinning.test.js. When a request pins a
  // concrete channel via explicit options (`preferredAdapter` + `strictPreferred:
  // true` → userPinnedAdapter), a transient process/queue-timeout failure on that
  // channel must surface a clear in-channel error rather than silently spilling
  // the user onto an adapter they did not select. Anti-jitter for a pinned channel
  // means a deterministic, predictable result — not a surprise channel switch.
  //
  // (Auto-relax/cascade resilience is preserved for ENV-DEFAULT strict, which is
  // NOT a user pin — see preferredChannelPinning.test.js
  // "env-default strict KEEPS its auto-relax cascade".)
  //
  // Historical note: an earlier revision (commit c367d5b) expected these pinned
  // cases to auto-relax and fail over to relay_api. That behavior was deliberately
  // superseded by the 0.1.100 pin-fix; the expectations below now match it.
  test('strict preferred process failure stays in-channel and does NOT spill to unselected fallback', async () => {
    const oldRelax = process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
    const oldMin = process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES;
    process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'true';
    process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES = '1';

    try {
      const codexEntry = createAdapterEntry('codex', async () => ({
        success: true,
        content: 'should-not-run',
        provider: 'codex',
        adapter: 'codex',
        attempts: [],
      }));
      const relayApiEntry = createAdapterEntry('relay_api', async () => ({
        success: true,
        content: 'relay ok',
        provider: 'relay_api',
        adapter: 'relay_api',
        attempts: [],
      }));
      gateway._adapters = [codexEntry, relayApiEntry];
      await gateway._recordAdapterFailure(
        'codex',
        'process',
        'codex backend reconnecting/channel closed'
      );

      const chunks = [];
      const result = await gateway.generate('ping', {
        preferredAdapter: 'codex',
        preferredStrict: true,
        strictPreferred: true,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // Pinned channel fails fast from its cached process failure; the user is NOT
      // silently routed onto relay_api.
      expect(result.success).toBe(false);
      expect(result.errorType).toBe('process');
      expect(codexEntry._generateMock).toHaveBeenCalledTimes(0);
      expect(relayApiEntry._generateMock).toHaveBeenCalledTimes(0);

      const statusTexts = chunks
        .filter(c => c && c.type === 'status')
        .map(c => String(c.text || ''));
      // The pin is honored: strict is never relaxed for a user-pinned channel.
      expect(statusTexts.some(s => s.includes('临时放宽 strict'))).toBe(false);
      expect(statusTexts.some(s => s.includes('跳过不稳定通道'))).toBe(true);
    } finally {
      if (oldRelax === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
      else process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = oldRelax;
      if (oldMin === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES;
      else process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES = oldMin;
    }
  });

  test('strict preferred queue-timeout on codex stays in-channel and does NOT spill to unselected fallback', async () => {
    const oldRelax = process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
    const oldMin = process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES;
    process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'true';
    process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES = '1';

    try {
      const codexEntry = createAdapterEntry('codex', async () => {
        throw new Error('adapter codex queue timeout');
      });
      const relayApiEntry = createAdapterEntry('relay_api', async () => ({
        success: true,
        content: 'relay ok',
        provider: 'relay_api',
        adapter: 'relay_api',
        attempts: [],
      }));
      gateway._adapters = [codexEntry, relayApiEntry];

      const chunks = [];
      const result = await gateway.generate('ping', {
        preferredAdapter: 'codex',
        preferredStrict: true,
        strictPreferred: true,
        onChunk: (chunk) => chunks.push(chunk),
      });

      // The pinned channel is tried exactly once; its queue-timeout surfaces as a
      // clear in-channel failure instead of spilling to relay_api.
      expect(result.success).toBe(false);
      expect(codexEntry._generateMock).toHaveBeenCalledTimes(1);
      expect(relayApiEntry._generateMock).toHaveBeenCalledTimes(0);
      expect(String(result.content || '')).toContain('已选择模型通道请求失败');
      expect(String(result.content || '').toLowerCase()).toContain('queue timeout');

      const statusTexts = chunks
        .filter(c => c && c.type === 'status')
        .map(c => String(c.text || ''));
      expect(statusTexts.some(s => s.includes('临时放宽 strict'))).toBe(false);
    } finally {
      if (oldRelax === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
      else process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = oldRelax;
      if (oldMin === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES;
      else process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES = oldMin;
    }
  });

  test('process failure on preferred cli triggers parallel failover probe and promotes remote adapters', async () => {
    const cliEntry = createAdapterEntry('cli', async () => ({
      success: true,
      content: 'should-not-run',
      provider: 'cli',
      adapter: 'cli',
      attempts: [],
    }));
    const codexEntry = createAdapterEntry('codex', async () => ({
      success: true,
      content: 'should-not-run',
      provider: 'codex',
      adapter: 'codex',
      attempts: [],
    }));
    const relayApiEntry = createAdapterEntry('relay_api', async () => ({
      success: true,
      content: 'relay ok',
      provider: 'relay_api',
      adapter: 'relay_api',
      attempts: [],
    }));
    const apiEntry = createAdapterEntry('api', async () => ({
      success: true,
      content: 'api ok',
      provider: 'api',
      adapter: 'api',
      attempts: [],
    }));
    const relayEntry = createAdapterEntry('relay', async () => ({
      success: true,
      content: 'relay web ok',
      provider: 'relay',
      adapter: 'relay',
      attempts: [],
    }));

    gateway._adapters = [cliEntry, codexEntry, relayApiEntry, apiEntry, relayEntry];
    await gateway._recordAdapterFailure(
      'cli',
      'process',
      'cli backend reconnecting/channel closed'
    );

    const chunks = [];
    const result = await gateway.generate('hello', {
      preferredAdapter: 'cli',
      preferredStrict: false,
      strictPreferred: false,
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('relay_api');
    expect(cliEntry._generateMock).toHaveBeenCalledTimes(0);
    expect(codexEntry._generateMock).toHaveBeenCalledTimes(0);
    expect(relayApiEntry._generateMock).toHaveBeenCalledTimes(1);

    const statusTexts = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusTexts.some(s => s.includes('并行探测'))).toBe(true);
    expect(statusTexts.some(s => s.includes('优先兜底通道'))).toBe(true);
  });

  test('afterResponse hook failure does not downgrade successful adapter result', async () => {
    const successEntry = createAdapterEntry('okAdapter', async () => ({
      success: true,
      content: 'hello from adapter',
      provider: 'okAdapter',
      adapter: 'okAdapter',
      model: 'ok-1',
      tokenUsage: { inputTokens: 1, outputTokens: 2 },
      attempts: [],
    }));
    gateway._adapters = [successEntry];

    pluginChain.executeAfterResponse = async () => {
      throw new Error('hook boom');
    };

    const endTraceSpy = jest.spyOn(aiMonitor, 'endTrace');
    const result = await gateway.generate('hello');

    expect(result.success).toBe(true);
    expect(result.content).toBe('hello from adapter');
    expect(successEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(endTraceSpy).toHaveBeenCalledTimes(1);
    expect(modelSwitch.getState().generating).toBe(false);
  });

  test('onFallback callback exceptions do not break cascade to next adapter', async () => {
    const failingEntry = createAdapterEntry('badAdapter', async () => ({
      success: false,
      error: 'upstream failed',
      statusCode: 500,
      errorType: 'server_error',
      provider: 'badAdapter',
      adapter: 'badAdapter',
      attempts: [],
    }));
    const successEntry = createAdapterEntry('goodAdapter', async () => ({
      success: true,
      content: 'from good adapter',
      provider: 'goodAdapter',
      adapter: 'goodAdapter',
      model: 'good-1',
      attempts: [],
    }));
    gateway._adapters = [failingEntry, successEntry];

    const result = await gateway.generate('hello', {
      onFallback: () => {
        throw new Error('fallback callback failure');
      },
    });

    expect(result.success).toBe(true);
    expect(result.provider).toBe('goodAdapter');
    expect(failingEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(successEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(modelSwitch.getState().generating).toBe(false);
  });

  test('beforeRequest hook failure returns plugin_error with clean completion', async () => {
    gateway._adapters = [createAdapterEntry('unused', async () => ({
      success: true,
      content: 'should not run',
      provider: 'unused',
      adapter: 'unused',
      attempts: [],
    }))];

    pluginChain.executeBeforeRequest = async () => {
      throw new Error('before hook exploded');
    };

    const endTraceSpy = jest.spyOn(aiMonitor, 'endTrace');
    const result = await gateway.generate('hello');

    expect(result.success).toBe(false);
    expect(result.errorType).toBe('plugin_error');
    expect(result.provider).toBe('plugin');
    expect(endTraceSpy).toHaveBeenCalledTimes(1);
    expect(modelSwitch.getState().generating).toBe(false);
  });

  test('init failure resets _initPromise so next init can retry', async () => {
    gateway._initialized = false;
    gateway._initPromise = null;

    const originalDoInit = gateway._doInit;
    gateway._doInit = jest.fn(async () => {
      throw new Error('init failed');
    });

    await expect(gateway.init()).rejects.toThrow('init failed');
    expect(gateway._initPromise).toBeNull();

    gateway._doInit = originalDoInit;
  });

  test('destroy clears cleanup interval and init state', async () => {
    gateway._adapters = [];
    gateway._initialized = true;
    gateway._initPromise = Promise.resolve();
    gateway._cleanupInterval = setInterval(() => {}, 1000);

    await gateway.destroy();

    expect(gateway._cleanupInterval).toBeNull();
    expect(gateway._initialized).toBe(false);
    expect(gateway._initPromise).toBeNull();
  });

  test('destroy still resets state when an adapter destroy throws', async () => {
    gateway._initialized = true;
    gateway._initPromise = Promise.resolve();
    gateway._cleanupInterval = setInterval(() => {}, 1000);
    gateway._adapterFailures = { bad: 3 };
    gateway._adapterLastError = { bad: { at: Date.now(), errorType: 'auth', error: 'boom' } };
    gateway._requestLog = { bad: [Date.now()] };
    gateway._lastRefreshTime = Date.now();
    gateway._adapters = [{
      key: 'bad',
      enabled: true,
      available: true,
      priority: 1,
      adapter: {
        detect: () => true,
        getStatus: () => ({ name: 'bad', available: true, detail: 'x' }),
        generate: async () => ({ success: true, content: 'ok', provider: 'bad', adapter: 'bad' }),
        destroy: async () => { throw new Error('destroy failed'); },
      },
    }];

    await expect(gateway.destroy()).rejects.toThrow('Gateway destroy completed with adapter cleanup errors');
    expect(gateway._cleanupInterval).toBeNull();
    expect(gateway._initialized).toBe(false);
    expect(gateway._initPromise).toBeNull();
    expect(gateway._adapterFailures).toEqual({});
    expect(gateway._adapterLastError).toEqual({});
    expect(gateway._requestLog).toEqual({});
    expect(gateway._lastRefreshTime).toBe(0);
  });

  test('all adapters failed path ends trace once and clears generating state', async () => {
    const bad1 = createAdapterEntry('bad1', async () => ({
      success: false,
      error: 'down-1',
      statusCode: 503,
      errorType: 'server_error',
      provider: 'bad1',
      adapter: 'bad1',
      attempts: [],
    }));
    const bad2 = createAdapterEntry('bad2', async () => ({
      success: false,
      error: 'down-2',
      statusCode: 500,
      errorType: 'server_error',
      provider: 'bad2',
      adapter: 'bad2',
      attempts: [],
    }));
    gateway._adapters = [bad1, bad2];

    const endTraceSpy = jest.spyOn(aiMonitor, 'endTrace');
    const result = await gateway.generate('hello');

    expect(result.success).toBe(false);
    expect(result.attempts.length).toBeGreaterThan(0);
    expect(endTraceSpy).toHaveBeenCalledTimes(1);
    expect(modelSwitch.getState().generating).toBe(false);
  });

  test('serializes local adapters to avoid concurrent runtime overload', () => {
    expect(gateway._shouldSerializeAdapter('localLLM')).toBe(true);
    expect(gateway._shouldSerializeAdapter('localllm')).toBe(true);
    expect(gateway._shouldSerializeAdapter('ollama')).toBe(true);
  });

  test('parallel override env can disable serialization for selected adapters', () => {
    const oldSerial = process.env.GATEWAY_SERIAL_ADAPTERS;
    const oldParallel = process.env.GATEWAY_PARALLEL_ADAPTERS;
    try {
      process.env.GATEWAY_SERIAL_ADAPTERS = 'localLLM,codex';
      process.env.GATEWAY_PARALLEL_ADAPTERS = 'codex';
      jest.resetModules();
      const freshGateway = require('../src/services/gateway/aiGateway');
      if (freshGateway._cleanupInterval) {
        clearInterval(freshGateway._cleanupInterval);
        freshGateway._cleanupInterval = null;
      }
      expect(freshGateway._shouldSerializeAdapter('localLLM')).toBe(true);
      expect(freshGateway._shouldSerializeAdapter('codex')).toBe(false);
    } finally {
      if (oldSerial === undefined) delete process.env.GATEWAY_SERIAL_ADAPTERS;
      else process.env.GATEWAY_SERIAL_ADAPTERS = oldSerial;
      if (oldParallel === undefined) delete process.env.GATEWAY_PARALLEL_ADAPTERS;
      else process.env.GATEWAY_PARALLEL_ADAPTERS = oldParallel;
      jest.resetModules();
      gateway = require('../src/services/gateway/aiGateway');
      if (gateway._cleanupInterval) {
        clearInterval(gateway._cleanupInterval);
        gateway._cleanupInterval = null;
      }
    }
  });

  test('emits queue wait statuses while serialized adapter is pending', async () => {
    const localEntry = createAdapterEntry('localLLM', async () => {
      await new Promise(resolve => setTimeout(resolve, 80));
      return {
        success: true,
        content: 'ok',
        provider: 'localLLM',
        adapter: 'localLLM',
        attempts: [],
      };
    });
    gateway._adapters = [localEntry];

    const firstStatuses = [];
    const secondStatuses = [];

    const first = gateway.generate('first', {
      preferredAdapter: 'localLLM',
      preferredStrict: true,
      strictPreferred: true,
      onChunk: (chunk) => {
        if (chunk && chunk.type === 'status') firstStatuses.push(String(chunk.text || ''));
      },
    });

    await new Promise(resolve => setTimeout(resolve, 10));

    const second = gateway.generate('second', {
      preferredAdapter: 'localLLM',
      preferredStrict: true,
      strictPreferred: true,
      onChunk: (chunk) => {
        if (chunk && chunk.type === 'status') secondStatuses.push(String(chunk.text || ''));
      },
    });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    expect(secondStatuses.some(s => s.includes('Adapter queueing:'))).toBe(true);
    expect(secondStatuses.some(s => s.includes('Adapter slot acquired:'))).toBe(true);
  });

  test('queued concurrent requests skip adapter execution after first process failure is cached', async () => {
    const codexEntry = createAdapterEntry('codex', async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
      return {
        success: false,
        error: 'channel closed',
        statusCode: 0,
        errorType: 'process',
        provider: 'codex',
        adapter: 'codex',
        attempts: [],
      };
    });
    gateway._adapters = [codexEntry];

    const options = {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
    };

    const first = gateway.generate('first-codex-request', options);
    await new Promise(resolve => setTimeout(resolve, 8));
    const second = gateway.generate('second-codex-request', options);

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.success).toBe(false);
    expect(secondResult.success).toBe(false);
    expect(codexEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(String(secondResult.content || '')).toContain('channel closed');
  });

  test('gateway idle watchdog does not abort an active request that keeps streaming chunks', async () => {
    const oldIdle = process.env.GATEWAY_WALL_CLOCK_TIMEOUT_MS;
    process.env.GATEWAY_WALL_CLOCK_TIMEOUT_MS = '40';

    try {
      const activeEntry = createAdapterEntry('codex', async (_prompt, options) => {
        for (let i = 0; i < 4; i += 1) {
          await new Promise(resolve => setTimeout(resolve, 15));
          if (typeof options.onChunk === 'function') {
            options.onChunk({ type: 'content', text: `chunk-${i}` });
          }
        }
        return {
          success: true,
          content: 'stream completed',
          provider: 'codex',
          adapter: 'codex',
          attempts: [],
        };
      });
      gateway._adapters = [activeEntry];

      const chunks = [];
      const result = await gateway.generate('keep streaming', {
        preferredAdapter: 'codex',
        preferredStrict: true,
        strictPreferred: true,
        onChunk: (chunk) => chunks.push(chunk),
      });

      expect(result.success).toBe(true);
      expect(result.content).toBe('stream completed');
      expect(chunks.filter(chunk => chunk && chunk.type === 'content')).toHaveLength(4);
      expect(chunks.some(chunk => String(chunk?.text || '').includes('请求超时'))).toBe(false);
    } finally {
      if (oldIdle === undefined) delete process.env.GATEWAY_WALL_CLOCK_TIMEOUT_MS;
      else process.env.GATEWAY_WALL_CLOCK_TIMEOUT_MS = oldIdle;
    }
  });

  test('background refresh trigger after repeated failures does not block response', async () => {
    const bad1 = createAdapterEntry('bad1', async () => ({
      success: false,
      error: 'down-1',
      statusCode: 503,
      errorType: 'server_error',
      provider: 'bad1',
      adapter: 'bad1',
      attempts: [],
    }));
    const bad2 = createAdapterEntry('bad2', async () => ({
      success: false,
      error: 'down-2',
      statusCode: 500,
      errorType: 'server_error',
      provider: 'bad2',
      adapter: 'bad2',
      attempts: [],
    }));
    gateway._adapters = [bad1, bad2];
    gateway._adapterFailures = { bad1: 5, bad2: 5 };
    gateway._lastRefreshTime = Date.now();

    gateway._enforceRateLimit = async () => {};
    const refreshSpy = jest.spyOn(gateway, 'refreshAdapters').mockResolvedValue();
    const result = await gateway.generate('hello');

    expect(result.success).toBe(false);
    expect(refreshSpy).toHaveBeenCalled();
    expect(modelSwitch.getState().generating).toBe(false);
  });
});
