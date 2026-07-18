'use strict';

const runtime = require('../src/services/khyUpgradeRuntime');

describe('khyUpgradeRuntime intent assurance', () => {
  test('extracts primary goal, constraints, path anchors, and tail details from noisy input', () => {
    const result = runtime.buildIntentAssuranceDirective(
      '你好，麻烦你帮我看看 backend/src/cli/ai.js，不要改接口，重点排查继续执行的逻辑，另外保留 Claude 兼容。'
    );

    expect(result.shouldInject).toBe(true);
    expect(result.constraintCount).toBeGreaterThanOrEqual(2);
    expect(result.detailCount).toBeGreaterThanOrEqual(4);
    expect(result.tailDetailCount).toBeGreaterThanOrEqual(1);
    expect(result.directive).toContain('Primary objective:');
    expect(result.directive).toContain('不要改接口');
    expect(result.directive).toContain('保留 Claude 兼容');
    expect(result.directive).toContain('backend/src/cli/ai.js');
    expect(result.directive).toContain('另外保留 Claude 兼容');
  });

  test('does not inject on a pure greeting', () => {
    const result = runtime.buildIntentAssuranceDirective('你好');
    expect(result.shouldInject).toBe(false);
    expect(result.directive).toBe('');
  });
});
