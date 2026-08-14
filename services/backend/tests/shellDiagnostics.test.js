'use strict';

/**
 * shellDiagnostics — 错误映射永不塌缩成裸退出码。
 *
 * 真实缺口:`dir "X" 2>nul | find "文件"` 在 Windows 上因 chcp + find 对中文 needle 误判而
 * exit 1,且 `2>nul` 抹掉 stderr → 旧 _composeShellError 只剩 `Command exited with code 1`,
 * 用户与模型都看不到「为什么」。本套件锁定:有 output 时附尾部;无 output 时永远附一条
 * 基于命令形态的诊断(stderr 被丢弃 / find 退出码 1=未匹配 / 通用空)。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { composeShellError, diagnoseEmptyFailure } = require('../src/tools/shellDiagnostics');

describe('diagnoseEmptyFailure — 空输出时推断原因', () => {
  test('find/findstr 退出码 1 → 标注「未匹配,不一定是错误」并点名代码页', () => {
    const msg = diagnoseEmptyFailure(1, 'dir "C:\\x" | find "文件"');
    assert.match(msg, /未匹配/);
    assert.match(msg, /代码页|chcp/);
  });

  test('find 退出码 1 且带 2>nul → 同时提示 stderr 被丢弃', () => {
    const msg = diagnoseEmptyFailure(1, 'dir "C:\\x" 2>nul | find "文件"');
    assert.match(msg, /未匹配/);
    assert.match(msg, /stderr|重定向|nul/i);
  });

  test('非 find、但 2>nul 抹掉 stderr → 提示移除重定向', () => {
    const msg = diagnoseEmptyFailure(2, 'some-tool --do 2>nul');
    assert.match(msg, /stderr|重定向/);
    assert.match(msg, /nul/);
  });

  test('grep 也算过滤器(POSIX 侧)', () => {
    const msg = diagnoseEmptyFailure(1, 'cat f | grep needle');
    assert.match(msg, /未匹配/);
  });

  test('通用空输出 → 退出码是唯一信号', () => {
    const msg = diagnoseEmptyFailure(127, 'mytool --run');
    assert.match(msg, /唯一信号|退出码/);
  });

  test('始终返回非空字符串', () => {
    assert.ok(diagnoseEmptyFailure(1, '').length > 0);
    assert.ok(diagnoseEmptyFailure(0, undefined).length > 0);
  });
});

describe('composeShellError — 永不塌缩成裸退出码', () => {
  test('有 output → 基底 + 输出尾部', () => {
    const out = composeShellError(1, 'mkdir: cannot create directory', 'mkdir /x');
    assert.match(out, /Command exited with code 1/);
    assert.match(out, /cannot create directory/);
  });

  test('空 output → 基底 + 诊断行(不是裸 exit-1)', () => {
    const out = composeShellError(1, '', 'dir 2>nul | find "文件"');
    assert.match(out, /Command exited with code 1/);
    // 关键:不止裸退出码,必须带一句可读诊断。
    assert.ok(out.split('\n').length >= 2, '空输出也要附诊断行');
    assert.match(out, /未匹配/);
  });

  test('超长 output 截尾到 ≤800 字符 + 前导省略号', () => {
    const long = 'A'.repeat(5000) + 'TAIL_MARKER';
    const out = composeShellError(3, long, 'x');
    assert.match(out, /TAIL_MARKER/);
    assert.match(out, /^Command exited with code 3\n…/);
    assert.ok(out.length < 1000);
  });

  test('空白-only output 视同空 → 走诊断分支', () => {
    const out = composeShellError(1, '   \n  \t ', 'a 2>nul');
    assert.match(out, /stderr|重定向/);
  });

  // Pit 1:inline-python 姿势错 → 追加「怎么改」一句(经 pythonInvocationHint 叶子)
  test('python -c 多行 SyntaxError → 附加修复指引', () => {
    const out = composeShellError(
      1,
      'File "<string>", line 1\n    def load(p):\n        ^\nSyntaxError: invalid syntax',
      'python -c "import csv; def load(p): pass"',
    );
    assert.match(out, /Command exited with code 1/);
    assert.match(out, /SyntaxError/);       // 原报错保留
    assert.match(out, /python -c/);         // 追加指引点名 -c
    assert.match(out, /\.py|heredoc|分号/); // 给出可操作改法
  });

  test('普通失败(非 python 姿势错)→ 不追加 python 指引', () => {
    const out = composeShellError(1, 'mkdir: cannot create directory', 'mkdir /x');
    assert.doesNotMatch(out, /python -c/);
  });
});
