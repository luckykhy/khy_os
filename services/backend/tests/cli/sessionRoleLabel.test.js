'use strict';

/**
 * session `_roleLabel` 契约测试(node:test)——`session show` recent 消息的角色标签
 * 区分。承 [[project_human_turn_count_ssot]](刀69):工具结果载体 / 压缩摘要与真人
 * 回合共享 role:'user',标签必须据 messagePredicates.userMessageKind 细分,不能一律
 * 标「用户」。门控 KHY_HUMAN_TURN_COUNT;关 → 逐字节回退旧标签。
 */
const test = require('node:test');
const assert = require('node:assert');

const { _roleLabel } = require('../../src/cli/handlers/session');

// chalk 可能注入 ANSI 颜色码,断言前剥离,只比纯文本。
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

test('门控开:真人 user 回合 → 用户', () => {
  delete process.env.KHY_HUMAN_TURN_COUNT;
  assert.strictEqual(strip(_roleLabel({ role: 'user', content: '帮我改 bug' })), '用户');
  // 含图片块的真人消息仍是「用户」。
  assert.strictEqual(
    strip(_roleLabel({ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image' }] })),
    '用户',
  );
});

test('门控开:工具结果载体(文本前缀 / 结构化块)→ 工具,非 用户', () => {
  delete process.env.KHY_HUMAN_TURN_COUNT;
  assert.strictEqual(strip(_roleLabel({ role: 'user', content: '[Tool Result]\nok' })), '工具');
  assert.strictEqual(
    strip(_roleLabel({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] })),
    '工具',
  );
});

test('门控开:压缩摘要载体([ContextCompact)→ 上下文,非 用户', () => {
  delete process.env.KHY_HUMAN_TURN_COUNT;
  assert.strictEqual(
    strip(_roleLabel({ role: 'user', content: '[ContextCompact v2 @ t]\n摘要' })),
    '上下文',
  );
});

test('assistant / 其它角色恒不变(两门控态一致)', () => {
  for (const v of [undefined, 'off']) {
    if (v === undefined) delete process.env.KHY_HUMAN_TURN_COUNT;
    else process.env.KHY_HUMAN_TURN_COUNT = v;
    assert.strictEqual(strip(_roleLabel({ role: 'assistant', content: 'x' })), '助手');
    assert.strictEqual(strip(_roleLabel({ role: 'tool', content: 'x' })), 'tool');
    assert.strictEqual(strip(_roleLabel({ role: '', content: 'x' })), '?');
    assert.strictEqual(strip(_roleLabel(null)), '?');
  }
  delete process.env.KHY_HUMAN_TURN_COUNT;
});

test('门控关:每条 user 一律 用户(逐字节回退旧标签)', () => {
  process.env.KHY_HUMAN_TURN_COUNT = 'off';
  assert.strictEqual(strip(_roleLabel({ role: 'user', content: '[Tool Result]\nok' })), '用户');
  assert.strictEqual(strip(_roleLabel({ role: 'user', content: '[ContextCompact v2 @ t]\n摘' })), '用户');
  assert.strictEqual(
    strip(_roleLabel({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] })),
    '用户',
  );
  assert.strictEqual(strip(_roleLabel({ role: 'user', content: '真人' })), '用户');
  delete process.env.KHY_HUMAN_TURN_COUNT;
});

test('绝不抛:畸形输入安全降级', () => {
  delete process.env.KHY_HUMAN_TURN_COUNT;
  assert.doesNotThrow(() => _roleLabel(undefined));
  assert.doesNotThrow(() => _roleLabel({}));
  assert.doesNotThrow(() => _roleLabel({ role: 'user' }));
});
