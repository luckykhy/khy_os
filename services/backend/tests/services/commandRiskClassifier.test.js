'use strict';

/**
 * s03 权限管线 阶段③最小切片：commandRiskClassifier 单一风险来源。
 *
 * 验证分类器把虚拟工具映射 (shellToToolMapper) 与语法安全校验
 * (shellSafetyValidator) 调和为单一判定（strictest-wins），覆盖
 * 破坏性命令 / 强制推送 / SQL DROP / 只读命令 / 复合命令 / 命令替换 /
 * 未知命令默认 medium。
 */

const { classifyCommandRisk, RISK_ORDER } = require('../../src/services/commandRiskClassifier');

describe('commandRiskClassifier.classifyCommandRisk', () => {
  test('rm -rf → critical, destructive, not read-only', () => {
    const v = classifyCommandRisk('rm -rf /tmp/foo');
    expect(v.risk).toBe('critical');
    expect(v.isDestructive).toBe(true);
    expect(v.isReadOnly).toBe(false);
  });

  test('git push --force → critical', () => {
    const v = classifyCommandRisk('git push --force origin main');
    expect(RISK_ORDER[v.risk]).toBeGreaterThanOrEqual(RISK_ORDER.high);
    expect(v.risk).toBe('critical');
  });

  test('SQL DROP TABLE → critical via validator', () => {
    const v = classifyCommandRisk('mysql -e "DROP TABLE users"');
    expect(v.risk).toBe('critical');
  });

  test('read-only cat → safe and read-only', () => {
    const v = classifyCommandRisk('cat package.json');
    expect(v.risk).toBe('safe');
    expect(v.isReadOnly).toBe(true);
    expect(v.isDestructive).toBe(false);
  });

  test('compound command takes strictest segment', () => {
    const v = classifyCommandRisk('cat foo.txt && rm -rf bar');
    expect(v.risk).toBe('critical');
    expect(v.isReadOnly).toBe(false);
    expect(v.isDestructive).toBe(true);
  });

  test('command substitution is flagged', () => {
    const v = classifyCommandRisk('echo $(rm -rf /)');
    expect(v.hasCommandSubstitution).toBe(true);
  });

  test('unknown command defaults to medium', () => {
    const v = classifyCommandRisk('frobnicate --wibble');
    expect(v.risk).toBe('medium');
  });

  test('empty/invalid command → critical fail-closed', () => {
    expect(classifyCommandRisk('').risk).toBe('critical');
    expect(classifyCommandRisk(null).risk).toBe('critical');
  });
});
