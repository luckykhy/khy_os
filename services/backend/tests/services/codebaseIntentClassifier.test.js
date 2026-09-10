'use strict';
const { isCodebaseQuery } = require('./codebaseIntentClassifier');
// ── isCodebaseQuery ──────────────────────────────────────────────────────────

describe('Codebase Intent Classifier', () => {
  test('isCodebaseQuery: short text �?not codebase', () => {
      expect(isCodebaseQuery('hi').toEqual({ isCodebase: false, type: 'none' });
      expect(isCodebaseQuery('').toEqual({ isCodebase: false, type: 'none' });
      expect(isCodebaseQuery('a').toEqual({ isCodebase: false, type: 'none' });
  });

  test('isCodebaseQuery: file reference �?file_reference type', () => {
      const result = isCodebaseQuery('Look at server.js');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('file_reference');
  });

  test('isCodebaseQuery: file path with extension', () => {
      const result = isCodebaseQuery('Check src/utils/helper.ts');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('file_reference');
  });

  test('isCodebaseQuery: wildcard file pattern', () => {
      const result = isCodebaseQuery('Find *.vue files');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('file_reference');
  });

  test('isCodebaseQuery: code search - where is function', () => {
      const result = isCodebaseQuery('where is the function handleLogin');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: code search - find class', () => {
      const result = isCodebaseQuery('find the class UserManager');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: code search - show me implementation', () => {
      const result = isCodebaseQuery('show me the implementation of sort');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: code search - what does function do', () => {
      const result = isCodebaseQuery('what does the function calculate do');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: Chinese code search - 哪个文件', () => {
      const result = isCodebaseQuery('哪个文件处理登录');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: Chinese code search - 怎么实现', () => {
      const result = isCodebaseQuery('这个功能怎么实现');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: Chinese code search - 代码在哪', () => {
      const result = isCodebaseQuery('登录的代码在�?);
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: structural - architecture', () => {
      const result = isCodebaseQuery('What is the architecture of this project?');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('structural');
  });

  test('isCodebaseQuery: structural - how does it work', () => {
      const result = isCodebaseQuery('how does the auth system work');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('structural');
  });

  test('isCodebaseQuery: structural - project structure', () => {
      const result = isCodebaseQuery('show me the project structure');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('structural');
  });

  test('isCodebaseQuery: Chinese structural - 架构', () => {
      const result = isCodebaseQuery('这个项目的架构是什�?);
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('structural');
  });

  test('isCodebaseQuery: Chinese structural - 怎么工作', () => {
      const result = isCodebaseQuery('登录是怎么工作�?);
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('structural');
  });

  test('isCodebaseQuery: code identifier with question word', () => {
      const result = isCodebaseQuery('what does handleLogin do');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: snake_case identifier with question', () => {
      const result = isCodebaseQuery('explain tool_use_loop');
      expect(result.isCodebase).toBe(true);
      expect(result.type).toBe('code_search');
  });

  test('isCodebaseQuery: non-codebase query �?none', () => {
      const result = isCodebaseQuery('What is the weather today?');
      expect(result.isCodebase).toBe(false);
      expect(result.type).toBe('none');
  });

  test('isCodebaseQuery: greeting �?none', () => {
      const result = isCodebaseQuery('Hello, how are you?');
      expect(result.isCodebase).toBe(false);
      expect(result.type).toBe('none');
  });

  test('isCodebaseQuery: null/undefined �?none', () => {
      expect(isCodebaseQuery(null).toEqual({ isCodebase: false, type: 'none' });
      expect(isCodebaseQuery(undefined).toEqual({ isCodebase: false, type: 'none' });
  });

  test('isCodebaseQuery: non-string input �?converts to string', () => {
      const result = isCodebaseQuery(12345);
      expect(result.isCodebase).toBe(false);
      expect(result.type).toBe('none');
  });

  test('isCodebaseQuery: camelCase without question word �?none', () => {
      const result = isCodebaseQuery('handleLogin is a function');
      expect(result.isCodebase).toBe(false);
      expect(result.type).toBe('none');
  });

});

