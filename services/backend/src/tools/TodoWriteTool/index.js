const { BaseTool } = require('../_baseTool');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 历史全局路径(会话作用域门控关 / 无 sessionId 时的字节回退目标)。
const TODO_FILE = path.join(os.tmpdir(), 'khy-todos.json');

/**
 * 解析本次读写应落到的 V1 清单文件——会话作用域路径。
 *
 * 病根(任务系统分裂·第 2 步):历史写死全局 `TODO_FILE`,并发多会话互相覆盖、
 * 新会话读到上一会话残留。经纯叶子 `todoStorePath.resolveTodoFilePath` 按当前
 * sessionId 分文件,使每个会话天然拥有独立、空白起步的清单。
 *
 * fail-soft:门控关 / 拿不到 sessionId / 任何异常 → 回退历史全局 `TODO_FILE`
 * (与今日**字节一致**,零行为变化)。execute()(写)与 snapshot()(读)都经此,
 * 同一会话内解析同一 sessionId → 同一文件,读写自洽。
 * @returns {string} 绝对文件路径
 */
function _resolveTodoFile() {
  try {
    const { resolveTodoFilePath, todoSessionScopeEnabled } = require('../../services/todoStorePath');
    if (!todoSessionScopeEnabled()) return TODO_FILE;
    let sessionId = null;
    try {
      const { getCurrentSessionId } = require('../../services/session/sessionForestService');
      sessionId = getCurrentSessionId();
    } catch { sessionId = null; }
    return resolveTodoFilePath({ tmpdir: os.tmpdir(), sessionId });
  } catch {
    return TODO_FILE;
  }
}

class TodoWriteTool extends BaseTool {
  static toolName = 'TodoWrite';
  static category = 'system';
  static risk = 'safe';
  static aliases = ['todo_write', 'update_todos'];
  static searchHint = 'manage session task checklist todo list';
  // Defer by default so the tool definition is fetched on demand (via toolSearch)
  // rather than always occupying weak-model context. Escape hatch:
  // KHY_TODOWRITE_ALWAYS_LOAD=1 always loads it (equivalent to the historical
  // always-present behavior) for setups that prefer eager availability.
  static get shouldDefer() {
    const v = process.env.KHY_TODOWRITE_ALWAYS_LOAD;
    if (v === '1' || v === 'true' || v === 'on' || v === 'yes') return false;
    return true;
  }

  isReadOnly() { return false; }
  isConcurrencySafe() { return false; }

  prompt() {
    return `Write and manage the session todo list. Use this to track progress on multi-step tasks.

	Each todo item has:
	- content: Description of the task
	- status: 'pending', 'in_progress', or 'completed'
	- priority: 'high', 'medium', or 'low' (optional)
	
	The todo list persists for the current session and helps track work progress.

	Tips:
	- Submit the complete updated list each time so the checklist stays in sync
	- Keep one major item in_progress at a time unless work is truly happening in parallel
	- Update item status immediately after each major step instead of batching updates at the end
	- If work is blocked, note the blocker explicitly in the item content rather than marking it completed`;
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          description: 'The complete updated todo list',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique identifier' },
              content: { type: 'string', description: 'Task description (imperative form, e.g. "Run tests")' },
              activeForm: { type: 'string', description: 'Present-continuous form shown in the spinner while this item is in_progress (e.g. "Running tests")' },
              status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
          },
        },
      },
      required: ['todos'],
    };
  }

  async execute(params) {
    const todos = params.todos || [];
    const todoFile = _resolveTodoFile();

    let oldTodos = [];
    try {
      if (fs.existsSync(todoFile)) {
        oldTodos = JSON.parse(fs.readFileSync(todoFile, 'utf-8'));
      }
    } catch { /* ignore */ }

    // If all done, clear
    const allDone = todos.every(t => t.status === 'completed');
    const newTodos = allDone ? [] : todos;

    fs.writeFileSync(todoFile, JSON.stringify(newTodos, null, 2), 'utf-8');

    return {
      success: true,
      oldTodos,
      newTodos,
      summary: `${newTodos.filter(t => t.status === 'completed').length}/${newTodos.length} completed`,
    };
  }

  getActivityDescription() { return '更新待办列表'; }

  /**
   * Render the persisted V1 todo list as a compact snapshot string.
   *
   * Consumed by the context-compaction pipeline (via _taskStore.snapshot)
   * so the planning checklist survives summarization — without this, V1 todos
   * are write-only and vanish from context after a compaction, reintroducing
   * the very attention-drift TodoWrite exists to prevent.
   *
   * @returns {string} One line per todo (✓/→/○ prefix), '' when no todos.
   */
  static snapshot() {
    let todos = [];
    try {
      const todoFile = _resolveTodoFile();
      if (fs.existsSync(todoFile)) {
        todos = JSON.parse(fs.readFileSync(todoFile, 'utf-8'));
      }
    } catch { return ''; }
    if (!Array.isArray(todos) || todos.length === 0) return '';
    return todos.map((t) => {
      const icon = t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '→' : '○';
      const prio = t.priority && t.priority !== 'medium' ? ` (${t.priority})` : '';
      // An in_progress item shows its present-continuous activeForm when set
      // (matching the spinner label); other states show the imperative content.
      const label = (t.status === 'in_progress' && t.activeForm)
        ? t.activeForm
        : (t.content || '(untitled)');
      return `${icon} ${label}${prio}`;
    }).join('\n');
  }
}

module.exports = TodoWriteTool;
