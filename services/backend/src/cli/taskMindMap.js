'use strict';

const DEFAULT_STEPS = [
  'Understand task',
  'Gather context',
  'Execute changes',
  'Verify result',
  'Summarize delivery',
];

const IDLE_TITLE = 'Start Node (No Active Task)';
const IDLE_STEPS = [
  'Start node',
  'Await task input',
  'Analyze intent',
  'Execute task chain',
  'Return to start node',
];

const STATUS_ICONS = {
  pending: '[ ]',
  running: '[>]',
  done: '[x]',
  error: '[!]',
};

// Lazy imports for colored rendering — avoid circular deps at parse time
let __chalk, __theme;
const _c = () => (__chalk ??= (require('chalk').default || require('chalk')));
const _theme = () => (__theme ??= require('./renderTheme'));

function _cleanText(text = '', maxLen = 120) {
  const oneLine = String(text || '').replace(/\s+/g, ' ').trim();
  if (!oneLine) return '';
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 3)}...` : oneLine;
}

function _dedupeSteps(steps = [], maxSteps = 8) {
  const out = [];
  const seen = new Set();
  for (const raw of steps) {
    const label = _cleanText(raw, 72);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= maxSteps) break;
  }
  return out;
}

function extractPlanStepsFromText(text = '', maxSteps = 8) {
  const src = String(text || '');
  if (!src.trim()) return [];
  const matches = [...src.matchAll(/(?:^|\n)\s*\d+[.、）)]\s*(.+)/g)];
  const steps = matches.map(m => _cleanText(m[1], 72)).filter(Boolean);
  return _dedupeSteps(steps, maxSteps);
}

function _toolCategory(toolName = '') {
  const n = String(toolName || '').toLowerCase().replace(/[\s_-]/g, '');
  if (/^(read|readfile|notebookread|grep|glob|find|findfiles|search|searchcontent|ls|websearch|webfetch|gitstatus|gitdiff|gitlog|explore)/.test(n)) {
    return 'context';
  }
  if (/^(write|writefile|createfile|edit|editfile|multiedit|notebookedit|bash|shell|shellcommand|command|agent|task|todowrite|scaffoldfiles|run|exec)/.test(n)) {
    return 'execute';
  }
  if (/^(test|pytest|jest|lint|verify|check|review|audit)/.test(n)) {
    return 'verify';
  }
  return 'execute';
}

class TaskMindMap {
  constructor({ title = '', steps = [], mode = 'active' } = {}) {
    this.title = _cleanText(title, 100) || 'Untitled task';
    this.mode = String(mode || 'active').toLowerCase() === 'idle' ? 'idle' : 'active';
    this.createdAt = Date.now();
    this.updatedAt = this.createdAt;
    this.iteration = 0;
    this.lastEvent = 'initialized';
    this.lastTool = null;
    this.currentIndex = -1;
    this.nextIndex = -1;
    this.steps = [];
    this.setPlanSteps(steps);
  }

  setPlanSteps(steps = []) {
    const picked = _dedupeSteps(steps, 8);
    const labels = picked.length >= 2 ? picked : DEFAULT_STEPS;
    this.steps = labels.map((label, idx) => ({
      id: idx + 1,
      label,
      status: 'pending',
      note: '',
    }));
    this.currentIndex = this.steps.length > 0 ? 0 : -1;
    this.nextIndex = this.steps.length > 1 ? 1 : -1;
    if (this.currentIndex >= 0) this.steps[this.currentIndex].status = 'running';
    this.updatedAt = Date.now();
    return this;
  }

  _markCurrent(index, note = '') {
    if (!Number.isInteger(index) || index < 0 || index >= this.steps.length) return;
    if (this.currentIndex >= 0 && this.currentIndex !== index) {
      const prev = this.steps[this.currentIndex];
      if (prev && prev.status === 'running') prev.status = 'done';
    }
    this.currentIndex = index;
    const curr = this.steps[index];
    if (curr.status !== 'done' && curr.status !== 'error') curr.status = 'running';
    if (note) curr.note = _cleanText(note, 96);

    this.nextIndex = -1;
    for (let i = index + 1; i < this.steps.length; i++) {
      if (this.steps[i].status === 'pending') {
        this.nextIndex = i;
        break;
      }
    }
    this.updatedAt = Date.now();
  }

  _markByCategory(category = '', note = '') {
    const last = Math.max(0, this.steps.length - 1);
    let target = this.currentIndex >= 0 ? this.currentIndex : 0;
    if (category === 'context' && this.steps.length > 1) target = 1;
    if (category === 'execute' && this.steps.length > 2) target = 2;
    if (category === 'verify' && this.steps.length > 3) target = 3;
    if (category === 'summary' && this.steps.length > 0) target = last;
    this._markCurrent(target, note);
  }

  markDecision(decision = {}) {
    const iteration = Number(decision.iteration || 0);
    if (iteration > 0) this.iteration = iteration;
    const mode = String(decision.mode || '').toLowerCase();
    const preview = _cleanText(decision.preview || '', 96);
    const tools = Array.isArray(decision.tools) ? decision.tools : [];

    if (mode === 'tool') {
      const firstTool = tools.length > 0 ? String(tools[0]) : '';
      this._markByCategory(_toolCategory(firstTool), preview || 'prepare tool call');
    } else {
      this._markByCategory('summary', preview || 'prepare final response');
    }
    this.lastEvent = 'decision';
    this.updatedAt = Date.now();
  }

  markToolCall(toolName = '', params = {}) {
    const category = _toolCategory(toolName);
    const target = _cleanText(
      params.path || params.file_path || params.filePath || params.pattern || params.query || params.q || params.command || '',
      80
    );
    this._markByCategory(category, target || `run ${toolName}`);
    this.lastTool = {
      name: String(toolName || ''),
      target,
      startedAt: Date.now(),
    };
    this.lastEvent = 'tool_call';
    this.updatedAt = Date.now();
  }

  markToolResult(toolName = '', success = true, detail = '') {
    const category = _toolCategory(toolName);
    if (this.currentIndex < 0) this._markByCategory(category);
    const current = this.currentIndex >= 0 ? this.steps[this.currentIndex] : null;
    if (current) {
      if (!success) {
        current.status = 'error';
      } else if (category === 'verify' || category === 'summary') {
        current.status = 'done';
      } else if (current.status === 'pending') {
        current.status = 'running';
      }
      if (detail) current.note = _cleanText(detail, 96);
    }
    if (this.currentIndex >= 0) {
      this.nextIndex = -1;
      for (let i = this.currentIndex + 1; i < this.steps.length; i++) {
        if (this.steps[i].status === 'pending') {
          this.nextIndex = i;
          break;
        }
      }
    }
    this.lastEvent = success ? 'tool_success' : 'tool_error';
    this.updatedAt = Date.now();
  }

  markIterationSummary(summary = {}) {
    const iteration = Number(summary.iteration || 0);
    if (iteration > 0) this.iteration = iteration;
    this.updatedAt = Date.now();
    this.lastEvent = 'iteration_summary';
  }

  complete({ success = true, reason = '' } = {}) {
    if (success) {
      if (this.currentIndex >= 0 && this.steps[this.currentIndex].status === 'running') {
        this.steps[this.currentIndex].status = 'done';
      }
      if (this.steps.length > 0) {
        this._markCurrent(this.steps.length - 1, reason || 'task completed');
        this.steps[this.currentIndex].status = 'done';
      }
    } else {
      if (this.currentIndex >= 0) {
        this.steps[this.currentIndex].status = 'error';
        if (reason) this.steps[this.currentIndex].note = _cleanText(reason, 96);
      }
    }
    this.nextIndex = -1;
    this.lastEvent = success ? 'completed' : 'failed';
    this.updatedAt = Date.now();
  }

  getCurrentStep() {
    return this.currentIndex >= 0 ? this.steps[this.currentIndex] : null;
  }

  getNextStep() {
    return this.nextIndex >= 0 ? this.steps[this.nextIndex] : null;
  }

  getProgress() {
    const done = this.steps.filter(step => step.status === 'done').length;
    const total = this.steps.length;
    return { done, total };
  }

  getCompactStatus() {
    const current = this.getCurrentStep();
    const next = this.getNextStep();
    const currentText = current ? `${current.id}. ${current.label}` : 'none';
    const nextText = next ? `${next.id}. ${next.label}` : 'none';
    return `Mode: ${this.mode} | Current: ${currentText} | Next: ${nextText}`;
  }

  buildAiSteerMessage() {
    const current = this.getCurrentStep();
    const next = this.getNextStep();
    const progress = this.getProgress();
    const lines = [
      '[Task Mind Map State]',
      `Task: ${this.title}`,
      `Mode: ${this.mode}`,
      `Current: ${current ? `${current.id}/${this.steps.length} ${current.label}` : 'none'}`,
      `Next: ${next ? `${next.id}/${this.steps.length} ${next.label}` : 'none'}`,
      `Progress: ${progress.done}/${progress.total} completed`,
    ];
    if (this.lastTool && this.lastTool.name) {
      lines.push(`Last Tool: ${this.lastTool.name}${this.lastTool.target ? ` (${this.lastTool.target})` : ''}`);
    }
    if (this.mode === 'idle') {
      lines.push('Rule: stay at start node until a concrete user task is provided.');
    } else {
      lines.push('Rule: continue from current step, avoid repeating completed steps.');
    }
    return lines.join('\n');
  }

  renderLines() {
    const lines = [];
    lines.push('Task Mind Map');
    lines.push(`Root: ${this.title}`);
    lines.push(`Mode: ${this.mode}`);
    this.steps.forEach((step, idx) => {
      const branch = idx === this.steps.length - 1 ? '└─' : '├─';
      const icon = STATUS_ICONS[step.status] || STATUS_ICONS.pending;
      const note = step.note ? ` · ${step.note}` : '';
      lines.push(`${branch} ${icon} ${step.id}. ${step.label}${note}`);
    });
    const current = this.getCurrentStep();
    const next = this.getNextStep();
    lines.push(`Current: ${current ? `${current.id}. ${current.label}` : 'none'}`);
    lines.push(`Next: ${next ? `${next.id}. ${next.label}` : 'none'}`);
    const progress = this.getProgress();
    lines.push(`Progress: ${progress.done}/${progress.total}`);
    return lines;
  }

  // ── Colored rendering methods ────────────────────────────────────────

  /**
   * Render a full colored task tree with progress bar and elapsed time.
   * Returns an array of chalk-colored strings ready for console output.
   */
  renderColored() {
    const c = _c();
    const {
      TASK_COMPLETED, TASK_IN_PROGRESS, TASK_PENDING,
      TREE_MID, TREE_LAST, _formatElapsed,
    } = _theme();

    const { done, total } = this.getProgress();
    const elapsed = (Date.now() - this.createdAt) / 1000;

    const lines = [];

    // Header: title + progress bar
    const barLen = 8;
    const filled = total > 0 ? Math.round((done / total) * barLen) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);
    lines.push(
      `  ${c.bold(this.title)}  ${c.dim('[')}${c.cyan(bar)}${c.dim(']')} ${c.white(`${done}/${total}`)} ${c.dim(`· ${_formatElapsed(elapsed)}`)}`
    );

    // Steps
    this.steps.forEach((step, idx) => {
      const isLast = idx === this.steps.length - 1;
      const branch = isLast ? TREE_LAST : TREE_MID;

      let icon, label;
      switch (step.status) {
        case 'done':
          icon = c.green(`[${TASK_COMPLETED}]`);
          label = c.strikethrough.dim(`${step.id}. ${step.label}`);
          break;
        case 'running':
          icon = c.yellow(`[${TASK_IN_PROGRESS}]`);
          label = c.bold.white(`${step.id}. ${step.label}`);
          break;
        case 'error':
          icon = c.red('[!]');
          label = c.red(`${step.id}. ${step.label}`);
          break;
        default:
          icon = c.dim(`[${TASK_PENDING}]`);
          label = c.dim(`${step.id}. ${step.label}`);
          break;
      }

      const note = step.note ? c.dim(` · ${step.note}`) : '';
      lines.push(`    ${c.dim(branch)} ${icon} ${label}${note}`);
    });

    return lines;
  }

  /**
   * Render a single-line compact summary for inline / collapsed display.
   * Format: ◆ Task Name [████░░] 3/7 · step 4: Execute changes · 12.3s
   */
  renderCompact() {
    const c = _c();
    const { _formatElapsed } = _theme();

    const { done, total } = this.getProgress();
    const elapsed = (Date.now() - this.createdAt) / 1000;
    const current = this.getCurrentStep();

    const barLen = 6;
    const filled = total > 0 ? Math.round((done / total) * barLen) : 0;
    const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled);

    const stepInfo = current
      ? `step ${current.id}: ${current.label}`
      : 'idle';

    return `${c.cyan('◆')} ${c.bold(this.title)} ${c.dim('[')}${c.cyan(bar)}${c.dim(']')} ${c.white(`${done}/${total}`)} ${c.dim('·')} ${c.white(stepInfo)} ${c.dim(`· ${_formatElapsed(elapsed)}`)}`;
  }

  /**
   * Render a single-line collapsed summary for post-completion display.
   * Format: ✓ Task Name — 7/7 completed in 45.2s
   */
  renderCollapsedSummary() {
    const c = _c();
    const { _formatElapsed } = _theme();

    const { done, total } = this.getProgress();
    const elapsed = (Date.now() - this.createdAt) / 1000;
    const hasError = this.steps.some(s => s.status === 'error');

    if (hasError) {
      const errCount = this.steps.filter(s => s.status === 'error').length;
      return `${c.red('✗')} ${c.bold(this.title)} ${c.dim('—')} ${c.white(`${done}/${total}`)} completed, ${c.red(`${errCount} failed`)} ${c.dim(`in ${_formatElapsed(elapsed)}`)}`;
    }

    return `${c.green('✓')} ${c.bold(this.title)} ${c.dim('—')} ${c.white(`${done}/${total}`)} completed ${c.dim(`in ${_formatElapsed(elapsed)}`)}`;
  }

  getSnapshot() {
    return {
      title: this.title,
      mode: this.mode,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      iteration: this.iteration,
      lastEvent: this.lastEvent,
      currentIndex: this.currentIndex,
      nextIndex: this.nextIndex,
      steps: this.steps.map(step => ({ ...step })),
      lastTool: this.lastTool ? { ...this.lastTool } : null,
      compact: this.getCompactStatus(),
    };
  }
}

function createTaskMindMap({ title = '', userInput = '', steps = [] } = {}) {
  const fromTitle = _cleanText(title, 100);
  const fromInput = _cleanText(userInput, 100);
  const mergedTitle = fromTitle || fromInput || 'Untitled task';
  const inferred = Array.isArray(steps) && steps.length > 0
    ? steps
    : extractPlanStepsFromText(userInput, 8);
  return new TaskMindMap({ title: mergedTitle, steps: inferred, mode: 'active' });
}

function createIdleTaskMindMap() {
  const map = new TaskMindMap({
    title: IDLE_TITLE,
    steps: IDLE_STEPS,
    mode: 'idle',
  });
  if (Array.isArray(map.steps) && map.steps[0]) {
    map.steps[0].note = 'No active task';
  }
  map.lastEvent = 'idle';
  map.updatedAt = Date.now();
  return map;
}

module.exports = {
  TaskMindMap,
  createTaskMindMap,
  createIdleTaskMindMap,
  extractPlanStepsFromText,
};
