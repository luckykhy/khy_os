'use strict';
/**
 * toolFailureRecovery.test.js �?工具失败多分支恢复裁决器（纯叶子）契约测试�? *
 * 覆盖 Branch ladder 首层（接线点 toolUseLoopCore 并行/串行执行路径）：
 *  - 瞬态失败分类：结构�?retryable 标记 / TIMEOUT·NETWORK_ERROR �?/ 瞬态文本特�? *  - 只读白名单：读类工具可自动重跑；写类工具（shell/write）绝不自动重�? *  - 预算：KHY_TOOL_TRANSIENT_RETRY_MAX 默认 2，clamp [0,5]，耗尽�?Branch H
 *  - 分支裁决：retry / honest 的全部判定路径（�?permission-denied 短路�? *  - isTransientText：chat() 抛异常等无结构化 error 形态的文本分类
 */
const tfr = require('../toolFailureRecovery');
const transientToolError = { success: false, error: { code: 'TIMEOUT', retryable: true, message: 'Command timed out after 30s' } };
const transientNetwork = { success: false, error: { code: 'NETWORK_ERROR', message: 'socket hang up' } };
const stringTransient = { success: false, error: 'Error: ECONNRESET at TLSSocket...' };
const enoent = { success: false, error: { code: 'RESOURCE_NOT_FOUND', message: 'file not found' } };

describe('Tool Failure Recovery', () => {
  test('isTransientToolFailure: 结构�?retryable 标记 / 瞬态码 / 文本特征', () => {
      expect(tfr.isTransientToolFailure(transientToolError)).toBe(true);
      expect(tfr.isTransientToolFailure(transientNetwork)).toBe(true);
      expect(tfr.isTransientToolFailure(stringTransient)).toBe(true);
      // retryable 缺失�?message 命中瞬态特�?      assert.equal(
        tfr.isTransientToolFailure({ success: false, error: { code: 'EXECUTION_ERROR', message: 'request timeout after 120s' } }),
        true
      );
  });

  test('isTransientToolFailure: 非瞬态失败与成功/空输�?, () => {
      expect(tfr.isTransientToolFailure(enoent)).toBe(false);
      expect(tfr.isTransientToolFailure({ success: false, error: 'permission denied' })).toBe(false);
      expect(tfr.isTransientToolFailure({ success: true })).toBe(false);
      expect(tfr.isTransientToolFailure(null)).toBe(false);
      expect(tfr.isTransientToolFailure({ success: false })).toBe(false);
  });

  test('isReadOnlyToolName: 读类白名单命中；写类/未知一律不自动重跑', () => {
      for (const name of ['read_file', 'readFile', 'grep', 'web_search', 'web_fetch', 'git_status', 'ls', 'search']) {
        expect(tfr.isReadOnlyToolName(name)).toBe(true);
      }
      for (const name of ['shell_command', 'bash', 'write_file', 'editFile', 'install_package', 'delete_file', 'Read_File']) {
        expect(tfr.isReadOnlyToolName(name)).toBe(false);
      }
      expect(tfr.isReadOnlyToolName(undefined)).toBe(false);
  });

  test('resolveMaxToolRetries: 默认 2；env 生效�?clamp [0,5]；非法回默认', () => {
      expect(tfr.resolveMaxToolRetries({})).toBe(2);
      expect(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: '0' })).toBe(0);
      expect(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: '3' })).toBe(3);
      expect(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: '99' })).toBe(5);
      expect(tfr.resolveMaxToolRetries({ KHY_TOOL_TRANSIENT_RETRY_MAX: 'abc' })).toBe(2);
  });

  test('decideToolRecovery: 瞬�?+ 只读 + 预算�?�?retry', () => {
      const d = tfr.decideToolRecovery({ toolName: 'read_file', result: transientToolError, retriesUsed: 0, env: {} });
      assert.deepEqual(d, { action: 'retry', reason: 'transient-read-only' });
      const d2 = tfr.decideToolRecovery({ toolName: 'web_search', result: stringTransient, retriesUsed: 1, env: {} });
      expect(d2.action).toBe('retry');
  });

  test('decideToolRecovery: 预算耗尽 �?honest(budget-exhausted)，绝不无限重�?, () => {
      const d = tfr.decideToolRecovery({ toolName: 'read_file', result: transientToolError, retriesUsed: 2, env: {} });
      assert.deepEqual(d, { action: 'honest', reason: 'budget-exhausted' });
      const d0 = tfr.decideToolRecovery({ toolName: 'grep', result: transientToolError, retriesUsed: 0, env: { KHY_TOOL_TRANSIENT_RETRY_MAX: '0' } });
      expect(d0.reason).toBe('budget-exhausted');
  });

  test('decideToolRecovery: 写类工具瞬态失�?�?honest(not-read-only)（副作用不可重复�?, () => {
      const d = tfr.decideToolRecovery({ toolName: 'shell_command', result: transientToolError, retriesUsed: 0, env: {} });
      assert.deepEqual(d, { action: 'honest', reason: 'not-read-only' });
      const d2 = tfr.decideToolRecovery({ toolName: 'write_file', result: transientNetwork, retriesUsed: 0, env: {} });
      expect(d2.action).toBe('honest');
  });

  test('decideToolRecovery: 非瞬�?成功/权限拒绝的短路路�?, () => {
      expect(tfr.decideToolRecovery({ toolName: 'read_file', result: enoent, retriesUsed: 0, env: {} }).reason).toBe('not-transient');
      assert.equal(
        tfr.decideToolRecovery({ toolName: 'read_file', result: { success: true }, retriesUsed: 0, env: {} }).reason,
        'not-failed'
      );
      assert.equal(
        tfr.decideToolRecovery({ toolName: 'read_file', result: { success: false, denied: true }, retriesUsed: 0, env: {} }).reason,
        'permission-denied'
      );
  });

  test('isTransientText: chat() 抛异常文本分类（Branch C 判定�?, () => {
      expect(tfr.isTransientText('Error: socket hang up')).toBe(true);
      expect(tfr.isTransientText('fetch failed: ECONNRESET')).toBe(true);
      expect(tfr.isTransientText('gateway timeout after 30s')).toBe(true);
      expect(tfr.isTransientText('HTTP 503 service unavailable')).toBe(true);
      expect(tfr.isTransientText('Cannot read properties of undefined (reading map)')).toBe(false);
      expect(tfr.isTransientText('Unexpected token < in JSON')).toBe(false);
      expect(tfr.isTransientText(null)).toBe(false);
  });

  test('分支准确性：确定性失败码优先�?retryable 标记（误标不触发自动重跑�?, () => {
      // INVALID_ARGS 即使被上游误�?retryable:true 也绝不判瞬态（重跑无意义）
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
      // 确定性码也压过瞬态文本特征（message 里带 timeout 字样�?      assert.equal(
        tfr.decideToolRecovery({
          toolName: 'read_file',
          result: { success: false, error: { code: 'INVALID_ARGS', retryable: true, message: 'timeoutMs must be < 120000' } },
          retriesUsed: 0,
          env: {},
        }).action,
        'honest'
      );
  });

  test('分支准确性：负向文本守卫优先于正向瞬态特�?, () => {
      // 错误文本同时含确定性签名与瞬态字�?�?判非瞬�?      assert.equal(
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
      // 真瞬态不受负向守卫误�?      expect(tfr.isTransientText('connection reset by peer')).toBe(true);
      expect(tfr.isTransientText('rate limit exceeded, retry after 30s')).toBe(true);
  });

});

