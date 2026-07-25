'use strict';

/**
 * shellFallbackNonBlocking.integration.test.js — 证明 shellCommand 的 execSync 回退路径
 * (KHY_SHELL_IDLE_TIMEOUT_ENABLED=false 时命中)在非阻塞 exec 垫片(门控开)与今日同步
 * execSync(门控关)两条路径上**输出一致**,且门控开时不阻塞事件循环。
 *
 * 这是回归「khy 调用工具卡死」的守卫之一:回退路径用同步 execSync 跑命令,子进程期间阻塞
 * 整个事件循环。换异步 exec 后事件循环照转;核心不变量:输出与今日逐字节一致。
 *
 * 运行:node --test services/backend/tests/tools/shellFallbackNonBlocking.integration.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

function loadFreshShell() {
  delete require.cache[require.resolve('../../src/tools/shellCommand.js')];
  return require('../../src/tools/shellCommand.js');
}

async function runShell(cmd, nonBlocking) {
  // 强制走 execSync/execAsync 回退路径(关 idle-timeout 主 spawn 路径)。
  const prevIdle = process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED;
  const prevNB = process.env.KHY_EXEC_NONBLOCKING;
  process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'false';
  process.env.KHY_EXEC_NONBLOCKING = nonBlocking ? 'on' : 'off';
  try {
    const shell = loadFreshShell();
    const tool = (shell && typeof shell.execute === 'function') ? shell : null;
    assert.ok(tool, 'shellCommand tool should be enabled');
    return await tool.execute({ command: cmd }, {});
  } finally {
    if (prevIdle === undefined) delete process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED;
    else process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = prevIdle;
    if (prevNB === undefined) delete process.env.KHY_EXEC_NONBLOCKING;
    else process.env.KHY_EXEC_NONBLOCKING = prevNB;
  }
}

test('回退路径:门控开(非阻塞)与门控关(execSync)→ 命令输出一致', async () => {
  const on = await runShell('printf "line1\\nline2"', true);
  const off = await runShell('printf "line1\\nline2"', false);
  assert.equal(on.success, true);
  assert.equal(off.success, true);
  assert.equal(on.output, off.output, 'output must be byte-identical on vs off');
  assert.ok(on.output.includes('line1') && on.output.includes('line2'));
});

test('回退路径:门控开时事件循环不被阻塞(setImmediate 可穿插)', async () => {
  const prevIdle = process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED;
  const prevNB = process.env.KHY_EXEC_NONBLOCKING;
  process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = 'false';
  process.env.KHY_EXEC_NONBLOCKING = 'on';
  try {
    const shell = loadFreshShell();
    let immediateFired = false;
    const p = shell.execute({ command: 'sh -c "sleep 0.2; printf done"' }, {});
    setImmediate(() => { immediateFired = true; });
    const res = await p;
    assert.equal(res.success, true);
    assert.equal(immediateFired, true, 'event loop kept turning during shell exec (non-blocking)');
  } finally {
    if (prevIdle === undefined) delete process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED;
    else process.env.KHY_SHELL_IDLE_TIMEOUT_ENABLED = prevIdle;
    if (prevNB === undefined) delete process.env.KHY_EXEC_NONBLOCKING;
    else process.env.KHY_EXEC_NONBLOCKING = prevNB;
  }
});
