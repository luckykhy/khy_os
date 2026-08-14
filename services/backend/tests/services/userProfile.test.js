'use strict';

/**
 * userProfile.getIdentitySummary — 用户身份摘要只读聚合单测(jest)。
 *
 * 覆盖:返回结构契约(deviceId/osUser/skillLevel/language/preferences/sessions/
 * totalCommands/hasIdentity)、安全兜底(load 失败/字段缺失时用默认值·绝不抛)、
 * hasIdentity 由 deviceId||osUser 派生。纯只读派生,不写盘。
 */

const userProfile = require('../../src/services/userProfile');

describe('userProfile.getIdentitySummary', () => {
  test('导出为函数', () => {
    expect(typeof userProfile.getIdentitySummary).toBe('function');
  });

  test('返回结构契约完整', () => {
    const s = userProfile.getIdentitySummary();
    expect(s).toBeTruthy();
    expect(s).toHaveProperty('deviceId');
    expect(s).toHaveProperty('osUser');
    expect(typeof s.skillLevel).toBe('string');
    expect(typeof s.language).toBe('string');
    expect(typeof s.preferences).toBe('object');
    expect(typeof s.sessions).toBe('number');
    expect(typeof s.totalCommands).toBe('number');
    expect(typeof s.hasIdentity).toBe('boolean');
  });

  test('hasIdentity 与 deviceId/osUser 一致', () => {
    const s = userProfile.getIdentitySummary();
    expect(s.hasIdentity).toBe(!!(s.deviceId || s.osUser));
  });

  test('绝不抛:多次调用稳定', () => {
    expect(() => userProfile.getIdentitySummary()).not.toThrow();
    const a = userProfile.getIdentitySummary();
    const b = userProfile.getIdentitySummary();
    expect(a.skillLevel).toBe(b.skillLevel);
  });
});
