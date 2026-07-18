'use strict';

/**
 * headlessNativeLoop.routing.test.js — 回归:headless `khy -p` 走真·工具循环的路由判决。
 *
 * 背景 bug(dogfood 实测):bin/khy.js 的 headless `-p` 分支直接 `await chat(prompt,…)`,而
 * ai.chat 是**单次模型调用核心**(内层 NL 循环),不进 runToolUseLoop。故模型请求原生工具时
 * 只吐 `[模型请求执行工具: NAME]` 占位串当回复、num_turns 恒 1、全部 toolUseLoop 注入引导失效。
 *
 * 修:门控 KHY_HEADLESS_NATIVE_LOOP(default-on·CANON)开时经 runToolUseLoop(chatFn 关内层
 * NL 循环、外层 loop 主导工具执行),loopResult.finalResponse → render 消费的 result.reply。
 * 关/loop 不可用/异常 → fail-soft 逐字节回退单发 chat()。
 *
 * 本测试复现 bin/khy.js 的路由判决(不拉起整个 CLI main),锁定契约:
 *   ① 门开 + loop 可用 → 经 loop,finalResponse→reply 映射
 *   ② 门关 → 不经 loop(回退单发)
 *   ③ loop 不可用 / 抛错 → fail-soft 回退单发
 */

const flagRegistry = require('../src/services/flagRegistry');

/**
 * 复现 bin/khy.js headless 路由块的判决 + 结果映射(仅 Fix C 相关部分)。
 * 返回 { routed:boolean, result } —— routed=true 表示走了 loop,result 为映射后的 chatResult 形。
 */
async function routeHeadless({ env, prompt, maxTurns, chat, toolUseLoop }) {
  const systemPrompt = null;
  const appendSystemPrompt = null;
  let result = null;

  let useHeadlessLoop = false;
  try {
    useHeadlessLoop = flagRegistry.isFlagEnabled('KHY_HEADLESS_NATIVE_LOOP', env);
  } catch { useHeadlessLoop = false; }

  if (useHeadlessLoop) {
    try {
      if (toolUseLoop && typeof toolUseLoop.runToolUseLoop === 'function' && toolUseLoop.isEnabled()) {
        const chatFn = (message, chatOpts = {}) => chat(message, {
          ...chatOpts,
          disableNaturalToolLoop: true,
          onChunk: null,
          systemPrompt,
          appendSystemPrompt,
        });
        const loopResult = await toolUseLoop.runToolUseLoop(prompt, {
          chat: chatFn,
          chatOpts: { systemPrompt, appendSystemPrompt },
          ...(maxTurns ? { maxIterations: maxTurns } : {}),
        });
        result = {
          reply: loopResult && loopResult.finalResponse,
          provider: loopResult && loopResult.provider,
          adapter: loopResult && loopResult.adapter,
          model: loopResult && loopResult.model,
          tokenUsage: loopResult && loopResult.tokenUsage,
          toolCallLog: loopResult && loopResult.toolCallLog,
          errorType: loopResult && loopResult.errorType,
          stopReason: loopResult && loopResult.stopReason,
          elapsed: loopResult && loopResult.elapsed,
        };
        return { routed: true, result };
      }
    } catch { result = null; }
  }
  if (!result) {
    result = await chat(prompt, { onChunk: null, maxTurns, systemPrompt, appendSystemPrompt });
    return { routed: false, result };
  }
  return { routed: true, result };
}

describe('headless `khy -p` 原生工具循环路由(Fix C)', () => {
  test('门开 + loop 可用 → 经 runToolUseLoop,finalResponse→reply 映射', async () => {
    const chat = jest.fn().mockResolvedValue({ reply: 'single-shot(不该走到)' });
    const runToolUseLoop = jest.fn().mockResolvedValue({
      finalResponse: 'loop 完成:version 0.1.161',
      provider: 'p', tokenUsage: { t: 1 }, toolCallLog: [{}, {}], iterations: 2,
    });
    const toolUseLoop = { runToolUseLoop, isEnabled: () => true };

    const { routed, result } = await routeHeadless({
      env: {}, prompt: '读 package.json 的 version', maxTurns: 5, chat, toolUseLoop,
    });

    expect(routed).toBe(true);
    expect(runToolUseLoop).toHaveBeenCalledTimes(1);
    expect(chat).not.toHaveBeenCalled(); // 直接 chat() 不该被调(chatFn 才是 loop 的入口)
    expect(result.reply).toBe('loop 完成:version 0.1.161');
    expect(result.tokenUsage).toEqual({ t: 1 });
    // maxTurns→maxIterations 透传
    expect(runToolUseLoop.mock.calls[0][1].maxIterations).toBe(5);
  });

  test('loop 内 chatFn 禁内层 NL 循环(disableNaturalToolLoop=true)', async () => {
    const chat = jest.fn().mockResolvedValue({ reply: 'x' });
    // runToolUseLoop 真的调一次 chatFn,以断言其透传的 chatOpts。
    const runToolUseLoop = jest.fn(async (msg, opts) => {
      await opts.chat('turn-1', {});
      return { finalResponse: 'done' };
    });
    const toolUseLoop = { runToolUseLoop, isEnabled: () => true };

    await routeHeadless({ env: {}, prompt: 'q', maxTurns: null, chat, toolUseLoop });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(chat.mock.calls[0][1].disableNaturalToolLoop).toBe(true);
    expect(chat.mock.calls[0][1].onChunk).toBeNull();
  });

  test('门关 KHY_HEADLESS_NATIVE_LOOP → 不经 loop,回退单发 chat()(逐字节回退)', async () => {
    const chat = jest.fn().mockResolvedValue({ reply: 'single-shot' });
    const runToolUseLoop = jest.fn();
    const toolUseLoop = { runToolUseLoop, isEnabled: () => true };

    const { routed, result } = await routeHeadless({
      env: { KHY_HEADLESS_NATIVE_LOOP: '0' }, prompt: 'q', maxTurns: null, chat, toolUseLoop,
    });

    expect(routed).toBe(false);
    expect(runToolUseLoop).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.reply).toBe('single-shot');
  });

  test('loop.isEnabled() 关 → 回退单发', async () => {
    const chat = jest.fn().mockResolvedValue({ reply: 'single-shot' });
    const runToolUseLoop = jest.fn();
    const toolUseLoop = { runToolUseLoop, isEnabled: () => false };

    const { routed } = await routeHeadless({ env: {}, prompt: 'q', maxTurns: null, chat, toolUseLoop });

    expect(routed).toBe(false);
    expect(runToolUseLoop).not.toHaveBeenCalled();
    expect(chat).toHaveBeenCalledTimes(1);
  });

  test('loop 抛错 → fail-soft 回退单发(不冒泡)', async () => {
    const chat = jest.fn().mockResolvedValue({ reply: 'single-shot' });
    const runToolUseLoop = jest.fn().mockRejectedValue(new Error('loop boom'));
    const toolUseLoop = { runToolUseLoop, isEnabled: () => true };

    const { routed, result } = await routeHeadless({ env: {}, prompt: 'q', maxTurns: null, chat, toolUseLoop });

    expect(routed).toBe(false);
    expect(result.reply).toBe('single-shot');
  });

  test('loop 模块不可用(runToolUseLoop 非函数)→ 回退单发', async () => {
    const chat = jest.fn().mockResolvedValue({ reply: 'single-shot' });
    const toolUseLoop = { runToolUseLoop: null, isEnabled: () => true };

    const { routed } = await routeHeadless({ env: {}, prompt: 'q', maxTurns: null, chat, toolUseLoop });

    expect(routed).toBe(false);
    expect(chat).toHaveBeenCalledTimes(1);
  });
});
