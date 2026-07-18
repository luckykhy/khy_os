'use strict';

/**
 * Claude compatibility helpers.
 *
 * Centralizes tool/agent alias normalization so Claude-style calls map to
 * existing KHY implementations without duplicating core logic.
 */

function _cleanName(name) {
  return String(name || '').trim().replace(/^["'`]+|["'`]+$/g, '');
}

function _lookupKey(name) {
  return _cleanName(name).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const TOOL_ALIASES = Object.freeze({
  // Shell
  bash: 'shell_command',
  shell: 'shell_command',
  sh: 'shell_command',
  shellcommand: 'shell_command',
  command: 'shell_command',

  // File read/write/edit
  read: 'readFile',
  readfile: 'readFile',
  write: 'writeFile',
  writefile: 'writeFile',
  edit: 'editFile',
  editfile: 'editFile',
  update: 'editFile',
  replace: 'editFile',

  // Claude-specific compatibility tools
  multiedit: 'multiEdit',
  ls: 'ls',
  task: 'agent',
  slashcommand: 'slashCommand',
  slashcmd: 'slashCommand',
  spawnagent: 'spawnAgent',
  spawn_agent: 'spawnAgent',
  sendinput: 'sendInput',
  send_input: 'sendInput',
  waitagent: 'waitAgent',
  wait_agent: 'waitAgent',
  closeagent: 'closeAgent',
  close_agent: 'closeAgent',
  resumeagent: 'resumeAgent',
  resume_agent: 'resumeAgent',
  todowrite: 'todoWrite',
  websearch: 'webSearch',
  webfetch: 'webFetch',
  notebookread: 'notebookRead',
  notebookedit: 'notebookEdit',
  scaffoldfiles: 'scaffoldFiles',
  scaffold_files: 'scaffoldFiles',
  scaffoldproject: 'scaffoldFiles',
  projectscaffold: 'scaffoldFiles',
  createprojectstructure: 'scaffoldFiles',
  batchcreatefiles: 'scaffoldFiles',

  // Patch
  applypatch: 'apply_patch',
  apply_patch: 'apply_patch',
  patch: 'apply_patch',

  // Search
  search: 'search',
  grep: 'grep',
  rg: 'grep',
  glob: 'glob',
  find: 'glob',

  // Claude Code deferred-tool & teammate vocabulary (front-by-front tool-name
  // alignment). CC exposes SearchExtraTools (discover deferred tools) and
  // SendMessage (message an in-process teammate/sub-agent). khy already has the
  // equivalent CAPABILITIES under different names — `toolSearch` (discover/select
  // tools by keyword or name) and `sendInput` ("send follow-up input to an
  // existing sub-agent") — but a CC-vocabulary model emitting the literal CC name
  // previously failed to resolve (verified by executing the real resolver). These
  // map the CC names onto khy's canonical tools so both spellings resolve.
  // NOTE: CC's `ExecuteExtraTool` (invoke a discovered deferred tool) is
  // intentionally NOT mapped — khy folds discovery+invocation differently
  // (discover via toolSearch, then call the surfaced tool DIRECTLY by name), so
  // there is no execute-wrapper to alias to; forcing one would mis-route to a
  // surface-only tool. That divergence is documented, not papered over.
  searchextratools: 'toolSearch',
  sendmessage: 'sendInput',
});

const AGENT_ROLE_ALIASES = Object.freeze({
  general: 'general',
  default: 'general',
  generalpurpose: 'general',
  explore: 'explore',
  explorer: 'explore',
  plan: 'planner',
  planner: 'planner',
  worker: 'coder',
  verification: 'reviewer',
  review: 'reviewer',
  reviewer: 'reviewer',
  audit: 'audit',
  auditor: 'audit',
  critic: 'audit',
  fix: 'fix',
  fixer: 'fix',
  repair: 'fix',
  research: 'research',
  researcher: 'research',
  reading: 'reading',
  reader: 'reading',
  map: 'map',
  cartographer: 'map',
  coder: 'coder',
  claude: 'claude',
  claudecode: 'claude',
  claudecodecli: 'claude',
  codex: 'codex',
  openaicodex: 'codex',
  claudecodeguide: 'general',
});

const CLAUDE_COMPAT_TOOLS = Object.freeze([
  {
    name: 'Bash',
    canonical: 'shell_command',
    description: 'Execute a shell command (Claude compatibility alias).',
    category: 'execution',
    risk: 'critical',
    parameters: {
      command: { type: 'string', description: 'Shell command to execute' },
    },
  },
  {
    name: 'Read',
    canonical: 'readFile',
    description: 'Read file content (Claude compatibility alias).',
    category: 'filesystem',
    risk: 'low',
    parameters: {
      path: { type: 'string', description: 'Path to file' },
      offset: { type: 'number', description: 'Optional start line (1-based)' },
      limit: { type: 'number', description: 'Optional max lines' },
    },
  },
  {
    name: 'Write',
    canonical: 'writeFile',
    description: 'Write a file (Claude compatibility alias).',
    category: 'filesystem',
    risk: 'high',
    parameters: {
      path: { type: 'string', description: 'Path to file' },
      content: { type: 'string', description: 'Content to write' },
    },
  },
  {
    name: 'Edit',
    canonical: 'editFile',
    description: 'Precise string replacement in a file (Claude compatibility alias).',
    category: 'filesystem',
    risk: 'medium',
    parameters: {
      file_path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
      replace_all: { type: 'boolean', description: 'Replace all matches' },
    },
  },
  {
    name: 'MultiEdit',
    canonical: 'multiEdit',
    description: 'Apply multiple edits in sequence to one file (Claude compatibility tool).',
    category: 'filesystem',
    risk: 'medium',
    parameters: {
      file_path: { type: 'string', description: 'File path' },
      edits: { type: 'array', description: 'Array of edit objects' },
    },
  },
  {
    name: 'LS',
    canonical: 'ls',
    description: 'List directory entries (Claude compatibility tool).',
    category: 'filesystem',
    risk: 'safe',
    parameters: {
      path: { type: 'string', description: 'Directory path' },
      recursive: { type: 'boolean', description: 'Recursive listing' },
    },
  },
  {
    name: 'Grep',
    canonical: 'grep',
    description: 'Search file contents with regex (Claude compatibility alias).',
    category: 'filesystem',
    risk: 'safe',
    parameters: {
      pattern: { type: 'string', description: 'Regex pattern' },
      path: { type: 'string', description: 'Directory or file path' },
    },
  },
  {
    name: 'Glob',
    canonical: 'glob',
    description: 'Find files by glob pattern (Claude compatibility alias).',
    category: 'filesystem',
    risk: 'safe',
    parameters: {
      pattern: { type: 'string', description: 'Glob pattern' },
      path: { type: 'string', description: 'Directory to search' },
    },
  },
  {
    name: 'Task',
    canonical: 'agent',
    description: 'Spawn a sub-agent for delegated work (Claude compatibility alias).',
    category: 'coordinator',
    risk: 'medium',
    parameters: {
      prompt: { type: 'string', description: 'Sub-agent task prompt' },
      role: { type: 'string', description: 'Agent role' },
      subagent_type: { type: 'string', description: 'Claude-style subagent type alias (e.g. explorer, worker, default)' },
      agent_type: { type: 'string', description: 'Agent type alias' },
      adapter: { type: 'string', description: 'Preferred adapter override (e.g. codex, claude)' },
      preferred_adapter: { type: 'string', description: 'Alias of adapter' },
      provider: { type: 'string', description: 'Alias of adapter' },
      model: { type: 'string', description: 'Preferred model id for the sub-agent' },
      preferred_model: { type: 'string', description: 'Alias of model' },
    },
  },
  {
    name: 'spawn_agent',
    canonical: 'spawnAgent',
    description: 'Spawn a background sub-agent and return an agent id.',
    category: 'coordinator',
    risk: 'medium',
    parameters: {
      message: { type: 'string', description: 'Task prompt for the sub-agent' },
      prompt: { type: 'string', description: 'Alias of message' },
      agent_type: { type: 'string', description: 'Agent role/type (default/explorer/worker/etc.)' },
      subagent_type: { type: 'string', description: 'Alias of agent_type' },
      adapter: { type: 'string', description: 'Preferred adapter override (e.g. codex, claude)' },
      preferred_adapter: { type: 'string', description: 'Alias of adapter' },
      provider: { type: 'string', description: 'Alias of adapter' },
      model: { type: 'string', description: 'Preferred model id for the sub-agent' },
      preferred_model: { type: 'string', description: 'Alias of model' },
      timeout_ms: { type: 'number', description: 'Optional timeout in milliseconds' },
    },
  },
  {
    name: 'send_input',
    canonical: 'sendInput',
    description: 'Send follow-up input to an existing sub-agent.',
    category: 'coordinator',
    risk: 'low',
    parameters: {
      target: { type: 'string', description: 'Agent id' },
      message: { type: 'string', description: 'Follow-up instruction' },
      interrupt: { type: 'boolean', description: 'Interrupt current work (best effort)' },
    },
  },
  {
    name: 'wait_agent',
    canonical: 'waitAgent',
    description: 'Wait until one of the target agents reaches a terminal state.',
    category: 'coordinator',
    risk: 'safe',
    parameters: {
      targets: { type: 'array', description: 'Agent ids to wait for' },
      timeout_ms: { type: 'number', description: 'Wait timeout in milliseconds' },
    },
  },
  {
    name: 'close_agent',
    canonical: 'closeAgent',
    description: 'Close (stop) a running agent.',
    category: 'coordinator',
    risk: 'medium',
    parameters: {
      target: { type: 'string', description: 'Agent id to close' },
    },
  },
  {
    name: 'resume_agent',
    canonical: 'resumeAgent',
    description: 'Resume/reopen an existing agent handle (best effort compatibility).',
    category: 'coordinator',
    risk: 'low',
    parameters: {
      id: { type: 'string', description: 'Agent id to resume' },
    },
  },
  {
    name: 'SlashCommand',
    canonical: 'slashCommand',
    description: 'Execute a slash command in CLI context (Claude compatibility tool).',
    category: 'system',
    risk: 'low',
    parameters: {
      command: { type: 'string', description: 'Slash command, e.g. /status or model' },
      args: { type: 'array', description: 'Optional positional arguments appended to command' },
    },
  },
  {
    name: 'TodoWrite',
    canonical: 'todoWrite',
    description: 'Write structured todo items for the current session.',
    category: 'system',
    risk: 'low',
    parameters: {
      todos: { type: 'array', description: 'Todo items' },
    },
  },
  {
    name: 'WebSearch',
    canonical: 'webSearch',
    description: 'Search the web for up-to-date information (Claude compatibility alias).',
    category: 'data',
    risk: 'safe',
    parameters: {
      query: { type: 'string', description: 'Search query' },
      freshness: { type: 'string', description: 'Time filter: day/week/month/year/auto/none. Required for time-sensitive queries (latest/recent/today/news).' },
    },
  },
  {
    name: 'WebFetch',
    canonical: 'webFetch',
    description: 'Fetch content from a URL (Claude compatibility tool).',
    category: 'data',
    risk: 'low',
    parameters: {
      url: { type: 'string', description: 'HTTP/HTTPS URL' },
    },
  },
  {
    name: 'NotebookRead',
    canonical: 'notebookRead',
    description: 'Read a notebook file (compatibility tool mapped to file read).',
    category: 'filesystem',
    risk: 'low',
    parameters: {
      path: { type: 'string', description: 'Notebook path' },
    },
  },
  {
    name: 'NotebookEdit',
    canonical: 'notebookEdit',
    description: 'Edit a notebook file (compatibility tool mapped to text edits).',
    category: 'filesystem',
    risk: 'high',
    parameters: {
      path: { type: 'string', description: 'Notebook path' },
      old_string: { type: 'string', description: 'Text to replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
  },
  {
    name: 'apply_patch',
    canonical: 'apply_patch',
    description: 'Apply a unified diff patch to one or more files atomically (all-or-nothing rollback).',
    category: 'filesystem',
    risk: 'high',
    parameters: {
      patch: { type: 'string', description: 'Unified diff text (git diff / diff -u format)' },
    },
  },
]);

function normalizeToolName(toolName) {
  let raw = _cleanName(toolName);
  // Some providers occasionally emit "toolName(...)" in the name field.
  // Strip invocation syntax and keep only the callable tool identifier.
  const fnLike = raw.match(/^([A-Za-z_][\w-]*)\s*\([\s\S]*\)$/);
  if (fnLike && fnLike[1]) raw = fnLike[1];
  raw = raw.replace(/[：:]+$/g, '');
  if (!raw) return '';
  const alias = TOOL_ALIASES[_lookupKey(raw)];
  if (alias) return alias;
  // keep original spelling for non-Claude tools, only normalize separators
  return raw.replace(/[\s-]+/g, '_');
}

function normalizeAgentRole(role) {
  const raw = _cleanName(role);
  if (!raw) return 'general';
  const mapped = AGENT_ROLE_ALIASES[_lookupKey(raw)];
  return mapped || raw.toLowerCase();
}

function normalizeToolParams(toolName, params = {}) {
  const normalizedTool = normalizeToolName(toolName);
  const src = (params && typeof params === 'object') ? { ...params } : {};

  if (normalizedTool === 'shell_command') {
    if (!src.command && typeof src.cmd === 'string') src.command = src.cmd;
    if (!src.command && typeof src.script === 'string') src.command = src.script;
  }

  if (normalizedTool === 'readFile' || normalizedTool === 'notebookRead') {
    if (!src.path && typeof src.file_path === 'string') src.path = src.file_path;
    if (!src.path && typeof src.filePath === 'string') src.path = src.filePath;
    if (!src.path && typeof src.file === 'string') src.path = src.file;
    if (src.offset === undefined && src.line_offset !== undefined) src.offset = src.line_offset;
    if (src.limit === undefined && src.max_lines !== undefined) src.limit = src.max_lines;
  }

  if (normalizedTool === 'writeFile') {
    if (!src.path && typeof src.file_path === 'string') src.path = src.file_path;
    if (!src.path && typeof src.filePath === 'string') src.path = src.filePath;
    if (src.content === undefined && typeof src.text === 'string') src.content = src.text;
  }

  if (normalizedTool === 'editFile' || normalizedTool === 'notebookEdit') {
    if (!src.file_path && typeof src.path === 'string') src.file_path = src.path;
    if (!src.file_path && typeof src.filePath === 'string') src.file_path = src.filePath;
    if (!src.file_path && typeof src.file === 'string') src.file_path = src.file;
    if (src.old_string === undefined && typeof src.oldText === 'string') src.old_string = src.oldText;
    if (src.new_string === undefined && typeof src.newText === 'string') src.new_string = src.newText;
    if (src.replace_all === undefined && src.replaceAll !== undefined) src.replace_all = Boolean(src.replaceAll);
  }

  if (normalizedTool === 'multiEdit') {
    if (!src.file_path && typeof src.path === 'string') src.file_path = src.path;
    if (!Array.isArray(src.edits)) {
      const singleOld = src.old_string ?? src.oldText;
      const singleNew = src.new_string ?? src.newText;
      if (singleOld !== undefined && singleNew !== undefined) {
        src.edits = [{
          old_string: singleOld,
          new_string: singleNew,
          replace_all: Boolean(src.replace_all ?? src.replaceAll),
        }];
      }
    } else {
      src.edits = src.edits.map((edit) => ({
        old_string: edit.old_string ?? edit.oldText,
        new_string: edit.new_string ?? edit.newText,
        replace_all: Boolean(edit.replace_all ?? edit.replaceAll),
      }));
    }
  }

  if (normalizedTool === 'ls') {
    if (!src.path && typeof src.dir === 'string') src.path = src.dir;
    if (!src.path && typeof src.directory === 'string') src.path = src.directory;
    if (src.recursive === undefined && src.recurse !== undefined) src.recursive = Boolean(src.recurse);
    if (src.max_entries === undefined && src.limit !== undefined) src.max_entries = src.limit;
  }

  if (normalizedTool === 'grep') {
    if (!src.pattern && typeof src.query === 'string') src.pattern = src.query;
  }

  if (normalizedTool === 'webSearch') {
    if (!src.query && typeof src.q === 'string') src.query = src.q;
  }

  if (normalizedTool === 'webFetch') {
    if (!src.url && typeof src.uri === 'string') src.url = src.uri;
    if (!src.url && typeof src.href === 'string') src.url = src.href;
  }

  if (normalizedTool === 'agent') {
    if (!src.prompt && typeof src.description === 'string') src.prompt = src.description;
    if (!src.prompt && typeof src.task === 'string') src.prompt = src.task;
    if (!src.prompt && typeof src.message === 'string') src.prompt = src.message;
    if (src.role || src.subagent_type || src.agent_type) {
      src.role = normalizeAgentRole(src.role || src.subagent_type || src.agent_type);
    }
    if (!src.preferred_adapter && typeof src.adapter === 'string') src.preferred_adapter = src.adapter;
    if (!src.preferred_adapter && typeof src.provider === 'string') src.preferred_adapter = src.provider;
    if (!src.preferred_model && typeof src.model === 'string') src.preferred_model = src.model;
  }

  if (normalizedTool === 'slashCommand') {
    if (!src.command && typeof src.cmd === 'string') src.command = src.cmd;
    if (!src.command && typeof src.name === 'string') src.command = src.name;
    if (!src.command && typeof src.text === 'string') src.command = src.text;
    if (typeof src.command === 'string') {
      const trimmed = src.command.trim();
      src.command = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    }
  }

  if (normalizedTool === 'spawnAgent') {
    if (!src.prompt && typeof src.message === 'string') src.prompt = src.message;
    if (!src.prompt && Array.isArray(src.items)) {
      const textItems = src.items.filter(i => i && i.type === 'text' && typeof i.text === 'string');
      if (textItems.length > 0) src.prompt = textItems.map(i => i.text).join('\n');
    }
    if (src.role || src.subagent_type || src.agent_type) {
      src.role = normalizeAgentRole(src.role || src.subagent_type || src.agent_type);
    }
    if (src.timeout === undefined && src.timeout_ms !== undefined) {
      const ms = Number(src.timeout_ms);
      if (Number.isFinite(ms) && ms > 0) src.timeout = Math.ceil(ms / 1000);
    }
    if (!src.preferred_adapter && typeof src.adapter === 'string') src.preferred_adapter = src.adapter;
    if (!src.preferred_adapter && typeof src.provider === 'string') src.preferred_adapter = src.provider;
    if (!src.preferred_model && typeof src.model === 'string') src.preferred_model = src.model;
  }

  if (normalizedTool === 'sendInput') {
    if (!src.agent_id && typeof src.target === 'string') src.agent_id = src.target;
    if (!src.agent_id && typeof src.id === 'string') src.agent_id = src.id;
    if (!src.message && typeof src.prompt === 'string') src.message = src.prompt;
  }

  if (normalizedTool === 'waitAgent') {
    if (!Array.isArray(src.targets) && typeof src.target === 'string') src.targets = [src.target];
    if (!Array.isArray(src.targets) && typeof src.agent_id === 'string') src.targets = [src.agent_id];
  }

  if (normalizedTool === 'closeAgent') {
    if (!src.agent_id && typeof src.target === 'string') src.agent_id = src.target;
    if (!src.agent_id && typeof src.id === 'string') src.agent_id = src.id;
  }

  if (normalizedTool === 'resumeAgent') {
    if (!src.agent_id && typeof src.id === 'string') src.agent_id = src.id;
    if (!src.agent_id && typeof src.target === 'string') src.agent_id = src.target;
  }

  if (normalizedTool === 'todoWrite') {
    if (!Array.isArray(src.todos) && Array.isArray(src.items)) src.todos = src.items;
    if (!Array.isArray(src.todos) && Array.isArray(src.list)) src.todos = src.list;
  }

  if (normalizedTool === 'apply_patch') {
    if (!src.patch && typeof src.diff === 'string') src.patch = src.diff;
    if (!src.patch && typeof src.content === 'string') src.patch = src.content;
  }

  return src;
}

function normalizeToolCall(toolName, params = {}) {
  let normalizedName = normalizeToolName(toolName);

  // Disambiguate 'search': if params contain 'query' (web search signature)
  // rather than 'pattern'/'regex'/'path' (grep signature), route to webSearch.
  if (normalizedName === 'search' && params && typeof params === 'object') {
    const hasWebParams = 'query' in params || 'q' in params;
    const hasGrepParams = 'pattern' in params || 'regex' in params || 'path' in params;
    if (hasWebParams && !hasGrepParams) {
      normalizedName = 'webSearch';
    }
  }

  const normalizedParams = normalizeToolParams(normalizedName || toolName, params);
  return {
    name: normalizedName || _cleanName(toolName),
    params: normalizedParams,
  };
}

// ── getClaudeCompatToolDefinitions() memoization (Ch2「不要每轮重建可复用结构」) ──
// getToolDefinitions() (local text-protocol / codex path) spreads this 22-def
// array on every request. It is a zero-arg pure map over the frozen module
// constant CLAUDE_COMPAT_TOOLS — the result never varies, so build it once and
// return the cached array. INVARIANT: downstream consumers are copy-on-write
// (getToolDefinitions dedup keeps refs but never mutates; collapseRedundant uses
// Object.assign({},…); toolParamNaming.canonicalizeDefs spreads {...def}) — none
// mutate the def objects in place, so a shared cached array is safe. Gate off →
// byte-identical fresh rebuild.
let _compatDefsCache = null;
function _isCompatDefsMemoEnabled() {
  const v = String(process.env.KHY_TOOL_COMPAT_DEFS_MEMO || '').trim().toLowerCase();
  return !(v === '0' || v === 'off' || v === 'false' || v === 'no');
}
function _buildClaudeCompatToolDefinitions() {
  return CLAUDE_COMPAT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: tool.parameters || {},
      required: [],
    },
    _compatCanonical: tool.canonical,
  }));
}
function getClaudeCompatToolDefinitions() {
  if (!_isCompatDefsMemoEnabled()) return _buildClaudeCompatToolDefinitions();
  if (_compatDefsCache === null) _compatDefsCache = _buildClaudeCompatToolDefinitions();
  return _compatDefsCache;
}

function getClaudeCompatToolList() {
  return CLAUDE_COMPAT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.category,
    risk: tool.risk,
    canonical: tool.canonical,
    compatibility: 'claude',
  }));
}

module.exports = {
  normalizeToolName,
  normalizeToolParams,
  normalizeToolCall,
  normalizeAgentRole,
  getClaudeCompatToolDefinitions,
  getClaudeCompatToolList,

  // getClaudeCompatToolDefinitions memo (Ch2) — exported for unit testing.
  _buildClaudeCompatToolDefinitions,
  _resetCompatDefsMemo: () => { _compatDefsCache = null; },
};
