/**
 * Permission Dialog — Claude Code-style approval prompt.
 *
 * Matches Claude Code's exact visual style:
 *   - Purple "Bash command" / "Write" / "Edit" header
 *   - Indented command/file content
 *   - Gray description
 *   - Yellow warning for risky operations
 *   - "Do you want to proceed?" with numbered choices
 *   - "Esc to cancel · ctrl+e to explain"
 */
const chalk = require('chalk').default || require('chalk');
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const { foldOutput } = require('../toolDisplayPolicy');

// ── Claude Code theme colors ───────────────────────────────────────

const PURPLE = '#B388FF';   // Claude Code permission purple
const WARN_YELLOW = '#FFC107';

// Map tool names to Claude Code display labels
const TOOL_TYPE_LABELS = {
  shell_command: 'Bash command',
  shellCommand:  'Bash command',
  bash:          'Bash command',
  command:       'Bash command',
  write_file:    'Write',
  writeFile:     'Write',
  write:         'Write',
  edit_file:     'Update',
  editFile:      'Update',
  edit:          'Update',
  multiedit:     'Update',
  read_file:     'Read',
  readFile:      'Read',
  read:          'Read',
  notebookRead:  'Read',
  notebookread:  'Read',
  glob:          'Search',
  grep:          'Search',
  find:          'Search',
  ls:            'Search',
  webFetch:      'Fetch',
  webfetch:      'Fetch',
  todoWrite:     'Todo',
  todowrite:     'Todo',
  agent:         'Agent',
  task:          'Agent',
  notebookEdit:  'Update',
  notebookedit:  'Update',
  scaffoldFiles: 'Scaffold',
  scaffoldfiles: 'Scaffold',
  scaffold_files:'Scaffold',
};

// Risk warnings (Claude Code shows these in yellow)
const RISK_WARNINGS = {
  critical: 'Shell expansion syntax in paths requires manual approval',
  high:     'File modification requires approval',
  medium:   'This action requires approval',
};

// ── ANSI-safe width measurement ─────────────────────────────────────

// 收敛到 utils/stripAnsi 单一真源(逐字节委托,调用点不变)
const stripAnsi = require('../../utils/stripAnsi');

function displayWidth(str) {
  const clean = stripAnsi(str);
  let width = 0;
  for (const ch of clean) {
    const code = ch.codePointAt(0);
    if ((code >= 0x1100 && code <= 0x115F) ||
        (code >= 0x2E80 && code <= 0xA4CF) ||
        (code >= 0xAC00 && code <= 0xD7AF) ||
        (code >= 0xF900 && code <= 0xFAFF) ||
        (code >= 0xFE10 && code <= 0xFE6F) ||
        (code >= 0xFF01 && code <= 0xFF60) ||
        (code >= 0xFFE0 && code <= 0xFFE6) ||
        (code >= 0x20000 && code <= 0x2FA1F)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

function padRight(str, targetWidth) {
  const current = displayWidth(str);
  const needed = Math.max(0, targetWidth - current);
  return str + ' '.repeat(needed);
}

function normalizeChoiceInput(input) {
  return String(input || '').trim().toLowerCase();
}

function compactChoiceInput(input) {
  return normalizeChoiceInput(input).replace(/[\s_-]+/g, '');
}

function resolveChoiceIndex(input, choices, defaultIndex = -1) {
  const normalized = normalizeChoiceInput(input);
  if (!normalized) return defaultIndex;

  const numeric = Number.parseInt(normalized, 10);
  if (!Number.isNaN(numeric) && String(numeric) === normalized) {
    const idx = numeric - 1;
    if (idx >= 0 && idx < choices.length) return idx;
  }

  const compact = compactChoiceInput(normalized);
  for (let i = 0; i < choices.length; i += 1) {
    const aliases = choices[i].aliases || [];
    for (const alias of aliases) {
      if (normalized === normalizeChoiceInput(alias) || compact === compactChoiceInput(alias)) {
        return i;
      }
    }
  }

  // Semantic fallback (SSOT, gated): natural-language affirmatives/negatives the
  // literal aliases miss — CJK 好/可以/同意/允许, English approve/ok/sure — get
  // mapped to a representative alias present in BOTH the regular and batch choice
  // lists (allow→'yes', allow-always→'always', deny→'no'). Fail-soft + gate-off
  // → null → skip → original `return -1` byte-fallback.
  try {
    const { classifyPermissionReply } = require('../permissionReply');
    const decision = classifyPermissionReply(input);
    if (decision) {
      const want = decision === 'allow-always' ? 'always' : (decision === 'deny' ? 'no' : 'yes');
      for (let i = 0; i < choices.length; i += 1) {
        const aliases = (choices[i].aliases || []).map(normalizeChoiceInput);
        if (aliases.includes(want)) return i;
      }
    }
  } catch { /* leaf unavailable → byte-fallback to -1 */ }

  return -1;
}

// ── Get project name for "allow from this project" option ───────────

function getProjectName() {
  try {
    const cwd = process.env.KHYQUANT_CWD || process.cwd();
    return path.basename(cwd) + '/';
  } catch {
    return 'this project';
  }
}

// ── Raw input helper ────────────────────────────────────────────────

async function promptRawInputWithProvider(promptText) {
  const toolCalling = require('../../services/toolCalling');
  const provider = toolCalling.getReadlineProvider();
  const providedRl = provider
    ? (typeof provider === 'function' ? provider() : provider)
    : null;

  if (providedRl && typeof providedRl.question === 'function') {
    return new Promise((resolve) => {
      providedRl.question(promptText, resolve);
    });
  }

  return new Promise((resolve) => {
    const tempRl = readline.createInterface({ input: process.stdin, output: process.stdout });
    tempRl.question(promptText, (ans) => {
      tempRl.close();
      resolve(ans);
    });
  });
}

// ── Arrow-key menu (Claude Code style) ──────────────────────────────

async function promptChoiceMenu(title, choices, options = {}) {
  const {
    defaultIndex = 0,
    cancelValue = choices[choices.length - 1]?.value,
    footerHint = 'Esc to cancel \u00B7 ctrl+e to explain',
  } = options;

  const stdin = process.stdin;
  const stdout = process.stdout;
  const canUseArrowMenu =
    Boolean(stdin && stdout && stdin.isTTY && stdout.isTTY && typeof stdin.setRawMode === 'function');

  if (!canUseArrowMenu) {
    const answer = await promptRawInputWithProvider(chalk.dim('  > '));
    const idx = resolveChoiceIndex(answer, choices, defaultIndex);
    return idx >= 0 ? choices[idx].value : cancelValue;
  }

  const toolCalling = require('../../services/toolCalling');
  const provider = toolCalling.getReadlineProvider();
  const rl = provider
    ? (typeof provider === 'function' ? provider() : provider)
    : null;

  return new Promise((resolve) => {
    let selected = Math.min(Math.max(defaultIndex, 0), choices.length - 1);
    let typed = '';
    let error = '';
    let renderedLines = 0;
    const wasRawMode = Boolean(stdin.isRaw);

    const cleanup = (resultValue) => {
      stdin.removeListener('data', onData);
      // Restore raw mode BEFORE resuming readline
      if (typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch { /* ignore */ }
      }
      // Clear the rendered menu
      if (renderedLines > 0) {
        try { readline.moveCursor(stdout, 0, -renderedLines); } catch { /* ignore */ }
        try { readline.cursorTo(stdout, 0); } catch { /* ignore */ }
        try { readline.clearScreenDown(stdout); } catch { /* ignore */ }
      }
      // Print the selected choice so user sees what was picked
      if (resultValue !== cancelValue) {
        const picked = choices.find(c => c.value === resultValue);
        if (picked) {
          console.log(`  ${chalk.green('✓')} ${picked.label}`);
        }
      }
      // Ensure stdin is flowing for the REPL readline
      try { stdin.resume(); } catch { /* ignore */ }
      if (rl && typeof rl.resume === 'function') {
        try { rl.resume(); } catch { /* ignore */ }
      }
      resolve(resultValue);
    };

    const render = () => {
      if (renderedLines > 0) {
        try { readline.moveCursor(stdout, 0, -renderedLines); } catch { /* ignore */ }
        try { readline.cursorTo(stdout, 0); } catch { /* ignore */ }
        try { readline.clearScreenDown(stdout); } catch { /* ignore */ }
      }

      const lines = [];
      // Claude Code style: "Do you want to proceed?"
      lines.push(`  ${chalk.bold(title)}`);
      for (let i = 0; i < choices.length; i += 1) {
        const marker = i === selected ? chalk.hex(PURPLE)('\u276F') : ' ';
        const num = `${i + 1}.`;
        const label = i === selected ? chalk.bold(choices[i].label) : choices[i].label;
        lines.push(`   ${marker} ${num} ${label}`);
      }
      lines.push('');
      // Claude Code: "Esc to cancel · ctrl+e to explain"
      lines.push(`  ${chalk.dim(footerHint)}`);
      if (error) lines.push(`  ${chalk.red(error)}`);

      stdout.write(`${lines.join('\n')}\n`);
      renderedLines = lines.length;
    };

    const onData = (chunk) => {
      const key = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);

      // Ctrl+C or Esc → cancel (deny)
      if (key === '\u0003' || key === '\u001b') {
        cleanup(cancelValue);
        return;
      }

      // Ctrl+E → explain (show AI reasoning)
      if (key === '\u0005') {
        // For now, treat ctrl+e as a hint to show explanation
        // Could integrate with AI to explain the tool call
        error = 'Explanation: AI wants to run this tool to complete your request.';
        render();
        return;
      }

      // Arrow up
      if (key === '\u001b[A') {
        selected = (selected - 1 + choices.length) % choices.length;
        error = '';
        render();
        return;
      }

      // Arrow down
      if (key === '\u001b[B') {
        selected = (selected + 1) % choices.length;
        error = '';
        render();
        return;
      }

      // Tab → cycle
      if (key === '\t') {
        selected = (selected + 1) % choices.length;
        error = '';
        render();
        return;
      }

      // Enter → confirm selection
      if (key === '\r' || key === '\n') {
        const idx = typed ? resolveChoiceIndex(typed, choices, -1) : selected;
        if (idx >= 0) {
          cleanup(choices[idx].value);
        } else {
          typed = '';
          error = 'Unrecognized input, please use arrow keys or type 1/2/3.';
          render();
        }
        return;
      }

      // Backspace
      if (key === '\u007f' || key === '\b' || key === '\x08') {
        typed = typed.slice(0, -1);
        error = '';
        render();
        return;
      }

      // Printable character. Gate ON broadens capture to multi-byte CJK input
      // (excluding control bytes) so typed Chinese affirmatives reach `typed`
      // and resolveChoiceIndex's semantic fallback; gate OFF keeps the original
      // ASCII-only single-char condition (byte-fallback). Escape/arrow chunks
      // start with ESC (0x1b) and are already handled+returned above.
      let _printable;
      try {
        const { permissionReplyEnabled } = require('../permissionReply');
        _printable = permissionReplyEnabled()
          ? (!!key && !/[\u0000-\u001f\u007f]/.test(key))
          : (key.length === 1 && key >= ' ' && key <= '~');
      } catch {
        _printable = (key.length === 1 && key >= ' ' && key <= '~');
      }
      if (_printable) {
        typed += key;
        error = '';

        // Fast path: single digit picks directly
        if (/^[1-9]$/.test(typed)) {
          const idx = resolveChoiceIndex(typed, choices, -1);
          if (idx >= 0) {
            cleanup(choices[idx].value);
            return;
          }
        }

        render();
      }
    };

    if (rl && typeof rl.pause === 'function') {
      try { rl.pause(); } catch { /* ignore */ }
    }
    try { stdin.resume(); } catch { /* ignore */ }
    try { stdin.setRawMode(true); } catch { /* ignore */ }
    stdin.on('data', onData);
    render();
  });
}

// ── Claude Code-style permission display ────────────────────────────

/**
 * Format tool parameters for display.
 * Claude Code shows:
 *   Bash: command text indented
 *   Write/Edit: file path
 *   Read: file path
 */
function formatToolContent(toolName, params) {
  const name = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
  const lines = [];

  if (name === 'shellcommand' || name === 'bash' || name === 'command') {
    const cmd = params?.command || params?.cmd || '';
    // Indented command display
    lines.push('');
    lines.push(`    ${chalk.white(cmd)}`);
    // Description
    if (params?.description) {
      lines.push(`    ${chalk.dim(params.description)}`);
    }
  } else if (name === 'writefile' || name === 'write') {
    const filePath = params?.file_path || params?.filePath || params?.path || '';
    lines.push('');
    lines.push(`    ${chalk.white(filePath)}`);
    if (params?.content) {
      const contentLines = params.content.split('\n');
      const { lines: foldedContent } = foldOutput(contentLines, { maxLines: 5, foldHead: 5, foldTail: 0 });
      for (const l of foldedContent) {
        lines.push(`    ${chalk.dim(l.slice(0, 80))}`);
      }
    }
  } else if (name === 'editfile' || name === 'edit' || name === 'multiedit') {
    const filePath = params?.file_path || params?.filePath || params?.path || '';
    lines.push('');
    lines.push(`    ${chalk.white(filePath)}`);
    // G5: diff 预览 — 显示红/绿对比
    if (params?.old_string && params?.new_string) {
      lines.push('');
      const rawOldLines = params.old_string.split('\n');
      const rawNewLines = params.new_string.split('\n');
      const { lines: foldedOld } = foldOutput(rawOldLines, { maxLines: 6, foldHead: 6, foldTail: 0 });
      const { lines: foldedNew } = foldOutput(rawNewLines, { maxLines: 6, foldHead: 6, foldTail: 0 });
      for (const l of foldedOld) {
        lines.push(`    ${chalk.red('- ' + l.slice(0, 76))}`);
      }
      for (const l of foldedNew) {
        lines.push(`    ${chalk.green('+ ' + l.slice(0, 76))}`);
      }
    } else {
      if (params?.old_string) {
        lines.push(`    ${chalk.dim('old: ' + params.old_string.slice(0, 60))}`);
      }
      if (params?.new_string) {
        lines.push(`    ${chalk.dim('new: ' + params.new_string.slice(0, 60))}`);
      }
    }
  } else if (name === 'readfile' || name === 'read') {
    const filePath = params?.file_path || params?.filePath || params?.path || '';
    lines.push('');
    lines.push(`    ${chalk.white(filePath)}`);
  } else {
    // Generic: show key=value pairs
    if (params && typeof params === 'object') {
      lines.push('');
      for (const [k, v] of Object.entries(params).slice(0, 5)) {
        if (k.startsWith('_')) continue;
        const val = typeof v === 'string'
          ? (v.length > 60 ? v.slice(0, 57) + '...' : v)
          : JSON.stringify(v).slice(0, 60);
        lines.push(`    ${chalk.dim(k)}: ${chalk.white(val)}`);
      }
    }
  }

  return lines;
}

// ── Risk display ────────────────────────────────────────────────────

const RISK_STYLES = {
  safe:     { color: chalk.green,      badge: chalk.bgGreen.black(' SAFE ') },
  low:      { color: chalk.cyan,       badge: chalk.bgCyan.black(' LOW ') },
  medium:   { color: chalk.yellow,     badge: chalk.bgYellow.black(' MEDIUM ') },
  high:     { color: chalk.red,        badge: chalk.bgRed.white(' HIGH ') },
  critical: { color: chalk.redBright,  badge: chalk.bgRedBright.white(' CRITICAL ') },
};

// ── Compact diff preview for permission dialogs ────────────────────

const MAX_DIFF_PREVIEW_LINES = 10;

/**
 * Render a compact inline diff preview (≤10 lines) inside a dimmed box.
 * Used by formatPermissionDialog to show what will change before approval.
 *
 * @param {{ oldContent: string, newContent: string, filePath?: string }} diffInfo
 * @returns {string[]} Array of formatted lines to print, or empty if diff unavailable
 */
function renderCompactDiffPreview(diffInfo) {
  try {
    if (!diffInfo || typeof diffInfo !== 'object') return [];
    const { oldContent, newContent } = diffInfo;
    if (typeof oldContent !== 'string' || typeof newContent !== 'string') return [];
    if (oldContent === newContent) return [];

    const { computeDiff } = require('./diffViewer');
    const changes = computeDiff(oldContent, newContent);
    if (!changes || changes.length === 0) return [];

    // Filter to only changed lines (add/remove), keep a few context lines around them
    const changedIndices = new Set();
    for (let i = 0; i < changes.length; i++) {
      if (changes[i].type === 'add' || changes[i].type === 'remove') {
        // Include 1 context line before and after each change
        for (let j = Math.max(0, i - 1); j <= Math.min(changes.length - 1, i + 1); j++) {
          changedIndices.add(j);
        }
      }
    }

    if (changedIndices.size === 0) return [];

    const relevantIndices = Array.from(changedIndices).sort((a, b) => a - b);
    const cols = Math.min((process.stdout.columns || 80) - 10, 72);

    // Build all relevant diff lines, then fold
    const allDiffLines = relevantIndices.map(idx => {
      const entry = changes[idx];
      const text = (entry.content || '').slice(0, cols);
      switch (entry.type) {
        case 'remove': return chalk.red(`    │ - ${text}`);
        case 'add':    return chalk.green(`    │ + ${text}`);
        default:       return chalk.dim(`    │   ${text}`);
      }
    });

    const { lines: diffLines } = foldOutput(allDiffLines, { maxLines: MAX_DIFF_PREVIEW_LINES, foldHead: 6, foldTail: 4 });

    // Frame with dimmed box borders
    const output = [];
    output.push(chalk.dim('    ╭─ diff preview'));
    for (const line of diffLines) {
      output.push(line);
    }

    // Summary stats
    let additions = 0;
    let removals = 0;
    for (const c of changes) {
      if (c.type === 'add') additions++;
      else if (c.type === 'remove') removals++;
    }
    const statParts = [];
    if (additions > 0) statParts.push(chalk.green(`+${additions}`));
    if (removals > 0) statParts.push(chalk.red(`-${removals}`));
    const stats = statParts.length > 0 ? ` (${statParts.join(', ')})` : '';
    output.push(chalk.dim(`    ╰─${stats}`));

    return output;
  } catch {
    // Graceful degradation: if anything fails, skip the diff preview
    return [];
  }
}

// ── Main entry point ────────────────────────────────────────────────

/**
 * Show Claude Code-style permission dialog.
 *
 * Layout:
 *   [purple] Bash command
 *
 *       stat -c '%i' /path/to/file
 *       Compare inode of files
 *
 *   [yellow] Shell expansion syntax in paths requires manual approval
 *
 *   Do you want to proceed?
 *    ❯ 1. Yes
 *      2. Yes, allow reading from ProjectName/ from this project
 *      3. No
 *
 *   Esc to cancel · ctrl+e to explain
 *
 * @param {string} toolName
 * @param {object} params
 * @param {object} riskInfo - { level, label }
 * @param {string} [reasoning]
 * @param {{ oldContent: string, newContent: string, filePath?: string }} [diffInfo]
 *   Optional diff info for write/edit operations. When provided, a compact diff
 *   preview (≤10 lines) is shown between the action description and the Yes/No choices.
 * @returns {Promise<'allow'|'allow-always'|'deny'>}
 */
async function formatPermissionDialog(toolName, params, riskInfo, reasoning, diffInfo) {
  const risk = riskInfo?.level || 'medium';
  const typeLabel = TOOL_TYPE_LABELS[toolName] || toolName;

  console.log('');

  // Purple header (Claude Code style)
  console.log(`  ${chalk.hex(PURPLE).bold(typeLabel)}`);

  // Tool content (indented)
  const contentLines = formatToolContent(toolName, params);
  for (const line of contentLines) {
    console.log(line);
  }

  console.log('');

  // Inline diff preview for write/edit operations
  if (diffInfo) {
    try {
      const previewLines = renderCompactDiffPreview(diffInfo);
      if (previewLines.length > 0) {
        for (const line of previewLines) {
          console.log(line);
        }
        console.log('');
      }
    } catch { /* graceful degradation — skip diff preview */ }
  }

  // Warning line (yellow, only for medium+ risk)
  const warning = RISK_WARNINGS[risk];
  if (warning) {
    console.log(`  ${chalk.hex(WARN_YELLOW).bold(warning)}`);
    console.log('');
  }

  // Build choices
  const projectName = getProjectName();
  // option-2「始终允许」标签的动词口径走 SSOT:写/编辑→"all edits"、bash→"running commands"、
  // 只读类→"reading"(对齐 CC 按工具族分流;门控关 → 逐字节回退 legacy "reading")。
  const { buildAlwaysAllowLabelOr } = require('./alwaysAllowLabel');
  const _alwaysAllowLabel = buildAlwaysAllowLabelOr(
    toolName,
    'Yes, allow reading from {project} from this project',
    process.env,
  ).replace('{project}', chalk.bold(projectName));
  const choices = [
    {
      label: 'Yes',
      value: 'allow',
      aliases: ['1', 'y', 'yes'],
    },
    {
      label: _alwaysAllowLabel,
      value: 'allow-always',
      aliases: ['2', 'a', 'always', 'trust'],
    },
    {
      label: 'No',
      value: 'deny',
      aliases: ['3', 'n', 'no'],
    },
  ];

  return promptChoiceMenu('Do you want to proceed?', choices, {
    defaultIndex: 0,
    cancelValue: 'deny',
    footerHint: 'Esc to cancel \u00B7 Tab to amend \u00B7 ctrl+e to explain',
  });
}

// ── Batch Permission Dialog ──────────────────────────────────────────

/**
 * Claude Code-style batch permission dialog for multiple tools.
 *
 * @param {Array<{name: string, risk: string, description?: string}>} tools
 * @returns {Promise<{decision: 'approve-all'|'approve-all-always'|'deny-all'}>}
 */
async function formatBatchPermissionDialog(tools) {
  console.log('');

  // Purple header
  console.log(`  ${chalk.hex(PURPLE).bold(`${tools.length} tools require approval`)}`);
  console.log('');

  // Tool list
  for (const tool of tools) {
    const style = RISK_STYLES[tool.risk] || RISK_STYLES.medium;
    const typeLabel = TOOL_TYPE_LABELS[tool.name] || tool.name;
    const desc = tool.description ? chalk.dim(` — ${tool.description.slice(0, 40)}`) : '';
    console.log(`    ${style.badge} ${chalk.white(typeLabel)}${desc}`);
  }

  console.log('');

  const projectName = getProjectName();
  const decision = await promptChoiceMenu(
    'Do you want to proceed?',
    [
      { label: 'Yes, approve all this time', value: 'approve-all', aliases: ['1', 'y', 'yes'] },
      { label: `Yes, always trust from ${chalk.bold(projectName)}`, value: 'approve-all-always', aliases: ['2', 'a', 'always'] },
      { label: 'No, deny all', value: 'deny-all', aliases: ['3', 'n', 'no'] },
    ],
    {
      defaultIndex: 0,
      cancelValue: 'deny-all',
      footerHint: 'Esc to cancel \u00B7 ctrl+e to explain',
    }
  );

  return { decision };
}

// ── Legacy box rendering (kept for backwards compat) ────────────────

function renderToolBox(toolName, params, riskInfo, reasoning) {
  const typeLabel = TOOL_TYPE_LABELS[toolName] || toolName;
  const lines = [];
  lines.push(`  ${chalk.hex(PURPLE).bold(typeLabel)}`);
  const contentLines = formatToolContent(toolName, params);
  for (const line of contentLines) lines.push(line);
  if (reasoning) {
    lines.push('');
    lines.push(`  ${chalk.dim('AI reasoning: ' + reasoning.slice(0, 100))}`);
  }
  return lines.join('\n');
}

async function promptApproval(toolName, options = {}) {
  return formatPermissionDialog(toolName, {}, { level: options.risk || 'medium' });
}

module.exports = {
  renderToolBox,
  promptApproval,
  formatPermissionDialog,
  formatBatchPermissionDialog,
  promptChoiceMenu,
  resolveChoiceIndex,
  RISK_STYLES,
  TOOL_TYPE_LABELS,
};

// Self-register the interactive prompter into the service-layer port so the
// service layer (toolCalling / preflightPermission) can request an approval
// decision without reaching up into cli/* (DESIGN-ARCH-057). This is the
// legitimate cli → services direction; the port is a zero-dependency leaf.
try {
  require('../../services/permissionPromptPort').registerPermissionPrompter({
    prompt: formatPermissionDialog,
    promptBatch: formatBatchPermissionDialog,
  });
} catch { /* port unavailable — non-cli context, services degrade to non-interactive */ }
