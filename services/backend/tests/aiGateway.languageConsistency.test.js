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

describe('aiGateway language consistency tracking', () => {
  let gateway;
  let traceAudit;
  let pluginChain;
  let aiMonitor;
  let modelSwitch;
  let originalBeforeRequest;
  let originalAfterResponse;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    gateway = require('../src/services/gateway/aiGateway');
    traceAudit = require('../src/services/traceAuditService');
    pluginChain = require('../src/services/gateway/pluginChain');
    aiMonitor = require('../src/services/aiMonitor');
    modelSwitch = require('../src/services/liveModelSwitch').getInstance();

    originalBeforeRequest = pluginChain.executeBeforeRequest;
    originalAfterResponse = pluginChain.executeAfterResponse;
    pluginChain.executeBeforeRequest = async (ctx) => ctx;
    pluginChain.executeAfterResponse = async (ctx) => ctx;

    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._lastRefreshTime = Date.now();
    gateway.refreshAdapters = async () => {};
    gateway._enforceRateLimit = async () => {};
    gateway._adapters = [];

    aiMonitor.clearTraces();
    modelSwitch.reset();
  });

  afterEach(() => {
    pluginChain.executeBeforeRequest = originalBeforeRequest;
    pluginChain.executeAfterResponse = originalAfterResponse;

    gateway._initialized = false;
    gateway._initPromise = null;
    gateway._adapters = [];

    aiMonitor.clearTraces();
    modelSwitch.reset();

    jest.restoreAllMocks();
  });

  test('records mismatch when a risky adapter emits an English first chunk', async () => {
    const appendSpy = jest.spyOn(require('fs'), 'appendFileSync');
    gateway._adapters = [
      createAdapterEntry('vscode', async (_prompt, options) => {
        options.onChunk({ type: 'text', text: 'I will inspect the repository first.' });
        return {
          success: true,
          content: '我已检查完成。',
          provider: 'VS Code',
          adapter: 'vscode',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('请检查仓库', {
      preferredAdapter: 'vscode',
      preferredStrict: true,
      strictPreferred: true,
      sessionId: 'sess-lang-track-1',
    });

    expect(result.success).toBe(true);
    expect(result.languageConsistency).toMatchObject({
      adapter: 'vscode',
      source: 'first_chunk',
      detectedLanguage: 'en',
      expectedLanguage: 'zh',
      matchesExpectation: false,
    });

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-track-1' });
    expect(summary.ok).toBe(true);
    expect(summary.status).toBe('mismatch');
    expect(summary.detectedLanguage).toBe('en');
    expect(summary.source).toBe('first_chunk');
    expect(appendSpy).toHaveBeenCalled();
  });

  test('injects explicit Chinese language block into codex system before the first attempt', async () => {
    const seenSystems = [];
    gateway._adapters = [
      createAdapterEntry('codex', async (_prompt, options) => {
        seenSystems.push(String(options.system || ''));
        return {
          success: true,
          content: '我先检查仓库。',
          provider: 'Codex',
          adapter: 'codex',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('请检查仓库并默认中文回复', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      sessionId: 'sess-lang-inject-1',
    });

    expect(result.success).toBe(true);
    expect(seenSystems).toHaveLength(1);
    expect(seenSystems[0]).toContain('# Language');
    expect(seenSystems[0]).toContain('KHY expected output: Simplified Chinese.');
    expect(seenSystems[0]).toContain('The first visible sentence must be in Simplified Chinese.');
  });

  test('does not inject the Chinese language block when the user explicitly requests English', async () => {
    const seenSystems = [];
    gateway._adapters = [
      createAdapterEntry('codex', async (_prompt, options) => {
        seenSystems.push(String(options.system || ''));
        return {
          success: true,
          content: 'Ready. Tell me what you want changed.',
          provider: 'Codex',
          adapter: 'codex',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('Please answer in English and review the change.', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      sessionId: 'sess-lang-inject-2',
    });

    expect(result.success).toBe(true);
    expect(seenSystems).toHaveLength(1);
    expect(seenSystems[0]).not.toContain('KHY expected output: Simplified Chinese.');
    expect(seenSystems[0]).not.toContain('The first visible sentence must be in Simplified Chinese.');
  });

  test('falls back to final response when adapter does not stream chunks', async () => {
    gateway._adapters = [
      createAdapterEntry('vscode', async () => ({
        success: true,
        content: 'I checked the config and found the issue.',
        provider: 'VS Code',
        adapter: 'vscode',
        attempts: [],
      })),
    ];

    const result = await gateway.generate('请检查配置', {
      preferredAdapter: 'vscode',
      preferredStrict: true,
      strictPreferred: true,
      sessionId: 'sess-lang-track-2',
    });

    expect(result.success).toBe(true);
    expect(result.languageConsistency).toMatchObject({
      adapter: 'vscode',
      source: 'final_response',
      detectedLanguage: 'en',
      expectedLanguage: 'zh',
      matchesExpectation: false,
    });

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-track-2' });
    expect(summary.ok).toBe(true);
    expect(summary.status).toBe('mismatch');
    expect(summary.source).toBe('final_response');
  });

  test('retries codex with Chinese recovery prompt and suppresses leaked English first chunk', async () => {
    const seenCalls = [];
    const streamed = [];
    let callCount = 0;
    gateway._adapters = [
      createAdapterEntry('codex', async (prompt, options) => {
        callCount += 1;
        seenCalls.push({ prompt, system: options.system });
        if (callCount === 1) {
          options.onChunk({ type: 'text', text: 'I will inspect the repository first.' });
          return {
            success: true,
            content: 'I will inspect the repository first.',
            provider: 'Codex',
            adapter: 'codex',
            attempts: [],
          };
        }
        options.onChunk({ type: 'text', text: '我先检查仓库。' });
        return {
          success: true,
          content: '我先检查仓库。',
          provider: 'Codex',
          adapter: 'codex',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('请检查仓库并用中文回复', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      maxAdapterAttempts: 2,
      sessionId: 'sess-lang-recover-1',
      onChunk: (chunk) => streamed.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('我先检查仓库。');
    expect(callCount).toBe(2);
    expect(String(seenCalls[1].prompt || '')).toContain('[KHY LANGUAGE RECOVERY]');
    expect(String(seenCalls[1].system || '')).toContain('# KHY Language Recovery');

    const renderedText = streamed
      .map((chunk) => String(chunk?.text || chunk?.content || ''))
      .join('\n');
    expect(renderedText).toContain('我先检查仓库。');
    expect(renderedText).not.toContain('I will inspect the repository first.');
  });

  test('retries codex when first English chunk aborts the attempt before a result is returned', async () => {
    const seenCalls = [];
    const streamed = [];
    let callCount = 0;
    gateway._adapters = [
      createAdapterEntry('codex', async (prompt, options) => {
        callCount += 1;
        seenCalls.push({ prompt, system: options.system });
        if (callCount === 1) {
          options.onChunk({ type: 'text', text: 'I will inspect the repository first.' });
          const abortErr = new Error(String(options.abortSignal?.reason || 'language mismatch first_chunk'));
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        options.onChunk({ type: 'text', text: '我先检查仓库。' });
        return {
          success: true,
          content: '我先检查仓库。',
          provider: 'Codex',
          adapter: 'codex',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('请检查仓库并用中文回复', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      maxAdapterAttempts: 2,
      sessionId: 'sess-lang-recover-throw-1',
      onChunk: (chunk) => streamed.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('我先检查仓库。');
    expect(callCount).toBe(2);
    expect(String(seenCalls[1].prompt || '')).toContain('[KHY LANGUAGE RECOVERY]');
    expect(String(seenCalls[1].system || '')).toContain('# KHY Language Recovery');
    expect(result.attempts.some((item) => item.errorType === 'language_mismatch')).toBe(true);

    const renderedText = streamed
      .map((chunk) => String(chunk?.text || chunk?.content || ''))
      .join('\n');
    expect(renderedText).toContain('我先检查仓库。');
    expect(renderedText).not.toContain('I will inspect the repository first.');
  });

  test('uses a dedicated Codex language recovery retry even when maxAdapterAttempts is 1 and the caller does not stream chunks', async () => {
    const seenCalls = [];
    let callCount = 0;
    gateway._adapters = [
      createAdapterEntry('codex', async (prompt, options) => {
        callCount += 1;
        seenCalls.push({ prompt, system: options.system });
        if (callCount === 1) {
          options.onChunk({ type: 'text', text: 'Ready. Tell me what you want changed.' });
          const abortErr = new Error(String(options.abortSignal?.reason || 'language mismatch first_chunk'));
          abortErr.name = 'AbortError';
          throw abortErr;
        }
        return {
          success: true,
          content: '我来继续处理。',
          provider: 'Codex',
          adapter: 'codex',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('请继续并默认中文回复', {
      preferredAdapter: 'codex',
      maxAdapterAttempts: 1,
      sessionId: 'sess-lang-recover-4',
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('我来继续处理。');
    expect(callCount).toBe(2);
    expect(String(seenCalls[1].prompt || '')).toContain('[KHY LANGUAGE RECOVERY]');
    expect(String(seenCalls[1].system || '')).toContain('# KHY Language Recovery');
    expect(result.attempts.some((item) => item.errorType === 'language_mismatch')).toBe(true);
  });

  test('retries codex when the first chunk is undecidable but the final response is English', async () => {
    const seenCalls = [];
    let callCount = 0;
    gateway._adapters = [
      createAdapterEntry('codex', async (prompt, options) => {
        callCount += 1;
        seenCalls.push({ prompt, system: options.system });
        if (callCount === 1) {
          options.onChunk({ type: 'text', text: '...' });
          return {
            success: true,
            content: 'Ready. Tell me what you want changed.',
            provider: 'Codex',
            adapter: 'codex',
            attempts: [],
          };
        }
        return {
          success: true,
          content: '我先继续处理。',
          provider: 'Codex',
          adapter: 'codex',
          attempts: [],
        };
      }),
    ];

    const result = await gateway.generate('请继续并默认中文回复', {
      preferredAdapter: 'codex',
      maxAdapterAttempts: 1,
      sessionId: 'sess-lang-recover-5',
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('我先继续处理。');
    expect(callCount).toBe(2);
    expect(String(seenCalls[1].prompt || '')).toContain('[KHY LANGUAGE RECOVERY]');
    expect(String(seenCalls[1].system || '')).toContain('# KHY Language Recovery');
    expect(result.attempts.some((item) => item.errorType === 'language_mismatch')).toBe(true);
  });

  test('falls through to next adapter when codex keeps English first chunk and language recovery retry is disabled', async () => {
    const streamed = [];
    const codexEntry = createAdapterEntry('codex', async (_prompt, options) => {
      options.onChunk({ type: 'text', text: 'Ready. Tell me what you want changed.' });
      return {
        success: true,
        content: 'Ready. Tell me what you want changed.',
        provider: 'Codex',
        adapter: 'codex',
        attempts: [],
      };
    });
    const relayEntry = createAdapterEntry('relay_api', async (_prompt, options) => {
      options.onChunk({ type: 'text', text: '我来继续处理。' });
      return {
        success: true,
        content: '我来继续处理。',
        provider: 'Relay API',
        adapter: 'relay_api',
        attempts: [],
      };
    });
    gateway._adapters = [codexEntry, relayEntry];

    const result = await gateway.generate('请继续并默认中文回复', {
      preferredAdapter: 'codex',
      maxAdapterAttempts: 1,
      codexLanguageRecoveryRetries: 0,
      sessionId: 'sess-lang-recover-2',
      onChunk: (chunk) => streamed.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.actualAdapter).toBe('relay_api');
    expect(codexEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(relayEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(result.attempts.some((item) => item.errorType === 'language_mismatch')).toBe(true);

    const renderedText = streamed
      .map((chunk) => String(chunk?.text || chunk?.content || ''))
      .join('\n');
    expect(renderedText).toContain('我来继续处理。');
    expect(renderedText).not.toContain('Ready. Tell me what you want changed.');
  });

  test('does not auto-recover when the user explicitly requests English', async () => {
    const streamed = [];
    const codexEntry = createAdapterEntry('codex', async (_prompt, options) => {
      options.onChunk({ type: 'text', text: 'Ready. Tell me what you want changed.' });
      return {
        success: true,
        content: 'Ready. Tell me what you want changed.',
        provider: 'Codex',
        adapter: 'codex',
        attempts: [],
      };
    });
    gateway._adapters = [codexEntry];

    const result = await gateway.generate('Please answer in English and say hello.', {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      maxAdapterAttempts: 2,
      sessionId: 'sess-lang-recover-3',
      onChunk: (chunk) => streamed.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.content).toContain('Ready. Tell me what you want changed.');
    expect(codexEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(result.languageConsistency).toMatchObject({
      adapter: 'codex',
      source: 'first_chunk',
      detectedLanguage: 'en',
      expectedLanguage: 'en',
      matchesExpectation: true,
    });

    const renderedText = streamed
      .map((chunk) => String(chunk?.text || chunk?.content || ''))
      .join('\n');
    expect(renderedText).toContain('Ready. Tell me what you want changed.');

    const summary = traceAudit.getLatestLanguageConsistencySummary({ sessionId: 'sess-lang-recover-3' });
    expect(summary.ok).toBe(true);
    expect(summary.status).toBe('aligned');
    expect(summary.detectedLanguage).toBe('en');
    expect(summary.expectedLanguage).toBe('en');
    expect(summary.source).toBe('first_chunk');
  });
});
