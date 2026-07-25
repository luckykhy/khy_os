'use strict';

/**
 * structuredOutputTool.test.js — StructuredOutputTool 薄壳契约(node:test,隔离 process.env)。
 *
 * 锁定:
 *   - 门控 KHY_STRUCTURED_OUTPUT=off → {success:false, disabled:true}(等价工具缺席,字节回退);
 *   - 无 schema → 原样透传 structured_output(对齐 CC 基础工具);
 *   - 入参 _schema 优先;否则注入 env KHY_OUTPUT_SCHEMA(JSON 串,防御性解析);
 *   - schema 通过 → success + structured_output(已剥离 _schema);
 *   - schema 未通过 → {success:false, schemaMismatch:true, errors, message};
 *   - 只读/并发安全声明。
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const TOOL_PATH = require.resolve('../../src/tools/StructuredOutputTool');

function freshTool() {
  delete require.cache[TOOL_PATH];
  const Tool = require('../../src/tools/StructuredOutputTool');
  return new Tool();
}

describe('StructuredOutputTool', () => {
  let savedGate, savedSchema;
  beforeEach(() => { savedGate = process.env.KHY_STRUCTURED_OUTPUT; savedSchema = process.env.KHY_OUTPUT_SCHEMA; });
  afterEach(() => {
    if (savedGate === undefined) delete process.env.KHY_STRUCTURED_OUTPUT; else process.env.KHY_STRUCTURED_OUTPUT = savedGate;
    if (savedSchema === undefined) delete process.env.KHY_OUTPUT_SCHEMA; else process.env.KHY_OUTPUT_SCHEMA = savedSchema;
  });

  test('只读/并发安全声明', () => {
    const t = freshTool();
    assert.equal(t.isReadOnly(), true);
    assert.equal(t.isConcurrencySafe(), true);
    assert.equal(t.constructor.toolName, 'StructuredOutput');
  });

  test('门控 off → disabled,字节回退', async () => {
    process.env.KHY_STRUCTURED_OUTPUT = 'off';
    const t = freshTool();
    const r = await t.execute({ foo: 1 });
    assert.equal(r.success, false);
    assert.equal(r.disabled, true);
  });

  test('无 schema → 原样透传', async () => {
    delete process.env.KHY_STRUCTURED_OUTPUT;
    delete process.env.KHY_OUTPUT_SCHEMA;
    const t = freshTool();
    const r = await t.execute({ answer: 42, note: 'hi' });
    assert.equal(r.success, true);
    assert.equal(r.schemaApplied, false);
    assert.deepStrictEqual(r.structured_output, { answer: 42, note: 'hi' });
  });

  test('入参 _schema 校验通过 → structured_output 剥离 _schema', async () => {
    delete process.env.KHY_STRUCTURED_OUTPUT;
    const t = freshTool();
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const r = await t.execute({ _schema: schema, name: 'alice', extra: 1 });
    assert.equal(r.success, true);
    assert.equal(r.schemaApplied, true);
    assert.deepStrictEqual(r.structured_output, { name: 'alice', extra: 1 });
    assert.equal(Object.prototype.hasOwnProperty.call(r.structured_output, '_schema'), false);
  });

  test('env KHY_OUTPUT_SCHEMA 校验未通过 → schemaMismatch', async () => {
    delete process.env.KHY_STRUCTURED_OUTPUT;
    process.env.KHY_OUTPUT_SCHEMA = JSON.stringify({ type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] });
    const t = freshTool();
    const r = await t.execute({ age: 'not-a-number' });
    assert.equal(r.success, false);
    assert.equal(r.schemaMismatch, true);
    assert.ok(Array.isArray(r.errors) && r.errors.length > 0);
    assert.match(r.message, /schema/);
  });

  test('入参 _schema 优先于 env', async () => {
    delete process.env.KHY_STRUCTURED_OUTPUT;
    process.env.KHY_OUTPUT_SCHEMA = JSON.stringify({ type: 'object', required: ['mustHave'] });
    const t = freshTool();
    // 入参 schema 不要求 mustHave → 应通过(证明入参优先)。
    const r = await t.execute({ _schema: { type: 'object', properties: { x: { type: 'number' } } }, x: 1 });
    assert.equal(r.success, true);
    assert.equal(r.schemaApplied, true);
  });

  test('env 非法 JSON → 视为无 schema 透传', async () => {
    delete process.env.KHY_STRUCTURED_OUTPUT;
    process.env.KHY_OUTPUT_SCHEMA = '{not valid json';
    const t = freshTool();
    const r = await t.execute({ a: 1 });
    assert.equal(r.success, true);
    assert.equal(r.schemaApplied, false);
  });
});
