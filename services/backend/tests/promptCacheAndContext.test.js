'use strict';

// Uses Jest's global describe/it (previously imported from node:test, which
// Jest does not collect). Assertions still run via node:assert/strict.
const assert = require('node:assert/strict');

// ── promptCacheService disk persistence tests ──

const { PromptCache } = require('../src/services/promptCacheService');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('PromptCache disk persistence', () => {
  const tmpDir = path.join(os.tmpdir(), `pcs-test-${Date.now()}`);
  const tmpFile = path.join(tmpDir, 'test_cache.json');

  it('persistToDisk writes only entries with accessCount >= threshold', () => {
    const cache = new PromptCache();
    // Put entry A (access once)
    cache.put('key-a', { systemPrompt: 'hello' }, 'agent1');
    // Put entry B and access it 3 times
    cache.put('key-b', { systemPrompt: 'world' }, 'agent2');
    cache.get('key-b', 'agent2');
    cache.get('key-b', 'agent2');

    const count = cache.persistToDisk(tmpFile, 2);
    assert.equal(count, 1, 'only entry B should be persisted (accessCount >= 2)');

    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf-8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.entries.length, 1);
    assert.equal(raw.entries[0].key, 'key-b');
  });

  it('loadFromDisk restores entries into a fresh cache', () => {
    const cache2 = new PromptCache();
    const loaded = cache2.loadFromDisk(tmpFile);
    assert.equal(loaded, 1);
    assert.ok(cache2.has('key-b'));
    assert.equal(cache2.get('key-b', 'test')?.systemPrompt, 'world');
  });

  it('loadFromDisk returns 0 for missing file', () => {
    const cache3 = new PromptCache();
    assert.equal(cache3.loadFromDisk('/tmp/nonexistent-pcs-test.json'), 0);
  });

  it('loadFromDisk skips duplicate keys already in memory', () => {
    const cache4 = new PromptCache();
    cache4.put('key-b', { systemPrompt: 'existing' }, 'x');
    const loaded = cache4.loadFromDisk(tmpFile);
    assert.equal(loaded, 0, 'should skip key-b since it already exists');
    // Verify original content preserved
    assert.equal(cache4.get('key-b')?.systemPrompt, 'existing');
  });

  // Cleanup
  it('cleanup', () => {
    try { fs.unlinkSync(tmpFile); } catch {}
    try { fs.rmdirSync(tmpDir); } catch {}
  });
});

// ── AgentContext conversationPrefix tests ──

const { AgentContext } = require('../src/services/agentContext');

describe('AgentContext conversationPrefix', () => {
  it('fork inherits conversationPrefix by default', () => {
    const root = new AgentContext({ config: { maxTokens: 4096 } });
    root.conversationPrefix = [{ role: 'user', content: 'hi' }];
    const child = root.fork({ role: 'coder' });
    assert.deepStrictEqual(child.conversationPrefix, root.conversationPrefix);
  });

  it('fork drops conversationPrefix when sharePromptPrefix=false', () => {
    const root = new AgentContext();
    root.conversationPrefix = [{ role: 'user', content: 'hi' }];
    const child = root.fork({ sharePromptPrefix: false });
    assert.equal(child.conversationPrefix, null);
  });

  it('fork allows explicit conversationPrefix override', () => {
    const root = new AgentContext();
    root.conversationPrefix = [{ role: 'user', content: 'old' }];
    const override = [{ role: 'user', content: 'new' }];
    const child = root.fork({ conversationPrefix: override });
    assert.deepStrictEqual(child.conversationPrefix, override);
  });

  it('toSerializable / fromSerializable preserves conversationPrefix', () => {
    const root = new AgentContext();
    root.conversationPrefix = [{ role: 'system', content: 'sys' }];
    const json = root.toSerializable();
    assert.deepStrictEqual(json.conversationPrefix, root.conversationPrefix);

    const restored = AgentContext.fromSerializable(json);
    assert.deepStrictEqual(restored.conversationPrefix, root.conversationPrefix);
  });
});
