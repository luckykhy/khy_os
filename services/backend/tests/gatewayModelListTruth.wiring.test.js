'use strict';

/**
 * modelListTruth wiring — 「候选池 → 真值表」的接线证明。
 *
 * 用户报告:前端 TUI 的模型列表里频繁出现大量**真实不存在**的模型(静态目录里的
 * `claude-3.5-sonnet`、本机 IDE storage.json 被正则扫描出来的句子片段),选中即报错。
 *
 * 本条断言单一咽喉点 `_filterModelsByReliability`(TUI ModelPicker 与经典 CLI 选择器共用
 * buildGatewayModelChoices → 这里)确实跑了 modelListTruth:上游 remote 列表存在时,非权威
 * 来源被剔除、形态非法的被剔除,且**只**把 pass 下来的模型交给选择器。
 */

describe('gateway model list truth wiring', () => {
  const originalInTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const originalOutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  let originalPreferredAdapter;
  let originalStrict;

  beforeEach(() => {
    originalPreferredAdapter = process.env.GATEWAY_PREFERRED_ADAPTER;
    originalStrict = process.env.KHY_MODEL_STRICT_ADAPTERS;
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
    if (originalPreferredAdapter === undefined) delete process.env.GATEWAY_PREFERRED_ADAPTER;
    else process.env.GATEWAY_PREFERRED_ADAPTER = originalPreferredAdapter;
    if (originalStrict === undefined) delete process.env.KHY_MODEL_STRICT_ADAPTERS;
    else process.env.KHY_MODEL_STRICT_ADAPTERS = originalStrict;
    delete process.env.KHY_MODEL_LIST_TRUTH;
  });

  test('windsurf:有上游 remote 列表时,静态目录 / 本机扫描 / 句子片段全部不进选择器', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    process.env.KHY_MODEL_STRICT_ADAPTERS = 'windsurf';

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const syncModelSwitch = jest.fn();
    const gatewayMock = {
      _initialized: true,
      isInitialized() { return this._initialized; },
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'windsurf', name: 'Windsurf', enabled: true, available: true, detail: 'ok' },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 8 },
        generation: { success: true, latencyMs: 12 },
        models: { success: true, latencyMs: 5, count: 2 },
      })),
      listModels: jest.fn(async () => ([
        // ── 猜测(静态硬编码目录)──
        { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: false, discoverySource: 'builtin' },
        { id: 'kimi2.6', name: 'Kimi2.6', isDefault: false, discoverySource: 'builtin' },
        // ── 猜测(本机 storage.json 正则扫描拾取)──
        { id: 'claude sonnet3.5', name: 'claude sonnet3.5', isDefault: false, discoverySource: 'local' },
        { id: 'swe-1.6-m1.5', name: 'SWE-1.6 M1.5', isDefault: false, discoverySource: 'local' },
        // ── 事实(上游亲口返回)──
        { id: 'gpt-4o', name: 'gpt-4o', isDefault: true, discoverySource: 'remote' },
        { id: 'gpt-4o-mini', name: 'gpt-4o-mini', isDefault: false, discoverySource: 'remote' },
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
      truncateToWidth: (s, w) => String(s).slice(0, w),
      displayWidth: (s) => String(s).length,
      padToWidth: (s) => String(s),
      stripAnsi: (s) => String(s),
      safeTerminalString: (s) => String(s),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewaySelectModel([], {});

    // 选择器只拿到「事实」:默认模型 gpt-4o 被选中。
    expect(syncModelSwitch).toHaveBeenCalledWith('gpt-4o');
    expect(printSuccess).toHaveBeenCalledWith('已选择: gpt-4o (windsurf)');

    // 猜测条目绝不出现。
    const printed = printInfo.mock.calls.map((c) => String(c[0])).join('\n');
    for (const junk of ['claude-3.5-sonnet', 'kimi2.6', 'swe-1.6-m1.5', 'claude sonnet3.5']) {
      expect(printed).not.toContain(junk);
      expect(printSuccess).not.toHaveBeenCalledWith(expect.stringContaining(junk));
    }
  });

  test('门控关闭(KHY_MODEL_LIST_TRUTH=off)→ 逐字节回退,猜测条目仍在列表里', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    process.env.KHY_MODEL_STRICT_ADAPTERS = 'windsurf';
    process.env.KHY_MODEL_LIST_TRUTH = 'off';

    const printSuccess = jest.fn();
    const printError = jest.fn();
    const printInfo = jest.fn();
    const printTable = jest.fn();

    const syncModelSwitch = jest.fn();
    const gatewayMock = {
      _initialized: true,
      isInitialized() { return this._initialized; },
      init: jest.fn(async () => {}),
      getStatus: jest.fn(() => ([
        { type: 'windsurf', name: 'Windsurf', enabled: true, available: true, detail: 'ok' },
      ])),
      testAdapter: jest.fn(async () => ({
        connectivity: { success: true, latencyMs: 8 },
        generation: { success: true, latencyMs: 12 },
        models: { success: true, latencyMs: 5, count: 2 },
      })),
      listModels: jest.fn(async () => ([
        { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', isDefault: true, discoverySource: 'builtin' },
        { id: 'gpt-4o', name: 'gpt-4o', isDefault: false, discoverySource: 'remote' },
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
      truncateToWidth: (s, w) => String(s).slice(0, w),
      displayWidth: (s) => String(s).length,
      padToWidth: (s) => String(s),
      stripAnsi: (s) => String(s),
      safeTerminalString: (s) => String(s),
    }));
    jest.doMock('../src/services/gateway/aiGateway', () => gatewayMock);

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewaySelectModel([], {});

    // 关门前 builtin 那条(且是 isDefault)仍在 —— 历史行为不变。
    expect(syncModelSwitch).toHaveBeenCalledWith('claude-3.5-sonnet');
    expect(printSuccess).toHaveBeenCalledWith('已选择: claude-3.5-sonnet (windsurf)');
  });
});
