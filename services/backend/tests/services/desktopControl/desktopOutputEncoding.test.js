'use strict';

/**
 * desktopOutputEncoding.test.js — Windows PowerShell 文本回传通道的编码不变量（F2）。
 *
 * 症状：中文 Windows 的控制台代码页是 cp936，PowerShell 重定向 stdout 时按该代码页编码字节，
 * 而 Node 侧 `execFile` 默认按 UTF-8 解码 —— 于是窗口标题、UIA 元素名里的中文全部变成
 * U+FFFD 替换符。`clickElement()` 按 name 寻址，本仓又规定面向用户的字符串是中文，
 * 等于「按名字点控件」在本机上永远命不中。
 *
 * 不变量：凡是我们自己构造、且预期会把文本读回来的 PowerShell 调用，必须先声明
 * stdout 用 UTF-8（无 BOM）。两条路径都要覆盖：`-Command` 内联 与 `-File` 脚本。
 */

const fs = require('fs');
const path = require('path');

const registry = require('../../../src/services/domain/desktop/desktopControl/backendRegistry.js');

const UIA_SCRIPT = path.join(
  __dirname,
  '../../../src/services/domain/desktop/desktopControl/scripts/win-uia-tree.ps1'
);

const isWin = process.platform === 'win32';

function _commandOf(argv) {
  const i = argv.args.indexOf('-Command');
  return i >= 0 ? argv.args[i + 1] : '';
}

describe('F2 — `-Command` 内联 PowerShell 必须自带 UTF-8 stdout 前导', () => {
  test('window 类后端（listWindows 等）每条 -Command 都带前导', () => {
    const backends = registry.backendsFor('win32', 'window') || [];
    expect(backends.length).toBeGreaterThan(0);

    const offenders = [];
    for (const b of backends) {
      for (const [op, build] of Object.entries(b.ops || {})) {
        let argv = null;
        try {
          argv = build('some-window-name');
        } catch {
          continue;
        }
        if (!argv || argv.cmd !== 'powershell') continue;
        if (!/OutputEncoding/.test(_commandOf(argv))) offenders.push(`${b.id}.${op}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('_ps() 产出的命令以 UTF-8 前导开头（单一咽喉，改这里就全覆盖）', () => {
    const argv = registry._internals._ps("'x'");
    expect(_commandOf(argv).startsWith(registry._internals._PS_UTF8_PREAMBLE)).toBe(true);
  });
});

describe('F2 — `-File` UIA 脚本必须自带 UTF-8 stdout 前导', () => {
  test('win-uia-tree.ps1 在任何输出之前设置 [Console]::OutputEncoding', () => {
    const src = fs.readFileSync(UIA_SCRIPT, 'utf8');
    const at = src.indexOf('[Console]::OutputEncoding');
    expect(at).toBeGreaterThan(-1);
    // 必须早于第一处可能写 stdout 的语句
    const firstOutput = src.indexOf('ConvertTo-Json');
    expect(at).toBeLessThan(firstOutput);
    // 无 BOM：带 BOM 会让下游 JSON.parse 直接炸
    expect(/UTF8Encoding\]\::new\(\$false\)|New-Object\s+System\.Text\.UTF8Encoding\(\$false\)/.test(src)).toBe(true);
  });
});

describe('F2 — 行为验证（真跑 PowerShell，仅 Windows）', () => {
  const t = isWin ? test : test.skip;
  t('带前导回显中文 → Node 按 UTF-8 解出原字符，无 U+FFFD', () => {
    const { execFileSync } = require('child_process');
    const preamble = registry._internals._PS_UTF8_PREAMBLE;
    expect(typeof preamble).toBe('string');

    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `${preamble}'\u4e2d\u6587\u6807\u9898'`],
      { encoding: 'utf8', timeout: 20000 }
    );
    expect(out.trim()).toBe('\u4e2d\u6587\u6807\u9898');
    expect(out).not.toContain('\uFFFD');
  });
});
