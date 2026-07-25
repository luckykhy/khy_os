'use strict';

/**
 * mapAuthor.js — distill a recorded trajectory into a reusable "map template"
 * (DESIGN-ARCH-049, capability C: "strong model draws the map for weak models").
 *
 * Produces BOTH formats the user locked in ("两者都要"):
 *   (a) an internal map.json — an ordered list of step intents + a deterministic
 *       qualityScore, consumable by guideRetriever/guideInjector;
 *   (b) an exportable SKILL.md — frontmatter + body that skillLoader can re-read,
 *       so the map enters the skill ecosystem.
 *
 * Gate (防呆): only a STRONG model may AUTHOR a map (capabilityVector strength),
 * configurable via KHY_TRAJ_MAP_AUTHOR_MIN_STRENGTH. Weak models consume maps,
 * they do not produce them. The distillation itself is deterministic (no model
 * call) — the model's role is the authorization + optional later enrichment.
 */

const config = require('./config');
const { assess } = require('../marshal/capabilityVector');
const artifactHash = require('../trajectoryReplay/artifactHash');
const tierRegistry = require('../trajectoryReplay/tierRegistry');

/** Short human intent for one step (deterministic, path-basename based). */
function _stepIntent(step) {
  const tier = step.tier || tierRegistry.effectiveTier(step.name);
  const arts = Array.isArray(step.artifacts) ? step.artifacts : [];
  const first = arts.find((a) => a && a.path);
  const base = first ? String(first.path).split(/[\\/]/).pop() : null;
  if (tier === 'FILE' && first) {
    const verb = first.op === 'delete' ? 'delete' : first.op === 'modify' ? 'edit' : 'create';
    return `${verb} ${base}`;
  }
  if (tier === 'SHELL') {
    const cmd = step.params && typeof step.params.command === 'string' ? step.params.command : step.name;
    return `run: ${String(cmd).slice(0, 60)}`;
  }
  if (tier === 'NETWORK_AI') return `${step.name} (network/AI — guidance only)`;
  return step.name;
}

/**
 * Deterministic quality score in [0,1]: rewards FILE coverage and recorded
 * artifacts, penalizes NETWORK_AI noise. Same trajectory ⇒ same score (no clock,
 * no randomness), so retrieval ranking is reproducible.
 */
function _qualityScore(steps) {
  if (!steps.length) return 0;
  let file = 0; let net = 0; let artifacts = 0;
  for (const s of steps) {
    const tier = s.tier || tierRegistry.effectiveTier(s.name);
    if (tier === 'FILE') file += 1;
    else if (tier === 'NETWORK_AI') net += 1;
    artifacts += Array.isArray(s.artifacts) ? s.artifacts.filter((a) => a && a.path).length : 0;
  }
  const total = steps.length;
  const fileRatio = file / total;          // deterministic-replayable fraction
  const noiseRatio = net / total;          // network/AI fraction (not reproducible)
  const artifactBonus = Math.min(1, artifacts / total);
  const raw = 0.6 * fileRatio + 0.3 * artifactBonus + 0.1 * (1 - noiseRatio);
  return Math.round(raw * 1000) / 1000;
}

/** Stable id derived from the step content (no clock → reproducible). */
function _mapId(sessionId, steps) {
  const sig = artifactHash.sha256Hex(JSON.stringify(steps.map((s) => [s.seq, s.name, s.tier])));
  return `map-${String(sessionId || 'session')}-${sig.slice(0, 12)}`;
}

/** Render the SKILL.md form of a map (frontmatter + recommended-path body). */
function renderSkillMd(map) {
  const tags = ['trajectory-map', 'recommended-path', `quality-${map.qualityScore}`];
  const lines = [];
  lines.push('---');
  lines.push(`name: ${map.id}`);
  lines.push(`description: Recommended path distilled from a successful trajectory (${map.task})`);
  lines.push(`tags: [${tags.join(', ')}]`);
  lines.push('version: 1');
  lines.push('entry_point: SKILL.md');
  lines.push('---');
  lines.push('');
  lines.push(`# ${map.task}`);
  lines.push('');
  lines.push(`> Distilled by ${map.createdBy} (${map.createdTier}). Quality score: ${map.qualityScore}.`);
  lines.push('> Follow these steps in order to reproduce the result; they are the highest-success-rate path.');
  lines.push('');
  lines.push('## Recommended path');
  lines.push('');
  for (const s of map.steps) {
    const note = s.tier === 'NETWORK_AI' ? '  _(non-deterministic — use judgement)_' : '';
    lines.push(`${s.seq + 1}. ${s.intent}${note}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Distill a replay bundle/manifest into a map (+ SKILL.md).
 *
 * @param {object} bundle  a manifest object (with .steps) or a readBundle() result.
 * @param {object} opts
 * @param {string} opts.modelId  the authoring model id (strength-gated).
 * @param {string} [opts.task]   human task label; falls back to a derived summary.
 * @returns {{map:object, skillMd:string, qualityScore:number}}
 * @throws if the authoring model is not strong enough.
 */
function authorMap(bundle, opts = {}) {
  const modelId = opts.modelId;
  if (!modelId) throw new Error('authorMap requires opts.modelId');
  const min = config.mapAuthorMinStrength();
  const a = assess(modelId);
  // 'strong' minimum rejects weak models; 'weak' minimum admits both.
  if (min === 'strong' && a.strength !== 'strong') {
    const err = new Error(`model ${modelId} (${a.strength}/${a.tier}) is not strong enough to author a map`);
    err.code = 'MAP_AUTHOR_FORBIDDEN';
    throw err;
  }

  const manifest = bundle && bundle.manifest ? bundle.manifest : bundle;
  const rawSteps = (Array.isArray(manifest.steps) ? manifest.steps : [])
    .slice()
    .sort((x, y) => x.seq - y.seq);
  const sessionId = manifest.sessionId || null;

  const steps = rawSteps.map((s) => ({
    seq: s.seq,
    name: s.name,
    tier: s.tier || tierRegistry.effectiveTier(s.name),
    intent: _stepIntent(s),
    artifacts: (Array.isArray(s.artifacts) ? s.artifacts : [])
      .filter((art) => art && art.path)
      .map((art) => ({ path: art.path, op: art.op || 'create' })),
  }));

  const qualityScore = _qualityScore(rawSteps);
  const task = opts.task
    || (manifest.summary && manifest.summary.task)
    || (steps.length ? `Trajectory ${sessionId || ''}: ${steps[0].intent}` : 'Empty trajectory');

  const map = {
    v: 1,
    id: _mapId(sessionId, steps),
    sessionId,
    task,
    createdBy: modelId,
    createdTier: a.tier,
    qualityScore,
    env: manifest.env || null,
    steps,
    summary: manifest.summary || { total: steps.length },
  };

  return { map, skillMd: renderSkillMd(map), qualityScore };
}

module.exports = {
  authorMap,
  renderSkillMd,
  _qualityScore,
  _stepIntent,
};
