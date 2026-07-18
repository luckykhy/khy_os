/**
 * Panel & Tracker components extracted from aiRenderer.js.
 *
 * Contains:
 *   - TaskPlanTracker   — task checklist with pending/in-progress/completed states
 *   - InitPhaseTracker  — init-phase line collector with collapse-to-summary
 *   - printExecutionBrief / collapseExecutionBrief — execution plan panel
 *   - printCompletionPanel — structured completion summary panel
 *   - printCollapseCounter — single-line collapse counter
 */
const {
  c, THEME,
  DOT_INDICATOR, DOT_SUCCESS, DOT_ERROR, DOT_DONE, DOT_PENDING,
  TASK_PENDING, TASK_IN_PROGRESS, TASK_COMPLETED,
  TREE_LAST, TREE_MID,
  _formatElapsed, getToolDisplayName,
} = require('./renderTheme');
const { displayWidth, padToWidth, truncateToWidth } = require('./formatters');

// ── Expandable outputs bridge ────────────────────────────────────────
// aiRenderer owns the canonical _expandableOutputs array.
// It calls setExpandableOutputs() after requiring this module so that
// InitPhaseTracker.collapse() and collapseExecutionBrief() can push entries.
let _expandableOutputs = [];

function setExpandableOutputs(arr) {
  if (Array.isArray(arr)) _expandableOutputs = arr;
}

// ── Task Plan Tracker (Claude Code style task list) ────────────────────

/**
 * TaskPlanTracker — displays and updates a task checklist.
 *
 * Usage:
 *   const plan = new TaskPlanTracker();
 *   plan.addTask('Fetch market data');
 *   plan.addTask('Run backtest');
 *   plan.addTask('Generate report');
 *   plan.render();          // show all tasks
 *   plan.start(0);          // mark first as in-progress -> re-render
 *   plan.complete(0);       // mark as done -> re-render
 */
class TaskPlanTracker {
  constructor(options = {}) {
    this._tasks = [];
    this._renderedLines = 0; // how many lines the last render() produced
    this._rewriteInPlace = options.rewriteInPlace !== false;
    this._panelMode = !!options.panelMode;
    this._panelState = null;
    if (this._panelMode) {
      try { this._panelState = require('./taskPanelState'); } catch { this._panelMode = false; }
    }
  }

  /**
   * Add a task to the plan.
   * @param {string} description
   * @returns {number} task index
   */
  addTask(description) {
    this._tasks.push({ description, status: 'pending' });
    if (this._panelMode && this._panelState) {
      this._panelState.setTasks(this._tasks);
    }
    return this._tasks.length - 1;
  }

  /**
   * Mark a task as in-progress.
   */
  start(index) {
    if (this._tasks[index]) {
      this._tasks[index].status = 'in_progress';
      if (this._panelMode && this._panelState) {
        this._panelState.updateTask(index, 'in_progress');
      }
      this._rerender(index);
    }
  }

  /**
   * Mark a task as completed.
   */
  complete(index) {
    if (this._tasks[index]) {
      this._tasks[index].status = 'completed';
      if (this._panelMode && this._panelState) {
        this._panelState.updateTask(index, 'completed');
        // All done -> delay clear so user sees the final state briefly
        if (this.allDone) {
          setTimeout(() => {
            try { this._panelState.clearTasks(); } catch { /* ignore */ }
          }, 800);
        }
      }
      this._rerender(index);
    }
  }

  /**
   * Mark a task as failed.
   */
  fail(index) {
    if (this._tasks[index]) {
      this._tasks[index].status = 'error';
      if (this._panelMode && this._panelState) {
        this._panelState.updateTask(index, 'error');
        if (this.allDone) {
          setTimeout(() => {
            try { this._panelState.clearTasks(); } catch { /* ignore */ }
          }, 800);
        }
      }
      this._rerender(index);
    }
  }

  /**
   * Get summary line.
   */
  getSummary() {
    const done = this._tasks.filter(t => t.status === 'completed').length;
    const inProgress = this._tasks.filter(t => t.status === 'in_progress').length;
    const open = this._tasks.filter(t => t.status === 'pending').length;
    const errored = this._tasks.filter(t => t.status === 'error').length;

    const parts = [];
    if (done > 0)       parts.push(`${done} 个已完成`);
    if (inProgress > 0) parts.push(`${inProgress} 个进行中`);
    if (open > 0)       parts.push(`${open} 个待处理`);
    if (errored > 0)    parts.push(`${errored} 个失败`);

    return `${this._tasks.length} 个任务（${parts.join('，')}）`;
  }

  /**
   * Render the full task list to stdout.
   */
  render() {
    if (process.stdout.isTTY) return;
    // panelMode: panel rendered by REPL layer, skip inline output
    if (this._panelMode) {
      if (this._panelState) this._panelState.renderPanel();
      return;
    }
    console.log('');
    console.log(c().dim(`  ${this.getSummary()}`));

    // Collapse completed tasks when >3 done — show "✔ 3 completed" on one line
    const done = this._tasks.filter(t => t.status === 'completed');
    const remaining = this._tasks.filter(t => t.status !== 'completed');
    let lineCount = 0;

    if (done.length > 3) {
      // Collapsed: single line for all completed tasks
      console.log(`    ${c().green(TASK_COMPLETED)} ${c().dim(`${done.length} 个步骤已完成`)}`);
      lineCount++;
    } else {
      for (const task of done) {
        console.log(`    ${c().green(TASK_COMPLETED)} ${c().strikethrough.dim(task.description)}`);
        lineCount++;
      }
    }

    for (const task of remaining) {
      let icon, color;
      switch (task.status) {
        case 'in_progress':
          icon = c().yellow(TASK_IN_PROGRESS);
          color = c().bold.white;
          break;
        case 'error':
          icon = c().red('✗');
          color = c().red;
          break;
        default:
          icon = c().dim(TASK_PENDING);
          color = c().white;
          break;
      }
      console.log(`    ${icon} ${color(task.description)}`);
      lineCount++;
    }
    this._renderedLines = lineCount + 2; // summary + blank + task lines
  }

  /**
   * Re-render by clearing previous output and printing again.
   */
  _rerender(changedIndex = -1) {
    if (process.stdout.isTTY) return;
    // panelMode: state updated via taskPanelState, REPL's console.log patch redraws
    if (this._panelMode) return;

    if (!this._rewriteInPlace) {
      const task = this._tasks[changedIndex];
      if (task) {
        let icon, color;
        switch (task.status) {
          case 'completed':
            icon = c().green(TASK_COMPLETED);
            color = c().dim;
            break;
          case 'in_progress':
            icon = c().yellow(TASK_IN_PROGRESS);
            color = c().white;
            break;
          case 'error':
            icon = c().red('✗');
            color = c().red;
            break;
          default:
            icon = c().dim(TASK_PENDING);
            color = c().white;
            break;
        }
        console.log(`  ${icon} [${changedIndex + 1}/${this._tasks.length}] ${color(task.description)}`);
        console.log(c().dim(`  ${this.getSummary()}`));
      } else {
        this.render();
      }
      return;
    }

    let _sw;
    try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
    if (typeof _sw !== 'function') _sw = (fn) => fn();
    _sw(() => {
      if (this._renderedLines > 0 && process.stdout.isTTY) {
        process.stdout.write('\x1b[1A\r\x1b[K'.repeat(this._renderedLines));
      }
      this.render();
    });
  }

  /**
   * Extract tasks from an AI response containing a numbered plan.
   * Looks for patterns like "1. xxx\n2. xxx\n3. xxx" under a heading.
   * @param {string} text - AI response text
   * @returns {boolean} true if tasks were extracted
   */
  extractFromResponse(text) {
    // Look for numbered items (Chinese or English)
    const planPattern = /(?:^|\n)\s*(\d+)[.、）)]\s*(.+)/g;
    const matches = [...text.matchAll(planPattern)];

    if (matches.length >= 2) {
      for (const m of matches) {
        this.addTask(m[2].trim().slice(0, 60));
      }
      return true;
    }
    return false;
  }

  /**
   * P1: Orchestration-driven plan — generate tasks from pending tool calls.
   * Called before tool execution begins. Each tool call becomes a task entry.
   *
   * @param {Array<{name: string, params: object}>} toolCalls - pending tool calls
   * @returns {boolean} true if tasks were generated
   */
  fromToolCalls(toolCalls) {
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) return false;
    // Only generate if no existing tasks (avoid overwriting text-extracted plan)
    if (this._tasks.length > 0) return false;

    const TOOL_LABELS = {
      Read: '读取文件', FileRead: '读取文件',
      Write: '写入文件', FileWrite: '写入文件',
      Edit: '编辑文件', FileEdit: '编辑文件',
      Bash: '执行命令', ShellCommand: '执行命令',
      Grep: '搜索内容', GrepTool: '搜索内容',
      Glob: '查找文件', GlobTool: '查找文件',
      WebSearch: '网络搜索', WebFetch: '获取网页',
      Agent: '子代理', SendMessage: '发送消息',
    };

    for (const call of toolCalls) {
      const name = call.name || '';
      const label = TOOL_LABELS[name] || name;
      const target = call.params?.file_path || call.params?.path || call.params?.pattern || call.params?.command || call.params?.query || '';
      const desc = target ? `${label}: ${String(target).slice(0, 40)}` : label;
      this.addTask(desc);
    }
    this.render();
    return true;
  }

  /**
   * P1: Auto-update task status from tool result.
   * Finds the first pending/in-progress task matching the tool name and updates it.
   *
   * @param {string} toolName - the tool that just completed
   * @param {boolean} success - whether the tool call succeeded
   * @returns {boolean} true if a task was updated
   */
  updateFromToolResult(toolName, success) {
    for (let i = 0; i < this._tasks.length; i++) {
      const t = this._tasks[i];
      if (t.status === 'pending' || t.status === 'in_progress') {
        // Match: task description starts with a label for this tool, or exact index order
        this.start(i);
        if (success) {
          this.complete(i);
        } else {
          this.fail(i);
        }
        return true;
      }
    }
    return false;
  }

  get length() { return this._tasks.length; }
  get allDone() { return this._tasks.every(t => t.status === 'completed' || t.status === 'error'); }
}

// ── Init Phase Tracker ───────────────────────────────────────────────

/**
 * InitPhaseTracker — tracks init-phase status lines and collapses them
 * into a single summary when the init phase ends.
 */
class InitPhaseTracker {
  constructor() {
    this._lines = 0;
    this._collapsed = false;
    this._plainLines = [];
  }
  /** Record one init-phase output line. */
  addLine(text) {
    if (this._collapsed) return;
    if (process.stdout.isTTY) { this._lines++; return; }
    console.log(text);
    this._lines++;
    // Store plain text for expandable output
    this._plainLines.push(String(text || '').replace(/\x1b\[[0-9;]*m/g, '').trim());
  }
  /** Collapse all tracked init lines into a single summary. */
  collapse(summaryText) {
    if (process.stdout.isTTY) { this._collapsed = true; return; }
    if (this._collapsed || this._lines <= 0 || !process.stdout.isTTY) {
      this._collapsed = true;
      return;
    }
    // Store for Ctrl+O expansion before clearing
    if (this._plainLines.length > 0) {
      _expandableOutputs.push({
        tool: '初始化',
        detail: this._plainLines.join('\n'),
        paramStr: `${this._plainLines.length} 步`,
      });
    }
    let _sw;
    try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
    if (typeof _sw !== 'function') _sw = (fn) => fn();
    _sw(() => {
      if (this._lines > 0) {
        process.stdout.write('\x1b[1A\r\x1b[K'.repeat(this._lines));
      }
      if (summaryText) {
        console.log(summaryText);
        this._lines = 1;
      } else {
        this._lines = 0;
      }
    });
    this._collapsed = true;
  }
  get lineCount() { return this._lines; }
  get isCollapsed() { return this._collapsed; }
}

// ── Execution Brief ──────────────────────────────────────────────────

/**
 * Print an execution brief panel before task execution begins.
 * Shows: user request, task analysis, planned steps, involved files.
 *
 * @param {object} opts
 * @param {string} opts.request - User's original request (truncated)
 * @param {string} [opts.analysis] - Task analysis text
 * @param {string} [opts.scale] - 'normal'|'large'
 * @param {string[]} [opts.steps] - Planned execution steps
 * @param {string[]} [opts.files] - Files likely involved
 * @param {boolean} [opts.decomposed] - Whether task was auto-decomposed
 * @param {number} [opts.subtaskCount] - Number of subtasks
 */
function printExecutionBrief(opts = {}) {
  if (process.stdout.isTTY) return { lineCount: 0, plainText: '' };
  const chalk = c();
  const maxW = Math.min((process.stdout.columns || 80) - 4, 72);
  const innerW = maxW - 4;
  const dim = chalk.dim;

  const lines = [];
  const addLine = (text) => {
    const w = displayWidth(text);
    const pad = Math.max(0, innerW - w);
    lines.push(dim('  │') + '  ' + text + ' '.repeat(pad) + dim('│'));
  };
  const addEmpty = () => {
    lines.push(dim('  │') + ' '.repeat(innerW + 2) + dim('│'));
  };
  const addSection = (label, content) => {
    const labelText = dim(label);
    if (Array.isArray(content)) {
      content.forEach((line, i) => {
        const prefix = i === 0 ? `  ${labelText}  ` : ' '.repeat(displayWidth(`  ${label}  `));
        addLine(`${prefix}${line}`);
      });
    } else {
      addLine(`  ${labelText}  ${content}`);
    }
  };

  // Title bar
  const titleText = ' ◆ 执行简报 ';
  const titleW = displayWidth(titleText);
  const dashCount = Math.max(0, maxW - titleW - 2);
  lines.push(dim('  ╭─') + chalk.hex('#D77757').bold(titleText) + dim('─'.repeat(dashCount) + '╮'));
  addEmpty();

  // Request
  if (opts.request) {
    const reqText = truncateToWidth(opts.request.replace(/\n/g, ' '), innerW - 10);
    addSection('需求', chalk.white(reqText));
    addEmpty();
  }

  // Analysis
  if (opts.analysis || opts.scale) {
    const parts = [];
    if (opts.analysis) parts.push(opts.analysis);
    if (opts.scale) parts.push(`任务规模: ${opts.scale}`);
    if (opts.decomposed) parts.push(`自动拆分为 ${opts.subtaskCount || '?'} 个子任务`);
    addSection('分析', parts);
    addEmpty();
  }

  // Steps
  if (opts.steps && opts.steps.length > 0) {
    const stepLines = opts.steps.slice(0, 8).map(s =>
      `${dim(TASK_PENDING)} ${chalk.white(truncateToWidth(s, innerW - 14))}`
    );
    if (opts.steps.length > 8) stepLines.push(`...+${opts.steps.length - 8} 步`);
    addSection('计划', stepLines);
    addEmpty();
  }

  // Files
  if (opts.files && opts.files.length > 0) {
    const fileText = opts.files.slice(0, 6).map(f =>
      chalk.cyan(require('path').basename(f))
    ).join(dim(' · '));
    const extra = opts.files.length > 6 ? dim(` +${opts.files.length - 6}`) : '';
    addSection('文件', fileText + extra);
    addEmpty();
  }

  // Bottom border
  lines.push(dim('  ╰' + '─'.repeat(maxW) + '╯'));

  console.log('');
  lines.forEach(l => console.log(l));
  console.log('');
  // Build plain-text version for expandable storage
  const plainParts = [];
  if (opts.request) plainParts.push(`需求: ${opts.request}`);
  if (opts.analysis) plainParts.push(`分析: ${opts.analysis}`);
  if (opts.scale) plainParts.push(`规模: ${opts.scale}`);
  if (opts.steps?.length > 0) plainParts.push(`计划:\n${opts.steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n')}`);
  if (opts.files?.length > 0) plainParts.push(`文件: ${opts.files.join(', ')}`);
  return { lineCount: lines.length + 2, plainText: plainParts.join('\n') };
}

/**
 * Collapse the execution brief panel into a single summary line.
 * Uses cursor-up to clear the previously rendered brief.
 * @param {number} renderedLines - Line count returned by printExecutionBrief
 * @param {object} [opts] - { scale, fileCount }
 */
function collapseExecutionBrief(renderedLines, opts = {}) {
  if (process.stdout.isTTY) return;
  if (!process.stdout.isTTY || renderedLines <= 0) return;
  // Store the brief content for Ctrl+O expansion before clearing
  if (opts.briefText) {
    _expandableOutputs.push({
      tool: '执行简报',
      detail: opts.briefText,
      paramStr: opts.scale || '',
    });
  }
  let _sw;
  try { _sw = require('./syncOutput').syncWrite; } catch { _sw = (fn) => fn(); }
  _sw(() => {
    if (renderedLines > 0) {
      process.stdout.write('\x1b[1A\r\x1b[K'.repeat(renderedLines));
    }
    const parts = [];
    if (opts.scale) parts.push(opts.scale);
    if (opts.fileCount > 0) parts.push(`${opts.fileCount} 文件`);
    const summary = parts.length > 0 ? ` (${parts.join(' · ')})` : '';
    console.log(c().dim(`  ◆ 执行简报${summary}  (ctrl+o 展开)`));
  });
}

// ── Completion Panel ─────────────────────────────────────────────────

/**
 * Print a structured completion summary panel after tool loop finishes.
 *
 * @param {object} opts
 * @param {boolean} opts.success
 * @param {number}  opts.iterations
 * @param {number}  opts.totalCalls
 * @param {number}  opts.succeeded
 * @param {string}  opts.elapsed - e.g. "8.3s"
 * @param {Array}   opts.fileChanges - [{ path, operation, diff }]
 * @param {Array}   opts.commands - [{ cmd, success }]
 * @param {number}  opts.searches
 * @param {number}  opts.reads
 */
function printCompletionPanel(opts = {}) {
  if (process.stdout.isTTY) return;
  const chalk = c();
  const maxW = Math.min((process.stdout.columns || 80) - 4, 68);
  const innerW = maxW - 4; // 2 border + 2 padding
  const dim = chalk.dim;
  const pathLib = require('path');

  const lines = [];
  const addLine = (text) => {
    const w = displayWidth(text);
    const pad = Math.max(0, innerW - w);
    lines.push(dim('  │') + '  ' + text + ' '.repeat(pad) + dim('│'));
  };
  const addEmpty = () => {
    lines.push(dim('  │') + ' '.repeat(innerW + 2) + dim('│'));
  };

  // Title bar
  const icon = opts.success !== false ? '✓' : '⚠';
  const iconColor = opts.success !== false ? chalk.hex('#4EBA65') : chalk.hex('#FFC107');
  const titleText = ` ${icon} 任务完成 `;
  const titleW = displayWidth(titleText);
  const dashCount = Math.max(0, maxW - titleW - 2);
  lines.push(dim('  ╭─') + iconColor.bold(titleText) + dim('─'.repeat(dashCount) + '╮'));
  addEmpty();

  // File changes
  const fc = opts.fileChanges || [];
  if (fc.length > 0) {
    const creates = fc.filter(f => f.operation === 'create' || f.operation === 'scaffold');
    const modifies = fc.filter(f => f.operation === 'modify');
    const renames = fc.filter(f => f.operation === 'rename');
    const moves = fc.filter(f => f.operation === 'move');
    const deletes = fc.filter(f => f.operation === 'delete');
    if (modifies.length > 0) {
      const label = chalk.dim('改动');
      for (let i = 0; i < Math.min(modifies.length, 6); i++) {
        const prefix = i === 0 ? `  ${label}  ` : '        ';
        const fname = truncateToWidth(pathLib.basename(modifies[i].path), 30);
        const diff = modifies[i].diff ? chalk.dim(` (${modifies[i].diff})`) : '';
        addLine(`${prefix}${chalk.cyan(fname)}${diff}`);
      }
      if (modifies.length > 6) addLine(`        ${chalk.dim(`...+${modifies.length - 6} 个文件`)}`);
    }
    if (creates.length > 0) {
      const label = chalk.dim('新建');
      for (let i = 0; i < Math.min(creates.length, 4); i++) {
        const prefix = i === 0 ? `  ${label}  ` : '        ';
        const fname = truncateToWidth(pathLib.basename(creates[i].path), 30);
        const diff = creates[i].diff ? chalk.dim(` (${creates[i].diff})`) : '';
        addLine(`${prefix}${chalk.hex('#4EBA65')(fname)}${diff}`);
      }
      if (creates.length > 4) addLine(`        ${chalk.dim(`...+${creates.length - 4} 个文件`)}`);
    }
    if (renames.length > 0) {
      const label = chalk.dim('重命名');
      for (let i = 0; i < Math.min(renames.length, 4); i++) {
        const prefix = i === 0 ? `  ${label}` + ' ' : '        ';
        const fromName = pathLib.basename(renames[i].fromPath || renames[i].path || '');
        const toName = pathLib.basename(renames[i].toPath || renames[i].path || '');
        const text = truncateToWidth(`${fromName} → ${toName}`, 36);
        addLine(`${prefix}${chalk.hex('#FFC107')(text)}`);
      }
      if (renames.length > 4) addLine(`        ${chalk.dim(`...+${renames.length - 4} 个文件`)}`);
    }
    if (moves.length > 0) {
      const label = chalk.dim('移动');
      for (let i = 0; i < Math.min(moves.length, 4); i++) {
        const prefix = i === 0 ? `  ${label}` + ' ' : '        ';
        const fromName = pathLib.basename(moves[i].fromPath || moves[i].path || '');
        const toName = pathLib.basename(moves[i].toPath || moves[i].path || '');
        const text = truncateToWidth(`${fromName} → ${toName}`, 36);
        addLine(`${prefix}${chalk.hex('#4DB6FF')(text)}`);
      }
      if (moves.length > 4) addLine(`        ${chalk.dim(`...+${moves.length - 4} 个文件`)}`);
    }
    if (deletes.length > 0) {
      const label = chalk.dim('删除');
      for (let i = 0; i < Math.min(deletes.length, 4); i++) {
        const prefix = i === 0 ? `  ${label}  ` : '        ';
        const fname = truncateToWidth(pathLib.basename(deletes[i].path || deletes[i].fromPath || ''), 30);
        const diff = deletes[i].diff ? chalk.dim(` (${deletes[i].diff})`) : '';
        addLine(`${prefix}${chalk.hex('#FF6B80')(fname)}${diff}`);
      }
      if (deletes.length > 4) addLine(`        ${chalk.dim(`...+${deletes.length - 4} 个文件`)}`);
    }
  } else if ((opts.totalCalls || 0) > 0) {
    // Tools were called but no files created/modified
    addLine(`  ${chalk.dim('文件')}  ${chalk.hex('#FFD700').bold('未发生文件变更')}`);
  }

  // Commands
  const cmds = opts.commands || [];
  if (cmds.length > 0) {
    const label = chalk.dim('命令');
    const cmdTexts = cmds.slice(0, 3).map(cmd =>
      truncateToWidth(typeof cmd === 'string' ? cmd : cmd.cmd || '', 25)
    );
    addLine(`  ${label}  ${cmdTexts.join(chalk.dim(' · '))}`);
    if (cmds.length > 3) addLine(`        ...+${cmds.length - 3} 条命令`);
  }

  // Summary (optional enrichment) — accepts string or string[]
  const summaryLines = Array.isArray(opts.summary) ? opts.summary
    : typeof opts.summary === 'string' ? opts.summary.split('\n')
    : [];
  if (summaryLines.length > 0) {
    addEmpty();
    const label = chalk.dim('摘要');
    summaryLines.slice(0, 4).forEach((line, i) => {
      const prefix = i === 0 ? `  ${label}  ` : '        ';
      addLine(`${prefix}${chalk.white(truncateToWidth(line, innerW - 10))}`);
    });
  }

  // Subtask report (when auto-decomposed)
  if (opts.subtaskReport && opts.subtaskReport.total > 0) {
    addEmpty();
    const sr = opts.subtaskReport;
    const srParts = [`${sr.succeeded}/${sr.total} 子任务完成`];
    if (sr.failed > 0) srParts.push(chalk.hex('#FF6B80')(`${sr.failed} 失败`));
    addLine(`  ${chalk.dim('子任务')}  ${srParts.join(chalk.dim(' · '))}`);
  }

  addEmpty();

  // Statistics line
  const statParts = [];
  if (opts.iterations > 0) statParts.push(`${opts.iterations} 轮`);
  if (opts.totalCalls > 0) statParts.push(`${opts.totalCalls} 次调用`);
  if (opts.totalCalls > 0) {
    const ratio = `${opts.succeeded || 0}/${opts.totalCalls}`;
    statParts.push(`${ratio} 成功`);
  }
  if (opts.elapsed) statParts.push(opts.elapsed);
  if (statParts.length > 0) {
    addLine(chalk.dim(`  ${statParts.join(' · ')}`));
  }

  // Bottom border
  lines.push(dim('  ╰' + '─'.repeat(maxW) + '╯'));

  console.log('');
  lines.forEach(l => console.log(l));
  console.log('');
}

// ── Collapse Counter ─────────────────────────────────────────────────

/**
 * Overwrite the previous line with a collapse counter summary.
 * On non-TTY, just prints a new line.
 *
 * @param {string} summary - e.g. "搜索 3 次，读取 5 个文件"
 */
function printCollapseCounter(summary) {
  if (process.stdout.isTTY) return;
  const chalk = c();
  const line = `  ${chalk.dim('○')} ${chalk.dim(summary)} ${chalk.dim('(ctrl+o 展开)')}`;
  if (process.stdout.isTTY) {
    let _sw;
    try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
    if (typeof _sw !== 'function') _sw = (fn) => fn();
    _sw(() => {
      process.stdout.write('\x1b[1A\x1b[2K');
      console.log(line);
    });
  } else {
    console.log(line);
  }
}

module.exports = {
  TaskPlanTracker,
  InitPhaseTracker,
  printExecutionBrief,
  collapseExecutionBrief,
  printCompletionPanel,
  printCollapseCounter,
  setExpandableOutputs,
};
