'use strict';

describe('gateway model selection strict probe', () => {
  const originalInTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalOutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  let originalPreferredAdapter;

  beforeEach(() => {
    originalPreferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
  });

  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
    if (originalInTTY) {
      Object.defineProperty(process.stdin, 'isTTY', originalInTTY);
    } else {
      delete process.stdin.isTTY;
    }
    if (originalOutTTY) {
      Object.defineProperty(process.stdout, 'isTTY', originalOutTTY);
    } else {
      delete process.stdout.isTTY;
    }
    delete process.env.KHY_MODEL_STRICT_ADAPTERS;
    delete process.env.KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS;
    if (originalPreferredAdapter === undefined) delete process.env.GATEWAY_PREFERRED_ADAPTER;
    else process.env.GATEWAY_PREFERRED_ADAPTER = originalPreferredAdapter;
  });

  test('filters strict adapters when generation probe fails', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    process.env.KHY_MODEL_STRICT_ADAPTERS = 'localllm,codex,claude';

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const testAdapter = jest.fn(async (adapterKey, opts = {}) => ({
      connectivity: { success: true, latencyMs: 6 },
      generation: { success: false, latencyMs: 18, error: `${adapterKey} probe failed` },
      models: { success: true, latencyMs: 3, count: 1 },
      _opts: opts,
    }));

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'localLLM', name: '本地模型', enabled: true, available: true, detail: 'ok' },
        { type: 'codex', name: 'OpenAI Codex', enabled: true, available: true, detail: 'ok' },
      ])),
      testAdapter,
      listModels: jest.fn(async () => ([
        { id: 'm1', name: 'm1', isDefault: true },
      ])),
      refreshAdapters: jest.fn(async () => {}),
    };

    jest.doMock('../src/cli/formatters', () => ({
      printSuccess,
      printError,
      printInfo,
      printTable,
      ICON_GATEWAY: 'G',
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewaySelectModel([], {});

    expect(printInfo).toHaveBeenCalledWith('当前无可执行模型可选（已过滤未通过实测的通道）');
    const localCall = testAdapter.mock.calls.find(c => c[0] === 'localLLM');
    const codexCall = testAdapter.mock.calls.find(c => c[0] === 'codex');
    expect(localCall).toBeTruthy();
    expect(codexCall).toBeTruthy();
    expect(localCall[1].quick).toBe(false);
    expect(codexCall[1].quick).toBe(false);
    expect(localCall[1].probeGenerationTimeoutMs).toBeGreaterThan(0);
    expect(codexCall[1].probeGenerationTimeoutMs).toBeGreaterThan(0);
  });

  test('hides claude-* models under codex in /model selection', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    process.env.KHY_MODEL_STRICT_ADAPTERS = 'codex';

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const syncModelSwitch = jest.fn();
    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok' },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 8 },
        generation: { success: true, latencyMs: 12 },
        models: { success: true, latencyMs: 5, count: 2 },
      })),
      listModels: jest.fn(async () => ([
        { id: 'claude-opus-4-7', name: 'claude-opus-4-7', isDefault: false, discoverySource: 'remote' },
        { id: 'gpt-5.3-codex-review', name: 'gpt-5.3-codex-review', isDefault: true, discoverySource: 'remote' },
      ])),
      syncModelSwitch,
      refreshAdapters: jest.fn(async () => {}),
    };

    jest.doMock('../src/cli/formatters', () => ({
      printSuccess,
      printError,
      printInfo,
      printTable,
      ICON_GATEWAY: 'G',
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewaySelectModel([], {});

    expect(syncModelSwitch).toHaveBeenCalledWith('gpt-5.3-codex-review');
    expect(printSuccess).toHaveBeenCalledWith('已选择: gpt-5.3-codex-review (codex)');
    expect(printSuccess).not.toHaveBeenCalledWith(expect.stringContaining('claude-opus-4-7'));
  });

  test('prints invalid preferred adapter hint in /model selection', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    process.env.KHY_MODEL_STRICT_ADAPTERS = 'codex';
    process.env.GATEWAY_PREFERRED_ADAPTER = '__missing__';

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const gatewayMock = {
      _initialized: true,
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'codex', name: 'Codex CLI', enabled: true, available: true, detail: 'ok' },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 8 },
        generation: { success: true, latencyMs: 12 },
        models: { success: true, latencyMs: 5, count: 1 },
      })),
      listModels: jest.fn(async () => ([
        { id: 'gpt-5.3-codex-review', name: 'gpt-5.3-codex-review', isDefault: true, discoverySource: 'remote' },
      ])),
      syncModelSwitch: jest.fn(),
      refreshAdapters: jest.fn(async () => {}),
    };

    jest.doMock('../src/cli/formatters', () => ({
      printSuccess,
      printError,
      printInfo,
      printTable,
      ICON_GATEWAY: 'G',
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewaySelectModel([], {});

    expect(printError).toHaveBeenCalledWith('首选通道配置错误: "__missing__" 未注册');
    expect(printInfo).toHaveBeenCalledWith('当前将忽略该无效配置，并仅展示可执行通道');
    expect(printSuccess).toHaveBeenCalledWith('已选择: gpt-5.3-codex-review (codex)');
  });
});
