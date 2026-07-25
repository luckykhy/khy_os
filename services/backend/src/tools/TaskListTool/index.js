/**
 * TaskListTool — list all tracked tasks, aligned with Claude Code's TaskList tool.
 *
 * Returns all tasks with their current status, description, and dependencies.
 * Can optionally filter by status.
 */
const { BaseTool } = require('../_baseTool');

const _taskStore = require('../_taskStore');

class TaskListTool extends BaseTool {
  static toolName = 'TaskList';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['list_tasks', 'task_list', 'todo_list'];
  static searchHint = 'list tasks todo progress status';
  static alwaysLoad = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `List all tasks in the current session's task list.

Use this tool to:
- Check existing tasks before creating new ones (avoid duplicates)
- Review overall progress
- Find task IDs for TaskUpdate operations
- Filter by status to see pending, in_progress, or completed tasks

Tips:
- Check TaskList before creating tasks to avoid duplicates
- Use the status_filter parameter to see only tasks in a specific state
- Review the list after each completed step so the next active task is explicit`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        status_filter: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'error'],
          description: 'Optional: filter tasks by status',
        },
      },
      required: [],
    };
  }

  getActivityDescription(_input) {
    return '列出任务列表';
  }

  async execute(params, _context) {
    const tasks = _taskStore.list(params.status_filter || null);

    // Compute summary statistics
    const stats = {
      total: _taskStore.count(),
      pending: 0,
      in_progress: 0,
      completed: 0,
      error: 0,
    };

    const allTasks = _taskStore.list();
    for (const t of allTasks) {
      if (stats[t.status] !== undefined) stats[t.status]++;
    }

    return {
      success: true,
      tasks,
      stats,
      message: `共 ${tasks.length} 个任务${params.status_filter ? `，状态为“${params.status_filter}”` : ''}，已完成 ${stats.completed}/${stats.total}`,
    };
  }
}

module.exports = new TaskListTool();
module.exports.TaskListTool = TaskListTool;
