'use strict';

/**
 * promptSectionStaticMemo.test —— 纯静态系统 Prompt section 记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_PROMPT_SECTION_STATIC_MEMO,node:test)。
 *
 * 验证:①门开 → 6 个 no-arg 静态 builder 首调后进缓存,缓存大小随之增长;
 * ②门开 vs 门关内容逐字等价(记忆不改语义);③门关(0/off/false/no/OFF)→ 不进缓存、
 * 每次现算;④非纯 getToneAndStyleSection 绝不进静态缓存(它调 fableVoiceProfile);
 * ⑤缓存内容与「门关现算」逐字一致(真源不漂移)。
 */
const test = require('node:test');
const assert = require('node:assert');

const p = require('../src/constants/prompts.js');

const STATIC_FNS = [
  'getSimpleSystemSection',
  'getDoingTasksSection',
  'getExecutionDisciplineSection',
  'getPlanningAndRecoverySection',
  'getSessionMemoryAndContextSection',
  'getOutputEfficiencySection',
];

function withMemo(value, fn) {
  const prev = process.env.KHY_PROMPT_SECTION_STATIC_MEMO;
  if (value === undefined) delete process.env.KHY_PROMPT_SECTION_STATIC_MEMO;
  else process.env.KHY_PROMPT_SECTION_STATIC_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_PROMPT_SECTION_STATIC_MEMO;
    else process.env.KHY_PROMPT_SECTION_STATIC_MEMO = prev;
  }
}

test('门开:6 个静态 builder 首调后进缓存(缓存大小达 6)', () => {
  withMemo(undefined, () => {
    p._resetStaticSectionMemo();
    assert.strictEqual(p._staticSectionMemoSize(), 0);
    for (const f of STATIC_FNS) p[f]();
    assert.strictEqual(p._staticSectionMemoSize(), STATIC_FNS.length, '每个纯 builder 应各占一个缓存槽');
    // 二次调用不应增长(命中缓存)。
    for (const f of STATIC_FNS) p[f]();
    assert.strictEqual(p._staticSectionMemoSize(), STATIC_FNS.length);
  });
});

test('门开 vs 门关:内容逐字等价(记忆不改语义)', () => {
  for (const f of STATIC_FNS) {
    p._resetStaticSectionMemo();
    const on = withMemo('1', () => p[f]());
    const off = withMemo('0', () => p[f]());
    assert.strictEqual(on, off, `${f} 门开与门关产出应逐字一致`);
  }
});

test('门关(0/off/false/no/OFF):不进缓存、每次现算', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      p._resetStaticSectionMemo();
      for (const f of STATIC_FNS) p[f]();
      assert.strictEqual(p._staticSectionMemoSize(), 0, `门=${v} 时不应写入静态缓存`);
    });
  }
});

test('非纯 getToneAndStyleSection 绝不进静态缓存', () => {
  withMemo(undefined, () => {
    p._resetStaticSectionMemo();
    p.getToneAndStyleSection();
    assert.strictEqual(p._staticSectionMemoSize(), 0, 'getToneAndStyleSection 非纯,不得走静态记忆');
  });
});

test('缓存内容与门关现算逐字一致(真源不漂移)', () => {
  const off = withMemo('0', () => STATIC_FNS.map(f => p[f]()));
  p._resetStaticSectionMemo();
  const on = withMemo('1', () => STATIC_FNS.map(f => p[f]()));
  assert.deepStrictEqual(on, off);
  // 结构自证:每段以其 '# ' 标题开头,非空。
  for (const s of on) {
    assert.ok(typeof s === 'string' && s.length > 0);
    assert.ok(s.startsWith('# '), '每静态段应以 markdown 标题开头');
  }
});
