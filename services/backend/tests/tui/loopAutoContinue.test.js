'use strict';

/**
 * [DESIGN-ARCH-135] 三期回归 —— TUI 有界自动续跑。
 *
 * 病灶：TUI 直调 runToolUseLoop（绕过 agenticHarnessService），因此没有外层 Ralph 循环；
 * 而 loop 达到迭代上限 / 绝对超时时会带 `maxIterationsReached: true` 返回，TUI 只取
 * `finalResponse` 就把半路结果当终态 ⇒ 长任务停在半路且界面零提示。
 *
 * 本文件钉住续跑骨架的边界：何时续、何时**不**续、有界性、失败即停。
 * 策略函数本身来自 agenticHarnessService（同一批），此处用真实策略驱动，
 * 不做 mock —— 这样「策略改了导致 TUI 不再续跑」也会被这里捕获。
 *
 * 用 node:test：jest.config.js:57 会按 `require('node:test')` 把本文件排除出 jest 套件。
 */

const test = require('node:test');
const assert = require('node:assert');

const { runLoopRoundWithContinuation } = require('../../src/cli/tui/hooks/useQueryBridge');
const { DEFAULTS } = require('../../src/services/agenticHarnessService');

// 让 _shouldAutoContinue 为真：长度 > 200 且含动作性关键词。
const ACTION_MSG = `请帮我实现这个功能。${'需要覆盖边界情况并补测试。'.repeat(20)}`;
const SHORT_MSG = '你好';

test('#135-18 首轮正常结束（无 maxIterationsReached）→ 不续跑', async () => {
  let calls = 0;
  const r = await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      return { finalResponse: 'ok' };
    },
    ACTION_MSG,
    []
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.finalResponse, 'ok');
});

test('#135-19 达到上限 + 有压缩上下文 + 策略通过 → 续跑', async () => {
  const seen = [];
  const r = await runLoopRoundWithContinuation(
    async (msg, msgs, dedup) => {
      seen.push({ msg, msgs, dedup });
      if (seen.length === 1) {
        return {
          finalResponse: 'part 1',
          maxIterationsReached: true,
          conversationMessages: [{ role: 'user', content: 'compacted-ctx' }],
          executedCallKeys: new Map([['sig-1', true]]),
        };
      }
      return { finalResponse: 'done' };
    },
    ACTION_MSG,
    [{ role: 'user', content: 'seed' }]
  );

  assert.strictEqual(seen.length, 2, '应当续跑一轮');
  assert.strictEqual(r.finalResponse, 'done');
  // 首轮拿到调用方给的 initialMessages
  assert.strictEqual(seen[0].msgs[0].content, 'seed');
  // 续跑轮拿到**上一轮的压缩视图**（这正是「摘要交给下一次上下文」）
  assert.strictEqual(seen[1].msgs[0].content, 'compacted-ctx');
  // 续跑轮继承去重键，避免重跑同一个工具
  assert.ok(seen[1].dedup instanceof Map);
  assert.strictEqual(seen[1].dedup.get('sig-1'), true);
  // 续跑提示词由 harness 的 buildContinuationInput 产出
  assert.match(seen[1].msg, /continuation round/);
});

test('#135-20 上一轮没带回 conversationMessages → 不续跑（硬续会失忆）', async () => {
  let calls = 0;
  const r = await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      return { finalResponse: 'part', maxIterationsReached: true };
    },
    ACTION_MSG,
    []
  );
  assert.strictEqual(calls, 1);
  assert.strictEqual(r.finalResponse, 'part');
});

test('#135-21 上下文为空数组 → 不续跑', async () => {
  let calls = 0;
  await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      return { maxIterationsReached: true, conversationMessages: [] };
    },
    ACTION_MSG,
    []
  );
  assert.strictEqual(calls, 1);
});

test('#135-22 续跑有界：不超过 DEFAULTS.maxContinuationRounds', async () => {
  let calls = 0;
  await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      return {
        finalResponse: 'never done',
        maxIterationsReached: true,
        conversationMessages: [{ role: 'user', content: 'ctx' }],
      };
    },
    ACTION_MSG,
    []
  );
  assert.ok(calls > 1, '应当至少续跑一轮');
  assert.ok(
    calls - 1 <= DEFAULTS.maxContinuationRounds,
    `续跑轮数 ${calls - 1} 不得超过 ${DEFAULTS.maxContinuationRounds}（RUNTIME-003 有界性）`
  );
});

test('#135-23 hooks.maxContinuationRounds 可收紧上限', async () => {
  let calls = 0;
  await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      return {
        maxIterationsReached: true,
        conversationMessages: [{ role: 'user', content: 'ctx' }],
      };
    },
    ACTION_MSG,
    [],
    { maxContinuationRounds: 1 }
  );
  assert.strictEqual(calls, 2, '首轮 + 最多 1 轮续跑');
});

test('#135-24 短消息（策略不过）→ 不续跑', async () => {
  let calls = 0;
  await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      return {
        maxIterationsReached: true,
        conversationMessages: [{ role: 'user', content: 'ctx' }],
      };
    },
    SHORT_MSG,
    []
  );
  assert.strictEqual(calls, 1);
});

test('#135-25 续跑轮抛错 → 停止但保留已有结果（fail-soft）', async () => {
  let calls = 0;
  const r = await runLoopRoundWithContinuation(
    async () => {
      calls += 1;
      if (calls === 1) {
        return {
          finalResponse: 'partial work',
          maxIterationsReached: true,
          conversationMessages: [{ role: 'user', content: 'ctx' }],
        };
      }
      throw new Error('boom');
    },
    ACTION_MSG,
    []
  );
  assert.strictEqual(calls, 2);
  assert.strictEqual(r.finalResponse, 'partial work', '必须返回已收集到的结果，而不是抛出去');
});

test('#135-26 onRound 被通知且不带异常影响主流程', async () => {
  const rounds = [];
  await runLoopRoundWithContinuation(
    async (msg, msgs) => {
      if (msg === ACTION_MSG) {
        return {
          maxIterationsReached: true,
          conversationMessages: [{ role: 'user', content: 'ctx' }],
        };
      }
      return { finalResponse: 'done' };
    },
    ACTION_MSG,
    [],
    {
      onRound: (n, max) => {
        rounds.push([n, max]);
        throw new Error('observer must not break the loop');
      },
    }
  );
  assert.strictEqual(rounds.length, 1);
  assert.strictEqual(rounds[0][0], 1);
  assert.ok(rounds[0][1] >= 1);
});

// ── 策略本身的回归（\b 与中文不兼容）─────────────────────────────────
//
// 修前 `_shouldAutoContinue` 把中英动作词写进同一个 `\b(...)\b`，而 `\b` 基于 `\w`
// （仅 ASCII），中文两侧都不成边界 ⇒ `\b实现\b` 永不匹配，中文那半边是死码。
// 后果：中文长任务的 Ralph 续跑**从不触发**（经典 REPL 与 TUI 都受影响）。
test('#135-27 中文长消息必须能触发续跑（\\b 与中文不兼容的回归）', () => {
  const { continuation } = require('../../src/services/agenticHarnessService');
  assert.strictEqual(
    continuation.shouldAutoContinue(ACTION_MSG),
    true,
    '中文动作词（实现/设计/创建…）必须触发'
  );
  assert.strictEqual(continuation.shouldAutoContinue('你好'), false, '短消息不触发');
  assert.strictEqual(
    continuation.shouldAutoContinue(`${'x'.repeat(210)} please implement the parser`),
    true,
    '英文动作词仍必须触发'
  );
  assert.strictEqual(
    continuation.shouldAutoContinue(`${'x'.repeat(210)} see the address book`),
    false,
    '英文侧保留 \\b：address 不得被 add 误命中'
  );
});
