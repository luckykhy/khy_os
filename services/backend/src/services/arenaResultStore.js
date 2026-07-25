'use strict';

/**
 * Arena Result Store — persist and query arena comparison results.
 *
 * Results are stored as JSON files under ~/.khyquant/arena/{arenaId}.json
 * and can be queried, aggregated into a leaderboard, or re-displayed.
 */
const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../utils/dataHome');

function _arenaDir() {
  return getDataDir('arena');
}

function _filePath(arenaId) {
  // Sanitize ID to prevent path traversal
  const safe = String(arenaId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(_arenaDir(), `${safe}.json`);
}

/**
 * Save an arena result to disk.
 * @param {object} result - ArenaResult from ArenaManager.run()
 * @returns {string} arenaId
 */
function saveResult(result) {
  if (!result || !result.arenaId) {
    throw new Error('Invalid arena result: missing arenaId');
  }
  const filePath = _filePath(result.arenaId);
  const data = {
    ...result,
    savedAt: Date.now(),
  };
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return result.arenaId;
}

/**
 * Load a single arena result by ID.
 * @param {string} arenaId
 * @returns {object|null}
 */
function loadResult(arenaId) {
  const filePath = _filePath(arenaId);
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * List arena results with optional filters.
 * @param {object} [filter]
 * @param {number} [filter.since] - Only results saved after this timestamp
 * @param {number} [filter.until] - Only results saved before this timestamp
 * @param {string} [filter.model] - Only results involving this model
 * @param {string} [filter.promptContains] - Filter by prompt substring
 * @param {number} [filter.limit=50] - Max results to return
 * @returns {object[]} Array of result metadata (lightweight, no full content)
 */
function listResults(filter = {}) {
  const dir = _arenaDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  const results = [];
  const limit = filter.limit || 50;

  for (const file of files) {
    if (results.length >= limit) break;
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(raw);

      // Apply filters
      if (filter.since && (data.savedAt || 0) < filter.since) continue;
      if (filter.until && (data.savedAt || 0) > filter.until) continue;
      if (filter.model) {
        const models = (data.entries || []).map(e => e.model);
        if (!models.some(m => m.includes(filter.model))) continue;
      }
      if (filter.promptContains) {
        if (!(data.prompt || '').includes(filter.promptContains)) continue;
      }

      results.push({
        arenaId: data.arenaId,
        prompt: (data.prompt || '').slice(0, 80),
        models: (data.entries || []).map(e => e.model),
        totalMs: data.totalMs,
        savedAt: data.savedAt,
        recommendation: data.summary?.recommendation || null,
      });
    } catch { /* skip corrupt files */ }
  }

  // Sort by savedAt descending (newest first)
  results.sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return results;
}

/**
 * Delete an arena result.
 * @param {string} arenaId
 * @returns {boolean}
 */
function deleteResult(arenaId) {
  const filePath = _filePath(arenaId);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a leaderboard by aggregating scores across all stored arena runs.
 * @param {object} [opts]
 * @param {number} [opts.since] - Only include results after this timestamp
 * @param {number} [opts.minGames=1] - Minimum games for inclusion
 * @returns {Array<{ model: string, avgScore: number, wins: number, games: number, avgLatencyMs: number, failRate: number }>}
 */
function getLeaderboard(opts = {}) {
  const dir = _arenaDir();
  let files;
  try {
    files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  } catch {
    return [];
  }

  // Accumulate per-model stats
  const stats = {}; // model → { totalScore, wins, games, totalLatency, failures }

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(dir, file), 'utf-8');
      const data = JSON.parse(raw);

      if (opts.since && (data.savedAt || 0) < opts.since) continue;

      const entries = data.entries || [];
      const recommendation = data.summary?.recommendation || '';

      // Extract per-model scores from summary.metrics
      const metrics = data.summary?.metrics || [];

      for (const entry of entries) {
        const model = entry.model;
        if (!stats[model]) {
          stats[model] = { totalScore: 0, wins: 0, games: 0, totalLatency: 0, failures: 0 };
        }
        const s = stats[model];
        s.games++;

        if (entry.failed) {
          s.failures++;
        } else {
          s.totalLatency += entry.totalMs || 0;

          // Find score from metrics
          const metric = metrics.find(m => m.model === model);
          if (metric && typeof metric.score === 'number') {
            s.totalScore += metric.score;
          } else {
            s.totalScore += 50; // default neutral score
          }

          // Check if this model won (mentioned in recommendation)
          if (recommendation.includes(model)) {
            s.wins++;
          }
        }
      }
    } catch { /* skip corrupt */ }
  }

  const minGames = opts.minGames || 1;
  const leaderboard = Object.entries(stats)
    .filter(([, s]) => s.games >= minGames)
    .map(([model, s]) => ({
      model,
      avgScore: s.games > s.failures
        ? Math.round(s.totalScore / (s.games - s.failures))
        : 0,
      wins: s.wins,
      games: s.games,
      avgLatencyMs: s.games > s.failures
        ? Math.round(s.totalLatency / (s.games - s.failures))
        : 0,
      failRate: Math.round((s.failures / s.games) * 100),
    }));

  // Sort by avgScore descending
  leaderboard.sort((a, b) => b.avgScore - a.avgScore);
  return leaderboard;
}

module.exports = {
  saveResult,
  loadResult,
  listResults,
  deleteResult,
  getLeaderboard,
};
