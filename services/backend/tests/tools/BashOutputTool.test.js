'use strict';

// BashOutputTool 契约测试(node:test)。
// 覆盖:门控开关、未知 id → error、非阻塞读运行中/完成/失败态、
// block 等待完成、gate off → isEnabled false + execute 拒绝。
// 直接对真 backgroundShellRegistry(模块级 Map)读写(无 IO)。

const test = require('node:test');
const assert = require('node:assert');

const BashOutputTool = require('../../src/tools/BashOutputTool');
const { bashOutputToolEnabled } = BashOutputTool;
const { backgroundShells } = require('../../src/tools/backgroundShellRegistry');

function freshTool() { return new BashOutputTool(); }

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(bashOutputToolEnabled({}), true);
  assert.strictEqual(bashOutputToolEnabled({ KHY_BASH_OUTPUT_TOOL: '' }), true);
  assert.strictEqual(bashOutputToolEnabled({ KHY_BASH_OUTPUT_TOOL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(bashOutputToolEnabled({ KHY_BASH_OUTPUT_TOOL: off }), false, `${JSON.stringify(off)} 应关`);
  }
});

test('静态元数据与只读/并发安全契约', () => {
  assert.strictEqual(BashOutputTool.toolName, 'BashOutput');
  assert.strictEqual(BashOutputTool.category, 'system');
  assert.strictEqual(BashOutputTool.risk, 'safe');
  assert.ok(BashOutputTool.aliases.includes('bash_output'));
  const t = freshTool();
  assert.strictEqual(t.isReadOnly(), true);
  assert.strictEqual(t.isConcurrencySafe(), true);
});

test('缺 bash_id → error', async () => {
  const r = await freshTool().execute({});
  assert.match(r.error, /bash_id is required/);
});

test('未知 id → not found error', async () => {
  const r = await freshTool().execute({ bash_id: 'bgsh-does-not-exist', block: false });
  assert.match(r.error, /not found/);
});

test('非阻塞读已完成后台命令 → output/exitCode/status', async () => {
  const id = 'bgsh-test-completed-1';
  backgroundShells.set(id, {
    status: 'completed', command: 'echo hi', startedAt: 1, kind: 'shell',
    result: { output: 'hi\n', exitCode: 0 },
  });
  try {
    const r = await freshTool().execute({ bash_id: id, block: false });
    assert.strictEqual(r.bash_id, id);
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.command, 'echo hi');
    assert.strictEqual(r.output, 'hi\n');
    assert.strictEqual(r.exitCode, 0);
    assert.strictEqual(r.error, null);
  } finally {
    backgroundShells.delete(id);
  }
});

test('非阻塞读失败后台命令 → error 字段透传', async () => {
  const id = 'bgsh-test-failed-1';
  backgroundShells.set(id, {
    status: 'failed', command: 'false', startedAt: 1, kind: 'shell',
    result: { output: 'boom', exitCode: 1 }, error: 'nonzero exit',
  });
  try {
    const r = await freshTool().execute({ bash_id: id, block: false });
    assert.strictEqual(r.status, 'failed');
    assert.strictEqual(r.exitCode, 1);
    assert.strictEqual(r.output, 'boom');
    assert.strictEqual(r.error, 'nonzero exit');
  } finally {
    backgroundShells.delete(id);
  }
});

test('非阻塞读运行中 → status running, output null', async () => {
  const id = 'bgsh-test-running-1';
  backgroundShells.set(id, { status: 'running', command: 'sleep 5', startedAt: 1, kind: 'shell' });
  try {
    const r = await freshTool().execute({ bash_id: id, block: false });
    assert.strictEqual(r.status, 'running');
    assert.strictEqual(r.output, null);
    assert.strictEqual(r.exitCode, null);
  } finally {
    backgroundShells.delete(id);
  }
});

test('block=true 等待完成:运行中被异步置完成 → 读到最终输出', async () => {
  const id = 'bgsh-test-block-1';
  backgroundShells.set(id, { status: 'running', command: 'sleep', startedAt: 1, kind: 'shell' });
  setTimeout(() => {
    const e = backgroundShells.get(id);
    if (e) { e.status = 'completed'; e.result = { output: 'done\n', exitCode: 0 }; }
  }, 700);
  try {
    const r = await freshTool().execute({ bash_id: id, block: true, timeout: 5000 });
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.output, 'done\n');
    assert.strictEqual(r.exitCode, 0);
  } finally {
    backgroundShells.delete(id);
  }
});

test('gate off → isEnabled false 且 execute 拒绝', async () => {
  const saved = process.env.KHY_BASH_OUTPUT_TOOL;
  process.env.KHY_BASH_OUTPUT_TOOL = 'off';
  try {
    const t = freshTool();
    assert.strictEqual(t.isEnabled(), false);
    const r = await t.execute({ bash_id: 'anything' });
    assert.match(r.error, /disabled/);
  } finally {
    if (saved == null) delete process.env.KHY_BASH_OUTPUT_TOOL;
    else process.env.KHY_BASH_OUTPUT_TOOL = saved;
  }
});

test('execute 绝不抛(坏参数)', async () => {
  await assert.doesNotThrow(async () => { await freshTool().execute(null); });
  await assert.doesNotThrow(async () => { await freshTool().execute({ bash_id: 123, block: 'x', timeout: 'y' }); });
});
