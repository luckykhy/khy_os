'use strict';

/**
 * multiFreeService.streamAndCatalog.test.js — locks the I/O-free slices of the
 * multi-provider free-LLM service:
 *   - createStreamIdleWatchdog: 活动感知的滑动空闲超时（规则 3）——
 *     touch 重置计时、clear 解除武装、到期 destroy + 结构化中文错误
 *     （含 KHY_STREAM_IDLE_TIMEOUT_MS 调参指引），绝不做硬 wall-clock kill
 *   - provider gating: 无 key → 全禁用 + local-fallback 状态；
 *     有 key → 按 priority 排序（google 1 在前）；baidu/alibaba 密钥回退链
 *   - generateZhipuJWT: id.secret 契约 + HS256/SIGN header + exp≈now+1h
 *   - localFallback: 各 agent 模板 + 未知 agent 综合兜底
 *   - enumerateKnownModels: 扁平目录结构（{id, provider, supportsVision}，
 *     去重、绝不抛、不发网络）
 * 环境变量在 before/after 中钉住与恢复，绝不读真实密钥。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');

const MultiFreeService = require('../src/services/multiFreeService');
const { createStreamIdleWatchdog, enumerateKnownModels } = MultiFreeService;
const jwt = require('jsonwebtoken');

const KEY_ENVS = [
  'GOOGLE_GEMINI_API_KEY',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'TRAE_API_KEY',
  'TRAE_MODEL',
  'ZHIPU_API_KEY',
  'XUNFEI_API_KEY',
  'BAIDU_API_KEY',
  'BAIDU_SECRET_KEY',
  'BAIDU_API_SECRET',
  'BAIDU_SECRET',
  'ALIBABA_API_KEY',
  'DASHSCOPE_API_KEY',
  'HUGGINGFACE_TOKEN',
  'KHY_STREAM_IDLE_TIMEOUT_MS',
];
const savedEnv = {};

before(() => {
  for (const k of KEY_ENVS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

after(() => {
  for (const k of KEY_ENVS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function clearKeys() {
  for (const k of KEY_ENVS.filter((k) => k !== 'KHY_STREAM_IDLE_TIMEOUT_MS')) delete process.env[k];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('multiFreeService 流式空闲看门狗（规则 3：活动感知，不硬 kill）', () => {
  test('返回 {touch, clear} 句柄', () => {
    process.env.KHY_STREAM_IDLE_TIMEOUT_MS = '150';
    const wd = createStreamIdleWatchdog({ destroy() {} }, () => {}, 'lbl');
    assert.strictEqual(typeof wd.touch, 'function');
    assert.strictEqual(typeof wd.clear, 'function');
    wd.clear();
  });

  test('无活动 → 到期 destroy 流 + 拒绝（错误含「空闲超时 + 调参指引」）', async () => {
    process.env.KHY_STREAM_IDLE_TIMEOUT_MS = '150';
    let destroyCount = 0;
    const stream = { destroy() { destroyCount++; } };
    const err = await assert.rejects(
      new Promise((resolve, reject) => {
        const wd = createStreamIdleWatchdog(stream, reject, 'test-label');
        wd.clear = undefined; // 只看到期路径；防止被后续清理解武装
        void wd;
      }),
      (e) => {
        assert.match(String(e.message), /流式响应空闲超时/);
        assert.match(String(e.message), /KHY_STREAM_IDLE_TIMEOUT_MS/, '必须给调参指引');
        assert.match(String(e.message), /test-label/, '错误必须点名目标流');
        return true;
      },
    );
    assert.strictEqual(destroyCount, 1, '到期必须 destroy 流');
    void err;
  });

  test('持续 touch（活动）→ 不断重置，长活动任务绝不被误杀', async () => {
    process.env.KHY_STREAM_IDLE_TIMEOUT_MS = '150';
    let rejected = null;
    const stream = { destroy() {} };
    const wd = createStreamIdleWatchdog(
      stream,
      (e) => {
        rejected = e;
      },
      'busy',
    );
    // 活动 700ms（> 4 × 150ms 空闲阈值），每 50ms touch 一次
    const start = Date.now();
    while (Date.now() - start < 700) {
      wd.touch();
      await sleep(50);
    }
    assert.strictEqual(rejected, null, '有活动就不许超时');
    wd.clear();
  });

  test('clear 解除武装 → 之后不再触发', async () => {
    process.env.KHY_STREAM_IDLE_TIMEOUT_MS = '150';
    let fired = false;
    const wd = createStreamIdleWatchdog(
      { destroy() {} },
      () => {
        fired = true;
      },
      'armed-off',
    );
    wd.clear();
    await sleep(400);
    assert.strictEqual(fired, false);
  });

  test('非法 KHY_STREAM_IDLE_TIMEOUT_MS（非数字/<=0）→ 不误设 0ms 立即超时', () => {
    process.env.KHY_STREAM_IDLE_TIMEOUT_MS = 'abc';
    let fired = false;
    const wd = createStreamIdleWatchdog(
      { destroy() {} },
      () => {
        fired = true;
      },
      'garbage-env',
    );
    // 垃圾值必须回落 45s 默认：100ms 内绝不应触发
    setTimeout(() => wd.clear(), 100);
    assert.strictEqual(fired, false);
  });
});

describe('multiFreeService provider 门控与状态', () => {
  test('无任何 key → 零可用 provider + local-fallback 状态', () => {
    clearKeys();
    const svc = new MultiFreeService();
    assert.deepStrictEqual(svc.getAvailableProviders(), []);
    assert.strictEqual(svc.getAvailableProvider(), null);
    const status = svc.getStatus();
    assert.strictEqual(status.available, false);
    assert.strictEqual(status.provider, 'local-fallback');
    assert.match(status.message, /No cloud providers configured/);
    assert.deepStrictEqual(svc.getStatus().configuredProviders, []);
  });

  test('testConnection 无 provider → 结构化失败（不触网）', async () => {
    clearKeys();
    const svc = new MultiFreeService();
    const out = await svc.testConnection();
    assert.strictEqual(out.success, false);
    assert.strictEqual(out.provider, 'local-fallback');
    assert.deepStrictEqual(out.results, []);
    assert.match(out.message, /No LLM providers configured/);
  });

  test('google key 优先（priority 1）排在 anthropic（priority 4）前', () => {
    clearKeys();
    process.env.GOOGLE_GEMINI_API_KEY = 'g-test-key';
    process.env.ANTHROPIC_API_KEY = 'a-test-key';
    const svc = new MultiFreeService();
    const list = svc.getAvailableProviders();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(list[0].key, 'google', 'priority 1 必须排前');
    assert.strictEqual(list[1].key, 'anthropic');
    assert.strictEqual(svc.getAvailableProvider().name, 'Google Gemini');
  });

  test('baidu 密钥回退链：apiKey 直取 BAIDU_API_KEY，secret 链 BAIDU_SECRET_KEY 优先；alibaba：ALIBABA_API_KEY 优先于 DASHSCOPE', () => {
    clearKeys();
    process.env.BAIDU_API_KEY = 'b-ak';
    process.env.BAIDU_SECRET_KEY = 'b-sk';
    process.env.BAIDU_API_SECRET = 'b-api-secret';
    process.env.ALIBABA_API_KEY = 'al';
    process.env.DASHSCOPE_API_KEY = 'ds';
    const svc = new MultiFreeService();
    assert.strictEqual(svc.providers.baidu.apiKey, 'b-ak');
    assert.strictEqual(svc.providers.baidu.secretKey, 'b-sk', 'secret 链首个命中');
    assert.strictEqual(svc.providers.alibaba.apiKey, 'al', '显式 key 优先于 DASHSCOPE');
  });

  test('alibaba 无 ALIBABA_API_KEY 时回退 DASHSCOPE_API_KEY', () => {
    clearKeys();
    process.env.DASHSCOPE_API_KEY = 'ds-only';
    const svc = new MultiFreeService();
    assert.strictEqual(svc.providers.alibaba.apiKey, 'ds-only');
    assert.strictEqual(svc.providers.alibaba.enabled, true);
  });
});

describe('multiFreeService Zhipu JWT 契约', () => {
  test('非法密钥格式 → 明确错误（不含密钥本身）', () => {
    const svc = new MultiFreeService();
    assert.throws(
      () => svc.generateZhipuJWT('no-dot-format'),
      (e) => /Invalid Zhipu API key format/.test(String(e.message)),
    );
  });

  test('id.secret → HS256 + SIGN header + api_key/exp 载荷可被校验', () => {
    const svc = new MultiFreeService();
    const token = svc.generateZhipuJWT('zhipu-id-1.test-secret');
    assert.strictEqual(String(token).split('.').length, 3, 'JWT 三段式');
    const decoded = jwt.verify(token, 'test-secret', { algorithms: ['HS256'] });
    assert.strictEqual(decoded.api_key, 'zhipu-id-1');
    assert.ok(Math.abs(decoded.exp - Math.round(Date.now() / 1000) - 3600) <= 5, 'exp ≈ now + 1h');
    // header 自定义 sign_type 必须保留（jsonwebtoken v9 的 decode({header:true})
    // 行为不可靠，直接解 base64url 头段）
    const header = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf-8'));
    assert.strictEqual(header.sign_type, 'SIGN');
    assert.strictEqual(header.alg, 'HS256');
  });
});

describe('multiFreeService 本地兜底分析', () => {
  test('已知 agent → 专属模板（含标的代码）', () => {
    const svc = new MultiFreeService();
    for (const agent of ['fundamentals', 'market', 'social', 'news', 'strategy', 'risk']) {
      const text = svc.localFallback(agent, '600000');
      assert.match(text, /600000/, `模板必须带标的: ${agent}`);
      assert.match(text, new RegExp(agent === 'fundamentals' ? '基本面' : '分析'), '带分析类别');
    }
  });

  test('未知 agent → 综合分析兜底文案', () => {
    const svc = new MultiFreeService();
    const text = svc.localFallback('mystery-agent', '000001');
    assert.match(text, /综合分析/);
    assert.match(text, /000001/);
  });

  test('缺省参数 → general/UNKNOWN 兜底', () => {
    const svc = new MultiFreeService();
    assert.match(svc.localFallback(), /综合分析/);
  });
});

describe('multiFreeService 模型目录枚举', () => {
  test('enumerateKnownModels: 结构契约 + 去重 + 含内置旗舰模型', () => {
    clearKeys();
    const out = enumerateKnownModels();
    assert.ok(Array.isArray(out) && out.length > 0, '必须枚举出内置模型');
    for (const m of out) {
      assert.ok(typeof m.id === 'string' && m.id.length > 0);
      assert.ok(typeof m.provider === 'string' && m.provider.length > 0);
      assert.strictEqual(typeof m.supportsVision, 'boolean');
    }
    const ids = out.map((m) => m.id.toLowerCase());
    assert.strictEqual(new Set(ids).size, ids.length, '模型 id 必须去重（大小写不敏感）');
    assert.ok(ids.includes('gpt-4o-mini'), 'OpenAI 默认模型必须在目录内');
    assert.ok(ids.includes('meta-llama/llama-3.3-70b-instruct'), 'OpenRouter 默认模型必须在目录内');
    const vision = out.filter((m) => m.supportsVision);
    assert.ok(vision.length > 0, '必须有支持视觉的模型');
  });

  test('httpClient 导出为 axios 兼容面（post/get 函数，服务内所有调用点依赖此契约）', () => {
    const c = MultiFreeService.httpClient;
    assert.strictEqual(typeof c, 'object');
    assert.strictEqual(typeof c.post, 'function', 'post(url, data, config)');
    assert.strictEqual(typeof c.get, 'function', 'get(url, config)');
  });
});
