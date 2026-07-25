/**
 * TaskUpdateTool — update task status and dependencies, aligned with Claude Code's TaskUpdate tool.
 *
 * Allows updating task status (pending, in_progress, completed, error),
 * adding blocks/blockedBy relationships, and modifying task details.
 */
const { BaseTool } = require('../_baseTool');

const _taskStore = require('../_taskStore');

class TaskUpdateTool extends BaseTool {
  static toolName = 'TaskUpdate';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['update_task', 'task_update', 'todo_update'];
  static searchHint = 'update task status progress complete block';
  static alwaysLoad = true;

  isReadOnly() { return false; }
  isConcurrencySafe() { return true; }

  prompt() {
    return `Update the status or details of an existing task.

Use this tool to:
- Mark a task as in_progress when you start working on it
- Mark a task as completed when done
- Mark a task as error if something went wrong
- Delete a task by setting status to "deleted" (permanently removes it)
- Add blocks/blockedBy relationships between tasks
- Update the task description or activeForm

Status transitions:
- pending -> in_progress (when starting work)
- in_progress -> completed (when done)
- in_progress -> error (when failed)
- pending -> completed (if done without separate start)
- any -> deleted (permanent removal)

IMPORTANT — Completion constraints:
- ONLY mark a task as completed when you have FULLY accomplished it
- If you encounter errors, blockers, or cannot finish, keep the task as in_progress
- Never mark a task as completed if tests are failing, implementation is partial, or you encountered unresolved errors
- After resolving, call TaskList to find your next task

Tips:
- Always mark tasks as in_progress BEFORE beginning work
- Keep one major task in_progress at a time unless work is truly happening in parallel
- Update status promptly to keep the user informed of progress
- If work is blocked by another task, use blocks/blockedBy or the task description to record that blocker explicitly
- Read a task's latest state using TaskGet before updating it`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'The task ID to update (e.g., "t-abc123")',
        },
        status: {
          type: 'string',
          enum: ['pending', 'in_progress', 'completed', 'error'],
          description: 'New status for the task',
        },
        description: {
          type: 'string',
          description: 'Updated task description',
        },
        activeForm: {
          type: 'string',
          description: 'Updated present continuous form for progress display',
        },
        owner: {
          type: 'string',
          description: 'Claim the task by assigning an owner (agent identifier). Pass an empty string to release ownership.',
        },
        blocks: {
          type: 'array',
          description: 'Array of task IDs that this task blocks',
          items: { type: 'string' },
        },
        blockedBy: {
          type: 'array',
          description: 'Array of task IDs that block this task',
          items: { type: 'string' },
        },
      },
      required: ['id'],
    };
  }

  getActivityDescription(input) {
    if (input.status) {
      return `更新任务 ${input.id} 状态为 ${input.status}`;
    }
    return `更新任务 ${input.id}`;
  }

  async execute(params, _context) {
    const { id, status, description, activeForm, owner, blocks, blockedBy } = params;

    const existing = _taskStore.get(id);
    if (!existing) {
      return { success: false, error: `Task not found: ${id}` };
    }

    // s12 multi-agent claim conflict: refuse to reassign a task that another
    // owner already holds (empty owner = release, always allowed). This makes
    // "claim by setting owner" safe under concurrent agents.
    if (owner) {
      const currentOwner = existing.owner || null;
      if (currentOwner && currentOwner !== owner && existing.status !== 'completed') {
        return {
          success: false,
          error: `任务 ${id} 已被 ${currentOwner} 认领，无法重复认领`,
          owner: currentOwner,
        };
      }
    }

    // s12 dependency gate: starting a task requires all its blockers completed.
    // Pre-check here so the model receives a structured rejection (with the
    // offending blocker IDs) instead of a thrown error. Only gate a fresh start,
    // not idempotent updates to a task that is already in_progress.
    if (status === 'in_progress' && existing.status !== 'in_progress') {
      const gate = _taskStore.canStart(id);
      if (!gate.ok) {
        return {
          success: false,
          error: `任务 ${id} 被未完成的依赖阻塞，无法开始：${gate.blockers.join(', ')}`,
          blockedBy: gate.blockers,
        };
      }
    }

    const updates = {};
    if (status) updates.status = status;
    if (description !== undefined) updates.description = description;
    if (activeForm !== undefined) updates.activeForm = activeForm;
    if (owner !== undefined) updates.owner = owner;
    if (blocks) updates.blocks = blocks;
    if (blockedBy) updates.blockedBy = blockedBy;

    const updated = _taskStore.update(id, updates);

    // If this task blocks others and just completed, check for unblocking
    if (status === 'completed' && updated.blocks && updated.blocks.length > 0) {
      const unblockedTasks = [];
      for (const blockedId of updated.blocks) {
        const blocked = _taskStore.get(blockedId);
        if (blocked && blocked.blockedBy) {
          const remaining = blocked.blockedBy.filter(bid => {
            const blocker = _taskStore.get(bid);
            return blocker && blocker.status !== 'completed';
          });
          if (remaining.length === 0) {
            unblockedTasks.push(blockedId);
          }
        }
      }
      if (unblockedTasks.length > 0) {
        return {
          success: true,
          task: updated,
          unblocked: unblockedTasks,
          message: `任务 ${id} 已更新为 ${status}。已解除阻塞：${unblockedTasks.join(', ')}`,
        };
      }
    }

    return {
      success: true,
      task: updated,
      message: `任务 ${id} 已更新${status ? `为 ${status}` : ''}`,
    };
  }
}

module.exports = new TaskUpdateTool();
module.exports.TaskUpdateTool = TaskUpdateTool;
