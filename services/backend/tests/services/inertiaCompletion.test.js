'use strict';

/**
 * inertiaCompletion.test.js — 断线惯性策略纯模块单测。
 *
 * 守护四件事:
 *   1. isInertiaTurn 只认「断线 partial」签名(interrupted:true + toolUseBlocks),
 *      不把干净的 max_tokens 截断、普通成功回合、errorType 误判进惯性路径;
 *      env KHY_INERTIA_COMPLETION=0 整体关闭。
 *   2. filterExecutableBlocks 放行可执行块、挡掉被截断的坏块(残缺 JSON / 无名 /
 *      server_tool_use),空/缺失 input 视为可执行(下游成 {})。
 *   3. buildModelReconnectHint 生成显式「曾断线 + 据惯性结果续跑勿重复」的 [SYSTEM] 提示,
 *      无内容时返回 ''。
 *   4. buildUserInertiaNotice / summarizeInertia 文案与汇总正确。
 *
 * 纯函数,零 IO。
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const inertia = require('../../src/services/query/inertiaCompletion');

const ENV_KEY = 'KHY_INERTIA_COMPLETION';
afterEach(() => { delete process.env[ENV_KEY]; });

describe('inertiaCompletion.isInertiaTurn', () => {
  test('断线 partial(interrupted + toolUseBlocks)→ true', () => {
    const r = { interrupted: true, toolUseBlocks: [{ name: 'read_file', input: { p: 'a' } }] };
    assert.equal(inertia.isInertiaTurn(r), true);
  });

  test('干净 max_tokens 截断(finishReason length 但无 interrupted)→ false', () => {
    const r = { finishReason: 'length', toolUseBlocks: [{ name: 'x', input: {} }] };
    assert.equal(inertia.isInertiaTurn(r), false);
  });

  test('interrupted 但没有 toolUseBlocks → false(无可惯性执行的指令)', () => {
    assert.equal(inertia.isInertiaTurn({ interrupted: true, toolUseBlocks: [] }), false);
    assert.equal(inertia.isInertiaTurn({ interrupted: true }), false);
  });

  test('普通成功回合 / errorType / 空值 → false', () => {
    assert.equal(inertia.isInertiaTurn({ reply: 'hi', toolUseBlocks: [{ name: 'x' }] }), false);
    assert.equal(inertia.isInertiaTurn({ errorType: 'network' }), false);
    assert.equal(inertia.isInertiaTurn(null), false);
  });

  test('env KHY_INERTIA_COMPLETION=0 → 整体关闭,断线 partial 也判 false(回退盲目行为)', () => {
    process.env[ENV_KEY] = '0';
    const r = { interrupted: true, toolUseBlocks: [{ name: 'x', input: {} }] };
    assert.equal(inertia.isInertiaTurn(r), false);
    assert.equal(inertia.isEnabled(), false);
  });
});

describe('inertiaCompletion.filterExecutableBlocks', () => {
  test('对象 input / 空 input / 缺失 input → 可执行;残缺 JSON 字符串 / 无名 / server_tool_use → 丢弃', () => {
    const blocks = [
      { name: 'a', input: { x: 1 } },            // 对象 → 可执行
      { name: 'b', input: '' },                  // 空串 → 可执行(下游 {})
      { name: 'c' },                             // 缺失 input → 可执行
      { name: 'd', input: '{"truncated":' },     // 残缺 JSON → 丢弃
      { input: { x: 1 } },                       // 无名 → 丢弃
      { name: 'e', type: 'server_tool_use', input: {} }, // server-side → 丢弃
      { name: 'f', input: '{"ok":true}' },       // 合法 JSON 字符串 → 可执行
    ];
    const { executable, dropped } = inertia.filterExecutableBlocks(blocks);
    assert.deepEqual(executable.map((b) => b.name), ['a', 'b', 'c', 'f']);
    assert.equal(dropped.length, 3);
  });

  test('非数组 → 空结果,不抛', () => {
    assert.deepEqual(inertia.filterExecutableBlocks(null), { executable: [], dropped: [] });
  });
});

describe('inertiaCompletion.buildModelReconnectHint', () => {
  test('有已执行工具 → 含「断开 + 据上方结果续跑勿重复」', () => {
    const hint = inertia.buildModelReconnectHint({ executedTools: ['read_file', 'list_dir'], droppedCount: 0 });
    assert.match(hint, /^\[SYSTEM:/);
    assert.match(hint, /中途断开/);
    assert.match(hint, /read_file、list_dir/);
    assert.match(hint, /切勿重复/);
  });

  test('有被丢弃的坏块 → 提示「N 个调用因截断已跳过」', () => {
    const hint = inertia.buildModelReconnectHint({ executedTools: ['a'], droppedCount: 2 });
    assert.match(hint, /2 个调用因中断被截断/);
  });

  test('无工具且无丢弃 → 返回空串(不注入)', () => {
    assert.equal(inertia.buildModelReconnectHint({ executedTools: [], droppedCount: 0 }), '');
    assert.equal(inertia.buildModelReconnectHint({}), '');
  });
});

describe('inertiaCompletion.buildUserInertiaNotice / summarizeInertia', () => {
  test('reconnected=true → 无感续接语气', () => {
    const n = inertia.buildUserInertiaNotice({ executedCount: 3, reconnected: true });
    assert.match(n, /已用惯性完成 3 个已下达的步骤并自动续接/);
  });

  test('reconnected=false → 通道未恢复语气 + 跳过计数', () => {
    const n = inertia.buildUserInertiaNotice({ executedCount: 2, droppedCount: 1, reconnected: false });
    assert.match(n, /通道未恢复/);
    assert.match(n, /跳过 1 个被截断的调用/);
  });

  test('无执行无丢弃 → 空串', () => {
    assert.equal(inertia.buildUserInertiaNotice({ executedCount: 0, droppedCount: 0 }), '');
  });

  test('summarizeInertia 累加多回合,空 → null', () => {
    assert.equal(inertia.summarizeInertia([]), null);
    assert.deepEqual(
      inertia.summarizeInertia([{ executed: 2, dropped: 1 }, { executed: 3, dropped: 0 }]),
      { turns: 2, executed: 5, dropped: 1 },
    );
  });
});
