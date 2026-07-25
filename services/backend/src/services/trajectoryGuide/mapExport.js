'use strict';

/**
 * mapExport.js — push a distilled trajectory map into the skill ecosystem
 * (DESIGN-ARCH-049, capability C: exportable SKILL.md form, "两者都要").
 *
 * A stored map (mapStore) already carries its SKILL.md rendering (mapAuthor).
 * Here we materialize that SKILL.md to a temp staging location and delegate to
 * skillPackageService.importSkill, so the map lands in the user skills root
 * exactly like any hand-authored skill — no skill-loading logic reinvented.
 *
 *   exportAsSkill(mapId, {format:'md'|'folder'}) → { name, dest, format }
 *
 * No model here: export is pure FS + the existing skill importer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const mapStore = require('./mapStore');
const mapAuthor = require('./mapAuthor');
const skillPackageService = require('../skillPackageService');

/**
 * Export a stored map as a skill.
 *
 * @param {string} mapId
 * @param {object} [opts]
 * @param {'md'|'folder'} [opts.format='folder']  staging shape handed to importSkill.
 * @returns {Promise<{name:string, dest:string, format:string, mapId:string}>}
 * @throws if the map is unknown.
 */
async function exportAsSkill(mapId, opts = {}) {
  const format = opts.format || 'folder';
  const map = mapStore.readMap(mapId);
  if (!map) {
    const err = new Error(`map not found: ${mapId}`);
    err.code = 'MAP_NOT_FOUND';
    throw err;
  }

  // Re-render from the stored map so the SKILL.md always matches current map state.
  const skillMd = mapAuthor.renderSkillMd(map);
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-map-export-'));

  try {
    let srcPath;
    if (format === 'md') {
      srcPath = path.join(stage, `${map.id}.md`);
      fs.writeFileSync(srcPath, skillMd, 'utf-8');
    } else if (format === 'folder') {
      srcPath = path.join(stage, map.id);
      fs.mkdirSync(srcPath, { recursive: true });
      fs.writeFileSync(path.join(srcPath, 'SKILL.md'), skillMd, 'utf-8');
    } else {
      throw new Error(`unknown export format "${format}" (expected md|folder)`);
    }

    const res = await skillPackageService.importSkill(srcPath, {});
    return { ...res, format, mapId: map.id };
  } finally {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

module.exports = { exportAsSkill };
