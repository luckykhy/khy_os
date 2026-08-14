'use strict';

/**
 * executeCodeMultiLang.test.js — Phase 5：executeCode 多语言执行。
 *
 *   • JavaScript 路径不回归：仍走 `node --permission` 强隔离子进程。
 *   • 非 JS（python/c/...）：ephemeral 临时目录编译/解释执行，受限 env + 空闲 SIGKILL
 *     + 输出上限。诚实标注信任边界（进程+env+fs-tmp，非 syscall 沙箱）。
 *   • 缺工具链 → 带 depId 的结构化软失败（交依赖自愈漏斗）。
 *   • 默认关闭：未设 KHY_ENABLE_EXECUTE_CODE=1 一律拒绝。
 *
 * 工具链相关用例按存在性 guard，缺则 skip，保持任意机器上绿。
 * 为缩短超时用例时长，在 require 前压低 VM/PROC 超时。
 */

process.env.KHY_ENABLE_EXECUTE_CODE = '1';
process.env.KHY_EXECUTE_CODE_VM_TIMEOUT_MS = '500';
process.env.KHY_EXECUTE_CODE_PROC_TIMEOUT_MS = '1500';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');

const executeCode = require('../src/tools/executeCode');

function have(bin) {
  try { return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

describe('executeCode — JavaScript 路径不回归', () => {
  test('JS 片段仍在受限子进程内执行，返回末表达式值', async () => {
    const r = await executeCode.execute({ code: '1 + 2', language: 'javascript' });
    assert.equal(r.success, true);
    assert.equal(r.result, '3');
  });

  test('未指定语言默认 javascript', async () => {
    const r = await executeCode.execute({ code: '"a" + "b"' });
    assert.equal(r.success, true);
    assert.equal(r.result, 'ab');
  });

  test('JS 子进程无文件系统权限（隔离仍生效）', async () => {
    const r = await executeCode.execute({ code: "require('fs').readFileSync('/etc/hostname')" });
    assert.equal(r.success, false); // Permission Model 拒绝 → 受控失败
  });
});

describe('executeCode — 非 JS 执行（按工具链存在性 guard）', () => {
  test('Python 解释执行并捕获 stdout', async (t) => {
    if (!have('python3')) return t.skip('python3 not installed');
    const r = await executeCode.execute({ code: 'print(6 * 7)', language: 'python' });
    assert.equal(r.success, true);
    assert.match(r.result, /42/);
    assert.equal(r.data.language, 'python');
    assert.match(r.data.trustBoundary, /NOT a syscall sandbox/);
  });

  test('C 先编译后执行，捕获 stdout', async (t) => {
    if (!have('gcc')) return t.skip('gcc not installed');
    const code = '#include <stdio.h>\nint main(){ printf("hi-c\\n"); return 0; }';
    const r = await executeCode.execute({ code, language: 'c' });
    assert.equal(r.success, true);
    assert.match(r.result, /hi-c/);
  });

  test('C 编译错误 → 执行前返回结构化诊断（不运行）', async (t) => {
    if (!have('gcc')) return t.skip('gcc not installed');
    const r = await executeCode.execute({ code: 'int main(){ return missing; }', language: 'c' });
    assert.equal(r.success, false);
    assert.equal(r.data.phase, 'compile');
    assert.ok(r.data.errorCount >= 1);
  });

  test('Python 死循环 → 空闲超时被 SIGKILL', async (t) => {
    if (!have('python3')) return t.skip('python3 not installed');
    const r = await executeCode.execute({ code: 'while True:\n    pass', language: 'python' });
    assert.equal(r.success, false);
    assert.match(r.error, /timed out/i);
  });
});

describe('executeCode — 约束', () => {
  test('未知语言 → 结构化不支持错误', async () => {
    const r = await executeCode.execute({ code: 'x', language: 'ruby' });
    assert.equal(r.success, false);
    assert.match(r.error, /Unsupported language/);
  });

  test('默认关闭：未开启时一律拒绝（即便非 JS）', async () => {
    const prev = process.env.KHY_ENABLE_EXECUTE_CODE;
    process.env.KHY_ENABLE_EXECUTE_CODE = '0';
    try {
      const r = await executeCode.execute({ code: 'print(1)', language: 'python' });
      assert.equal(r.success, false);
      assert.match(r.error, /disabled by default/);
    } finally {
      process.env.KHY_ENABLE_EXECUTE_CODE = prev;
    }
  });
});
