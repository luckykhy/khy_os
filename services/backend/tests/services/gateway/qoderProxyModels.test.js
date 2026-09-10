'use strict';
/**
 * qoderProxyModels.test.js �?锁死「让 khyos 反代消费 qoder-proxy 模型」的纯叶子契约�?
 *
 * qoder-proxy 是本�?HTTP 反代(默认 127.0.0.1:3000),同时提供 OpenAI(/v1/chat/completions)
 * �?Anthropic(/v1/messages)两条线。本叶子声明:模型目录、opt-in �?默认�?127.0.0.1:3000
 * 没跑会留死条�?、以及两条池注册 spec(端点从单一根派生——anthropic 线端点必须裸主机不带 /v1,
 * 否则 callAnthropic �?/v1/messages �?/v1/v1/messages)�?
 *
 * 覆盖:常量;opt-in 默认�?+ flag 开;env-present;qoderOptedIn;端点派生(关键回归);
 * 两条 spec �?service/key;深拷贝隔�?junk env 绝不�?以及 registrar/三接线点�?LIVE 断言�?
 */
const fs = require('fs');
const path = require('path');
const q = require('../../../src/services/gateway/qoderProxyModels');

describe('Qoder Proxy Models', () => {
  test('constants: two pool keys, 13 models (incl 4 effort variants), non-empty defaults', () => {
      expect(q.QODER_POOL_KEY).toBe('qoder');
      expect(q.QODER_ANTHROPIC_POOL_KEY).toBe('qoder-anthropic');
      expect(q.QODER_DEFAULT_MODEL).toBe('qoder-cn');
      expect(q.QODER_DEFAULT_ROOT && /^https?:\/\//.test(q.QODER_DEFAULT_ROOT).toBeTruthy());
      expect(q.QODER_DUMMY_KEY && q.QODER_DUMMY_KEY.length > 0).toBeTruthy();
      expect(q.QODER_MODELS.length).toBe(13);
      expect(q.QODER_MODELS).toContain('qoder-cn');
      expect(q.QODER_MODELS).toContain('auto');
      for (const m of [
        'qwen3.7-max-effort-low', 'qwen3.7-max-effort-medium',
        'qwen3.7-max-effort-high', 'qwen3.7-max-effort-max',
      ]) {
        expect(q.QODER_MODELS.includes(m)).toBeTruthy();
      }
      expect(Object.isFrozen(q.QODER_MODELS)).toBeTruthy();
  });

  test('opt-in gate: default OFF; only true/1 enable', () => {
      expect(q.qoderProxyFlagEnabled({})).toBe(false);
      expect(q.qoderProxyFlagEnabled({ KHY_QODER_PROXY: 'true' })).toBe(true);
      expect(q.qoderProxyFlagEnabled({ KHY_QODER_PROXY: '1' })).toBe(true);
      for (const v of ['0', 'false', 'off', 'no', '']) {
        expect(q.qoderProxyFlagEnabled({ KHY_QODER_PROXY: v })).toBe(false, v);
      }
  });

  test('env-present: endpoint OR key present �?true', () => {
      expect(q.qoderProxyEnvPresent({})).toBe(false);
      expect(q.qoderProxyEnvPresent({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000' })).toBe(true);
      expect(q.qoderProxyEnvPresent({ QODER_PROXY_API_KEY: 'x' })).toBe(true);
      expect(q.qoderProxyEnvPresent({ QODER_PROXY_ENDPOINT: '   ' })).toBe(false);
  });

  test('qoderOptedIn: flag on OR env coordinates present', () => {
      expect(q.qoderOptedIn({})).toBe(false);
      expect(q.qoderOptedIn({ KHY_QODER_PROXY: 'true' })).toBe(true);
      expect(q.qoderOptedIn({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000' })).toBe(true);
      expect(q.qoderOptedIn({ QODER_PROXY_API_KEY: 'k' })).toBe(true);
  });

  test('endpoint derivation (KEY regression): anthropic root stays bare (no /v1)', () => {
      // Explicit endpoint carrying /v1 �?normalized root, no double /v1.
      const root = q.qoderProxyRoot({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000/v1' });
      expect(root).toBe('http://127.0.0.1:3000');
      // Trailing slashes stripped.
      expect(q.qoderProxyRoot({ QODER_PROXY_ENDPOINT: 'http://host:8080/' })).toBe('http://host:8080');
      // Empty env �?default root.
      expect(q.qoderProxyRoot({})).toBe(q.QODER_DEFAULT_ROOT);
  });

  test('qoderProxySpecs: two lines, correct service + endpoint shape', () => {
      const specs = q.qoderProxySpecs({ QODER_PROXY_ENDPOINT: 'http://127.0.0.1:3000/v1' });
      expect(specs.length).toBe(2);
      const openai = specs.find(s => s.poolKey === 'qoder');
      const anthropic = specs.find(s => s.poolKey === 'qoder-anthropic');
      expect(openai && anthropic).toBeTruthy();
      expect(openai.service).toBe('openai');
      expect(anthropic.service).toBe('anthropic');
      // openai line carries /v1 (callOpenAI normalizes either way).
      expect(openai.endpoint).toBe('http://127.0.0.1:3000/v1');
      // anthropic line MUST be bare root �?callAnthropic appends /v1/messages itself.
      expect(anthropic.endpoint).toBe('http://127.0.0.1:3000');
      expect(!/\/v1$/.test(anthropic.endpoint)).toBeTruthy();
      // both carry the full model set + default.
      expect(openai.defaultModel).toBe('qoder-cn');
      expect(openai.models.length).toBe(13);
      expect(anthropic.models.length).toBe(13);
  });

  test('qoderProxySpecs: key override vs dummy fallback', () => {
      const withKey = q.qoderProxySpecs({ QODER_PROXY_API_KEY: 'real-key-123' });
      expect(withKey.every(s => s.key === 'real-key-123').toBeTruthy());
      const noKey = q.qoderProxySpecs({});
      expect(noKey.every(s => s.key === q.QODER_DUMMY_KEY && s.key.length > 0).toBeTruthy());
  });

  test('deep-copy isolation: mutating returned models never pollutes frozen QODER_MODELS', () => {
      const a = q.listQoderModels();
      a.push('__poison__');
      expect(!q.QODER_MODELS).toContain('__poison__');
      const specs = q.qoderProxySpecs({});
      specs[0].models.push('__poison2__');
      expect(!q.QODER_MODELS).toContain('__poison2__');
  });

  test('never throws on junk env', () => {
      expect(() => q.qoderProxyFlagEnabled(null).not.toThrow());
      expect(() => q.qoderProxyEnvPresent(null).not.toThrow());
      expect(() => q.qoderOptedIn(undefined).not.toThrow());
      expect(() => q.qoderProxyRoot({ QODER_PROXY_ENDPOINT: {} }).not.toThrow());
      expect(() => q.qoderProxyKey(null).not.toThrow());
      expect(() => q.qoderProxySpecs(null).not.toThrow());
      expect(Array.isArray(q.qoderProxySpecs(null).toBeTruthy()));
  });

  test('LIVE wiring: registrar seeds via opt-in gate + registerCustomProvider', () => {
      const src = fs.readFileSync(
        path.join(__dirname, '../../../src/services/customProviderRegistrar.js'), 'utf8');
      expect(/require\(['"]\.\/gateway\/qoderProxyModels['"]\).toBeTruthy()/.test(src),
        'registrar requires qoderProxyModels');
      expect(/ensureBuiltinQoder/.test(src)).toBeTruthy();
      expect(/qoderOptedIn/.test(src)).toBeTruthy();
      expect(/qoderProxySpecs/.test(src)).toBeTruthy();
      // service param is threaded into the service map.
      expect(/VALID_SERVICES/.test(src)).toBeTruthy();
      expect(/\[poolKey\]:\s*service/.test(src)).toBeTruthy();
  });

  test('LIVE wiring: three startup call sites invoke ensureBuiltinQoder', () => {
      const files = [
        '../../../src/services/gateway/aiGateway.js',
        '../../../src/services/aiManagementServer.js',
        '../../../src/cli/handlers/init.js',
      ];
      for (const rel of files) {
        const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
        expect(/ensureBuiltinQoder/.test(src)).toBeTruthy();
      }
  });

});

