'use strict';

/**
 * ScoringEngine — computes checkpoint-weighted scores and verdict.
 *
 * Formula:
 *   autoScore = sum(passed ? weight : 0) / sum(all weights)
 *   verdict:  autoScore >= 0.8 → pass
 *             autoScore >= 0.5 → partial
 *             else             → fail
 */
class ScoringEngine {
  /**
   * @param {Array} checkpointResults  [{ checkpointId, passed, autoScore }]
   * @param {Array} checkpoints       [{ id, weight }]
   * @returns {{ autoScore: number, verdict: string, breakdown: object }}
   */
  compute(checkpointResults, checkpoints = []) {
    const cpMap = new Map(checkpoints.map((cp) => [cp.id, cp]));
    let totalWeight = 0;
    let earnedWeight = 0;
    const results = [];

    for (const cr of checkpointResults || []) {
      const cp = cpMap.get(cr.checkpointId) || { weight: 1 };
      const w = Math.max(0, cp.weight || 1);
      totalWeight += w;
      if (cr.passed) {
        earnedWeight += w;
      }
      results.push({ ...cr, weight: w });
    }

    if (totalWeight === 0) {
      totalWeight = checkpoints.length || 1;
    }
    const autoScore = Math.max(0, Math.min(1, earnedWeight / totalWeight));
    const verdict = autoScore >= 0.8 ? 'pass' : autoScore >= 0.5 ? 'partial' : 'fail';

    return {
      autoScore: Math.round(autoScore * 10000) / 10000,
      verdict,
      totalWeight,
      earnedWeight,
      breakdown: { totalWeight, earnedWeight },
      results,
    };
  }
}

module.exports = { ScoringEngine };
