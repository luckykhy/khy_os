'use strict';

// docSuggestDraft 叶子契约测试(node:test)。
// Layer 4:门控默认关;纯 prompt 构造(不调模型/不写文件)。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  docSuggestEnabled,
  buildSuggestionPrompt,
} = require('../../src/services/docsFreshness/docSuggestDraft');

test('docSuggestEnabled 默认关;仅 {1,true,on,yes} 开', () => {
  assert.strictEqual(docSuggestEnabled({}), false);
  assert.strictEqual(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: '' }), false);
  assert.strictEqual(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: 'x' }), false);
  for (const on of ['1', 'true', 'on', 'yes', 'YES']) {
    assert.strictEqual(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: on }), true, `${on} 应开`);
  }
});

test('buildSuggestionPrompt:含文档名/源码/片段/diff,且强调只出建议不落地', () => {
  const p = buildSuggestionPrompt({
    doc: 'docs/A.md',
    docSection: '端口是 1234',
    sourceDiff: '-1234\n+9090',
    matchedSources: ['services/backend/src/x.js'],
  });
  assert.ok(p.includes('docs/A.md'));
  assert.ok(p.includes('services/backend/src/x.js'));
  assert.ok(p.includes('端口是 1234'));
  assert.ok(p.includes('9090'));
  assert.ok(p.includes('只输出改稿建议') || p.includes('绝不直接改文件'));
});

test('buildSuggestionPrompt:缺字段有兜底,不抛', () => {
  assert.doesNotThrow(() => buildSuggestionPrompt());
  const p = buildSuggestionPrompt({});
  assert.ok(p.includes('(未指定文档)'));
  assert.ok(p.includes('(未提供)'));
});

test('buildSuggestionPrompt:超长片段/diff 截断,不抛', () => {
  const big = 'x'.repeat(10000);
  const p = buildSuggestionPrompt({ doc: 'd', docSection: big, sourceDiff: big });
  assert.ok(p.length < 12000, 'prompt 应对超长输入截断');
});
