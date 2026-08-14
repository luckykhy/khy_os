'use strict';

// 纯叶子 semanticNumberCoerce 的单测:逐字节移植 CC `src/utils/semanticNumber.ts` 的
// 「合法十进制字面量字符串 → number」强制转换。核验:
//  - 只转匹配 /^-?\d+(\.\d+)?$/ 的字符串(整数 / 简单小数 / 前导负号);
//  - 绝不用 Number() 兜底 → ""/空白/科学计数/十六进制/Infinity 原样穿过(掩盖 bug = CC 反对);
//  - coerceSchemaNumbers 只动 schema 中 type:'number' 的形参,无变化 → 返回同一引用(零拷贝);
//  - 门控 KHY_SEMANTIC_NUMBER 关 → 原样返回入参同一引用(逐字节回退)。
const test = require('node:test');
const assert = require('node:assert');
const {
  semanticNumberEnabled,
  coerceNumericLiteral,
  coerceSchemaNumbers,
} = require('../../src/tools/semanticNumberCoerce');

test('coerceNumericLiteral:合法十进制字面量字符串 → number', () => {
  assert.strictEqual(coerceNumericLiteral('30'), 30);
  assert.strictEqual(coerceNumericLiteral('0'), 0);
  assert.strictEqual(coerceNumericLiteral('-7'), -7);
  assert.strictEqual(coerceNumericLiteral('3.14'), 3.14);
  assert.strictEqual(coerceNumericLiteral('-0.5'), -0.5);
  assert.strictEqual(coerceNumericLiteral('007'), 7); // 前导零仍是合法十进制
});

test('coerceNumericLiteral:已是 number / 非字符串 → 原样', () => {
  assert.strictEqual(coerceNumericLiteral(30), 30);
  assert.strictEqual(coerceNumericLiteral(0), 0);
  assert.strictEqual(coerceNumericLiteral(true), true);
  assert.strictEqual(coerceNumericLiteral(null), null);
  assert.strictEqual(coerceNumericLiteral(undefined), undefined);
  const obj = { a: 1 };
  assert.strictEqual(coerceNumericLiteral(obj), obj);
});

test('coerceNumericLiteral:绝不用 Number() 兜底(掩盖 bug 的输入原样穿过)', () => {
  // CC 注释明确反对 z.coerce.number():以下都**不**转,继续被下游校验诚实拒绝。
  for (const bad of ['', '   ', ' 30', '30 ', '0x10', '1e3', '1E3', 'Infinity', '-Infinity', 'NaN', '+30', '1,000', '3.', '.5', '1.2.3', 'abc', '12px']) {
    assert.strictEqual(coerceNumericLiteral(bad), bad, `应原样穿过: ${JSON.stringify(bad)}`);
  }
});

test('semanticNumberEnabled:门控梯(默认开,标准 falsy 串关)', () => {
  assert.strictEqual(semanticNumberEnabled({}), true); // 默认开
  assert.strictEqual(semanticNumberEnabled({ KHY_SEMANTIC_NUMBER: '1' }), true);
  assert.strictEqual(semanticNumberEnabled({ KHY_SEMANTIC_NUMBER: 'on' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'FALSE', 'Off', ' no ']) {
    assert.strictEqual(semanticNumberEnabled({ KHY_SEMANTIC_NUMBER: off }), false, `应关: ${off}`);
  }
});

test('coerceSchemaNumbers:只转 type:number 形参,且确有转换才浅拷贝', () => {
  const schema = {
    head_limit: { type: 'number' },
    pattern: { type: 'string' },
    depth: { type: 'number' },
  };
  const params = { head_limit: '30', pattern: '42', depth: 2 };
  const out = coerceSchemaNumbers(schema, params, { KHY_SEMANTIC_NUMBER: '1' });
  assert.notStrictEqual(out, params); // 确有转换 → 新对象
  assert.strictEqual(out.head_limit, 30); // 字符串 → number
  assert.strictEqual(out.pattern, '42'); // 非 number 形参不动(即便看着像数字)
  assert.strictEqual(out.depth, 2); // 已是 number 不动
  assert.deepStrictEqual(params, { head_limit: '30', pattern: '42', depth: 2 }); // 入参未被改
});

test('coerceSchemaNumbers:无可转换形参 → 返回同一引用(零拷贝)', () => {
  const schema = { n: { type: 'number' }, s: { type: 'string' } };
  const params = { n: 5, s: 'hi' }; // n 已是 number → 无转换
  const out = coerceSchemaNumbers(schema, params, { KHY_SEMANTIC_NUMBER: '1' });
  assert.strictEqual(out, params); // 引用恒等
});

test('coerceSchemaNumbers:门控关 → 原样返回同一引用(逐字节回退)', () => {
  const schema = { n: { type: 'number' } };
  const params = { n: '30' };
  const out = coerceSchemaNumbers(schema, params, { KHY_SEMANTIC_NUMBER: 'off' });
  assert.strictEqual(out, params); // 同一引用
  assert.strictEqual(out.n, '30'); // 未转 → 下游校验仍按旧口径拒绝
});

test('coerceSchemaNumbers:守卫非法入参绝不抛', () => {
  const env = { KHY_SEMANTIC_NUMBER: '1' };
  assert.strictEqual(coerceSchemaNumbers(null, { a: '1' }, env).a, '1');
  assert.strictEqual(coerceSchemaNumbers({ a: { type: 'number' } }, null, env), null);
  const arr = ['1'];
  assert.strictEqual(coerceSchemaNumbers({ 0: { type: 'number' } }, arr, env), arr); // 数组 params 不动
  // schema 含非对象 rule / 缺 type 不报错
  const schema = { a: null, b: 'x', c: { type: 'number' } };
  const out = coerceSchemaNumbers(schema, { a: '1', b: '2', c: '3' }, env);
  assert.strictEqual(out.c, 3);
  assert.strictEqual(out.a, '1');
  assert.strictEqual(out.b, '2');
});

test('coerceSchemaNumbers:小数 / 负数字面量经 schema 转换', () => {
  const schema = { ratio: { type: 'number' }, offset: { type: 'number' } };
  const out = coerceSchemaNumbers(schema, { ratio: '0.25', offset: '-3' }, { KHY_SEMANTIC_NUMBER: '1' });
  assert.strictEqual(out.ratio, 0.25);
  assert.strictEqual(out.offset, -3);
});
