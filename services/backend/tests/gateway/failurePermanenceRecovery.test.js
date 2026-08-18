'use strict';

/**
 * 「一次失败永久失败 / 无法恢复 / 硬编码」三连的回归测试。
 *
 * 用户现象(终端截图):
 *   api [unknown]: recent unknown failure cached: All providers failed (cooldown 292s)
 * 292s ≈ 熔断退避的 300s 上限 —— 通道被判死刑,而真实原因只是「一个 provider 都没被试过」。
 *
 * 失败链条(逐环都在本文件里钉住):
 *   1. 请求没解析出 pool provider → apiAdapter 用 env-only 的 MultiFreeService 实例
 *      → 每个 provider 都 enabled:false → getAvailableProviders() 返回 [] → 尝试循环一次没进;
 *   2. 旧代码把这种**配置问题**报成 error:'All providers failed' + errorType:'unknown',
 *      而 'unknown' 是熔断合格类型 → 连续 3 次「没试」= 通道连挂 3 次 → circuitOpen + 300s;
 *   3. MemoryHealthStore(无 Redis 的默认实现)的连续失败计数**没有 TTL**,只能被一次成功清零
 *      —— 但成功需要先熬过 300s 冷却,而熔断态又关掉了 fast-fail 的探测放行 → 死锁。
 *
 * 修复与本文件断言的对应关系:
 *   §1 no_provider 独立成类(multiFreeService)
 *   §2 零信号失败在 _recordAdapterFailure 里完全不落痕迹
 *   §3 内存 health store 的失败计数与 Redis 路径同样按 TTL 衰减(真正的「永久」根因)
 *   §4 冷却/退避默认值收口到 constants(F5),不再散落硬编码
 */

const path = require('path');
const fs = require('fs');

const { MemoryHealthStore } = require('../../src/services/gateway/redisHealthStore');

const SRC = path.join(__dirname, '..', '..', 'src');

// ── §1 no_provider:配置问题不再冒充「通道挂了」 ──────────────────────────────

describe('multiFreeService: 零 provider 时报 no_provider,而不是 All providers failed', () => {
  const MultiFreeService = require('../../src/services/multiFreeService');

  // 构造函数会读 env / 建 axios 客户端;这里只需要 generateResponse 的前半段,
  // 用 Object.create 绕过构造,只桩掉唯一被触达的 this 依赖 getAvailableProviders。
  const makeSvc = (providers) => {
    const svc = Object.create(MultiFreeService.prototype);
    svc.getAvailableProviders = () => providers;
    return svc;
  };

  test('env 里没有裸 key(全部 enabled:false)→ errorType no_provider', async () => {
    const res = await makeSvc([]).generateResponse('hi');
    expect(res.success).toBe(false);
    expect(res.errorType).toBe('no_provider');
    expect(res.attempts).toEqual([]);
    // 旧文案会被 fast-fail 缓存原样回显给用户,必须彻底消失
    expect(res.error).not.toMatch(/All providers failed/);
  });

  test('错误文案指向可操作的下一步(khy key list / khy model)', async () => {
    const res = await makeSvc([]).generateResponse('hi');
    expect(res.error).toMatch(/khy key list/);
    expect(res.error).toMatch(/khy model/);
  });

  test('有 provider 但全被前置条件跳过(如带图无 vision 支持)→ 仍进正常失败路径', async () => {
    // 这条守住边界:attempts 非空时**不能**被 no_provider 分支吞掉。
    const svc = makeSvc([
      { key: 'p1', name: 'P1', priority: 1, model: 'm', supportsVision: false },
    ]);
    const res = await svc.generateResponse('hi', { images: ['data:image/png;base64,AA'] });
    expect(res.errorType).not.toBe('no_provider');
    expect(res.attempts.length).toBe(1);
  });

  test('no_provider 刻意不进 transient 冷却表(零冷却,下一个请求立刻重判)', () => {
    const gw = require('../../src/services/gateway/aiGateway');
    if (typeof gw._transientCooldownMs !== 'function') return;
    expect(gw._transientCooldownMs('no_provider')).toBe(0);
  });
});

// ── §2 零信号失败:不落痕迹 ───────────────────────────────────────────────────

describe('_recordAdapterFailure: no_provider 是零信号失败,不留任何失败痕迹', () => {
  const cooldownLeaf = require('../../src/services/gateway/aiGatewayCooldownMethods');

  const makeGateway = () => {
    const gwMod = require('../../src/services/gateway/aiGateway');
    const AIGateway = gwMod.AIGateway || gwMod.default || gwMod;
    const proto = AIGateway.prototype || Object.getPrototypeOf(AIGateway);
    const calls = { incrFailure: 0, window: 0, outcome: 0, broadcast: [] };
    const gw = Object.create(proto);
    gw._adapterLastError = {};
    gw._adapterFailures = {};
    gw._adapterActivity = {};
    gw._adapterOutcomes = new Map();
    gw._fastFailProbeMeta = {};
    gw._cooldownSelfHealMeta = {};
    gw._cooldownSelfHealMidpointTimers = new Map();
    gw._lastAdapterFailureAt = {};
    gw._adapterFirstFailureAt = {};
    gw._resolveFastFailCooldownMs = () => 30000;
    gw._recordAdapterOutcome = () => {
      calls.outcome += 1;
    };
    gw._healthStore = {
      getFailureCount: async () => 0,
      incrFailure: async () => {
        calls.incrFailure += 1;
        return 1;
      },
      recordWindowOutcome: async () => {
        calls.window += 1;
        return { total: 1, failed: 1 };
      },
      getWindowStats: async () => ({ total: 0, failed: 0, rate: 0 }),
      recordLastError: async () => {},
      setCooldown: async () => {},
      isInCooldown: async () => false,
      getCooldownRemainingMs: async () => 0,
      setHalfOpenState: async () => {},
      clearHalfOpenState: async () => {},
      resetHalfOpen: async () => {},
    };
    gw._healthBroadcaster = {
      recordRequestActivity: (k, kind, type) => calls.broadcast.push([k, kind, type]),
    };
    return { gw, calls, proto };
  };

  test('mixin 已挂到 prototype 上(接线自检)', () => {
    const { proto } = makeGateway();
    expect(typeof proto._recordAdapterFailure).toBe('function');
    expect(typeof cooldownLeaf.setAiGatewayCooldownMethodsDeps).toBe('function');
  });

  test('不写 _adapterLastError / 不 incrFailure / 不进错误率窗口', async () => {
    const { gw, calls } = makeGateway();
    await gw._recordAdapterFailure('api', 'no_provider', 'no key configured');
    expect(gw._adapterLastError.api).toBeUndefined();
    expect(gw._adapterFailures.api).toBeUndefined();
    expect(calls.incrFailure).toBe(0);
    expect(calls.window).toBe(0);
    expect(calls.outcome).toBe(0);
  });

  test('仍然广播一次 failure(khy health 里看得见,不做静默丢弃)', async () => {
    const { gw, calls } = makeGateway();
    await gw._recordAdapterFailure('api', 'no_provider', 'no key configured');
    expect(calls.broadcast).toEqual([['api', 'failure', 'no_provider']]);
  });

  test('不会覆盖掉一条已存在的真实熔断记录(反向 bug 守卫)', async () => {
    const { gw } = makeGateway();
    const real = {
      at: Date.now(),
      errorType: 'auth',
      error: '401',
      cooldownMs: 300000,
      circuitOpen: true,
    };
    gw._adapterLastError.api = real;
    await gw._recordAdapterFailure('api', 'no_provider', 'no key configured');
    // 若零信号失败写了 lastError(circuitOpen:false),已开的熔断会被悄悄清掉。
    expect(gw._adapterLastError.api).toBe(real);
    expect(gw._adapterLastError.api.circuitOpen).toBe(true);
  });

  test('对照组:真实失败类型照旧完整记录(修复没有削弱正常熔断)', async () => {
    const { gw, calls } = makeGateway();
    await gw._recordAdapterFailure('api', 'server_error', '502 bad gateway');
    expect(gw._adapterLastError.api).toBeTruthy();
    expect(gw._adapterLastError.api.errorType).toBe('server_error');
    expect(calls.incrFailure).toBeGreaterThan(0);
    // 真实路径会挂一个自愈中点定时器;测试里必须收掉,否则 jest 留下 open handle。
    for (const v of gw._cooldownSelfHealMidpointTimers.values()) {
      if (v && v.timer) clearTimeout(v.timer);
    }
  });

  test('no_provider 被排除在 circuitEligible 之外(双保险,源码级)', () => {
    const src = fs.readFileSync(path.join(SRC, 'services', 'gateway', 'aiGatewayCooldownMethods.js'), 'utf-8');
    const m = src.match(/const circuitEligible =[\s\S]{0,400}?\]\.includes/);
    expect(m).toBeTruthy();
    expect(m[0]).toMatch(/'no_provider'/);
  });
});

// ── §3 真正的「永久」根因:内存 health store 的失败计数没有 TTL ────────────────

describe('MemoryHealthStore: 连续失败计数按 TTL 衰减(与 Redis 路径语义一致)', () => {
  // 过期戳直接推到过去,避免依赖真实等待或 fake timer。
  const expire = (store, key) => {
    store._failureExpiry[key] = Date.now() - 1;
  };

  test('正常累加(既有行为不变)', async () => {
    const store = new MemoryHealthStore();
    expect(await store.incrFailure('a')).toBe(1);
    expect(await store.incrFailure('a')).toBe(2);
    expect(await store.getFailureCount('a')).toBe(2);
  });

  test('incrFailure 写入过期戳(不再是永生记录)', async () => {
    const store = new MemoryHealthStore();
    await store.incrFailure('a');
    expect(typeof store._failureExpiry.a).toBe('number');
    expect(store._failureExpiry.a).toBeGreaterThan(Date.now());
  });

  test('过期后 getFailureCount 归零', async () => {
    const store = new MemoryHealthStore();
    await store.incrFailure('a');
    await store.incrFailure('a');
    expire(store, 'a');
    expect(await store.getFailureCount('a')).toBe(0);
  });

  test('过期后 incrFailure 从 1 重新开始 —— 这是「永久失败」的根因所在', async () => {
    const store = new MemoryHealthStore();
    for (let i = 0; i < 9; i += 1) await store.incrFailure('a');
    expect(await store.getFailureCount('a')).toBe(9);
    expire(store, 'a');
    // 修复前:返回 10,连续失败数只增不减 → 之后**任意一次**失败都直接撞熔断阈值,
    // 且退避早已饱和到 300s 上限 → 通道再也回不来。
    expect(await store.incrFailure('a')).toBe(1);
  });

  test('滑动续期:每次失败都把过期时间往后推', async () => {
    const store = new MemoryHealthStore();
    await store.incrFailure('a');
    const first = store._failureExpiry.a;
    store._failureExpiry.a = first - 5000; // 模拟时间流逝
    await store.incrFailure('a');
    expect(store._failureExpiry.a).toBeGreaterThan(first - 5000);
  });

  test('clearFailure 连过期戳一起删(不留悬挂键)', async () => {
    const store = new MemoryHealthStore();
    await store.incrFailure('a');
    await store.clearFailure('a');
    expect(store._failureExpiry.a).toBeUndefined();
    expect(await store.getFailureCount('a')).toBe(0);
  });

  test('getAllAdapterStates.failureCount 同样尊重过期', async () => {
    const store = new MemoryHealthStore();
    await store.incrFailure('a');
    expire(store, 'a');
    const states = await store.getAllAdapterStates(['a']);
    expect(states.a.failureCount).toBe(0);
  });

  test('cleanup 清掉失效 key 的过期戳', async () => {
    const store = new MemoryHealthStore();
    await store.incrFailure('gone');
    await store.incrFailure('kept');
    store.cleanup(['kept']);
    expect(store._failureExpiry.gone).toBeUndefined();
    expect(store._failureExpiry.kept).toBeDefined();
  });

  test('Redis 镜像回内存时也带过期戳(否则镜像会造出永生记录)', async () => {
    const store = new MemoryHealthStore();
    expect(typeof store._mirrorFailureCount).toBe('function');
    store._mirrorFailureCount('a', 7);
    expect(await store.getFailureCount('a')).toBe(7);
    expect(store._failureExpiry.a).toBeGreaterThan(Date.now());
  });

  test('两条路径共用同一个 TTL 常量,不会再各自漂移', () => {
    const src = fs.readFileSync(path.join(SRC, 'services', 'gateway', 'redisHealthStore.js'), 'utf-8');
    // Redis 侧不得再出现写死的 expire(key, 300)
    expect(src).not.toMatch(/client\.expire\(key,\s*300\)/);
    expect(src).toMatch(/client\.expire\(key,\s*FAILURE_TTL_SEC\)/);
    expect(src).toMatch(/GATEWAY_FAILURE_COUNT_TTL_MS/);
  });
});

// ── §4 F5:冷却/退避默认值收口到 constants ────────────────────────────────────

describe('API key 池冷却参数是单一真源(F5:不许散落硬编码)', () => {
  const defaults = require('../../src/constants/serviceDefaults');

  test('serviceDefaults 导出 API_KEY_POOL 且被冻结', () => {
    expect(defaults.API_KEY_POOL).toBeTruthy();
    expect(Object.isFrozen(defaults.API_KEY_POOL)).toBe(true);
  });

  test('默认值与修复前逐字节一致(纯搬家,不改行为)', () => {
    const p = defaults.API_KEY_POOL;
    expect(p.BASE_COOLDOWN_MS).toBe(10000);
    expect(p.MAX_COOLDOWN_MS).toBe(300000);
    expect(p.MAX_BACKOFF_LEVEL).toBe(5);
    expect(p.MAX_RETRY_AFTER_MS).toBe(600000);
  });

  test('退避级数封顶后不超过 MAX_COOLDOWN_MS', () => {
    const p = defaults.API_KEY_POOL;
    const at = (level) =>
      Math.min(p.MAX_COOLDOWN_MS, p.BASE_COOLDOWN_MS * Math.pow(2, level - 1));
    expect(at(1)).toBe(10000);
    expect(at(p.MAX_BACKOFF_LEVEL)).toBeLessThanOrEqual(p.MAX_COOLDOWN_MS);
  });

  test('apiKeyPool.js 不再内联这些字面量(否则 env 覆盖形同虚设)', () => {
    const src = fs.readFileSync(path.join(SRC, 'services', 'apiKeyPool.js'), 'utf-8');
    expect(src).toMatch(/API_KEY_POOL/);
    // 常量定义处必须是别名引用,不能是数字字面量
    expect(src).not.toMatch(/const BASE_COOLDOWN_MS\s*=\s*\d/);
    expect(src).not.toMatch(/const MAX_COOLDOWN_MS\s*=\s*\d/);
    expect(src).not.toMatch(/const MAX_BACKOFF_LEVEL\s*=\s*\d/);
    expect(src).not.toMatch(/const MAX_RETRY_AFTER_MS\s*=\s*\d/);
  });

  test('四个参数都能被 env 覆盖(用户不必改代码重装才能调冷却)', () => {
    for (const name of [
      'KHY_API_KEY_POOL_BASE_COOLDOWN_MS',
      'KHY_API_KEY_POOL_MAX_COOLDOWN_MS',
      'KHY_API_KEY_POOL_MAX_BACKOFF_LEVEL',
      'KHY_API_KEY_POOL_MAX_RETRY_AFTER_MS',
    ]) {
      const src = fs.readFileSync(path.join(SRC, 'constants', 'serviceDefaults.js'), 'utf-8');
      expect(src).toMatch(new RegExp(name));
    }
  });
});

// ── §5 无法恢复:熔断态必须保留 half-open 真实流量通路 ─────────────────────────

describe('熔断态下仍放行 half-open 真实尝试(否则没有任何恢复路径)', () => {
  const GEN = path.join(SRC, 'services', 'gateway', 'aiGatewayGenerateMethod.js');

  test('探测放行不再被 circuitOpen 一刀切否决', () => {
    const src = fs.readFileSync(GEN, 'utf-8');
    // 修复前的条件:_probeTypes.includes(_cachedType) && cached.circuitOpen !== true
    expect(src).not.toMatch(/_probeTypes\.includes\(_cachedType\)\s*&&\s*cached\.circuitOpen !== true/);
    expect(src).toMatch(/_probeTypes\.includes\(_cachedType\)\s*&&\s*\(!_circuitOpen \|\| _halfOpenMs > 0\)/);
  });

  test('熔断态的探测间隔被夹到 half-open 窗口(300s 冷却 ≠ 300s 才试一次)', () => {
    const src = fs.readFileSync(GEN, 'utf-8');
    expect(src).toMatch(/Math\.min\(_probeWindowMs,\s*_halfOpenMs\)/);
  });

  test('KHY_CIRCUIT_HALF_OPEN_PROBE_MS 可调,显式 0 = 回到旧行为', () => {
    const src = fs.readFileSync(GEN, 'utf-8');
    expect(src).toMatch(/KHY_CIRCUIT_HALF_OPEN_PROBE_MS/);
    // 非法值必须回落默认而不是变成 0(否则一个笔误就把恢复通路关掉)
    expect(src).toMatch(/Number\.isFinite\(_halfOpenParsed\)\s*&&\s*_halfOpenParsed >= 0\s*\?\s*_halfOpenParsed\s*:\s*30000/);
  });

  test('探测时间戳同步写入,封死同窗口并发放行', () => {
    const src = fs.readFileSync(GEN, 'utf-8');
    expect(src).toMatch(/_meta\.lastProbeAt = Date\.now\(\);/);
  });
});

// ── §6 归因:一把没出手的 key 不该被记失败 ────────────────────────────────────

describe('apiAdapter: no_provider 不记到 key 的 totalFailures 上', () => {
  test('_poolMark 被 no_provider 显式跳过', () => {
    const src = fs.readFileSync(
      path.join(SRC, 'services', 'gateway', 'adapters', 'apiAdapter.js'),
      'utf-8'
    );
    expect(src).toMatch(/resolvedErrorType !== 'no_provider'/);
  });
});
