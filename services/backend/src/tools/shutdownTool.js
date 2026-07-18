/**
 * Shutdown Tool — stop a running worker gracefully.
 *
 * Only available when coordinator mode is active.
 */
const { defineTool } = require('./_baseTool');

module.exports = defineTool({
  name: 'shutdown',
  description:
    'Stop a running worker agent. Use when a worker is on the wrong track ' +
    'or the task is no longer needed.',
  category: 'coordinator',
  risk: 'medium',
  isReadOnly: false,
  isConcurrencySafe: true,

  aliases: ['stop_worker', 'kill_worker'],
  searchHint: 'stop shutdown kill worker coordinator',

  inputSchema: {
    worker_id: {
      type: 'string',
      required: true,
      description: 'Worker ID to stop (e.g., "w-abc123")',
    },
  },

  isEnabled() {
    try {
      const { isCoordinatorMode } = require('../coordinator/coordinatorMode');
      return isCoordinatorMode();
    } catch { return false; }
  },

  getActivityDescription(input) {
    return `停止工作代理 ${input.worker_id}`;
  },

  async execute(params) {
    const { shutdownWorker, getWorkerStatus } = require('../coordinator/workerAgent');

    const worker = getWorkerStatus(params.worker_id);
    if (!worker) {
      return { success: false, error: `Worker ${params.worker_id} not found` };
    }

    const stopped = shutdownWorker(params.worker_id);
    return {
      success: stopped,
      message: stopped
        ? `Worker ${params.worker_id} stopped`
        : `Failed to stop worker ${params.worker_id} (status: ${worker.status})`,
    };
  },
});
