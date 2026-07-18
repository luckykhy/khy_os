'use strict';

// 原测试针对已删除的 shell_command 内置工具（森林重构 c63fa48 移除）。
// 当前产品中，「fork 资源错误应归类为 executor_unavailable 而非宿主 OOM」
// 这一能力存活于 appLaunchRecovery.isShellExecutorUnavailableResult（布尔分类器），
// 故测试改为直接验证该分类器的语义。
const { isShellExecutorUnavailableResult } = require('../src/services/appLaunchRecovery');

describe('shell fork executor-unavailable classification', () => {
  test('classifies fork resource error as executor_unavailable (not host OOM)', () => {
    const result = {
      success: false,
      error: {
        message: 'bash: fork: retry: Resource temporarily unavailable',
      },
    };
    expect(isShellExecutorUnavailableResult(result)).toBe(true);
  });

  test('honors explicit executor_unavailable error code', () => {
    const result = { success: false, error: { code: 'executor_unavailable' } };
    expect(isShellExecutorUnavailableResult(result)).toBe(true);
  });

  test('does not misclassify an ordinary command failure as executor-unavailable', () => {
    const result = { success: false, error: { message: 'command not found: gimp' } };
    expect(isShellExecutorUnavailableResult(result)).toBe(false);
  });

  test('treats a successful result as not executor-unavailable', () => {
    expect(isShellExecutorUnavailableResult({ success: true })).toBe(false);
  });
});
