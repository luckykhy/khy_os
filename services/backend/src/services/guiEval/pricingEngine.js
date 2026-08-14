'use strict';

/**
 * PricingEngine — computes payout from checkpoint results and task pricing config.
 *
 * Formula:
 *   payout = basePrice * difficultyMultiplier * completionRatio * timeFactor
 *
 * difficultyMultiplier: easy=0.5, medium=1.0, hard=2.0, expert=5.0
 * completionRatio: checkpointResults 的通过比例
 * timeFactor: SLA 内=1.0, 超时每 10% 递减 5%, 最低 0.3
 */
class PricingEngine {
  static DIFFICULTY_MAP = { easy: 0.5, medium: 1.0, hard: 2.0, expert: 5.0 };

  /**
   * @param {object} task      { pricing, difficulty, max_duration }
   * @param {object} scoreResult  { autoScore, totalWeight, earnedWeight }
   * @param {number} durationSec  actual execution duration in seconds
   * @returns {{ payout: number, breakdown: object }}
   */
  compute(task, scoreResult, durationSec = 0) {
    const pricing = (task && task.pricing) || {};
    const basePrice = Number(pricing.basePrice || 320);
    const diffMult = PricingEngine.DIFFICULTY_MAP[task?.difficulty] || 1.0;
    const completionRatio =
      scoreResult && scoreResult.totalWeight > 0
        ? scoreResult.earnedWeight / scoreResult.totalWeight
        : 0;
    const timeFactor = this._timeFactor(task?.max_duration || 300, durationSec);
    const payout = basePrice * diffMult * completionRatio * timeFactor;

    return {
      payout: Math.round(payout * 100) / 100,
      breakdown: {
        basePrice,
        difficulty: task?.difficulty,
        difficultyMultiplier: diffMult,
        completionRatio: Math.round(completionRatio * 10000) / 10000,
        timeFactor,
        durationSec,
        maxDuration: task?.max_duration || 300,
      },
    };
  }

  /**
   * Time factor: 1.0 when within maxDuration, decays 5% per 10% overage, floor 0.3.
   */
  _timeFactor(maxDurationSec, actualDurationSec) {
    if (actualDurationSec <= 0 || actualDurationSec <= maxDurationSec) {
      return 1.0;
    }
    const overageRatio = actualDurationSec / maxDurationSec;
    const decay = Math.max(0, (overageRatio - 1) / 0.1) * 0.05;
    return Math.max(0.3, 1.0 - decay);
  }
}

module.exports = { PricingEngine };
