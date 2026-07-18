'use strict';

// KillShellTool 契约测试(node:test)。
// 覆盖:门控开关、缺 bash_id、未知 id、已结束态、无句柄旧条目、真实 kill 一个
// 长跑后台 shell(经 shellCommand run_in_background)→ status 落 failed + killRequested。

const test = require('node:test');
const assert = require('node:assert');

const KillShellTool = require('../../src/tools/KillShellTool');
const { killShellToolEnabled } = KillShellTool;
const { backgroundShells } = require('../../src/tools/backgroundShellRegistry');

function freshTool() { return new KillShellTool(); }

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(killShellToolEnabled({}), true);
  assert.strictEqual(killShellToolEnabled({ KHY_KILL_SHELL_TOOL: '' }), true);
  assert.strictEqual(killShellToolEnabled({ KHY_KILL_SHELL_TOOL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(killShellToolEnabled({ KHY_KILL_SHELL_TOOL: off }), false, `${JSON.stringify(off)} 应关`);
  }
});

test('静态元数据:非只读、risk medium、aliases', () => {
  assert.strictEqual(KillShellTool.toolName, 'KillShell');
  assert.strictEqual(KillShellTool.risk, 'medium');
  assert.ok(KillShellTool.aliases.includes('kill_shell'));
  const t = freshTool();
  assert.strictEqual(t.isReadOnly(), false);
});

test('缺 bash_id → error', async () => {
  const r = await freshTool().execute({});
  assert.strictEqual(r.success, false);
  assert.match(r.error, /bash_id is required/);
});

test('未知 id → not found', async () => {
  const r = await freshTool().execute({ bash_id: 'bgsh-nope' });
  assert.strictEqual(r.success, false);
  assert.match(r.error, /not found/);
});

test('已结束态 → 无需终止', async () => {
  const id = 'bgsh-kill-done';
  backgroundShells.set(id, { status: 'completed', command: 'echo', startedAt: 1, kind: 'shell', result: { output: 'x', exitCode: 0 } });
  try {
    const r = await freshTool().execute({ bash_id: id });
    assert.strictEqual(r.success, false);
    assert.strictEqual(r.status, 'completed');
    assert.match(r.message, /已结束/);
  } finally { backgroundShells.delete(id); }
});

test('运行中但无句柄(旧条目)→ 诚实报无可终止句柄', async () => {
  const id = 'bgsh-kill-nohandle';
  backgroundShells.set(id, { status: 'running', command: 'sleep', startedAt: 1, kind: 'shell' });
  try {
    const r = await freshTool().execute({ bash_id: id });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /没有可终止的句柄/);
  } finally { backgroundShells.delete(id); }
});

test('gate off → isEnabled false 且 execute 拒绝', async () => {
  const saved = process.env.KHY_KILL_SHELL_TOOL;
  process.env.KHY_KILL_SHELL_TOOL = 'off';
  try {
    const t = freshTool();
    assert.strictEqual(t.isEnabled(), false);
    const r = await t.execute({ bash_id: 'x' });
    assert.strictEqual(r.success, false);
    assert.match(r.error, /disabled/);
  } finally {
    if (saved == null) delete process.env.KHY_KILL_SHELL_TOOL;
    else process.env.KHY_KILL_SHELL_TOOL = saved;
  }
});

test('execute 绝不抛(坏参数)', async () => {
  await assert.doesNotThrow(async () => { await freshTool().execute(null); });
});

test('端到端:真实终止一个长跑后台 shell(经 shellCommand)', async () => {
  const shellCommand = require('../../src/tools/shellCommand');
  // 启动一个长跑后台命令(60s sleep),拿到 backgroundTaskId。
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'ping -n 60 127.0.0.1 > NUL' : 'sleep 60';
  const started = await shellCommand.execute({ command: cmd, run_in_background: true }, {});
  assert.strictEqual(started.success, true);
  const id = started.backgroundTaskId;
  assert.ok(id, 'should return backgroundTaskId');

  // 给 spawn 一点时间登记 child 句柄。
  await new Promise((r) => setTimeout(r, 300));
  const entry = backgroundShells.get(id);
  assert.ok(entry, 'entry registered');
  assert.strictEqual(entry.status, 'running');
  assert.ok(entry.pid, 'child pid retained via onChild hook');

  // 终止它。
  const r = await freshTool().execute({ bash_id: id });
  assert.strictEqual(r.success, true, JSON.stringify(r));
  assert.strictEqual(r.bash_id, id);
  assert.strictEqual(entry.killRequested, true);

  // close handler 应在短时间内把 status 落到终态(failed/completed)。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && backgroundShells.get(id) && backgroundShells.get(id).status === 'running') {
    await new Promise((res) => setTimeout(res, 100));
  }
  const finalEntry = backgroundShells.get(id);
  assert.ok(finalEntry && finalEntry.status !== 'running', `terminated (status=${finalEntry && finalEntry.status})`);
  backgroundShells.delete(id);
});
