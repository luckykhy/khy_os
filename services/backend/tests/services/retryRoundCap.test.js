'use strict';

/**
 * 「出错后的重试必须有限,且不超过 10 轮」——跨入口的不变量守卫。
 *
 * 背景(用户诉求「错误出现 khy 应该尝试 10 轮之内的有限重试」):本仓四条重试入口
 * 原来的轮次预算**只有下界没有上界**:
 *   - services/retryWithBackoff.js       `Math.max(1, Math.floor(attempts))`
 *   - services/retryWithBackoff.js       persistentRetry() 是 `while (true)`,只有 6h 墙钟
 *   - gateway/adapters/_retryWithBackoff  `maxAttempts = 3`,无上界
 *   - utils/retry.js                     `maxRetries = 3`,无上界
 * 于是一个手滑的 env(KHY_HARNESS_RETRY_ATTEMPTS=999)或一次持续 429,就能让请求悬在
 * 「自动恢复 37/999」上,既不成功也不报错。现在四处一律经
 * constants/retryBudget.clampRetryRounds 封顶。
 *
 * 本套件断言的是**实际执行轮数**(数 fn 被调了几次),而不是配置值 —— 配置被 clamp 了
 * 但循环边界忘了换,是这类改动最典型的漏法。
 */

const { MAX_RETRY_ROUNDS, clampRetryRounds } = require('../../src/constants/retryBudget');
const adapterRetry = require('../../src/services/gateway/adapters/_retryWithBackoff');
const {
  retryWithBackoff,
  persistentRetry,
  PERSISTENT_MIN_DELAY_MS,
  MAX_RETRY_ROUNDS: reexported,
} = require('../../src/services/retryWithBackoff');
const utilsRetry = require('../../src/utils/retry');

describe('constants/retryBudget.clampRetryRounds', () => {
  test('上界就是 MAX_RETRY_ROUNDS,且它是 10', () => {
    expect(MAX_RETRY_ROUNDS).toBe(10);
    expect(clampRetryRounds(999)).toBe(MAX_RETRY_ROUNDS);
    expect(clampRetryRounds(Number.MAX_SAFE_INTEGER)).toBe(MAX_RETRY_ROUNDS);
    expect(clampRetryRounds(Infinity)).toBe(MAX_RETRY_ROUNDS);
  });

  test('合法轮次原样透传,不被抬升', () => {
    expect(clampRetryRounds(1)).toBe(1);
    expect(clampRetryRounds(3)).toBe(3);
    expect(clampRetryRounds(10)).toBe(10);
  });

  test('数字型坏输入就地收敛(保持旧行为),非数字才回退', () => {
    expect(clampRetryRounds(0)).toBe(1); // 旧 Math.max(1, 0) 也是 1
    expect(clampRetryRounds(-5)).toBe(1);
    expect(clampRetryRounds(2.9)).toBe(2);
    expect(clampRetryRounds(NaN, 3)).toBe(3);
    expect(clampRetryRounds('abc', 3)).toBe(3);
    expect(clampRetryRounds(undefined, 3)).toBe(3);
    expect(clampRetryRounds(undefined, 999)).toBe(MAX_RETRY_ROUNDS); // 回退值自身也受封顶
  });

  test('retryWithBackoff 转出同一个常量(不许各自维护一份)', () => {
    expect(reexported).toBe(MAX_RETRY_ROUNDS);
  });
});

describe('retryWithBackoff 轮次封顶', () => {
  test('attempts=999 实际只跑 MAX_RETRY_ROUNDS 轮', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      retryWithBackoff(fn, { attempts: 999, minDelayMs: 1, maxDelayMs: 2, jitter: 0 })
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ROUNDS);
  });

  test('onRetry 报出的 maxAttempts 是收敛后的真值,不是请求值', async () => {
    const seen = [];
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      retryWithBackoff(fn, {
        attempts: 999,
        minDelayMs: 1,
        maxDelayMs: 2,
        jitter: 0,
        onRetry: (info) => seen.push(info.maxAttempts),
      })
    ).rejects.toThrow('boom');
    // 进度条不能承诺 999 —— 那是做不到的数(状态透明红线)。
    expect(new Set(seen)).toEqual(new Set([MAX_RETRY_ROUNDS]));
    expect(seen).toHaveLength(MAX_RETRY_ROUNDS - 1);
  });

  test('小于上界的预算不受影响(只封顶不抬升)', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(
      retryWithBackoff(fn, { attempts: 3, minDelayMs: 1, maxDelayMs: 2, jitter: 0 })
    ).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('attempts 是坏值时回落 DEFAULT_ATTEMPTS,而不是静默返回 undefined', async () => {
    // 旧实现 Math.max(1, Math.floor(NaN)) = NaN,`1 <= NaN` 为假 → 循环一次都不进,
    // 函数隐式返回 undefined。调用方把 undefined 当成功用,比抛错更坏。
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(retryWithBackoff(fn, { attempts: NaN })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('persistentRetry 不再是无限重试', () => {
  // 用 Retry-After 把每轮等待压到 1ms:persistentRetry 的退避起点是 20s,真等一遍要
  // 半小时。服务端指定的延迟优先级更高,正好当测试夹具。
  const capacityErr = () =>
    Object.assign(new Error('overloaded'), { status: 429, retryAfter: 0.001 });

  test('容量错误持续存在时,轮次用尽即抛错(而非 while(true) 挂死)', async () => {
    const fn = jest.fn().mockImplementation(() => Promise.reject(capacityErr()));
    await expect(persistentRetry(fn, { label: 'test' })).rejects.toThrow(
      new RegExp(`exhausted ${MAX_RETRY_ROUNDS}/${MAX_RETRY_ROUNDS} rounds`)
    );
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ROUNDS);
  });

  test('maxRounds 只能往小调,不能突破上界', async () => {
    const few = jest.fn().mockImplementation(() => Promise.reject(capacityErr()));
    await expect(persistentRetry(few, { maxRounds: 3 })).rejects.toThrow('exhausted 3/3 rounds');
    expect(few).toHaveBeenCalledTimes(3);

    const many = jest.fn().mockImplementation(() => Promise.reject(capacityErr()));
    await expect(persistentRetry(many, { maxRounds: 999 })).rejects.toThrow(
      `exhausted ${MAX_RETRY_ROUNDS}/${MAX_RETRY_ROUNDS} rounds`
    );
    expect(many).toHaveBeenCalledTimes(MAX_RETRY_ROUNDS);
  });

  test('轮次内恢复成功就照常返回,封顶不影响自愈', async () => {
    let n = 0;
    const fn = jest.fn().mockImplementation(() => {
      n += 1;
      return n < 3 ? Promise.reject(capacityErr()) : Promise.resolve('recovered');
    });
    await expect(persistentRetry(fn)).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  test('onRetry 带上 maxAttempts,调用方能渲染「N/10 轮」', async () => {
    const seen = [];
    const fn = jest.fn().mockImplementation(() => Promise.reject(capacityErr()));
    await expect(
      persistentRetry(fn, {
        maxRounds: 2,
        onRetry: (i) => seen.push(`${i.attempt}/${i.maxAttempts}`),
      })
    ).rejects.toThrow('exhausted 2/2 rounds');
    expect(seen).toEqual(['1/2']);
  });

  test('退避起点抬到 20s:容量类错误不该 300ms 后就再撞一次', () => {
    expect(PERSISTENT_MIN_DELAY_MS).toBe(20_000);
  });
});

describe('gateway/adapters/_retryWithBackoff 轮次封顶', () => {
  test('maxAttempts=999 实际只跑 MAX_RETRY_ROUNDS 轮', async () => {
    const fn = jest.fn().mockImplementation(() => Promise.reject(new Error('socket hang up')));
    await expect(
      adapterRetry.retryWithBackoff(fn, { maxAttempts: 999, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow('socket hang up');
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ROUNDS);
  });

  test('传给 fn 的 maxAttempts 也是收敛后的真值', async () => {
    const seen = [];
    const fn = jest.fn().mockImplementation(({ maxAttempts }) => {
      seen.push(maxAttempts);
      return Promise.reject(new Error('socket hang up'));
    });
    await expect(
      adapterRetry.retryWithBackoff(fn, { maxAttempts: 42, baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow('socket hang up');
    expect(new Set(seen)).toEqual(new Set([MAX_RETRY_ROUNDS]));
  });

  test('默认 3 轮不受影响', async () => {
    const fn = jest.fn().mockImplementation(() => Promise.reject(new Error('socket hang up')));
    await expect(
      adapterRetry.retryWithBackoff(fn, { baseDelayMs: 1, maxDelayMs: 2 })
    ).rejects.toThrow('socket hang up');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('utils/retry 轮次封顶', () => {
  // maxRetries 数的是额外次数,总轮次 = maxRetries + 1。
  test('maxRetries=999 实际只跑 MAX_RETRY_ROUNDS 轮', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(utilsRetry(fn, 999, 1)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(MAX_RETRY_ROUNDS);
  });

  test('小预算原样保留:maxRetries=2 → 3 轮,0 → 1 轮', async () => {
    const two = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(utilsRetry(two, 2, 1)).rejects.toThrow('boom');
    expect(two).toHaveBeenCalledTimes(3);

    const none = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(utilsRetry(none, 0, 1)).rejects.toThrow('boom');
    expect(none).toHaveBeenCalledTimes(1);
  });
});
