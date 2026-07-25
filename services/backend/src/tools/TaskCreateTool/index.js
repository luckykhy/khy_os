/**
 * TaskCreateTool — create tracked tasks, aligned with Claude Code's TaskCreate tool.
 *
 * Creates structured tasks for the current session. Tracks progress,
 * organizes complex multi-step work, and demonstrates thoroughness.
 */
const { BaseTool } = require('../_baseTool');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// Persistent task store (largeTaskRuntimeStore-backed), shared across all task tools
const _taskStore = require('../_taskStore');

class TaskCreateTool extends BaseTool {
  static toolName = 'TaskCreate';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['create_task', 'add_task', 'todo_create'];
  static searchHint = 'create task todo track progress plan';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Use this tool to create a structured task list for your current session. This helps you track progress, organize complex tasks, and demonstrate thoroughness to the user.
It also helps the user understand the progress of the task and overall progress of their requests.

## When to Use This Tool

Use this tool proactively in these scenarios:

- Complex multi-step tasks - When a task requires 3 or more distinct steps or actions
- Non-trivial and complex tasks - Tasks that require careful planning or multiple operations
- Plan mode - When using plan mode, create a task list to track the work
- User explicitly requests todo list - When the user directly asks you to use the todo list
- User provides multiple tasks - When users provide a list of things to be done (numbered or comma-separated)
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps
- The task is purely conversational or informational

NOTE that you should not use this tool if there is only one trivial task to do. In this case you are better off just doing the task directly.

## Task Fields

- **subject**: A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")
- **description**: What needs to be done
- **activeForm** (optional): Present continuous form shown in the spinner when the task is in_progress (e.g., "Fixing authentication bug"). If omitted, the spinner shows the subject instead.

All tasks are created with status \`pending\`.

## Tips

- Create tasks with clear, specific subjects that describe the outcome
- Prefer task-sized steps that can move cleanly from pending to in_progress to completed
- Avoid duplicate tasks and avoid creating one giant umbrella task when several concrete steps are known
- After creating tasks, use TaskUpdate to set up dependencies (blocks/blockedBy) if needed
- Check TaskList first to avoid creating duplicate tasks`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: 'A brief, actionable title in imperative form (e.g., "Fix authentication bug in login flow")',
        },
        description: {
          type: 'string',
          description: 'Detailed description of what needs to be done',
        },
        activeForm: {
          type: 'string',
          description: 'Present continuous form for progress display (e.g., "Fixing authentication bug")',
        },
      },
      required: ['subject'],
    };
  }

  getActivityDescription(input) {
    return `创建任务：${(input.subject || '').slice(0, 40)}`;
  }

  async execute(params, _context) {
    const id = 't-' + crypto.randomBytes(4).toString('hex');
    const task = {
      id,
      subject: params.subject,
      description: params.description || '',
      activeForm: params.activeForm || null,
      status: 'pending',
      blocks: [],
      blockedBy: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    _taskStore.add(task);

    return {
      success: true,
      task,
      message: `已创建任务：${task.subject}（${task.id}）`,
    };
  }
}

module.exports = new TaskCreateTool();
module.exports.TaskCreateTool = TaskCreateTool;
