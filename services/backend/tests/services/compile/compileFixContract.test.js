'use strict';

/**
 * compileFixContract.test.js — Phase 4：编译→报错→修复闭环的「透明、有界」契约。
 *
 * 设计立场（写进规范的红线）：
 *   1) 绝不在工具内部跑「模型自动改代码」的隐藏循环——那会与顶层 agent loop 互斗、
 *      脆弱且烧 token。代码类错误一律**只返回精确诊断 + nextAction**，由顶层
 *      agent 自然驱动 edit→rebuild。
 *   2) 工具链/依赖类错误的「自动修复 + 重编」是确定性的，且**有界**：唯一的自动重试
 *      来自 executeTool 的依赖自愈漏斗（安装 + 恰重试一次），工具自身单次调用 = 单次编译。
 *
 * 本套件证明：单次 execute 只编译一次（无内部循环）、代码错返回诊断 + nextAction、
 * 且工具绝不改动源代码（输入文件内容前后一致）。
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const buildProject = require('../../../src/tools/buildProject');
const compileFile = require('../../../src/tools/compileFile');

function have(bin) {
  try { return spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

describe('build_project — 透明有界契约', () => {
  test('单次 execute 只运行一次构建命令（无隐藏内部循环）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-iter-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '{}');
    const counter = path.join(dir, 'runs.count');
    try {
      // 每次构建命令执行就向计数文件追加一行；失败退出（exit 1）。
      const r = await buildProject.execute({
        cwd: dir,
        command: `printf 'x\\n' >> "${counter}"; exit 1`,
      });
      assert.equal(r.success, false);
      const runs = fs.readFileSync(counter, 'utf-8').trim().split('\n').filter(Boolean).length;
      assert.equal(runs, 1, '构建命令恰执行一次，工具内部不重试');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('代码类错误 → 返回结构化诊断 + nextAction，且无 depId（不触发依赖自愈）', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-codeerr-'));
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '{}');
    try {
      const r = await buildProject.execute({
        cwd: dir,
        command: "printf 'error[E0425]: cannot find value `x`\\n' >&2; exit 1",
      });
      assert.equal(r.success, false);
      assert.equal(r.depId, undefined);
      assert.ok(r.data.errorCount >= 1);
      assert.ok(r.data.nextAction && /Fix/i.test(r.data.nextAction));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('成功构建 → nextAction 为 null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ok-'));
    fs.writeFileSync(path.join(dir, 'Makefile'), 'all:\n\t@true\n');
    try {
      const r = await buildProject.execute({ cwd: dir, command: 'true' });
      assert.equal(r.success, true);
      assert.equal(r.data.nextAction, null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('compile_file — 透明有界契约', () => {
  test('编译失败绝不改写源文件（只读诊断，不自动 edit）', async (t) => {
    if (!have('gcc')) return t.skip('gcc not installed');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-noedit-'));
    const src = path.join(dir, 'broken.c');
    const original = 'int main(){ return undeclared_symbol; }\n';
    fs.writeFileSync(src, original);
    try {
      const r = await compileFile.execute({ language: 'c', file: src });
      assert.equal(r.success, false);
      assert.ok(r.data.errorCount >= 1);
      assert.ok(r.data.nextAction, 'nextAction guides the agent to fix + recompile');
      // 红线：工具绝不替模型改源码。
      assert.equal(fs.readFileSync(src, 'utf-8'), original, '源文件内容前后一致');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('成功编译 → nextAction 为 null（无多余动作）', async (t) => {
    if (!have('gcc')) return t.skip('gcc not installed');
    const r = await compileFile.execute({ language: 'c', code: 'int main(){return 0;}' });
    assert.equal(r.success, true);
    assert.equal(r.data.nextAction, null);
  });
});
