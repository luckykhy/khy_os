'use strict';

/**
 * trajectoryGuide — "trajectory as teacher" subsystem (DESIGN-ARCH-049).
 *
 * Layers an optional AI dimension on top of the deterministic replay subsystem
 * (DESIGN-ARCH-048), all default-off:
 *   A. AI-assisted replay — an AI sub-agent bridges steps the deterministic core
 *      cannot reproduce (aiBridge), wired into replayEngine via an injected
 *      opts.repair hook so the engine itself stays model-free (防呆①).
 *   B. Weak-model guidance — retrieve a relevant past map and inject a recommended
 *      path into the system prompt for weak models (guideRetriever/guideInjector).
 *   C. Map template — a strong model distills a trajectory into both an internal
 *      map.json and an exportable SKILL.md (mapAuthor/mapStore/mapExport).
 *
 * Modules are wired in as their phases (G1..G10) land; the recorded artifact
 * sha256 from 048 remains the sole success oracle throughout.
 */

const config = require('./config');
const aiBridge = require('./aiBridge');
const mapAuthor = require('./mapAuthor');
const mapStore = require('./mapStore');
const mapExport = require('./mapExport');
const guideRetriever = require('./guideRetriever');
const guideInjector = require('./guideInjector');

module.exports = {
  config,
  aiBridge,
  mapAuthor,
  mapStore,
  mapExport,
  guideRetriever,
  guideInjector,
};
