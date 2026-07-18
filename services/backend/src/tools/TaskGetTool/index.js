/**
 * TaskGetTool — retrieve a task by its ID.
 * Aligned with Claude Code's TaskGet tool.
 */
const { BaseTool } = require('../_baseTool');

class TaskGetTool extends BaseTool {
  static toolName = 'TaskGet';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['task_get', 'get_task'];
  static searchHint = 'get task details status dependencies';

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Retrieve a task by its ID from the task list.
Returns full task details: subject, description, status, blocks, blockedBy.
Use TaskList to see all tasks in summary form.`;
  }

  get inputSchema() {
    return {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string', description: 'The ID of the task to retrieve.' },
      },
    };
  }

  async execute(params) {
    try {
      const taskStore = require('../_taskStore');
      const task = taskStore.getTask(params.taskId);
      if (!task) {
        return { error: `Task "${params.taskId}" not found.` };
      }
      return task;
    } catch (err) {
      return { error: err.message };
    }
  }
}

module.exports = TaskGetTool;
