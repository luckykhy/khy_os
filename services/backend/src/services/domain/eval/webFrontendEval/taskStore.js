'use strict';

const { WebFrontendEvalTask, WebFrontendEvalRun } = require('@khy/shared/models');
const { sequelize } = require('@khy/shared/models');

/**
 * taskStore — lightweight Sequelize CRUD for Web Frontend Eval tasks and runs.
 * Follows the _safeAsync pattern: try/catch → { success: false, message }.
 */
class TaskStore {
  async _safeAsync(fn) {
    try {
      return { success: true, data: await fn() };
    } catch (err) {
      return { success: false, message: err.message || 'Operation failed' };
    }
  }

  // ── Task CRUD ─────────────────────────────────────────────────

  listTasks(opts = {}) {
    return this._safeAsync(async () => {
      const { page = 1, pageSize = 20, level, category, status, q, tag } = opts;
      const where = {};
      if (level) {
        where.level = level;
      }
      if (category) {
        where.category = category;
      }
      if (status) {
        where.status = status;
      }
      if (q) {
        where.name = { [sequelize.Op.iLike]: `%${q}%` };
      }
      if (tag) {
        where.tags = { [sequelize.Op.contains]: [tag] };
      }
      const offset = (page - 1) * pageSize;
      const { rows, count } = await WebFrontendEvalTask.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: pageSize,
        offset,
      });
      return { tasks: rows, total: count, page, pageSize };
    });
  }

  getTask(id) {
    return this._safeAsync(() =>
      WebFrontendEvalTask.findByPk(id, {
        include: [
          { model: WebFrontendEvalRun, as: 'runs', limit: 20, order: [['createdAt', 'DESC']] },
        ],
      })
    );
  }

  createTask(data) {
    return this._safeAsync(() => WebFrontendEvalTask.create(data));
  }

  updateTask(id, data) {
    return this._safeAsync(async () => {
      const task = await WebFrontendEvalTask.findByPk(id);
      if (!task) {
        throw new Error('Task not found');
      }
      await task.update(data);
      return task;
    });
  }

  deleteTask(id) {
    return this._safeAsync(async () => {
      const task = await WebFrontendEvalTask.findByPk(id);
      if (!task) {
        throw new Error('Task not found');
      }
      await WebFrontendEvalRun.destroy({ where: { task_id: id } });
      await task.destroy();
    });
  }

  // ── Run CRUD ──────────────────────────────────────────────────

  createRun(data) {
    return this._safeAsync(() => WebFrontendEvalRun.create(data));
  }

  getRun(id) {
    return this._safeAsync(() =>
      WebFrontendEvalRun.findByPk(id, {
        include: [
          {
            model: WebFrontendEvalTask,
            as: 'task',
            attributes: ['id', 'name', 'level', 'category'],
          },
        ],
      })
    );
  }

  updateRun(id, data) {
    return this._safeAsync(async () => {
      const run = await WebFrontendEvalRun.findByPk(id);
      if (!run) {
        throw new Error('Run not found');
      }
      await run.update(data);
      return run;
    });
  }

  listRuns(opts = {}) {
    return this._safeAsync(async () => {
      const { page = 1, pageSize = 20, status, taskId, annotatorId } = opts;
      const where = {};
      if (status) {
        where.status = status;
      }
      if (taskId) {
        where.task_id = taskId;
      }
      if (annotatorId) {
        where.annotator_id = annotatorId;
      }
      const offset = (page - 1) * pageSize;
      const { rows, count } = await WebFrontendEvalRun.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: pageSize,
        offset,
        include: [
          {
            model: WebFrontendEvalTask,
            as: 'task',
            attributes: ['id', 'name', 'level', 'category'],
          },
        ],
      });
      return { runs: rows, total: count, page, pageSize };
    });
  }

  // ── Stats ─────────────────────────────────────────────────────

  getStats() {
    return this._safeAsync(async () => {
      const [totalRuns, annotatingRuns, completedRuns, rejectedRuns, totalTasks, activeTasks] =
        await Promise.all([
          WebFrontendEvalRun.count(),
          WebFrontendEvalRun.count({ where: { status: 'annotating' } }),
          WebFrontendEvalRun.count({ where: { status: 'completed' } }),
          WebFrontendEvalRun.count({ where: { status: 'rejected' } }),
          WebFrontendEvalTask.count(),
          WebFrontendEvalTask.count({ where: { status: 'active' } }),
        ]);
      return {
        runs: {
          total: totalRuns,
          annotating: annotatingRuns,
          completed: completedRuns,
          rejected: rejectedRuns,
        },
        tasks: { total: totalTasks, active: activeTasks },
      };
    });
  }
}

module.exports = new TaskStore();
