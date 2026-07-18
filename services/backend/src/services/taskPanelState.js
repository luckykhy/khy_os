'use strict';

/**
 * taskPanelState.js — Shared singleton for task progress panel.
 *
 * Decouples planModeService (which writes state) from the REPL layer
 * (which reads and renders the panel above the input prompt).
 *
 * renderPanel() writes directly to process.stdout to avoid recursion
 * through the console.log monkey-patch in repl.js.
 */

let _chalk;
const c = () => (_chalk ??= (require('chalk').default || require('chalk')));

// ── State ──

let _tasks = null;     // null = no panel, Array<{description, status}> = show panel
let _listener = null;  // single onChange callback (REPL layer)

// ── Public API ──

/**
 * Set the task list (called when plan execution begins).
 * @param {Array<{description: string, status: string}>} tasks
 */
function setTasks(tasks) {
  _tasks = tasks.map(t => ({ description: t.description, status: t.status || 'pending' }));
  _notify();
}

/**
 * Update a single task's status.
 * @param {number} index
 * @param {string} status - 'pending' | 'in_progress' | 'completed' | 'error'
 */
function updateTask(index, status) {
  if (!_tasks || !_tasks[index]) return;
  _tasks[index].status = status;
  _notify();
}

/**
 * Clear the task panel (called when plan execution ends).
 */
function clearTasks() {
  _tasks = null;
  _notify();
}

/**
 * Get the current task list, or null if no panel is active.
 * @returns {Array<{description: string, status: string}>|null}
 */
function getTasks() {
  return _tasks;
}

/**
 * Register a change listener (only one — the REPL layer).
 * @param {Function} fn
 */
function onChange(fn) {
  _listener = fn;
}

function _notify() {
  if (typeof _listener === 'function') {
    try { _listener(); } catch { /* best effort */ }
  }
}

// ── Rendering ──

/**
 * Render the task panel to stdout.
 * Uses process.stdout.write directly to avoid console.log recursion.
 */
function renderPanel() {
  if (!_tasks || _tasks.length === 0) return;
  if (!process.stdout.isTTY) return;
  if (process.stdout.isTTY) return;

  const width = Math.min(process.stdout.columns || 80, 120);
  const done = _tasks.filter(t => t.status === 'completed').length;
  const errored = _tasks.filter(t => t.status === 'error').length;
  const total = _tasks.length;

  // Title rule: ─ 计划进度 2/5 ────────
  const titleText = ` 计划进度 ${done + errored}/${total} `;
  const ruleLen = Math.max(0, width - titleText.length - 4);
  const ruleLeft = '─';
  const ruleRight = '─'.repeat(Math.max(1, ruleLen));
  const titleLine = c().dim(`  ${ruleLeft}${titleText}${ruleRight}`);

  let out = titleLine + '\n';

  for (const task of _tasks) {
    // Truncate description to fit terminal width (leave room for icon + indent)
    const maxDescLen = Math.max(10, width - 6);
    const desc = task.description.length > maxDescLen
      ? task.description.slice(0, maxDescLen - 1) + '…'
      : task.description;

    switch (task.status) {
      case 'completed':
        out += `  ${c().green('✔')} ${c().strikethrough.dim(desc)}\n`;
        break;
      case 'in_progress':
        out += `  ${c().yellow('■')} ${c().bold.white(desc)}\n`;
        break;
      case 'error':
        out += `  ${c().red('✗')} ${c().red(desc)}\n`;
        break;
      default: // pending
        out += `  ${c().dim('☐')} ${c().white(desc)}\n`;
        break;
    }
  }

  process.stdout.write(out);
}

module.exports = {
  setTasks,
  updateTask,
  clearTasks,
  getTasks,
  onChange,
  renderPanel,
};
