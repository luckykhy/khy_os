'use strict';

/**
 * mapExport.test.js — DESIGN-ARCH-049 G6 (map → skill ecosystem).
 *
 * Verifies exportAsSkill stages a stored map's SKILL.md and delegates to
 * skillPackageService.importSkill so it lands in the user skills root:
 *   - 'md' format imports a single SKILL.md;
 *   - 'folder' format imports a folder with SKILL.md;
 *   - the imported skill re-parses with the map id as its name;
 *   - an unknown map id throws MAP_NOT_FOUND.
 *
 * KHY_DATA_HOME (skills root) + KHY_PROJECT_DATA_HOME (maps store) set before
 * requiring, so both land under temp dirs. No model invoked.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g6-data-'));
const TMP_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g6-proj-'));
process.env.KHY_DATA_HOME = TMP_DATA;
process.env.KHY_PROJECT_DATA_HOME = TMP_PROJ;
process.env.KHY_DEP_HEALING = 'off';

const mapAuthor = require('../../../src/services/trajectoryGuide/mapAuthor');
const mapStore = require('../../../src/services/trajectoryGuide/mapStore');
const mapExport = require('../../../src/services/trajectoryGuide/mapExport');
const { parseSkillFile } = require('../../../src/skills/skillLoader');

function seedMap() {
  const manifest = {
    v: 1, sessionId: 'sess-g6', env: null,
    steps: [
      { seq: 0, name: 'write_file', tier: 'FILE', artifacts: [{ path: '/work/a.js', sha256: 'aa', op: 'create' }] },
      { seq: 1, name: 'run_shell', tier: 'SHELL', params: { command: 'make' }, artifacts: [] },
    ],
  };
  const { map } = mapAuthor.authorMap(manifest, { modelId: 'claude-opus-4-8' });
  mapStore.saveMap(map);
  return map;
}

test("'md' format imports a single SKILL.md into the skills root", async () => {
  const map = seedMap();
  const res = await mapExport.exportAsSkill(map.id, { format: 'md' });
  assert.strictEqual(res.format, 'md');
  assert.strictEqual(res.mapId, map.id);
  const skillMd = path.join(res.dest, 'SKILL.md');
  assert.ok(fs.existsSync(skillMd));
  const parsed = parseSkillFile(skillMd);
  assert.strictEqual(parsed.meta.name, map.id);
});

test("'folder' format imports a folder with SKILL.md", async () => {
  const map = seedMap();
  const res = await mapExport.exportAsSkill(map.id, { format: 'folder' });
  assert.strictEqual(res.format, 'folder');
  assert.ok(fs.existsSync(path.join(res.dest, 'SKILL.md')));
  const parsed = parseSkillFile(path.join(res.dest, 'SKILL.md'));
  assert.ok(parsed.meta.tags.includes('trajectory-map'));
});

test('unknown map id throws MAP_NOT_FOUND', async () => {
  await assert.rejects(
    () => mapExport.exportAsSkill('map-nope-000000000000', {}),
    (e) => e.code === 'MAP_NOT_FOUND',
  );
});
