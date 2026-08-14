'use strict';

const { GuiEvalTask, GuiEvalRun } = require('@khy/shared/models');
const { sequelize } = require('@khy/shared/models');

/**
 * taskStore — lightweight Sequelize CRUD for GUI Eval tasks and runs.
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

  listTasks(opts = {}) {
    return this._safeAsync(async () => {
      const { page = 1, pageSize = 20, status, difficulty, category, q, tag } = opts;
      const where = {};
      if (status) {
        where.status = status;
      }
      if (difficulty) {
        where.difficulty = difficulty;
      }
      if (category) {
        where.category = category;
      }
      if (q) {
        where.name = { [sequelize.Op.iLike]: `%${q}%` };
      }
      if (tag) {
        where.tags = { [sequelize.Op.contains]: [tag] };
      }
      const offset = (page - 1) * pageSize;
      const { rows, count } = await GuiEvalTask.findAndCountAll({
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
      GuiEvalTask.findByPk(id, {
        include: [{ model: GuiEvalRun, as: 'runs', limit: 20, order: [['createdAt', 'DESC']] }],
      })
    );
  }

  createTask(data) {
    return this._safeAsync(() => GuiEvalTask.create(data));
  }

  updateTask(id, data) {
    return this._safeAsync(async () => {
      const task = await GuiEvalTask.findByPk(id);
      if (!task) {
        throw new Error('Task not found');
      }
      await task.update(data);
      return task;
    });
  }

  deleteTask(id) {
    return this._safeAsync(async () => {
      const task = await GuiEvalTask.findByPk(id);
      if (!task) {
        throw new Error('Task not found');
      }
      // Cascading deletes for runs
      await GuiEvalRun.destroy({ where: { task_id: id } });
      await task.destroy();
    });
  }

  createRun(data) {
    return this._safeAsync(() => GuiEvalRun.create(data));
  }

  getRun(id) {
    return this._safeAsync(() =>
      GuiEvalRun.findByPk(id, {
        include: [{ model: GuiEvalTask, as: 'task' }],
      })
    );
  }

  updateRun(id, data) {
    return this._safeAsync(async () => {
      const run = await GuiEvalRun.findByPk(id);
      if (!run) {
        throw new Error('Run not found');
      }
      await run.update(data);
      return run;
    });
  }

  listRuns(opts = {}) {
    return this._safeAsync(async () => {
      const { page = 1, pageSize = 20, status, verdict, taskId, userId } = opts;
      const where = {};
      if (status) {
        where.status = status;
      }
      if (verdict) {
        where.verdict = verdict;
      }
      if (taskId) {
        where.task_id = taskId;
      }
      if (userId) {
        where.user_id = userId;
      }
      const offset = (page - 1) * pageSize;
      const { rows, count } = await GuiEvalRun.findAndCountAll({
        where,
        order: [['createdAt', 'DESC']],
        limit: pageSize,
        offset,
        include: [{ model: GuiEvalTask, as: 'task', attributes: ['id', 'name', 'difficulty'] }],
      });
      return { runs: rows, total: count, page, pageSize };
    });
  }

  getStats() {
    return this._safeAsync(async () => {
      const [
        totalRuns,
        passRuns,
        partialRuns,
        failRuns,
        pendingRuns,
        totalTasks,
        activeTasks,
        payoutSum,
      ] = await Promise.all([
        GuiEvalRun.count(),
        GuiEvalRun.count({ where: { verdict: 'pass' } }),
        GuiEvalRun.count({ where: { verdict: 'partial' } }),
        GuiEvalRun.count({ where: { verdict: 'fail' } }),
        GuiEvalRun.count({
          where: { verdict: { [sequelize.Op.in]: ['pending', 'pending_review'] } },
        }),
        GuiEvalTask.count(),
        GuiEvalTask.count({ where: { status: 'active' } }),
        GuiEvalRun.sum('payout_amount'),
      ]);
      return {
        runs: {
          total: totalRuns,
          pass: passRuns,
          partial: partialRuns,
          fail: failRuns,
          pending: pendingRuns,
        },
        tasks: { total: totalTasks, active: activeTasks },
        payout: { total: Number(payoutSum) || 0 },
      };
    });
  }
}

module.exports = new TaskStore();
