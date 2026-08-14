'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const tpn = require('../src/services/toolParamNaming');

test('toSnakeCase:camelCase → snake_case,已是 snake 原样', () => {
  assert.equal(tpn.toSnakeCase('filePath'), 'file_path');
  assert.equal(tpn.toSnakeCase('outputPath'), 'output_path');
  assert.equal(tpn.toSnakeCase('maxCount'), 'max_count');
  assert.equal(tpn.toSnakeCase('file_path'), 'file_path'); // 幂等
  assert.equal(tpn.toSnakeCase('url'), 'url');
  assert.equal(tpn.toSnakeCase('prompt'), 'prompt'); // 单词不动
});

test('toCamelCase:snake_case → camelCase,已是 camel 原样', () => {
  assert.equal(tpn.toCamelCase('file_path'), 'filePath');
  assert.equal(tpn.toCamelCase('output_path'), 'outputPath');
  assert.equal(tpn.toCamelCase('max_count'), 'maxCount');
  assert.equal(tpn.toCamelCase('filePath'), 'filePath'); // 幂等
  assert.equal(tpn.toCamelCase('url'), 'url');
});

test('canonicalizeDefs:把 camelCase 参数键统一成 snake_case(含 required)', () => {
  const defs = [{
    name: 'demo',
    description: 'd',
    parameters: {
      type: 'object',
      properties: { filePath: { type: 'string' }, maxCount: { type: 'number' } },
      required: ['filePath'],
    },
  }];
  const out = tpn.canonicalizeDefs(defs);
  const p = out[0].parameters;
  assert.ok('file_path' in p.properties);
  assert.ok('max_count' in p.properties);
  assert.ok(!('filePath' in p.properties));
  assert.deepEqual(p.required, ['file_path']);
});

test('canonicalizeDefs:已是 snake_case 的定义原样返回(同引用)', () => {
  const defs = [{
    name: 'read',
    description: 'd',
    parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] },
  }];
  const out = tpn.canonicalizeDefs(defs);
  assert.strictEqual(out, defs); // 无改动 → 同引用(字节回退)
});

test('canonicalizeDefs:命名碰撞时保留原键,绝不覆盖丢数据', () => {
  const defs = [{
    name: 'weird',
    description: 'd',
    parameters: {
      type: 'object',
      // 同时存在 filePath 与 file_path(语义可能不同)→ 不可合并
      properties: { filePath: { type: 'string' }, file_path: { type: 'number' } },
    },
  }];
  const out = tpn.canonicalizeDefs(defs);
  const keys = Object.keys(out[0].parameters.properties);
  assert.ok(keys.includes('filePath'));
  assert.ok(keys.includes('file_path'));
  assert.equal(keys.length, 2); // 两键都在,无丢失
});

test('canonicalizeDefs:不合并语义不同的词(prompt/text/content 原样)', () => {
  const defs = [{
    name: 'gen',
    description: 'd',
    parameters: { type: 'object', properties: { prompt: {}, text: {}, content: {} } },
  }];
  const out = tpn.canonicalizeDefs(defs);
  assert.strictEqual(out, defs); // 全是单词 → 无改动同引用
});

test('expandParamAliases:补全 snake + camel 两种拼写(只填缺失)', () => {
  const out = tpn.expandParamAliases({ file_path: '/a', maxCount: 5 });
  assert.equal(out.file_path, '/a');
  assert.equal(out.filePath, '/a'); // 补 camel
  assert.equal(out.maxCount, 5);
  assert.equal(out.max_count, 5); // 补 snake
});

test('expandParamAliases:既有键不覆盖', () => {
  const out = tpn.expandParamAliases({ file_path: '/a', filePath: '/b' });
  assert.equal(out.file_path, '/a');
  assert.equal(out.filePath, '/b'); // 原值保留,不被覆盖
});

test('expandParamAliases:跳过下划线开头的内部标记键', () => {
  const out = tpn.expandParamAliases({ _autoRepairedFrom: 'x', url: 'http://a' });
  assert.equal(out._autoRepairedFrom, 'x');
  assert.ok(!('AutoRepairedFrom' in out));
  assert.ok(!('_auto_repaired_from' in out));
});

test('expandParamAliases:无新增时返回原对象(同引用)', () => {
  const p = { url: 'http://a', method: 'GET' };
  assert.strictEqual(tpn.expandParamAliases(p), p);
});

test('canonicalizeDefs / expandParamAliases 往返无损:定义改 snake,执行还原 camel', () => {
  // 定义侧:工具原本暴露 camelCase
  const defs = [{ name: 't', parameters: { type: 'object', properties: { filePath: {} } } }];
  const canon = tpn.canonicalizeDefs(defs);
  assert.ok('file_path' in canon[0].parameters.properties); // 模型看到 snake
  // 模型据此用 snake 调用 → 执行侧补回工具 execute 读的 camel
  const params = tpn.expandParamAliases({ file_path: '/x' });
  assert.equal(params.filePath, '/x');
});

test('门控关闭(off):两函数均字节回退(同引用)', () => {
  const prev = process.env.KHY_TOOL_PARAM_NAMING;
  process.env.KHY_TOOL_PARAM_NAMING = 'off';
  try {
    const defs = [{ name: 't', parameters: { type: 'object', properties: { filePath: {} } } }];
    assert.strictEqual(tpn.canonicalizeDefs(defs), defs);
    const p = { file_path: '/a' };
    assert.strictEqual(tpn.expandParamAliases(p), p);
  } finally {
    if (prev === undefined) delete process.env.KHY_TOOL_PARAM_NAMING;
    else process.env.KHY_TOOL_PARAM_NAMING = prev;
  }
});

test('默认开启(未设 env)', () => {
  const prev = process.env.KHY_TOOL_PARAM_NAMING;
  delete process.env.KHY_TOOL_PARAM_NAMING;
  try {
    assert.equal(tpn._enabled(), true);
  } finally {
    if (prev !== undefined) process.env.KHY_TOOL_PARAM_NAMING = prev;
  }
});

test('fail-soft:畸形输入绝不抛', () => {
  assert.doesNotThrow(() => tpn.canonicalizeDefs(null));
  assert.doesNotThrow(() => tpn.canonicalizeDefs('nope'));
  assert.doesNotThrow(() => tpn.expandParamAliases(null));
  assert.doesNotThrow(() => tpn.expandParamAliases([1, 2, 3]));
  assert.strictEqual(tpn.expandParamAliases(null), null);
});
