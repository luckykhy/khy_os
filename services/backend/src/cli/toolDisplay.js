/**
 * Tool Display Module — Claude Code-style tool call rendering.
 *
 * Extracted from aiRenderer.js to reduce file size.
 * Handles:
 *   - Tool call start/result display with family icons
 *   - Expandable output sections (ctrl+o)
 *   - File operation display
 *   - Inline diff rendering
 *   - Agent progress rendering
 *   - ExpandableSection / ToolUseTracker classes
 */
const {
  c, THEME,
  DOT_INDICATOR, DOT_SUCCESS, DOT_ERROR, DOT_DONE, DOT_PENDING,
  TREE_LAST, TREE_MID,
  TOOL_FAMILY_ICONS, getToolFamilyIcon,
  getToolDisplayName, normalizeToolKind, getToolKindLabel,
  summarizeToolDetail,
  _formatElapsed, PHASE_LABELS,
} = require('./renderTheme');
const { displayWidth, padToWidth, truncateToWidth } = require('./formatters');
const { printStepDetail } = require('./steps');
const { getToolPolicy, foldOutput, collapseConsecutiveDuplicates } = require('./toolDisplayPolicy');
// agent / 工具追踪器统计行三分段(tool uses · tokens · 时长)收敛到纯叶子
// cli/agentStatLine.js(对齐 CC AgentTool/UI.tsx;门控 KHY_CC_FORMAT 默认开,关 → legacy 字节回退)。
const { agentToolUsesLabelOr, agentTokensLabelOr, agentDurationLabelOr, toolDurationLabelOr, agentMoreToolUsesLabelOr } = require('./agentStatLine');
// 命令输出 JSON 行美化(纯叶子 SSOT):对齐 CC OutputLine,把命令输出里压扁成一坨的
// JSON 行逐行缩进展开(带精度守卫)。门控 KHY_SHELL_OUTPUT_JSON 默认开;关 → 原样字节回退。
let _formatShellOutputJson;
try { ({ formatShellOutputJson: _formatShellOutputJson } = require('./shellOutputJson')); }
catch { _formatShellOutputJson = null; }

// ── Expandable outputs bridge ────────────────────────────────────────
// panels.js exposes setExpandableOutputs() so we can share the canonical
// array with InitPhaseTracker.collapse() and collapseExecutionBrief().
const {
  setExpandableOutputs: _setExpandableOutputs,
} = require('./panels');

const _expandableOutputs = [];
_setExpandableOutputs(_expandableOutputs);

// ── Step counter — "Step N/M" progress for multi-tool sequences ─────
let _stepCounter = 0;
let _stepTotal = 0;

/**
 * Set expected total step count for "Step N/M" display.
 * Call with 0 to disable step numbering.
 * @param {number} total
 */
function setStepTotal(total) { _stepTotal = Math.max(0, total); _stepCounter = 0; }

/**
 * Reset step counter (call at start of each AI turn).
 */
function resetStepCounter() { _stepCounter = 0; _stepTotal = 0; }

// ── Text helpers (shared with aiRenderer.js via re-export) ───────────

// 收敛到 utils/escapeRegExp 单一真源(逐字节委托,调用点不变)
const _escapeRegex = require('../utils/escapeRegExp');

function _extractParamValue(rawArgs, keys) {
  const source = String(rawArgs || '');
  for (const key of keys) {
    const re = new RegExp(`(?:^|[,{\\s])${_escapeRegex(key)}\\s*(?:=|:)\\s*(?:"((?:\\\\.|[^"\\\\])*)"|'((?:\\\\.|[^'\\\\])*)'|\\\`((?:\\\\.|[^\\\`\\\\])*)\\\`|([^,}]+))`, 'i');
    const m = source.match(re);
    if (m) {
      const value = (m[1] || m[2] || m[3] || m[4] || '').trim()
        .replace(/\\(["'`\\])/g, '$1');
      if (value) return value;
    }
  }
  return '';
}

function _truncateText(text, max = 120) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  return source.length > max ? `${source.slice(0, max - 3)}...` : source;
}

// 按显示宽度截断的省略号预算收敛到纯叶子 cli/truncateDisplayWidthBudget.js
// (门控 KHY_TRUNCATE_WIDTH_BUDGET 默认开:截断时为 `...` 预留 3 列、总宽 ≤ limit;
//  关 → 逐字节回退历史「填满 limit 再溢出接 `...`」行为)。懒加载 + fail-soft。
let _truncateWidthBudget;
function _truncateDisplayWidth(text, maxWidth) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  if (!source) return '';
  const limit = Math.max(0, Number(maxWidth) || 0);
  if (limit <= 0) return '';

  try {
    if (_truncateWidthBudget === undefined) {
      _truncateWidthBudget = require('./truncateDisplayWidthBudget').truncateWidth;
    }
    if (typeof _truncateWidthBudget === 'function') {
      return _truncateWidthBudget(source, limit, displayWidth, process.env);
    }
  } catch {
    /* 叶子不可用 → 落历史内联分支 */
  }

  let width = 0;
  let out = '';
  for (const ch of Array.from(source)) {
    const chWidth = displayWidth(ch);
    if (width + chWidth > limit) {
      return out ? `${out}...` : '...';
    }
    out += ch;
    width += chWidth;
  }
  return out;
}

function _truncateNaturalText(text, maxWidth = 120) {
  const clipped = _truncateDisplayWidth(String(text || ''), maxWidth);
  if (!clipped.endsWith('...')) return clipped;

  const base = clipped.slice(0, -3).trimEnd();
  if (!base) return clipped;
  const boundaryPattern = /[\s,，。;；:：!！?？)\]）】》"'`]/;
  let lastBoundary = -1;
  for (let i = 0; i < base.length; i++) {
    if (boundaryPattern.test(base[i])) lastBoundary = i;
  }
  if (lastBoundary < 0) return clipped;
  const candidate = base.slice(0, lastBoundary).trimEnd();
  if (!candidate) return clipped;
  if (candidate.length < Math.floor(base.length * 0.55)) return clipped;
  return `${candidate}...`;
}

function _sanitizeToolTableCell(value, maxWidth = 24) {
  const normalized = String(value || '')
    .replace(/\|/g, '¦')
    .replace(/\r?\n/g, ' ')
    .trim();
  return _truncateDisplayWidth(normalized, maxWidth);
}

function _extractLooseToolParams(raw = '') {
  const source = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!source) return {};
  const loose = {};

  const cmd = _extractParamValue(source, ['command', 'cmd']);
  const filePath = _extractParamValue(source, ['file_path', 'filePath', 'path', 'file']);
  const pattern = _extractParamValue(source, ['pattern', 'query', 'q']);
  const url = _extractParamValue(source, ['url', 'uri', 'href']);
  const description = _extractParamValue(source, ['description', 'summary', 'message', 'content']);
  const role = _extractParamValue(source, ['role', 'subagent_type', 'agent_type']);
  const prompt = _extractParamValue(source, ['prompt']);

  if (cmd) loose.command = cmd;
  if (filePath) loose.path = filePath;
  if (pattern) loose.pattern = pattern;
  if (url) loose.url = url;
  if (description) loose.description = description;
  if (role) loose.role = role;
  if (prompt) loose.prompt = prompt;
  return loose;
}

function _coerceToolParams(params) {
  if (params && typeof params === 'object') return params;
  if (typeof params === 'string') {
    try {
      const parsed = JSON.parse(params);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* not JSON */ }
    const raw = String(params || '').replace(/\s+/g, ' ').trim();
    const loose = _extractLooseToolParams(raw);
    if (Object.keys(loose).length > 0) return loose;
    return { _raw: raw };
  }
  return {};
}

// ── Claude Code-style Tool Call Display ──────────────────────────────

/**
 * Generate a natural, conversational intent description for a tool call.
 * Prioritizes the AI-provided description; falls back to auto-generated text.
 * Returns empty string if no meaningful intent can be inferred.
 */
function _describeToolIntent(normalizedName, params = {}) {
  const p = _coerceToolParams(params);
  const filePath = String(p.file_path || p.filePath || p.path || '').trim();
  const fileName = filePath ? require('path').basename(filePath) : '';
  const command = String(p.command || p.cmd || '').trim();
  const pattern = String(p.pattern || '').trim();
  const query = String(p.query || p.q || '').trim();
  const url = String(p.url || '').trim();

  switch (normalizedName) {
    case 'read':
    case 'readfile':
    case 'notebookread':
      if (fileName) return `看看 ${fileName} 里的内容`;
      return '读取文件内容';

    case 'write':
    case 'writefile':
    case 'createfile':
      if (fileName) return `把改动写入 ${fileName}`;
      return '写入文件';

    case 'edit':
    case 'editfile':
    case 'multiedit':
      if (fileName) return `修改 ${fileName}`;
      return '编辑文件';

    case 'bash':
    case 'shell':
    case 'shellcommand':
    case 'command': {
      if (!command) return '';
      // 对齐 CC commentLabel.extractBashCommentLabel:模型若在命令首行写 `# 注释`
      // (非 `#!` shebang),那是它专为人类写的**权威标签**,比从动词猜的描述更真实,
      // 优先采用。门控关/无注释/异常 → 落到下面的动词模式猜测(逐字节回退)。
      try {
        const lbl = require('../tools/bashCommentLabel').extractBashCommentLabelForDisplay(command, process.env);
        if (lbl) return lbl;
      } catch { /* fall through to verb pattern matching */ }
      // Recognize common command patterns
      const first = command.split(/\s+/)[0].replace(/^.*\//, ''); // basename
      if (first === 'find') return '搜索文件系统，找到匹配的文件';
      if (first === 'ls') return '看看目录下有哪些文件';
      if (first === 'cat' || first === 'head' || first === 'tail') return '查看文件内容';
      if (first === 'git') {
        const sub = command.split(/\s+/)[1] || '';
        if (sub === 'status') return '看看当前 Git 状态';
        if (sub === 'log') return '查看最近的提交记录';
        if (sub === 'diff') return '对比一下改动';
        if (sub === 'clone') return '克隆仓库';
        if (sub === 'pull') return '拉取最新代码';
        if (sub === 'push') return '推送代码到远程';
        if (sub === 'checkout' || sub === 'switch') return '切换分支';
        if (sub === 'branch') return '查看或操作分支';
        if (sub === 'add') return '暂存文件改动';
        if (sub === 'commit') return '提交改动';
        if (sub === 'stash') return '暂存当前工作进度';
        return `执行 git ${sub}`;
      }
      if (first === 'npm' || first === 'yarn' || first === 'pnpm') {
        const sub = command.split(/\s+/)[1] || '';
        if (sub === 'install' || sub === 'i' || sub === 'add') return '安装依赖';
        if (sub === 'run') return '运行脚本';
        if (sub === 'test') return '跑一下测试';
        if (sub === 'build') return '构建项目';
        return `运行 ${first} ${sub}`;
      }
      if (first === 'pip' || first === 'pip3') return '管理 Python 依赖';
      if (first === 'python' || first === 'python3' || first === 'node') return '运行脚本';
      if (first === 'mkdir') return '创建目录';
      if (first === 'rm') return '删除文件';
      if (first === 'cp') return '复制文件';
      if (first === 'mv') return '移动文件';
      if (first === 'chmod') return '修改文件权限';
      if (first === 'curl' || first === 'wget') return '请求远程资源';
      if (first === 'docker') return '操作 Docker 容器';
      if (first === 'make') return '执行构建任务';
      if (first === 'grep' || first === 'rg') return '在文件中搜索内容';
      if (first === 'sed' || first === 'awk') return '处理文本';
      if (first === 'ssh') return '连接远程服务器';
      if (first === 'tar' || first === 'zip' || first === 'unzip') return '处理压缩包';
      // Generic fallback — keep it conversational
      return `执行 ${first} 命令`;
    }

    case 'grep':
    case 'search':
    case 'searchcontent':
      if (pattern && fileName) return `在 ${fileName} 里搜索 "${pattern}"`;
      if (pattern) return `搜索包含 "${pattern}" 的文件`;
      return '在代码中搜索';

    case 'glob':
    case 'find':
    case 'findfiles':
    case 'ls':
      if (pattern) return `查找匹配 ${pattern} 的文件`;
      if (filePath) return `查看 ${fileName || filePath} 的结构`;
      return '查找文件';

    case 'websearch':
      if (query) return `搜索一下: ${query.slice(0, 60)}`;
      return '搜索网络信息';

    case 'webfetch':
      if (url) return `获取网页内容`;
      return '抓取网页';

    case 'agent':
    case 'task':
    case 'spawnworker':
    case 'subagent': {
      const role = String(p.role || p.subagent_type || '').trim();
      const prompt = String(p.prompt || '').trim();
      if (prompt) return `让 ${role || '子智能体'} 去处理: ${prompt.slice(0, 50)}`;
      return '分配子任务';
    }

    default:
      break;
  }

  // Optional fallback: trust model-provided description only when explicitly enabled.
  const trustDesc = ['1', 'true', 'yes', 'on'].includes(
    String(process.env.KHY_TOOL_INTENT_TRUST_DESCRIPTION || '').trim().toLowerCase()
  );
  if (trustDesc) {
    const aiDesc = String(p.description || '').trim();
    if (aiDesc) return _truncateNaturalText(aiDesc, 88);
  }
  return '';
}

const _toolStartDedupState = {
  signature: '',
  count: 0,
  lastAt: 0,
};

/**
 * Print a tool call start line (Claude Code style).
 * Shows: ⏺ ToolName(param: "value", path: "file.js")
 *
 * @param {string} toolName - raw tool name, auto-mapped to display name
 * @param {object|string} params - tool parameters to display
 * @returns {number} line count printed (for cursor-up later)
 */
function printToolCallStart(toolName, params = {}) {
  if (process.stdout.isTTY) return 0;
  const normalizedParams = _coerceToolParams(params);
  const displayName = getToolDisplayName(toolName);
  const paramStr = _formatToolParams(toolName, normalizedParams);
  const name = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
  const now = Date.now();
  const signature = `${displayName}|${paramStr}`;

  if (signature && _toolStartDedupState.signature === signature && (now - _toolStartDedupState.lastAt) < 15000) {
    _toolStartDedupState.count += 1;
    _toolStartDedupState.lastAt = now;
    if (_toolStartDedupState.count === 2) {
      printStepDetail(`相同工具调用已合并显示（当前 ×${_toolStartDedupState.count}）`);
    }
    return 0;
  }

  if (_toolStartDedupState.signature && _toolStartDedupState.count > 1) {
    printStepDetail(`上一条工具调用共重复 ${_toolStartDedupState.count} 次，已合并显示`);
  }
  _toolStartDedupState.signature = signature;
  _toolStartDedupState.count = 1;
  _toolStartDedupState.lastAt = now;

  // Show conversational intent above the tool line (policy-driven)
  const policy = getToolPolicy(toolName);
  const intent = policy.showIntent ? _describeToolIntent(name, normalizedParams) : '';
  if (intent) {
    console.log(`  ${c().dim(intent)}`);
  }

  // Step counter: "Step N/M" or "Step N" prefix for multi-tool sequences
  _stepCounter++;
  const stepPrefix = _stepTotal > 0
    ? c().dim(`[${_stepCounter}/${_stepTotal}] `)
    : _stepCounter > 1
      ? c().dim(`[${_stepCounter}] `)
      : '';

  // Active state: tool family icon + bold name + params
  const icon = getToolFamilyIcon(toolName);
  console.log(`  ${stepPrefix}${c().hex(THEME.text)(icon)} ${c().hex(THEME.text).bold(displayName)}${c().dim(`(${paramStr})`)}`);

  // Subtle background block for Bash command preview (no border lines)
  if (policy.boxPreview && normalizedParams) {
    const cmd = normalizedParams.command || normalizedParams.cmd || '';
    if (cmd) {
      const termCols = process.stdout.columns || 80;
      const blockWidth = termCols - 6; // 4-char left indent + 2 right margin
      const bgStyle = c().bgHex(THEME.bashBg || '#2A2A2A');
      const cmdLines = cmd.split('\n');
      const { lines: foldedCmdLines } = foldOutput(cmdLines, { maxLines: 8, foldHead: 8, foldTail: 0 });
      for (const line of foldedCmdLines) {
        const prefix = ' $ ';
        const maxContent = blockWidth - prefix.length - 1;
        const display = line.length > maxContent ? line.slice(0, maxContent - 3) + '...' : line;
        const rendered = `${prefix}${display}`;
        const pad = Math.max(0, blockWidth - displayWidth(rendered));
        console.log(`    ${bgStyle(rendered + ' '.repeat(pad))}`);
      }
    }
  }

  // Write/Edit: show file path with icon
  if ((name === 'write' || name === 'writefile' || name === 'createfile') && (normalizedParams?.file_path || normalizedParams?.filePath || normalizedParams?.path)) {
    const filePath = normalizedParams.file_path || normalizedParams.filePath || normalizedParams.path;
    const _wlc = _estimateLines(normalizedParams.content);
    console.log(`    ${c().dim('✏️  Writing')} ${c().cyan(filePath)} ${c().dim(`(${_wlc} ${require('./ccPlural').pluralOr(_wlc, 'line')})`)}`);
  }
  if ((name === 'edit' || name === 'editfile' || name === 'multiedit') && normalizedParams) {
    const filePath = normalizedParams.file_path || normalizedParams.filePath || normalizedParams.path || '';
    if (filePath) {
      console.log(`    ${c().dim('📝 Editing')} ${c().cyan(filePath)}`);
    }
  }

  return 1;
}

function _estimateLines(content) {
  if (!content) return 0;
  // CC countLines SSOT(cli/ccCountLines):末尾换行当行终止符(不是新空行),避免把
  // 以 '\n' 结尾的常态文件多算 1 行。门控 KHY_WRITE_COUNT_LINES_CC 关 → 逐字节回退裸
  // `split('\n').length`。与 toolResultSummary 的 post-exec「已写入 M 行」摘要同源同门控,
  // 消除同一次写入 pre-exec「Writing N lines」与 post-exec 差 1 的不一致。
  try {
    return require('./ccCountLines').countLinesOr(content, process.env);
  } catch {
    return String(content).split('\n').length;
  }
}

/**
 * Format tool parameters for display, tool-type-aware.
 * Claude Code shows different formats per tool:
 *   Read → file_path
 *   Bash → command (truncated to 120 chars)
 *   Search/Grep → pattern: "X", path: "Y"
 *   Write/Update → file_path
 */
function _formatToolParams(toolName, params) {
  if (!params) return '';
  if (typeof params === 'string') return _formatToolParams(toolName, _coerceToolParams(params));
  if (params && typeof params === 'object' && params._raw && Object.keys(params).length === 1) {
    return _truncateNaturalText(String(params._raw), 100);
  }
  const name = String(toolName).toLowerCase().replace(/[\s_-]/g, '');

  if (name === 'read' || name === 'readfile') {
    const p0 = params.file_path || params.filePath || params.path || '';
    // 统一工具头行路径口径:相对化到 cwd + 超长中间截断保文件名(SSOT
    // toolParamPath.formatToolHeaderPath;两门控关 → 逐字节回退裸路径)。与
    // TUI ToolLines / displayFormatters 同源,消除经典 REPL 显裸绝对路径的孤儿。
    const p = require('./toolParamPath').formatToolHeaderPath(p0, process.cwd(), process.env);
    // CC FileReadTool/UI.tsx renderToolUseMessage: append the read line-range
    // (offset/limit → `第 X-Y 行` / `从第 X 行起`) after the path. Gate
    // KHY_READ_RANGE_SUFFIX off → '' → byte-identical bare path.
    return p + require('./readRangeSuffix').buildReadRangeSuffix(params, process.env);
  }
  if (name === 'notebookread') {
    const p0 = params.path || params.file_path || '';
    return require('./toolParamPath').formatToolHeaderPath(p0, process.cwd(), process.env);
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    const cmd = params.command || params.cmd || '';
    if (cmd) return _truncateNaturalText(cmd, 120);
    if (params.description) return _truncateNaturalText(String(params.description), 100);
    return '';
  }
  if (name === 'websearch') {
    const q = params.query || params.q || '';
    return _truncateNaturalText(q, 120);
  }
  if (name === 'webfetch') {
    const url = params.url || params.uri || params.href || '';
    return _truncateNaturalText(url, 120);
  }
  if (name === 'grep' || name === 'search' || name === 'searchcontent') {
    const parts = [];
    if (params.pattern) parts.push(`pattern: "${params.pattern}"`);
    if (params.path) parts.push(`path: "${params.path}"`);
    return parts.join(', ') || '';
  }
  if (name === 'glob' || name === 'find' || name === 'findfiles' || name === 'ls') {
    return [params.pattern, params.path].filter(Boolean).join(', ') || params.path || '';
  }
  if (name === 'write' || name === 'writefile' || name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    const p0 = params.file_path || params.filePath || params.path || '';
    return require('./toolParamPath').formatToolHeaderPath(p0, process.cwd(), process.env);
  }
  if (name === 'agent' || name === 'task') {
    const role = params.role || params.subagent_type || params.agent_type || '';
    const prompt = params.description || params.prompt || params.message || '';
    const rolePrefix = role ? `${role}: ` : '';
    return _truncateNaturalText(`${rolePrefix}${prompt}`.trim(), 80);
  }
  if (name === 'todowrite') {
    const count = Array.isArray(params.todos) ? params.todos.length : 0;
    return count > 0 ? `${count} todos` : 'todos';
  }

  // Generic fallback
  if (typeof params === 'object') {
    return Object.entries(params).slice(0, 3)
      .map(([k, v]) => {
        const val = typeof v === 'string'
          ? _truncateNaturalText(v, 40)
          : String(v);
        return `${k}: ${val}`;
      }).join(', ');
  }
  return '';
}

/**
 * Print a tool call result, overwriting the active line.
 * Shows: ● ToolName(params) with green/red dot + tree detail line.
 *
 * @param {string} toolName
 * @param {object|string} params - same params as start (for redraw)
 * @param {'success'|'error'} status
 * @param {string} detail - result summary, e.g. "Found 3 matches", "245 lines"
 * @param {number} elapsed - ms elapsed
 */
function printToolCallResult(toolName, params, status, detail = '', elapsed = 0) {
  let _syncWrite;
  try { _syncWrite = require('./syncOutput').syncWrite; } catch { _syncWrite = (fn) => fn(); }
  _syncWrite(() => _printToolCallResultInner(toolName, params, status, detail, elapsed));
}

function _printToolCallResultInner(toolName, params, status, detail = '', elapsed = 0) {
  if (process.stdout.isTTY) return;
  const displayName = getToolDisplayName(toolName);
  const paramStr = _formatToolParams(toolName, params);
  const name = String(toolName).toLowerCase().replace(/[\s_-]/g, '');
  const policy = getToolPolicy(toolName);
  const isBash = policy.boxPreview; // tools with boxPreview had cursor-up skipped

  // For tools with box preview, don't move cursor up (multiple lines rendered)
  // For other tools, overwrite the active line
  if (process.stdout.isTTY && !isBash) {
    process.stdout.write('\x1b[1A\r\x1b[K');
  }

  // 使用工具家族图标 + 状态色
  const icon = getToolFamilyIcon(toolName);
  const dot = status === 'success'
    ? c().hex(THEME.success)(icon)
    : c().hex(THEME.error)(icon);
  // 工具结果行的时长走 tool-result SSOT `toolDurationLabelOr`:亚秒(<1s)→ CC 亚秒
  // 精度 `0.1s`(对齐 CC 工具结果行,快工具不再全显 `0s`);≥1s → ccFormat 对齐(整秒 /
  // h/d 进位)。子门控 KHY_CC_TOOLDUR_SUBSEC 默认开;关 → 纯 agentDurationLabelOr 字节回退。
  const elapsedStr = elapsed > 0 ? c().dim(` ${toolDurationLabelOr(elapsed, `${(elapsed / 1000).toFixed(1)}s`, process.env)}`) : '';
  console.log(`  ${dot} ${c().bold(displayName)}${c().dim(`(${paramStr})`)}${elapsedStr}`);

  // Claude Code: result on next line with ⎿ prefix, collapsible
  // Folding is now driven by the tool display policy.
  if (detail) {
    // 对齐 CC:命令(bash)输出在切行/折叠**之前**先逐行尝试 JSON 美化(CC OutputLine
    // 只对 shell 输出做)。门控关/非 bash/非 JSON → 逐字节原样。
    const _formattedDetail = (isBash && _formatShellOutputJson)
      ? _formatShellOutputJson(String(detail), process.env)
      : String(detail);
    const rawLines = _formattedDetail.split('\n');
    const cols = (process.stdout.columns || 80) - 8;
    // Collapse consecutive duplicate lines (e.g. `dir /s` → hundreds of identical
    // "0 File(s) 0 bytes") to the first occurrence + a "+N 行相同" marker before
    // folding. The full, un-collapsed output is preserved for Ctrl+O expansion.
    const { lines: dedupedLines, collapsed } = collapseConsecutiveDuplicates(rawLines);
    const { lines: foldedLines, folded } = foldOutput(dedupedLines, policy);

    for (const line of foldedLines) {
      const display = isBash && line.length > cols ? line.slice(0, cols - 3) + '...' : line;
      console.log(`    ${c().dim('⎿')} ${c().dim(display)}`);
    }

    // Mark expandable when EITHER folding or duplicate-collapse hid content, so the
    // "ctrl+o 展开" promise on the collapse marker actually has full output to show.
    if (folded || collapsed) {
      _expandableOutputs.push({ tool: displayName, detail: rawLines.join('\n'), paramStr });
    }
  }
}

function getLastExpandableOutput() {
  return _expandableOutputs.length > 0 ? _expandableOutputs[_expandableOutputs.length - 1] : null;
}

function pushExpandableOutput(entry) {
  if (entry && typeof entry === 'object') _expandableOutputs.push(entry);
}

/**
 * Print a file operation result with line count statistics.
 * Shows Claude Code style: "Added N lines, removed M lines"
 *
 * @param {'update'|'create'|'delete'} operation
 * @param {string} filePath - file path relative to cwd
 * @param {object} [stats] - { added: number, removed: number, total: number }
 * @param {number} [elapsed] - ms elapsed
 */
function printFileOperation(operation, filePath, stats = {}, elapsed = 0) {
  if (process.stdout.isTTY) return;
  // Claude Code: Update/Create/Write use green dot, Delete uses red dot
  const opColors = {
    update: { dot: c().hex(THEME.success)(DOT_SUCCESS), label: c().hex(THEME.success)('Update'), verb: 'Updated' },
    create: { dot: c().hex(THEME.success)(DOT_SUCCESS), label: c().hex(THEME.success)('Create'), verb: 'Created' },
    write:  { dot: c().hex(THEME.success)(DOT_SUCCESS), label: c().hex(THEME.success)('Write'), verb: 'Wrote' },
    delete: { dot: c().hex(THEME.error)(DOT_ERROR), label: c().hex(THEME.error)('Delete'), verb: 'Deleted' },
  };
  const op = opColors[operation] || opColors.update;
  // 文件操作行时长同走 tool-result SSOT `toolDurationLabelOr`(阈值 >500ms 不变):
  // 亚秒(500–1000ms)→ CC 亚秒精度 `0.6s`;≥1s → ccFormat 对齐。子门控关 → 纯
  // agentDurationLabelOr 字节回退。
  const elapsedStr = elapsed > 500 ? c().dim(` (${toolDurationLabelOr(elapsed, `${(elapsed / 1000).toFixed(1)}s`, process.env)})`) : '';

  console.log(`  ${op.dot} ${c().bold(op.label)}${c().dim(`(${filePath})`)}${elapsedStr}`);

  // Claude Code: result line with ⎿ prefix — "Added X lines, removed Y lines"
  // \u6458\u8981\u4E32\u6784\u9020\u6536\u655B\u5230\u5355\u4E00\u771F\u6E90 cli/editStatLine.js(\u542B CC \u53E5\u9996 "Removed" \u5927\u5199\u89C4\u5219)\u3002
  const statLine = require('./editStatLine').buildEditStatLine(stats.added, stats.removed, process.env);
  if (statLine) {
    console.log(`  ${c().dim('\u23BF')}  ${c().dim(statLine)}`);
  }
}

/**
 * Render "Running N agents..." header.
 * @param {number} count
 * @param {string} [hint] - e.g. "(ctrl+o to expand)"
 */
function renderAgentHeader(count, hint = '') {
  const hintStr = hint ? c().dim(`  ${hint}`) : '';
  // Pluralize via the shared ccPlural SSOT so a single agent reads
  // "Running 1 agent..." instead of the ungrammatical "1 agents"
  // (gate KHY_CC_PLURAL off → returns the plural form → byte-revert).
  const agentWord = require('./ccPlural').pluralOr(count, 'agent', 'agents', process.env);
  console.log(`  ${c().hex(THEME.secondaryText)(DOT_INDICATOR)} ${c().bold(`Running ${count} ${agentWord}...`)}${hintStr}`);
}

/**
 * Render tree-style agent progress.
 * @param {Array<{name: string, status: 'pending'|'running'|'completed'|'error', toolCalls?: number, tokens?: number, elapsed?: string, detail?: string}>} agents
 * @returns {number} lines rendered
 */
function renderAgentProgress(agents) {
  let lines = 0;
  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];
    const isLast = i === agents.length - 1;
    const branch = isLast ? '\u2514' : '\u251C';

    let statusIcon, nameColor;
    switch (agent.status) {
      case 'completed':
        statusIcon = c().hex(THEME.success)(DOT_DONE);
        nameColor = c().dim;
        break;
      case 'error':
        statusIcon = c().hex(THEME.error)(DOT_ERROR);
        nameColor = c().hex(THEME.error);
        break;
      case 'running':
        statusIcon = c().hex(THEME.secondaryText)(DOT_INDICATOR);
        nameColor = c().bold;
        break;
      default:
        statusIcon = c().dim(DOT_PENDING);
        nameColor = c().dim;
        break;
    }

    // Stats string: tool calls · tokens · elapsed
    const stats = [];
    if (agent.toolCalls > 0) {
      stats.push(agentToolUsesLabelOr(agent.toolCalls, `${agent.toolCalls} tool uses`, process.env));
    }
    if (agent.tokens > 0) {
      const tokenStr = agent.tokens >= 1000
        ? `${(agent.tokens / 1000).toFixed(1)}k tokens`
        : `${agent.tokens} tokens`;
      stats.push(agentTokensLabelOr(agent.tokens, tokenStr, process.env));
    }
    if (agent.elapsed) stats.push(agent.elapsed);
    const statsStr = stats.length > 0 ? c().dim(` \u00B7 ${stats.join(' \u00B7 ')}`) : '';

    // Claude Code style: ⏺ AgentName with status-colored dot
    console.log(`    ${statusIcon} ${nameColor(agent.name)}${statsStr}`);
    lines++;

    // Detail line with ⎿ prefix
    if (agent.detail) {
      console.log(`      ${c().dim('\u23BF')}  ${c().dim(agent.detail)}`);
      lines++;
    }
  }
  return lines;
}

/**
 * Render agent/task completion summary line.
 * Shows: Done (N tool uses · X.Xk tokens · Nm NNs)
 *
 * @param {object} stats - { toolCalls, tokens, elapsedMs }
 */
function renderAgentDone(stats = {}) {
  const parts = [];
  if (stats.toolCalls > 0) {
    parts.push(agentToolUsesLabelOr(stats.toolCalls, `${stats.toolCalls} tool uses`, process.env));
  }
  if (stats.tokens > 0) {
    parts.push(agentTokensLabelOr(stats.tokens, `${(stats.tokens / 1000).toFixed(1)}k tokens`, process.env));
  }
  if (stats.elapsedMs > 0) {
    const sec = Math.floor(stats.elapsedMs / 1000);
    const min = Math.floor(sec / 60);
    const remSec = sec % 60;
    const legacyDur = min > 0 ? `${min}m ${remSec}s` : `${sec}s`;
    parts.push(agentDurationLabelOr(stats.elapsedMs, legacyDur, process.env));
  }

  const detail = parts.length > 0 ? ` (${parts.join(' \u00B7 ')})` : '';
  // Claude Code: ⎿ Done summary
  console.log(`  ${c().dim('\u23BF')}  ${c().hex(THEME.success)('Done')}${c().dim(detail)}`);
}

/**
 * Render "(ctrl+o to expand)" hint.
 */
function renderExpandHint() {
  console.log(c().dim('  (ctrl+o to expand)'));
}

/**
 * ExpandableSection — manages collapsible output sections.
 * Stores full output but displays only a summary until expanded.
 */
class ExpandableSection {
  constructor() {
    this._sections = [];
    this._expandedIndex = -1;
  }

  /**
   * Add a collapsible section.
   * @param {string} summary - one-line summary shown when collapsed
   * @param {string[]} fullOutput - full output lines shown when expanded
   */
  add(summary, fullOutput) {
    this._sections.push({ summary, fullOutput, expanded: false });
    return this._sections.length - 1;
  }

  /**
   * Toggle expand/collapse of a section.
   */
  toggle(index) {
    if (index >= 0 && index < this._sections.length) {
      this._sections[index].expanded = !this._sections[index].expanded;
    }
  }

  /**
   * Get all sections for display.
   */
  getSections() {
    return this._sections;
  }
}

/**
 * ToolUseTracker — Claude Code-style collapsible tool-use display.
 *
 * While running, shows:
 *   ● Explore(Explore training infrastructure)
 *     ├ Bash(grep -r "train.*start" /path/to/dir)
 *     │ Running...
 *     ├ Read(backend/src/cli/router.js)
 *     │ Running...
 *     └ +12 more tool uses (ctrl+o to expand)
 *     (ctrl+b to run in background)
 *
 * When done, collapses to:
 *   ● Explore(Explore training infrastructure)
 *     └ Done (24 tool uses · 60.9k tokens · 2m 15s)
 *     (ctrl+o to expand)
 */
class ToolUseTracker {
  /**
   * @param {string} label - Top-level label (e.g. "Explore", "Agent")
   * @param {string} description - Short description (e.g. "Explore training infrastructure")
   * @param {object} [opts]
   * @param {number} [opts.maxVisible=3] - Max tool calls visible before "+N more"
   */
  constructor(label, description, opts = {}) {
    this._label = label;
    this._description = description;
    this._maxVisible = opts.maxVisible || 3;
    this._tools = [];          // [{ name, params, status, elapsed, detail }]
    this._renderedLines = 0;
    this._startTime = Date.now();
    this._totalTokens = 0;
    this._finished = false;
    this._headerPrinted = false;
  }

  /**
   * Print the header line (call once before adding tools).
   * Claude Code style: ⏺ Agent(description)
   */
  printHeader() {
    if (this._headerPrinted) return;
    this._headerPrinted = true;
    const displayName = getToolDisplayName(this._label);
    const icon = getToolFamilyIcon(this._label);
    console.log(`  ${c().hex(THEME.secondaryText)(icon)} ${c().bold(displayName)}${c().dim(`(${this._description})`)}`);
    this._renderedLines = 1;
  }

  /**
   * Record a tool call starting.
   * @param {string} name - Tool name (e.g. "Read", "Bash", "Grep")
   * @param {string} params - Brief param string
   */
  toolStart(name, params = '') {
    const summary = summarizeToolDetail(name, params);
    const now = Date.now();
    const sig = `${String(name)}|${summary.short}`;
    const tail = this._tools.length > 0 ? this._tools[this._tools.length - 1] : null;
    if (tail && tail.signature === sig && (now - (tail._lastSeenAt || 0)) < 15000) {
      tail.repeat = Math.max(1, Number(tail.repeat || 1)) + 1;
      tail.status = 'running';
      tail.elapsed = 0;
      tail.detail = '';
      tail.startTime = now;
      tail._lastSeenAt = now;
      this._rerender();
      return;
    }
    this._tools.push({
      name,
      params: summary.short,
      kind: summary.kind,
      status: 'running',
      elapsed: 0,
      detail: '',
      startTime: now,
      repeat: 1,
      signature: sig,
      _lastSeenAt: now,
    });
    this._rerender();
  }

  /**
   * Record a tool call completing.
   * @param {string} name - Tool name
   * @param {'success'|'error'} status
   * @param {string} [detail]
   * @param {number} [elapsed] - ms
   */
  toolEnd(name, status = 'success', detail = '', elapsed = 0) {
    // Find the most recent matching running tool
    for (let i = this._tools.length - 1; i >= 0; i--) {
      if (this._tools[i].name === name && this._tools[i].status === 'running') {
        this._tools[i].status = status;
        this._tools[i].detail = detail;
        this._tools[i].elapsed = elapsed || (Date.now() - this._tools[i].startTime);
        this._tools[i]._lastSeenAt = Date.now();
        break;
      }
    }
    this._rerender();
  }

  /**
   * Add token count.
   * @param {number} tokens
   */
  addTokens(tokens) {
    this._totalTokens += tokens;
  }

  /**
   * Mark as finished and collapse to summary.
   */
  finish() {
    this._finished = true;
    this._rerender();
    // Store tool detail for Ctrl+O expansion
    this._pushExpandableDetail();
  }

  /** Push full tool list to expandable outputs so Ctrl+O works after collapse. */
  _pushExpandableDetail() {
    if (this._tools.length === 0) return;
    const lines = this._tools.map(t => {
      const status = t.status === 'success' ? 'ok' : t.status === 'error' ? 'FAIL' : '...';
      const elapsed = t.elapsed > 0 ? ` ${t.elapsed}ms` : '';
      const repeat = (t.repeat || 1) > 1 ? ` x${t.repeat}` : '';
      const detail = t.detail ? `  ${t.detail}` : '';
      return `  [${status}] ${t.name}(${t.params || ''})${repeat}${elapsed}${detail}`;
    });
    _expandableOutputs.push({
      tool: this._label,
      detail: lines.join('\n'),
      paramStr: this._description,
    });
  }

  /**
   * Clear previously rendered lines and re-render.
   * Uses syncWrite + batched ANSI to prevent flicker on Windows.
   */
  _rerender() {
    if (process.stdout.isTTY) return;
    if (!this._headerPrinted) this.printHeader();

    let _sw;
    try { _sw = require('./syncOutput').syncWrite; } catch { /* ignore */ }
    if (typeof _sw !== 'function') _sw = (fn) => fn();
    _sw(() => this._rerenderInner());
  }

  /** @private */
  _rerenderInner() {
    // Batch-clear previous tool lines (not the header) — single write
    const clearCount = this._finished
      ? (process.stdout.isTTY ? this._renderedLines : 0)  // finished: clear header too
      : (process.stdout.isTTY && this._renderedLines > 1 ? this._renderedLines - 1 : 0);
    if (clearCount > 0) {
      process.stdout.write('\x1b[1A\r\x1b[K'.repeat(clearCount));
    }

    let lines = 0;

    if (this._finished) {
      const displayName = getToolDisplayName(this._label);
      const icon = getToolFamilyIcon(this._label);
      console.log(`  ${c().hex(THEME.success)(icon)} ${c().bold(displayName)}${c().dim(`(${this._description})`)}`);
      lines++;

      // Summary line
      const elapsed = Date.now() - this._startTime;
      const parts = [];
      const mergedToolCount = this._tools.reduce((sum, item) => sum + Math.max(1, Number(item.repeat || 1)), 0);
      parts.push(agentToolUsesLabelOr(mergedToolCount, `${mergedToolCount} tool uses`, process.env));
      if (this._totalTokens > 0) {
        const legacyTok = this._totalTokens >= 1000
          ? `${(this._totalTokens / 1000).toFixed(1)}k tokens`
          : `${this._totalTokens} tokens`;
        parts.push(agentTokensLabelOr(this._totalTokens, legacyTok, process.env));
      }
      const sec = Math.floor(elapsed / 1000);
      const min = Math.floor(sec / 60);
      const remSec = sec % 60;
      parts.push(agentDurationLabelOr(elapsed, min > 0 ? `${min}m ${remSec}s` : `${sec}s`, process.env));

      console.log(`  ${c().dim('\u23BF')}  ${c().hex(THEME.success)('Done')} ${c().dim(`(${parts.join(' \u00B7 ')})`)}`);
      lines++;
      console.log(c().dim('    (ctrl+o to expand)'));
      lines++;

      this._renderedLines = 1 + lines;
      return;
    }

    // Running state: show recent tools with Claude Code tree style
    const visible = this._tools.slice(-this._maxVisible);
    const hiddenCount = Math.max(0, this._tools.length - this._maxVisible);

    for (let i = 0; i < visible.length; i++) {
      const tool = visible[i];
      const displayName = getToolDisplayName(tool.name);
      const toolIcon = getToolFamilyIcon(tool.name);
      const repeatSuffix = Number(tool.repeat || 1) > 1 ? ` \u00D7${Number(tool.repeat || 1)}` : '';
      const paramStrBase = tool.params ? tool.params.slice(0, 80) : '';
      const paramStr = paramStrBase ? `${paramStrBase}${repeatSuffix}` : repeatSuffix.trim();

      if (tool.status === 'running') {
        console.log(`    ${c().hex(THEME.secondaryText)(toolIcon)} ${c().bold(displayName)}${paramStr ? c().dim(`(${paramStr})`) : ''}`);
        lines++;
        console.log(`      ${c().dim('Running\u2026')}`);
        lines++;
      } else if (tool.status === 'success') {
        console.log(`    ${c().hex(THEME.success)(toolIcon)} ${c().bold(displayName)}${paramStr ? c().dim(`(${paramStr})`) : ''}`);
        lines++;
        if (tool.detail) {
          console.log(`      ${c().dim('\u23BF')}  ${c().dim(tool.detail)}`);
          lines++;
        }
      } else if (tool.status === 'error') {
        console.log(`    ${c().hex(THEME.error)(toolIcon)} ${c().bold(displayName)}${paramStr ? c().dim(`(${paramStr})`) : ''}`);
        lines++;
        const detail = tool.detail ? tool.detail : 'Failed';
        console.log(`      ${c().dim('\u23BF')}  ${c().hex(THEME.error)(detail)}`);
        lines++;
      }
    }

    if (hiddenCount > 0) {
      // use/uses 复数收敛到 agentStatLine SSOT(对齐 CC AgentTool/UI.tsx:639 的
      // `=== 1 ? 'use' : 'uses'`;门控关 → legacy `+N more tool uses` 字节回退)。
      const _moreLabel = agentMoreToolUsesLabelOr(hiddenCount, `+${hiddenCount} more tool uses`, process.env);
      console.log(`    ${c().dim(`${_moreLabel} (ctrl+o to expand)`)}`);
      lines++;
    }

    console.log(c().dim('    (ctrl+b to run in background)'));
    lines++;

    this._renderedLines = 1 + lines;
  }

  /**
   * Get total tool count.
   */
  get toolCount() { return this._tools.length; }
  get totalTokens() { return this._totalTokens; }
  get elapsedMs() { return Date.now() - this._startTime; }
}

module.exports = {
  // Public API — tool display functions (spread into aiRenderer.js exports)
  printToolCallStart,
  printToolCallResult,
  getLastExpandableOutput,
  pushExpandableOutput,
  printFileOperation,
  renderAgentHeader,
  renderAgentProgress,
  renderAgentDone,
  renderExpandHint,
  ExpandableSection,
  ToolUseTracker,
  // Step counter for "Step N/M" progress
  setStepTotal,
  resetStepCounter,
  // Shared expandable outputs array (used by panels.js)
  _expandableOutputs,
  // Internal text helpers — used by aiRenderer.js renderAiResponse section.
  // Prefixed with _ to signal internal use; NOT spread into public exports.
  _escapeRegex,
  _extractParamValue,
  _truncateText,
  _truncateDisplayWidth,
  _truncateNaturalText,
  _sanitizeToolTableCell,
  _extractLooseToolParams,
  _coerceToolParams,
  _describeToolIntent,
};
