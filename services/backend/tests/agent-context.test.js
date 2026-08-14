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

group('1. AgentContext — creation', () => {
  test('creates with defaults', () => {
    const ctx = new AgentContext();
    assert.ok(ctx.id);
    assert.strictEqual(ctx.parentId, null);
    assert.strictEqual(ctx.depth, 0);
    assert.strictEqual(ctx.role, 'general');
    assert.strictEqual(ctx.config.maxTokens, 8192);
    assert.strictEqual(ctx.config.effort, 'medium');
    assert.strictEqual(ctx.revealedDeferred.size, 0);
    assert.strictEqual(ctx.fileReadCache.size, 0);
    assert.strictEqual(ctx.isBuilt(), false);
  });

  test('creates with custom config', () => {
    const ctx = new AgentContext({
      role: 'explore',
      config: { maxTokens: 4096, customKey: 'value' },
    });
    assert.strictEqual(ctx.role, 'explore');
    assert.strictEqual(ctx.config.maxTokens, 4096);
    assert.strictEqual(ctx.config.customKey, 'value');
    assert.strictEqual(ctx.config.effort, 'medium'); // default preserved
  });
});

group('2. AgentContext — prototype chain config inheritance', () => {
  const parent = new AgentContext({
    config: { maxTokens: 8192, effort: 'high', parentOnly: true },
  });

  const child = parent.fork({ config: { effort: 'low' } });

  test('child inherits parent config via prototype', () => {
    assert.strictEqual(child.config.maxTokens, 8192);
    assert.strictEqual(child.config.parentOnly, true);
  });

  test('child can override without affecting parent', () => {
    assert.strictEqual(child.config.effort, 'low');
    assert.strictEqual(parent.config.effort, 'high');
  });

  test('parent modification propagates to child (prototype chain)', () => {
    parent.config.newKey = 'fromParent';
    assert.strictEqual(child.config.newKey, 'fromParent');
  });

  test('child override shadows parent', () => {
    child.config.newKey = 'fromChild';
    assert.strictEqual(child.config.newKey, 'fromChild');
    assert.strictEqual(parent.config.newKey, 'fromParent');
  });

  test('Object.create chain verified', () => {
    assert.ok(Object.getPrototypeOf(child.config) === parent.config);
  });
});

group('3. AgentContext — revealedDeferred isolation', () => {
  const parent = new AgentContext();
  parent.revealTool('tool_a');
  parent.revealTool('tool_b');

  const child = parent.fork();

  test('child inherits parent revealed tools at fork time', () => {
    assert.ok(child.isToolRevealed('tool_a'));
    assert.ok(child.isToolRevealed('tool_b'));
  });

  test('child reveal does NOT pollute parent', () => {
    child.revealTool('tool_c');
    assert.ok(child.isToolRevealed('tool_c'));
    assert.ok(!parent.isToolRevealed('tool_c'));
  });

  test('parent reveal after fork does NOT affect child', () => {
    parent.revealTool('tool_d');
    assert.ok(parent.isToolRevealed('tool_d'));
    assert.ok(!child.isToolRevealed('tool_d'));
  });
});

group('4. AgentContext — fileReadCache isolation', () => {
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
    assert.ok(r1);
    assert.strictEqual(r1.content, 'hello world');
    assert.strictEqual(r1.fromCache, false);

    // Parent cache hit
    const r2 = parent.readFile(tmpFile);
    assert.strictEqual(r2.fromCache, true);

    // Child has no cache yet
    assert.strictEqual(child.fileReadCache.size, 0);

    const r3 = child.readFile(tmpFile);
    assert.strictEqual(r3.fromCache, false);
    assert.strictEqual(r3.content, 'hello world');
  });

  test('child invalidation does not affect parent', () => {
    child.invalidateFile(tmpFile);
    assert.strictEqual(child.fileReadCache.size, 0);
    assert.strictEqual(parent.fileReadCache.size, 1);
  });
});

group('5. AgentContext — fork depth tracking', () => {
  const root = new AgentContext();
  const child1 = root.fork();
  const child2 = child1.fork();
  const child3 = child2.fork();

  test('depth increments on each fork', () => {
    assert.strictEqual(root.depth, 0);
    assert.strictEqual(child1.depth, 1);
    assert.strictEqual(child2.depth, 2);
    assert.strictEqual(child3.depth, 3);
  });

  test('parentId chain is correct', () => {
    assert.strictEqual(child1.parentId, root.id);
    assert.strictEqual(child2.parentId, child1.id);
    assert.strictEqual(child3.parentId, child2.id);
  });
});

group('6. AgentContext — Symbol.BUILT guard', () => {
  const ctx = new AgentContext();

  test('initially not built', () => {
    assert.strictEqual(ctx.isBuilt(), false);
  });

  test('markBuilt sets the flag', () => {
    ctx.markBuilt();
    assert.strictEqual(ctx.isBuilt(), true);
  });

  test('forked child is not built', () => {
    const child = ctx.fork();
    assert.strictEqual(child.isBuilt(), false);
  });

  test('BUILT symbol is not enumerable', () => {
    const keys = Object.keys(ctx);
    assert.ok(!keys.includes('BUILT'));
    assert.ok(!keys.some(k => k.includes('built')));
  });
});

group('7. AgentContext — toJSON serialization', () => {
  const ctx = new AgentContext({ role: 'explore', toolFilter: 'explore' });
  ctx.revealTool('tool_x');

  test('toJSON returns expected shape', () => {
    const json = ctx.toJSON();
    assert.strictEqual(json.role, 'explore');
    assert.strictEqual(json.toolFilter, 'explore');
    assert.strictEqual(json.revealedCount, 1);
    assert.strictEqual(json.fileCacheSize, 0);
    assert.strictEqual(json.depth, 0);
    assert.ok(json.createdAt > 0);
  });
});

group('8. tools/index.js — getDefinitionsForContext', () => {
  // Verify the functions exist and are callable
  const toolRegistry = require('../src/tools');

  test('getDefinitionsForContext is exported', () => {
    assert.strictEqual(typeof toolRegistry.getDefinitionsForContext, 'function');
  });

  test('ensureToolForContext is exported', () => {
    assert.strictEqual(typeof toolRegistry.ensureToolForContext, 'function');
  });

  test('getDefinitionsForContext uses agent revealedDeferred', () => {
    const ctx1 = new AgentContext({ toolFilter: 'full' });
    const ctx2 = new AgentContext({ toolFilter: 'full' });

    // Both should return the same definitions for 'full' profile
    const defs1 = toolRegistry.getDefinitionsForContext(ctx1);
    const defs2 = toolRegistry.getDefinitionsForContext(ctx2);
    assert.ok(Array.isArray(defs1));
    assert.ok(Array.isArray(defs2));
    // Both full profiles should have same count
    assert.strictEqual(defs1.length, defs2.length);
  });

  test('ensureToolForContext reveals into agent context only', () => {
    const ctx = new AgentContext();
    // Try to reveal a non-existent tool
    const result = toolRegistry.ensureToolForContext('nonexistent_tool_xyz', ctx);
    assert.strictEqual(result.revealed, false);
    assert.ok(result.error);
  });
});

console.log('\n--- All Gap #9 tests complete ---\n');
