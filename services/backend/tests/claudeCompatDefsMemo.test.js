'use strict';

/**
 * claudeCompatDefsMemo.test —— Claude 兼容工具定义记忆
 * (Ch2「不要每轮重建可复用结构」;门 KHY_TOOL_COMPAT_DEFS_MEMO,node:test)。
 *
 * getToolDefinitions(本地文本协议 / codex 路径)每请求都 spread 这 22 条 def。它是对冻结常量
 * CLAUDE_COMPAT_TOOLS 的零参纯 map。验证:①门开 → 重复调用返同一缓存数组引用;②门开缓存内容
 * 与门关现建逐字等价(真源不漂移);③门关(0/off/false/no/OFF)→ 每次现建新数组;④纯 builder
 * 产稳定内容且与公开接口等价;⑤缓存数组是 copy-on-write 消费方的安全共享源(结构自证:含
 * name/description/parameters/_compatCanonical)。
 */
const test = require('node:test');
const assert = require('node:assert');

const c = require('../src/services/claudeCompat.js');

function withMemo(value, fn) {
  const prev = process.env.KHY_TOOL_COMPAT_DEFS_MEMO;
  if (value === undefined) delete process.env.KHY_TOOL_COMPAT_DEFS_MEMO;
  else process.env.KHY_TOOL_COMPAT_DEFS_MEMO = value;
  try { return fn(); }
  finally {
    if (prev === undefined) delete process.env.KHY_TOOL_COMPAT_DEFS_MEMO;
    else process.env.KHY_TOOL_COMPAT_DEFS_MEMO = prev;
  }
}

test('门开:重复调用返同一缓存数组引用', () => {
  withMemo('1', () => {
    c._resetCompatDefsMemo();
    const a = c.getClaudeCompatToolDefinitions();
    const b = c.getClaudeCompatToolDefinitions();
    assert.ok(Array.isArray(a) && a.length > 0);
    assert.strictEqual(a, b, '门开时重复调用应返回同一缓存数组');
  });
});

test('门开缓存内容与门关现建逐字等价(真源不漂移)', () => {
  const off = withMemo('0', () => c.getClaudeCompatToolDefinitions());
  c._resetCompatDefsMemo();
  const on = withMemo('1', () => c.getClaudeCompatToolDefinitions());
  assert.deepStrictEqual(on, off);
});

test('门关(0/off/false/no/OFF):每次现建新数组', () => {
  for (const v of ['0', 'off', 'false', 'no', 'OFF']) {
    withMemo(v, () => {
      c._resetCompatDefsMemo();
      const a = c.getClaudeCompatToolDefinitions();
      const b = c.getClaudeCompatToolDefinitions();
      assert.notStrictEqual(a, b, `门=${v} 时应每次现建新数组`);
    });
  }
});

test('纯 builder 产稳定内容且与公开接口等价', () => {
  const b1 = c._buildClaudeCompatToolDefinitions();
  const b2 = c._buildClaudeCompatToolDefinitions();
  assert.deepStrictEqual(b1, b2);
  assert.notStrictEqual(b1, b2, '每次 build 应产新数组(纯函数无缓存)');
  const pub = withMemo('0', () => c.getClaudeCompatToolDefinitions());
  assert.deepStrictEqual(b1, pub);
});

test('def 结构完整(name/description/parameters/_compatCanonical)', () => {
  const defs = c._buildClaudeCompatToolDefinitions();
  for (const d of defs) {
    assert.ok(typeof d.name === 'string' && d.name.length > 0);
    assert.strictEqual(typeof d.description, 'string');
    assert.strictEqual(d.parameters.type, 'object');
    assert.ok(Array.isArray(d.parameters.required));
    assert.ok('_compatCanonical' in d);
  }
});
