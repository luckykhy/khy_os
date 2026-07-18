'use strict';

/**
 * Regression test: auto-scaffold must not misfire when the agentic harness
 * injects [System Skill Hints] whose descriptions contain words like
 * "scaffold", "initialize...project", etc.
 *
 * Bug: _looksLikeProjectScaffoldRequest matched on enriched loopInput
 * instead of the raw user message, causing every request to trigger
 * scaffold-files (which then failed with "File path escapes root").
 */

describe('auto-scaffold vs skill hints', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
    jest.resetModules();
  });

  function load() {
    process.env.KHY_TASK_CAPABILITY_GATE = 'false';
    return require('../src/services/toolUseLoop');
  }

  const SKILL_HINTS = [
    '[System Skill Hints]',
    '1. /batch: Run a batch of commands or tasks sequentially',
    '2. /claude-api: Guide for using the Anthropic API and Claude models',
    '3. /create-mcp-server: Scaffold a new MCP server project with TypeScript',
    '4. /skillify: Create a new custom skill with manifest and handler',
    '5. /init: Initialize a new project with best practices',
    '6. /verify: Verify that recent changes work correctly',
  ].join('\n');

  test('raw greeting does not trigger scaffold detection', () => {
    const tul = load();
    expect(tul._looksLikeProjectScaffoldRequest('你好')).toBe(false);
    expect(tul._looksLikeProjectScaffoldRequest('hello')).toBe(false);
    expect(tul._looksLikeProjectScaffoldRequest('你是什么模型')).toBe(false);
  });

  test('enriched message WITH skill hints triggers scaffold (the bug)', () => {
    const tul = load();
    const enriched = '你好\n\n' + SKILL_HINTS;
    // This is the raw behavior — skill hints cause a false positive
    expect(tul._looksLikeProjectScaffoldRequest(enriched)).toBe(true);
  });

  test('sanitized enriched message does NOT trigger scaffold (the fix)', () => {
    const tul = load();
    const enriched = '你好\n\n' + SKILL_HINTS;
    const sanitized = tul._sanitizeSearchSourceMessage(enriched);
    expect(tul._looksLikeProjectScaffoldRequest(sanitized)).toBe(false);
  });

  test('sanitized message preserves real scaffold intent', () => {
    const tul = load();
    const realScaffold = '创建一个新项目结构\n\n' + SKILL_HINTS;
    const sanitized = tul._sanitizeSearchSourceMessage(realScaffold);
    expect(tul._looksLikeProjectScaffoldRequest(sanitized)).toBe(true);
  });

  test('sanitizeSearchSourceMessage strips skill/memory/context sections', () => {
    const tul = load();
    const input = 'user text\n\n[System Skill Hints]\n1. foo\n2. bar\n\n[System Memory Hints]\nsome memory';
    const result = tul._sanitizeSearchSourceMessage(input);
    expect(result).toBe('user text');
  });

  test('extractScaffoldSpecFromMessage does not parse skill hints as files', () => {
    const tul = load();
    const enriched = '你好\n\n' + SKILL_HINTS;
    const sanitized = tul._sanitizeSearchSourceMessage(enriched);
    const spec = tul._extractScaffoldSpecFromMessage(sanitized);
    expect(spec).toBeNull();
  });
});
