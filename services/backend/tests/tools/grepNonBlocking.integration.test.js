'use strict';

/**
 * grepNonBlocking.integration.test.js — 证明 GrepTool 在非阻塞 exec 垫片(门控开)与今日
 * 同步 execSync(门控关)两条路径上**结果一致**,且门控开时不阻塞事件循环。
 *
 * 这是回归本次「khy 调用工具卡死」的守卫之一:Grep 用同步 execSync 跑 rg/grep,子进程期间
 * 阻塞整个事件循环(spinner 停、ESC 无效)。换异步 exec 后事件循环照转;核心不变量:输出与
 * 今日逐字节一致(仅执行原语从阻塞变非阻塞)。
 *
 * 运行:node --test services/backend/tests/tools/grepNonBlocking.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-grep-'));
  fs.writeFileSync(path.join(root, 'a.js'), 'const NEEDLE_TOKEN = 1;\nconst other = 2;\n');
  fs.writeFileSync(path.join(root, 'b.js'), 'function foo() { return NEEDLE_TOKEN; }\n');
  fs.writeFileSync(path.join(root, 'c.txt'), 'no match here\n');
  return root;
}

function loadFreshGrep() {
  delete require.cache[require.resolve('../../src/tools/GrepTool/index.js')];
  return require('../../src/tools/GrepTool/index.js');
}

async function runGrep(root, envValue) {
  const prev = process.env.KHY_EXEC_NONBLOCKING;
  if (envValue === undefined) delete process.env.KHY_EXEC_NONBLOCKING;
  else process.env.KHY_EXEC_NONBLOCKING = envValue;
  try {
    const Grep = loadFreshGrep();
    const inst = Grep.GrepTool ? Grep : Grep;
    const tool = (inst && typeof inst.execute === 'function') ? inst : null;
    assert.ok(tool, 'Grep tool should be enabled');
    return await tool.execute({ pattern: 'NEEDLE_TOKEN', path: root, output_mode: 'files_with_matches' });
  } finally {
    if (prev === undefined) delete process.env.KHY_EXEC_NONBLOCKING;
    else process.env.KHY_EXEC_NONBLOCKING = prev;
  }
}

test('门控开(非阻塞)与门控关(execSync)→ 匹配结果一致', async (t) => {
  const root = mkTree();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  const on = await runGrep(root, undefined);   // 默认开
  const off = await runGrep(root, 'off');       // 逐字节回退 execSync

  assert.equal(on.success, true);
  assert.equal(off.success, true);
  const norm = (res) => (res.files || []).map((f) => path.basename(f)).sort();
  assert.deepEqual(norm(on), norm(off), 'file matches must be identical on vs off');
  // 两文件命中 NEEDLE_TOKEN(a.js、b.js),c.txt 不命中。
  assert.deepEqual(norm(on), ['a.js', 'b.js']);
});

test('门控开:Grep 运行期间事件循环不被阻塞(setImmediate 可穿插)', async (t) => {
  const root = mkTree();
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* */ } });

  process.env.KHY_EXEC_NONBLOCKING = 'on';
  t.after(() => { delete process.env.KHY_EXEC_NONBLOCKING; });

  const Grep = loadFreshGrep();
  let immediateFired = false;
  const p = Grep.execute({ pattern: 'NEEDLE_TOKEN', path: root, output_mode: 'files_with_matches' });
  setImmediate(() => { immediateFired = true; });
  const res = await p;
  assert.equal(res.success, true);
  assert.equal(immediateFired, true, 'event loop kept turning during grep (non-blocking)');
});
