'use strict';

/**
 * Tests for B4 — Auto Dream lossless forgetting.
 *
 * Covers the memory lifecycle state machine (memoryLifecycle.js) and the
 * lossless consolidation behavior wired into MemoryDreaming: duplicates are
 * archived rather than physically destroyed, every entry carries a lifecycle
 * stage, and total content is preserved across a light-phase dedup.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');

const lifecycle = require('../../src/services/memoryLifecycle');
const { MemoryDreaming } = require('../../src/services/memoryDreaming');

function tmpStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-mem-'));
  return {
    dir,
    store: path.join(dir, 'dream-store.json'),
    archive: path.join(dir, 'dream-archive.json'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

describe('memoryLifecycle — state machine', () => {
  test('exposes all six lifecycle stages in decay order', () => {
    expect(lifecycle.STAGE_ORDER).toEqual([
      'active', 'recent', 'archived', 'dream', 'compressed', 'pruned',
    ]);
  });

  test('isLifecycleStage validates known stages', () => {
    expect(lifecycle.isLifecycleStage('active')).toBe(true);
    expect(lifecycle.isLifecycleStage('pruned')).toBe(true);
    expect(lifecycle.isLifecycleStage('nonsense')).toBe(false);
    expect(lifecycle.isLifecycleStage(undefined)).toBe(false);
  });

  test('every stage retains a path back to active (lossless revival)', () => {
    for (const stage of lifecycle.STAGE_ORDER) {
      if (stage === 'active') continue;
      expect(lifecycle.canTransition(stage, 'active')).toBe(true);
    }
  });

  test('rejects illegal backward transitions', () => {
    expect(lifecycle.canTransition('compressed', 'recent')).toBe(false);
    expect(lifecycle.canTransition('pruned', 'compressed')).toBe(false);
  });

  test('same-stage transition is a no-op allowed', () => {
    expect(lifecycle.canTransition('archived', 'archived')).toBe(true);
  });
});

describe('memoryLifecycle — type weights', () => {
  test('known types map to documented weights', () => {
    expect(lifecycle.typeWeight('milestone')).toBe(0.9);
    expect(lifecycle.typeWeight('decision')).toBe(0.8);
    expect(lifecycle.typeWeight('commitment')).toBe(0.7);
    expect(lifecycle.typeWeight('lesson')).toBe(0.7);
    expect(lifecycle.typeWeight('preference')).toBe(0.6);
    expect(lifecycle.typeWeight('fact')).toBe(0.5);
  });

  test('unknown / missing type falls back to the default weight', () => {
    expect(lifecycle.typeWeight('xyz')).toBe(lifecycle.DEFAULT_TYPE_WEIGHT);
    expect(lifecycle.typeWeight(undefined)).toBe(lifecycle.DEFAULT_TYPE_WEIGHT);
  });
});

describe('memoryLifecycle — stageFromAge', () => {
  test('derives active/recent/archived from age in days', () => {
    expect(lifecycle.stageFromAge(0)).toBe('active');
    expect(lifecycle.stageFromAge(1)).toBe('active');
    expect(lifecycle.stageFromAge(7)).toBe('recent');
    expect(lifecycle.stageFromAge(30)).toBe('archived');
  });

  test('defensive on bad input', () => {
    expect(lifecycle.stageFromAge(-1)).toBe('active');
    expect(lifecycle.stageFromAge(NaN)).toBe('active');
  });
});

describe('MemoryDreaming — lifecycle field', () => {
  test('addMemory initializes lifecycle to active', () => {
    const eng = new MemoryDreaming({});
    const m = eng.addMemory('hello', 'session');
    expect(m.lifecycle).toBe('active');
  });

  test('load() backfills lifecycle on legacy entries from age', () => {
    const t = tmpStore();
    try {
      const legacy = [{
        id: 'a', content: 'x', source: 'session',
        createdAt: Date.now() - 20 * 86400_000,
        score: 1, recallCount: 0, queries: [],
      }];
      fs.writeFileSync(t.store, JSON.stringify(legacy));
      const eng = new MemoryDreaming({ storePath: t.store });
      eng.load();
      expect(eng._memories[0].lifecycle).toBe('archived');
    } finally {
      t.cleanup();
    }
  });
});

describe('MemoryDreaming — lossless dedup', () => {
  test('duplicates are archived, not destroyed, and total content is preserved', async () => {
    const t = tmpStore();
    try {
      const eng = new MemoryDreaming({ storePath: t.store, archivePath: t.archive });
      eng.addMemory('The deploy pipeline uses docker buildx for multi-arch images', 'session', { type: 'decision' });
      eng.addMemory('The deploy pipeline uses docker buildx for multi-arch images.', 'session', { type: 'decision' });

      const stats = await eng.runLightPhase();
      expect(stats.dropped).toBe(1);

      const archived = JSON.parse(fs.readFileSync(t.archive, 'utf-8'));
      expect(archived).toHaveLength(1);
      // The archived entry keeps its original content verbatim.
      expect(typeof archived[0].content).toBe('string');
      expect(archived[0].content.length).toBeGreaterThan(0);
      // Folded into the keeper → recorded as compressed, with a back-reference.
      expect(archived[0].lifecycle).toBe('compressed');
      expect(archived[0].consolidatedInto).toBeTruthy();

      // Lossless: live + archived equals the original count.
      expect(eng._memories.length + archived.length).toBe(2);
    } finally {
      t.cleanup();
    }
  });

  test('getStats reports a byLifecycle breakdown', async () => {
    const t = tmpStore();
    try {
      const eng = new MemoryDreaming({ storePath: t.store, archivePath: t.archive });
      eng.addMemory('alpha distinct content one', 'session');
      eng.addMemory('beta distinct content two', 'session');
      const stats = eng.getStats();
      expect(stats.byLifecycle).toBeDefined();
      expect(stats.byLifecycle.active).toBe(2);
    } finally {
      t.cleanup();
    }
  });
});
