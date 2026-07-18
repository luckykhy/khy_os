'use strict';

// docProductPlan 叶子契约测试(node:test)。
// Layer 2:只重生成已 committed 的 .html/.pdf 兄弟,绝不新建;md-only 跳过。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  docRegenEnabled,
  planDocProducts,
  _stripExt,
} = require('../../src/services/docsFreshness/docProductPlan');

test('docRegenEnabled 默认开,{0,false,off,no} 关', () => {
  assert.strictEqual(docRegenEnabled({}), true);
  assert.strictEqual(docRegenEnabled({ KHY_DOCS_REGEN: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF']) {
    assert.strictEqual(docRegenEnabled({ KHY_DOCS_REGEN: off }), false);
  }
});

test('_stripExt:去最后扩展名,保留中文/方括号/空格', () => {
  assert.strictEqual(_stripExt('docs/07_OPS_运维/[OPS-MAN-043] 成长路线.md'), 'docs/07_OPS_运维/[OPS-MAN-043] 成长路线');
  assert.strictEqual(_stripExt('a/b.c.md'), 'a/b.c');
  assert.strictEqual(_stripExt('a/no-ext'), 'a/no-ext');
});

test('md-only(无 committed 产物)→ skip,绝不新建', () => {
  const r = planDocProducts('docs/X.md', []);
  assert.deepStrictEqual(r.regen, []);
  assert.strictEqual(r.skip.length, 1);
  assert.strictEqual(r.skip[0].reason, 'md-only');
});

test('只 committed .html → --html-only', () => {
  const r = planDocProducts('docs/X.md', ['docs/X.html']);
  assert.strictEqual(r.regen.length, 1);
  assert.strictEqual(r.regen[0].mode, '--html-only');
  assert.deepStrictEqual(r.regen[0].products, ['docs/X.html']);
});

test('committed .html + .pdf → 全量(mode null)', () => {
  const r = planDocProducts('docs/X.md', ['docs/X.pdf', 'docs/X.html', 'docs/Other.html']);
  assert.strictEqual(r.regen.length, 1);
  assert.strictEqual(r.regen[0].mode, null);
  assert.deepStrictEqual(r.regen[0].products, ['docs/X.html', 'docs/X.pdf']);
});

test('只 committed .pdf → 含 pdf(全量,mode null)', () => {
  const r = planDocProducts('docs/X.md', ['docs/X.pdf']);
  assert.strictEqual(r.regen.length, 1);
  assert.strictEqual(r.regen[0].mode, null);
  assert.deepStrictEqual(r.regen[0].products, ['docs/X.pdf']);
});

test('产物必须是同名兄弟,不误匹配其它文档产物', () => {
  const r = planDocProducts('docs/A.md', ['docs/B.html', 'docs/B.pdf']);
  assert.deepStrictEqual(r.regen, []);
  assert.strictEqual(r.skip[0].reason, 'md-only');
});

test('归一化 ./ 与反斜杠', () => {
  const r = planDocProducts('./docs/X.md', ['docs\\X.html']);
  assert.strictEqual(r.regen.length, 1);
  assert.deepStrictEqual(r.regen[0].products, ['docs/X.html']);
});

test('非 .md 输入 → not-md,不抛', () => {
  const r = planDocProducts('docs/X.txt', ['docs/X.html']);
  assert.deepStrictEqual(r.regen, []);
  assert.strictEqual(r.skip[0].reason, 'not-md');
});

test('垃圾/空输入不抛,返回空计划', () => {
  assert.deepStrictEqual(planDocProducts('', []).regen, []);
  assert.deepStrictEqual(planDocProducts(null, null).regen, []);
  assert.deepStrictEqual(planDocProducts(42, undefined).regen, []);
});

test('确定性:products 排序稳定', () => {
  const r1 = planDocProducts('docs/X.md', ['docs/X.pdf', 'docs/X.html']);
  const r2 = planDocProducts('docs/X.md', ['docs/X.html', 'docs/X.pdf']);
  assert.deepStrictEqual(r1.regen[0].products, r2.regen[0].products);
});
