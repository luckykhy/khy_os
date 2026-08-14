'use strict';

/**
 * E2E tests for gateway/refusalRecovery.recover() — 用 mock generate 驱动完整编排:
 * 首轮拆分 JSON → 逐步答案 → 聚合;并验证子步骤携带 `_refusalDecomposeDepth` 递归保护。
 * 不触真实网关/适配器,recover 只依赖注入的 generate。
 */

const rr = require('../../src/services/gateway/refusalRecovery');

/**
 * 构造一个 mock generate:第 1 次返回拆分 JSON,之后每次按步骤返回答案。
 * 记录每次调用的 (prompt, options) 以便断言递归保护。
 */
function makeMockGenerate(decomposeJson, stepAnswers) {
  const calls = [];
  let callIndex = 0;
  const generate = async (prompt, options = {}) => {
    calls.push({ prompt, options });
    const idx = callIndex++;
    if (idx === 0) {
      return {
        success: true,
        content: decomposeJson,
        model: 'mock-model',
        tokenUsage: { inputTokens: 20, outputTokens: 10 },
      };
    }
    const ans = stepAnswers[idx - 1] || '（无内容）';
    return {
      success: true,
      content: ans,
      model: 'mock-model',
      tokenUsage: { inputTokens: 5, outputTokens: 8 },
    };
  };
  return { generate, calls };
}

describe('recover — 端到端编排', () => {
  test('拆分 → 逐步重执 → 聚合,返回 content/stepCount/tokenUsage', async () => {
    const decompose = '[{"title":"调研","step":"收集资料"},{"title":"撰写","step":"起草正文"}]';
    const { generate, calls } = makeMockGenerate(decompose, ['调研结果', '正文草稿']);
    const statuses = [];

    const out = await rr.recover({
      originalPrompt: '帮我写一篇关于春天的文章',
      options: {},
      emitStatus: (t) => statuses.push(t),
      // 模拟网关注入的递归保护 generate 包装
      generate: (p, o) => generate(p, { ...o, _refusalDecomposeDepth: 1 }),
    });

    expect(out).not.toBeNull();
    expect(out.stepCount).toBe(2);
    expect(out.content).toContain('调研结果');
    expect(out.content).toContain('正文草稿');
    expect(out.content).toContain('第 1 步');
    expect(out.content).toContain('第 2 步');
    // token 合并:20+10(拆分) + 2*(5+8)(两步)
    expect(out.tokenUsage.inputTokens).toBe(20 + 5 + 5);
    expect(out.tokenUsage.outputTokens).toBe(10 + 8 + 8);

    // 状态文案遵循「动作+目标+进度」,含 i/N 计数
    expect(statuses.some((s) => /第 1\/2 步/.test(s))).toBe(true);
    expect(statuses.some((s) => /第 2\/2 步/.test(s))).toBe(true);
  });

  test('递归保护:所有子调用都携带 _refusalDecomposeDepth,子步骤不会再触发检测', async () => {
    const decompose = '[{"title":"a","step":"do a"},{"title":"b","step":"do b"}]';
    const { generate, calls } = makeMockGenerate(decompose, ['ans a', 'ans b']);

    const out = await rr.recover({
      originalPrompt: '一个合理的请求',
      options: {},
      emitStatus: () => {},
      generate: (p, o) => generate(p, { ...o, _refusalDecomposeDepth: 1 }),
    });

    expect(out).not.toBeNull();
    // 拆分 1 次 + 2 步 = 3 次调用
    expect(calls).toHaveLength(3);
    // 每次调用都带递归保护标记
    for (const c of calls) {
      expect(c.options._refusalDecomposeDepth).toBe(1);
    }
  });

  test('拆分结果 < 2 步 → 返回 null(不介入)', async () => {
    const { generate } = makeMockGenerate('[{"title":"only","step":"one"}]', []);
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate: (p, o) => generate(p, { ...o, _refusalDecomposeDepth: 1 }),
    });
    expect(out).toBeNull();
  });

  test('拆分调用失败 → 返回 null(fail-soft)', async () => {
    const generate = async () => ({ success: false, content: '' });
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate,
    });
    expect(out).toBeNull();
  });

  test('generate 抛异常 → 返回 null(绝不抛给调用方)', async () => {
    const generate = async () => { throw new Error('boom'); };
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate,
    });
    expect(out).toBeNull();
  });

  test('流式:命中恢复先发 reset,再逐步转发子步骤 chunk', async () => {
    const decompose = '[{"title":"a","step":"do a"},{"title":"b","step":"do b"}]';
    // mock generate 在 step 调用时通过 options.onChunk 吐出 chunk
    let callIndex = 0;
    const generate = async (prompt, options = {}) => {
      const idx = callIndex++;
      if (idx === 0) {
        return { success: true, content: decompose, tokenUsage: null };
      }
      if (typeof options.onChunk === 'function') {
        options.onChunk({ type: 'text', text: `chunk-${idx}` });
      }
      return { success: true, content: `ans-${idx}`, tokenUsage: null };
    };

    const forwarded = [];
    let resetCount = 0;

    const out = await rr.recover({
      originalPrompt: '合理请求',
      options: {},
      emitStatus: () => {},
      generate: (p, o) => generate(p, { ...o, _refusalDecomposeDepth: 1 }),
      forwardChunk: (chunk) => forwarded.push(chunk),
      emitReset: () => { resetCount++; },
    });

    expect(out).not.toBeNull();
    expect(resetCount).toBe(1);
    // 两步各转发一帧
    expect(forwarded.filter((c) => c && c.type === 'text')).toHaveLength(2);
  });
});

// FIX 4 — emitReset 延迟到拆分成功且 parseSteps >=2 步之后才触发。
// 拆分/解析失败时 recover 返回 null、调用方保留原拒绝 —— 此时绝不能先发 reset。
describe('recover — reset 延迟提交(FIX 4)', () => {
  test('拆分调用失败 → 返回 null 且从不发 reset', async () => {
    let resetCount = 0;
    const generate = async () => ({ success: false, content: '' });
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate,
      emitReset: () => { resetCount++; },
    });
    expect(out).toBeNull();
    expect(resetCount).toBe(0);
  });

  test('拆分结果 < 2 步 → 返回 null 且从不发 reset', async () => {
    let resetCount = 0;
    const { generate } = makeMockGenerate('[{"title":"only","step":"one"}]', []);
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate: (p, o) => generate(p, { ...o, _refusalDecomposeDepth: 1 }),
      emitReset: () => { resetCount++; },
    });
    expect(out).toBeNull();
    expect(resetCount).toBe(0);
  });

  test('generate 抛异常 → 返回 null 且从不发 reset', async () => {
    let resetCount = 0;
    const generate = async () => { throw new Error('boom'); };
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate,
      emitReset: () => { resetCount++; },
    });
    expect(out).toBeNull();
    expect(resetCount).toBe(0);
  });
});

// FIX 2 — MAX_RETRIES 每请求链上限:以下测试忠实复现网关 maybeRecoverFromRefusal 的门控
// 表达式(rr._resolveMaxRetries + _refusalRecoveryCount 计数 + 传递),验证契约。
describe('MAX_RETRIES 链上限门控契约(FIX 2)', () => {
  // 与 aiGatewayGenerateMethod.maybeRecoverFromRefusal 一致的门控:
  //   count = options._refusalRecoveryCount || 0;  if (count >= maxRetries) 短路。
  function shouldRecover(env, options) {
    const maxRetries = rr._resolveMaxRetries(env);
    const count = Number(options._refusalRecoveryCount) || 0;
    return count < maxRetries;
  }

  test('MAX_RETRIES=0 → 即便 detected 也永不恢复', () => {
    const env = { KHY_REFUSAL_RECOVERY_MAX_RETRIES: '0' };
    expect(shouldRecover(env, {})).toBe(false);
  });

  test('MAX_RETRIES=1 → 首轮恢复;子调用携带 count+1 后再次短路(至多一次)', () => {
    const env = { KHY_REFUSAL_RECOVERY_MAX_RETRIES: '1' };
    // 首轮:count=0 < 1 → 允许恢复
    expect(shouldRecover(env, {})).toBe(true);
    // 子调用传递 _refusalRecoveryCount = 0+1 = 1
    const subOptions = { _refusalRecoveryCount: 0 + 1 };
    // 下一链:count=1 >= 1 → 短路,保证至多一次恢复
    expect(shouldRecover(env, subOptions)).toBe(false);
  });
});

// FIX 4 — emitReset 延迟到拆分成功且 parseSteps >=2 步之后才触发。
// 拆分/解析失败时 recover 返回 null、调用方保留原拒绝 —— 此时绝不能先发 reset。
describe('recover — reset 延迟提交(FIX 4)', () => {
  test('拆分调用失败 → 返回 null 且从不发 reset', async () => {
    let resetCount = 0;
    const generate = async () => ({ success: false, content: '' });
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate,
      emitReset: () => { resetCount++; },
    });
    expect(out).toBeNull();
    expect(resetCount).toBe(0);
  });

  test('拆分结果 < 2 步 → 返回 null 且从不发 reset', async () => {
    let resetCount = 0;
    const { generate } = makeMockGenerate('[{"title":"only","step":"one"}]', []);
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate: (p, o) => generate(p, { ...o, _refusalDecomposeDepth: 1 }),
      emitReset: () => { resetCount++; },
    });
    expect(out).toBeNull();
    expect(resetCount).toBe(0);
  });

  test('generate 抛异常 → 返回 null 且从不发 reset', async () => {
    let resetCount = 0;
    const generate = async () => { throw new Error('boom'); };
    const out = await rr.recover({
      originalPrompt: 'x',
      options: {},
      emitStatus: () => {},
      generate,
      emitReset: () => { resetCount++; },
    });
    expect(out).toBeNull();
    expect(resetCount).toBe(0);
  });
});

// FIX 2 — MAX_RETRIES 每请求链上限:以下测试忠实复现网关 maybeRecoverFromRefusal 的门控
// 表达式(rr._resolveMaxRetries + _refusalRecoveryCount 计数 + 传递),验证契约。
describe('MAX_RETRIES 链上限门控契约(FIX 2)', () => {
  // 与 aiGatewayGenerateMethod.maybeRecoverFromRefusal 一致的门控:
  //   count = options._refusalRecoveryCount || 0;  if (count >= maxRetries) 短路。
  function shouldRecover(env, options) {
    const maxRetries = rr._resolveMaxRetries(env);
    const count = Number(options._refusalRecoveryCount) || 0;
    return count < maxRetries;
  }

  test('MAX_RETRIES=0 → 即便 detected 也永不恢复', () => {
    const env = { KHY_REFUSAL_RECOVERY_MAX_RETRIES: '0' };
    expect(shouldRecover(env, {})).toBe(false);
  });

  test('MAX_RETRIES=1 → 首轮恢复;子调用携带 count+1 后再次短路(至多一次)', () => {
    const env = { KHY_REFUSAL_RECOVERY_MAX_RETRIES: '1' };
    // 首轮:count=0 < 1 → 允许恢复
    expect(shouldRecover(env, {})).toBe(true);
    // 子调用传递 _refusalRecoveryCount = 0+1 = 1
    const subOptions = { _refusalRecoveryCount: 0 + 1 };
    // 下一链:count=1 >= 1 → 短路,保证至多一次恢复
    expect(shouldRecover(env, subOptions)).toBe(false);
  });
});
