'use strict';

/**
 * runEngine — executes a GuiEvalTask via the ComputerUseAgent and collects
 * recordings (screenshots, trajectory, artifacts) throughout the run.
 *
 * Execution pipeline:
 *   1. prepareEnvironment(task.environment)  — start required apps
 *   2. startRecording()                       — init WorkflowRecorder + RecordingCollector
 *   3. computerUseAgent.run(goal, opts)       — the observe→think→act→verify loop
 *   4. collectArtifacts()                     — final artifacts + hashes
 *   5. evaluate()                             — run checkpoints + score
 *   6. updateRunStatus(runId, 'completed')    — persist results
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

class RunEngine {
  constructor(opts = {}) {
    this.checkpointVerifier = opts.checkpointVerifier || null;
    this.scoringEngine = opts.scoringEngine || null;
    this.pricingEngine = opts.pricingEngine || null;
    this.reviewService = opts.reviewService || null;
    this._guiEvalService = opts.guiEvalService || null;
  }

  /**
   * Start a task execution.  Returns immediately; the engine updates the Run
   * record in-place as progress is made (via guiEvalService.evaluateRun).
   * @param {object} task
   * @param {object} run
   * @param {object} opts  { agentModel, agentConfig, userId }
   */
  async start(task, run, opts = {}) {
    const runId = run.id;
    const guiEval = this._guiEvalService || require('./index');
    const taskStore = require('./taskStore');

    try {
      // 1. Prepare
      await taskStore.updateRun(runId, {
        status: 'preparing',
        started_at: new Date().toISOString(),
      });
      await this._prepareEnvironment(task.environment);

      // 2. Start recording
      const collector = this._startRecording(runId, task);

      // 3. Execute via ComputerUseAgent
      await taskStore.updateRun(runId, { status: 'running' });
      const result = await this._runAgent(task, run, collector, opts);

      // 4. Collect artifacts
      const recordings = collector.finalize();
      const artifacts = await this._collectArtifacts(task, collector);

      // 5. Calculate duration
      const startedAt = run.started_at || new Date().toISOString();
      const totalDuration = Math.round((Date.now() - new Date(startedAt).getTime()) / 1000);

      // 6. Update run with all collected data
      const updateData = {
        status: 'completed',
        trajectory: recordings.trajectory,
        recordings,
        artifacts,
        total_duration: totalDuration,
        completed_at: new Date().toISOString(),
      };
      await taskStore.updateRun(runId, updateData);

      // 7. Auto-evaluate
      try {
        const evalResult = await guiEval.evaluateRun(runId);
        if (evalResult.success && evalResult.data) {
          await taskStore.updateRun(runId, {
            overall_score: evalResult.data.overall_score,
            auto_score: evalResult.data.auto_score,
            verdict: evalResult.data.verdict,
            checkpoint_results: evalResult.data.checkpoint_results,
            discrepancies: evalResult.data.discrepancies,
            payout_amount: evalResult.data.payout_amount,
            pricing_breakdown: evalResult.data.pricing_breakdown,
          });
        }
      } catch (evalErr) {
        // Evaluation failed → mark run as completed but with failed evaluation
        await taskStore.updateRun(runId, {
          status: 'completed',
          error_message: `Evaluation error: ${evalErr.message}`,
        });
      }
    } catch (err) {
      try {
        await taskStore.updateRun(runId, {
          status: 'failed',
          error_message: err.message,
          error_stack: err.stack || '',
        });
      } catch {
        /* best effort */
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────

  async _prepareEnvironment(env = {}) {
    // Start required applications before execution.
    const apps = Array.isArray(env.apps) ? env.apps : [];
    const { DesktopController } = require('../desktopControl');
    const controller = new DesktopController({ sessionId: '__eval-env__' });
    for (const appName of apps) {
      try {
        await controller.activate(appName);
      } catch {
        /* non-fatal */
      }
    }
  }

  _startRecording(runId, task) {
    const outputDir = path.join(os.tmpdir(), 'khy-eval', String(runId));
    const { RecordingCollector } = require('./recordingCollector');
    const collector = new RecordingCollector({ outputDir });
    collector.ensureDir();
    return collector;
  }

  /**
   * 迭代预算：一个应用一段「观察→操作→验证」流程，轮数需求随应用数线性增长。
   * 固定 30 轮对「浏览器→备忘录→地图→日历」这类四应用任务远远不够——光是应用
   * 切换与逐步验证就吃掉大半预算，任务会在走到最后一个应用之前耗尽轮数而判失败。
   * 可用 environment.maxIterations 显式覆盖。
   * @param {object} task
   * @returns {number} 30–100 之间的迭代上限
   */
  _resolveIterationBudget(task) {
    const env = (task && task.environment) || {};
    const explicit = Number(env.maxIterations || env.max_iterations || 0);
    if (Number.isFinite(explicit) && explicit > 0) {
      return Math.min(100, Math.max(1, Math.round(explicit)));
    }
    const appCount = Array.isArray(env.apps) ? env.apps.length : 0;
    const checkpointCount = Array.isArray(task && task.checkpoints) ? task.checkpoints.length : 0;
    const budget = 15 * Math.max(1, appCount) + 4 * checkpointCount;
    return Math.min(100, Math.max(30, budget));
  }

  async _runAgent(task, run, collector, opts = {}) {
    const { ComputerUseAgent } = require('../computerUse/computerUseAgent');
    const appCount = Array.isArray(task.environment && task.environment.apps)
      ? task.environment.apps.length
      : 0;
    const agent = new ComputerUseAgent({
      model: opts.agentModel,
      maxIterations: this._resolveIterationBudget(task),
    });

    const goal = task.description || task.name;

    const result = await agent.run(goal, {
      hostApproved: true,
      // 多应用任务先规划再执行：计划会注入之后每一轮决策提示词，模型据此维持阶段感，
      // 不至于在第 3 个应用里忘了自己还要回到第 4 个应用。
      planFirst: appCount > 1,
      maxDuration: task.max_duration || 300,
      onIteration: (state, { iteration, action, result: stepResult }) => {
        // Record each iteration
        const step = iteration + 1;
        collector.recordStep(step, action?.type || 'unknown', action?.params || {}, stepResult, [
          action?.params,
        ]);
        collector.captureScreenshot(step).catch(() => {});
      },
    });

    return result;
  }

  async _collectArtifacts(task, collector) {
    // Scan the output directory for any files produced during execution
    const artifacts = [];
    try {
      const files = fs.readdirSync(collector.outputDir);
      for (const file of files) {
        if (
          file.endsWith('.png') ||
          file.endsWith('.log') ||
          file.endsWith('.txt') ||
          file.endsWith('.json')
        ) {
          const fullPath = path.join(collector.outputDir, file);
          artifacts.push(await collector.registerArtifact(fullPath));
        }
      }
    } catch {
      /* ignore */
    }
    return artifacts.filter(Boolean);
  }
}

module.exports = { RunEngine };
