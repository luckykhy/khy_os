'use strict';

/**
 * syscallGateway.redLine.test.js — Part B「L2 红线收敛到破坏性操作」+ redLine 单一真源。
 *
 * 两件事：
 *  1) redLine.describe / isRedLine 把分级裁决翻译成小白可读的「是不是红线、为什么」，
 *     且决策口径与 resourceClassifier.classify 完全一致（不另立判据）。
 *  2) 收敛验证：良性、可逆、非破坏性的 shell 命令（npm test / node build.js / git add）
 *     不再被工具静态 risk:'critical' 强行升到 L2；真正破坏性的命令（rm -rf）仍恒 L2。
 *     这正是把 riskGate.assess 的**动态**风险喂给网关后的预期口径。
 */

const path = require('path');
const { classifyCommandRisk } = require('../../src/services/commandRiskClassifier');
const { classify, LEVELS } = require('../../src/services/syscallGateway/resourceClassifier');
const { buildIntent } = require('../../src/services/syscallGateway/intentSchema');
const redLine = require('../../src/services/syscallGateway/redLine');

const CWD = path.sep === '\\' ? 'C:\\proj' : '/proj';
const HOME = path.sep === '\\' ? 'C:\\Users\\u' : '/home/u';

// Build the intent exactly as toolCalling now does: derive the dynamic risk
// signals from commandRiskClassifier (the single source riskGate also uses),
// then hand them to the gateway classifier — instead of the tool's static
// worst-case risk:'critical'.
function intentFromCommand(command) {
  const c = classifyCommandRisk(command);
  return buildIntent({
    tool: 'shell_command',
    params: { command },
    isReadOnly: c.isReadOnly,
    isDestructive: c.isDestructive,
    risk: c.risk,
    cwd: CWD,
    home: HOME,
  });
}

describe('Part B — 良性命令不再被静态 critical 升到 L2', () => {
  test.each([
    'npm test',
    'node build.js',
    'git add -A',
    'git commit -m hi',
    'echo hello',
  ])('良性可逆命令「%s」分级不为 L2（动态风险口径）', (cmd) => {
    const level = classify(intentFromCommand(cmd)).level;
    expect(level).not.toBe(LEVELS.L2);
  });
});

describe('Part B — 真正破坏性命令仍恒 L2（红线零弱化）', () => {
  test.each([
    'rm -rf build',
    'rm -rf /',
    'npm install -g typescript',
  ])('破坏性/系统级命令「%s」仍判 L2', (cmd) => {
    const level = classify(intentFromCommand(cmd)).level;
    expect(level).toBe(LEVELS.L2);
  });
});

describe('redLine — 人类可读单一真源', () => {
  test('isRedLine 与 classify 口径一致', () => {
    const danger = intentFromCommand('rm -rf x');
    const benign = intentFromCommand('npm test');
    expect(redLine.isRedLine(danger)).toBe(classify(danger).level === LEVELS.L2);
    expect(redLine.isRedLine(benign)).toBe(classify(benign).level === LEVELS.L2);
    expect(redLine.isRedLine(danger)).toBe(true);
    expect(redLine.isRedLine(benign)).toBe(false);
  });

  test('describe 对红线给出「为什么是红线」的小白说明', () => {
    const d = redLine.describe(intentFromCommand('rm -rf important'));
    expect(d.isRedLine).toBe(true);
    expect(d.level).toBe(LEVELS.L2);
    expect(d.summary).toMatch(/红线/);
    expect(Array.isArray(d.reasons)).toBe(true);
  });

  test('describe 对只读给出「不改变状态、默认放行」', () => {
    const it = buildIntent({ tool: 'read_file', params: { path: path.join(CWD, 'a.txt') }, isReadOnly: true, cwd: CWD, home: HOME });
    const d = redLine.describe(it);
    expect(d.isRedLine).toBe(false);
    expect(d.level).toBe(LEVELS.L0);
    expect(d.summary).toMatch(/只读|放行/);
  });

  test('describe 对项目内写入给出「可逆、确认一次」', () => {
    const it = buildIntent({ tool: 'write_file', params: { path: path.join(CWD, 'src', 'a.txt') }, cwd: CWD, home: HOME });
    const d = redLine.describe(it);
    expect(d.level).toBe(LEVELS.L1);
    expect(d.isRedLine).toBe(false);
    expect(d.summary).toMatch(/确认一次|有限影响/);
  });

  test('fail-closed：意图损坏时按红线处理', () => {
    expect(redLine.isRedLine(null)).toBe(true);
    expect(redLine.describe(undefined).isRedLine).toBe(true);
  });
});
