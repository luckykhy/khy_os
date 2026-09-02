'use strict';

/**
 * toolFailureRecovery.test.js — 工具失败多分支恢复裁决器（纯叶子）契约测试。
 *
 * 覆盖 Branch ladder 首层（接线点 toolUseLoopCore 并行/串行执行路径）：
 *  - 瞬态失败分类：结构化 retryable 标记 / TIMEOUT·NETWORK_ERROR 码 / 瞬态文本特征
 *  - 只读白名单：读类工具可自动重跑；写类工具（shell/write）绝不自动重跑
 *  - 预算：KHY_TOOL_TRANSIENT_RETRY_MAX 默认 2，clamp [0,5]，耗尽即 Branch H
 *  - 分支裁决：retry / honest 的全部判定路径（含 permission-denied 短路）
 *  - isTransientText：chat() 抛异常等无结构化 error 形态的文本分类
 */

const assert = require('node:assert');
const { test } = require('node:test');

const tfr = require('../toolFailureRecovery');

const transientToolError = { success: false, error: { code: 'TIMEOUT', retryable: true, message: 'Command timed out after 30s' } };
const transientNetwork = { success: false, error: { code: 'NETWORK_ERROR', message: 'socket hang up' } };
const stringTransient = { success: false, error: 'Error: ECONNRESET at TLSSocket...' };
const enoent = { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'file not found' } };

test('isTransientToolFailure: 结构化 retryable 标记 / 瞬态码 / 文本特征', () => {
  assert.equal(tfr.isTransientToolFailure(transientToolError), true);
  assert.equal(tfr.isTransientToolFailure(transientNetwork), true);
  assert.equal(tfr.isTransientToolFailure(stringTransient), true);
  // retryable 缺失但 message 命中瞬态特征
  assert.equal(
    tfr.isTransientToolFailure({ success: false, error: { code: 'EXECUTION_ERROR', message: 'request timeout after 120s' } }),
    true
  );
});

test('isTransientToolFailure: 非瞬态失败与成功/空输入', () => {
  assert.equal(tfr.isTransientToolFailure(enoent), false);
  assert.equal(tfr.isTransientToolFailure({ success: false, error: 'permission denied' }), false);
  assert.equal(tfr.isTransientToolFailure({ success: true }), false);
  assert.equal(tfr.isTransientToolFailure(null), false);
  assert.equal(tfr.isTransientToolFailure({ success: false }), false);
});

test('isReadOnlyToolName: 读类白名单命中；写类/未知一律不自动重跑', () => {
  for (const name of ['read_file', 'readFile', 'grep', 'web_search', 'web_fetch', 'git_status', 'ls', 'search']) {
    assert.equal(tfr.isReadOnlyToolName(name), true, name);
  }
  for (const name of ['shell_command', 'bash', 'write_file', 'editFile', 'install_package', 'delete_file', 'Read_File']) {
    assert.equal(tfr.isReadOnlyToolName(name), false, name);
  }
  assert.equal(tfr.isReadOnlyToolName(undefined), false);
});

test('resolveMaxToolRetries: 默认 2；env 生效并 clamp [0,5]；非法回默认', () => {
  assert.equal(tfr.resolveMaxToolRetries({}), 2);
  assert.equal(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: '0' }), 0);
  assert.equal(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: '3' }), 3);
  assert.equal(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: '99' }), 5);
  assert.equal(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: 'abc' }), 2);
});

test('decideToolRecovery: 瞬态 + 只读 + 预算内 → retry', () => {
  const d = tfr.decideToolRecovery({ toolName: 'read_file', result: transientToolError, retriesUsed: 0, env: {} });
  assert.deepEqual(d, { action: 'retry', reason: 'transient-read-only' });
  const d2 = tfr.decideToolRecovery({ toolName: 'web_search', result: stringTransient, retriesUsed: 1, env: {} });
  assert.equal(d2.action, 'retry');
});

test('decideToolRecovery: 预算耗尽 → honest(budget-exhausted)，绝不无限重跑', () => {
  const d = tfr.decideToolRecovery({ toolName: 'read_file', result: transientToolError, retriesUsed: 2, env: {} });
  assert.deepEqual(d, { action: 'honest', reason: 'budget-exhausted' });
  const d0 = tfr.decideToolRecovery({ toolName: 'grep', result: transientToolError, retriesUsed: 0, env: { KHY_TOOL_TRANSIENT_RETRY_MAX: '0' } });
  assert.equal(d0.reason, 'budget-exhausted');
});

test('decideToolRecovery: 写类工具瞬态失败 → honest(not-read-only)（副作用不可重复）', () => {
  const d = tfr.decideToolRecovery({ toolName: 'shell_command', result: transientToolError, retriesUsed: 0, env: {} });
  assert.deepEqual(d, { action: 'honest', reason: 'not-read-only' });
  const d2 = tfr.decideToolRecovery({ toolName: 'write_file', result: transientNetwork, retriesUsed: 0, env: {} });
  assert.equal(d2.action, 'honest');
});

test('decideToolRecovery: 非瞬态/成功/权限拒绝的短路路径', () => {
  assert.equal(tfr.decideToolRecovery({ toolName: 'read_file', result: enoent, retriesUsed: 0, env: {} }).reason, 'not-transient');
  assert.equal(
    tfr.decideToolRecovery({ toolName: 'read_file', result: { success: true }, retriesUsed: 0, env: {} }).reason,
    'not-failed'
  );
  assert.equal(
    tfr.decideToolRecovery({ toolName: 'read_file', result: { success: false, denied: true }, retriesUsed: 0, env: {} }).reason,
    'permission-denied'
  );
});

test('isTransientText: chat() 抛异常文本分类（Branch C 判定）', () => {
  assert.equal(tfr.isTransientText('Error: socket hang up'), true);
  assert.equal(tfr.isTransientText('fetch failed: ECONNRESET'), true);
  assert.equal(tfr.isTransientText('gateway timeout after 30s'), true);
  assert.equal(tfr.isTransientText('HTTP 503 service unavailable'), true);
  assert.equal(tfr.isTransientText('Cannot read properties of undefined (reading map)'), false);
  assert.equal(tfr.isTransientText('Unexpected token < in JSON'), false);
  assert.equal(tfr.isTransientText(null), false);
});

test('分支准确性：确定性失败码优先于 retryable 标记（误标不触发自动重跑）', () => {
  // INVALID_ARGS 即使被上游误标 retryable:true 也绝不判瞬态（重跑无意义）
  assert.equal(
    tfr.isTransientToolFailure({
      success: false,
      error: { code: 'INVALID_ARGS', retryable: true, message: 'bad params' },
    }),
    false
  );
  for (const code of ['PERMISSION_DENIED', 'RESOURCE_NOT_FOUND', 'TOOL_UNAVAILABLE', 'MISSING_DEPENDENCY']) {
    assert.equal(
      tfr.isTransientToolFailure({ success: false, error: { code, retryable: true, message: code } }),
      false,
      code
    );
  }
  // 确定性码也压过瞬态文本特征（message 里带 timeout 字样）
  assert.equal(
    tfr.decideToolRecovery({
      toolName: 'read_file',
      result: { success: false, error: { code: 'INVALID_ARGS', retryable: true, message: 'timeoutMs must be < 120000' } },
      retriesUsed: 0,
      env: {},
    }).action,
    'honest'
  );
});

test('分支准确性：负向文本守卫优先于正向瞬态特征', () => {
  // 错误文本同时含确定性签名与瞬态字样 → 判非瞬态
  assert.equal(
    tfr.isTransientText('invalid argument: timeoutMs must be < 120000'),
    false
  );
  assert.equal(
    tfr.isTransientText('file not found (network path configured)'),
    false
  );
  assert.equal(
    tfr.isTransientText('no such tool: web_serch'),
    false
  );
  // 真瞬态不受负向守卫误伤
  assert.equal(tfr.isTransientText('connection reset by peer'), true);
  assert.equal(tfr.isTransientText('rate limit exceeded, retry after 30s'), true);
});
