'use strict';

/**
 * denialGuidance.test.js — 高危拒绝可执行指引叶子(纯函数、门控)单测。
 */

const { buildDenialGuidance, isDenialGuidanceEnabled } = require('../../src/services/syscallGateway/denialGuidance');
const { DENY_CAUSES } = require('../../src/services/syscallGateway/approvalRouter');

describe('buildDenialGuidance', () => {
  test('no-interactive-channel → 产出可执行指引(含为何被拒 + 三条合规途径)', () => {
    const g = buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, { tool: 'shell_command' }, {});
    expect(typeof g).toBe('string');
    expect(g).toContain('shell_command'); // 点名工具
    expect(g).toContain('非交互环境');
    expect(g).toContain('YES');            // 途径①交互键入
    expect(g).toContain('permissions.json'); // 途径②配置策略
  });

  test('无 intent 也能生成通用指引(fail-soft)', () => {
    const g = buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, undefined, {});
    expect(typeof g).toBe('string');
    expect(g).toContain('高危');
  });

  test('其余 cause → null(语义自明，不改现有措辞)', () => {
    expect(buildDenialGuidance(DENY_CAUSES.CONFIRM_MISMATCH, {}, {})).toBeNull();
    expect(buildDenialGuidance(DENY_CAUSES.USER_DECLINED, {}, {})).toBeNull();
    expect(buildDenialGuidance(DENY_CAUSES.INTERACTION_ERROR, {}, {})).toBeNull();
    expect(buildDenialGuidance('anything-else', {}, {})).toBeNull();
  });

  test('门控关(0/false/off/no) → null，逐字节回退「不附指引」', () => {
    for (const off of ['0', 'false', 'off', 'no']) {
      expect(buildDenialGuidance(DENY_CAUSES.NO_INTERACTIVE_CHANNEL, { tool: 't' }, { KHY_GATEWAY_DENIAL_GUIDANCE: off })).toBeNull();
    }
  });

  test('门控默认开(未设/其他值)', () => {
    expect(isDenialGuidanceEnabled({})).toBe(true);
    expect(isDenialGuidanceEnabled({ KHY_GATEWAY_DENIAL_GUIDANCE: 'true' })).toBe(true);
    expect(isDenialGuidanceEnabled({ KHY_GATEWAY_DENIAL_GUIDANCE: 'off' })).toBe(false);
  });
});
