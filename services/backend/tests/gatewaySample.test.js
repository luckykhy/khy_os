'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('gateway sample command', () => {
  let logSpy;
  let originalHome;

  beforeEach(() => {
    originalHome = process.env.HOME;
    jest.resetModules();
    jest.restoreAllMocks();
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (logSpy) logSpy.mockRestore();
    jest.resetModules();
    jest.restoreAllMocks();
  });

  function mockBaseDeps() {
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

  test('sample helpers parse prompt injection and trace events from run directory', () => {
    mockBaseDeps();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-sample-helper-'));

    try {
      fs.writeFileSync(path.join(runDir, 'prompt.log'), [
        '[2026-05-31T00:00:00.000Z] adapter=codex provider="Codex CLI (mindflow)"',
        'system_preview=# Language KHY expected output: Simplified Chinese.',
        'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 你好',
        '',
      ].join('\n'), 'utf8');

      fs.writeFileSync(path.join(runDir, 'trace-events.jsonl'), [
        JSON.stringify({ type: 'llm.request', requestId: 'req-helper-1', data: { requestId: 'req-helper-1' } }),
        JSON.stringify({
          type: 'agent.language.first_chunk',
          requestId: 'req-helper-1',
          data: {
            detectedLanguage: 'zh',
            expectedLanguage: 'zh',
            matchesExpectation: true,
            source: 'first_chunk',
          },
        }),
        JSON.stringify({
          type: 'llm.response',
          requestId: 'req-helper-1',
          data: {
            success: true,
            errorType: null,
          },
        }),
      ].join('\n') + '\n', 'utf8');
      fs.writeFileSync(path.join(runDir, 'stdout.log'), '已收到\n', 'utf8');
      fs.writeFileSync(path.join(runDir, 'stderr.log'), '', 'utf8');

      const handler = require('../src/cli/handlers/gateway');
      const summary = handler.__test__._readGatewaySampleRunSummary(runDir);

      expect(summary).toMatchObject({
        runDir,
        requestId: 'req-helper-1',
        promptInjected: true,
        stdoutPreview: '已收到',
      });
      expect(summary.firstChunk).toMatchObject({
        detectedLanguage: 'zh',
        expectedLanguage: 'zh',
        matchesExpectation: true,
        source: 'first_chunk',
      });
      expect(summary.llmResponse).toMatchObject({
        success: true,
      });
      expect(summary.typeCounts).toEqual({
        'llm.request': 1,
        'agent.language.first_chunk': 1,
        'llm.response': 1,
      });

      const aggregate = handler.__test__._summarizeGatewaySampleCounts([
        summary,
        {
          promptInjected: true,
          firstChunk: null,
          llmResponse: { success: false, errorType: 'timeout' },
        },
      ]);
      expect(aggregate).toEqual({
        attempts: 2,
        promptInjectedCount: 2,
        firstChunkCount: 1,
        firstChunkZhCount: 1,
        firstChunkEnCount: 0,
        firstChunkAlignedCount: 1,
        timeoutCount: 1,
        successCount: 1,
        failureCount: 1,
      });
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  test('gateway sample returns aggregated json payload', async () => {
    mockBaseDeps();
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-sample-json-'));
    const realFs = jest.requireActual('fs');
    let callCount = 0;
    process.env.HOME = path.join(os.tmpdir(), 'khy-gateway-sample-home-json');

    jest.doMock('child_process', () => ({
      spawn: jest.fn(),
      spawnSync: jest.fn((_cmd, _args, options = {}) => {
        callCount += 1;
        const runDir = String(options.env.KHY_TRACE_AUDIT_DIR || '');
        realFs.mkdirSync(runDir, { recursive: true });
        realFs.writeFileSync(path.join(runDir, 'prompt.log'), [
          '[2026-05-31T00:00:00.000Z] adapter=codex provider="Codex CLI (mindflow)"',
          'system_preview=# Language KHY expected output: Simplified Chinese.',
          'prompt_preview=[KHY PRIORITY DIRECTIVE] USER: 你好',
          '',
        ].join('\n'), 'utf8');

        if (callCount === 1) {
          realFs.writeFileSync(path.join(runDir, 'trace-events.jsonl'), [
            JSON.stringify({ type: 'llm.request', requestId: 'req-sample-1', data: { requestId: 'req-sample-1' } }),
            JSON.stringify({
              type: 'agent.language.first_chunk',
              requestId: 'req-sample-1',
              data: {
                detectedLanguage: 'zh',
                expectedLanguage: 'zh',
                matchesExpectation: true,
                source: 'first_chunk',
              },
            }),
            JSON.stringify({
              type: 'llm.response',
              requestId: 'req-sample-1',
              data: {
                success: true,
                errorType: null,
              },
            }),
          ].join('\n') + '\n', 'utf8');
          return { status: 0, stdout: '已收到\n', stderr: '', signal: null, error: null };
        }

        realFs.writeFileSync(path.join(runDir, 'trace-events.jsonl'), [
          JSON.stringify({ type: 'llm.request', requestId: 'req-sample-2', data: { requestId: 'req-sample-2' } }),
          JSON.stringify({
            type: 'agent.language.final_response',
            requestId: 'req-sample-2',
            data: {
              detectedLanguage: 'zh',
              expectedLanguage: 'zh',
              matchesExpectation: true,
              source: 'final_response',
            },
          }),
          JSON.stringify({
            type: 'llm.response',
            requestId: 'req-sample-2',
            data: {
              success: false,
              errorType: 'timeout',
            },
          }),
        ].join('\n') + '\n', 'utf8');
        const err = new Error('spawnSync /opt/devenv/nodejs/bin/node EPERM');
        err.code = 'EPERM';
        return { status: 2, stdout: 'timeout\n', stderr: '', signal: null, error: err };
      }),
    }));

    try {
      const handler = require('../src/cli/handlers/gateway');
      await handler.handleGatewaySample(['codex'], {
        attempts: 2,
        json: true,
        dir: baseDir,
        prompt: '只用一句中文回复：已收到，不要调用工具。',
        timeoutMs: 5000,
      });

      const payload = JSON.parse(logSpy.mock.calls.map((call) => String(call[0] || '')).join(''));
      expect(payload.ok).toBe(true);
      expect(payload.adapter).toBe('codex');
      expect(payload.baseDir).toBe(baseDir);
      expect(payload.environment).toMatchObject({
        homeRisk: {
          homeDir: process.env.HOME,
          tmpDir: os.tmpdir(),
          isTempHome: true,
          hint: expect.stringContaining('位于临时目录'),
          recommendation: expect.stringContaining('建议改回真实用户主目录'),
        },
      });
      expect(payload.summary).toEqual({
        attempts: 2,
        promptInjectedCount: 2,
        firstChunkCount: 1,
        firstChunkZhCount: 1,
        firstChunkEnCount: 0,
        firstChunkAlignedCount: 1,
        timeoutCount: 1,
        successCount: 1,
        failureCount: 1,
      });
      expect(payload.runs).toHaveLength(2);
      expect(payload.runs[0]).toMatchObject({
        run: 'run-1',
        requestId: 'req-sample-1',
        promptInjected: true,
      });
      expect(payload.runs[1]).toMatchObject({
        run: 'run-2',
        requestId: 'req-sample-2',
        promptInjected: true,
        spawnError: '',
      });
      expect(payload.runs[1].llmResponse).toMatchObject({
        success: false,
        errorType: 'timeout',
      });
    } finally {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  test('router recognizes gateway sample as a sub-command', () => {
    const router = require('../src/cli/router');
    const parsed = router.parseInput('gateway sample codex --attempts 2 --timeout-ms 5000');

    expect(parsed).toMatchObject({
      command: 'gateway',
      subCommand: 'sample',
      args: ['codex'],
      options: {
        attempts: '2',
        'timeout-ms': '5000',
      },
    });
  });
});
