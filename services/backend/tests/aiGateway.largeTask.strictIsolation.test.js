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

describe('aiGateway large-task strict isolation', () => {
  let gateway;
  let oldRelax;
  let oldRelaxLarge;

  beforeEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();

    gateway = require('../src/services/gateway/aiGateway');
    gateway._initialized = true;
    gateway._initPromise = null;
    gateway._adapters = [];

    oldRelax = process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
    oldRelaxLarge = process.env.GATEWAY_STRICT_AUTO_RELAX_LARGE_TASKS;
    process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = 'true';
    delete process.env.GATEWAY_STRICT_AUTO_RELAX_LARGE_TASKS;
    delete process.env.GATEWAY_PREFERRED_ADAPTER;
    delete process.env.GATEWAY_PREFERRED_STRICT;
  });

  afterEach(() => {
    if (oldRelax === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS;
    else process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS = oldRelax;
    if (oldRelaxLarge === undefined) delete process.env.GATEWAY_STRICT_AUTO_RELAX_LARGE_TASKS;
    else process.env.GATEWAY_STRICT_AUTO_RELAX_LARGE_TASKS = oldRelaxLarge;
    delete process.env.GATEWAY_PREFERRED_ADAPTER;
    delete process.env.GATEWAY_PREFERRED_STRICT;
    jest.restoreAllMocks();
  });

  test('keeps strict preferred on large tasks even after process-like failure', async () => {
    const codexEntry = createAdapterEntry('codex', async () => {
      throw new Error('adapter codex queue timeout');
    });
    const relayEntry = createAdapterEntry('relay_api', async () => ({
      success: true,
      content: 'relay fallback',
      provider: 'relay_api',
      adapter: 'relay_api',
      attempts: [],
    }));
    gateway._adapters = [codexEntry, relayEntry];

    const chunks = [];
    const result = await gateway.generate('x'.repeat(1800), {
      preferredAdapter: 'codex',
      preferredStrict: true,
      strictPreferred: true,
      taskScale: 'large',
      onChunk: (chunk) => chunks.push(chunk),
    });

    expect(result.success).toBe(false);
    expect(codexEntry._generateMock).toHaveBeenCalledTimes(1);
    expect(relayEntry._generateMock).toHaveBeenCalledTimes(0);
    const statusTexts = chunks
      .filter(c => c && c.type === 'status')
      .map(c => String(c.text || ''));
    expect(statusTexts.some(s => s.includes('临时放宽 strict'))).toBe(false);
  });
});

