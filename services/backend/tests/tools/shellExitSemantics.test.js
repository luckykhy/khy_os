'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  interpretShellExit,
  _heuristicBaseCommand,
  _baseOfSegment,
} = require('../../src/tools/shellExitSemantics');

// 关门控用环境(显式关 → 必须逐字节回退 legacy 语义)
const OFF = { KHY_SHELL_EXIT_SEMANTICS: '0' };
// 开门控(默认即开;显式给空对象走 process.env-less 路径也算开)
const ON = {};

test('grep: exit 1 = 无匹配 → 成功 + "No matches found"(对齐 CC)', () => {
  const v = interpretShellExit('grep foo file.txt', 1, ON);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.message, 'No matches found');
  assert.strictEqual(v.source, 'semantic');
});

test('grep: exit 0 = 有匹配 → 成功无 note', () => {
  const v = interpretShellExit('grep foo file.txt', 0, ON);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.message, undefined);
});

test('grep: exit 2 = 真错误 → 失败', () => {
  const v = interpretShellExit('grep foo /nope', 2, ON);
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.message, undefined);
});

test('rg(ripgrep): exit 1 同 grep → 成功 + "No matches found"', () => {
  const v = interpretShellExit('rg pattern src/', 1, ON);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.message, 'No matches found');
});

test('diff: exit 1 = 有差异 → 成功 + "Files differ"', () => {
  const v = interpretShellExit('diff a.txt b.txt', 1, ON);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.message, 'Files differ');
});

test('find: exit 1 = 部分目录不可访问 → 成功 + note', () => {
  const v = interpretShellExit('find / -name x', 1, ON);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.message, 'Some directories were inaccessible');
});

test('test / [ : exit 1 = 条件假 → 成功 + "Condition is false"', () => {
  assert.strictEqual(interpretShellExit('test -f /nope', 1, ON).message, 'Condition is false');
  assert.strictEqual(interpretShellExit('test -f /nope', 1, ON).isError, false);
  assert.strictEqual(interpretShellExit('[ -f /nope ]', 1, ON).message, 'Condition is false');
});

test('管道:最后一段命令决定退出码(cat f | grep x → grep)', () => {
  const v = interpretShellExit('cat file | grep needle', 1, ON);
  assert.strictEqual(v.isError, false);
  assert.strictEqual(v.message, 'No matches found');
});

test('逻辑链 && / || / ; 取最后一段', () => {
  assert.strictEqual(interpretShellExit('cd x && grep y z', 1, ON).message, 'No matches found');
  assert.strictEqual(interpretShellExit('foo; diff a b', 1, ON).message, 'Files differ');
});

test('未知命令 → legacy(非零=失败,无 note)', () => {
  const v = interpretShellExit('npm test', 1, ON);
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.message, undefined);
  assert.strictEqual(v.source, 'legacy');
});

test('未知命令 exit 0 → 成功', () => {
  assert.strictEqual(interpretShellExit('npm test', 0, ON).isError, false);
});

test('门控关 KHY_SHELL_EXIT_SEMANTICS=0 → grep exit 1 逐字节回退失败、无 note', () => {
  const v = interpretShellExit('grep foo file.txt', 1, OFF);
  assert.strictEqual(v.isError, true);
  assert.strictEqual(v.message, undefined);
  assert.strictEqual(v.source, 'legacy');
});

test('门控关 false/off/no 同回退', () => {
  for (const val of ['false', 'off', 'no', 'FALSE', 'Off']) {
    const v = interpretShellExit('grep x y', 1, { KHY_SHELL_EXIT_SEMANTICS: val });
    assert.strictEqual(v.isError, true, `gate=${val} should be legacy`);
    assert.strictEqual(v.message, undefined);
  }
});

test('门控开 + grep exit 0:门控关与开对 exit 0 行为一致(都成功)', () => {
  assert.strictEqual(interpretShellExit('grep x y', 0, ON).isError, false);
  assert.strictEqual(interpretShellExit('grep x y', 0, OFF).isError, false);
});

test('非有限退出码(null/NaN,如信号杀死)→ 视作 0,legacy 成功', () => {
  assert.strictEqual(interpretShellExit('npm test', null, ON).isError, false);
  assert.strictEqual(interpretShellExit('npm test', NaN, ON).isError, false);
});

test('空/异常命令绝不抛 → legacy', () => {
  assert.strictEqual(interpretShellExit('', 1, ON).isError, true);
  assert.strictEqual(interpretShellExit(null, 0, ON).isError, false);
  assert.strictEqual(interpretShellExit(undefined, 2, ON).isError, true);
});

test('路径形式命令取 basename(/usr/bin/grep → grep)', () => {
  const v = interpretShellExit('/usr/bin/grep foo bar', 1, ON);
  assert.strictEqual(v.message, 'No matches found');
});

test('env 赋值与 sudo/env 前缀被跳过', () => {
  assert.strictEqual(_baseOfSegment('FOO=bar grep x y'), 'grep');
  assert.strictEqual(_baseOfSegment('sudo grep x y'), 'grep');
  assert.strictEqual(_baseOfSegment('env grep x y'), 'grep');
  assert.strictEqual(interpretShellExit('LC_ALL=C grep x y', 1, ON).message, 'No matches found');
});

test('_heuristicBaseCommand 直测', () => {
  assert.strictEqual(_heuristicBaseCommand('grep x'), 'grep');
  assert.strictEqual(_heuristicBaseCommand('a | b | rg z'), 'rg');
  assert.strictEqual(_heuristicBaseCommand('   '), '');
  assert.strictEqual(_heuristicBaseCommand(''), '');
});
