'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

describe('khy machine-readable CLI entrypoints', () => {
  test('gateway add --json accepts explicit non-interactive flags', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-add-json-'));
    const envPath = path.join(tmpHome, 'gateway-add.env');
    fs.writeFileSync(envPath, 'EXISTING_KEY=1\n', 'utf8');

    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [
        binPath,
        'gateway',
        'add',
        '--name', 'Example Provider',
        '--pool-key', 'example-provider',
        '--base-url', 'https://api.example.com/v1',
        '--api-key', 'sk-test-1234567890123456',
        '--model-id', 'example-chat',
        '--json',
      ], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_ENV_FILE: envPath,
          KHY_ENV_SYNC_ROOT: 'false',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        action: 'add',
        poolKey: 'example-provider',
        displayName: 'Example Provider',
        endpoint: 'https://api.example.com/v1',
        defaultModel: 'example-chat',
        models: ['example-chat'],
        keyCount: 1,
        envPath,
      });

      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).toContain('EXISTING_KEY=1');
      expect(envContent).toContain('GATEWAY_API_POOL_SERVICE_MAP=');
      expect(envContent).toContain('GATEWAY_API_POOL_DEFAULT_MODEL_MAP=');
      expect(envContent).toContain('PROXY_MODEL_ROUTE_MAP=');

      const providerRegistryPath = path.join(tmpHome, '.khyquant', 'custom_providers.json');
      expect(fs.existsSync(providerRegistryPath)).toBe(true);
      const providers = JSON.parse(fs.readFileSync(providerRegistryPath, 'utf8'));
      expect(providers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          poolKey: 'example-provider',
          name: 'Example Provider',
          endpoint: 'https://api.example.com/v1',
          defaultModel: 'example-chat',
        }),
      ]));

      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway pool list --json stays machine-readable on an empty isolated pool', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-pool-json-'));
    const dbPath = path.join(tmpHome, 'account-pool.sqlite');
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'pool', 'list', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          DB_PATH: dbPath,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        action: 'list',
        provider: null,
        count: 0,
        accounts: [],
        providers: {},
        message: '号池为空',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway config --json stays machine-readable in non-interactive mode', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-config-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'config', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        action: 'config',
        interactive: false,
        requiresTTY: true,
      });
      expect(Array.isArray(payload.menu)).toBe(true);
      expect(payload.menu.length).toBeGreaterThan(0);
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway detect --json stays machine-readable in non-interactive mode', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-detect-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'detect', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        action: 'detect',
        interactive: false,
      });
      expect(typeof payload.count).toBe('number');
      expect(typeof payload.missingCount).toBe('number');
      expect(Array.isArray(payload.ides)).toBe(true);
      expect(Array.isArray(payload.missing)).toBe(true);
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway prefer-remote --json stays machine-readable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-prefer-remote-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'prefer-remote', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          GATEWAY_CLAUDE_ENABLED: 'false',
          GATEWAY_CODEX_ENABLED: 'false',
          GATEWAY_CURSOR_ENABLED: 'false',
          GATEWAY_KIRO_ENABLED: 'false',
          GATEWAY_TRAE_ENABLED: 'false',
          GATEWAY_WINDSURF_ENABLED: 'false',
          GATEWAY_VSCODE_ENABLED: 'false',
          GATEWAY_WARP_ENABLED: 'false',
          GATEWAY_RELAY_ENABLED: 'false',
          GATEWAY_API_ENABLED: 'false',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 20000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        action: 'prefer-remote',
      });
      expect(typeof payload.ok).toBe('boolean');
      expect(typeof payload.switched).toBe('boolean');
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway key rotate --json stays machine-readable when no keys are configured', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-key-rotate-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'key', 'rotate', 'deepseek', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          DEEPSEEK_API_KEY: '',
          DEEPSEEK_API_KEYS: '',
          DEEPSEEK_API_KEY_1: '',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'rotate',
        provider: 'deepseek',
        error: 'no_keys_configured',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway discover-models --json stays machine-readable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-discover-models-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'discover-models', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      const payload = JSON.parse(result.stdout);
      expect(payload).toMatchObject({
        ok: true,
        action: 'discover-models',
      });
      expect(typeof payload.count).toBe('number');
      expect(Array.isArray(payload.models)).toBe(true);
      expect(Array.isArray(payload.evidence)).toBe(true);
      expect(typeof payload.envPath).toBe('string');
      expect(typeof payload.mergedCount).toBe('number');
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway test <missing-adapter> --json stays machine-readable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-gateway-test-json-'));
    try {
      const missingAdapter = '__missing_adapter__';
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'test', missingAdapter, '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'test',
        target: missingAdapter,
        count: 0,
        adapters: [],
        error: 'adapter_not_found',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway debug-prompt help --json stays machine-readable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-debug-prompt-help-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'debug-prompt', 'help', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        action: 'help',
        command: 'gateway debug-prompt',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('gateway trace --json stays machine-readable on first run', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-bin-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'gateway', 'trace', 'req-json-smoke', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('self --json stays machine-readable and does not crash', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-self-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'self', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toHaveProperty('identity.name');
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('config show --json returns JSON instead of a table', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-json-'));
    const envPath = path.join(tmpHome, 'config.env');
    fs.writeFileSync(envPath, [
      'GATEWAY_PREFERRED_ADAPTER=relay_api',
      'GATEWAY_PREFERRED_MODEL=test-model',
      'RELAY_API_ENDPOINT=https://api.example.com/v1',
      'RELAY_API_KEY=sk-machine-readable-99',
      'RELAY_API_MODEL=test-model',
      'KHY_LANGUAGE=Chinese',
      '',
    ].join('\n'), 'utf8');

    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'config', 'show', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_ENV_FILE: envPath,
          KHY_ENV_SYNC_ROOT: 'false',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: 'show',
        envPath,
        values: {
          'model.provider': 'custom',
          'model.base_url': 'https://api.example.com/v1',
          'model.api_key': 'sk-m...99',
          'model.name': 'test-model',
          'model.default': 'custom/test-model',
          'language.preference': 'Chinese',
        },
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('session stats --json returns JSON instead of human summary', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-session-stats-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'session', 'stats', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: 'stats',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('models list --json returns structured JSON when Ollama is unavailable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-models-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'models', 'list', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          OLLAMA_HOST: 'http://127.0.0.1:1',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'list',
        provider: 'ollama',
        error: 'ollama_not_running',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('models set --json respects KHY_ENV_FILE and returns JSON', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-models-set-json-'));
    const envPath = path.join(tmpHome, 'isolated.env');
    fs.writeFileSync(envPath, 'EXISTING_KEY=1\n', 'utf8');

    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'models', 'set', 'qwen2.5:7b', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_ENV_FILE: envPath,
          KHY_ENV_SYNC_ROOT: 'false',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        action: 'set',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        envPath,
      });

      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).toContain('EXISTING_KEY=1');
      expect(envContent).toContain('GATEWAY_PREFERRED_ADAPTER=ollama');
      expect(envContent).toContain('GATEWAY_PREFERRED_STRICT=true');
      expect(envContent).toContain('OLLAMA_MODEL=qwen2.5:7b');
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('config set --json returns JSON and updates target env file', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-set-json-'));
    const envPath = path.join(tmpHome, 'config.env');
    fs.writeFileSync(envPath, 'EXISTING_KEY=1\n', 'utf8');

    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'config', 'set', 'model.default', 'custom/demo', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_ENV_FILE: envPath,
          KHY_ENV_SYNC_ROOT: 'false',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        action: 'set',
        key: 'model.default',
        value: 'custom/demo',
        envPath,
      });

      const envContent = fs.readFileSync(envPath, 'utf8');
      expect(envContent).toContain('EXISTING_KEY=1');
      expect(envContent).toContain('GATEWAY_PREFERRED_ADAPTER=relay_api');
      expect(envContent).toContain('GATEWAY_PREFERRED_MODEL=demo');
      expect(envContent).toContain('GATEWAY_PREFERRED_STRICT=true');
      expect(envContent).toContain('RELAY_API_MODEL=demo');
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('models pull --json returns structured JSON when Ollama is unavailable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-models-pull-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'models', 'pull', 'qwen2.5:7b', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          OLLAMA_HOST: 'http://127.0.0.1:1',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'pull',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        error: 'ollama_not_running',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('models delete --json returns structured JSON when Ollama is unavailable', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-models-delete-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'models', 'delete', 'qwen2.5:7b', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          OLLAMA_HOST: 'http://127.0.0.1:1',
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'delete',
        provider: 'ollama',
        model: 'qwen2.5:7b',
        error: 'ollama_not_running',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('config openclaw --json returns structured JSON for missing args', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-openclaw-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'config', 'openclaw', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'openclaw',
        error: 'missing_base_url_or_model_id',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('config opencode --json returns structured JSON for missing args', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-config-opencode-json-'));
    try {
      const binPath = path.join(__dirname, '..', 'bin', 'khy.js');
      const result = spawnSync(process.execPath, [binPath, 'config', 'opencode', '--json'], {
        cwd: path.join(__dirname, '..'),
        env: {
          ...process.env,
          HOME: tmpHome,
          KHY_SHOW_INSTALL_PATH_ALWAYS: '0',
        },
        encoding: 'utf8',
        timeout: 15000,
      });

      expect(result.status).toBe(0);
      expect(result.stdout.trim().startsWith('{')).toBe(true);
      expect(() => JSON.parse(result.stdout)).not.toThrow();
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        action: 'opencode',
        error: 'missing_base_url_or_model_id',
      });
      expect(result.stderr).not.toContain('[khy] Install ready');
      expect(result.stderr).not.toContain('[khy] Install root');
      expect(result.stderr).not.toContain('[khy] Backend dir');
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
