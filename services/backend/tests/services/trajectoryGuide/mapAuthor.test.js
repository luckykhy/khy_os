'use strict';

/**
 * mapAuthor.test.js — DESIGN-ARCH-049 G5 (map distillation, capability C).
 *
 * Verifies:
 *   - a STRONG model (claude-opus-4-8) authors a map: ordered step intents,
 *     deterministic qualityScore, both map.json and SKILL.md forms;
 *   - a WEAK model (claude-haiku-4-5) is refused (MAP_AUTHOR_FORBIDDEN) — weak
 *     models consume maps, they do not author them (防呆 strong-gate);
 *   - the SKILL.md form round-trips through skillLoader.parseSkillContent
 *     (frontmatter name/description/tags/version/entry_point intact), so the map
 *     enters the skill ecosystem unchanged;
 *   - mapStore persists + reads back the map (atomic FS, no model);
 *   - qualityScore is reproducible (same trajectory ⇒ same score, no clock).
 *
 * No model is invoked — authoring is deterministic; the strength gate is the
 * only model-derived signal (capabilityVector.assess).
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g5-home-'));
process.env.KHY_PROJECT_DATA_HOME = TMP_HOME;
process.env.KHY_DEP_HEALING = 'off';

const mapAuthor = require('../../../src/services/trajectoryGuide/mapAuthor');
const mapStore = require('../../../src/services/trajectoryGuide/mapStore');
const { parseSkillContent } = require('../../../src/skills/skillLoader');

function manifest() {
  return {
    v: 1,
    kind: 'khyos-replay-bundle',
    sessionId: 'sess-g5',
    env: { platform: 'linux' },
    steps: [
      {
        seq: 0, name: 'write_file', tier: 'FILE',
        artifacts: [{ path: '/work/app/index.js', sha256: 'aa', op: 'create' }],
      },
      {
        seq: 1, name: 'run_shell', tier: 'SHELL',
        params: { command: 'npm install' },
        artifacts: [],
      },
      {
        seq: 2, name: 'web_fetch', tier: 'NETWORK_AI',
        artifacts: [],
      },
    ],
  };
}

test('a strong model authors a map with ordered intents + deterministic score', () => {
  const { map, skillMd, qualityScore } = mapAuthor.authorMap(manifest(), { modelId: 'claude-opus-4-8' });

  assert.strictEqual(map.sessionId, 'sess-g5');
  assert.strictEqual(map.createdBy, 'claude-opus-4-8');
  assert.strictEqual(map.steps.length, 3);
  assert.deepStrictEqual(map.steps.map((s) => s.seq), [0, 1, 2]);
  assert.match(map.steps[0].intent, /create index\.js/);
  assert.match(map.steps[1].intent, /run: npm install/);
  assert.match(map.steps[2].intent, /network\/AI/);
  assert.ok(qualityScore > 0 && qualityScore <= 1);
  assert.strictEqual(map.qualityScore, qualityScore);
  assert.ok(typeof skillMd === 'string' && skillMd.includes('Recommended path'));
});

test('a weak model is refused (strong-gate)', () => {
  assert.throws(
    () => mapAuthor.authorMap(manifest(), { modelId: 'claude-haiku-4-5' }),
    (e) => e.code === 'MAP_AUTHOR_FORBIDDEN',
  );
});

test('SKILL.md round-trips through skillLoader.parseSkillContent', () => {
  const { map, skillMd } = mapAuthor.authorMap(manifest(), { modelId: 'claude-opus-4-8' });
  const parsed = parseSkillContent(skillMd, 'SKILL.md');
  assert.strictEqual(parsed.meta.name, map.id);
  assert.match(parsed.meta.description, /distilled from a successful trajectory/i);
  assert.ok(parsed.meta.tags.includes('trajectory-map'));
  assert.strictEqual(parsed.meta.entry_point, 'SKILL.md');
  assert.ok(parsed.body.includes('Recommended path'));
});

test('mapStore persists and reads back the map', () => {
  const { map } = mapAuthor.authorMap(manifest(), { modelId: 'claude-opus-4-8' });
  const file = mapStore.saveMap(map);
  assert.ok(fs.existsSync(file));
  const back = mapStore.readMap(map.id);
  assert.strictEqual(back.id, map.id);
  assert.strictEqual(back.qualityScore, map.qualityScore);
  const all = mapStore.listMaps();
  assert.ok(all.some((m) => m.id === map.id));
});

test('qualityScore is reproducible across runs (no clock/randomness)', () => {
  const a = mapAuthor.authorMap(manifest(), { modelId: 'claude-opus-4-8' });
  const b = mapAuthor.authorMap(manifest(), { modelId: 'claude-opus-4-8' });
  assert.strictEqual(a.qualityScore, b.qualityScore);
  assert.strictEqual(a.map.id, b.map.id);
});
