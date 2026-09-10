'use strict';
// docSuggestDraft 叶子契约测试(node:test)。
// Layer 4:门控默认关;纯 prompt 构造(不调模型/不写文件)。绝不抛。
const {
  docSuggestEnabled,
  buildSuggestionPrompt,
} = require('../../src/services/domain/docs/docsFreshness/docSuggestDraft.js');

describe('Doc Suggest Draft', () => {
  test('docSuggestEnabled 默认关;仅 {1,true,on,yes} 开', () => {
      expect(docSuggestEnabled({})).toBe(false);
      expect(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: '' })).toBe(false);
      expect(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: 'x' })).toBe(false);
      for (const on of ['1', 'true', 'on', 'yes', 'YES']) {
        expect(docSuggestEnabled({ KHY_DOCS_AI_SUGGEST: on })).toBe(true, `${on} 应开`);
      }
  });

  test('buildSuggestionPrompt:含文档名/源码/片段/diff,且强调只出建议不落地', () => {
      const p = buildSuggestionPrompt({
        doc: 'docs/A.md',
        docSection: '端口是 1234',
        sourceDiff: '-1234\n+9090',
        matchedSources: ['services/backend/src/x.js'],
      });
      expect(p).toContain('docs/A.md');
      expect(p).toContain('services/backend/src/x.js');
      expect(p).toContain('端口是 1234');
      expect(p).toContain('9090');
      expect(p.includes('只输出改稿建议') || p).toContain('绝不直接改文件');
  });

  test('buildSuggestionPrompt:缺字段有兜底,不抛', () => {
      expect(() => buildSuggestionPrompt().not.toThrow());
      const p = buildSuggestionPrompt({});
      expect(p.includes('(未指定文档).toBeTruthy()'));
      expect(p.includes('(未提供).toBeTruthy()'));
  });

  test('buildSuggestionPrompt:超长片段/diff 截断,不抛', () => {
      const big = 'x'.repeat(10000);
      const p = buildSuggestionPrompt({ doc: 'd', docSection: big, sourceDiff: big });
      expect(p.length < 12000).toBeTruthy();
  });

});
