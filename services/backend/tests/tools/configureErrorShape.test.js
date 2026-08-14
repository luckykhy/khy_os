'use strict';

/**
 * configureErrorShape — Configure 失败路径结构化错误的单测(node:test)。
 *
 * 回归目标(khyos 自审 #5「Configure 只返回裸 Error: Unknown error」):验证失败被塑成
 * `{success:false, error:{code,message,hint,...}}`、message **绝不为空/绝不是裸
 * Unknown error**(空 message 时用调用点上下文合成)、hint 存在、details 带机器字段、
 * 门控关字节回退 null、fail-soft 绝不抛。
 *
 * node:test(jest 经 rtk 代理报 Exec format error 不可用)。
 */
const test = require('node:test');
const assert = require('node:assert');

const mod = require('../../src/tools/configureErrorShape');

test('普通 Error → 结构化 {success:false, error:{code,message,hint}}', () => {
  const r = mod.buildConfigureError(new Error('disk full'), { action: 'on', envKey: 'KHY_X' }, { env: {} });
  assert.strictEqual(r.success, false);
  assert.ok(r.error && typeof r.error === 'object');
  assert.ok(r.error.code, 'must carry a code');
  assert.ok(/disk full/.test(r.error.message), r.error.message);
  assert.ok(r.error.hint && r.error.hint.length > 0, 'must carry a recovery hint');
  assert.strictEqual(r.error.details.tool, 'Configure');
  assert.strictEqual(r.error.details.envKey, 'KHY_X');
  assert.strictEqual(r.error.details.action, 'on');
});

test('空 message 的错误 → 绝不塌成裸 Unknown error(用上下文合成)', () => {
  // 抛出的普通对象、无 message 的 Error、reject 的字符串空值
  const bads = [
    {},                       // 普通对象
    new Error(''),            // 空 message
    { code: 'EACCES' },       // 只有 code
  ];
  for (const bad of bads) {
    const r = mod.buildConfigureError(bad, { action: 'off', envKey: 'KHY_CHANGE_WATCH' }, { env: {} });
    assert.strictEqual(r.success, false);
    assert.ok(r.error.message && r.error.message.trim().length > 0, 'message 非空');
    assert.ok(!/^\s*(configure 执行失败:)?\s*unknown error\s*$/i.test(r.error.message), '不得是裸 Unknown error: ' + r.error.message);
    // 上下文合成必须提到目标键
    assert.ok(/KHY_CHANGE_WATCH/.test(r.error.message), '应含目标 envKey: ' + r.error.message);
  }
});

test('裸字面 "Unknown error" 字符串 → 被替换为上下文消息', () => {
  const r = mod.buildConfigureError('Unknown error', { action: 'on', envKey: 'KHY_GROUND_TRUTH' }, { env: {} });
  assert.ok(!/^\s*(configure 执行失败:)?\s*unknown error\s*$/i.test(r.error.message), r.error.message);
  assert.ok(/KHY_GROUND_TRUTH/.test(r.error.message), r.error.message);
});

test('无上下文 + 空错误 → 仍给通用非空 message', () => {
  const r = mod.buildConfigureError({}, {}, { env: {} });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.message && r.error.message.trim().length > 0);
  assert.ok(!/unknown error/i.test(r.error.message), r.error.message);
});

test('message 前缀化 Configure 语境', () => {
  const r = mod.buildConfigureError(new Error('boom'), { envKey: 'KHY_X' }, { env: {} });
  assert.ok(/Configure/.test(r.error.message), r.error.message);
});

test('details 带原始错误的机器字段(code/errno/syscall/path)', () => {
  const e = new Error('write failed');
  e.code = 'EACCES'; e.errno = -13; e.syscall = 'open'; e.path = '/x/.env';
  const r = mod.buildConfigureError(e, { envKey: 'KHY_X', action: 'set', target: '/x/.env' }, { env: {} });
  assert.strictEqual(r.error.details.code, 'EACCES');
  assert.strictEqual(r.error.details.errno, -13);
  assert.strictEqual(r.error.details.syscall, 'open');
  assert.strictEqual(r.error.details.path, '/x/.env');
  assert.strictEqual(r.error.details.target, '/x/.env');
});

test('门控关 → null(调用方逐字节回退旧字符串)', () => {
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(
      mod.buildConfigureError(new Error('x'), { envKey: 'KHY_X' }, { env: { KHY_CONFIGURE_STRUCTURED_ERROR: off } }),
      null,
      off,
    );
  }
  // 显式开 / 未设 → 非 null
  assert.ok(mod.buildConfigureError(new Error('x'), {}, { env: { KHY_CONFIGURE_STRUCTURED_ERROR: 'on' } }));
  assert.ok(mod.buildConfigureError(new Error('x'), {}, { env: {} }));
});

test('structuredErrorEnabled:默认开 + 关闭词表', () => {
  assert.strictEqual(mod.structuredErrorEnabled({}), true);
  assert.strictEqual(mod.structuredErrorEnabled({ KHY_CONFIGURE_STRUCTURED_ERROR: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    assert.strictEqual(mod.structuredErrorEnabled({ KHY_CONFIGURE_STRUCTURED_ERROR: off }), false, off);
  }
});

test('fail-soft:异常输入绝不抛', () => {
  for (const bad of [null, undefined, 123, 'str', {}, [], new Error('x')]) {
    assert.doesNotThrow(() => mod.buildConfigureError(bad, undefined, { env: {} }));
    assert.doesNotThrow(() => mod.buildConfigureError(bad, { envKey: 'KHY_X' }, {}));
  }
});

test('_contextualMessage:按信息量优先 envKey > capability > 通用', () => {
  assert.ok(/KHY_X/.test(mod._contextualMessage({ envKey: 'KHY_X', action: 'on' })));
  assert.ok(/KHY_X/.test(mod._contextualMessage({ envKey: 'KHY_X' })));
  assert.ok(/改动监视/.test(mod._contextualMessage({ capability: '改动监视' })));
  assert.ok(mod._contextualMessage({}).length > 0);
});
