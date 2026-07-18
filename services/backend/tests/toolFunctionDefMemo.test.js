'use strict';

/**
 * toFunctionDef() memoization —— defineTool 冻结 tool 的 function-calling 定义记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_TOOL_FUNCTION_DEF_MEMO,node:test)。
 *
 * 验证:①门开 → 同一 tool 多次 toFunctionDef() 返回**同一引用**(命中缓存);
 * ②门开 vs 门关内容逐字段等价(记忆不改语义);③门关(0/off/false/no/OFF)→
 * 每次现建、返回**不同引用**;④不同 tool 各自独立缓存,互不串扰;⑤缓存 def 结构
 * 完整(name/description/parameters.type/properties/required/别名)。
 */
const test = require('node:test');
const assert = require('node:assert');

const { defineTool } = require('../src/tools/_baseTool');

// 保存/恢复门环境,避免测试间污染。
function withMemo(value, fn) {
  const prev = process.env.KHY_TOOL_FUNCTION_DEF_MEMO;
  if (value === undefined) delete process.env.KHY_TOOL_FUNCTION_DEF_MEMO;
  else process.env.KHY_TOOL_FUNCTION_DEF_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_TOOL_FUNCTION_DEF_MEMO;
    else process.env.KHY_TOOL_FUNCTION_DEF_MEMO = prev;
  }
}

function makeTool(name) {
  return defineTool({
    name,
    description: `${name} desc`,
    category: 'analysis',
    risk: 'safe',
    inputSchema: {
      symbol: { type: 'string', required: true, description: 'the symbol' },
      window: { type: 'number', description: 'lookback', default: 20 },
      tags: { type: 'array', items: { type: 'string' }, description: 'labels' },
    },
    aliases: [`${name}_alias`],
    execute: async () => ({ ok: true }),
  });
}

test('门开:同一 tool 多次调用返回同一引用(命中缓存)', () => {
  withMemo(undefined, () => {
    const t = makeTool('MemoA');
    const a = t.toFunctionDef();
    const b = t.toFunctionDef();
    assert.strictEqual(a, b, '缓存命中应返回同一对象引用');
  });
});

test('门开 vs 门关:内容逐字段等价(记忆不改语义)', () => {
  const on = withMemo('1', () => makeTool('MemoB').toFunctionDef());
  const off = withMemo('0', () => makeTool('MemoB').toFunctionDef());
  assert.deepStrictEqual(on, off, '门开与门关产出的 def 内容应完全一致');
});

test('门关(0/off/false/no/OFF):每次现建、返回不同引用', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      const t = makeTool('MemoC');
      const a = t.toFunctionDef();
      const b = t.toFunctionDef();
      assert.notStrictEqual(a, b, `门=${v} 应每次现建(不同引用)`);
      assert.deepStrictEqual(a, b, `门=${v} 现建内容仍应一致`);
    });
  }
});

test('不同 tool 各自独立缓存,互不串扰', () => {
  withMemo(undefined, () => {
    const t1 = makeTool('MemoD1');
    const t2 = makeTool('MemoD2');
    const d1 = t1.toFunctionDef();
    const d2 = t2.toFunctionDef();
    assert.notStrictEqual(d1, d2);
    assert.strictEqual(d1.name, 'MemoD1');
    assert.strictEqual(d2.name, 'MemoD2');
    // 各自命中自己的缓存。
    assert.strictEqual(t1.toFunctionDef(), d1);
    assert.strictEqual(t2.toFunctionDef(), d2);
  });
});

test('缓存 def 结构完整', () => {
  withMemo(undefined, () => {
    const def = makeTool('MemoE').toFunctionDef();
    assert.strictEqual(def.name, 'MemoE');
    assert.strictEqual(def.description, 'MemoE desc');
    assert.strictEqual(def.parameters.type, 'object');
    assert.ok(def.parameters.properties.symbol);
    assert.strictEqual(def.parameters.properties.symbol.type, 'string');
    assert.strictEqual(def.parameters.properties.window.default, 20);
    assert.deepStrictEqual(def.parameters.properties.tags.items, { type: 'string' });
    assert.deepStrictEqual(def.parameters.required, ['symbol']);
    assert.deepStrictEqual(def.aliases, ['MemoE_alias']);
  });
});
