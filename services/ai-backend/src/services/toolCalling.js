/**
 * Tool Calling System — enable AI models to invoke tools with user confirmation.
 *
 * Architecture:
 * 1. Tools are registered (built-in + MCP servers + user plugins)
 * 2. AI generates tool_use requests during conversation
 * 3. System prompts user for confirmation (unless dangerous mode)
 * 4. Tool executes and result feeds back to AI
 *
 * Security:
 * - All tool calls require explicit user approval by default
 * - "Dangerous mode" (--dangerous / KHYQUANT_DANGEROUS=true) skips confirmation
 * - Dangerous mode requires explicit user acknowledgment on first enable
 * - Tool permissions can be pre-approved per tool or per category
 *
 * Inspired by: Claude Code permission model, Claw tool calling, MCP protocol
 */
const readline = require('readline');
const chalk = require('chalk').default || require('chalk');
const path = require('path');
const fs = require('fs');
const os = require('os');

// 数据家单一真源:复用主 backend 的 getAppDataDir(),与 backend 同根
// (避免全新 HOME 上 .khy / .khyquant 双写)。见 ../utils/dataHome。
const { getAppDataDir } = require('../utils/dataHome');
const PERMISSIONS_FILE = getAppDataDir('tool_permissions.json');

// Tool categories and risk levels
const RISK_LEVELS = {
  safe: { label: '安全', color: 'green', autoApprove: true },
  low: { label: '低风险', color: 'cyan', autoApprove: false },
  medium: { label: '中风险', color: 'yellow', autoApprove: false },
  high: { label: '高风险', color: 'red', autoApprove: false },
  critical: { label: '危险', color: 'redBright', autoApprove: false },
};

// Built-in tools available for AI to call
const BUILTIN_TOOLS = [
  {
    name: 'quote',
    description: 'Get real-time stock/futures quote',
    category: 'data',
    risk: 'safe',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Stock/futures symbol code' },
    },
    handler: async (params) => {
      try {
        const { handleQuote } = require('../cli/handlers/data');
        await handleQuote(params.symbol);
        return { success: true };
      } catch {
        return { success: false, error: '行情查询功能仅在主 CLI 中可用（ai-backend 不含 cli 模块）' };
      }
    },
  },
  {
    name: 'backtest',
    description: 'Run strategy backtest',
    category: 'analysis',
    risk: 'safe',
    parameters: {
      symbol: { type: 'string', required: true },
      strategy: { type: 'string', required: false },
      start: { type: 'string', required: false },
      end: { type: 'string', required: false },
      capital: { type: 'number', required: false },
    },
    handler: async (params) => {
      try {
        const { handleBacktestRun } = require('../cli/handlers/backtest');
        await handleBacktestRun(params.symbol, params);
        return { success: true };
      } catch {
        return { success: false, error: '回测功能仅在主 CLI 中可用（ai-backend 不含 cli 模块）' };
      }
    },
  },
  {
    name: 'data_fetch',
    description: 'Download K-line data for a symbol',
    category: 'data',
    risk: 'safe',
    parameters: {
      symbol: { type: 'string', required: true },
    },
    handler: async (params) => {
      try {
        const { handleDataFetch } = require('../cli/handlers/data');
        await handleDataFetch(params.symbol);
        return { success: true };
      } catch {
        return { success: false, error: '数据下载功能仅在主 CLI 中可用（ai-backend 不含 cli 模块）' };
      }
    },
  },
  {
    name: 'search',
    description: 'Search for instruments by name/code',
    category: 'data',
    risk: 'safe',
    parameters: {
      keyword: { type: 'string', required: true },
    },
    handler: async (params) => {
      try {
        const { resolveSymbol } = require('../cli/symbolResolver');
        const result = await resolveSymbol(params.keyword);
        return { success: true, result };
      } catch {
        return { success: false, error: '证券搜索功能仅在主 CLI 中可用（ai-backend 不含 cli 模块）' };
      }
    },
  },
  {
    name: 'execute_code',
    description: 'Execute JavaScript code in sandbox',
    category: 'execution',
    risk: 'high',
    parameters: {
      code: { type: 'string', required: true, description: 'JavaScript code to execute' },
    },
    handler: async (params) => {
      // Sandboxed execution via VM with timeout guard
      const vm = require('vm');
      const sandbox = { result: null, console: { log: (...args) => { sandbox._output = (sandbox._output || '') + args.join(' ') + '\n'; } } };
      const context = vm.createContext(sandbox);
      await Promise.resolve(vm.runInContext(params.code, context, { timeout: 5000 }));
      return { success: true, output: sandbox._output || '', result: sandbox.result };
    },
  },
  {
    name: 'shell_command',
    description: 'Execute a shell command',
    category: 'system',
    risk: 'critical',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run' },
    },
    handler: async (params) => {
      // Block shell commands that could read KHY-Quant protected source
      const cmd = params.command;
      try {
        const { isProtectedPath } = require('./selfOptimizer');
        const khyRoot = path.resolve(__dirname, '../..');
        // Block: cat/less/head/tail/grep/find on KHY source dirs
        const readPatterns = /\b(cat|less|head|tail|more|strings|xxd|hexdump)\s/;
        if (readPatterns.test(cmd)) {
          const pathMatch = cmd.match(/\s(\/\S+|\.\.\/\S+|\.\S+)/);
          if (pathMatch) {
            const target = path.resolve(process.env.KHYQUANT_CWD || process.cwd(), pathMatch[1]);
            if (isProtectedPath(target)) {
              return { success: false, error: 'Access denied: Cannot read KHY-Quant core source files via shell' };
            }
          }
        }
        // Block any command referencing KHY backend/src or frontend/src directly
        if (cmd.includes(path.join(khyRoot, 'backend', 'src')) || cmd.includes(path.join(khyRoot, 'frontend', 'src'))) {
          return { success: false, error: 'Access denied: KHY-Quant source directories are protected' };
        }
      } catch {}
      const { execSync } = require('child_process');
      const result = (() => {
        try {
          const stdout = execSync(params.command, { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
          return { exitCode: 0, stdout, stderr: '' };
        } catch (e) {
          return { exitCode: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
        }
      })();
      if (result.exitCode !== 0) {
        return { success: false, output: result.stdout, error: result.stderr, exitCode: result.exitCode };
      }
      return { success: true, output: result.stdout };
    },
  },
  {
    name: 'read_file',
    description: 'Read contents of a file',
    category: 'filesystem',
    risk: 'low',
    parameters: {
      path: { type: 'string', required: true },
    },
    handler: async (params) => {
      // Block access to KHY-Quant protected source files
      try {
        const { isProtectedPath } = require('./selfOptimizer');
        if (isProtectedPath(params.path)) {
          return { success: false, error: 'Access denied: KHY-Quant core source files are protected' };
        }
      } catch {}
      const content = fs.readFileSync(params.path, 'utf-8');
      return { success: true, content: content.slice(0, 10000) };
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file',
    category: 'filesystem',
    risk: 'high',
    parameters: {
      path: { type: 'string', required: true },
      content: { type: 'string', required: true },
    },
    handler: async (params) => {
      // Block writes to KHY-Quant protected source files
      try {
        const { isProtectedPath } = require('./selfOptimizer');
        if (isProtectedPath(params.path)) {
          return { success: false, error: 'Access denied: Cannot modify KHY-Quant core source files' };
        }
      } catch {}
      fs.writeFileSync(params.path, params.content, 'utf-8');
      return { success: true };
    },
  },
  {
    name: 'strategy_list',
    description: 'List available trading strategies',
    category: 'data',
    risk: 'safe',
    parameters: {},
    handler: async () => {
      try {
        const { Strategy } = require('@khy/shared/models');
        const strategies = await Strategy.findAll({ raw: true });
        return { success: true, strategies };
      } catch {
        return { success: false, error: 'Database not available' };
      }
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for current information (news, docs, prices, tech specs, etc.)',
    category: 'data',
    risk: 'safe',
    parameters: {
      query: { type: 'string', required: true, description: 'Search query (max 200 characters)' },
    },
    handler: async (params) => {
      const webSearch = require('./webSearchService');
      return webSearch.search(params.query);
    },
  },
  // ── Git tools ──
  {
    name: 'git_status',
    description: 'Show git repository status (staged, modified, untracked files)',
    category: 'git',
    risk: 'safe',
    parameters: {},
    handler: async () => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const output = execSync('git status', { cwd, timeout: 5000, encoding: 'utf-8' });
      return { success: true, output };
    },
  },
  {
    name: 'git_diff',
    description: 'Show staged and unstaged changes',
    category: 'git',
    risk: 'safe',
    parameters: {
      staged: { type: 'boolean', required: false, description: 'Show only staged changes' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const cmd = params.staged ? 'git diff --cached' : 'git diff';
      const output = execSync(cmd, { cwd, timeout: 10000, encoding: 'utf-8' });
      return { success: true, output: output.slice(0, 10000) };
    },
  },
  {
    name: 'git_log',
    description: 'Show recent commit history',
    category: 'git',
    risk: 'safe',
    parameters: {
      count: { type: 'number', required: false, description: 'Number of commits (default 10)' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const n = Math.min(params.count || 10, 50);
      const output = execSync(`git log --oneline -${n}`, { cwd, timeout: 5000, encoding: 'utf-8' });
      return { success: true, output };
    },
  },
  {
    name: 'git_add',
    description: 'Stage files for commit',
    category: 'git',
    risk: 'low',
    parameters: {
      files: { type: 'string', required: true, description: 'File paths to stage (space-separated, or "." for all)' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      execSync(`git add ${params.files}`, { cwd, timeout: 5000, encoding: 'utf-8' });
      return { success: true, output: `Staged: ${params.files}` };
    },
  },
  {
    name: 'git_commit',
    description: 'Create a git commit with a message',
    category: 'git',
    risk: 'medium',
    parameters: {
      message: { type: 'string', required: true, description: 'Commit message' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      // Escape double quotes in message
      const msg = params.message.replace(/"/g, '\\"');
      const output = execSync(`git commit -m "${msg}"`, { cwd, timeout: 10000, encoding: 'utf-8' });
      return { success: true, output };
    },
  },
  {
    name: 'git_push',
    description: 'Push commits to remote repository',
    category: 'git',
    risk: 'high',
    parameters: {
      remote: { type: 'string', required: false, description: 'Remote name (default: origin)' },
      branch: { type: 'string', required: false, description: 'Branch name' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const remote = params.remote || 'origin';
      const branch = params.branch || '';
      const output = execSync(`git push ${remote} ${branch}`.trim(), { cwd, timeout: 30000, encoding: 'utf-8' });
      return { success: true, output };
    },
  },
  {
    name: 'git_branch',
    description: 'List or create branches',
    category: 'git',
    risk: 'low',
    parameters: {
      name: { type: 'string', required: false, description: 'New branch name (omit to list)' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const cmd = params.name ? `git branch ${params.name}` : 'git branch -a';
      const output = execSync(cmd, { cwd, timeout: 5000, encoding: 'utf-8' });
      return { success: true, output };
    },
  },
  {
    name: 'git_checkout',
    description: 'Switch to a branch or restore files',
    category: 'git',
    risk: 'medium',
    parameters: {
      target: { type: 'string', required: true, description: 'Branch name or file path' },
    },
    handler: async (params) => {
      const { execSync } = require('child_process');
      const cwd = process.env.KHYQUANT_CWD || process.cwd();
      const output = execSync(`git checkout ${params.target}`, { cwd, timeout: 5000, encoding: 'utf-8' });
      return { success: true, output };
    },
  },
  // ── Self-optimization tools ──
  {
    name: 'optimize_config',
    description: 'Safely update AI configuration (system prompt, agent roles, prompt library). Hot-update, no restart needed.',
    category: 'optimization',
    risk: 'medium',
    parameters: {
      target: { type: 'string', required: true, description: 'Config target: system_prompt | agent_roles | prompt_library' },
      content: { type: 'string', required: true, description: 'New content for the config' },
      reason: { type: 'string', required: true, description: 'Why this optimization' },
    },
    handler: async (params) => {
      const optimizer = require('./selfOptimizer');
      return optimizer.applyOptimization(params.target, params.content, params.reason);
    },
  },
  {
    name: 'propose_code_change',
    description: 'Propose a source code change via git branch (requires user review, does not affect running code)',
    category: 'optimization',
    risk: 'high',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Absolute path to the source file' },
      content: { type: 'string', required: true, description: 'Proposed new file content' },
      description: { type: 'string', required: true, description: 'What was changed and why' },
    },
    handler: async (params) => {
      const optimizer = require('./selfOptimizer');
      return optimizer.proposeCodeChange(params.file_path, params.content, params.description);
    },
  },
];

// State
let _dangerousMode = false;
let _permissions = null;
let _mcpServers = [];
let _allTools = [...BUILTIN_TOOLS];

/**
 * Load saved tool permissions.
 */
function loadPermissions() {
  if (_permissions) return _permissions;
  try {
    if (fs.existsSync(PERMISSIONS_FILE)) {
      _permissions = JSON.parse(fs.readFileSync(PERMISSIONS_FILE, 'utf-8'));
    }
  } catch { /* ignore */ }
  _permissions = _permissions || { approved: {}, denied: {}, dangerousAcknowledged: false };
  return _permissions;
}

/**
 * Save permissions to disk.
 */
function savePermissions() {
  try {
    const dir = path.dirname(PERMISSIONS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PERMISSIONS_FILE, JSON.stringify(_permissions, null, 2), 'utf-8');
  } catch { /* ignore */ }
}

/**
 * Enable dangerous mode (skip all confirmations).
 * Returns false if user hasn't acknowledged the warning yet.
 */
function enableDangerousMode() {
  const perms = loadPermissions();
  _dangerousMode = true;
  return perms.dangerousAcknowledged === true;
}

/**
 * Acknowledge dangerous mode warning (first-time).
 */
function acknowledgeDangerousMode() {
  const perms = loadPermissions();
  perms.dangerousAcknowledged = true;
  savePermissions();
  _dangerousMode = true;
}

function isDangerousMode() {
  return _dangerousMode;
}

function disableDangerousMode() {
  _dangerousMode = false;
}

/**
 * Check if a tool call is pre-approved.
 */
function isApproved(toolName) {
  const perms = loadPermissions();
  return perms.approved[toolName] === true;
}

/**
 * Pre-approve a tool (remember for session).
 */
function approveTool(toolName, persist = false) {
  const perms = loadPermissions();
  perms.approved[toolName] = true;
  if (persist) savePermissions();
}

/**
 * Get the risk level info for a tool.
 */
function getToolRisk(toolName) {
  const tool = _allTools.find(t => t.name === toolName);
  if (!tool) return RISK_LEVELS.medium;
  return RISK_LEVELS[tool.risk] || RISK_LEVELS.medium;
}

/**
 * Format tool call for display to user (for confirmation prompt).
 */
function formatToolCall(toolName, params) {
  const tool = _allTools.find(t => t.name === toolName);
  const risk = getToolRisk(toolName);
  const riskColor = chalk[risk.color] || chalk.yellow;

  let display = '';
  display += chalk.bold(`  🔧 工具调用: ${toolName}\n`);
  display += `  ${riskColor(`[${risk.label}]`)} ${tool?.description || ''}\n`;

  if (params && Object.keys(params).length > 0) {
    display += chalk.dim('  参数:\n');
    for (const [key, value] of Object.entries(params)) {
      const displayVal = typeof value === 'string' && value.length > 100
        ? value.slice(0, 100) + '...'
        : JSON.stringify(value);
      display += chalk.dim(`    ${key}: `) + displayVal + '\n';
    }
  }

  return display;
}

/**
 * Request user confirmation for a tool call.
 * Returns: 'allow' | 'allow-session' | 'allow-always' | 'deny'
 *
 * Interactive selection (Claude Code style):
 *   1. Yes             — Execute this time only
 *   2. Yes, allow all  — Trust this tool for current session (shift+tab)
 *   3. No              — Refuse execution
 *   Esc to cancel · Tab to amend
 */
async function requestPermission(toolName, params) {
  // Auto-approve safe tools
  const tool = _allTools.find(t => t.name === toolName);
  if (tool && tool.risk === 'safe') return 'allow';

  // Dangerous mode = auto-approve everything
  if (_dangerousMode) return 'allow';

  // Previously approved (persisted or session)
  if (isApproved(toolName)) return 'allow';

  // Ask user with detailed display
  console.log('');
  console.log(formatToolCall(toolName, params));

  // Show reasoning if available
  if (params._reasoning) {
    console.log(chalk.dim('  💭 AI 思考:'));
    console.log(chalk.dim(`     ${params._reasoning}`));
    console.log('');
  }

  // Interactive selection (Claude Code style)
  const riskInfo = getToolRisk(toolName);
  const question = chalk.yellow(`  Do you want to execute `) + chalk.bold(toolName) + chalk.yellow('?');
  console.log(question);
  console.log(`  ${chalk.white('❯ 1.')} ${chalk.green('Yes')}`);
  console.log(`    ${chalk.white('2.')} ${chalk.cyan('Yes, allow all during this session')} ${chalk.dim('(shift+tab)')}`);
  console.log(`    ${chalk.white('3.')} ${chalk.red('No')}`);
  console.log('');
  console.log(chalk.dim('  Esc to cancel · Tab to amend'));

  const answer = await askUser(chalk.dim('  > '));
  const normalized = answer.trim().toLowerCase();

  switch (normalized) {
    case '1':
    case 'y':
    case 'yes':
    case '':
      return 'allow';

    case '2':
    case 's':
    case 'session':
      approveTool(toolName, false); // Session only (not persisted)
      console.log(chalk.green(`  ✓ Trusted "${toolName}" for this session`));
      return 'allow-session';

    case 'a':
    case 'always':
    case 'trust':
      approveTool(toolName, true); // Persist to disk
      console.log(chalk.green(`  ✓ Permanently trusted "${toolName}"`));
      return 'allow-always';

    case '3':
    case 'n':
    case 'no':
    case 'deny':
      console.log(chalk.red(`  ✗ Denied "${toolName}"`));
      return 'deny';

    default:
      // Unknown input = deny for safety
      console.log(chalk.red(`  ✗ Unrecognized input, denied`));
      return 'deny';
  }
}

/**
 * Execute a tool call with permission checking.
 */
async function executeTool(toolName, params = {}) {
  const tool = _allTools.find(t => t.name === toolName);
  if (!tool) {
    return { success: false, error: `Unknown tool: ${toolName}` };
  }

  // Check permission
  const permission = await requestPermission(toolName, params);
  if (permission === 'deny') {
    return { success: false, error: 'User denied tool execution', denied: true };
  }

  // Execute
  try {
    const result = await tool.handler(params);
    return result;
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Get the tool definitions in Claude/OpenAI function-calling format.
 * Used when sending messages to AI models that support tool use.
 */
function getToolDefinitions() {
  return _allTools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: {
      type: 'object',
      properties: Object.fromEntries(
        Object.entries(tool.parameters || {}).map(([key, spec]) => [
          key,
          { type: spec.type || 'string', description: spec.description || '' },
        ])
      ),
      required: Object.entries(tool.parameters || {})
        .filter(([, spec]) => spec.required)
        .map(([key]) => key),
    },
  }));
}

/**
 * Register an MCP server connection.
 */
function registerMCPServer(server) {
  _mcpServers.push(server);
  // Register MCP tools into the tool registry
  if (server.tools) {
    for (const tool of server.tools) {
      _allTools.push({
        name: `mcp_${server.name}_${tool.name}`,
        description: `[MCP:${server.name}] ${tool.description}`,
        category: 'mcp',
        risk: 'medium',
        parameters: tool.inputSchema?.properties || {},
        handler: async (params) => {
          return server.callTool(tool.name, params);
        },
      });
    }
  }
}

/**
 * Register a custom tool (from plugin or skill).
 */
function registerTool(tool) {
  if (!tool.name || !tool.handler) throw new Error('Tool must have name and handler');
  tool.risk = tool.risk || 'medium';
  tool.category = tool.category || 'custom';
  _allTools.push(tool);
}

/**
 * List all registered tools.
 */
function listTools() {
  return _allTools.map(t => ({
    name: t.name,
    description: t.description,
    category: t.category,
    risk: t.risk,
  }));
}

/**
 * Get MCP servers.
 */
function getMCPServers() {
  return _mcpServers;
}

// ── Helper ──

function askUser(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

module.exports = {
  // Core
  executeTool,
  getToolDefinitions,
  listTools,
  formatToolCall,

  // Permissions
  requestPermission,
  enableDangerousMode,
  disableDangerousMode,
  isDangerousMode,
  acknowledgeDangerousMode,
  approveTool,
  isApproved,

  // Registration
  registerTool,
  registerMCPServer,
  getMCPServers,

  // Constants
  RISK_LEVELS,
  BUILTIN_TOOLS,
};
