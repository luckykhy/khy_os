'use strict';

// BackgroundAgentOutputTool 契约测试(node:test)。
// 覆盖:门控开关、未知 id → error、非阻塞读完成/失败态、block 等待终态、
// gate off → isEnabled false + execute 拒绝。
// 直接对真 _backgroundAgents(模块级 Map)读写(无 IO)。
//
// 存在的理由:见 [DESIGN-ARCH-130] §1.3 —— AgentTool 的工具描述承诺
// "result available via getBackgroundAgent()",而该函数既未注册为工具、
// 也没有任何生产调用点。本工具即该缺口的修补。

const test = require('node:test');
const assert = require('node:assert');

const BackgroundAgentOutputTool = require('../../src/tools/BackgroundAgentOutputTool');
const { bgAgentOutputToolEnabled } = BackgroundAgentOutputTool;
const AgentTool = require('../../src/tools/AgentTool');

function freshTool() {
  return new BackgroundAgentOutputTool();
}

/** 直接写真注册表(与生产同一个 Map),返回清理函数。 */
function seed(id, entry) {
  AgentTool._backgroundAgents.set(id, entry);
  return () => AgentTool._backgroundAgents.delete(id);
}

test('门控默认开(unset/空/未知),{0,false,off,no} 关', () => {
  assert.strictEqual(bgAgentOutputToolEnabled({}), true);
  assert.strictEqual(bgAgentOutputToolEnabled({ KHY_BG_AGENT_OUTPUT_TOOL: '' }), true);
  assert.strictEqual(bgAgentOutputToolEnabled({ KHY_BG_AGENT_OUTPUT_TOOL: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      bgAgentOutputToolEnabled({ KHY_BG_AGENT_OUTPUT_TOOL: off }),
      false,
      `${JSON.stringify(off)} 应关`
    );
  }
});

test('静态元数据与只读/并发安全契约', () => {
  assert.strictEqual(BackgroundAgentOutputTool.toolName, 'BackgroundAgentOutput');
  assert.strictEqual(BackgroundAgentOutputTool.category, 'system');
  assert.strictEqual(BackgroundAgentOutputTool.risk, 'safe');
  assert.ok(BackgroundAgentOutputTool.aliases.includes('background_agent_output'));
  const t = freshTool();
  assert.strictEqual(t.isReadOnly(), true);
  assert.strictEqual(t.isConcurrencySafe(), true);
  assert.strictEqual(t.isEnabled(), true);
});

test('缺 agent_id → error', async () => {
  const r = await freshTool().execute({});
  assert.match(r.error, /agent_id is required/);
});

test('未知 id → not found error(黑洞必须可见,不得静默成功)', async () => {
  const r = await freshTool().execute({ agent_id: 'bg-does-not-exist', block: false });
  assert.match(r.error, /not found/);
});

test('gate off → execute 拒绝', async () => {
  const saved = process.env.KHY_BG_AGENT_OUTPUT_TOOL;
  process.env.KHY_BG_AGENT_OUTPUT_TOOL = 'off';
  try {
    const r = await freshTool().execute({ agent_id: 'bg-anything' });
    assert.match(r.error, /disabled/);
  } finally {
    if (saved === undefined) delete process.env.KHY_BG_AGENT_OUTPUT_TOOL;
    else process.env.KHY_BG_AGENT_OUTPUT_TOOL = saved;
  }
});

test('非阻塞读完成态 → 返回 result 与 subagentType', async () => {
  const id = `bg-test-${Date.now()}`;
  const cleanup = seed(id, {
    status: 'completed',
    startedAt: Date.now(),
    subagentType: 'Explore',
    role: 'explore',
    result: { output: 'found 3 call sites' },
  });
  try {
    const r = await freshTool().execute({ agent_id: id, block: false });
    assert.strictEqual(r.agent_id, id);
    assert.strictEqual(r.status, 'completed');
    assert.strictEqual(r.subagent_type, 'Explore');
    assert.deepStrictEqual(r.result, { output: 'found 3 call sites' });
    assert.strictEqual(r.error, null);
  } finally {
    cleanup();
  }
});

test('非阻塞读失败态 → 暴露 error 而非吞掉', async () => {
  const id = `bg-fail-${Date.now()}`;
  const cleanup = seed(id, {
    status: 'failed',
    startedAt: Date.now(),
    subagentType: 'fix',
    error: 'sub-agent exceeded depth ceiling',
  });
  try {
    const r = await freshTool().execute({ agent_id: id, block: false });
    assert.strictEqual(r.status, 'failed');
    assert.match(r.error, /depth ceiling/);
  } finally {
    cleanup();
  }
});

test('block=true 在终态到达时立即返回(活动式等待,不烧满 timeout)', async () => {
  const id = `bg-block-${Date.now()}`;
  const cleanup = seed(id, { status: 'running', startedAt: Date.now(), subagentType: 'read' });
  const started = Date.now();
  try {
    setTimeout(() => {
      const e = AgentTool._backgroundAgents.get(id);
      if (e) {
        e.status = 'completed';
        e.result = { output: 'done' };
      }
    }, 50);
    const r = await freshTool().execute({ agent_id: id, block: true, timeout: 5000 });
    assert.strictEqual(r.status, 'completed');
    assert.deepStrictEqual(r.result, { output: 'done' });
    // 必须远早于 timeout —— 证明是「观察到终态即返回」而不是死等。
    assert.ok(Date.now() - started < 4000, '不应烧满 timeout');
  } finally {
    cleanup();
  }
});

test('读取不消耗结果(不影响一次性通知的 drain 语义)', async () => {
  const id = `bg-nonconsume-${Date.now()}`;
  const cleanup = seed(id, {
    status: 'completed',
    startedAt: Date.now(),
    subagentType: 'Explore',
    result: { output: 'x' },
  });
  try {
    await freshTool().execute({ agent_id: id, block: false });
    const still = AgentTool.getBackgroundAgent(id);
    assert.ok(still, '读后条目必须仍在注册表里');
    assert.notStrictEqual(still.notified, true, '按需读取不得替 drain 标记 notified');
  } finally {
    cleanup();
  }
});
