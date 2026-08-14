'use strict';

/**
 * jsonSchemaValidate.test.js — 纯叶子 JSON Schema 子集校验器契约(node:test,零 IO)。
 *
 * 锁定:type(含 integer/number/联合/null)、required、properties 递归、items 递归、
 * enum/const、additionalProperties(false / schema)、字符串/数值/数组约束、anyOf/oneOf/allOf、
 * nullable;无 schema → pass-through;病态 schema 绝不让校验器自身抛。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { validateAgainstSchema, formatSchemaErrors } = require('../../../src/services/output/jsonSchemaValidate');

describe('type', () => {
  test('基础类型命中/不命中', () => {
    assert.equal(validateAgainstSchema('hi', { type: 'string' }).valid, true);
    assert.equal(validateAgainstSchema(5, { type: 'string' }).valid, false);
    assert.equal(validateAgainstSchema(5, { type: 'number' }).valid, true);
    assert.equal(validateAgainstSchema(5.5, { type: 'integer' }).valid, false);
    assert.equal(validateAgainstSchema(5, { type: 'integer' }).valid, true);
    assert.equal(validateAgainstSchema(null, { type: 'null' }).valid, true);
    assert.equal(validateAgainstSchema(true, { type: 'boolean' }).valid, true);
  });
  test('类型联合', () => {
    const s = { type: ['string', 'number'] };
    assert.equal(validateAgainstSchema('x', s).valid, true);
    assert.equal(validateAgainstSchema(3, s).valid, true);
    assert.equal(validateAgainstSchema(true, s).valid, false);
  });
  test('nullable 允许 null', () => {
    assert.equal(validateAgainstSchema(null, { type: 'string', nullable: true }).valid, true);
  });
});

describe('object', () => {
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string', minLength: 1 },
      age: { type: 'integer', minimum: 0 },
    },
    required: ['name'],
  };
  test('完整对象通过', () => {
    assert.equal(validateAgainstSchema({ name: 'a', age: 3 }, schema).valid, true);
  });
  test('缺必填 → 失败且路径可读', () => {
    const r = validateAgainstSchema({ age: 3 }, schema);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => /missing required property "name"/.test(e.message)));
  });
  test('嵌套属性类型违例 → 失败带子路径', () => {
    const r = validateAgainstSchema({ name: 'a', age: -1 }, schema);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.path === '/age' && /minimum/.test(e.message)));
  });
  test('additionalProperties:false 拒绝多余键', () => {
    const s = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    const r = validateAgainstSchema({ a: 'x', b: 1 }, s);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => /additional property "b"/.test(e.message)));
  });
  test('additionalProperties:schema 校验额外键', () => {
    const s = { type: 'object', properties: {}, additionalProperties: { type: 'number' } };
    assert.equal(validateAgainstSchema({ x: 1, y: 2 }, s).valid, true);
    assert.equal(validateAgainstSchema({ x: 'no' }, s).valid, false);
  });
});

describe('array', () => {
  test('items 递归 + minItems', () => {
    const s = { type: 'array', items: { type: 'string' }, minItems: 1 };
    assert.equal(validateAgainstSchema(['a', 'b'], s).valid, true);
    assert.equal(validateAgainstSchema([], s).valid, false);
    const r = validateAgainstSchema(['a', 3], s);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.path === '/1'));
  });
  test('uniqueItems', () => {
    const s = { type: 'array', uniqueItems: true };
    assert.equal(validateAgainstSchema([1, 2, 3], s).valid, true);
    assert.equal(validateAgainstSchema([1, 2, 1], s).valid, false);
  });
});

describe('enum/const + 组合', () => {
  test('enum', () => {
    const s = { enum: ['a', 'b'] };
    assert.equal(validateAgainstSchema('a', s).valid, true);
    assert.equal(validateAgainstSchema('c', s).valid, false);
  });
  test('const(深比较)', () => {
    assert.equal(validateAgainstSchema({ x: 1 }, { const: { x: 1 } }).valid, true);
    assert.equal(validateAgainstSchema({ x: 2 }, { const: { x: 1 } }).valid, false);
  });
  test('oneOf 恰好一个', () => {
    const s = { oneOf: [{ type: 'string' }, { type: 'number' }] };
    assert.equal(validateAgainstSchema('x', s).valid, true);
    assert.equal(validateAgainstSchema(true, s).valid, false);
  });
  test('anyOf 至少一个', () => {
    const s = { anyOf: [{ type: 'string' }, { type: 'number' }] };
    assert.equal(validateAgainstSchema(3, s).valid, true);
    assert.equal(validateAgainstSchema(true, s).valid, false);
  });
});

describe('字符串/pattern', () => {
  test('pattern + maxLength', () => {
    const s = { type: 'string', pattern: '^[a-z]+$', maxLength: 3 };
    assert.equal(validateAgainstSchema('abc', s).valid, true);
    assert.equal(validateAgainstSchema('ABC', s).valid, false);
    assert.equal(validateAgainstSchema('abcd', s).valid, false);
  });
  test('非法 pattern 不抛(退化为不约束 pattern)', () => {
    const s = { type: 'string', pattern: '(' };
    assert.doesNotThrow(() => validateAgainstSchema('x', s));
  });
});

describe('防呆 + 边界', () => {
  test('无 schema → pass-through 通过', () => {
    assert.equal(validateAgainstSchema({ anything: 1 }, null).valid, true);
    assert.equal(validateAgainstSchema('x', undefined).valid, true);
  });
  test('schema=false → 拒绝', () => {
    assert.equal(validateAgainstSchema(1, false).valid, false);
  });
  test('深嵌套对象递归校验', () => {
    const s = {
      type: 'object',
      properties: { user: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
      required: ['user'],
    };
    assert.equal(validateAgainstSchema({ user: { id: 1 } }, s).valid, true);
    const r = validateAgainstSchema({ user: { id: 'x' } }, s);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some(e => e.path === '/user/id'));
  });
  test('formatSchemaErrors 拼可读串', () => {
    const r = validateAgainstSchema({ age: -1 }, { type: 'object', properties: { age: { type: 'integer', minimum: 0 } } });
    const msg = formatSchemaErrors(r.errors);
    assert.match(msg, /\/age: number below minimum 0/);
    assert.equal(formatSchemaErrors([]), '');
  });
});
