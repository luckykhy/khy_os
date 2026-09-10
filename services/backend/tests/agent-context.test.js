'use strict';

/**
 * Tests for Gap #9: Subagent Isolation (AgentContext).
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Bridge the original standalone-script helpers onto Jest's globals so the
// suite is collected by Jest (assertions still run via node 'assert').
function test(name, fn) {
  global.test(name, fn);
}

function group(name, fn) {
  global.describe(name, fn);
}

const { AgentContext } = require('../src/services/agentContext');

// ── Tests ────────────────────────────────────────────────────────

group('1. AgentContext �?creation', () => {
  test('creates with defaults', () => {
    const ctx = new AgentContext();
    expect(ctx.id).toBeTruthy();
    expect(ctx.parentId).toBe(null);
    expect(ctx.depth).toBe(0);
    expect(ctx.role).toBe('general');
    expect(ctx.config.maxTokens).toBe(8192);
    expect(ctx.config.effort).toBe('medium');
    expect(ctx.revealedDeferred.size).toBe(0);
    expect(ctx.fileReadCache.size).toBe(0);
    expect(ctx.isBuilt()).toBe(false);
  });

  test('creates with custom config', () => {
    const ctx = new AgentContext({
      role: 'explore',
      config: { maxTokens: 4096, customKey: 'value' },
    });
    expect(ctx.role).toBe('explore');
    expect(ctx.config.maxTokens).toBe(4096);
    expect(ctx.config.customKey).toBe('value');
    expect(ctx.config.effort).toBe('medium'); // default preserved
  });
});

group('2. AgentContext �?prototype chain config inheritance', () => {
  const parent = new AgentContext({
    config: { maxTokens: 8192, effort: 'high', parentOnly: true },
  });

  const child = parent.fork({ config: { effort: 'low' } });

  test('child inherits parent config via prototype', () => {
    expect(child.config.maxTokens).toBe(8192);
    expect(child.config.parentOnly).toBe(true);
  });

  test('child can override without affecting parent', () => {
    expect(child.config.effort).toBe('low');
    expect(parent.config.effort).toBe('high');
  });

  test('parent modification propagates to child (prototype chain)', () => {
    parent.config.newKey = 'fromParent';
    expect(child.config.newKey).toBe('fromParent');
  });

  test('child override shadows parent', () => {
    child.config.newKey = 'fromChild';
    expect(child.config.newKey).toBe('fromChild');
    expect(parent.config.newKey).toBe('fromParent');
  });

  test('Object.create chain verified', () => {
    expect(Object.getPrototypeOf(child.config) === parent.config).toBeTruthy();
  });
});

group('3. AgentContext �?revealedDeferred isolation', () => {
  const parent = new AgentContext();
  parent.revealTool('tool_a');
  parent.revealTool('tool_b');

  const child = parent.fork();

  test('child inherits parent revealed tools at fork time', () => {
    expect(child.isToolRevealed('tool_a')).toBe();
    expect(child.isToolRevealed('tool_b')).toBe();
  });

  test('child reveal does NOT pollute parent', () => {
    child.revealTool('tool_c');
    expect(child.isToolRevealed('tool_c')).toBe();
    expect(!parent.isToolRevealed('tool_c')).toBe();
  });

  test('parent reveal after fork does NOT affect child', () => {
    parent.revealTool('tool_d');
    expect(parent.isToolRevealed('tool_d')).toBe();
    expect(!child.isToolRevealed('tool_d')).toBe();
  });
});

group('4. AgentContext �?fileReadCache isolation', () => {
  // Create a temp file for testing. Group bodies run at collection time while
  // test bodies run later, so file setup/teardown must use beforeAll/afterAll
  // to avoid the file being removed before the tests execute.
  let tmpDir;
  let tmpFile;
  let parent;
  let child;

  global.beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentctx-test-'));
    tmpFile = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(tmpFile, 'hello world');

    parent = new AgentContext();
    // This group verifies cache ISOLATION, so opt out of the default
    // shared-file-cache behavior (fork() shares the parent cache by default).
    child = parent.fork({ shareFileCache: false });
  });

  global.afterAll(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });

  test('parent and child have independent caches', () => {
    const r1 = parent.readFile(tmpFile);
    expect(r1).toBeTruthy();
    expect(r1.content).toBe('hello world');
    expect(r1.fromCache).toBe(false);

    // Parent cache hit
    const r2 = parent.readFile(tmpFile);
    expect(r2.fromCache).toBe(true);

    // Child has no cache yet
    expect(child.fileReadCache.size).toBe(0);

    const r3 = child.readFile(tmpFile);
    expect(r3.fromCache).toBe(false);
    expect(r3.content).toBe('hello world');
  });

  test('child invalidation does not affect parent', () => {
    child.invalidateFile(tmpFile);
    expect(child.fileReadCache.size).toBe(0);
    expect(parent.fileReadCache.size).toBe(1);
  });
});

group('5. AgentContext �?fork depth tracking', () => {
  const root = new AgentContext();
  const child1 = root.fork();
  const child2 = child1.fork();
  const child3 = child2.fork();

  test('depth increments on each fork', () => {
    expect(root.depth).toBe(0);
    expect(child1.depth).toBe(1);
    expect(child2.depth).toBe(2);
    expect(child3.depth).toBe(3);
  });

  test('parentId chain is correct', () => {
    expect(child1.parentId).toBe(root.id);
    expect(child2.parentId).toBe(child1.id);
    expect(child3.parentId).toBe(child2.id);
  });
});

group('6. AgentContext �?Symbol.BUILT guard', () => {
  const ctx = new AgentContext();

  test('initially not built', () => {
    expect(ctx.isBuilt()).toBe(false);
  });

  test('markBuilt sets the flag', () => {
    ctx.markBuilt();
    expect(ctx.isBuilt()).toBe(true);
  });

  test('forked child is not built', () => {
    const child = ctx.fork();
    expect(child.isBuilt()).toBe(false);
  });

  test('BUILT symbol is not enumerable', () => {
    const keys = Object.keys(ctx);
    expect(!keys).toContain('BUILT');
    expect(!keys.some(k => k)).toContain('built');
  });
});

group('7. AgentContext �?toJSON serialization', () => {
  const ctx = new AgentContext({ role: 'explore', toolFilter: 'explore' });
  ctx.revealTool('tool_x');

  test('toJSON returns expected shape', () => {
    const json = ctx.toJSON();
    expect(json.role).toBe('explore');
    expect(json.toolFilter).toBe('explore');
    expect(json.revealedCount).toBe(1);
    expect(json.fileCacheSize).toBe(0);
    expect(json.depth).toBe(0);
    expect(json.createdAt > 0).toBeTruthy();
  });
});

group('8. tools/index.js �?getDefinitionsForContext', () => {
  // Verify the functions exist and are callable
  const toolRegistry = require('../src/tools');

  test('getDefinitionsForContext is exported', () => {
    expect(typeof toolRegistry.getDefinitionsForContext).toBe('function');
  });

  test('ensureToolForContext is exported', () => {
    expect(typeof toolRegistry.ensureToolForContext).toBe('function');
  });

  test('getDefinitionsForContext uses agent revealedDeferred', () => {
    const ctx1 = new AgentContext({ toolFilter: 'full' });
    const ctx2 = new AgentContext({ toolFilter: 'full' });

    // Both should return the same definitions for 'full' profile
    const defs1 = toolRegistry.getDefinitionsForContext(ctx1);
    const defs2 = toolRegistry.getDefinitionsForContext(ctx2);
    expect(Array.isArray(defs1)).toBe();
    expect(Array.isArray(defs2)).toBe();
    // Both full profiles should have same count
    expect(defs1.length).toBe(defs2.length);
  });

  test('ensureToolForContext reveals into agent context only', () => {
    const ctx = new AgentContext();
    // Try to reveal a non-existent tool
    const result = toolRegistry.ensureToolForContext('nonexistent_tool_xyz', ctx);
    expect(result.revealed).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

console.log('\n--- All Gap #9 tests complete ---\n');

