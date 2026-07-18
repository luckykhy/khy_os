'use strict';

// Mock heavy dependencies that router.js lazy-loads
jest.mock('chalk', () => {
  const fn = (...args) => args.join(' ');
  fn.bold = fn; fn.dim = fn; fn.cyan = fn; fn.red = fn; fn.green = fn;
  fn.yellow = fn; fn.blue = fn; fn.white = fn; fn.hex = () => fn;
  fn.default = fn;
  return fn;
});

jest.mock('../../src/cli/formatters', () => ({
  printSuccess: jest.fn(),
  printError: jest.fn(),
  printWarn: jest.fn(),
  printInfo: jest.fn(),
  printHelp: jest.fn(),
  printTable: jest.fn(),
  printQuote: jest.fn(),
  displayWidth: (s) => s.length,
  padToWidth: (s, w) => s.padEnd(w),
  stripAnsi: (s) => s,
  ICON_PROMPT: '>',
  ICON_AI: '*',
  getRandomFarewell: () => 'bye',
}));

jest.mock('../../src/cli/ai', () => ({
  listConversations: jest.fn(() => []),
  findConversationByRef: jest.fn(() => null),
  resumeConversation: jest.fn(() => ({ success: false })),
  resumePersistedSession: jest.fn(() => ({ success: false, error: 'NOT_FOUND' })),
  resumeLastPersistedSession: jest.fn(() => ({ success: false, error: 'EMPTY' })),
  getConversation: jest.fn(() => []),
}));

jest.mock('../../src/services/imageService', () => ({
  writeClipboardText: jest.fn(() => true),
}));

jest.mock('../../src/services/ollamaModelManager', () => ({
  isOllamaRunning: jest.fn(),
  listModels: jest.fn(),
  importModel: jest.fn(),
}));

jest.mock('../../src/cli/handlers/config', () => ({
  _writeEnvPatch: jest.fn(() => '/tmp/test-models.env'),
}));

jest.mock('../../src/services/gateway/aiGateway', () => ({
  refreshAdapters: jest.fn(),
}));

jest.mock('../../src/cli/handlers/gateway', () => ({
  handleGatewayConfig: jest.fn(async () => true),
  handleGatewayDetect: jest.fn(async () => true),
  handleGatewayPreferRemote: jest.fn(async () => ({
    switched: false,
    reason: 'mocked',
  })),
  handleGatewayKey: jest.fn(async () => true),
  handleGatewayTest: jest.fn(async () => true),
  handleGatewayDiscoverModels: jest.fn(async () => true),
}));

// Suppress console output
beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterAll(() => {
  console.log.mockRestore();
  console.warn.mockRestore();
});

const router = require('../../src/cli/router');
const aiMock = require('../../src/cli/ai');
const ollamaMgr = require('../../src/services/ollamaModelManager');
const configHandler = require('../../src/cli/handlers/config');
const aiGateway = require('../../src/services/gateway/aiGateway');
const gatewayHandler = require('../../src/cli/handlers/gateway');
const imageServiceMock = require('../../src/services/imageService');

describe('router', () => {
  describe('module exports', () => {
    test('exports parseInput function', () => {
      expect(typeof router.parseInput).toBe('function');
    });

    test('exports route function', () => {
      expect(typeof router.route).toBe('function');
    });

    test('exports getCompletions function', () => {
      expect(typeof router.getCompletions).toBe('function');
    });

    test('exports COMMANDS array', () => {
      expect(Array.isArray(router.COMMANDS)).toBe(true);
      expect(router.COMMANDS.length).toBeGreaterThan(0);
    });

    test('exports SLASH_COMMANDS array', () => {
      expect(Array.isArray(router.SLASH_COMMANDS)).toBe(true);
    });
  });

  describe('COMMANDS', () => {
    test('includes core commands', () => {
      expect(router.COMMANDS).toContain('quote');
      expect(router.COMMANDS).toContain('backtest');
      expect(router.COMMANDS).toContain('gateway');
      expect(router.COMMANDS).toContain('help');
      expect(router.COMMANDS).toContain('exit');
    });
  });

  describe('parseInput()', () => {
    test('parses a simple command', () => {
      const result = router.parseInput('quote sh600519');
      expect(result).toBeDefined();
      expect(typeof result).toBe('object');
    });

    test('returns an object with command field', () => {
      const result = router.parseInput('help');
      expect(result).toHaveProperty('command');
    });

    test('handles empty input gracefully', () => {
      const result = router.parseInput('');
      expect(result).toBeDefined();
    });

    test('handles slash commands', () => {
      const result = router.parseInput('/help');
      expect(result).toBeDefined();
    });

    test('parses /ulw-loop and keeps task args', () => {
      const result = router.parseInput('/ulw-loop fix gateway retries');
      expect(result).toBeDefined();
      expect(result.command).toBe('ulw-loop');
      expect(result.args.join(' ')).toBe('fix gateway retries');
    });

    test('handles flags like --port 3000', () => {
      const result = router.parseInput('server start --port 3000');
      expect(result).toBeDefined();
      expect(result.command).toBe('server');
    });

    test('parses config set as command + subcommand', () => {
      const result = router.parseInput('config set model.provider custom');
      expect(result).toBeDefined();
      expect(result.command).toBe('config');
      expect(result.subCommand).toBe('set');
      expect(result.args).toEqual(['model.provider', 'custom']);
    });

    test('parses config openclaw with non-interactive flags', () => {
      const result = router.parseInput('config openclaw --custom-base-url https://token.sensenova.cn/v1 --custom-model-id qwen-max');
      expect(result).toBeDefined();
      expect(result.command).toBe('config');
      expect(result.subCommand).toBe('openclaw');
      expect(result.options['custom-base-url']).toBe('https://token.sensenova.cn/v1');
      expect(result.options['custom-model-id']).toBe('qwen-max');
    });

    test('parses config opencode flags', () => {
      const result = router.parseInput('config opencode --base-url https://token.sensenova.cn/v1 --model-id qwen-max');
      expect(result).toBeDefined();
      expect(result.command).toBe('config');
      expect(result.subCommand).toBe('opencode');
      expect(result.options['base-url']).toBe('https://token.sensenova.cn/v1');
      expect(result.options['model-id']).toBe('qwen-max');
    });

    test('parses gateway debug-prompt help as a real subcommand', () => {
      const result = router.parseInput('gateway debug-prompt help --json');
      expect(result).toBeDefined();
      expect(result.command).toBe('gateway');
      expect(result.subCommand).toBe('debug-prompt');
      expect(result.args).toEqual(['help']);
      expect(result.options.json).toBe(true);
    });

    test('bare-keyword alias does not clobber an explicit sub-command', () => {
      // The `runtime` keyword is a status-only alias (subCommand: 'status').
      // An explicit, valid sub-command typed after it must survive — otherwise
      // `runtime verify` / `runtime install` would silently fall back to status.
      const verify = router.parseInput('runtime verify');
      expect(verify.command).toBe('runtime');
      expect(verify.subCommand).toBe('verify');

      const install = router.parseInput('runtime install ollama-runner');
      expect(install.command).toBe('runtime');
      expect(install.subCommand).toBe('install');
      expect(install.args).toEqual(['ollama-runner']);
    });

    test('bare alias still applies its default sub-command when none is typed', () => {
      const bare = router.parseInput('runtime');
      expect(bare.command).toBe('runtime');
      expect(bare.subCommand).toBe('status');
    });

    test('trace command + sub-commands parse (DESIGN-ARCH-047 P5)', () => {
      const show = router.parseInput('trace');
      expect(show.command).toBe('trace');
      // bare `trace` has no typed sub; handler defaults to show
      expect(show.subCommand).toBeNull();

      const verify = router.parseInput('trace verify p5-good');
      expect(verify.command).toBe('trace');
      expect(verify.subCommand).toBe('verify');
      expect(verify.args).toEqual(['p5-good']);

      const list = router.parseInput('trace list');
      expect(list.command).toBe('trace');
      expect(list.subCommand).toBe('list');
    });

    test('trace aliases 轨迹/gj resolve, and 轨迹 verify is not clobbered', () => {
      const cn = router.parseInput('轨迹');
      expect(cn.command).toBe('trace');
      expect(cn.subCommand).toBe('show');

      const gj = router.parseInput('gj');
      expect(gj.command).toBe('trace');
      expect(gj.subCommand).toBe('show');

      // explicit valid sub typed after the bare alias must survive
      const cnVerify = router.parseInput('轨迹 verify');
      expect(cnVerify.command).toBe('trace');
      expect(cnVerify.subCommand).toBe('verify');
    });

    test('parses argv arrays without splitting spaced option values', () => {
      const result = router.parseInput([
        'gateway',
        'add',
        '--name', 'Example Provider',
        '--pool-key', 'example-provider',
        '--base-url', 'https://api.example.com/v1',
        '--api-key', 'sk-test-1234567890123456',
        '--model-id', 'example-chat',
        '--json',
      ]);
      expect(result).toBeDefined();
      expect(result.command).toBe('gateway');
      expect(result.subCommand).toBe('add');
      expect(result.args).toEqual([]);
      expect(result.options.name).toBe('Example Provider');
      expect(result.options['pool-key']).toBe('example-provider');
      expect(result.options['base-url']).toBe('https://api.example.com/v1');
      expect(result.options['api-key']).toBe('sk-test-1234567890123456');
      expect(result.options['model-id']).toBe('example-chat');
      expect(result.options.json).toBe(true);
    });

    test('parses resume with session id token', () => {
      const result = router.parseInput('resume 019e33c8-2378-7830-aead-66bb6d72fa0d');
      expect(result).toBeDefined();
      expect(result.command).toBe('history');
      expect(result.subCommand).toBe('resume');
      expect(result.args).toEqual(['019e33c8-2378-7830-aead-66bb6d72fa0d']);
    });

    test('parses publish pip-dir-bundle subcommand', () => {
      const result = router.parseInput('publish pip-dir-bundle --out /tmp/out');
      expect(result).toBeDefined();
      expect(result.command).toBe('publish');
      expect(result.subCommand).toBe('pip-dir-bundle');
      expect(result.options.out).toBe('/tmp/out');
    });

    test('parses publish git-push with platform/repo options', () => {
      const result = router.parseInput('publish git-push --platform gitlab --repo group/demo');
      expect(result).toBeDefined();
      expect(result.command).toBe('publish');
      expect(result.subCommand).toBe('git-push');
      expect(result.options.platform).toBe('gitlab');
      expect(result.options.repo).toBe('group/demo');
    });

    test('parses publish origin-code subcommand', () => {
      const result = router.parseInput('publish origin-code --out /tmp/origin-code');
      expect(result).toBeDefined();
      expect(result.command).toBe('publish');
      expect(result.subCommand).toBe('origin-code');
      expect(result.options.out).toBe('/tmp/origin-code');
    });

    test('parses publish origin-code secret option', () => {
      const result = router.parseInput('publish origin-code --secret khy2026');
      expect(result).toBeDefined();
      expect(result.command).toBe('publish');
      expect(result.subCommand).toBe('origin-code');
      expect(result.options.secret).toBe('khy2026');
    });

    test('parses publish npm-dir-bundle subcommand', () => {
      const result = router.parseInput('publish npm-dir-bundle --out /tmp/npm-bundle');
      expect(result).toBeDefined();
      expect(result.command).toBe('publish');
      expect(result.subCommand).toBe('npm-dir-bundle');
      expect(result.options.out).toBe('/tmp/npm-bundle');
    });
  });

  describe('getCompletions()', () => {
    test('returns an array', () => {
      const completions = router.getCompletions('qu');
      expect(Array.isArray(completions)).toBe(true);
    });

    test('returns completions matching the prefix', () => {
      const completions = router.getCompletions('gate');
      expect(completions.some(c => c.startsWith('gate'))).toBe(true);
    });

    test('returns empty or all for empty string', () => {
      const completions = router.getCompletions('');
      expect(Array.isArray(completions)).toBe(true);
    });
  });

  describe('route()', () => {
    beforeEach(() => {
      aiMock.listConversations.mockReset();
      aiMock.findConversationByRef.mockReset();
      aiMock.resumeConversation.mockReset();
      aiMock.resumePersistedSession.mockReset();
      aiMock.resumeLastPersistedSession.mockReset();
      aiMock.listConversations.mockReturnValue([]);
      aiMock.findConversationByRef.mockReturnValue(null);
      aiMock.resumeConversation.mockReturnValue({ success: false });
      // Default: Store B miss, so tests exercising the legacy summary store
      // fall through unless they opt into a Store B hit.
      aiMock.resumePersistedSession.mockReturnValue({ success: false, error: 'NOT_FOUND' });
      aiMock.resumeLastPersistedSession.mockReturnValue({ success: false, error: 'EMPTY' });
    });

    test('ulw-loop forwards ultrawork prompt to AI', async () => {
      const parsed = router.parseInput('ulw-loop stabilize this workflow');
      const result = await router.route(parsed, {});
      expect(result).toBeDefined();
      expect(typeof result.aiForward).toBe('string');
      expect(result.aiForward).toContain('ultrawork');
      expect(result.aiForward).toContain('stabilize this workflow');
    });

    test('resume supports session id token', async () => {
      aiMock.listConversations.mockReturnValue([
        {
          file: '2026-05-17T12-34-56-abcd.json',
          sessionId: '019e33c8-2378-7830-aead-66bb6d72fa0d',
          timestamp: '2026-05-17T12:34:56.000Z',
          messageCount: 12,
        },
      ]);
      aiMock.findConversationByRef.mockReturnValue({
        file: '2026-05-17T12-34-56-abcd.json',
        sessionId: '019e33c8-2378-7830-aead-66bb6d72fa0d',
        timestamp: '2026-05-17T12:34:56.000Z',
        messageCount: 12,
      });
      aiMock.resumeConversation.mockReturnValue({
        success: true,
        messageCount: 4,
        originalCount: 12,
        compacted: true,
        timestamp: '2026-05-17T12:34:56.000Z',
      });

      const parsed = router.parseInput('resume 019e33c8-2378-7830-aead-66bb6d72fa0d');
      const result = await router.route(parsed, {});
      expect(result).toBe(true);
      expect(aiMock.findConversationByRef).toHaveBeenCalledWith('019e33c8-2378-7830-aead-66bb6d72fa0d');
      expect(aiMock.resumeConversation).toHaveBeenCalledWith('2026-05-17T12-34-56-abcd.json');
    });

    test('resume resolves a Store B (JSONL transcript) id before the legacy store', async () => {
      // The shutdown banner prints getLiveSessionId() — a Store B id. `resume`
      // is aliased to `history resume`, which previously checked only the legacy
      // summary store and rejected such ids with "无效会话 ID". The unified flow
      // must try Store B first and short-circuit on a hit.
      const liveId = '188c7b22-88fa-41e3-85f0-57ebc8d64a0f';
      aiMock.resumePersistedSession.mockReturnValue({
        success: true,
        sessionId: liveId,
        messageCount: 18,
        title: '',
        source: 'jsonl',
      });

      const parsed = router.parseInput(`resume ${liveId}`);
      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(aiMock.resumePersistedSession).toHaveBeenCalledWith(liveId);
      // Store B hit short-circuits — the legacy summary store is never consulted.
      expect(aiMock.findConversationByRef).not.toHaveBeenCalled();
      expect(aiMock.resumeConversation).not.toHaveBeenCalled();
    });

    test('resume falls back to the legacy store when Store B misses', async () => {
      // A Store B miss must not surface as a hard error; the legacy summary
      // store still gets a chance to resolve an explicit id.
      const liveId = '188c7b22-88fa-41e3-85f0-57ebc8d64a0f';
      aiMock.listConversations.mockReturnValue([
        { file: 'legacy.json', sessionId: liveId, timestamp: '2026-06-23T00:00:00.000Z', messageCount: 3 },
      ]);
      aiMock.findConversationByRef.mockReturnValue({
        file: 'legacy.json', sessionId: liveId, timestamp: '2026-06-23T00:00:00.000Z', messageCount: 3,
      });
      aiMock.resumeConversation.mockReturnValue({
        success: true, messageCount: 3, timestamp: '2026-06-23T00:00:00.000Z',
      });

      const parsed = router.parseInput(`resume ${liveId}`);
      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(aiMock.resumePersistedSession).toHaveBeenCalledWith(liveId);
      expect(aiMock.resumeConversation).toHaveBeenCalledWith('legacy.json');
    });

    test('resume #N resolves the same 1-based index as `resume N` (no INVALID_ID dead-end)', async () => {
      // Regression: the resume flow's _looksLikeIndex gate accepts `#N` (`/^#?\d+$/`)
      // and correctly skips Store-B session resume, but the resolver's index gate
      // was `/^\d+$/` — so `#2` fell through to findConversationByRef and dead-ended
      // at "无效会话 ID". Both gates must agree: `#N` is a 1-based history index.
      const convos = [
        { file: 'a.json', sessionId: 'aaaa', timestamp: '2026-06-01T00:00:00.000Z', messageCount: 2 },
        { file: 'b.json', sessionId: 'bbbb', timestamp: '2026-06-02T00:00:00.000Z', messageCount: 5 },
      ];
      aiMock.listConversations.mockReturnValue(convos);
      aiMock.resumeConversation.mockReturnValue({
        success: true, messageCount: 5, timestamp: '2026-06-02T00:00:00.000Z',
      });

      const result = await router.route(router.parseInput('resume #2'), {});

      expect(result).toBe(true);
      // Resolved by numeric index, NOT by treating `#2` as an opaque id.
      expect(aiMock.findConversationByRef).not.toHaveBeenCalled();
      expect(aiMock.resumeConversation).toHaveBeenCalledWith('b.json');
    });

    test('resume #N and resume N select the identical conversation', async () => {
      const convos = [
        { file: 'a.json', sessionId: 'aaaa', timestamp: '2026-06-01T00:00:00.000Z', messageCount: 2 },
        { file: 'b.json', sessionId: 'bbbb', timestamp: '2026-06-02T00:00:00.000Z', messageCount: 5 },
      ];
      aiMock.listConversations.mockReturnValue(convos);
      aiMock.resumeConversation.mockReturnValue({
        success: true, messageCount: 2, timestamp: '2026-06-01T00:00:00.000Z',
      });

      await router.route(router.parseInput('resume 1'), {});
      expect(aiMock.resumeConversation).toHaveBeenCalledWith('a.json');

      aiMock.resumeConversation.mockClear();
      await router.route(router.parseInput('resume #1'), {});
      expect(aiMock.resumeConversation).toHaveBeenCalledWith('a.json');
    });

    test('resume #99 (out of range) reports INVALID_INDEX, not INVALID_ID', async () => {
      const fmt = require('../../src/cli/formatters');
      fmt.printError.mockClear();
      aiMock.listConversations.mockReturnValue([
        { file: 'a.json', sessionId: 'aaaa', timestamp: '2026-06-01T00:00:00.000Z', messageCount: 2 },
      ]);

      const result = await router.route(router.parseInput('resume #99'), {});

      expect(result).toBe(true);
      // An out-of-range index must NOT fall through to id resolution.
      expect(aiMock.findConversationByRef).not.toHaveBeenCalled();
      expect(aiMock.resumeConversation).not.toHaveBeenCalled();
      expect(fmt.printError).toHaveBeenCalledWith('无效序号，请先运行 history list 查看');
    });

    test('models list --json returns structured error when Ollama is not running', async () => {
      ollamaMgr.isOllamaRunning.mockResolvedValue(false);
      const parsed = router.parseInput('models list --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: false,
        action: 'list',
        provider: 'ollama',
        error: 'ollama_not_running',
        message: 'Ollama 未运行。请先执行: ollama serve',
      }, null, 2));
    });

    test('models list --json returns structured model list', async () => {
      ollamaMgr.isOllamaRunning.mockResolvedValue(true);
      ollamaMgr.listModels.mockResolvedValue([
        { name: 'qwen2.5:7b', size: '4.7 GB', paramSize: '7B', quantization: 'Q4_K_M' },
      ]);
      const parsed = router.parseInput('models list --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: true,
        action: 'list',
        provider: 'ollama',
        count: 1,
        models: [
          { name: 'qwen2.5:7b', size: '4.7 GB', paramSize: '7B', quantization: 'Q4_K_M' },
        ],
      }, null, 2));
    });

    test('models set --json writes via shared env patch and returns structured result', async () => {
      const parsed = router.parseInput('models set qwen2.5:7b --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(configHandler._writeEnvPatch).toHaveBeenCalledWith({
        GATEWAY_PREFERRED_ADAPTER: 'ollama',
        GATEWAY_PREFERRED_STRICT: 'true',
        OLLAMA_MODEL: 'qwen2.5:7b',
      });
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: true,
        action: 'set',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        envPath: '/tmp/test-models.env',
      }, null, 2));
    });

    test('models set --json returns structured usage error when model id is missing', async () => {
      const parsed = router.parseInput('models set --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: false,
        action: 'set',
        provider: 'ollama',
        error: 'missing_model_id',
        message: '用法: models set <model-id>',
      }, null, 2));
    });

    test('models pull --json returns structured error when model id is missing', async () => {
      const parsed = router.parseInput('models pull --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: false,
        action: 'pull',
        provider: 'ollama',
        error: 'missing_model_id',
        message: '用法: models pull <model-id>',
      }, null, 2));
    });

    test('models pull --json returns structured error when Ollama is not running', async () => {
      ollamaMgr.isOllamaRunning.mockResolvedValue(false);
      const parsed = router.parseInput('models pull qwen2.5:7b --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: false,
        action: 'pull',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        error: 'ollama_not_running',
        message: 'Ollama 未运行。请先执行: ollama serve',
      }, null, 2));
    });

    test('models delete --json returns structured error when model id is missing', async () => {
      const parsed = router.parseInput('models delete --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: false,
        action: 'delete',
        provider: 'ollama',
        error: 'missing_model_id',
        message: '用法: models delete <model-id>',
      }, null, 2));
    });

    test('models delete --json returns structured error when Ollama is not running', async () => {
      ollamaMgr.isOllamaRunning.mockResolvedValue(false);
      const parsed = router.parseInput('models delete qwen2.5:7b --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(console.log).toHaveBeenCalledWith(JSON.stringify({
        ok: false,
        action: 'delete',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        error: 'ollama_not_running',
        message: 'Ollama 未运行。请先执行: ollama serve',
      }, null, 2));
    });

    test('models import with --use writes default model via shared env patch', async () => {
      ollamaMgr.isOllamaRunning.mockResolvedValue(true);
      ollamaMgr.importModel.mockResolvedValue({
        success: true,
        model: 'imported-model',
        sourceKind: 'gguf',
      });
      const parsed = router.parseInput('models import ./model.gguf imported-model --use');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(ollamaMgr.importModel).toHaveBeenCalledWith('./model.gguf', 'imported-model', {
        base: undefined,
        systemPrompt: undefined,
        temperature: undefined,
        topP: undefined,
        numCtx: undefined,
      });
      expect(configHandler._writeEnvPatch).toHaveBeenCalledWith({
        GATEWAY_PREFERRED_ADAPTER: 'ollama',
        GATEWAY_PREFERRED_STRICT: 'true',
        OLLAMA_MODEL: 'imported-model',
      });
      expect(aiGateway.refreshAdapters).toHaveBeenCalled();
    });

    test('gateway prefer-remote forwards options to the handler', async () => {
      gatewayHandler.handleGatewayPreferRemote.mockClear();
      const parsed = router.parseInput('gateway prefer-remote --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(gatewayHandler.handleGatewayPreferRemote).toHaveBeenCalledWith({ json: true });
    });

    test('gateway config forwards options to the handler', async () => {
      gatewayHandler.handleGatewayConfig.mockClear();
      const parsed = router.parseInput('gateway config --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(gatewayHandler.handleGatewayConfig).toHaveBeenCalledWith({ json: true });
    });

    test('gateway detect forwards options to the handler', async () => {
      gatewayHandler.handleGatewayDetect.mockClear();
      const parsed = router.parseInput('gateway detect --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(gatewayHandler.handleGatewayDetect).toHaveBeenCalledWith({ json: true });
    });

    test('gateway key health forwards args and options to the handler', async () => {
      gatewayHandler.handleGatewayKey.mockClear();
      const parsed = router.parseInput('gateway key health deepseek --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(gatewayHandler.handleGatewayKey).toHaveBeenCalledWith('health', ['deepseek'], { json: true });
    });

    test('gateway test forwards target and options to the handler', async () => {
      gatewayHandler.handleGatewayTest.mockClear();
      const parsed = router.parseInput('gateway test codex --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(gatewayHandler.handleGatewayTest).toHaveBeenCalledWith('codex', { json: true });
    });

    test('gateway discover-models forwards options to the handler', async () => {
      gatewayHandler.handleGatewayDiscoverModels.mockClear();
      const parsed = router.parseInput('gateway discover-models --json');

      const result = await router.route(parsed, {});

      expect(result).toBe(true);
      expect(gatewayHandler.handleGatewayDiscoverModels).toHaveBeenCalledWith({ json: true });
    });

    describe('share', () => {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');

      test('renders conversation to Markdown, writes file, and copies to clipboard', async () => {
        aiMock.getConversation.mockReturnValue([
          { role: 'user', content: '帮我写个函数 $(whoami)' },
          { role: 'assistant', content: [{ type: 'text', text: '好的' }, { type: 'tool_use', name: 'write', input: {} }] },
          { role: 'assistant', content: '完成 ✅' },
        ]);
        imageServiceMock.writeClipboardText.mockReturnValue(true);
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-share-')), 'out.md');

        const result = await router.route(router.parseInput(`share --out ${out}`), {});

        expect(result).toBe(true);
        expect(fs.existsSync(out)).toBe(true);
        const md = fs.readFileSync(out, 'utf-8');
        expect(md).toContain('# KHY 会话分享');
        expect(md).toContain('帮我写个函数 $(whoami)'); // shell metachars preserved verbatim
        expect(md).toContain('完成 ✅');
        // empty (tool_use-only) turns are skipped, not rendered as blank sections
        expect(imageServiceMock.writeClipboardText).toHaveBeenCalledWith(md);
      });

      test('empty conversation → no file written, friendly notice', async () => {
        aiMock.getConversation.mockReturnValue([]);
        imageServiceMock.writeClipboardText.mockClear();

        const result = await router.route(router.parseInput('share'), {});

        expect(result).toBe(true);
        expect(imageServiceMock.writeClipboardText).not.toHaveBeenCalled();
      });

      test('clipboard unavailable still succeeds (file is the fallback)', async () => {
        aiMock.getConversation.mockReturnValue([{ role: 'user', content: 'hi' }]);
        imageServiceMock.writeClipboardText.mockReturnValue(false);
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'khy-share-')), 'out.md');

        const result = await router.route(router.parseInput(`share --out ${out}`), {});

        expect(result).toBe(true);
        expect(fs.existsSync(out)).toBe(true);
      });
    });
  });
});
