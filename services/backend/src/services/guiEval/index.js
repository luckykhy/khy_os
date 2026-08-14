'use strict';

/**
 * GuiEvalService — top-level facade for the GUI Agent evaluation platform.
 *
 * Orchestrates: task CRUD → run execution → auto-evaluation → pricing → review.
 *
 * All methods are async and return { success, data } or { success, false, message }.
 */
const { GuiEvalTask, GuiEvalRun } = require('@khy/shared/models');

const { CheckpointVerifier } = require('./checkpointVerifier');
const { PricingEngine } = require('./pricingEngine');
const reviewService = require('./reviewService');
const { RunEngine } = require('./runEngine');
const { ScoringEngine } = require('./scoringEngine');
const taskStore = require('./taskStore');

class GuiEvalService {
  constructor() {
    this._runEngine = new RunEngine({
      checkpointVerifier: new CheckpointVerifier(),
      scoringEngine: new ScoringEngine(),
      pricingEngine: new PricingEngine(),
      reviewService,
    });
  }

  // ── Task CRUD (delegates to taskStore) ──────────────────────────

  async listTasks(opts = {}) {
    return taskStore.listTasks(opts);
  }

  async getTask(id) {
    return taskStore.getTask(id);
  }

  async createTask(data) {
    const result = taskStore.createTask(data);
    if (!result.success) {
      return result;
    }
    return taskStore.getTask(result.data.id);
  }

  async updateTask(id, data) {
    const result = taskStore.updateTask(id, data);
    if (!result.success) {
      return result;
    }
    return taskStore.getTask(id);
  }

  async deleteTask(id) {
    return taskStore.deleteTask(id);
  }

  // ── Execution ────────────────────────────────────────────────────

  async executeTask(taskId, opts = {}) {
    const taskResult = await taskStore.getTask(taskId);
    if (!taskResult.success) {
      return taskResult;
    }
    const task = taskResult.data;
    if (!task) {
      return { success: false, message: 'Task not found' };
    }
    if (task.status !== 'active') {
      return { success: false, message: `Task status is "${task.status}", cannot execute` };
    }

    const run = await taskStore.createRun({
      task_id: task.id,
      guarded_run_id: opts.guardedRunId || null,
      agent_model: opts.agentModel || null,
      agent_config: opts.agentConfig || {},
      status: 'queued',
      user_id: opts.userId || 0,
    });

    if (!run.success) {
      return run;
    }

    // Kick off the execution engine (fire-and-forget the actual run;
    // the run record exists now and the engine updates it in-place).
    this._runEngine.start(task, run.data, opts).catch((err) => {
      try {
        taskStore.updateRun(run.data.id, {
          status: 'failed',
          error_message: err.message,
          error_stack: err.stack,
        });
      } catch {
        /* best effort */
      }
    });

    return {
      success: true,
      data: { runId: run.data.id, status: 'queued', message: 'Task queued for execution' },
    };
  }

  // ── Run queries ──────────────────────────────────────────────────

  async getRun(id) {
    return taskStore.getRun(id);
  }

  async listRuns(opts = {}) {
    return taskStore.listRuns(opts);
  }

  // ── Evaluation ──────────────────────────────────────────────────

  async evaluateRun(runId) {
    const runResult = await taskStore.getRun(runId);
    if (!runResult.success) {
      return runResult;
    }
    const run = runResult.data;
    if (!run) {
      return { success: false, message: 'Run not found' };
    }

    const taskResult = await taskStore.getTask(run.task_id);
    if (!taskResult.success) {
      return taskResult;
    }
    const task = taskResult.data;

    // Run each checkpoint
    const verifier = new CheckpointVerifier();
    const checkpointResults = [];
    const checkpoints = task.checkpoints || [];
    for (const cp of checkpoints) {
      const result = await verifier.verify(cp, {
        trajectory: run.trajectory,
        recordings: run.recordings,
        artifacts: run.artifacts,
      });
      checkpointResults.push({ checkpointId: cp.id, ...result });
    }

    // Compute score
    const engine = new ScoringEngine();
    const scoreResult = engine.compute(checkpointResults, checkpoints);

    // Compute pricing
    const pricingEngine = new PricingEngine();
    const pricing = pricingEngine.compute(task, scoreResult, run.total_duration || 0);

    // Determine if review is needed
    let verdict = scoreResult.verdict;
    if (scoreResult.autoScore < 0.5) {
      verdict = 'pending_review';
    }

    // Compute discrepancies against gold standard
    const discrepancies = this._computeDiscrepancies(
      checkpointResults,
      checkpoints,
      task.gold_standard
    );

    const update = taskStore.updateRun(run.id, {
      status: 'completed',
      checkpoint_results: checkpointResults,
      overall_score: scoreResult.autoScore,
      auto_score: scoreResult.autoScore,
      verdict,
      discrepancies,
      payout_amount: pricing.payout,
      pricing_breakdown: pricing.breakdown,
      completed_at: new Date().toISOString(),
    });

    if (!update.success) {
      return update;
    }

    return taskStore.getRun(run.id);
  }

  // ── Review ────────────────────────────────────────────────────────

  async submitReview(runId, opts) {
    const runResult = await taskStore.getRun(runId);
    if (!runResult.success) {
      return runResult;
    }
    const run = runResult.data;
    const taskResult = await taskStore.getTask(run.task_id);
    if (!taskResult.success) {
      return taskResult;
    }
    return reviewService.submitReview(runId, opts, taskResult.data);
  }

  // ── Stats ────────────────────────────────────────────────────────

  async getStats() {
    return taskStore.getStats();
  }

  // ── Helpers ──────────────────────────────────────────────────────

  _computeDiscrepancies(checkpointResults, checkpoints, goldStandard) {
    if (!goldStandard || !Object.keys(goldStandard).length) {
      return [];
    }
    const discrepancies = [];
    const cpMap = new Map(checkpoints.map((cp) => [cp.id, cp]));
    for (const cr of checkpointResults) {
      const cp = cpMap.get(cr.checkpointId);
      if (!cp || cr.passed) {
        continue;
      }
      const goldEntry = goldStandard.checkpoints?.find((c) => c.id === cr.checkpointId);
      discrepancies.push({
        checkpointId: cr.checkpointId,
        expected: goldEntry ? goldEntry.expected : 'unknown',
        actual: cr.evidence,
        severity: cr.autoScore >= 0.5 ? 'minor' : 'major',
      });
    }
    return discrepancies;
  }
}

module.exports = new GuiEvalService();
