/**
 * Companion — deterministic pet generation engine.
 *
 * Uses FNV-1a hash of (userId + salt) to seed a Mulberry32 PRNG.
 * Each user gets exactly one fixed companion. Bones (species, rarity,
 * stats) are regenerated every time; only soul (name, personality)
 * persists to disk. Editing config cannot change your companion.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {
  SPECIES, RARITY_WEIGHTS, RARITY_FLOOR, EYES, HATS,
  STAT_NAMES, SHINY_CHANCE, SALT,
} = require('./types');

// ── Hash + PRNG ────────────────────────────────────────────────────

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * FNV-1a 32-bit hash.
 * @param {string} str
 * @returns {number}
 */
function fnv1a(str) {
  let hash = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0; // Ensure unsigned 32-bit
}

/**
 * Mulberry32 PRNG — returns a function producing [0, 1) floats.
 * @param {number} seed - 32-bit unsigned integer
 * @returns {() => number}
 */
function mulberry32(seed) {
  let t = seed | 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let x = Math.imul(t ^ (t >>> 15), t | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Weighted Random Pick ───────────────────────────────────────────

function pickWeighted(rng, weights) {
  const total = Object.values(weights).reduce((s, w) => s + w, 0);
  let roll = rng() * total;
  for (const [key, weight] of Object.entries(weights)) {
    roll -= weight;
    if (roll <= 0) return key;
  }
  return Object.keys(weights).pop();
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

// ── Stat Rolling ───────────────────────────────────────────────────

function rollStats(rng, rarity) {
  const floor = RARITY_FLOOR[rarity] || 5;
  const peakStat = pick(rng, STAT_NAMES);
  let dumpStat = pick(rng, STAT_NAMES);
  while (dumpStat === peakStat) dumpStat = pick(rng, STAT_NAMES);

  const stats = {};
  for (const name of STAT_NAMES) {
    if (name === peakStat) {
      stats[name] = Math.min(100, floor + 50 + Math.floor(rng() * 30));
    } else if (name === dumpStat) {
      stats[name] = Math.max(1, floor - 10 + Math.floor(rng() * 15));
    } else {
      stats[name] = floor + Math.floor(rng() * 40);
    }
  }
  return stats;
}

// ── Roll Cache ─────────────────────────────────────────────────────

let _rollCache = null; // { key, value }

/**
 * Roll companion "bones" from userId. Deterministic and stateless.
 * @param {string} userId
 * @returns {{species: object, eye: string, rarity: string, hat: string, shiny: boolean, stats: object, inspirationSeed: number}}
 */
function rollBones(userId) {
  const key = userId + SALT;
  if (_rollCache && _rollCache.key === key) return _rollCache.value;

  const hash = fnv1a(key);
  const rng = mulberry32(hash);

  // Sequential draws (order matters for determinism)
  const species = SPECIES[Math.floor(rng() * SPECIES.length)];
  const eye = EYES[Math.floor(rng() * EYES.length)];
  const rarity = pickWeighted(rng, RARITY_WEIGHTS);
  const hat = rarity === 'common' ? 'none' : HATS[Math.floor(rng() * HATS.length)];
  const shiny = rng() < SHINY_CHANCE;
  const stats = rollStats(rng, rarity);
  const inspirationSeed = Math.floor(rng() * 1e9);

  const value = { species, eye, rarity, hat, shiny, stats, inspirationSeed };
  _rollCache = { key, value };
  return value;
}

// ── Soul Persistence ───────────────────────────────────────────────

function _soulPath() {
  const { getDataDir } = require('../utils/dataHome');
  return path.join(getDataDir('buddy'), 'soul.json');
}

/**
 * Load persisted soul data (name, personality, hatchedAt).
 * @returns {object|null}
 */
function loadSoul() {
  try {
    const p = _soulPath();
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Save soul data to disk.
 * @param {object} soul - { name, personality, hatchedAt, muted? }
 */
function saveSoul(soul) {
  const p = _soulPath();
  fs.writeFileSync(p, JSON.stringify(soul, null, 2), 'utf-8');
}

/**
 * Get full companion by merging fresh bones + persisted soul.
 * @param {string} userId
 * @returns {object|null} null if not hatched yet
 */
function getCompanion(userId) {
  const soul = loadSoul();
  if (!soul) return null;
  const bones = rollBones(userId);
  return { ...soul, ...bones };
}

/**
 * Get a stable user ID for companion generation.
 * @returns {string}
 */
function getUserId() {
  // Try cliAuthService session
  try {
    const auth = require('../services/cliAuthService');
    const session = auth.checkSession ? auth.checkSession() : null;
    if (session && session.userId) return session.userId;
  } catch { /* not available */ }

  // Fallback: stable machine-derived ID
  const os = require('os');
  return `${os.hostname()}-${os.userInfo().username}`;
}

module.exports = {
  fnv1a, mulberry32, rollBones, rollStats,
  loadSoul, saveSoul, getCompanion, getUserId,
};
