'use strict';

/**
 * promptToolsSectionMemo.test —— enabledTools 派生的「Using your tools」section 记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_PROMPT_TOOLS_SECTION_MEMO,node:test)。
 *
 * 验证:①门开 → 同一工具集合命中缓存(同引用),缓存计一槽;②键与输入顺序/重复无关
 * (逆序、含重复项仍命中同一条目);③不同集合 → 不同内容、不同缓存条目;④门开 vs 门关
 * 内容逐字等价;⑤门关(0/off/false/no/OFF)→ 不写缓存、每次现建;⑥缓存有界:超 32 个
 * 不同键即整清(绝不无界增长)。
 */
const test = require('node:test');
const assert = require('node:assert');

const p = require('../src/constants/prompts.js');

const BASE = ['Read', 'Write', 'Bash', 'Agent', 'TaskCreate', 'TaskUpdate', 'TaskList', 'Grep', 'Glob'];

function withMemo(value, fn) {
  const prev = process.env.KHY_PROMPT_TOOLS_SECTION_MEMO;
  if (value === undefined) delete process.env.KHY_PROMPT_TOOLS_SECTION_MEMO;
  else process.env.KHY_PROMPT_TOOLS_SECTION_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_PROMPT_TOOLS_SECTION_MEMO;
    else process.env.KHY_PROMPT_TOOLS_SECTION_MEMO = prev;
  }
}

test('门开:同一集合命中缓存(同引用),缓存计一槽', () => {
  withMemo(undefined, () => {
    p._resetToolsSectionMemo();
    const a = p.getUsingYourToolsSection(BASE);
    const b = p.getUsingYourToolsSection(BASE);
    assert.strictEqual(a, b, '重复调用应返回同一缓存引用');
    assert.strictEqual(p._toolsSectionMemoSize(), 1);
  });
});

test('键与输入顺序/重复无关(逆序、含重复仍命中同一条目)', () => {
  withMemo(undefined, () => {
    p._resetToolsSectionMemo();
    const base = p.getUsingYourToolsSection(BASE);
    const rev = p.getUsingYourToolsSection([...BASE].reverse());
    const dup = p.getUsingYourToolsSection([...BASE, 'Read', 'Bash', 'Read']);
    assert.strictEqual(rev, base, '逆序应命中同一条目');
    assert.strictEqual(dup, base, '含重复项应命中同一条目');
    assert.strictEqual(p._toolsSectionMemoSize(), 1, '三次归一为同一键 → 仅一槽');
  });
});

test('不同集合 → 不同内容、不同缓存条目', () => {
  withMemo(undefined, () => {
    p._resetToolsSectionMemo();
    const a = p.getUsingYourToolsSection(BASE);
    const b = p.getUsingYourToolsSection(['Read', 'Glob']);
    assert.notStrictEqual(a, b);
    assert.strictEqual(p._toolsSectionMemoSize(), 2);
  });
});

test('门开 vs 门关:内容逐字等价', () => {
  const sets = [BASE, ['Read', 'Glob'], [], ['Bash'], ['TodoWrite', 'Agent', 'SendMessage']];
  for (const s of sets) {
    p._resetToolsSectionMemo();
    const on = withMemo('1', () => p.getUsingYourToolsSection(s));
    const off = withMemo('0', () => p.getUsingYourToolsSection(s));
    assert.strictEqual(on, off, `集合 [${s}] 门开与门关产出应逐字一致`);
  }
});

test('门关(0/off/false/no/OFF):不写缓存、每次现建', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      p._resetToolsSectionMemo();
      p.getUsingYourToolsSection(BASE);
      p.getUsingYourToolsSection(['Read']);
      assert.strictEqual(p._toolsSectionMemoSize(), 0, `门=${v} 时不应写入缓存`);
    });
  }
});

test('缓存有界:超 32 个不同键即整清', () => {
  withMemo(undefined, () => {
    p._resetToolsSectionMemo();
    // 生成 33 个不同的单元素集合,强制越过 CAP=32。
    for (let i = 0; i < 33; i++) {
      p.getUsingYourToolsSection([`ToolMarker${i}`, 'Read']);
    }
    assert.ok(p._toolsSectionMemoSize() <= 32, `缓存不得无界增长,实际=${p._toolsSectionMemoSize()}`);
  });
});
