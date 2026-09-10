'use strict';
/**
 * learningCurriculum.rank.test.js �?locks for the growth-roadmap subsystem:
 *   - 修仙境界阶梯 (RANKS / getRank / countCompletedLayers)
 *   - 进度导出 / 导入 (exportProgress / importProgress, merge & replace)
 *   - 存储迁移 ~/.khyquant �?~/.khyos (read-old-fallback, old file preserved)
 *   - 原子�?+ .bak 轮转
 *   - 课程随包守卫 (getLayers().length >= 11)
 *
 * Isolation: HOME and KHYOS_HOME are pointed at a private temp dir BEFORE the
 * module is required, so dataHome caches the temp base home and nothing touches
 * the real user home. node:test convention (matches repo test:node script).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
// ── isolate home dirs before requiring the module under test ──
const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-growth-'));
const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, KHYOS_HOME: process.env.KHYOS_HOME };
process.env.HOME = TMP_HOME;
process.env.USERPROFILE = TMP_HOME;          // Windows homedir source
process.env.KHYOS_HOME = path.join(TMP_HOME, '.khyos');
const curriculum = require('../../src/services/learningCurriculum');
const NEW_DIR = path.join(TMP_HOME, '.khyos', 'growth');
const NEW_FILE = path.join(NEW_DIR, 'learning_progress.json');
const BAK_FILE = path.join(NEW_DIR, 'learning_progress.bak');
const LEGACY_DIR = path.join(TMP_HOME, '.khyquant', 'growth');
const LEGACY_FILE = path.join(LEGACY_DIR, 'learning_progress.json');
function wipe() {
  for (const f of [NEW_FILE, BAK_FILE, LEGACY_FILE]) {
    try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
  }
}
/** Build completedTopics covering the first `k` layers entirely. */
function completeFirstLayers(k) {
  const layers = curriculum.getLayers().slice(0, k);
  const keys = [];
  for (const l of layers) for (const t of l.topics) keys.push(`${l.id}:${t.id}`);
  return keys;
}
before(() => wipe());
after(() => {
  process.env.HOME = ORIG.HOME;
  process.env.USERPROFILE = ORIG.USERPROFILE;
  process.env.KHYOS_HOME = ORIG.KHYOS_HOME;
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => wipe());
describe('curriculum ships with the full course', () => {
});
describe('修仙境界阶梯 (RANKS / getRank)', () => {
});
describe('formatProgressTable surfaces rank + streak', () => {
});
describe('export / import (换电脑带得走)', () => {
describe('storage: migration + atomic write + backup', () => {
});

describe('Learning Curriculum rank', () => {
  test('getLayers() returns at least 11 layers (guards against pip prune)', () => {
        expect(curriculum.getLayers().toBeTruthy().length >= 11,
          `expected >=11 layers, got ${curriculum.getLayers().length}`);
  });

  test('a blank-paper user is 凡人 (Lv0)', () => {
        const r = curriculum.getRank({ completedTopics: [], totalXP: 0, streak: { count: 0 } });
        expect(r.level).toBe(0);
        expect(r.name).toBe('凡人');
        expect(r.isMaster).toBe(false);
        expect(r.next).toBe('练气');
        expect(r.layersToNext).toBe(1);
  });

  test('rank ladder maps completed-layer thresholds correctly', () => {
        const cases = [
          [0, 0, '凡人'],
          [1, 1, '练气'],
          [3, 2, '筑基'],
          [5, 3, '金丹'],
          [7, 4, '元婴'],
          [9, 5, '化神'],
          [11, 6, '大乘'],
          [12, 7, '大师'],
        ];
        for (const [layersDone, level, name] of cases) {
          const r = curriculum.getRank({ completedTopics: completeFirstLayers(layersDone) });
          expect(r.completedLayers).toBe(layersDone, `completedLayers for ${layersDone}`);
          expect(r.level).toBe(level, `level at ${layersDone} layers`);
          expect(r.name).toBe(name, `name at ${layersDone} layers`);
        }
  });

  test('finishing every layer reaches 大师 (master, no next)', () => {
        const all = completeFirstLayers(curriculum.getLayers().length);
        const r = curriculum.getRank({ completedTopics: all });
        expect(r.name).toBe('大师');
        expect(r.isMaster).toBe(true);
        expect(r.next).toBe(null);
  });

  test('countCompletedLayers ignores partially-done layers', () => {
        const layers = curriculum.getLayers();
        const first = layers[0];
        // only one topic of the first layer �?layer not complete
        const partial = [`${first.id}:${first.topics[0].id}`];
        expect(curriculum.countCompletedLayers({ completedTopics: partial })).toBe(0);
  });

  test('formatRoadmap renders current rank name and is non-empty', () => {
        const out = curriculum.formatRoadmap({ completedTopics: completeFirstLayers(3), totalXP: 80, streak: { count: 4 } });
        expect(out.length > 0).toBeTruthy();
        expect(out).toMatch(/筑基/);
        expect(out).toMatch(/修行之路/);
  });

  test('summary box mentions 当前境界 and 连续学习', () => {
        const out = curriculum.formatProgressTable({
          completedTopics: completeFirstLayers(1), viewedTopics: [], currentLayer: 1,
          totalXP: 60, streak: { count: 3, lastDate: '2026-06-15' }, notes: {},
        });
        expect(out).toMatch(/当前境界/);
        expect(out).toMatch(/练气/);
        expect(out).toMatch(/连续学习/);
  });

  test('export writes a versioned envelope to disk', () => {
        // seed progress at the new location
        fs.mkdirSync(NEW_DIR, { recursive: true });
        fs.writeFileSync(NEW_FILE, JSON.stringify({
          completedTopics: completeFirstLayers(2), viewedTopics: [], currentLayer: 2,
          totalXP: 120, streak: { count: 2, lastDate: null }, notes: { '0:x': 'hi' },
        }), 'utf-8');
    
        const dest = path.join(TMP_HOME, 'export1.json');
        const res = curriculum.exportProgress(dest);
        expect(res.ok).toBe(true);
        expect(res.path).toBe(dest);
        const payload = JSON.parse(fs.readFileSync(dest, 'utf-8'));
        expect(payload.tool).toBe('khy-learn');
        expect(payload.version).toBe(1);
        expect(Array.isArray(payload.progress.completedTopics).toBeTruthy());
        expect(payload.progress.totalXP).toBe(120);
  });

  test('round-trip: export then import (replace) restores progress', () => {
        fs.mkdirSync(NEW_DIR, { recursive: true });
        const original = {
          completedTopics: completeFirstLayers(2), viewedTopics: [], currentLayer: 2,
          totalXP: 120, startedAt: '2026-01-01T00:00:00.000Z',
          lastVisit: null, streak: { count: 2, lastDate: null }, notes: {},
        };
        fs.writeFileSync(NEW_FILE, JSON.stringify(original), 'utf-8');
    
        const dest = path.join(TMP_HOME, 'export2.json');
        curriculum.exportProgress(dest);
    
        // wipe local progress, then import as replace
        wipe();
        const res = curriculum.importProgress(dest, { merge: false });
        expect(res.ok).toBe(true);
        expect(res.mode).toBe('replace');
        const restored = curriculum.getProgress();
        expect(restored.totalXP).toBe(120);
        assert.deepStrictEqual(
          restored.completedTopics.sort(),
          original.completedTopics.slice().sort()
        );
  });

  test('import merge takes union of completed + max XP', () => {
        fs.mkdirSync(NEW_DIR, { recursive: true });
        // local: first layer complete, 60 XP
        fs.writeFileSync(NEW_FILE, JSON.stringify({
          completedTopics: completeFirstLayers(1), viewedTopics: [], currentLayer: 1,
          totalXP: 60, streak: { count: 1, lastDate: null }, notes: {},
        }), 'utf-8');
    
        // incoming file: first TWO layers complete, 200 XP
        const incoming = path.join(TMP_HOME, 'incoming.json');
        fs.writeFileSync(incoming, JSON.stringify({
          tool: 'khy-learn', version: 1,
          progress: {
            completedTopics: completeFirstLayers(2), viewedTopics: [], currentLayer: 2,
            totalXP: 200, streak: { count: 5, lastDate: null }, notes: {},
          },
        }), 'utf-8');
    
        const res = curriculum.importProgress(incoming, { merge: true });
        expect(res.ok).toBe(true);
        const merged = curriculum.getProgress();
        expect(merged.totalXP).toBe(200);                 // max
        expect(merged.streak.count).toBe(5);              // max
        const expectUnion = new Set(completeFirstLayers(2));
        expect(merged.completedTopics.length).toBe(expectUnion.size);
  });

  test('import rejects missing / invalid files without corrupting progress', () => {
        fs.mkdirSync(NEW_DIR, { recursive: true });
        const good = { completedTopics: completeFirstLayers(1), viewedTopics: [], currentLayer: 1, totalXP: 60, streak: { count: 0 }, notes: {} };
        fs.writeFileSync(NEW_FILE, JSON.stringify(good), 'utf-8');
    
        const missing = curriculum.importProgress(path.join(TMP_HOME, 'nope.json'));
        expect(missing.ok).toBe(false);
        expect(missing.error).toBe('NOT_FOUND');
    
        const badFile = path.join(TMP_HOME, 'bad.json');
        fs.writeFileSync(badFile, '{not json', 'utf-8');
        const parseFail = curriculum.importProgress(badFile);
        expect(parseFail.ok).toBe(false);
        expect(parseFail.error).toBe('PARSE_FAILED');
    
        // existing progress untouched
        expect(curriculum.getProgress().totalXP).toBe(60);
      });
  });

  test('legacy ~/.khyquant progress migrates to ~/.khyos and old file is preserved', () => {
        // only legacy exists
        fs.mkdirSync(LEGACY_DIR, { recursive: true });
        const legacy = {
          completedTopics: completeFirstLayers(2), viewedTopics: [], currentLayer: 2,
          totalXP: 99, startedAt: '2026-01-01T00:00:00.000Z',
          lastVisit: null, streak: { count: 0, lastDate: null }, notes: {},
        };
        fs.writeFileSync(LEGACY_FILE, JSON.stringify(legacy), 'utf-8');
        expect(!fs.existsSync(NEW_FILE)).toBeTruthy();
    
        const loaded = curriculum.getProgress();
        expect(loaded.totalXP).toBe(99);
        expect(fs.existsSync(NEW_FILE)).toBeTruthy();
        expect(fs.existsSync(LEGACY_FILE)).toBeTruthy();
  });

  test('saving rotates a .bak of the previous file and writes atomically', () => {
        fs.mkdirSync(NEW_DIR, { recursive: true });
        // initial save
        curriculum.markTopicViewed ? null : null;
        fs.writeFileSync(NEW_FILE, JSON.stringify({ completedTopics: [], viewedTopics: [], currentLayer: 0, totalXP: 5, streak: { count: 0 }, notes: {} }), 'utf-8');
    
        // trigger a save via resetProgress (writes new content, rotates bak)
        curriculum.resetProgress();
        expect(fs.existsSync(NEW_FILE)).toBeTruthy();
        expect(fs.existsSync(BAK_FILE)).toBeTruthy();
        // no leftover temp files in the dir
        const leftovers = fs.readdirSync(NEW_DIR).filter(f => f.endsWith('.tmp'));
        expect(leftovers.length).toBe(0, 'no .tmp leftovers after atomic rename');
  });

});

