'use strict';

// 纯叶子 copyReply 的单测:对齐 CC `/copy` 的后端逻辑——
// 选第 N 条助手回复 / 抽代码块 / 拼最终待复制载荷。零 IO、确定性、fail-soft。
const test = require('node:test');
const assert = require('node:assert');
const {
  isEnabled,
  parseCopyArgs,
  selectReply,
  extractCodeBlocks,
  buildCopyPayload,
} = require('../../src/cli/copyReply');

test('isEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(isEnabled({}), true);
  assert.strictEqual(isEnabled({ KHY_COPY: '1' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(isEnabled({ KHY_COPY: off }), false, `应关: ${off}`);
  }
});

test('parseCopyArgs:缺省 nth=1 codeOnly=false', () => {
  assert.deepStrictEqual(parseCopyArgs([]), { nth: 1, codeOnly: false });
  assert.deepStrictEqual(parseCopyArgs([undefined, '']), { nth: 1, codeOnly: false });
});

test('parseCopyArgs:code / --code / -c → codeOnly;正整数 → nth', () => {
  assert.deepStrictEqual(parseCopyArgs(['code']), { nth: 1, codeOnly: true });
  assert.deepStrictEqual(parseCopyArgs(['--code']), { nth: 1, codeOnly: true });
  assert.deepStrictEqual(parseCopyArgs(['-c']), { nth: 1, codeOnly: true });
  assert.deepStrictEqual(parseCopyArgs(['3']), { nth: 3, codeOnly: false });
  assert.deepStrictEqual(parseCopyArgs(['code', '2']), { nth: 2, codeOnly: true });
  // 负/零/非数忽略 → 保持缺省
  assert.deepStrictEqual(parseCopyArgs(['-1', '0', 'x']), { nth: 1, codeOnly: false });
});

test('selectReply:剔空后从最近往回数;越界 → null', () => {
  const texts = ['first', '  ', 'second', 'third'];
  assert.deepStrictEqual(selectReply(texts, 1), { text: 'third', ordinal: 1, total: 3 });
  assert.deepStrictEqual(selectReply(texts, 2), { text: 'second', ordinal: 2, total: 3 });
  assert.deepStrictEqual(selectReply(texts, 3), { text: 'first', ordinal: 3, total: 3 });
  assert.strictEqual(selectReply(texts, 4), null);   // 越界
  assert.strictEqual(selectReply([], 1), null);
  assert.strictEqual(selectReply(null, 1), null);
});

test('extractCodeBlocks:抽 ``` 围栏内容(不含围栏/语言)', () => {
  const text = 'pre\n```js\nconst a=1;\n```\nmid\n```\nplain\n```\npost';
  assert.deepStrictEqual(extractCodeBlocks(text), ['const a=1;', 'plain']);
});

test('extractCodeBlocks:无围栏 → [];~~~ 围栏亦支持;未闭合容错收尾', () => {
  assert.deepStrictEqual(extractCodeBlocks('no fences here'), []);
  assert.deepStrictEqual(extractCodeBlocks('~~~\nx\n~~~'), ['x']);
  // 未闭合:把已积累内容也算一块(绝不丢)
  assert.deepStrictEqual(extractCodeBlocks('```\nopen\nstill'), ['open\nstill']);
  assert.deepStrictEqual(extractCodeBlocks(''), []);
  assert.deepStrictEqual(extractCodeBlocks(null), []);
});

test('buildCopyPayload:默认复制整条回复(最近)', () => {
  const r = buildCopyPayload(['a', 'hello world'], { nth: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.payload, 'hello world');
  assert.match(r.description, /最近一条助手回复/);
});

test('buildCopyPayload:nth=2 → 描述「从最近往回数第 2 条」', () => {
  const r = buildCopyPayload(['a', 'b', 'c'], { nth: 2 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.payload, 'b');
  assert.match(r.description, /第 2 条/);
});

test('buildCopyPayload:codeOnly 抽代码块;多块以空行拼接', () => {
  const text = 'see:\n```\nA\n```\nand\n```\nB\n```';
  const r = buildCopyPayload([text], { codeOnly: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.payload, 'A\n\nB');
  assert.match(r.description, /2 个代码块/);
});

test('buildCopyPayload:无回复 → no_reply;codeOnly 无块 → no_code', () => {
  assert.deepStrictEqual(buildCopyPayload([], {}), { ok: false, reason: 'no_reply' });
  assert.deepStrictEqual(buildCopyPayload(['plain text only'], { codeOnly: true }), { ok: false, reason: 'no_code' });
});
