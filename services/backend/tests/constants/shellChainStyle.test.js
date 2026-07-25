'use strict';

/**
 * shellChainStyle.test.js — 纯叶子:PowerShell 感知的命令串接措辞单一真源。
 *
 * 验收要点:
 *  - 门控 KHY_POWERSHELL_CHAIN_STYLE:未设/任意非关键字 → 开;0/false/off/no
 *    (含大小写/空白) → 关。
 *  - resolveFamily:KHY_SHELL 显式覆盖最高优先;否则读 COMSPEC 末尾;bash/sh →
 *    null(非 Windows 家族,交调用方按 posix 处理)。
 *  - targetsPowerShell:门开 ∧ 家族 ∈ {powershell,pwsh} 才 true;门关恒 false。
 *  - windowsRuleLines / multiCommandLines:PowerShell 家族 → PowerShell 版
 *    (含 `;`/`if ($?)`、注明 `&&` 需 7+);其余 → 逐字节 legacy(`&&`)。
 *  - parseExecOverride:门开归一化 KHY_SHELL token;门关恒 null。
 *  - byte-revert:门关时 windowsRuleLines/multiCommandLines 与 legacy 常量逐字节相同。
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const leaf = require('../../src/constants/shellChainStyle');

// 局部 env 构造(纯叶子读入参 env,无需清缓存)。
function env(overrides) {
  return { ...overrides };
}

test('isEnabled: 未设/非关键字 → 开;0/false/off/no(含大小写/空白) → 关', () => {
  assert.equal(leaf.isEnabled({}), true);
  assert.equal(leaf.isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'on' }), true);
  assert.equal(leaf.isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: 'anything' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ', 'FALSE']) {
    assert.equal(leaf.isEnabled({ KHY_POWERSHELL_CHAIN_STYLE: off }), false, `off word: ${off}`);
  }
});

test('resolveFamily: KHY_SHELL 覆盖最高优先', () => {
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'powershell' })), 'powershell');
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'ps' })), 'powershell');
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'pwsh' })), 'pwsh');
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'ps7' })), 'pwsh');
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'cmd' })), 'cmd');
  // bash/sh → null(非 Windows 家族)
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'bash' })), null);
  assert.equal(leaf.resolveFamily(env({ KHY_SHELL: 'sh' })), null);
});

test('resolveFamily: 无覆盖时读 COMSPEC 末尾', () => {
  assert.equal(leaf.resolveFamily(env({ COMSPEC: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' })), 'powershell');
  assert.equal(leaf.resolveFamily(env({ COMSPEC: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' })), 'pwsh');
  assert.equal(leaf.resolveFamily(env({ COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })), 'cmd');
  assert.equal(leaf.resolveFamily(env({})), null);
});

test('resolveFamily: KHY_SHELL 覆盖优先于 COMSPEC', () => {
  assert.equal(
    leaf.resolveFamily(env({ KHY_SHELL: 'powershell', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' })),
    'powershell',
  );
});

test('targetsPowerShell: 门开 ∧ PowerShell 家族 → true;cmd/门关 → false', () => {
  assert.equal(leaf.targetsPowerShell(env({ KHY_SHELL: 'powershell' })), true);
  assert.equal(leaf.targetsPowerShell(env({ KHY_SHELL: 'pwsh' })), true);
  assert.equal(leaf.targetsPowerShell(env({ KHY_SHELL: 'cmd' })), false);
  assert.equal(leaf.targetsPowerShell(env({})), false);
  // 门关:即便家族是 powershell 也返 false
  assert.equal(
    leaf.targetsPowerShell(env({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: 'off' })),
    false,
  );
});

test('windowsRuleLines: PowerShell 家族 → PS 版(`;`/`if ($?)`、注明 7+)', () => {
  const lines = leaf.windowsRuleLines(env({ KHY_SHELL: 'powershell' }));
  const joined = lines.join('\n');
  assert.match(joined, /PowerShell/);
  assert.match(joined, /if \(\$\?\)/);
  assert.match(joined, /PowerShell 7\+/);
  // 不应出现 legacy 的 cmd.exe 断言
  assert.doesNotMatch(joined, /execute via cmd\.exe/);
});

test('windowsRuleLines: cmd / 门关 → 逐字节 legacy', () => {
  // cmd 家族
  assert.deepEqual(leaf.windowsRuleLines(env({ KHY_SHELL: 'cmd' })), leaf.LEGACY_WINDOWS_RULE_LINES);
  // 门关(即便 powershell 家族)
  assert.deepEqual(
    leaf.windowsRuleLines(env({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: '0' })),
    leaf.LEGACY_WINDOWS_RULE_LINES,
  );
  // 无任何提示 → legacy
  assert.deepEqual(leaf.windowsRuleLines(env({})), leaf.LEGACY_WINDOWS_RULE_LINES);
});

test('multiCommandLines: PowerShell 家族 → PS 版;其余 → 逐字节 legacy', () => {
  const ps = leaf.multiCommandLines(env({ KHY_SHELL: 'pwsh' }));
  assert.deepEqual(ps, leaf.POWERSHELL_MULTI_COMMAND_LINES);
  assert.match(ps.join('\n'), /if \(\$\?\)/);
  // 门关字节回退
  assert.deepEqual(
    leaf.multiCommandLines(env({ KHY_SHELL: 'pwsh', KHY_POWERSHELL_CHAIN_STYLE: 'no' })),
    leaf.LEGACY_MULTI_COMMAND_LINES,
  );
  // cmd / 无提示 → legacy
  assert.deepEqual(leaf.multiCommandLines(env({ KHY_SHELL: 'cmd' })), leaf.LEGACY_MULTI_COMMAND_LINES);
  assert.deepEqual(leaf.multiCommandLines(env({})), leaf.LEGACY_MULTI_COMMAND_LINES);
});

test('parseExecOverride: 门开归一化 token;门关恒 null', () => {
  assert.equal(leaf.parseExecOverride(env({ KHY_SHELL: 'powershell' })), 'powershell');
  assert.equal(leaf.parseExecOverride(env({ KHY_SHELL: 'pwsh' })), 'pwsh');
  assert.equal(leaf.parseExecOverride(env({ KHY_SHELL: 'cmd' })), 'cmd');
  assert.equal(leaf.parseExecOverride(env({ KHY_SHELL: 'gitbash' })), 'bash');
  assert.equal(leaf.parseExecOverride(env({ KHY_SHELL: 'posix' })), 'sh');
  assert.equal(leaf.parseExecOverride(env({ KHY_SHELL: 'nonsense' })), null);
  assert.equal(leaf.parseExecOverride(env({})), null);
  // 门关 → 恒 null(不覆盖实际 spawn)
  assert.equal(
    leaf.parseExecOverride(env({ KHY_SHELL: 'powershell', KHY_POWERSHELL_CHAIN_STYLE: 'off' })),
    null,
  );
});

test('legacy 常量含 `&&`;PowerShell 常量注明 5.1 不支持 `&&`', () => {
  assert.match(leaf.LEGACY_WINDOWS_RULE_LINES.join('\n'), /Use `&&` to chain commands/);
  assert.match(leaf.LEGACY_MULTI_COMMAND_LINES.join('\n'), /chain with '&&'/);
  assert.match(leaf.POWERSHELL_WINDOWS_RULE_LINES.join('\n'), /does NOT support `&&`/);
  assert.match(leaf.POWERSHELL_MULTI_COMMAND_LINES.join('\n'), /does NOT support `&&`/);
});
