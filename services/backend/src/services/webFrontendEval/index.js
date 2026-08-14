'use strict';

/**
 * WebFrontendEvalService — facade for the 2D/3D Web Frontend Trajectory Annotation platform.
 *
 * Orchestrates: task CRUD → run creation → trajectory package assembly → QC validation → zip packaging.
 */
const { WebFrontendEvalTask, WebFrontendEvalRun } = require('@khy/shared/models');

const taskStore = require('./taskStore');

class WebFrontendEvalService {
  constructor() {
    this._packager = require('./trajectoryPackager');
    this._qcEngine = require('./qcEngine');
  }

  // ── Task CRUD ──────────────────────────────────────────────────

  listTasks(opts = {}) {
    return taskStore.listTasks(opts);
  }

  getTask(id) {
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

  deleteTask(id) {
    return taskStore.deleteTask(id);
  }

  // ── Run Lifecycle ──────────────────────────────────────────────

  /**
   * Start an annotation run. Creates a run record and returns it.
   * The actual trajectory package assembly happens later via assemblePackage().
   */
  async startRun(taskId, opts = {}) {
    const taskResult = await taskStore.getTask(taskId);
    if (!taskResult.success) {
      return taskResult;
    }
    const task = taskResult.data;
    if (!task) {
      return { success: false, message: 'Task not found' };
    }
    if (task.status !== 'active') {
      return { success: false, message: `Task status is "${task.status}", cannot start` };
    }

    return taskStore.createRun({
      task_id: task.id,
      ai_model: opts.aiModel || null,
      annotator_id: opts.annotatorId || 0,
      status: 'annotating',
      api_call_rounds: 0,
    });
  }

  getRun(id) {
    return taskStore.getRun(id);
  }

  listRuns(opts = {}) {
    return taskStore.listRuns(opts);
  }

  /**
   * Assemble the trajectory package from a run's filesystem path.
   * Validates structure, generates manifest, writes QC files.
   */
  async assemblePackage(runId, opts = {}) {
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

    const pkgDir = run.package_path;
    if (!pkgDir) {
      return { success: false, message: 'Run has no package_path set' };
    }

    // 1. Validate structure
    const validation = this._packager.validateStructure(pkgDir);
    if (!validation.valid) {
      return {
        success: false,
        message: `Package structure invalid: ${validation.missing.join(', ')}`,
      };
    }

    // 2. Generate manifest.json
    const manifest = this._packager.generateManifest(pkgDir, task, run);
    this._packager.writeManifest(pkgDir, manifest);

    // 3. Run QC
    const qcResult = this._qcEngine.runQC(pkgDir, task, manifest);

    // 4. Update run
    const verdict = qcResult.passed ? 'reviewing' : 'rejected';
    const update = await taskStore.updateRun(runId, {
      status: verdict,
      qc_result: qcResult,
      qc_score: qcResult.score,
    });

    return { success: update.success, data: { manifest, qcResult } };
  }

  /**
   * Finalize a run after QC passes (complete the run).
   */
  async completeRun(runId, opts = {}) {
    const update = await taskStore.updateRun(runId, {
      status: 'completed',
      delivered_at: new Date().toISOString(),
      total_duration: opts.totalDuration || null,
      notes: opts.notes || null,
    });
    if (!update.success) {
      return update;
    }

    // Generate zip package
    const runResult = await taskStore.getRun(runId);
    if (runResult.success && runResult.data?.package_path) {
      try {
        const zipPath = this._packager.zipPackage(runResult.data.package_path);
        await taskStore.updateRun(runId, { package_zipped: true, package_path: zipPath });
      } catch {
        /* zip failure is non-fatal */
      }
    }
    return { success: true };
  }

  /**
   * Reject a run with a reason.
   */
  async rejectRun(runId, reason) {
    return taskStore.updateRun(runId, {
      status: 'rejected',
      rejection_reason: reason || '未通过 QC',
    });
  }

  /**
   * Submit QC self-check for a run.
   */
  async submitSelfCheck(runId, selfCheck) {
    return taskStore.updateRun(runId, {
      self_check: selfCheck,
      status: 'reviewing',
    });
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats() {
    return taskStore.getStats();
  }
}

module.exports = new WebFrontendEvalService();
