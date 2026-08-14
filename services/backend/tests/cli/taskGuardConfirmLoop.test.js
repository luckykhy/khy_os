'use strict';

/**
 * taskGuardConfirmLoop.test.js — 锁定「确认执行能力硬约束后不再循环触发新 taskId」的根因修复。
 *
 * 历史 bug:用户发消息触发能力硬约束(tg-xxx)→ 用户输「确认执行 tg-xxx」→ ai.js
 * 把原始消息 replay 给模型 → replay 时**未标记已确认** → _resolveHardTaskGuard
 * 再次评估 replay 消息 → 又判定 issues >= hardMin → 生成全新 taskId(tg-yyy)→ 再拦一次
 * → 用户永远确认不掉,每次确认都产生新 taskId。表现:用户输「你好」「继续」「确认执行」
 * 都无法执行,只是不断弹新约束(taskId 递增:1szw → 3g5l → 3xdq → 5yu8 → ...)。
 *
 * 修:ai.js:4656 确认分支在把 replayMessage 赋给 userMessage 后,给 opts 追加
 * `_taskGuardConfirmed: true`,这样 replay 进入 :4623 的 _resolveHardTaskGuard 时
 * 命中 :3805 的 `if (opts._taskGuardConfirmed || ...) return { action: 'none' };`
 * 直接放行,不再重复评估。
 *
 * 本测验证:模拟「高推理需求消息 → blocked(tg-xxx)→ 确认执行 tg-xxx → confirmed
 * + replay」流程,断言 replay 带 `_taskGuardConfirmed: true` 且不再产生新 blocked。
 */

const test = require('node:test');
const assert = require('node:assert');

// ai.js 的 _resolveHardTaskGuard 与 _parseTaskGuardCommand 是内部函数,无导出。
// 本测通过「输入 → 输出」黑盒验证行为:模拟用户发高推理消息 → 确认 → 再发一轮
// 消息,断言第二轮不触发新约束(因第一轮确认已标记 _taskGuardConfirmed)。
// 由于 ai.js exports.chat 是全流程集成点,拆出 _resolveHardTaskGuard 需要重构;
// 这里采用轻量白盒策略:直接 require ai.js,通过其私有 _pendingTaskGuard 状态
// 与公开的 chat() 接口验证修复。考虑到 ai.js 庞大且有状态,本测在隔离环境运行。

// 设环境:KHY_TASK_GUARD_HARD=1(护栏开)、模型推理能力不足(触发约束)。
process.env.KHY_TASK_GUARD_HARD = '1';
process.env.KHY_TASK_GUARD_HARD_ISSUES_MIN = '1'; // 降阈值让单个 issue 就触发
process.env.KHY_WEAK_MODEL_GUIDANCE = '0'; // 关闭弱模型指引避免干扰

// Mock checkModelCapability 让它始终报告推理不足(触发硬约束)。
const Module = require('module');
const originalRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../services/modelTier' || id.endsWith('/modelTier')) {
    const real = originalRequire.apply(this, arguments);
    return {
      ...real,
      checkModelCapability: (text) => {
        // 任何非空 text 都判为「推理能力不足」(reasoning < 4),触发硬约束。
        if (!text || !text.trim()) return null;
        return {
          issues: ['推理能力不足 (需要 4/5, 当前 3/5)'],
          recommendations: [{ label: 'Claude Opus 4', key: 'opus4' }],
        };
      },
    };
  }
  return originalRequire.apply(this, arguments);
};

const ai = require('../../src/cli/ai');

test.after(() => {
  Module.prototype.require = originalRequire; // 恢复
});

test('confirm execution bypasses capability assessment on replay (fix loop bug)', async () => {
  // 第一轮:发一个会触发硬约束的消息(比如「实现完整的用户认证系统」)。
  const result1 = await ai.chat('实现完整的用户认证系统', {
    conversationId: 'test-confirm-loop',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });

  assert.strictEqual(result1.errorType, 'capability_guard', '第一轮应触发能力硬约束');
  assert.ok(result1.reply.includes('能力硬约束触发'), '应返回硬约束提示');
  const taskIdMatch = result1.reply.match(/tg-[a-z0-9-]+/);
  assert.ok(taskIdMatch, '应生成 taskId');
  const taskId = taskIdMatch[0];

  // 第二轮:输入「确认执行 <taskId>」,应返回 confirmed 并 replay 原始消息。
  const result2 = await ai.chat(`确认执行 ${taskId}`, {
    conversationId: 'test-confirm-loop',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });

  // 修复后:replay 时 opts._taskGuardConfirmed=true → 不再触发新约束 → 正常执行。
  // 由于我们 mock 的 checkModelCapability 没有实际模型,chat 会走到某个错误分支
  // 返回 errorType,但关键是**不应再出现新的 capability_guard**。
  assert.notStrictEqual(result2.errorType, 'capability_guard', '确认后 replay 不应再触发 capability_guard');
  assert.ok(!result2.reply.includes('能力硬约束触发'), '确认后不应再弹硬约束提示');

  // 如果 bug 未修复,result2 会再次返回 errorType='capability_guard' + 新 taskId(tg-yyy),
  // 且 reply 会再次包含「能力硬约束触发」。本测通过「不应再出现 capability_guard」
  // 断言修复生效。
});

test('confirm with wrong taskId is blocked and does not loop', async () => {
  // 第一轮:触发约束 tg-aaa。
  const result1 = await ai.chat('端到端实现支付网关', {
    conversationId: 'test-wrong-id',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });
  assert.strictEqual(result1.errorType, 'capability_guard');
  const taskIdMatch = result1.reply.match(/tg-[a-z0-9-]+/);
  const correctId = taskIdMatch[0];

  // 第二轮:故意用错误 taskId「确认执行 tg-wrong」→ 应被 blocked 且提示正确 id。
  const result2 = await ai.chat('确认执行 tg-wrong', {
    conversationId: 'test-wrong-id',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });
  assert.ok(result2.reply.includes('确认口令不匹配'), '错误 taskId 应提示不匹配');
  assert.ok(result2.reply.includes(correctId), '应提示正确 taskId');

  // 第三轮:用正确 taskId 确认 → 应通过。
  const result3 = await ai.chat(`确认执行 ${correctId}`, {
    conversationId: 'test-wrong-id',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });
  assert.notStrictEqual(result3.errorType, 'capability_guard', '正确 taskId 确认后应放行');
});

test('cancel execution clears pending guard', async () => {
  const result1 = await ai.chat('重构整个前端架构', {
    conversationId: 'test-cancel',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });
  assert.strictEqual(result1.errorType, 'capability_guard');
  const taskIdMatch = result1.reply.match(/tg-[a-z0-9-]+/);
  const taskId = taskIdMatch[0];

  // 取消任务。
  const result2 = await ai.chat(`取消执行 ${taskId}`, {
    conversationId: 'test-cancel',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });
  assert.ok(result2.reply.includes('已取消受限任务'), '应提示已取消');
  assert.strictEqual(result2.errorType, 'none', '取消后不应有 errorType');

  // 再发同样的消息,应再次触发新约束(因上一个已取消,pending 已清)。
  const result3 = await ai.chat('重构整个前端架构', {
    conversationId: 'test-cancel',
    onStatus: () => {},
    onProgress: () => {},
    onChunk: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
  });
  assert.strictEqual(result3.errorType, 'capability_guard', '取消后再发应重新触发约束');
  const newTaskIdMatch = result3.reply.match(/tg-[a-z0-9-]+/);
  assert.notStrictEqual(newTaskIdMatch[0], taskId, '应生成新的 taskId');
});
