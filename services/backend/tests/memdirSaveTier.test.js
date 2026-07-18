'use strict';

/**
 * Tests for memdir.saveMemory persisting the optional `tier` frontmatter key
 * (the memoryTier layering seam), plus its round-trip through readMemory and
 * the memoryEngine.addStructuredMemory passthrough.
 *
 * Contract:
 *   - tier omitted ⇒ the key is NOT written (backward compatible; readers derive
 *     it from `type` via memoryTier.classifyTier);
 *   - a valid tier is written verbatim and parsed back;
 *   - an invalid tier is dropped (treated as omitted), never persisted;
 *   - addStructuredMemory threads entry.tier through to the saved file.
 *
 * Deterministic: KHY_MEMORY_DIR points at a throwaway temp dir; no LLM/network.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../src/memdir/paths');
const memdir = require('../src/memdir/memdir');
const memoryTier = require('../src/services/memoryTier');

let tmpDir;
let prevEnvDir;

beforeEach(() => {
  prevEnvDir = process.env.KHY_MEMORY_DIR;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-savetier-'));
  process.env.KHY_MEMORY_DIR = tmpDir;
  paths._resetCache();
});

afterEach(() => {
  if (prevEnvDir === undefined) delete process.env.KHY_MEMORY_DIR;
  else process.env.KHY_MEMORY_DIR = prevEnvDir;
  paths._resetCache();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('memdir.saveMemory — tier frontmatter', () => {
  test('omitted tier ⇒ no tier key written; readers derive from type', () => {
    const { filename } = memdir.saveMemory('user', 'identity', 'who the user is', {});
    const raw = fs.readFileSync(path.join(tmpDir, filename), 'utf8');
    expect(raw).not.toMatch(/^tier:/m);

    const parsed = memdir.readMemory(filename);
    expect(parsed.frontmatter.tier).toBeUndefined();
    // Derived layer: user ⇒ permanent.
    expect(memoryTier.classifyTier(parsed.frontmatter)).toBe(memoryTier.TIERS.PERMANENT);
  });

  test('valid tier is persisted and round-trips through readMemory', () => {
    const { filename } = memdir.saveMemory('project', 'pinned fact', 'a fact pinned forever',
      { tier: 'permanent' });
    const raw = fs.readFileSync(path.join(tmpDir, filename), 'utf8');
    expect(raw).toMatch(/^tier: permanent$/m);

    const parsed = memdir.readMemory(filename);
    expect(parsed.frontmatter.tier).toBe('permanent');
    // Explicit tier overrides the type-derived default (project ⇒ cross_session).
    expect(memoryTier.classifyTier(parsed.frontmatter)).toBe(memoryTier.TIERS.PERMANENT);
  });

  test('invalid tier is dropped (treated as omitted)', () => {
    const { filename } = memdir.saveMemory('project', 'note', 'body', { tier: 'garbage' });
    const raw = fs.readFileSync(path.join(tmpDir, filename), 'utf8');
    expect(raw).not.toMatch(/^tier:/m);
    expect(memdir.readMemory(filename).frontmatter.tier).toBeUndefined();
  });

  test('tier is normalized to lowercase', () => {
    const { filename } = memdir.saveMemory('project', 'note2', 'body', { tier: 'PERMANENT' });
    expect(memdir.readMemory(filename).frontmatter.tier).toBe('permanent');
  });
});

describe('memoryEngine.addStructuredMemory — tier passthrough', () => {
  test('threads entry.tier into the saved frontmatter', () => {
    const engine = require('../src/services/memoryEngine');
    const res = engine.addStructuredMemory({
      type: 'project', name: 'pinned via engine', content: 'durable body', tier: 'permanent',
    });
    expect(res.success).toBe(true);
    expect(memdir.readMemory(res.filename).frontmatter.tier).toBe('permanent');
  });

  test('omitting tier leaves the key unwritten', () => {
    const engine = require('../src/services/memoryEngine');
    const res = engine.addStructuredMemory({
      type: 'feedback', name: 'no tier', content: 'some collaboration preference',
    });
    expect(res.success).toBe(true);
    expect(memdir.readMemory(res.filename).frontmatter.tier).toBeUndefined();
  });
});

describe('memoryEngine.addStructuredMemory — short_term routes to session store (layer 1)', () => {
  afterEach(() => {
    try { require('../src/services/memoryEngine').sessionMemory.clear(); } catch {}
  });

  test('tier=short_term is NOT written to disk; it lands in the in-session store', () => {
    const engine = require('../src/services/memoryEngine');
    const before = memdir.listMemories().length;
    const res = engine.addStructuredMemory({
      type: 'project', name: 'scratch', content: 'a temporary in-session note', tier: 'short_term',
    });
    expect(res.success).toBe(true);
    expect(res.ephemeral).toBe(true);
    // No new file on disk.
    expect(memdir.listMemories().length).toBe(before);
    // Present in the session store, recallable this session.
    expect(engine.sessionMemory.size()).toBe(1);
    expect(engine.sessionMemory.recall('temporary in-session note').length).toBe(1);
  });
});

describe('memoryEngine.addStructuredMemory — information update (decideUpdate seam)', () => {
  test('same name + unchanged body ⇒ skip (no rewrite)', () => {
    const engine = require('../src/services/memoryEngine');
    const first = engine.addStructuredMemory({ type: 'project', name: 'fact', content: 'the same body' });
    expect(first.action).toBe('write');
    const again = engine.addStructuredMemory({ type: 'project', name: 'fact', content: 'the same body' });
    expect(again.action).toBe('skip');
    expect(again.filename).toBe(first.filename);
  });

  test('same name + changed body ⇒ supersede in place, preserving a more durable existing tier', () => {
    const engine = require('../src/services/memoryEngine');
    // First write pins it permanent.
    const first = engine.addStructuredMemory({
      type: 'project', name: 'pinned fact', content: 'v1', tier: 'permanent',
    });
    expect(memdir.readMemory(first.filename).frontmatter.tier).toBe('permanent');
    // Update with no tier (would derive cross_session) must NOT downgrade.
    const second = engine.addStructuredMemory({ type: 'project', name: 'pinned fact', content: 'v2 updated' });
    expect(second.action).toBe('write');
    expect(second.filename).toBe(first.filename); // same file, in place
    const parsed = memdir.readMemory(second.filename);
    expect(parsed.body).toContain('v2 updated');
    expect(parsed.frontmatter.tier).toBe('permanent'); // durability preserved
  });
});

describe('capture-side: memoryTrigger.classify → addStructuredMemory (proactive update)', () => {
  test('identity re-declaration via the stable topic key supersedes in place (one file)', () => {
    const trigger = require('../src/services/memoryTrigger');
    const engine = require('../src/services/memoryEngine');

    const save = (msg) => {
      const d = trigger.classify(msg);
      expect(d.kind).not.toBe('none');
      return engine.addStructuredMemory({
        type: d.type, name: d.name || 'note', content: d.note, description: d.note.slice(0, 40), tier: d.tier,
      });
    };

    const before = memdir.listMemories().length;
    const first = save('我叫张三');                 // proactive identity, name=user-name, permanent
    const second = save('其实我叫李四，改个名');      // same topic key ⇒ supersede, not a new file

    expect(first.filename).toBe(second.filename);
    expect(memdir.listMemories().length).toBe(before + 1); // exactly one identity memory
    const parsed = memdir.readMemory(second.filename);
    expect(parsed.body).toContain('李四');
    // user type ⇒ permanent is the derived default, so the redundant tier key is
    // intentionally omitted (byte-stable); the derived layer must still be permanent.
    expect(memoryTier.classifyTier(parsed.frontmatter)).toBe(memoryTier.TIERS.PERMANENT);
  });

  test('explicit「请记住」is reliably persisted to disk', () => {
    const trigger = require('../src/services/memoryTrigger');
    const engine = require('../src/services/memoryEngine');
    const d = trigger.classify('记住：项目根目录是 /srv/app');
    expect(d.kind).toBe('explicit');
    const res = engine.addStructuredMemory({
      type: d.type, name: 'project-root', content: d.note, description: d.note, tier: d.tier,
    });
    expect(res.success).toBe(true);
    expect(res.ephemeral).toBeFalsy(); // cross_session ⇒ on disk, not session-only
    expect(memdir.readMemory(res.filename).body).toContain('/srv/app');
  });
});
