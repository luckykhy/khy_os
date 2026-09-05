'use strict';

/**
 * 截断自动续跑回归(自然 REPL 循环,KHY_REPLY_TRUNCATION_RECOVERY):
 * 模型回复被 max_tokens 截断时,不再把「说『继续』」甩给用户,而是用
 * maxTokensRecovery 的成熟范式自动续写(尾锚 + 升级预算 + 收益递减守卫),
 * 直到写完或预算耗尽(耗尽时追加单一真源截断提示)。
 *
 * 设定:网关 mock 第一轮返回 stopReason='length' 的半截正文,续写轮返回
 * stopReason='stop' 的补全片段 → 最终回复应为两段无缝拼接、无截断提示。
 */

// 单测预算说明:每条用例 jest.resetModules() 后整树 require src/cli/ai(见
// aiCli.lightweightToolCuration.test.js 同款脚手架与预算说明)。
jest.setTimeout(120000);

function setupAiModule(generateImpl) {
  jest.resetModules();

  const calls = [];
  const gatewayGenerate = jest.fn(async (prompt, opts) => {
    calls.push({ prompt, opts: opts || {} });
    return generateImpl(calls.length, prompt, opts || {});
  });

  jest.doMock('../src/services/gateway/aiGateway', () => ({
    _initialized: true,
    isInitialized() {
      return this._initialized;
    },
    init: jest.fn(async () => {}),
    getStatus: jest.fn(() => []),
    getFirstAvailableAdapter: jest.fn(() => 'codex'),
    getActiveAdapter: jest.fn(() => null),
    generate: gatewayGenerate,
  }));

  jest.doMock('../src/services/traceAuditService', () => ({
    ensureDiagnosticsBridge: jest.fn(),
    attachTrace: jest.fn(),
    logEvent: jest.fn(),
  }));

  const ai = require('../src/cli/ai');
  return { ai, calls, gatewayGenerate };
}

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  jest.restoreAllMocks();
});

describe('natural-loop truncation auto-recovery', () => {
  test('truncated prose is continued automatically and delivered complete', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    delete process.env.KHY_REPLY_TRUNCATION_RECOVERY;

    const part1 = '夜色渐深，李明盯着屏幕上那行刺眼的红色报错信息，手指悬在键盘上方迟迟没有落下。';
    const part2 = '他知道，这一次的问题不在代码，而在那台沉默了三年的老服务器里。';
    const { ai, calls } = setupAiModule((n) => {
      if (n === 1) {
        return { success: true, content: part1, stopReason: 'length', provider: 'mock', adapter: 'mock' };
      }
      return { success: true, content: part2, stopReason: 'stop', provider: 'mock', adapter: 'mock' };
    });
    ai.clearHistory();

    const res = await ai.chat('讲个故事', {});

    // 续写确实发生(首次生成 + 至少一次续写轮)
    expect(calls.length).toBeGreaterThanOrEqual(2);
    // 两段无缝拼接(无分隔符 — 续写从中断处接着写)
    expect(res.reply).toBe(part1 + part2);
    // 写完了 → 不附带截断提示
    expect(res.reply).not.toContain('输出已达长度上限被截断');
  });

  test('continuation rounds are capped and exhaustion appends the honest notice', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    delete process.env.KHY_REPLY_TRUNCATION_RECOVERY;

    // 每一轮都「写满又被截断」:3 轮续写(KHY_LENGTH_RECOVERY_MAX_ATTEMPTS 默认 3)
    // 后放弃,回复末尾追加诚实提示(带已尝试段数)。
    const { ai, calls } = setupAiModule((n) => ({
      success: true,
      content: `第${n}段内容——这一段写得足够长，超过收益递减守卫的最小可见字符阈值，不会被当作空转的续写轮丢弃。`,
      stopReason: 'length',
      provider: 'mock',
      adapter: 'mock',
    }));
    ai.clearHistory();

    const res = await ai.chat('讲个故事', {});

    // 首次生成 + 3 轮续写
    expect(calls.length).toBe(4);
    expect(res.reply).toContain('输出已达长度上限被截断');
    expect(res.reply).toContain('已尝试续写 3 段');
  });

  test('kill switch KHY_REPLY_TRUNCATION_RECOVERY=off restores manual-continue behavior', async () => {
    delete process.env.KHY_GREETING_FASTPATH;
    process.env.KHY_REPLY_TRUNCATION_RECOVERY = 'off';

    const part1 = '夜色渐深，李明盯着屏幕上那行刺眼的红色报错信息，手指悬在键盘上方迟迟没有落下。';
    const { ai, calls } = setupAiModule(() => ({
      success: true,
      content: part1,
      stopReason: 'length',
      provider: 'mock',
      adapter: 'mock',
    }));
    ai.clearHistory();

    const res = await ai.chat('讲个故事', {});

    // 门关:只有首次生成,不续写;交付层 _annotateTruncation 兜底追加提示
    expect(calls.length).toBe(1);
    expect(res.reply).toContain(part1);
    expect(res.reply).toContain('输出已达长度上限被截断');
  });
});
