'use strict';

/**
 * contextZhLabels — /context 交互中文面对齐回归守卫。
 *
 * 背景(goal 2026-07-03「TUI 工具体验不如 cc·不只是 clear」):route() 的 `case 'context'`
 * 是 **Ink TUI** 键入 /context 的落点(REPL 在 route() 之前就用中文孪生拦了 /context,故这条
 * 路径只有 TUI 可见)。此前它印**英文**标签(Context Window / Used / Remaining / Session),
 * 而 REPL 键入 /context 孪生印**中文**(上下文窗口 / 已使用 / 剩余 / 会话令牌)——同一命令、
 * 同一 computeContextStats SSOT,两套语言体验。本测锁定门控 KHY_CONTEXT_ZH_LABELS:
 * 默认/开 → 中文标签(与 REPL 孪生逐字对齐);关 → 逐字节回退英文标签。
 *
 * 用 route() 真实执行 + 捕获 console.log(hudRenderer.getState() 在空会话下给确定性 0 值)。
 */

const { describe, test, expect, beforeEach, afterEach } = require('@jest/globals');

function captureContext(env) {
  const { parseInput, route } = require('../../src/cli/router');
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  // 门控值注入到 process.env(route 读 process.env)。
  const prev = process.env.KHY_CONTEXT_ZH_LABELS;
  if (env === undefined) delete process.env.KHY_CONTEXT_ZH_LABELS;
  else process.env.KHY_CONTEXT_ZH_LABELS = env;
  return route(parseInput('/context'))
    .then(() => lines.join('\n'))
    .finally(() => {
      console.log = orig;
      if (prev === undefined) delete process.env.KHY_CONTEXT_ZH_LABELS;
      else process.env.KHY_CONTEXT_ZH_LABELS = prev;
    });
}

describe('/context 交互中文面对齐(KHY_CONTEXT_ZH_LABELS)', () => {
  test('默认(未设)→ 中文标签,与 REPL 孪生逐字对齐', async () => {
    const out = await captureContext(undefined);
    expect(out).toContain('上下文窗口');
    expect(out).toContain('已使用:');
    expect(out).toContain('令牌');
    expect(out).toContain('剩余:');
    expect(out).toContain('会话令牌:');
    // 不再出现英文标签。
    expect(out).not.toContain('Context Window:');
    expect(out).not.toMatch(/\bUsed:/);
    expect(out).not.toMatch(/\bRemaining:/);
  });

  test('显式开(on/1/true)→ 中文标签', async () => {
    for (const v of ['on', '1', 'true']) {
      const out = await captureContext(v);
      expect(out).toContain('上下文窗口');
      expect(out).not.toContain('Context Window:');
    }
  });

  test('健康分级词用中文(健康/偏高/接近上限 之一)', async () => {
    const out = await captureContext(undefined);
    expect(out).toMatch(/健康|偏高|接近上限/);
  });

  test('门控关(off/0/false/no/disable/disabled)→ 逐字节回退英文标签', async () => {
    for (const v of ['off', '0', 'false', 'no', 'disable', 'disabled']) {
      const out = await captureContext(v);
      expect(out).toContain('Context Window:');
      expect(out).toContain('Used:');
      expect(out).toContain('Remaining:');
      expect(out).toContain('Session:');
      // 中文标签不出现(回退干净)。
      expect(out).not.toContain('上下文窗口');
    }
  });
});
