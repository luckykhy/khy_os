'use strict';

// 纯叶子 debugToolCall 的单测:对齐 CC `/debug-tool-call` 的后端逻辑——
// 从 conversation chain 配对最近 N 个 tool_use↔tool_result、截断、渲染。
//  - isEnabled:门控梯(默认开,标准 falsy 串关);
//  - extractToolCalls:按出现先后收集 tool_use,按 tool_use_id 配对 tool_result,取末 limit;
//  - formatToolCallDebug:可读多行;无结果时如实标注「(result not stored in transcript)」绝不编造;
//  - 防呆:chain 非数组 / content 非数组 / 块缺字段 → 安全返回,绝不抛。
const test = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  menuInlineEnabled,
  extractToolCalls,
  formatToolCallDebug,
} = require('../../src/cli/debugToolCall');

test('menuInlineEnabled:菜单内联门控(默认开,标准 falsy 串关,独立于 KHY_DEBUG_TOOL_CALL)', () => {
  assert.strictEqual(menuInlineEnabled({}), true);
  assert.strictEqual(menuInlineEnabled({ KHY_DEBUG_MENU_INLINE: '1' }), true);
  assert.strictEqual(menuInlineEnabled({ KHY_DEBUG_MENU_INLINE: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(menuInlineEnabled({ KHY_DEBUG_MENU_INLINE: off }), false, `应关: ${off}`);
  }
  // 与 isEnabled 相互独立:KHY_DEBUG_TOOL_CALL 关不影响 menuInlineEnabled 判定。
  assert.strictEqual(menuInlineEnabled({ KHY_DEBUG_TOOL_CALL: 'off' }), true);
});

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_DEBUG_TOOL_CALL: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_DEBUG_TOOL_CALL: off }), false, `应关: ${off}`);
  }
});

test('extractToolCalls:防呆——chain 非数组 / 空 → []', () => {
  assert.deepStrictEqual(extractToolCalls(null), []);
  assert.deepStrictEqual(extractToolCalls(undefined), []);
  assert.deepStrictEqual(extractToolCalls('nope'), []);
  assert.deepStrictEqual(extractToolCalls([]), []);
});

test('extractToolCalls:无 tool_use 的 chain → []', () => {
  const chain = [
    { role: 'user', content: 'hello' },
    { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
  ];
  assert.deepStrictEqual(extractToolCalls(chain), []);
});

test('extractToolCalls:按 tool_use_id 配对 result;无结果如实标 hasResult=false', () => {
  const chain = [
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
        { type: 'tool_use', id: 'tu_2', name: 'Bash', input: { command: 'ls' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tu_1', content: 'FILE BODY', is_error: false },
      ],
    },
  ];
  const pairs = extractToolCalls(chain, { limit: 5 });
  assert.strictEqual(pairs.length, 2);
  // tu_1 有结果
  assert.strictEqual(pairs[0].name, 'Read');
  assert.strictEqual(pairs[0].hasResult, true);
  assert.strictEqual(pairs[0].resultText, 'FILE BODY');
  assert.strictEqual(pairs[0].isError, false);
  // tu_2 无结果(khy transcript 常态:只存 tool_use 不存 tool_result)
  assert.strictEqual(pairs[1].name, 'Bash');
  assert.strictEqual(pairs[1].hasResult, false);
  assert.strictEqual(pairs[1].resultText, '');
});

test('extractToolCalls:is_error 透传;result content 为块数组时压平为文本', () => {
  const chain = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'x', name: 'Grep', input: {} }] },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'x', is_error: true, content: [{ type: 'text', text: 'boom' }] },
      ],
    },
  ];
  const [p] = extractToolCalls(chain);
  assert.strictEqual(p.isError, true);
  assert.strictEqual(p.resultText, 'boom');
});

test('extractToolCalls:limit 取末尾 N(时间正序)', () => {
  const content = [];
  for (let i = 1; i <= 7; i++) content.push({ type: 'tool_use', id: 't' + i, name: 'T' + i, input: {} });
  const chain = [{ role: 'assistant', content }];
  const pairs = extractToolCalls(chain, { limit: 3 });
  assert.strictEqual(pairs.length, 3);
  assert.deepStrictEqual(pairs.map((p) => p.name), ['T5', 'T6', 'T7']);
});

test('extractToolCalls:limit 缺省/非法 → 默认 5;块缺字段不抛', () => {
  const content = [];
  for (let i = 1; i <= 8; i++) content.push({ type: 'tool_use', id: 'i' + i, input: {} });
  // 夹杂坏块
  content.push(null, { type: 'tool_use' }, 'garbage');
  const chain = [{ role: 'assistant', content }, { role: 'user', content: 'plain' }, null];
  const pairs = extractToolCalls(chain, { limit: 0 });
  assert.strictEqual(pairs.length, 5);
  // 缺 name 的块回退 '(unknown)'
  assert.ok(pairs.every((p) => typeof p.name === 'string'));
});

test('formatToolCallDebug:空 → 友好提示(无报错)', () => {
  assert.strictEqual(
    formatToolCallDebug([]),
    'No tool calls found in the current session transcript.'
  );
  assert.strictEqual(
    formatToolCallDebug(null),
    'No tool calls found in the current session transcript.'
  );
});

test('formatToolCallDebug:渲染头 + 序号 + input + 结果/诚实缺失标记', () => {
  const pairs = [
    { id: 'tu_abcdef123456789', name: 'Read', input: { file_path: '/x' }, resultText: 'OK', isError: false, hasResult: true },
    { id: 'tu_2', name: 'Bash', input: { command: 'ls' }, resultText: '', isError: false, hasResult: false },
  ];
  const out = formatToolCallDebug(pairs);
  assert.match(out, /^Last 2 tool call\(s\):/);
  assert.match(out, /1\. Read/);
  assert.match(out, /input: \{"file_path":"\/x"\}/);
  assert.match(out, /⎿ result: OK/);
  assert.match(out, /2\. Bash/);
  // 诚实标记:绝不编造结果
  assert.match(out, /⎿ \(result not stored in transcript\)/);
});

test('formatToolCallDebug:错误结果显示为 error;超长结果截断缀「…」', () => {
  const long = 'y'.repeat(500);
  const pairs = [
    { id: 'e1', name: 'X', input: {}, resultText: long, isError: true, hasResult: true },
  ];
  const out = formatToolCallDebug(pairs, { maxResultChars: 50 });
  assert.match(out, /⎿ error: y{50}…/);
});
