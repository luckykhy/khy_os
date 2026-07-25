'use strict';

/**
 * mapStore.js — persistence for distilled trajectory "map templates"
 * (DESIGN-ARCH-049, capability C).
 *
 * A map is the strong-model distillation of a recorded trajectory: an ordered
 * list of step intents plus a deterministic qualityScore. Maps live under
 * getProjectDataDir('trajectoryGuide','maps') as `<id>.map.json`, one file per
 * map. Pure filesystem — no model here (the authoring model runs in mapAuthor).
 */

const fs = require('fs');
const path = require('path');

const { getProjectDataDir } = require('../../utils/dataHome');

/** Absolute directory holding all maps (auto-created by getProjectDataDir). */
function mapsDir() {
  return getProjectDataDir('trajectoryGuide', 'maps');
}

/** Absolute path for a given map id. */
function pathFor(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(mapsDir(), `${safe}.map.json`);
}

/** Persist a map atomically (tmp + rename). Returns the written path. */
function saveMap(map) {
  if (!map || !map.id) throw new Error('map.id is required');
  const file = pathFor(map.id);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

/** Read a map by id, or null if absent / unparseable. */
function readMap(id) {
  const file = pathFor(id);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** List all stored maps (best-effort; skips unreadable files). */
function listMaps() {
  let names = [];
  try {
    names = fs.readdirSync(mapsDir()).filter((n) => n.endsWith('.map.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(mapsDir(), n), 'utf-8')));
    } catch { /* skip corrupt file */ }
  }
  return out;
}

module.exports = {
  mapsDir,
  pathFor,
  saveMap,
  readMap,
  listMaps,
};
