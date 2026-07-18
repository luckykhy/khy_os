'use strict';

/**
 * saveMemoryProactive.test.js — 回归守卫:SaveMemory 工具的**主动写入时机**引导。
 *
 * 背景(goal 2026-07-03「永久/仓库/会话/任务记忆…没把握主动写入与主动调用的时机,
 * 感觉特别健忘」):SaveMemory 原描述只教模型「用户说记住才存」——纯触发式,正是用户
 * 抱怨的窄写入时机。本刀给描述追加**主动捕获**引导(durable 跨会话事实浮现即存)+防噪
 * 护栏(不存易逝/仓库已录/一次性琐事·先查重再更新),门控 KHY_SAVE_MEMORY_PROACTIVE
 * 默认开。这只丰富**模型自选** SaveMemory 的引导,不动确定性自动保存分类器(刻意保守)。
 *
 * 契约:①默认(无 env)→ 描述含 PROACTIVE TIMING 引导;②门控关(4 falsy)→ 描述逐字
 * 回退到原始基线串(byte-revert);③工具其它字段(name/inputSchema)不受影响。
 */

const test = require('node:test');
const assert = require('node:assert');

const TOOL_PATH = require.resolve('../src/tools/SaveMemory');
const BASE_END = 'Writes to the local memory store and updates the index.';

// 描述在 require 期按 process.env 冻结进 defineTool → 用 env-toggled fresh require 取。
function freshDescription(env) {
  const KEY = 'KHY_SAVE_MEMORY_PROACTIVE';
  const saved = process.env[KEY];
  if (env[KEY] === undefined) delete process.env[KEY]; else process.env[KEY] = env[KEY];
  delete require.cache[TOOL_PATH];
  const tool = require(TOOL_PATH);
  const desc = tool.description;
  if (saved === undefined) delete process.env[KEY]; else process.env[KEY] = saved;
  delete require.cache[TOOL_PATH];
  return { desc, tool };
}

test('SaveMemory 描述: 默认(无 env)含主动写入时机引导', () => {
  const { desc } = freshDescription({});
  assert.match(desc, /PROACTIVE TIMING/);
  assert.match(desc, /WITHOUT being told/);
  assert.match(desc, /Do NOT save ephemeral/); // 防噪护栏在场
  assert.match(desc, /update it instead of duplicating/); // 先查重再更新
});

test('SaveMemory 描述: 门控 KHY_SAVE_MEMORY_PROACTIVE 关(4 falsy)→ 逐字回退基线', () => {
  for (const v of ['0', 'false', 'off', 'no']) {
    const { desc } = freshDescription({ KHY_SAVE_MEMORY_PROACTIVE: v });
    assert.ok(!/PROACTIVE TIMING/.test(desc), `off (${v}) must drop the proactive hint`);
    assert.ok(desc.endsWith(BASE_END), `off (${v}) must end at the baseline string`);
  }
});

test('SaveMemory 描述: 基线串(gate off)保持原始触发式引导不丢', () => {
  const { desc } = freshDescription({ KHY_SAVE_MEMORY_PROACTIVE: 'off' });
  assert.match(desc, /Use this whenever the user tells you something to remember/);
  assert.match(desc, /do not just claim you remembered it/);
});

test('SaveMemory: 门控只影响描述,其它工具契约不变', () => {
  const on = freshDescription({});
  const off = freshDescription({ KHY_SAVE_MEMORY_PROACTIVE: 'off' });
  assert.strictEqual(on.tool.name, 'SaveMemory');
  assert.strictEqual(off.tool.name, 'SaveMemory');
  // inputSchema 的必填字段不受描述门控影响。
  for (const t of [on.tool, off.tool]) {
    assert.ok(t.inputSchema && t.inputSchema.type && t.inputSchema.name && t.inputSchema.content);
  }
  // 开启态是「基线 + 引导」的纯追加(基线子串仍完整在场)。
  assert.ok(on.desc.startsWith(off.desc), 'on description must be a strict superset (prefix) of the baseline');
});
