'use strict';

/**
 * guideHandler.test.js — DESIGN-ARCH-049 G9 (CLI guide surface).
 *
 * Verifies `khy guide` dispatch end-to-end against real stored maps (no model):
 *   - `map <session>` with a strong --model distills + persists a map;
 *   - `map <session>` with a weak --model is refused (strong-gate message);
 *   - `list` shows the distilled map with its quality score;
 *   - `export <mapId>` lands the map in the skill ecosystem;
 *   - unknown subcommand / unknown map id report friendly errors, never crash.
 *
 * KHY_DATA_HOME (skills) + KHY_PROJECT_DATA_HOME (maps) set before requiring.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g9-data-'));
const TMP_PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-g9-proj-'));
process.env.KHY_DATA_HOME = TMP_DATA;
process.env.KHY_PROJECT_DATA_HOME = TMP_PROJ;
process.env.KHY_DEP_HEALING = 'off';

const { handleGuide } = require('../../../src/cli/handlers/guide');
const replayLedger = require('../../../src/services/trajectoryReplay/replayLedger');
const mapStore = require('../../../src/services/trajectoryGuide/mapStore');

async function capture(fn) {
  const lines = [];
  const sinks = ['log', 'error', 'warn', 'info'];
  const orig = {};
  for (const s of sinks) { orig[s] = console[s]; console[s] = (...a) => lines.push(a.join(' ')); }
  try { await fn(); } finally { for (const s of sinks) console[s] = orig[s]; }
  return lines.join('\n');
}

function seedLedger(sessionId) {
  replayLedger._resetSeq(sessionId);
  replayLedger.recordToolTurn({
    sessionId,
    name: 'write_file',
    params: { path: path.join(TMP_DATA, 'guide-src.txt'), content: 'g9' },
    result: { success: true },
    writeDiff: { filePath: path.join(TMP_DATA, 'guide-src.txt'), beforeContent: '', afterContent: 'g9' },
  });
}

test('map with a strong model distills and persists a map', async () => {
  seedLedger('g9-strong');
  const out = await capture(() => handleGuide('map', ['g9-strong'], { model: 'claude-opus-4-8' }));
  assert.match(out, /地图模板已蒸馏/);
  assert.match(out, /质量分/);
  assert.ok(mapStore.listMaps().length >= 1);
});

test('map with a weak model is refused', async () => {
  seedLedger('g9-weak');
  const out = await capture(() => handleGuide('map', ['g9-weak'], { model: 'claude-haiku-4-5' }));
  assert.match(out, /智能不足|不可作者/);
});

test('list shows the distilled map', async () => {
  const out = await capture(() => handleGuide('list', [], {}));
  assert.match(out, /地图模板/);
});

test('export lands the map in the skill ecosystem', async () => {
  const maps = mapStore.listMaps();
  assert.ok(maps.length >= 1);
  const id = maps[0].id;
  const out = await capture(() => handleGuide('export', [id], { format: 'folder' }));
  assert.match(out, /地图已入技能生态/);
});

test('unknown map id on export reports a friendly error', async () => {
  const out = await capture(() => handleGuide('export', ['map-nope-000000000000'], {}));
  assert.match(out, /未找到地图/);
});

test('unknown subcommand reports available subcommands', async () => {
  const out = await capture(() => handleGuide('frobnicate', [], {}));
  assert.match(out, /未知子命令/);
  assert.match(out, /map \| export \| list/);
});
