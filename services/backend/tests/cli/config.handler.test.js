'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

jest.mock('../../src/cli/formatters', () => ({
  printSuccess: jest.fn(),
  printError: jest.fn(),
  printInfo: jest.fn(),
  printWarn: jest.fn(),
  printTable: jest.fn(),
}));

const { printSuccess, printError, printInfo, printTable } = require('../../src/cli/formatters');
const { handleConfig } = require('../../src/cli/handlers/config');

describe('config handler', () => {
  const ORIGINAL_ENV = process.env;
  let tmpDir;
  let envPath;
  let consoleLogSpy;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-handler-'));
    envPath = path.join(tmpDir, '.env');
    fs.writeFileSync(envPath, '', 'utf-8');
    process.env = {
      ...ORIGINAL_ENV,
      HOME: tmpDir,
      KHY_ENV_FILE: envPath,
      KHY_ENV_SYNC_ROOT: 'false',
    };
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.clearAllMocks();
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    process.env = ORIGINAL_ENV;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('set model.provider custom writes relay_api preference', async () => {
    await handleConfig('set', ['model.provider', 'custom']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('GATEWAY_PREFERRED_ADAPTER=relay_api');
    expect(content).toContain('GATEWAY_PREFERRED_STRICT=true');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('set model.default custom/model writes preferred model route', async () => {
    await handleConfig('set', ['model.default', 'custom/test-model']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('GATEWAY_PREFERRED_ADAPTER=relay_api');
    expect(content).toContain('GATEWAY_PREFERRED_MODEL=test-model');
    expect(content).toContain('RELAY_API_MODEL=test-model');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('openclaw compatibility mode writes dynamic provider model mapping', async () => {
    await handleConfig('openclaw', [], {
      'custom-base-url': 'https://api.example.com/v1',
      'custom-model-id': 'any-dynamic-model-id',
      'custom-api-key': 'sk-test',
      'custom-compatibility': 'openai',
    });
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('RELAY_API_ENDPOINT=https://api.example.com/v1');
    expect(content).toContain('RELAY_API_MODEL=any-dynamic-model-id');
    expect(content).toContain('RELAY_API_KEY=sk-test');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('opencode compatibility mode accepts direct flags and normalizes /v1', async () => {
    await handleConfig('opencode', [], {
      'base-url': 'https://api.example.com',
      'model-id': 'dynamic-opencode-model',
      'api-key': 'sk-direct',
      compatibility: 'openai',
    });
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('RELAY_API_ENDPOINT=https://api.example.com/v1');
    expect(content).toContain('RELAY_API_MODEL=dynamic-opencode-model');
    expect(content).toContain('RELAY_API_KEY=sk-direct');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('opencode compatibility mode can read opencode.json profile', async () => {
    const opencodeDir = path.join(tmpDir, '.config', 'opencode');
    fs.mkdirSync(opencodeDir, { recursive: true });
    const opencodePath = path.join(opencodeDir, 'opencode.json');
    fs.writeFileSync(opencodePath, JSON.stringify({
      provider: {
        'my-provider': {
          npm: '@ai-sdk/openai-compatible',
          options: {
            baseURL: 'https://api.example.com/v1',
            apiKey: 'sk-from-file',
          },
          models: {
            'model-from-file': {},
          },
        },
      },
    }, null, 2), 'utf-8');

    await handleConfig('opencode', [], {
      config: opencodePath,
      provider: 'my-provider',
    });

    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('RELAY_API_ENDPOINT=https://api.example.com/v1');
    expect(content).toContain('RELAY_API_MODEL=model-from-file');
    expect(content).toContain('RELAY_API_KEY=sk-from-file');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('set model.api_key accepts multiple keys and persists primary/list', async () => {
    await handleConfig('set', ['model.api_key', 'sk-a,sk-b']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('RELAY_API_KEY=sk-a');
    expect(content).toContain('RELAY_API_KEYS=sk-a,sk-b');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  // Relay 端点族(base_url / api_key / name)不再硬钉 strict:一个已死的自定义
  // 端点不得锁死整轮对话,允许级联回退到可用通道。逐字节回退用 change A 的门控。
  test('set model.base_url writes NON-strict relay preference (dead endpoint can fall back)', async () => {
    await handleConfig('set', ['model.base_url', 'https://relay.example.com/v1']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('GATEWAY_PREFERRED_ADAPTER=relay_api');
    expect(content).toContain('GATEWAY_PREFERRED_STRICT=false');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('set model.api_key writes NON-strict relay preference', async () => {
    await handleConfig('set', ['model.api_key', 'sk-only']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('GATEWAY_PREFERRED_STRICT=false');
  });

  test('set model.name writes NON-strict relay preference', async () => {
    await handleConfig('set', ['model.name', 'my-relay-model']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('GATEWAY_PREFERRED_STRICT=false');
  });

  // GLM 视觉池自动镜像:relay 端点为智谱 bigmodel 时,把 key 镜像进 glm 池(GLM_API_KEY),
  // 让识图的视觉 api-pin(hasAvailableKeys('glm') 闸门)得以触发,识图不再落进通用级联被
  // OpenAI/api 抢答后 ECONNRESET/404。门控 KHY_GLM_VISION_POOL_MIRROR(默认开)。
  describe('GLM vision pool mirror', () => {
    beforeEach(() => {
      // 确定性:清掉可能从外层环境泄漏的相关键。
      delete process.env.RELAY_API_ENDPOINT;
      delete process.env.RELAY_API_KEY;
      delete process.env.GLM_API_KEY;
      delete process.env.GLM_API_ENDPOINT;
      delete process.env.KHY_GLM_VISION_POOL_MIRROR;
    });

    test('bigmodel base_url + api_key → key mirrored into the glm pool', async () => {
      await handleConfig('set', ['model.base_url', 'https://open.bigmodel.cn/api/paas/v4']);
      await handleConfig('set', ['model.api_key', 'sk-glm-relay']);
      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('GLM_API_KEY=sk-glm-relay');
      expect(content).toContain('GLM_API_ENDPOINT=https://open.bigmodel.cn/api/paas/v4');
    });

    test('order-independent: api_key first, then bigmodel base_url → still mirrored', async () => {
      await handleConfig('set', ['model.api_key', 'sk-first']);
      // key set 时端点尚非 bigmodel → 此刻不镜像
      let content = fs.readFileSync(envPath, 'utf-8');
      expect(content).not.toContain('GLM_API_KEY=sk-first');
      // 端点转为 bigmodel → 二者齐备 → 镜像
      await handleConfig('set', ['model.base_url', 'https://open.bigmodel.cn/api/paas/v4']);
      content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('GLM_API_KEY=sk-first');
    });

    test('non-bigmodel endpoint (trae) → NOT mirrored', async () => {
      await handleConfig('set', ['model.base_url', 'https://api.trae.ai/v1']);
      await handleConfig('set', ['model.api_key', 'sk-trae']);
      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).not.toContain('GLM_API_KEY=');
    });

    test('gate off (KHY_GLM_VISION_POOL_MIRROR=false) → NOT mirrored even for bigmodel', async () => {
      process.env.KHY_GLM_VISION_POOL_MIRROR = 'false';
      await handleConfig('set', ['model.base_url', 'https://open.bigmodel.cn/api/paas/v4']);
      await handleConfig('set', ['model.api_key', 'sk-gateoff']);
      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).not.toContain('GLM_API_KEY=');
    });

    test('does NOT clobber a user-set dedicated GLM_API_KEY', async () => {
      // 用户先有独立 glm key(与 relay key 不同)。
      process.env.GLM_API_KEY = 'sk-dedicated';
      fs.writeFileSync(envPath, 'GLM_API_KEY=sk-dedicated\n', 'utf-8');
      await handleConfig('set', ['model.base_url', 'https://open.bigmodel.cn/api/paas/v4']);
      await handleConfig('set', ['model.api_key', 'sk-relay']);
      const content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('GLM_API_KEY=sk-dedicated');
      expect(content).not.toContain('GLM_API_KEY=sk-relay');
    });

    test('rotation: a key we previously mirrored updates with the relay key', async () => {
      await handleConfig('set', ['model.base_url', 'https://open.bigmodel.cn/api/paas/v4']);
      await handleConfig('set', ['model.api_key', 'sk-old']);
      let content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('GLM_API_KEY=sk-old');
      // 轮换 relay key:我方镜像值(等于旧 relay key)应随之更新。
      await handleConfig('set', ['model.api_key', 'sk-new']);
      content = fs.readFileSync(envPath, 'utf-8');
      expect(content).toContain('GLM_API_KEY=sk-new');
      expect(content).not.toContain('GLM_API_KEY=sk-old');
    });
  });

  test('list prints model config table', async () => {
    await handleConfig('set', ['model.default', 'custom/test-model']);
    await handleConfig('list', []);
    expect(printTable).toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('Config file:'));
  });

  test('show behaves as list alias', async () => {
    await handleConfig('set', ['model.default', 'custom/test-model']);
    await handleConfig('show', []);
    expect(printTable).toHaveBeenCalled();
    expect(printInfo).toHaveBeenCalledWith(expect.stringContaining('Config file:'));
    expect(printError).not.toHaveBeenCalled();
  });

  test('show --json prints machine-readable config snapshot', async () => {
    await handleConfig('set', ['model.default', 'custom/test-model']);
    jest.clearAllMocks();

    await handleConfig('show', [], { json: true });

    expect(printTable).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      action: 'show',
      envPath,
    });
    expect(payload.values['model.default']).toBe('custom/test-model');
  });

  test('get --json prints machine-readable single value', async () => {
    await handleConfig('set', ['model.default', 'custom/test-model']);
    jest.clearAllMocks();

    await handleConfig('get', ['model.default'], { json: true });

    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      action: 'get',
      envPath,
      key: 'model.default',
      value: 'custom/test-model',
    });
  });

  test('set --json prints machine-readable success payload', async () => {
    await handleConfig('set', ['model.default', 'custom/test-model'], { json: true });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: true,
      action: 'set',
      key: 'model.default',
      value: 'custom/test-model',
      envPath,
    });
  });

  test('set --json prints structured error when key is missing', async () => {
    await handleConfig('set', [], { json: true });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: false,
      action: 'set',
      error: 'missing_key',
    });
  });

  test('set model.api_key --json masks secret in success payload', async () => {
    await handleConfig('set', ['model.api_key', 'sk-secret-12345'], { json: true });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    expect(consoleLogSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: true,
      action: 'set',
      key: 'model.api_key',
      value: 'sk-s...45',
      envPath,
    });
  });

  test('set language zh persists Chinese language preference', async () => {
    await handleConfig('set', ['language', 'zh']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).toContain('KHY_LANGUAGE=Chinese');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('set language auto clears KHY_LANGUAGE override', async () => {
    await handleConfig('set', ['language', 'zh']);
    await handleConfig('set', ['language', 'auto']);
    const content = fs.readFileSync(envPath, 'utf-8');
    expect(content).not.toContain('KHY_LANGUAGE=');
    expect(printSuccess).toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
  });

  test('openclaw --json prints structured error when required args are missing', async () => {
    await handleConfig('openclaw', [], { json: true });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: false,
      action: 'openclaw',
      error: 'missing_base_url_or_model_id',
    });
  });

  test('openclaw --json prints machine-readable success payload', async () => {
    await handleConfig('openclaw', [], {
      json: true,
      'custom-base-url': 'https://api.example.com/v1',
      'custom-model-id': 'demo-model',
      'custom-api-key': 'sk-test',
      'custom-compatibility': 'openai',
    });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: true,
      action: 'openclaw',
      provider: 'custom',
      modelId: 'demo-model',
      endpoint: 'https://api.example.com/v1',
      compatibility: 'openai',
      envPath,
    });
  });

  test('opencode --json prints structured error when required args are missing', async () => {
    await handleConfig('opencode', [], {
      json: true,
      config: path.join(tmpDir, 'missing-opencode.json'),
    });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: false,
      action: 'opencode',
      error: 'missing_base_url_or_model_id',
    });
  });

  test('opencode --json prints machine-readable success payload', async () => {
    await handleConfig('opencode', [], {
      json: true,
      'base-url': 'https://api.example.com',
      'model-id': 'demo-model',
      'api-key': 'sk-direct',
      compatibility: 'openai',
    });

    expect(printSuccess).not.toHaveBeenCalled();
    expect(printInfo).not.toHaveBeenCalled();
    expect(printError).not.toHaveBeenCalled();
    const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
    expect(payload).toMatchObject({
      ok: true,
      action: 'opencode',
      providerId: 'custom',
      modelId: 'demo-model',
      endpoint: 'https://api.example.com/v1',
      compatibility: 'openai',
      envPath,
    });
  });

  describe('layers — layered settings resolution (CC alignment)', () => {
    // The handler reads ~/.khy/settings.json (user layer, HOME=tmpDir here),
    // <cwd>/.khy/settings.* (project layers), and the managed layer via
    // KHY_MANAGED_SETTINGS. Resolution must honor managed > project > user.
    const writeUser = () => {
      const dir = path.join(tmpDir, '.khy');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ theme: 'dark', telemetry: true }));
    };

    test('layers --json reports merged value, per-key source and active layers', async () => {
      writeUser();
      const managed = path.join(tmpDir, 'managed.json');
      process.env.KHY_MANAGED_SETTINGS = managed;
      fs.writeFileSync(managed, JSON.stringify({ telemetry: false }));

      await handleConfig('layers', [], { json: true });

      const payload = JSON.parse(consoleLogSpy.mock.calls[0][0]);
      expect(payload.action).toBe('layers');
      expect(payload.value).toMatchObject({ theme: 'dark', telemetry: false });
      expect(payload.sources.theme).toBe('user');
      expect(payload.sources.telemetry).toBe('managed');
      expect(payload.layers.map((l) => l.name)).toEqual(
        expect.arrayContaining(['user', 'managed']),
      );
    });

    test('layers reports no active layers when nothing exists', async () => {
      // No user/project/managed files written, and managed override points nowhere.
      process.env.KHY_MANAGED_SETTINGS = path.join(tmpDir, 'absent-managed.json');
      await handleConfig('layers', [], {});
      expect(printInfo).toHaveBeenCalledWith(
        expect.stringContaining('未发现任何 settings 层'),
      );
    });
  });
});
