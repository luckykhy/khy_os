'use strict';

/**
 * reviewService — manages human review workflow for GuiEvalRuns.
 *
 * Flow:
 *   1. Auto-evaluation produces a score → if < 0.5, mark as pending_review
 *   2. Admin submits manual score via reviewSubmit
 *   3. Recompute pricing with the final score (auto or manual, whichever is higher)
 */

const { GuiEvalRun } = require('@khy/shared/models');

const { PricingEngine } = require('./pricingEngine');

class ReviewService {
  constructor() {
    this._pricingEngine = new PricingEngine();
  }

  /**
   * Check if a run needs human review (auto score < 0.5).
   * @param {object} run
   * @param {object} task
   * @returns {boolean}
   */
  needsReview(run, task) {
    if (run.verdict === 'pending_review') {
      return true;
    }
    const score = run.manual_score != null ? run.manual_score : run.auto_score || 0;
    return score < 0.5;
  }

  /**
   * Submit a manual review score and recompute verdict + pricing.
   * @param {number} runId
   * @param {object} opts  { manualScore }
   * @param {object} task
   * @returns {Promise<object>}
   */
  async submitReview(runId, opts, task) {
    const score = Number(opts.manualScore);
    if (isNaN(score) || score < 0 || score > 1) {
      throw new Error('manualScore must be between 0 and 1');
    }

    const run = await GuiEvalRun.findByPk(runId);
    if (!run) {
      throw new Error('Run not found');
    }

    await run.update({ manual_score: score });

    // Recompute verdict: manual score takes precedence for pass/fail,
    // but auto score may still be higher in partial cases
    const finalScore = Math.max(run.auto_score || 0, score);
    const verdict = finalScore >= 0.8 ? 'pass' : finalScore >= 0.5 ? 'partial' : 'fail';
    await run.update({ verdict });

    // Recompute payout
    const scoreResult = { totalWeight: 1, earnedWeight: finalScore };
    const pricing = this._pricingEngine.compute(task, scoreResult, run.total_duration || 0);
    await run.update({ payout_amount: pricing.payout, pricing_breakdown: pricing.breakdown });

    return { run, pricing };
  }
}

module.exports = new ReviewService();
