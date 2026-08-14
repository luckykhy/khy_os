'use strict';

/**
 * aiGateway language-recovery reset frame — regression guard for the
 * duplicate-output fix.
 *
 * Contract under test: when a language-recovery retry starts AFTER visible
 * text already streamed to the caller (`_forwardedVisibleTextLen > 0`),
 * `beginLanguageRecoveryRetry()` must first forward a
 * `{type:'reset', reason:'language-recovery-retry', retract:true}` frame
 * (responseDebounce protocol) so buffer-based consumers drop the retracted
 * draft, and only then may the regenerated answer stream. Without the frame,
 * append-only consumers render the retry as a second full answer.
 *
 * Mocking mirrors tests/aiGateway.languageConsistency.test.js: stub adapter
 * entries drive gateway.generate() end to end with the plugin chain and
 * refresh logic neutralized.
 */

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

describe('aiGateway language-recovery reset frame', () => {
  let gateway;
  let pluginChain;
  let aiMonitor;
  let modelSwitch;
  let originalBeforeRequest;
  let originalAfterResponse;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    gateway = require('../src/services/gateway/aiGateway');
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

  test('emits {type:reset, reason:language-recovery-retry} BEFORE the regenerated text when a draft already streamed', async () => {
    const streamed = [];
    let callCount = 0;
    gateway._adapters = [
      // First generation streams an undecidable visible chunk then settles on
      // an English final response → final_response language mismatch → the
      // gateway starts a language-recovery retry. Because visible text already
      // reached onChunk, the retry MUST retract it with a reset frame first.
      createAdapterEntry('codex', async (_prompt, options) => {
        callCount += 1;
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

    const result = await gateway.generate('请继续并默认中文回复', {
      preferredAdapter: 'codex',
      maxAdapterAttempts: 1,
      sessionId: 'sess-lang-reset-1',
      onChunk: (chunk) => streamed.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('我先检查仓库。');
    expect(callCount).toBe(2);
    expect(result.attempts.some((item) => item.errorType === 'language_mismatch')).toBe(true);

    // Exactly one reset frame, carrying the responseDebounce protocol shape.
    const resetFrames = streamed.filter((c) => c && c.type === 'reset');
    expect(resetFrames).toHaveLength(1);
    expect(resetFrames[0]).toMatchObject({
      type: 'reset',
      reason: 'language-recovery-retry',
      retract: true,
    });

    // Ordering: draft text → reset → regenerated text.
    const resetIdx = streamed.findIndex((c) => c && c.type === 'reset');
    const draftIdx = streamed.findIndex((c) => c && c.type === 'text' && String(c.text || '').includes('...'));
    const retryTextIdx = streamed.findIndex((c) => c && c.type === 'text' && String(c.text || '').includes('我先检查仓库。'));
    expect(draftIdx).toBeGreaterThanOrEqual(0);
    expect(retryTextIdx).toBeGreaterThanOrEqual(0);
    expect(resetIdx).toBeGreaterThan(draftIdx);
    expect(resetIdx).toBeLessThan(retryTextIdx);
  });

  test('does NOT emit a reset frame when no visible text streamed before the retry', async () => {
    const streamed = [];
    let callCount = 0;
    gateway._adapters = [
      // First generation streams nothing visible and fails the language check
      // on the final response → nothing to retract → no reset frame allowed
      // (a spurious reset would wipe unrelated consumer state).
      createAdapterEntry('codex', async (_prompt, options) => {
        callCount += 1;
        if (callCount === 1) {
          return {
            success: true,
            content: 'Ready. Tell me what you want changed.',
            provider: 'Codex',
            adapter: 'codex',
            attempts: [],
          };
        }
        options.onChunk({ type: 'text', text: '我来继续处理。' });
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
      sessionId: 'sess-lang-reset-2',
      onChunk: (chunk) => streamed.push(chunk),
    });

    expect(result.success).toBe(true);
    expect(result.content).toBe('我来继续处理。');
    expect(callCount).toBe(2);
    expect(streamed.filter((c) => c && c.type === 'reset')).toHaveLength(0);
  });
});
