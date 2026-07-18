'use strict';

/**
 * toolchainHeal.test.js — Phase 3：编译工具链自动安装的接线证据。
 *
 * 约束（用户长期）：能代码约束就不用提示词注入。缺失工具链不是「打印提示」，
 * 而是产出带 top-level depId 的结构化软失败，executeTool 的依赖自愈漏斗据此
 * 探测→询问→隔离安装→重试恰一次（与 webSearch/news 同一约定，见
 * searchToolHealingWiring.test.js）。
 *
 * 本套件只验证「工具侧正确发出可被 detectFromError 精准辨认的缺失信号」与
 * 「绝不把真实编译错误误判为缺工具链」。自愈循环本身的安装+重试机制由
 * dependencyHealing.test.js 覆盖，不在此重复。
 *
 * 全程零真实工具链依赖：build_project 用无害的 shell 覆盖命令模拟
 * 「command not found」/真实编译错误；compile_file 用桩替换 dep.ensure。
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const buildProject = require('../../../src/tools/buildProject');
const compileFile = require('../../../src/tools/compileFile');
const resolver = require('../../../src/services/dependency/resolver');

function mkProject(markerFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-toolchain-'));
  fs.writeFileSync(path.join(dir, markerFile), '{}');
  return dir;
}

// ── build_project: missing toolchain → tagged depId ─────────────────────────
describe('build_project — 缺工具链发出带 depId 的结构化软失败', () => {
  test('command-not-found（exit 127）→ 结果带 projectType 对应 depId，detectFromError 命中', async () => {
    const dir = mkProject('Cargo.toml'); // projectType = rust
    try {
      const r = await buildProject.execute({
        cwd: dir,
        command: "printf 'cargo: command not found\\n' >&2; exit 127",
      });
      assert.equal(r.success, false);
      assert.equal(r.depId, 'rust');
      // 端到端接线证据：自愈层据此结果能精准回溯辨认依赖。
      assert.equal(resolver.detectFromError(r).depId, 'rust');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('每生态 projectType 映射到正确 depId', async () => {
    const cases = [
      ['go.mod', 'go'],
      ['Makefile', 'make'],
      ['moon.mod.json', 'moonbit'],
      ['CMakeLists.txt', 'cmake'],
    ];
    for (const [marker, depId] of cases) {
      const dir = mkProject(marker);
      try {
        const r = await buildProject.execute({
          cwd: dir,
          command: "printf 'tool: command not found\\n' >&2; exit 127",
        });
        assert.equal(r.success, false, `${marker} build should fail`);
        assert.equal(r.depId, depId, `${marker} → ${depId}`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test('真实编译错误（工具已运行，exit≠0）绝不误判为缺工具链', async () => {
    const dir = mkProject('Cargo.toml'); // projectType = rust
    try {
      const r = await buildProject.execute({
        cwd: dir,
        command: "printf 'error[E0308]: mismatched types\\n' >&2; exit 1",
      });
      assert.equal(r.success, false);
      // 关键：没有 depId → 不会触发依赖自愈（否则会错误地去装编译器）。
      assert.equal(r.depId, undefined);
      assert.equal(resolver.detectFromError(r), null);
      // 结构化诊断仍如实保留。
      assert.ok(r.data.errorCount >= 1, 'compile diagnostics preserved');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('无注册表条目的生态（如 nodejs）即便 command-not-found 也不杜撰 depId', async () => {
    const dir = mkProject('package.json'); // projectType = nodejs（无 toolchain 条目）
    try {
      const r = await buildProject.execute({
        cwd: dir,
        command: "printf 'npm: command not found\\n' >&2; exit 127",
      });
      assert.equal(r.success, false);
      assert.equal(r.depId, undefined);
      assert.equal(resolver.detectFromError(r), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── compile_file: 缺工具链上前置探针 → 带 depId 软失败 ────────────────────────
describe('compile_file — 缺工具链发出带 depId 的结构化软失败', () => {
  const dep = require('../../../src/services/dependency');
  const _origEnsure = dep.ensure;
  afterEach(() => { dep.ensure = _origEnsure; });

  test('上前置探针报缺失 → 结果带 depId，detectFromError 命中（不打印提示）', async () => {
    // 桩：把 c 的工具链探针强制判为缺失（缓存模块对象上替换 ensure 引用）。
    dep.ensure = (id) => (id === 'gcc'
      ? new dep.MissingDependencyError('gcc')
      : _origEnsure(id));

    const r = await compileFile.execute({ language: 'c', code: 'int main(){return 0;}' });
    assert.equal(r.success, false);
    assert.equal(r.depId, 'gcc');
    assert.equal(resolver.detectFromError(r).depId, 'gcc');
  });

  test('探针就绪时不污染正常路径（无 depId，照常编译）', async () => {
    // 不打桩；仅断言：当 ensure 返回 null（工具链在位）时不会平白带 depId。
    // 工具链不在位的机器上该用例自然跳过编译断言，只验证无杜撰 depId。
    dep.ensure = () => null; // 强制「在位」，绕过真实探针
    const r = await compileFile.execute({ language: 'python', code: 'print(1)' });
    // python 用 py_compile，若 python3 实际缺失会经 ENOENT 路径回到 depId；
    // 这里只断言：成功或失败都不来自上前置探针误报。
    if (r.success) {
      assert.equal(r.depId, undefined);
    } else {
      // 仅当真实缺 python3 时 ENOENT 路径才会带 depId='python3'。
      assert.ok(r.depId === undefined || r.depId === 'python3');
    }
  });
});
