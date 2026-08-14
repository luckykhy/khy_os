'use strict';

describe('gateway debug prompt command', () => {
  let originalEnv;
  let logSpy;

  beforeEach(() => {
    originalEnv = { ...process.env };
    jest.resetModules();
    jest.restoreAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.env = originalEnv;
    if (logSpy) logSpy.mockRestore();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function mockBaseDeps({ exists = true, filePath = '/tmp/khy_prompt_debug.log', content = '' } = {}) {
    const realFs = jest.requireActual('fs');
    jest.doMock('fs', () => ({
      ...realFs,
      existsSync: jest.fn((targetPath) => String(targetPath || '') === filePath ? exists : realFs.existsSync(targetPath)),
      readFileSync: jest.fn((targetPath, encoding) => {
        if (String(targetPath || '') === filePath) return content;
        return realFs.readFileSync(targetPath, encoding);
      }),
      writeFileSync: jest.fn((targetPath, data, encoding) => {
        if (String(targetPath || '') === filePath) return;
        return realFs.writeFileSync(targetPath, data, encoding);
      }),
      mkdirSync: jest.fn(() => {}),
    }));

    jest.doMock('../src/utils/dataHome', () => ({
      getDataHome: () => '/tmp/khy-data-home',
      getLegacyDataHome: () => '/tmp/khy-data-home-legacy',
    }));

    jest.doMock('../src/cli/formatters', () => ({
      printSuccess: jest.fn(),
      printError: jest.fn(),
      printInfo: jest.fn(),
      printTable: jest.fn(),
      ICON_GATEWAY: 'G',
      stripAnsi: (s) => String(s || ''),
      displayWidth: (s) => String(s || '').length,
      padToWidth: (s, width) => {
        const text = String(s || '');
        const safeWidth = Math.max(0, Number(width) || 0);
        return text.length >= safeWidth ? text : `${text}${' '.repeat(safeWidth - text.length)}`;
      },
      truncateToWidth: (s, width) => {
        const text = String(s || '');
        const safeWidth = Math.max(0, Number(width) || 0);
        return text.length > safeWidth ? text.slice(0, safeWidth) : text;
      },
      safeTerminalString: (s) => String(s || ''),
    }));
  }

  test('prints recent KHY prompt injection records', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT = '1';
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: [
        '[2026-05-30T01:02:03.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=128 prompt_length=512',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 你好',
        '',
        '[2026-05-30T02:03:04.000Z] adapter=api provider="API 池"',
        'has_system=1 system_length=144 prompt_length=640',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 再测一次',
        '',
      ].join('\n'),
    });

    const { printInfo } = require('../src/cli/formatters');
    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayDebugPrompt([], { tail: 1 });

    expect(printInfo).toHaveBeenCalledWith('KHY prompt 调试状态: 调试开关=已开启，日志路径=已找到，累计请求=2');
    expect(printInfo).toHaveBeenCalledWith('正在展示最近 1/2 条 KHY 注入记录');

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('api');
    expect(output).toContain('prompt_preview: [KHY PRIORITY DIRECTIVE] USER: 再测一次');
    expect(output).not.toContain('USER: 你好');
  });

  test('returns JSON payload and clears debug log', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: [
        '[2026-05-30T01:02:03.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=128 prompt_length=512',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 你好',
        '',
      ].join('\n'),
    });

    const fsMock = require('fs');
    const handler = require('../src/cli/handlers/gateway');

    await handler.handleGatewayDebugPrompt([], { json: true });
    const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    expect(payload.entriesCount).toBe(1);
    expect(payload.entries[0]).toMatchObject({
      adapter: 'codex',
      provider: 'Codex CLI',
      hasSystem: true,
      systemLength: 128,
      promptLength: 512,
    });

    logSpy.mockClear();
    await handler.handleGatewayDebugPrompt(['clear'], { json: true });
    const cleared = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    expect(cleared).toEqual({
      ok: true,
      cleared: true,
      file: '/tmp/khy_prompt_debug.log',
    });
    expect(fsMock.mkdirSync).toHaveBeenCalledWith('/tmp', { recursive: true });
    expect(fsMock.writeFileSync).toHaveBeenCalledWith('/tmp/khy_prompt_debug.log', '', 'utf8');
  });

  test('returns JSON help payload when help action is requested in machine-readable mode', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: false,
      filePath: '/tmp/khy_prompt_debug.log',
      content: '',
    });

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayDebugPrompt(['help'], { json: true });

    const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
    expect(payload).toMatchObject({
      ok: true,
      action: 'help',
      command: 'gateway debug-prompt',
      usage: 'gateway debug-prompt [show|live|clear] [--tail 5] [--adapter codex] [--capsules] [--why-full] [--json] [--file /path/to/log]',
    });
    expect(typeof payload.recommendedCommand).toBe('string');
    expect(payload.recommendedCommand).toContain('khy gateway status');
  });

  test('snapshot helper returns latest record summary', () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: [
        '[2026-05-30T01:02:03.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=128 prompt_length=512',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第一条',
        '',
        '[2026-05-30T02:03:04.000Z] adapter=api provider="API 池"',
        'has_system=1 system_length=144 prompt_length=640',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第二条',
        '',
      ].join('\n'),
    });

    const handler = require('../src/cli/handlers/gateway');
    const snapshot = handler.getGatewayDebugPromptSnapshot({ tail: 1 });

    expect(snapshot).toMatchObject({
      ok: true,
      file: '/tmp/khy_prompt_debug.log',
      exists: true,
      entriesCount: 2,
      showing: 1,
    });
    expect(snapshot.latest).toMatchObject({
      adapter: 'api',
      provider: 'API 池',
      promptLength: 640,
      promptPreview: '[KHY PRIORITY DIRECTIVE] USER: 第二条',
    });
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0].adapter).toBe('api');
  });

  test('filters snapshot and output by adapter', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT = '1';
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: [
        '[2026-05-30T01:02:03.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=128 prompt_length=512',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第一条 codex',
        '',
        '[2026-05-30T02:03:04.000Z] adapter=api provider="API 池"',
        'has_system=1 system_length=144 prompt_length=640',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第二条 api',
        '',
        '[2026-05-30T03:04:05.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=156 prompt_length=704',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第三条 codex',
        '',
      ].join('\n'),
    });

    const { printInfo } = require('../src/cli/formatters');
    const handler = require('../src/cli/handlers/gateway');

    const snapshot = handler.getGatewayDebugPromptSnapshot({ tail: 5, adapter: 'codex' });
    expect(snapshot).toMatchObject({
      adapterFilter: 'codex',
      totalEntriesCount: 3,
      entriesCount: 2,
      showing: 2,
    });
    expect(snapshot.latest).toMatchObject({
      adapter: 'codex',
      promptPreview: '[KHY PRIORITY DIRECTIVE] USER: 第三条 codex',
    });
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.entries.every((entry) => entry.adapter === 'codex')).toBe(true);

    await handler.handleGatewayDebugPrompt([], { tail: 5, adapter: 'codex' });

    expect(printInfo).toHaveBeenCalledWith('KHY prompt 调试状态: 调试开关=已开启，日志路径=已找到，累计请求=2（adapter=codex，原始总计 3 条）');
    expect(printInfo).toHaveBeenCalledWith('正在展示最近 2/2 条 KHY 注入记录（adapter=codex，原始总计 3 条）');

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('第一条 codex');
    expect(output).toContain('第三条 codex');
    expect(output).not.toContain('第二条 api');
  });

  test('live mode prints new records detected during polling', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    const initialContent = [
      '[2026-05-30T01:02:03.000Z] adapter=codex provider="Codex CLI"',
      'has_system=1 system_length=128 prompt_length=512',
      'system_preview=# KHY Protocol Priority',
      'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第一条',
      '',
    ].join('\n');
    const updatedContent = [
      initialContent,
      '[2026-05-30T02:03:04.000Z] adapter=api provider="API 池"',
      'has_system=1 system_length=144 prompt_length=640',
      'system_preview=# KHY Protocol Priority',
      'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第二条',
      '',
    ].join('\n');

    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: initialContent,
    });

    const actualFs = jest.requireActual('fs');
    const fsMock = require('fs');
    let readCount = 0;
    fsMock.readFileSync.mockImplementation((targetPath, encoding) => {
      if (String(targetPath || '') === '/tmp/khy_prompt_debug.log') {
        readCount += 1;
        // Read #1 is the baseline snapshot; read #2 is the first poll round.
        // Release the updated content on the first poll so detection lands at round 1/2.
        return readCount >= 2 ? updatedContent : initialContent;
      }
      return actualFs.readFileSync(targetPath, encoding);
    });

    const { printInfo } = require('../src/cli/formatters');
    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayDebugPrompt(['live'], { tail: 1, interval: 0, cycles: 2 });

    expect(printInfo).toHaveBeenCalledWith('实时监听方式: 执行 2 次轮询后退出');
    expect(printInfo).toHaveBeenCalledWith('检测到新的 KHY 注入记录（新增 1 条，第 1/2 次轮询，累计 2 条）');
    expect(printInfo).toHaveBeenCalledWith('KHY prompt 实时监听已完成（轮询 2 次，累计 2 条记录）');

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('prompt_preview: [KHY PRIORITY DIRECTIVE] USER: 第二条');
  });

  test('live mode respects adapter filter when detecting new records', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    const initialContent = [
      '[2026-05-30T01:02:03.000Z] adapter=codex provider="Codex CLI"',
      'has_system=1 system_length=128 prompt_length=512',
      'system_preview=# KHY Protocol Priority',
      'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第一条 codex',
      '',
    ].join('\n');
    const updatedContent = [
      initialContent,
      '[2026-05-30T02:03:04.000Z] adapter=api provider="API 池"',
      'has_system=1 system_length=144 prompt_length=640',
      'system_preview=# KHY Protocol Priority',
      'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第二条 api',
      '',
      '[2026-05-30T03:04:05.000Z] adapter=codex provider="Codex CLI"',
      'has_system=1 system_length=156 prompt_length=704',
      'system_preview=# KHY Protocol Priority',
      'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 第三条 codex',
      '',
    ].join('\n');

    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: initialContent,
    });

    const actualFs = jest.requireActual('fs');
    const fsMock = require('fs');
    let readCount = 0;
    fsMock.readFileSync.mockImplementation((targetPath, encoding) => {
      if (String(targetPath || '') === '/tmp/khy_prompt_debug.log') {
        readCount += 1;
        // Read #1 is the baseline snapshot; read #2 is the first poll round.
        // Release the updated content on the first poll so detection lands at round 1/2.
        return readCount >= 2 ? updatedContent : initialContent;
      }
      return actualFs.readFileSync(targetPath, encoding);
    });

    const { printInfo } = require('../src/cli/formatters');
    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayDebugPrompt(['live'], { tail: 5, interval: 0, cycles: 2, adapter: 'codex' });

    expect(printInfo).toHaveBeenCalledWith('实时监听方式: 执行 2 次轮询后退出');
    expect(printInfo).toHaveBeenCalledWith('检测到新的 KHY 注入记录（新增 1 条，第 1/2 次轮询，累计匹配 2 条，原始总计 3 条）');
    expect(printInfo).toHaveBeenCalledWith('KHY prompt 实时监听已完成（轮询 2 次，累计匹配 2 条记录，原始总计 3 条）');

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('第三条 codex');
    expect(output).not.toContain('第二条 api');
  });

  test('shows prompt capsules when --capsules is enabled', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT = '1';
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: [
        '[2026-06-01T01:02:03.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=256 prompt_length=1024',
        'capsule_mode=on_demand prompt_capsules="planning_verification,file_operations,command_execution" capsule_reasons="task_scale=medium,file_keywords,command_keywords"',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 修复登录 bug 并运行测试',
        '',
      ].join('\n'),
    });

    const handler = require('../src/cli/handlers/gateway');
    const snapshot = handler.getGatewayDebugPromptSnapshot({ tail: 1 });
    expect(snapshot.latest).toMatchObject({
      capsuleMode: 'on_demand',
      promptCapsules: ['planning_verification', 'file_operations', 'command_execution'],
      capsuleReasons: ['task_scale=medium', 'file_keywords', 'command_keywords'],
    });

    await handler.handleGatewayDebugPrompt([], { tail: 1, capsules: true });
    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('capsule_mode: on_demand');
    expect(output).toContain('prompt_capsules: planning_verification, file_operations, command_execution');
    expect(output).toContain('capsule_reasons: task_scale=medium, file_keywords, command_keywords');
  });

  test('shows why_full when fallback mode is requested', async () => {
    process.env.KHY_GATEWAY_DEBUG_PROMPT = '1';
    process.env.KHY_GATEWAY_DEBUG_PROMPT_FILE = '/tmp/khy_prompt_debug.log';
    mockBaseDeps({
      exists: true,
      filePath: '/tmp/khy_prompt_debug.log',
      content: [
        '[2026-06-01T01:02:03.000Z] adapter=codex provider="Codex CLI"',
        'has_system=1 system_length=256 prompt_length=1024',
        'capsule_mode=continuation_fallback prompt_capsules="planning_verification,file_operations" capsule_reasons="continuation_turn,task_scale=medium"',
        'system_preview=# KHY Protocol Priority',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 继续修复登录 bug',
        '',
      ].join('\n'),
    });

    const handler = require('../src/cli/handlers/gateway');
    await handler.handleGatewayDebugPrompt([], { tail: 1, whyFull: true });

    const output = logSpy.mock.calls.map((call) => String(call[0] || '')).join('\n');
    expect(output).toContain('why_full: continuation_turn');
    expect(output).not.toContain('why_full: task_scale=medium');
  });
});
