'use strict';

// MonitorTool 后台化契约测试(对齐 CC Monitor 非阻塞 + 实时可读 outputFile + 退出通知)。
// 用真子进程(node -e),零网络。门控梯 + 非阻塞 + 文件落盘 + backgroundShells 通知。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const MonitorTool = require('../../src/tools/MonitorTool');
const { _monitorBackgroundEnabled } = MonitorTool;
const { backgroundShells } = require('../../src/tools/backgroundShellRegistry');

function waitFor(predicate, timeoutMs = 5000, stepMs = 25) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      let ok = false;
      try { ok = predicate(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, stepMs);
    };
    tick();
  });
}

test('_monitorBackgroundEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(_monitorBackgroundEnabled({}), true);
  assert.strictEqual(_monitorBackgroundEnabled({ KHY_MONITOR_BACKGROUND: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(_monitorBackgroundEnabled({ KHY_MONITOR_BACKGROUND: off }), false, `应关: ${off}`);
  }
});

test('inputSchema:command 必填,description/timeout 可选', () => {
  const t = new MonitorTool();
  const s = t.inputSchema;
  assert.deepStrictEqual(s.required, ['command']);
  assert.ok(s.properties.command && s.properties.description && s.properties.timeout);
});

test('isConcurrencySafe 随门控:开→true,关→false', () => {
  const t = new MonitorTool();
  const saved = process.env.KHY_MONITOR_BACKGROUND;
  try {
    delete process.env.KHY_MONITOR_BACKGROUND;
    assert.strictEqual(t.isConcurrencySafe(), true);
    process.env.KHY_MONITOR_BACKGROUND = 'off';
    assert.strictEqual(t.isConcurrencySafe(), false);
  } finally {
    if (saved === undefined) delete process.env.KHY_MONITOR_BACKGROUND;
    else process.env.KHY_MONITOR_BACKGROUND = saved;
  }
});

test('后台模式:立即返回 taskId+outputFile(非阻塞),不等进程退出', async () => {
  const saved = process.env.KHY_MONITOR_BACKGROUND;
  delete process.env.KHY_MONITOR_BACKGROUND; // 默认开
  try {
    const t = new MonitorTool();
    // 一个会跑 ~1.5s 的进程;execute 必须在它退出前就返回。
    const cmd = process.platform === 'win32'
      ? 'ping -n 2 127.0.0.1 >NUL & echo done'
      : 'sleep 1.5; echo done';
    const t0 = Date.now();
    const res = await t.execute({ command: cmd, description: 'slow job' });
    const elapsed = Date.now() - t0;

    assert.strictEqual(res.success, true);
    assert.ok(res.taskId && /^mon-/.test(res.taskId), 'taskId 应以 mon- 前缀');
    assert.strictEqual(res.backgroundTaskId, res.taskId);
    assert.ok(res.outputFile && res.outputFile.includes(res.taskId), 'outputFile 含 taskId');
    assert.ok(elapsed < 1000, `应立即返回(非阻塞),实际 ${elapsed}ms`);

    // 注册进 backgroundShells,初始 running
    const entry = backgroundShells.get(res.taskId);
    assert.ok(entry, '应注册进 backgroundShells');
    assert.strictEqual(entry.kind, 'monitor');
    assert.strictEqual(entry.status, 'running');

    // 等进程退出 → entry 转 completed,且 outputFile 含输出
    await waitFor(() => backgroundShells.get(res.taskId).status === 'completed');
    assert.strictEqual(entry.status, 'completed');
    assert.strictEqual(entry.result.exitCode, 0);
    const fileContent = fs.readFileSync(res.outputFile, 'utf8');
    assert.match(fileContent, /done/);

    backgroundShells.delete(res.taskId);
    try { fs.unlinkSync(res.outputFile); } catch { /* ignore */ }
  } finally {
    if (saved === undefined) delete process.env.KHY_MONITOR_BACKGROUND;
    else process.env.KHY_MONITOR_BACKGROUND = saved;
  }
});

test('后台模式:outputFile 实时可读(进程未退出时已有输出)', async () => {
  const saved = process.env.KHY_MONITOR_BACKGROUND;
  delete process.env.KHY_MONITOR_BACKGROUND;
  try {
    const t = new MonitorTool();
    const cmd = process.platform === 'win32'
      ? 'echo early & ping -n 3 127.0.0.1 >NUL'
      : 'echo early; sleep 2';
    const res = await t.execute({ command: cmd, description: 'early output' });
    // 进程仍在跑时,文件里已应出现 early
    await waitFor(() => {
      try { return /early/.test(fs.readFileSync(res.outputFile, 'utf8')); } catch { return false; }
    }, 3000);
    assert.strictEqual(backgroundShells.get(res.taskId).status, 'running', '读到 early 时进程仍 running(真实时)');

    await waitFor(() => backgroundShells.get(res.taskId).status === 'completed', 6000);
    backgroundShells.delete(res.taskId);
    try { fs.unlinkSync(res.outputFile); } catch { /* ignore */ }
  } finally {
    if (saved === undefined) delete process.env.KHY_MONITOR_BACKGROUND;
    else process.env.KHY_MONITOR_BACKGROUND = saved;
  }
});

test('后台模式:失败进程 → entry.status=failed,带 exitCode', async () => {
  const saved = process.env.KHY_MONITOR_BACKGROUND;
  delete process.env.KHY_MONITOR_BACKGROUND;
  try {
    const t = new MonitorTool();
    const cmd = process.platform === 'win32' ? 'exit 3' : 'exit 3';
    const res = await t.execute({ command: cmd, description: 'failing' });
    await waitFor(() => {
      const e = backgroundShells.get(res.taskId);
      return e && (e.status === 'failed' || e.status === 'completed');
    });
    const entry = backgroundShells.get(res.taskId);
    assert.strictEqual(entry.status, 'failed');
    assert.strictEqual(entry.result.exitCode, 3);
    assert.match(String(entry.error || ''), /exited with code 3/);
    backgroundShells.delete(res.taskId);
    try { fs.unlinkSync(res.outputFile); } catch { /* ignore */ }
  } finally {
    if (saved === undefined) delete process.env.KHY_MONITOR_BACKGROUND;
    else process.env.KHY_MONITOR_BACKGROUND = saved;
  }
});

test('门控关:逐字节回退旧阻塞行为(阻塞到退出,返回 exitCode+output 内联,无 taskId)', async () => {
  const saved = process.env.KHY_MONITOR_BACKGROUND;
  process.env.KHY_MONITOR_BACKGROUND = 'off';
  try {
    const t = new MonitorTool();
    const cmd = process.platform === 'win32' ? 'echo hi' : 'echo hi';
    const t0 = Date.now();
    const res = await t.execute({ command: cmd, description: 'blocking' });
    // 旧行为:有 exitCode/output,无 taskId/outputFile
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.match(res.output, /hi/);
    assert.strictEqual(res.taskId, undefined);
    assert.strictEqual(res.outputFile, undefined);
    assert.ok(Date.now() - t0 >= 0);
  } finally {
    if (saved === undefined) delete process.env.KHY_MONITOR_BACKGROUND;
    else process.env.KHY_MONITOR_BACKGROUND = saved;
  }
});

test('drain:退出后 collectBackgroundResults 产出一条 monitor 通知(命令+summary),一次性', async () => {
  const saved = process.env.KHY_MONITOR_BACKGROUND;
  delete process.env.KHY_MONITOR_BACKGROUND;
  try {
    const reg = require('../../src/tools/backgroundShellRegistry');
    const t = new MonitorTool();
    const cmd = process.platform === 'win32' ? 'echo notif-out' : 'echo notif-out';
    const res = await t.execute({ command: cmd, description: 'notify test' });
    await waitFor(() => {
      const e = reg.backgroundShells.get(res.taskId);
      return e && (e.status === 'completed' || e.status === 'failed');
    });
    const drained = reg.collectBackgroundResults().filter(d => d.taskId === res.taskId);
    assert.strictEqual(drained.length, 1, '退出后应排空恰好一条');
    assert.strictEqual(drained[0].status, 'completed');
    assert.strictEqual(drained[0].command, cmd);
    assert.match(drained[0].summary, /notif-out/);
    // 一次性:再 drain 不再产出
    const again = reg.collectBackgroundResults().filter(d => d.taskId === res.taskId);
    assert.strictEqual(again.length, 0, '一次性,二次 drain 不再产出');
    reg.backgroundShells.delete(res.taskId);
    try { fs.unlinkSync(res.outputFile); } catch { /* ignore */ }
  } finally {
    if (saved === undefined) delete process.env.KHY_MONITOR_BACKGROUND;
    else process.env.KHY_MONITOR_BACKGROUND = saved;
  }
});
