const { BaseTool } = require('../_baseTool');

class TaskOutputTool extends BaseTool {
  static toolName = 'TaskOutput';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['task_output', 'get_task_output'];
  static searchHint = 'read background task output result';
  static shouldDefer = true;

  isReadOnly() { return true; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Retrieve output from a running or completed background task.
- Takes a task_id parameter identifying the task
- Returns the task output along with status information
- Use block=true (default) to wait for task completion
- Use block=false for non-blocking check of current status`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to get output from' },
        block: { type: 'boolean', description: 'Whether to wait for completion (default true)', default: true },
        timeout: { type: 'number', description: 'Max wait time in ms (default 30000)', default: 30000, minimum: 0, maximum: 600000 },
      },
      required: ['task_id'],
    };
  }

  async execute(params) {
    const taskStore = require('../_taskStore');
    const task = taskStore.getTask(params.task_id);
    if (!task) return { error: `Task ${params.task_id} not found` };

    const block = params.block !== false;
    const idleTimeoutMs = Math.max(1000, Math.min(params.timeout || 30000, 600000));

    if (block && task.status === 'running') {
      // Activity-based idle timeout: reset on output changes (Rule 3)
      let lastActivityAt = Date.now();
      let lastOutput = task.output || '';
      while ((Date.now() - lastActivityAt) < idleTimeoutMs) {
        const current = taskStore.getTask(params.task_id);
        if (!current || current.status !== 'running') break;
        const currentOutput = current.output || '';
        if (currentOutput !== lastOutput) {
          lastOutput = currentOutput;
          lastActivityAt = Date.now(); // touch — new output means activity
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }

    const current = taskStore.getTask(params.task_id) || task;
    return {
      task_id: params.task_id,
      status: current.status,
      type: current.type,
      output: current.output || null,
      description: current.description,
    };
  }

  getActivityDescription(input) { return `读取任务输出：${input.task_id}`; }
}

module.exports = TaskOutputTool;
