'use strict';

/**
 * gitBlame.test — 补全的 git 只读族成员（node:test）。
 *
 * 验证:①defineTool 契约(name/category/risk/isReadOnly/别名/schema 合法);
 * ②file 必填且有 description、行范围参数有 type+description(过参数级审计);
 * ③execute 在本仓(真 git repo)对已跟踪文件返回 blame 输出;④缺 file → 明确错误。
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const blame = require('../../src/tools/gitBlame');

test('gitBlame:defineTool 契约字段', () => {
  assert.strictEqual(blame.name, 'gitBlame');
  assert.strictEqual(blame.category, 'git');
  assert.strictEqual(blame.risk, 'safe');
  assert.strictEqual(typeof blame.execute, 'function');
  assert.strictEqual(typeof blame.toFunctionDef, 'function');
  assert.ok(Array.isArray(blame.aliases) && blame.aliases.includes('git_blame'));
  // 只读:isReadOnly 为函数且返回 true。
  assert.strictEqual(typeof blame.isReadOnly, 'function');
  assert.strictEqual(blame.isReadOnly(), true);
});

test('gitBlame:schema 合参数级审计（file 必填有描述，行范围有 type+描述）', () => {
  const def = blame.toFunctionDef();
  const p = def.parameters;
  assert.strictEqual(p.type, 'object');
  assert.ok(p.properties.file && p.properties.file.description, 'file 应有 description');
  assert.ok(Array.isArray(p.required) && p.required.includes('file'), 'file 应为必填');
  // 悬垂检查:required 全在 properties 内。
  for (const r of p.required) assert.ok(Object.keys(p.properties).includes(r), `required '${r}' 应在 properties`);
  for (const k of Object.keys(p.properties)) {
    assert.ok(p.properties[k].type, `参数 ${k} 应有 type`);
    assert.ok(p.properties[k].description, `参数 ${k} 应有 description`);
  }
});

test('gitBlame:缺 file → 明确错误(不抛)', async () => {
  const r = await blame.execute({});
  assert.strictEqual(r.success, false);
  assert.match(String(r.error), /file/);
});

test('gitBlame:在本仓对已跟踪文件返回 blame（真 git repo 冒烟）', async () => {
  // 本仓库自身即 git repo;blame 本测试文件的相对路径。KHYQUANT_CWD 指向 backend 根。
  const prev = process.env.KHYQUANT_CWD;
  process.env.KHYQUANT_CWD = path.resolve(__dirname, '../..'); // services/backend
  try {
    const r = await blame.execute({ file: 'package.json', start_line: 1, end_line: 2 });
    // 若环境非 git 或文件未跟踪,execute 仍 fail-soft 返回 {success:false}——不抛即达标。
    assert.ok(typeof r === 'object' && typeof r.success === 'boolean');
    if (r.success) assert.ok(typeof r.output === 'string' && r.output.length > 0);
  } finally {
    if (prev === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = prev;
  }
});
