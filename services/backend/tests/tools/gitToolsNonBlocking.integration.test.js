'use strict';

/**
 * gitToolsNonBlocking.integration.test.js — 证明 git 工具族(gitStatus/gitDiff/gitLog)
 * 接入非阻塞 exec 垫片后:门控开(异步 exec)与门控关(同步 execSync)两条路径**输出逐字节
 * 一致**,且门控开时不阻塞事件循环。
 *
 * 这是回归「khy 调用工具卡死」的守卫之一:git 工具此前用同步 execSync 跑子进程,子进程期间
 * 阻塞整个事件循环(spinner 停 / ESC 死)。换异步 exec 后事件循环照转;核心不变量:输出与
 * 今日逐字节一致。
 *
 * 运行:node --test services/backend/tests/tools/gitToolsNonBlocking.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-git-nb-'));
  const run = (c) => execSync(c, { cwd: dir, stdio: 'pipe' });
  run('git init -q');
  run('git config user.email t@t.t');
  run('git config user.name t');
  run('git config commit.gpgsign false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  run('git add a.txt');
  run('git commit -q -m "init"');
  // 一处未提交改动,让 gitStatus/gitDiff 有非空输出。
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n');
  return dir;
}

function loadFreshTool(name) {
  const p = require.resolve(`../../src/tools/${name}.js`);
  delete require.cache[p];
  return require(p);
}

async function runTool(name, params, nonBlocking, cwd) {
  const prevNB = process.env.KHY_EXEC_NONBLOCKING;
  const prevCwd = process.env.KHYQUANT_CWD;
  process.env.KHY_EXEC_NONBLOCKING = nonBlocking ? 'on' : 'off';
  process.env.KHYQUANT_CWD = cwd;
  try {
    const tool = loadFreshTool(name);
    return await tool.execute(params || {}, {});
  } finally {
    if (prevNB === undefined) delete process.env.KHY_EXEC_NONBLOCKING;
    else process.env.KHY_EXEC_NONBLOCKING = prevNB;
    if (prevCwd === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = prevCwd;
  }
}

test('gitStatus / gitDiff / gitLog:门控开(非阻塞)与门控关(execSync)→ 输出逐字节一致', async () => {
  const dir = makeRepo();
  try {
    for (const [name, params] of [['gitStatus', {}], ['gitDiff', {}], ['gitLog', { max_count: 5 }]]) {
      const on = await runTool(name, params, true, dir);
      const off = await runTool(name, params, false, dir);
      assert.equal(on.success, true, `${name} ON should succeed`);
      assert.equal(off.success, true, `${name} OFF should succeed`);
      assert.equal(on.output, off.output, `${name}: output must be byte-identical on vs off`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gitStatus:门控开时事件循环不被阻塞(setImmediate 可穿插)', async () => {
  const dir = makeRepo();
  try {
    const prevNB = process.env.KHY_EXEC_NONBLOCKING;
    const prevCwd = process.env.KHYQUANT_CWD;
    process.env.KHY_EXEC_NONBLOCKING = 'on';
    process.env.KHYQUANT_CWD = dir;
    try {
      const tool = loadFreshTool('gitStatus');
      let immediateFired = false;
      const p = tool.execute({}, {});
      setImmediate(() => { immediateFired = true; });
      const res = await p;
      assert.equal(res.success, true);
      assert.equal(immediateFired, true, 'event loop kept turning during git exec (non-blocking)');
    } finally {
      if (prevNB === undefined) delete process.env.KHY_EXEC_NONBLOCKING;
      else process.env.KHY_EXEC_NONBLOCKING = prevNB;
      if (prevCwd === undefined) delete process.env.KHYQUANT_CWD;
      else process.env.KHYQUANT_CWD = prevCwd;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
