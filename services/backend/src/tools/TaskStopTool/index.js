/**
 * TaskStopTool — stop a running background task.
 * Aligned with Claude Code's TaskStop tool.
 */
const { BaseTool } = require('../_baseTool');

class TaskStopTool extends BaseTool {
  static toolName = 'TaskStop';
  static category = 'system';
  static risk = 'medium';
  static aliases = ['task_stop', 'stop_task', 'kill_task'];
  static searchHint = 'stop kill terminate task background';

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Stops a running background task by its ID.
Returns a success or failure status.
Use this tool when you need to terminate a long-running task.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string', description: 'The ID of the background task to stop.' },
      },
    };
  }

  async execute(params) {
    try {
      const taskStore = require('../_taskStore');
      const stopped = taskStore.stopTask(params.task_id);
      if (stopped) {
        return { success: true, message: `Task ${params.task_id} stopped.` };
      }
      return { error: `Task "${params.task_id}" not found or already completed.` };
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = TaskStopTool;
