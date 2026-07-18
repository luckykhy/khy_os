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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * [AI-弱模型·别绕过] 本文件是**唯一工具执行漏斗**:每一条运行时路径(主 toolUseLoop、本地小模型
 * localToolLoop、子代理、直接调用)都经 executeTool() 落地。其权限判定是一条**有序 fail-closed 链**。
 * 弱模型/不受信模型改动本文件前务必守住:
 *   1) 绝不在权限链中间早 return 跳过后续闸;绝不另开一个绕过 executeTool 的执行入口。
 *   2) PreToolUse 硬底(见 executeTool 内)在所有权限闸之前无条件运行,即便 bypass 模式也绕不过——勿短路。
 *   3) 要加能力,加在链**末尾**且默认 fail-closed;判定逻辑写成纯叶子(照 goalStopGate.js)。
 * 拿不准这里能不能改 → 调 WeakModelGuidance 工具查该位点的护栏与示范。
 * ─────────────────────────────────────────────────────────────────────────────
 */
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  normalizeToolName,
  normalizeToolParams,
  getClaudeCompatToolDefinitions,
  getClaudeCompatToolList,
} = require('./claudeCompat');
const { rewriteWindowsDesktopPath } = require('../utils/pathCompat');
// Capability matrix (cut 1): post-tool governance seams consult the registry
// instead of inline `process.env.KHY_*` checks. Byte-identical by construction
// (offDisables kind + PRE.always) — see capabilityMatrix/descriptors.js.
const { getCapabilityMatrix } = require('./capabilityMatrix');
const { SEAMS: CAP_SEAMS } = require('./capabilityMatrix/seams');
// Schema validation for builtin-source tools (registry-source tools carry their
// own .validate()). `_baseTool` is a leaf module (no cycle with toolCalling).
const { validateParams } = require('../tools/_baseTool');
// 工具结果结构化归一(leaf,无环):MCP 工具 handler 返回原始协议形
// `{content:[...], isError}`(无 success、content 是数组)。executeTool 成功路径原样透出会让
// 直连消费者把成功 MCP 调用误判为失败。用 canonical normalizeToolResult 归一(单一真源,零方言分歧)。
const { normalizeToolResult, _isMCPCallToolResult } = require('../tools/_toolResultNormalizer');
// flag 中央注册表:门控 KHY_MCP_RESULT_NORMALIZE(默认开)从声明式真源解析,不再 inline `_off`。
const flagRegistry = require('./flagRegistry');
// App-launch pure leaves (fail-soft: a missing bundled copy must never crash the
// tool layer — both have byte-identical fallbacks baked in).
//   - winAppPaths: parse Windows `App Paths` registry into installed-app records
//     (gate KHY_APP_PATHS_REGISTRY) — fixes "installed app not found" spinning.
//   - launchOutcome: honest "已启动" wording on a clean spawn
//     (gate KHY_LAUNCH_TRUST_SPAWN) — fixes the alarming "未验证" phrasing.
let _winAppPaths; try { _winAppPaths = require('./winAppPaths'); } catch { _winAppPaths = null; }
let _launchOutcome; try { _launchOutcome = require('./launchOutcome'); } catch { _launchOutcome = null; }

// ── Per-tool capability policy ────────────────────────────────────
let _toolPolicyCache = null;
let _toolPolicyCacheMtime = 0;

function _loadToolPolicy() {
  const home = String(process.env.HOME || process.env.USERPROFILE || '').trim();
  const policyPath = process.env.KHY_CAPABILITY_POLICY_FILE
    || (home ? path.join(home, '.khyquant', 'capability-policy.json') : '');
  if (!policyPath) return null;
  try {
    const st = fs.statSync(policyPath);
    if (_toolPolicyCache && st.mtimeMs === _toolPolicyCacheMtime) return _toolPolicyCache;
    const raw = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
    _toolPolicyCache = raw;
    _toolPolicyCacheMtime = st.mtimeMs;
    return raw;
  } catch { return _toolPolicyCache || null; }
}

/**
 * Check if a tool is blocked by enterprise capability policy.
 * Policy file supports:
 *   blockedTools: string[] — tools that cannot be called
 *   allowedTools: string[] — if set, only these tools can be called (allowlist mode)
 * @returns {string|null} block reason, or null if allowed
 */
/**
 * Constraint-lattice liveness glue (§4.D). Suppress a policy block reason when
 * the tool is a guaranteed-feasible escape action (ask_user/abort), so no
 * allowlist/whitelist can prune A(s) to empty. Any other block passes through.
 * Best-effort: if the lattice module is unavailable, keep the original block.
 * @returns {string|null}
 */
function _latticeLiveness(toolName, blockReason) {
  try {
    return require('./constraintLattice').feasibleUnderPolicy(toolName, blockReason);
  } catch {
    return blockReason || null;
  }
}

function _checkToolPolicy(normalizedName, originalName) {
  if (process.env.KHY_TOOL_POLICY === 'false') return null;
  const policy = _loadToolPolicy();
  if (!policy) return null;
  const names = [normalizedName, originalName].filter(Boolean).map(n => n.toLowerCase());

  // Blocklist check
  if (Array.isArray(policy.blockedTools) && policy.blockedTools.length > 0) {
    const blocked = policy.blockedTools.map(t => t.toLowerCase());
    for (const name of names) {
      if (blocked.includes(name)) {
        // Liveness (§4.D): even an explicit blocklist may not prune an escape
        // action, or A(s) could be emptied. Floor actions are suppressed here.
        return _latticeLiveness(originalName || normalizedName,
          `Tool "${originalName || normalizedName}" is blocked by capability policy (blockedTools).`);
      }
    }
  }

  // Allowlist check (if set, only listed tools are permitted)
  if (Array.isArray(policy.allowedTools) && policy.allowedTools.length > 0) {
    const allowed = policy.allowedTools.map(t => t.toLowerCase());
    const isAllowed = names.some(name => allowed.includes(name));
    if (!isAllowed) {
      // Liveness (§4.D, Π_C): an allowlist may never prune an escape action
      // (ask_user/abort), or A(s) could be emptied and the agent wedged. Let the
      // constraint lattice suppress the block for a floor action.
      return _latticeLiveness(originalName || normalizedName,
        `Tool "${originalName || normalizedName}" is not in the capability policy allowlist (allowedTools).`);
    }
  }

  return null;
}

/**
 * Check if a tool is blocked by the currently active skill's `allowed-tools`
 * whitelist (A1). When a skill with a non-empty `allowedTools` list is the
 * active execution context (set by skills/index.js executeSkill around handler
 * runs), only tools on that list may run. A skill with no whitelist (the common
 * case) imposes no restriction. Shares the KHY_TOOL_POLICY kill switch.
 *
 * @param {string} normalizedName
 * @param {string} originalName
 * @returns {string|null} block reason, or null if allowed
 */
function _checkActiveSkillPolicy(normalizedName, originalName) {
  if (process.env.KHY_TOOL_POLICY === 'false') return null;
  let active = null;
  try {
    active = require('./activeSkillContext').getActiveSkill();
  } catch { return null; }
  if (!active || !Array.isArray(active.allowedTools) || active.allowedTools.length === 0) {
    return null;
  }
  const allowed = active.allowedTools.map(t => String(t).toLowerCase());
  const names = [normalizedName, originalName].filter(Boolean).map(n => n.toLowerCase());
  const isAllowed = names.some(name => allowed.includes(name));
  if (!isAllowed) {
    // Liveness (§4.D): the escape floor (ask_user/abort) survives any skill
    // whitelist too, so A(s) is never emptied by a restrictive active skill.
    return _latticeLiveness(originalName || normalizedName,
      `Tool "${originalName || normalizedName}" is not in the active skill "${active.name}" allowed-tools whitelist.`);
  }
  return null;
}

let _chalk;
const chalk = () => (_chalk ??= (require('chalk').default || require('chalk')));

// Expand ~ and ~user in file paths to absolute paths
function expandPath(p) {
  if (!p || typeof p !== 'string') return p;
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

function _trimWrappingQuotes(value) {
  return String(value || '').trim().replace(/^['"`]+|['"`]+$/g, '').trim();
}

function _looksLikeFilesystemTarget(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return false;
  return text.startsWith('~/')
    || text.startsWith('./')
    || text.startsWith('../')
    || text.startsWith('.\\')
    || text.startsWith('..\\')
    || text.startsWith('/')
    || text.startsWith('\\')
    || /^[A-Za-z]:[\\/]/.test(text)
    || /\.[A-Za-z0-9]{1,10}$/.test(text);
}

function _resolveExistingFilesystemTarget(input = '') {
  const normalizedInput = rewriteWindowsDesktopPath(_trimWrappingQuotes(input));
  if (!normalizedInput || !_looksLikeFilesystemTarget(normalizedInput)) return '';

  const cwd = process.env.KHYQUANT_CWD || process.cwd();
  const candidates = [];
  const pushCandidate = (value) => {
    const candidate = String(value || '').trim();
    if (!candidate) return;
    if (!candidates.includes(candidate)) candidates.push(candidate);
  };

  const expandedRaw = expandPath(normalizedInput);
  pushCandidate(expandedRaw);

  const absoluteLike = path.isAbsolute(expandedRaw)
    || /^[A-Za-z]:[\\/]/.test(expandedRaw)
    || /^\\\\/.test(expandedRaw);
  if (!absoluteLike) {
    pushCandidate(path.resolve(cwd, expandedRaw));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* ignore invalid filesystem candidates */ }
  }
  return '';
}

async function _openFilesystemTarget(targetPath = '') {
  const absPath = String(targetPath || '').trim();
  if (!absPath) return { success: false, error: 'Target path is required' };

  const launchers = [];
  if (process.platform === 'win32') {
    launchers.push({
      command: 'explorer.exe',
      args: [absPath],
      hint: `explorer.exe ${absPath}`,
    });
  } else if (process.platform === 'darwin') {
    launchers.push({
      command: 'open',
      args: [absPath],
      hint: `open ${absPath}`,
    });
  } else {
    if (_commandExists('xdg-open')) {
      launchers.push({
        command: 'xdg-open',
        args: [absPath],
        hint: `xdg-open ${absPath}`,
      });
    }
    if (_commandExists('gio')) {
      launchers.push({
        command: 'gio',
        args: ['open', absPath],
        hint: `gio open ${absPath}`,
      });
    }
  }

  if (launchers.length === 0) {
    return {
      success: false,
      error: `No launcher is available to open path: ${absPath}`,
      hint: 'Install xdg-open/gio (Linux) or use a desktop session that supports opening files.',
    };
  }

  let lastError = null;
  for (const launcher of launchers) {
    try {
      await _spawnDetached(launcher.command, launcher.args, {
        env: { ...process.env },
      });
      return {
        success: true,
        launcher: launcher.hint,
        output: `已打开目标: ${absPath}`,
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    success: false,
    error: `Failed to open path ${absPath}: ${lastError?.message || 'launcher failed'}`,
  };
}

function _normalizePathLikeParams(params = {}) {
  if (!params || typeof params !== 'object') return params;
  const out = { ...params };
  const pathLikeKeys = [
    'path',
    'file_path',
    'filePath',
    'inputPath',
    'outputPath',
    'directory',
    'dir',
  ];
  for (const key of pathLikeKeys) {
    if (typeof out[key] === 'string' && out[key].trim()) {
      out[key] = rewriteWindowsDesktopPath(out[key]);
    }
  }
  return out;
}

// ── 应用启动与检测(已抽取为叶子 ./toolCallingAppLaunch.js)──────────────────
// GUI 探测 / 已安装应用索引与别名匹配 / 跨平台启动验证 / open-default 目标解析。全部
// 应用缓存态私有于叶子。宿主 open_app 处理器、_openFilesystemTarget、module.exports 按
// **同名 re-import** 接回,调用点字节不变。刻意非纯零 IO 叶子(fs/spawn/懒加载)。
const {
  APP_ALIAS_MAP, _normalizeAppQuery, _buildAppCandidates, _matchInstalledApp,
  hasInstalledAppMatch, _primeInstalledAppsForTest, _resolveOpenDefaultTarget,
  _hasGraphicalSession, _getInstalledApps, _commandExists, _spawnDetached,
  _inferWindowsImageName, _getWindowsProcessPids, _verifyWindowsLaunch,
  _formatLaunchOutput, _splitExecLine, _launchLinuxDesktopEntry,
} = require('./toolCallingAppLaunch');

// ── 内置工具定义与风险表(已抽取为叶子 ./toolCallingBuiltins.js)──────────────
// BUILTIN_TOOLS(含 open_app 等 handler)+ RISK_LEVELS + PERMISSIONS_FILE。open_app
// handler 复用 app-launch 兄弟叶子。宿主 _allTools(`[...BUILTIN_TOOLS]`)、loadPermissions/
// savePermissions、module.exports 按**同名 re-import** 接回,调用点字节不变。
const { PERMISSIONS_FILE, RISK_LEVELS, BUILTIN_TOOLS } = require('./toolCallingBuiltins');

// State

// ── 权限子系统(已抽取为叶子 ./toolCallingPermissions.js)──────────────────────
// 权限模式/档案、审批持久化、危险模式、requestPermission 有序 fail-closed 决策链、readline
// 注入、preflight 上下文、formatToolCall/getToolRisk。全部权限可变态(_permissions /
// _permissionMode / _preflightContext / _rlProvider)私有于叶子。叶子经 setPermissionResolvers
// 注入宿主 _resolveToolDescriptor / _findBuiltinTool(打破两条反向边,零环;仿既有
// setReadlineProvider DI)。宿主 executeTool 与 module.exports 按**同名 re-import** 接回,调用点
// 字节不变。
const {
  PERMISSION_MODES, permissionModeToProfile, setPermissionMode, getPermissionMode,
  enableDangerousMode, acknowledgeDangerousMode, isDangerousMode, disableDangerousMode,
  isApproved, approveTool, getToolRisk, formatToolCall, _decisionFromControl,
  _resolveToolBehavior, requestPermission, _ACCEPT_EDITS_TOOLS,
  setPreflightContext, clearPreflightContext, setReadlineProvider, getReadlineProvider,
  setPermissionResolvers,
} = require('./toolCallingPermissions');
// 注入权限链所需的两个宿主解析器(无环 host→leaf;函数声明已提升,加载时可引用)。
setPermissionResolvers({ resolveToolDescriptor: _resolveToolDescriptor, findBuiltinTool: _findBuiltinTool });
let _mcpServers = [];
let _allTools = [...BUILTIN_TOOLS];

// Register chain_run tool (LangChain-compatible chain execution)
try {
  const chainWasm = require('./chainWasm');
  _allTools.push({
    name: 'chain_run',
    description: 'Execute a LangChain-compatible chain by name. Available chains: echo, template, react-parse.',
    category: 'ai',
    risk: 'low',
    parameters: {
      chain: { type: 'string', description: 'Chain name (echo, template, react-parse)', required: true },
      input: { type: 'string', description: 'Input text for the chain', required: true },
      template: { type: 'string', description: 'Prompt template with {key} placeholders (for template chain)' },
      keys: { type: 'array', description: 'Placeholder key names (for template chain)' },
      values: { type: 'array', description: 'Placeholder values (for template chain)' },
    },
    handler: async (params) => {
      const { chain, input, template, keys, values } = params || {};
      if (!chain) return { error: 'Missing chain name' };
      if (!input) return { error: 'Missing input' };
      if (chain === 'echo') {
        const tmpl = template || 'echo: {input}';
        return { output: chainWasm.renderTemplate(tmpl, ['input'], [input]) };
      }
      if (chain === 'react-parse') {
        return { output: chainWasm.parseReactResponse(input) };
      }
      if (chain === 'template') {
        const tmpl = template || '{input}';
        const k = keys || ['input'];
        const v = values || [input];
        return { output: chainWasm.renderTemplate(tmpl, k, v) };
      }
      return { error: `Unknown chain: ${chain}` };
    },
  });
} catch { /* chainWasm not available */ }

// ── Register local brain capabilities as tools (zero-cost, offline-capable) ──
try {
  const _offlineKnowledge = require('./offlineKnowledge');

  _allTools.push({
    name: 'local_knowledge',
    description: 'Query the offline knowledge base for unit conversions, HTTP status codes, programming cheat sheets (git/vim/docker/linux/npm/python/regex), common knowledge (provinces, speed of light, ASCII, port numbers, chmod), and regex patterns. Zero cost, no network needed.',
    category: 'local',
    risk: 'none',
    parameters: {
      query: { type: 'string', description: 'The question or lookup query in Chinese or English', required: true },
    },
    handler: async (params) => {
      const query = String(params?.query || '').trim();
      if (!query) return { error: 'Missing query' };
      const plan = _offlineKnowledge.detect(query);
      if (plan) {
        const result = _offlineKnowledge.execute(plan);
        if (result) return { output: result, type: plan.type };
      }
      return { error: `No offline knowledge found for: ${query}. Try rephrasing or use web_search instead.` };
    },
  });

  _allTools.push({
    name: 'unit_convert',
    description: 'Convert between units: length (mile/km/ft/m/inch/cm), weight (lb/kg/oz/g), temperature (Fahrenheit/Celsius), area (acre/hectare), volume (gallon/liter), data storage (TB/GB/MB/KB). Zero cost, no network needed.',
    category: 'local',
    risk: 'none',
    parameters: {
      query: { type: 'string', description: 'Conversion query, e.g. "1英里等于多少公里" or "100华氏度转摄氏"', required: true },
    },
    handler: async (params) => {
      const result = _offlineKnowledge.unitConvert(String(params?.query || ''));
      return result ? { output: result } : { error: 'Could not parse conversion. Format: "<number> <unit> 等于多少 <target>"' };
    },
  });

  _allTools.push({
    name: 'translate_snippet',
    description: 'Translate English text snippets to Chinese using a local 200-word dictionary. Suitable for rough translation of search results and error messages. No network needed.',
    category: 'local',
    risk: 'none',
    parameters: {
      text: { type: 'string', description: 'English text to translate', required: true },
    },
    handler: async (params) => {
      const result = _offlineKnowledge.translateSnippets(String(params?.text || ''));
      return { output: result };
    },
  });
} catch { /* offlineKnowledge not available */ }

// ── create_document tool — wraps docHelper.py text2docx ──────────
try {
  const _createDocPath = require('path').join(__dirname, '../tools/createDocument');
  const _createDocMod = require(_createDocPath);
  if (_createDocMod && typeof _createDocMod.execute === 'function') {
    _allTools.push({
      name: 'create_document',
      description: 'Create a Word (.docx) document from text. Use for reports, articles, travel guides, etc. Accepts content (text with newlines for paragraphs), outputPath (e.g. ~/Desktop/report.docx), and optional title. Supports Chinese and English.',
      category: 'filesystem',
      risk: 'medium',
      parameters: {
        content: { type: 'string', description: 'Document text content, newlines separate paragraphs', required: true },
        outputPath: { type: 'string', description: 'Save path, e.g. ~/Desktop/南阳旅游.docx', required: true },
        title: { type: 'string', description: 'Optional document title', required: false },
      },
      handler: async (params) => {
        return _createDocMod.execute(params);
      },
    });
  }
} catch { /* createDocument tool not available */ }

const _claudeCompatTools = getClaudeCompatToolList();

// 收敛到 utils/normalizeAlnumKey 单一真源(逐字节委托,调用点不变)
const _toolKey = require('../utils/normalizeAlnumKey');

const _toolNameVariants = require('../utils/toolNameVariants');

function _getToolRegistry() {
  try {
    return require('../tools');
  } catch {
    return null;
  }
}

function _findBuiltinTool(name) {
  const variants = _toolNameVariants(name);
  for (const variant of variants) {
    const direct = _allTools.find(t => t.name === variant);
    if (direct) return direct;
  }
  const keys = new Set(variants.map(_toolKey));
  return _allTools.find(t => keys.has(_toolKey(t.name))) || null;
}

function _findRegistryTool(name) {
  const registry = _getToolRegistry();
  if (!registry) return null;

  const variants = _toolNameVariants(name);
  for (const variant of variants) {
    const direct = registry.get(variant);
    if (direct) return direct;
  }

  let allTools;
  try {
    allTools = registry.getAll();
  } catch {
    allTools = null;
  }
  if (!allTools || typeof allTools.values !== 'function') return null;

  const keys = new Set(variants.map(_toolKey));
  for (const tool of allTools.values()) {
    if (!tool) continue;
    if (keys.has(_toolKey(tool.name))) return tool;
    if (Array.isArray(tool.aliases) && tool.aliases.some((alias) => keys.has(_toolKey(alias)))) {
      return tool;
    }
  }
  return null;
}

function _findCompatTool(name) {
  const key = _toolKey(name);
  if (!key) return null;
  return _claudeCompatTools.find((tool) => (
    _toolKey(tool.name) === key || _toolKey(tool.canonical) === key
  )) || null;
}

function _resolveToolDescriptor(requestedName) {
  const normalizedName = normalizeToolName(requestedName) || requestedName;

  // Priority 1: Registry tools with alwaysLoad (newer, feature-rich implementations
  // like FileReadTool that support offset/limit, replacing legacy builtins)
  const registryTool = _findRegistryTool(normalizedName) || _findRegistryTool(requestedName);
  if (registryTool && registryTool.alwaysLoad) {
    return {
      source: 'registry',
      tool: registryTool,
      resolvedName: registryTool.name,
      requestedName,
      normalizedName,
    };
  }

  // Priority 2: Builtin tools (legacy, simple implementations)
  const builtinTool = _findBuiltinTool(normalizedName) || _findBuiltinTool(requestedName);
  if (builtinTool) {
    return {
      source: 'builtin',
      tool: builtinTool,
      resolvedName: builtinTool.name,
      requestedName,
      normalizedName,
    };
  }

  // Priority 3: Registry tools without alwaysLoad
  if (registryTool) {
    return {
      source: 'registry',
      tool: registryTool,
      resolvedName: registryTool.name,
      requestedName,
      normalizedName,
    };
  }

  // Priority 4: Claude compat tools (name mapping layer)
  const compatTool = _findCompatTool(normalizedName) || _findCompatTool(requestedName);
  if (compatTool) {
    return {
      source: 'compat',
      tool: compatTool,
      resolvedName: compatTool.canonical,
      requestedName,
      normalizedName,
    };
  }

  return null;
}

function _buildDirectoryListing(baseDir, relPath = '.', recursive = false, maxEntries = 200) {
  const out = [];
  const queue = [{ abs: baseDir, rel: relPath, depth: 0 }];

  while (queue.length > 0 && out.length < maxEntries) {
    const current = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) break;
      const rel = path.join(current.rel, entry.name);
      const abs = path.join(current.abs, entry.name);
      out.push({
        name: entry.name,
        path: rel === '.' ? entry.name : rel,
        type: entry.isDirectory() ? 'directory' : 'file',
      });
      if (recursive && entry.isDirectory() && current.depth < 8 && !entry.name.startsWith('.')) {
        queue.push({ abs, rel: rel === '.' ? entry.name : rel, depth: current.depth + 1 });
      }
    }
  }
  return out;
}

async function _executeCompatTool(compatCanonicalName, params = {}, traceContext = {}) {
  const normalizedParams = normalizeToolParams(compatCanonicalName, params);
  const cwd = process.env.KHYQUANT_CWD || process.cwd();

  if (compatCanonicalName === 'ls') {
    const target = expandPath(normalizedParams.path || '.');
    const abs = path.resolve(cwd, target);
    if (!fs.existsSync(abs)) {
      return { success: false, error: `Path not found: ${target}` };
    }
    const recursive = Boolean(normalizedParams.recursive);
    const maxEntries = Math.max(1, Math.min(Number(normalizedParams.max_entries) || 200, 2000));
    const entries = _buildDirectoryListing(abs, '.', recursive, maxEntries);
    return {
      success: true,
      path: abs,
      recursive,
      count: entries.length,
      entries,
      truncated: entries.length >= maxEntries,
    };
  }

  if (compatCanonicalName === 'multiEdit') {
    const filePath = normalizedParams.file_path || normalizedParams.path;
    const edits = Array.isArray(normalizedParams.edits) ? normalizedParams.edits : [];
    if (!filePath || edits.length === 0) {
      return { success: false, error: 'multiEdit requires file_path and non-empty edits[]' };
    }
    const editTool = _findRegistryTool('editFile') || _findBuiltinTool('editFile');
    if (!editTool) {
      return { success: false, error: 'editFile tool is unavailable' };
    }

    const applied = [];
    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const editParams = {
        file_path: filePath,
        old_string: edit.old_string,
        new_string: edit.new_string,
        replace_all: Boolean(edit.replace_all),
      };
      const result = await editTool.execute(editParams, {});
      if (!result || !result.success) {
        return {
          success: false,
          error: result?.error || `multiEdit failed at edit index ${i}`,
          appliedCount: applied.length,
          failedIndex: i,
        };
      }
      applied.push({ index: i, replacements: result.replacements || 1 });
    }
    return {
      success: true,
      file: filePath,
      editsApplied: applied.length,
      details: applied,
    };
  }

  if (compatCanonicalName === 'todoWrite') {
    const items = Array.isArray(normalizedParams.todos) ? normalizedParams.todos : [];
    const normalized = items.map((item, index) => {
      if (typeof item === 'string') {
        return { id: `todo-${index + 1}`, content: item, status: 'pending' };
      }
      return {
        id: item.id || `todo-${index + 1}`,
        content: item.content || item.text || '',
        status: item.status || (item.done ? 'completed' : 'pending'),
        priority: item.priority || 'normal',
      };
    }).filter(t => t.content);

    let todoPath = '';
    const payload = JSON.stringify({
      updatedAt: new Date().toISOString(),
      todos: normalized,
    }, null, 2);
    // 候选目录经 SSOT(todoStateStorePaths)与看板读侧收敛,消除写/读 tmp 解析漂移
    // (写侧 getTmpDir vs 读侧 os.tmpdir)。门控关 → 内联今日清单(与 SSOT 输出一致,
    // 写侧本就用 getTmpDir),逐字节回退。
    const _getTmpDir = () => require('../tools/platformUtils').getTmpDir();
    let candidateFiles;
    try {
      const store = require('./todoStateStorePaths');
      if (store.todoStateUnifyEnabled()) {
        candidateFiles = store.todoStateCandidateFiles({
          homedir: os.homedir(), cwd, tmpdir: _getTmpDir(),
        });
      } else {
        candidateFiles = null;
      }
    } catch { candidateFiles = null; }
    if (!candidateFiles) {
      candidateFiles = [
        path.join(os.homedir(), '.khyquant'),
        path.join(cwd, '.khyquant'),
        path.join(_getTmpDir(), 'khyquant'),
      ].map((dir) => ({ dir, file_path: path.join(dir, 'todo_state.json') }));
    }

    let lastWriteErr = null;
    for (const cand of candidateFiles) {
      try {
        if (!fs.existsSync(cand.dir)) fs.mkdirSync(cand.dir, { recursive: true });
        fs.writeFileSync(cand.file_path, payload, 'utf-8');
        todoPath = cand.file_path;
        lastWriteErr = null;
        break;
      } catch (err) {
        lastWriteErr = err;
      }
    }
    if (!todoPath) {
      return { success: false, error: lastWriteErr?.message || 'Unable to persist todo state' };
    }

    try {
      // Push todos to the HUD via the neutral UI port, no reverse require to
      // cli/hudRenderer (DESIGN-ARCH-021, Batch 3). Silent no-op headless.
      require('./compactionUiPort').emitTodoUpdate(
        normalized.map(t => ({ text: t.content, done: t.status === 'completed' })));
    } catch { /* best effort */ }

    return {
      success: true,
      path: todoPath,
      count: normalized.length,
      output: `Wrote ${normalized.length} todo item(s).`,
      todos: normalized,
    };
  }

  if (compatCanonicalName === 'webFetch') {
    const url = String(normalizedParams.url || '').trim();
    if (!/^https?:\/\//i.test(url)) {
      return { success: false, error: 'webFetch requires an http/https URL' };
    }
    const timeoutMs = Math.min(Math.max(Number(normalizedParams.timeout) || 15000, 1000), 60000);
    const maxChars = Math.min(Math.max(Number(normalizedParams.max_chars) || 20000, 1000), 200000);
    const { fetchWithSsrfGuard } = require('./fetchTimeout');
    let fetchFn = typeof fetch === 'function' ? fetch : null;
    if (!fetchFn) {
      try {
        const mod = await import('node-fetch');
        fetchFn = mod.default || mod;
      } catch {
        return { success: false, error: 'No fetch implementation available for webFetch' };
      }
    }

    const response = await fetchWithSsrfGuard((signal) => fetchFn(url, {
      method: 'GET',
      signal,
      headers: { 'user-agent': 'khy-compat-webfetch/1.0' },
    }), { url, timeoutMs, operation: 'webFetch' });

    const contentType = response.headers?.get ? response.headers.get('content-type') : '';
    // Decode by the server's declared charset (GB2312/GBK/big5/… — Chinese news
    // sites are NOT utf-8) and extract readable text from HTML. Feeding raw,
    // mis-decoded HTML to the model produced empty answers ("✓ but no output").
    const buf = Buffer.from(await response.arrayBuffer());
    const { decodeAndExtract } = require('./webFetchDecode');
    const decoded = decodeAndExtract(buf, contentType, maxChars);
    return {
      success: true,
      url,
      status: response.status,
      contentType: contentType || '',
      charset: decoded.charset,
      isHtml: decoded.isHtml,
      content: decoded.content,
      truncated: decoded.truncated,
    };
  }

  if (compatCanonicalName === 'spawnAgent') {
    const prompt = String(normalizedParams.prompt || '').trim();
    if (!prompt) return { success: false, error: 'spawn_agent requires message/prompt' };
    const { spawnWorker } = require('../coordinator/workerAgent');
    const role = normalizedParams.role || 'general';
    let preferredAdapter = String(
      normalizedParams.preferred_adapter
      || normalizedParams.adapter
      || normalizedParams.provider
      || ''
    ).trim().toLowerCase();
    if (!preferredAdapter && String(role).toLowerCase() === 'codex') preferredAdapter = 'codex';
    if (!preferredAdapter && String(role).toLowerCase() === 'claude') preferredAdapter = 'claude';
    const preferredModel = String(
      normalizedParams.preferred_model
      || normalizedParams.model
      || ''
    ).trim();
    const timeoutMs = Math.max(1000, Math.min(Number(normalizedParams.timeout_ms || normalizedParams.timeout * 1000) || 120000, 3600000));
    const worker = await spawnWorker(prompt, {
      role,
      timeout: timeoutMs,
      preferredAdapter,
      preferredModel,
    });
    return {
      success: true,
      agent_id: worker.id,
      status: worker.status,
      role: worker.role || role,
      preferredAdapter: worker.preferredAdapter || preferredAdapter || null,
      preferredModel: worker.preferredModel || preferredModel || null,
      message: `Spawned agent ${worker.id} (${worker.role || role})`,
    };
  }

  if (compatCanonicalName === 'sendInput') {
    const agentId = String(normalizedParams.agent_id || '').trim();
    const message = String(normalizedParams.message || '').trim();
    if (!agentId) return { success: false, error: 'send_input requires target/agent id' };
    if (!message) return { success: false, error: 'send_input requires message' };
    const { sendMessage, getWorkerStatus } = require('../coordinator/workerAgent');
    const worker = getWorkerStatus(agentId);
    if (!worker) return { success: false, error: `Agent ${agentId} not found` };
    const ok = sendMessage(agentId, message);
    return {
      success: ok,
      agent_id: agentId,
      status: worker.status,
      message: ok ? `Message queued for ${agentId}` : `Agent ${agentId} is ${worker.status}, cannot receive message`,
    };
  }

  if (compatCanonicalName === 'waitAgent') {
    const targets = Array.isArray(normalizedParams.targets)
      ? normalizedParams.targets.map(v => String(v).trim()).filter(Boolean)
      : [];
    if (targets.length === 0) return { success: false, error: 'wait_agent requires targets[]' };

    const idleTimeoutMs = Math.max(1000, Math.min(Number(normalizedParams.timeout_ms) || 30000, 3600000));
    const pollMs = Math.max(100, Math.min(Number(normalizedParams.poll_ms) || 250, 2000));
    const terminal = new Set(['completed', 'error', 'stopped']);
    const { getWorkerStatus } = require('../coordinator/workerAgent');
    const start = Date.now();

    // Activity-based idle timeout: reset when any worker status changes (Rule 3)
    let lastActivityAt = Date.now();
    const lastStatuses = new Map(targets.map(id => [id, null]));

    while ((Date.now() - lastActivityAt) < idleTimeoutMs) {
      for (const id of targets) {
        const worker = getWorkerStatus(id);
        if (!worker) continue;
        if (terminal.has(worker.status)) {
          return {
            success: true,
            agent_id: id,
            status: worker.status,
            output: worker.result || '',
            error: worker.error || null,
            elapsed_ms: Date.now() - start,
          };
        }
        // touch — status or progress change means activity
        if (worker.status !== lastStatuses.get(id)) {
          lastStatuses.set(id, worker.status);
          lastActivityAt = Date.now();
        }
      }
      await new Promise(resolve => setTimeout(resolve, pollMs));
    }

    return {
      success: true,
      timeout: true,
      status: null,
      elapsed_ms: Date.now() - start,
      pending_targets: targets,
    };
  }

  if (compatCanonicalName === 'closeAgent') {
    const agentId = String(normalizedParams.agent_id || '').trim();
    if (!agentId) return { success: false, error: 'close_agent requires target/agent id' };
    const { shutdownWorker, getWorkerStatus } = require('../coordinator/workerAgent');
    const worker = getWorkerStatus(agentId);
    if (!worker) return { success: false, error: `Agent ${agentId} not found` };
    const previousStatus = worker.status;
    const closed = shutdownWorker(agentId);
    const latest = getWorkerStatus(agentId);
    return {
      success: closed,
      agent_id: agentId,
      previous_status: previousStatus,
      status: latest?.status || previousStatus,
      message: closed ? `Agent ${agentId} closed` : `Failed to close ${agentId}`,
    };
  }

  if (compatCanonicalName === 'resumeAgent') {
    const agentId = String(normalizedParams.agent_id || '').trim();
    if (!agentId) return { success: false, error: 'resume_agent requires id' };
    const { getWorkerStatus } = require('../coordinator/workerAgent');
    const worker = getWorkerStatus(agentId);
    if (!worker) return { success: false, error: `Agent ${agentId} not found` };
    return {
      success: true,
      agent_id: agentId,
      status: worker.status,
      resumed: worker.status === 'running' || worker.status === 'pending',
      message: worker.status === 'running' || worker.status === 'pending'
        ? `Agent ${agentId} is active`
        : `Agent ${agentId} is ${worker.status}; resume is best-effort only`,
    };
  }

  if (compatCanonicalName === 'slashCommand') {
    const raw = String(normalizedParams.command || '').trim();
    if (!raw) {
      return { success: false, error: 'SlashCommand requires command' };
    }
    const args = Array.isArray(normalizedParams.args)
      ? normalizedParams.args.map(v => String(v)).filter(Boolean)
      : [];
    const slash = raw.startsWith('/') ? raw : `/${raw}`;
    const commandLine = [slash, ...args].join(' ').trim();

    try {
      // Dispatch through the neutral commandDispatchPort instead of requiring
      // cli/router back — breaks the keystone `services → cli/router` reverse
      // edge that anchored 42 nodes of the giant SCC (DESIGN-ARCH-021, Batch 1).
      // cli/router self-registers on load; if it was never loaded (headless
      // service / test), degrade gracefully with a structured result.
      const dispatcher = require('./commandDispatchPort').getDispatcher();
      if (!dispatcher) {
        return {
          success: false,
          error: 'Slash command dispatcher unavailable (CLI router not loaded)',
          command: commandLine,
          reason: 'no_dispatcher',
        };
      }
      const parsed = dispatcher.parseInput(commandLine);
      const routeResult = await dispatcher.route(parsed);

      if (routeResult === false) {
        const lower = slash.toLowerCase();

        // Claude-style fallback commands that may not exist in static slash table.
        // Resolved via the neutral aiSessionPort instead of a reverse require to
        // cli/ai (DESIGN-ARCH-021, Batch 3). Unregistered → structured no_ai_session.
        if (lower === '/status') {
          const session = require('./aiSessionPort').getAiSession();
          if (!session) return { success: false, command: commandLine, reason: 'no_ai_session' };
          await session.handleAiStatus();
          return { success: true, command: commandLine, routeResult: 'ai-status' };
        }
        if (lower === '/config') {
          const session = require('./aiSessionPort').getAiSession();
          if (!session) return { success: false, command: commandLine, reason: 'no_ai_session' };
          await session.handleAiConfig();
          return { success: true, command: commandLine, routeResult: 'ai-config' };
        }
        if (lower === '/new' || lower === '/clear') {
          const session = require('./aiSessionPort').getAiSession();
          if (session && typeof session.clearHistory === 'function') session.clearHistory();
          return { success: true, command: commandLine, routeResult: 'history-cleared' };
        }
        if (lower === '/tools') {
          return {
            success: true,
            command: commandLine,
            routeResult: 'tools-list',
            tools: listTools(),
          };
        }

        return {
          success: false,
          error: `Unrecognized slash command: ${slash}`,
          command: commandLine,
        };
      }

      return {
        success: true,
        command: commandLine,
        routeResult,
      };
    } catch (err) {
      return {
        success: false,
        error: err.message || `Failed to execute slash command: ${commandLine}`,
        command: commandLine,
      };
    }
  }

  if (compatCanonicalName === 'notebookRead') {
    const pathArg = normalizedParams.path || normalizedParams.file_path;
    if (!pathArg) return { success: false, error: 'NotebookRead requires path' };
    const readTool = _findRegistryTool('readFile') || _findBuiltinTool('read_file');
    if (!readTool) return { success: false, error: 'readFile tool is unavailable' };
    return readTool.execute({ path: pathArg, offset: normalizedParams.offset, limit: normalizedParams.limit }, {});
  }

  if (compatCanonicalName === 'notebookEdit') {
    const pathArg = normalizedParams.file_path || normalizedParams.path;
    if (!pathArg) return { success: false, error: 'NotebookEdit requires path/file_path' };

    if (typeof normalizedParams.old_string === 'string') {
      const editTool = _findRegistryTool('editFile') || _findBuiltinTool('editFile');
      if (!editTool) return { success: false, error: 'editFile tool is unavailable' };
      return editTool.execute({
        file_path: pathArg,
        old_string: normalizedParams.old_string,
        new_string: normalizedParams.new_string || '',
        replace_all: Boolean(normalizedParams.replace_all),
      }, {});
    }

    if (typeof normalizedParams.content === 'string') {
      const writeTool = _findRegistryTool('writeFile') || _findBuiltinTool('write_file');
      if (!writeTool) return { success: false, error: 'writeFile tool is unavailable' };
      return writeTool.execute({ path: pathArg, content: normalizedParams.content }, {});
    }

    return { success: false, error: 'NotebookEdit requires either old_string/new_string or content' };
  }

  return { success: false, error: `Unsupported compatibility tool: ${compatCanonicalName}` };
}


/**
 * [DESIGN-ARCH-029] Tool → resilience intent-tree head map.
 *
 * Only tools that HEAD a registered degradation tree (resilience/intentTrees.js)
 * are routed through the self-heal coordinator; every other tool falls straight
 * through to the normal funnel. Extend this map as more core intent trees land.
 */
const _SELF_HEAL_INTENT_BY_TOOL = Object.freeze({
  WebBrowser: 'fetch-web-content',
});

/**
 * Opt-in self-heal / bounded-degradation routing for executeTool.
 *
 * Default ON — disable with KHY_SELF_HEAL=off. When a tool that heads a known
 * intent tree is invoked top-level, run it through FallbackTreeWithHeal (selfHeal
 * micro-loop repair) over the resilience degradation tree, so a failure auto-
 * degrades (e.g. WebBrowser→WebFetch→WebSearch) and produces a structured salvage
 * instead of a bare error. The coordinator's own runner re-enters executeTool with
 * traceContext.resiliencePlan set; those calls are NOT re-routed (recursion guard).
 * Any error in the heal layer falls open to the normal funnel — zero behavior
 * change by default.
 *
 * @returns {Promise<{handled:boolean, result?:object}>}
 */
async function _maybeRouteSelfHeal(toolName, params, traceContext) {
  // byte-identical to `KHY_SELF_HEAL === 'off'` (offDisables: enabled ⇔ raw!=='off').
  if (!getCapabilityMatrix().isEnabledAt(CAP_SEAMS.POST_TOOL_GOVERNANCE, 'selfHeal', {})) return { handled: false };
  // Re-entry guard: makeToolRunner stamps resiliencePlan on the trace.
  if (traceContext && traceContext.resiliencePlan) return { handled: false };
  const intent = _SELF_HEAL_INTENT_BY_TOOL[toolName];
  if (!intent) return { handled: false };
  try {
    const { makeToolRunner } = require('./resilience');
    const { FallbackTreeWithHeal } = require('./selfHeal');
    const runner = makeToolRunner(executeTool, { ...(traceContext || {}) });
    const onDegrade = (text) => {
      try {
        if (typeof traceContext?.onActivity === 'function') {
          traceContext.onActivity({ type: 'self-heal-degrade', text });
        }
      } catch { /* degrade notification is best-effort */ }
    };
    const heal = new FallbackTreeWithHeal({ runner, onDegrade });
    const outcome = await heal.run(intent, {
      ...(params || {}),
      url: params && params.url,
      query: params && params.query,
      control: traceContext && traceContext.control,
    });
    if (outcome && outcome.status === 'ok') {
      return { handled: true, result: outcome.result };
    }
    // Exhausted self-heal + degradation → hand back an executeTool-shaped salvage.
    return {
      handled: true,
      result: {
        success: false,
        error: (outcome && outcome.next_action_suggestion)
          || '自愈与降级路径已穷尽，未取得成功结果。',
        denied: false,
        _selfHealReport: outcome || null,
      },
    };
  } catch {
    // Fail-open: heal-layer failure must never break the normal tool funnel.
    return { handled: false };
  }
}

/**
 * Execute a tool call with permission checking.
 * Enhanced with permissionStore integration and audit logging.
 *
 * [AI-弱模型·别绕过] 唯一工具执行漏斗。以下是有序 fail-closed 权限链;勿早 return、勿加旁路。
 * 要加能力→加在链末尾且默认 fail-closed。判定写成纯叶子(照 goalStopGate.js)。
 */
async function executeTool(toolName, params = {}, traceContext = {}) {
  const normalizedName = normalizeToolName(toolName) || toolName;

  // Claude Code SDK alignment: enforce the --allowedTools / --disallowedTools
  // gateway at execution too (belt-and-suspenders), so a gated tool cannot run
  // even if a model names it directly without it appearing in the definitions.
  {
    const gw = _toolAccessGateway();
    const denied = gw.gatewayDecision(normalizedName) || gw.gatewayDecision(toolName);
    if (denied) return { success: false, error: denied };
  }

  // [P1#3] 参数命名统一:逐工具跨词映射(normalizeToolParams)+ 路径键归一之后,
  // 再补「同词不同大小写」的 snake/camel 两种拼写,使定义侧统一成 snake_case 后,
  // 读取 camelCase 的旧工具仍能取到值。门控 KHY_TOOL_PARAM_NAMING(默认开)。
  const normalizedParams = require('./toolParamNaming').expandParamAliases(
    _normalizePathLikeParams(
      normalizeToolParams(normalizedName, params)
    )
  );

  // [Plugin marketplace] Coze-compatible plugin tools (`plugin__<slug>__<op>`)
  // are dynamic + per-user, so they live outside the static registry. Dispatch
  // them here using the RAW toolName — normalizeToolName() would corrupt hyphens
  // in the slug (claudeCompat replaces [\s-] with '_'). The cheap prefix check
  // keeps the normal funnel untouched for every non-plugin tool. Gated by
  // KHY_PLUGINS.
  if (process.env.KHY_PLUGINS !== 'off' && typeof toolName === 'string' && toolName.startsWith('plugin__')) {
    try {
      const pluginBridge = require('./plugins/pluginToolBridge');
      if (pluginBridge.isPluginTool(toolName)) {
        return await pluginBridge.executePluginTool(toolName, params, traceContext);
      }
    } catch (err) {
      return { success: false, error: `Plugin tool dispatch failed: ${err.message}` };
    }
  }

  let descriptor = _resolveToolDescriptor(normalizedName) || _resolveToolDescriptor(toolName);
  let traceAudit = null;
  try {
    traceAudit = require('./traceAuditService');
    traceAudit.ensureDiagnosticsBridge();
  } catch { /* trace audit optional */ }
  const traceCtx = {
    sessionId: traceContext?.sessionId || traceAudit?.getContext?.()?.sessionId || null,
    traceId: traceContext?.traceId || traceAudit?.getContext?.()?.traceId || null,
    requestId: traceContext?.requestId || traceAudit?.getContext?.()?.requestId || traceContext?.traceId || traceAudit?.getContext?.()?.traceId || null,
    role: traceContext?.role || traceAudit?.getContext?.()?.role || null,
    source: 'tool-calling',
    visibility: 'summary',
  };
  const onActivity = typeof traceContext?.onActivity === 'function'
    ? traceContext.onActivity
    : null;
  const onProgress = typeof traceContext?.onProgress === 'function'
    ? traceContext.onProgress
    : null;
  const emitActivity = (payload) => {
    if (!onActivity) return;
    try { onActivity(payload); } catch { /* non-critical */ }
  };
  const emitProgress = (payload) => {
    if (!onProgress) return;
    try { onProgress(payload); } catch { /* non-critical */ }
  };
  const wrapperStart = Date.now();
  // ESC / 用户中断 → 执行中的工具取消:loop 把 parentAbort.signal(仅真·中断时触发)放进
  // traceContext.abortSignal,这里取出——① 附到 toolExecutionContext.signal 供工具主动查询
  // (加法字段,门控关/无信号时不出现,byte-identical);② 供 _withToolTimeout 与在途工具竞赛。
  const _toolAbortSignal = (traceContext && traceContext.abortSignal) || null;
  const toolExecutionContext = {
    traceContext,
    onActivity: emitActivity,
    onProgress: emitProgress,
    // P0.3: forward a capped parent-conversation snapshot (if the loop supplied
    // one) so AgentTool can derive a parent-context summary for sub-agents.
    // Additive and optional — undefined when the caller did not provide it.
    parentConversation: traceContext?.parentConversation,
  };
  if (_toolAbortSignal) toolExecutionContext.signal = _toolAbortSignal;
  const emitWrapper = (phase, payload = {}, visibility = 'summary') => {
    try {
      if (!traceAudit || typeof traceAudit.logEvent !== 'function') return;
      traceAudit.logEvent(`tool.wrapper.${phase}`, payload, {
        ...traceCtx,
        visibility,
      });
    } catch { /* non-critical */ }
  };

  // [DESIGN-ARCH-029] Opt-in self-heal / bounded-degradation routing (default off;
  // KHY_SELF_HEAL=on). No-op unless the flag is on and the tool heads an intent
  // tree; recursion-guarded and fail-open. See _maybeRouteSelfHeal.
  {
    const _healed = await _maybeRouteSelfHeal(normalizedName, normalizedParams, traceContext);
    if (_healed && _healed.handled) return _healed.result;
  }

  if (!descriptor) {
    // ── 模糊修复: Levenshtein 距离匹配 + "did you mean?" ──────────
    // [AI-弱模型·别绕过] 此处只对**已注册工具**做拼写纠错(距离阈值内),纠错后仍走完整权限链。
    //   绝不把未知/被拒的名字自动映射成一个真描述符来绕过 allowedTools/权限判定;
    //   绝不放宽 autoFixThreshold 让任意名字命中。拿不准就让它落到下面的 "did you mean?" 建议。
    const allToolNames = listTools().map(t => t.name);
    const _lev = (a, b) => {
      if (a === b) return 0;
      const la = a.length, lb = b.length;
      if (la === 0) return lb;
      if (lb === 0) return la;
      if (la > 80 || lb > 80) return Math.abs(la - lb);
      let prev = Array.from({ length: lb + 1 }, (_, i) => i);
      for (let i = 1; i <= la; i++) {
        const curr = [i];
        for (let j = 1; j <= lb; j++) {
          curr[j] = a[i - 1] === b[j - 1] ? prev[j - 1] : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
        }
        prev = curr;
      }
      return prev[lb];
    };
    const lowerName = (normalizedName || toolName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    // 计算所有工具的距离排行
    const ranked = allToolNames
      .map(name => ({ name, dist: _lev(lowerName, name.toLowerCase().replace(/[^a-z0-9]/g, '')) }))
      .sort((a, b) => a.dist - b.dist);
    const best = ranked[0];
    // 自动修复阈值: 距离 <= max(2, 名字长度*20%)
    const autoFixThreshold = Math.max(2, Math.floor(lowerName.length * 0.2));
    if (best && best.dist <= autoFixThreshold && best.dist > 0) {
      const fixedDescriptor = _resolveToolDescriptor(best.name);
      if (fixedDescriptor) {
        descriptor = fixedDescriptor;
        normalizedParams._autoRepairedFrom = toolName;
      }
    }
    // 仍然未解析 → 构建 "did you mean?" 建议
    if (!descriptor) {
      const suggestions = ranked
        .filter(s => s.dist <= 5)
        .slice(0, 3)
        .map(s => s.name);

      const hint = suggestions.length > 0
        ? `Did you mean: ${suggestions.join(', ')}?`
        : `Available tools: ${allToolNames.slice(0, 14).join(', ')}...`;

      emitWrapper('end', {
        tool: normalizedName || toolName,
        success: false,
        error: `Unknown tool: ${toolName}`,
        elapsedMs: Date.now() - wrapperStart,
      });
      try {
        const { ToolError } = require('./toolError');
        return new ToolError('TOOL_UNAVAILABLE', `Unknown tool: ${toolName}`, {
          hint,
          recoverable: true,
          retryable: false,
        }).toStructuredResult();
      } catch {
        return { success: false, error: `Unknown tool: ${toolName}. ${hint}` };
      }
    }
  }

  // ── Step-type assessment (固化/灵活/人闸门) ──────────────────────
  // Derive the step type + risk once, here at the single tool funnel, so the
  // permission gate, wrapper events, audit log, and receipt recorder all share
  // one judgement. Read-only/low → hardened, model work → flexible,
  // high/destructive → human-gate. Pure read-only call; never throws.
  let stepAssessment = { stepType: 'flexible', riskLevel: 'medium', isReadOnly: false, isDestructive: false, reason: '', source: 'tool' };
  try {
    stepAssessment = require('./riskGate').assess(normalizedName || toolName, normalizedParams, descriptor);
  } catch { /* riskGate optional — keep conservative default */ }

  // ── §4.A reversibility layering: speculation guard ───────────────
  // Under a speculative lookahead context (traceContext.speculative === true)
  // only read-only (A_safe) actions may run; any irreversible (A_commit) action
  // is hard-refused BEFORE permission or execution, so exploration can never
  // change the world or consume the irreversible-step budget (budget
  // conservation, design doc §4.A). Default path: speculative falsy → untouched
  // (zero regression). Fail-closed: if the guard module is unavailable we refuse
  // to speculate rather than risk an unguarded commit.
  if (traceContext?.speculative === true) {
    let speculativeRefusal = 'Speculative execution guard unavailable; refusing to speculate.';
    try {
      const { speculationGuard, resolveReversibility } = require('./reversibility');
      const specKey = descriptor.resolvedName || normalizedName || toolName;
      const blocked = speculationGuard(
        resolveReversibility(specKey, normalizedParams, stepAssessment), true,
      );
      if (!blocked) {
        speculativeRefusal = null; // A_safe — allowed to proceed speculatively
      } else {
        speculativeRefusal = blocked.error;
      }
    } catch { /* keep fail-closed refusal */ }
    if (speculativeRefusal) {
      emitWrapper('end', {
        tool: normalizedName || toolName,
        success: false,
        error: speculativeRefusal,
        speculativeBlocked: true,
        elapsedMs: Date.now() - wrapperStart,
      });
      return { success: false, error: speculativeRefusal, _speculativeBlocked: true };
    }
  }

  // ── Per-tool capability policy gate ──────────────────────────────
  const policyBlocked = _checkToolPolicy(normalizedName, toolName);
  if (policyBlocked) {
    emitWrapper('end', {
      tool: normalizedName || toolName,
      success: false,
      error: policyBlocked,
      elapsedMs: Date.now() - wrapperStart,
    });
    return { success: false, error: policyBlocked, _policyBlocked: true };
  }

  // ── Active-skill allowed-tools whitelist gate (A1) ───────────────
  const skillBlocked = _checkActiveSkillPolicy(normalizedName, toolName);
  if (skillBlocked) {
    emitWrapper('end', {
      tool: normalizedName || toolName,
      success: false,
      error: skillBlocked,
      elapsedMs: Date.now() - wrapperStart,
    });
    try {
      require('./receiptService').appendToolCall({
        sessionId: traceCtx.sessionId, tool: normalizedName || toolName, params: normalizedParams,
        result: { success: false }, permission: 'blocked', elapsedMs: 0,
        stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel, error: skillBlocked,
      });
    } catch { /* receipt is non-critical */ }
    return { success: false, error: skillBlocked, _policyBlocked: true };
  }

  // Check permission
  const permissionKey = descriptor.resolvedName || normalizedName || toolName;
  emitWrapper('start', {
    tool: permissionKey,
    params: normalizedParams,
    stepType: stepAssessment.stepType,
    risk: stepAssessment.riskLevel,
  });

  // ── Plan-mode hard read-only ([P4] CC-aligned plan sandbox) ──────────
  // While a plan is being generated/reviewed (before the user approves it),
  // Claude Code keeps the agent in a strict read-only sandbox: explore freely,
  // but no writes/exec until ExitPlanMode approval. KHY's EnterPlanMode declared
  // read-only *intent* but never enforced it, so a model could write files while
  // "just planning". Here we hard-deny any non-read-only tool during the plan
  // window and re-inject a clear instruction so the model explores instead of
  // writing. This runs ahead of the syscall gateway / capability floor so the
  // plan-mode reason is the one the model sees. Cleared once the plan is approved
  // (executing) or aborted (idle/complete). Kill switch: KHY_PLAN_READONLY=off.
  if (process.env.KHY_PLAN_READONLY !== 'off') {
    try {
      // 经零依赖叶子读“计划只读”标志（[DESIGN-ARCH-051] §6.11），不再 import
      // 计划链；未登记 provider 时得 false，等同“无活动计划”。
      const planMode = require('./planModeSink');
      if (planMode.isPlanReadOnly()) {
        let isReadOnly = false;
        try {
          const registry = require('../tools');
          const regTool = registry.get(permissionKey);
          if (regTool && typeof regTool.isReadOnly === 'function') {
            isReadOnly = regTool.isReadOnly(normalizedParams);
          }
        } catch { /* registry not available — treat as non-read-only (safer) */ }
        if (!isReadOnly) {
          const reason = `计划模式（仅探索）：当前正在生成/审阅计划，只能使用只读工具（读取、检索、分析）。`
            + `工具「${permissionKey}」会进行写入或执行，已被拦截。请先用只读工具把计划补充完整，`
            + `待用户批准后再执行写操作。`;
          emitWrapper('end', {
            tool: permissionKey, success: false, denied: true, permission: 'deny',
            planReadOnly: true, elapsedMs: Date.now() - wrapperStart,
          });
          try {
            require('./receiptService').appendToolCall({
              sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
              result: { success: false }, permission: 'deny', elapsedMs: 0,
              stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel, error: reason,
            });
          } catch { /* receipt non-critical */ }
          return { success: false, error: reason, denied: true, _planReadOnlyBlocked: true };
        }
      }
    } catch { /* planModeService optional — fall through to normal gating */ }
  }


  // ── PreToolUse 钩子（绕不过的硬底）────────────────────────────────────
  // [AI-弱模型·别绕过] 这是绕不过的硬底:钩子在所有权限闸之前、无条件运行(即便 bypass/危险模式)。
  //   勿在此块前早 return;勿改 alreadyHooked/HOOKS_EVALUATED 戳逻辑使钩子不触发;勿放宽 kill-switch。
  //   下面这段中文注释即权威说明,勿删勿改其语义。
  // 把 PreToolUse 钩子下沉到「单一执行漏斗」executeTool：任何到达这里的调用——主
  // toolUseLoop、本地小模型 localToolLoop、子代理、直连 executeTool——都必须先过钩子。
  // 钩子判 block 即拦截（denied），即便后续是 bypass/危险模式也绕不过（钩子在所有权限
  // 闸之前、无条件运行，对齐 CC「PreToolUse 即使 bypassPermissions 也照跑」）。幂等：
  // 主循环已在调用前触发过 PreToolUse 并在 params 上盖 HOOKS_EVALUATED 戳的调用，这里
  // 据戳跳过避免双跑；任何无戳的调用（localToolLoop/直连）都在此真正补上钩子 = 硬底。
  // 可审批的软 block（guard）经 onControlRequest 转一次审批。kill-switch
  // KHY_PRETOOL_HOOKS=off。钩子系统内部已 fault-isolated（safeRunHook 崩溃即 allow），
  // 故只有「明确的 block 决策」是硬的，加载异常不致卡死工具。
  if (process.env.KHY_PRETOOL_HOOKS !== 'off') {
    try {
      let alreadyHooked = false;
      try {
        const { HOOKS_EVALUATED } = require('./execApproval');
        alreadyHooked = !!(HOOKS_EVALUATED && normalizedParams[HOOKS_EVALUATED] === true);
      } catch { /* execApproval optional */ }
      if (!alreadyHooked) {
        const hookSystem = require('./hooks/hookSystem');
        if (typeof hookSystem.isInitialized === 'function' && hookSystem.isInitialized()) {
          const hr = await hookSystem.trigger('PreToolUse', {
            toolName: permissionKey, params: normalizedParams, _executeToolFunnel: true,
          });
          if (hr && hr.blocked) {
            let released = false;
            const onCtrlHook = typeof traceContext?.onControlRequest === 'function' ? traceContext.onControlRequest : null;
            if (hr.approvable && onCtrlHook) {
              try {
                const { requestGuardApproval } = require('./guardApproval');
                const verdict = await requestGuardApproval({
                  toolName: permissionKey, params: normalizedParams,
                  reason: hr.reason, source: hr.source, onControlRequest: onCtrlHook,
                });
                if (verdict && verdict.allowed) { normalizedParams = verdict.params || normalizedParams; released = true; }
              } catch { /* fall through to block */ }
            }
            if (!released) {
              const reason = `[Hook] ${hr.reason || 'Blocked by PreToolUse hook'}`;
              emitWrapper('end', {
                tool: permissionKey, success: false, denied: true, permission: 'deny',
                elapsedMs: Date.now() - wrapperStart,
              });
              try {
                require('./receiptService').appendToolCall({
                  sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
                  result: { success: false }, permission: 'deny', elapsedMs: 0,
                  stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel, error: reason,
                });
              } catch { /* receipt non-critical */ }
              return { success: false, error: reason, denied: true, _hookBlocked: true };
            }
          }
          // 钩子改写了 params（脱敏 / 重写路径等）→ 采纳（与主循环 hr.context.params 一致）。
          if (hr && hr.context && hr.context.params) normalizedParams = hr.context.params;
        }
      }
    } catch { /* 防呆: 钩子子系统加载异常不得卡死工具（block 决策由 trigger 内部保证） */ }
  }

  // ── 权限模式：plan（只读演练）前置拦截 ───────────────────────────────
  // CC 对齐：plan 模式 = 只读演练，任何有副作用的工具一律拒绝且不打断（prompt-free）。
  // 置于网关之前，确保写类工具在 plan 下被静默拒绝而非先弹一次 L1 审批。仅 registry
  // 显式声明 isReadOnly===true 的工具放行（保守：未声明者按非只读处理，plan 下拒绝）。
  // bypass/acceptEdits 是「自动放行」语义，留给网关 autoApproveL1 与 requestPermission。
  try {
    if (getPermissionMode() === 'plan') {
      const beh = _resolveToolBehavior(permissionKey, normalizedParams);
      if (beh.isReadOnly === false) {
        const reason = 'Plan 模式为只读演练，已拒绝有副作用的工具调用（切到 default/acceptEdits 模式后再执行）。';
        emitWrapper('end', {
          tool: permissionKey, success: false, denied: true, permission: 'deny',
          permissionMode: 'plan', elapsedMs: Date.now() - wrapperStart,
        });
        return { success: false, error: reason, denied: true, _planModeBlocked: true };
      }
    }
  } catch { /* fail-open: 模式解析异常 → 落回既有管线（网关/审批仍把关） */ }

  // ── 意图精准裁决前置路由（[DESIGN-ARCH-041] 接管点）─────────────────────
  // 在一切能力/网关裁决之前，对「触发本次执行的原始自然语言意图」做防误触路由。仅当上游
  // 显式在 traceContext.intentText 附带原始 NL 意图时才介入（默认无此字段 = 零介入，对既有
  // 调用方零回归）。dispatch 把意图落到三段光谱：
  //   execution  强意图 → 放行（继续既有管线，下游能力/网关/审批仍把关）；
  //   chat       安全对话带 → 拦截（防误触：非可执行意图绝不触发工具）；
  //   confirm    歧义模糊带 → 有交互通道则发 can_use_tool 二次确认，批准放行否则拦截（防呆②）。
  // 已盖 EXEC_APPROVED 戳（上游已授权该具体调用）= 意图明确，直接跳过。
  // kill-switch：KHY_INTENT_ARBITER=on 才启用（默认关，新治理引擎默认关）；任何加载/裁决
  // 异常一律 fail-open 落回既有管线（意图层异常不得卡死工具）。
  if (process.env.KHY_INTENT_ARBITER === 'on') {
    try {
      const intentText = traceContext && typeof traceContext.intentText === 'string'
        ? traceContext.intentText.trim() : '';
      let alreadyApproved = false;
      try {
        const { EXEC_APPROVED } = require('./execApproval');
        alreadyApproved = !!(EXEC_APPROVED && normalizedParams[EXEC_APPROVED] === true);
      } catch { /* execApproval optional */ }

      if (intentText && !alreadyApproved) {
        const { IntentArbiter } = require('./intentArbiter');
        const verdict = new IntentArbiter().dispatch(intentText);

        let intentBlocked = null; // null = 放行
        if (verdict.status === 'chat') {
          intentBlocked = `意图裁决拦截：原始意图判定为安全对话带（置信度 ${verdict.analysis.confidence}），非可执行指令，不触发工具（防误触）。`;
        } else if (verdict.status === 'confirm') {
          // 歧义带：把决定权交回用户（confirmPrompt 来自零副作用沙箱），有通道才问。
          const onCtrl = typeof traceContext?.onControlRequest === 'function' ? traceContext.onControlRequest : null;
          let confirmed = false;
          if (onCtrl) {
            try {
              const ctrlResp = await onCtrl({
                requestId: `intent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                request: {
                  subtype: 'can_use_tool',
                  tool_name: permissionKey,
                  input: {
                    ...normalizedParams,
                    _intentPrompt: verdict.route.confirmPrompt || '',
                    _intentConfidence: verdict.analysis.confidence,
                  },
                },
              });
              const d = _decisionFromControl(ctrlResp);
              confirmed = d === 'allow' || d === 'allow-always';
            } catch { confirmed = false; }
          }
          if (!confirmed) {
            intentBlocked = `意图裁决拦截：原始意图落歧义模糊带（置信度 ${verdict.analysis.confidence}），未获显式确认，不自主猜测执行（防呆②）。`;
          }
        }
        // execution → intentBlocked 保持 null，放行。

        if (intentBlocked) {
          emitWrapper('end', {
            tool: permissionKey, success: false, denied: true, permission: 'deny',
            intentArbiter: { band: verdict.route.band, confidence: verdict.analysis.confidence },
            elapsedMs: Date.now() - wrapperStart,
          });
          try {
            require('./receiptService').appendToolCall({
              sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
              result: { success: false }, permission: 'deny', elapsedMs: 0,
              stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel, error: intentBlocked,
            });
          } catch { /* receipt non-critical */ }
          return { success: false, error: intentBlocked, denied: true, _intentArbiterBlocked: true };
        }
      }
    } catch { /* 防呆 fail-open: 意图层加载/裁决异常 → 落回既有管线（权限/网关/锁仍把关） */ }
  }

  // ── 系统调用审批网关（单一裁决权威，只增不减保护）─────────────────
  // 网关在既有 requestPermission 之前裁决：判 deny 即 fail-closed 拦截，
  // 根本不进入既有管线；判 allow 则盖一枚不可伪造的 EXEC_APPROVED 戳，
  // 交还既有管线放行（不二次打断、保留审计）。任何网关异常都 fail-closed。
  // 关闭开关 KHY_SYSCALL_GATEWAY=off。byte-identical（offDisables）。
  if (getCapabilityMatrix().isEnabledAt(CAP_SEAMS.POST_TOOL_GOVERNANCE, 'syscallGateway', {})) {
    try {
      const gateway = require('./syscallGateway');
      // 解析工具的行为声明（只读/破坏性/风险），喂给网关分级。
      let gwReadOnly = false, gwDestructive = false, gwRisk = descriptor?.tool?.risk || 'medium';
      // 「跳出沙箱执行」是工具级声明（静态 sandboxEscape 或动态 requiresSandboxEscape(params)），
      // 绝不取自模型参数。一旦置位，网关恒按 L2（键入 YES）裁决。现有工具均不声明，故零行为变化。
      let gwSandboxEscape = false;
      // 复用 riskGate.assess() 作为风险信号的**单一真源**——它对 shell 命令走动态
      // commandRiskClassifier（逐命令判风险/只读/破坏性），对其余工具走静态 risk + 注册表
      // 谓词，与既有 requestPermission 漏斗用的是同一份裁决。把这份裁决喂给网关（而非工具
      // 「最坏情况」的静态 risk:'critical'），可避免良性、非破坏性的 shell 命令（npm test、
      // node build.js、git add）被强行升到 L2 红灯——它们会被判 L1 黄灯，与既有漏斗一致。
      // **L2 红线只收敛到真正的破坏性/不可逆操作**：真正破坏性的操作其 isDestructive=true，
      // resourceClassifier 第 2 步无视 risk 一律判 L2，红线零弱化。可逆回退开关
      // KHY_GATEWAY_DYNAMIC_RISK=off（退回工具静态 risk 信号）。
      let gwAssessment = null;
      try {
        const reg = require('../tools');
        const regTool = reg.get(permissionKey);
        if (regTool) {
          gwSandboxEscape = regTool.sandboxEscape === true
            || (typeof regTool.requiresSandboxEscape === 'function' && regTool.requiresSandboxEscape(normalizedParams) === true);
        }
        if (process.env.KHY_GATEWAY_DYNAMIC_RISK !== 'off') {
          const riskGate = require('./riskGate');
          gwAssessment = riskGate.assess(permissionKey, normalizedParams, descriptor);
          gwReadOnly = gwAssessment.isReadOnly;
          gwDestructive = gwAssessment.isDestructive;
          gwRisk = gwAssessment.riskLevel || gwRisk;
        } else if (regTool) {
          gwReadOnly = typeof regTool.isReadOnly === 'function' ? regTool.isReadOnly(normalizedParams) : false;
          gwDestructive = typeof regTool.isDestructive === 'function' ? regTool.isDestructive(normalizedParams) : false;
          gwRisk = regTool.risk || gwRisk;
        }
      } catch { /* registry/riskGate optional */ }
      const onCtrl = typeof traceContext?.onControlRequest === 'function' ? traceContext.onControlRequest : null;
      // 权限模式 → 网关 L1 预授权（CC 对齐）。bypass = 用户已对 L1 类操作给出「标准答案」；
      // acceptEdits = 仅对文件编辑类工具预授权。autoApproveL1 只放行 L1（黄灯），**绝不触及
      // L2 红线**（删除/安装/系统路径/破坏性仍须键入 YES），且对临界红线（criticalGate）一律
      // 不预授权——确保 bypass/acceptEdits 都无法绕过不可覆盖红线。
      let gwAutoApproveL1 = false;
      try {
        const _mode = getPermissionMode();
        if (_mode === 'bypass' || _mode === 'acceptEdits') {
          // Unbypassable gate (destructive OR critical) is never L1-preauthorized,
          // mirroring requestPermission's backstop. The gateway still classifies
          // destructive → L2 on its own, but reading the same predicate here keeps
          // the two definitions in lockstep (single source of truth in riskGate).
          let _unbypassable = false;
          if (process.env.KHY_HUMAN_GATE !== 'off') {
            try {
              const riskGate = require('./riskGate');
              // Reuse the assessment already computed for the gateway signals
              // (single source of truth); only re-assess if it was unavailable
              // (e.g. KHY_GATEWAY_DYNAMIC_RISK=off path skipped it).
              const a = gwAssessment || riskGate.assess(permissionKey, normalizedParams, descriptor);
              _unbypassable = riskGate.isUnbypassableGate(a);
            } catch { /* riskGate optional */ }
          }
          if (!_unbypassable) {
            if (_mode === 'bypass') gwAutoApproveL1 = true;
            else {
              const _norm = String(permissionKey).toLowerCase().replace(/[\s_-]/g, '');
              if (_ACCEPT_EDITS_TOOLS.has(_norm) && !gwDestructive) gwAutoApproveL1 = true;
            }
          }
        }
      } catch { /* mode resolution optional — default to no pre-approval */ }
      // ── 自主/非交互 L1 自动放行(headless `khy -p`/管道/后台 → onCtrl 缺失)──────────────
      // [AI-弱模型·别绕过红线] dogfood 实测:非交互环境(无交互器)下 approvalRouter 对 L1(黄灯)
      // 一律 fail-closed 拒绝(「L1 需用户确认但无交互器」),于是 headless khy 连 node/sleep/timeout/
      // npm test/git add 都跑不了——用户显式 `khy -p` 起一个自主任务却无从完成(Goal「khy 布置要能
      // 完成任务」)。对齐 Claude Code headless `-p`:自主模式自动跑 L1,**唯 L2 红线(删除/全局装/
      // 系统路径/破坏性)仍 fail-closed 需人**。onCtrl 缺失=无人可问=自主上下文。仅当门开 + 无交互器
      // + 未被权限模式预授权 + 非不可越红线(isUnbypassableGate 双保险)才置 gwAutoApproveL1。
      // autoApproveL1 在 router 里**只作用于 L1 分支**——L2 红灯分支不读此标志,红线零弱化。
      // 门控 KHY_AUTONOMOUS_L1_AUTO_APPROVE(default-on·CANON);关 → 逐字节回退今日 L1 fail-closed。
      try {
        if (!onCtrl && !gwAutoApproveL1
            && flagRegistry.isFlagEnabled('KHY_AUTONOMOUS_L1_AUTO_APPROVE', process.env)) {
          let _autoUnbypassable = false;
          try {
            const riskGate = require('./riskGate');
            const a = gwAssessment || riskGate.assess(permissionKey, normalizedParams, descriptor);
            _autoUnbypassable = riskGate.isUnbypassableGate(a);
          } catch { /* riskGate optional — 保守不放行 */ _autoUnbypassable = true; }
          if (!_autoUnbypassable) gwAutoApproveL1 = true;
        }
      } catch { /* autonomous L1 auto-approve optional — default to no pre-approval */ }
      const verdict = await gateway.evaluate(
        {
          sessionId: traceCtx.sessionId,
          tool: permissionKey,
          params: normalizedParams,
          isReadOnly: gwReadOnly,
          isDestructive: gwDestructive,
          risk: gwRisk,
          sandboxEscape: gwSandboxEscape,
        },
        { prompter: gateway.makeControlPrompter(onCtrl), autoApproveL1: gwAutoApproveL1 },
      );
      if (!verdict.allow) {
        let reason = `系统调用网关拦截 [${verdict.level}${verdict.tripped ? '/已熔断' : ''}]: ${verdict.reasons.join('; ')}`;
        // 反幻觉提示(门控 KHY_GATEWAY_DENY_HINT,默认开):写入/创建类工具被拒时,明确告知模型
        // 「文件未写入,勿声称已完成」。此前 khy 曾在写被网关拒后仍向用户宣称「文件都存好了」,
        // 根因是拒绝原文对模型不够「响亮」。仅对非只读(写/建)工具追加,读类不加(避免噪声)。
        try {
          const _hintOff = ['0', 'false', 'off', 'no', 'disable', 'disabled'];
          const _hintOn = !_hintOff.includes(String(process.env.KHY_GATEWAY_DENY_HINT || '').trim().toLowerCase());
          const _isWriteClass = gwReadOnly !== true
            && /(write|edit|create|patch|scaffold|notebook|append|mkdir|move|rename|multiedit|save)/i.test(String(permissionKey || ''));
          if (_hintOn && _isWriteClass) {
            reason += '（该工具调用被拒绝，文件未写入/未修改；请勿声称已完成，如实向用户说明被网关拦截）';
          }
        } catch { /* 提示拼接失败不影响拒绝主流程 */ }
        emitWrapper('end', {
          tool: permissionKey, success: false, denied: true, permission: 'deny',
          gateway: { level: verdict.level, decision: verdict.decision, tripped: verdict.tripped },
          elapsedMs: Date.now() - wrapperStart,
        });
        try {
          require('./receiptService').appendToolCall({
            sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
            result: { success: false }, permission: 'deny', elapsedMs: 0,
            stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel, error: reason,
          });
        } catch { /* receipt non-critical */ }
        return { success: false, error: reason, denied: true, _gatewayBlocked: true };
      }
      // 网关放行 → 盖不可伪造 EXEC_APPROVED 戳，既有 requestPermission 据此免二次打断。
      // [AI-弱模型·别绕过] 此戳是「已通过中央审批」的不可伪造凭据,只应由本审批网关在放行时盖。
      //   绝不在别处预置/伪造 EXEC_APPROVED 来让某调用跳过 requestPermission。
      if (verdict.decision === gateway.DECISIONS.USER_ALLOW || verdict.decision === gateway.DECISIONS.AUTO_ALLOW) {
        try {
          const { EXEC_APPROVED } = require('./execApproval');
          if (EXEC_APPROVED) normalizedParams[EXEC_APPROVED] = true;
        } catch { /* execApproval optional — fall through to classic prompt */ }
      }
    } catch { /* 防呆④: 网关加载/裁决异常不得放行也不得卡死 → 落回既有管线（其自身 fail-safe） */ }
  }

  // ── 元约束能力地板守卫（[DESIGN-ARCH-034] 接管点）─────────────────────
  // 按「执行该动作的模型」的能力向量求出约束地板，并对这一次具体调用真正挂锁：
  // 强模型 Prompt_Soft 直接放行（零校验损耗）；弱模型 Code_Hard 对候选 content 跑
  // AST/语法拦截器，语法不过即拦截；System_Block 极危操作要求显式确认（网关已盖
  // EXEC_APPROVED 戳的免二次打断）。零侵入：只读 metaConstraint/metaplan 单一真源。
  // kill-switch KHY_METACONSTRAINT=off；能力层异常一律 fail-open 落回既有管线。byte-identical（offDisables）。
  if (getCapabilityMatrix().isEnabledAt(CAP_SEAMS.POST_TOOL_GOVERNANCE, 'metaConstraint', {})) {
    try {
      const guard = require('./metaConstraint/toolFunnelGuard');
      const verdict = await guard.enforce({
        tool: permissionKey,
        params: normalizedParams,
        descriptor,
        traceContext,
      });
      if (verdict && verdict.allow === false) {
        emitWrapper('end', {
          tool: permissionKey, success: false, denied: true, permission: 'deny',
          capabilityFloor: { floor: verdict.floor, band: verdict.band, riskClass: verdict.riskClass },
          elapsedMs: Date.now() - wrapperStart,
        });
        try {
          require('./receiptService').appendToolCall({
            sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
            result: { success: false }, permission: 'deny', elapsedMs: 0,
            stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel, error: verdict.error,
          });
        } catch { /* receipt non-critical */ }
        return { success: false, error: verdict.error, denied: true, _capabilityFloorBlocked: true };
      }
    } catch { /* 防呆 fail-open: 能力层加载/裁决异常 → 落回既有管线（权限/网关/锁仍把关） */ }
  }

  const permission = await requestPermission(
    permissionKey,
    normalizedParams,
    typeof traceContext?.onControlRequest === 'function' ? traceContext.onControlRequest : null,
  );
  if (permission === 'deny') {
    emitWrapper('end', {
      tool: permissionKey,
      success: false,
      denied: true,
      permission: 'deny',
      elapsedMs: Date.now() - wrapperStart,
    });
    // Audit denied call
    try {
      const { logToolExecution } = require('./auditLog');
      logToolExecution({ tool: permissionKey, params: normalizedParams, result: { success: false }, permission: 'deny', elapsed: 0 });
    } catch { /* audit is non-critical */ }
    try {
      require('./receiptService').appendToolCall({
        sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
        result: { success: false }, permission: 'deny', elapsedMs: 0,
        stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel,
      });
    } catch { /* receipt is non-critical */ }
    return { success: false, error: 'User denied tool execution', denied: true };
  }

  // Execute
  const start = Date.now();
  emitActivity({ phase: 'execute_start', tool: permissionKey });
  emitProgress(`Executing ${permissionKey}`);

  // Per-tool execution timeout — prevents a single hanging tool from blocking
  // the entire loop until the 600s absolute timeout.
  //
  // Budget is model-settable PER CALL via `params.timeoutMs` (gated
  // KHY_TOOL_TIMEOUT); env `KHY_TOOL_EXEC_TIMEOUT_MS` is the fallback; default
  // 120000. When no `timeoutMs` is supplied (or the gate is off) this is
  // byte-identical to the previous `parseInt(env||'120000')`. On timeout the
  // reject is TAGGED (markToolExecTimeoutError) so the outer catch shapes it
  // into an HONEST, retryable timeout result — the tool call is cut, but the
  // AI gateway is NEVER aborted (a tool timeout is caught here, between gateway
  // LLM calls, and returned to the loop as a structured tool_result).
  let _toolTimeoutLeaf = null;
  try { _toolTimeoutLeaf = require('../tools/_toolTimeout'); } catch { _toolTimeoutLeaf = null; }
  const TOOL_EXEC_TIMEOUT_MS = _toolTimeoutLeaf && typeof _toolTimeoutLeaf.resolveToolExecBudgetMs === 'function'
    ? _toolTimeoutLeaf.resolveToolExecBudgetMs({
      paramMs: normalizedParams && normalizedParams.timeoutMs,
      env: process.env,
    })
    : parseInt(process.env.KHY_TOOL_EXEC_TIMEOUT_MS || '120000', 10);
  const _withToolTimeout = (promise, toolLabel) => {
    // ESC / 用户中断竞赛(门控 KHY_TOOL_ABORT_SIGNAL,默认开):当 loop 供了 abort 信号,
    // 在途工具与 abort 竞赛——信号触发 → 以带取消标记的错误落败,外层 catch 塑成诚实、可重试
    // 的「已取消」结果。cleanup 在 settle 后移除挂在长寿命 parentAbort.signal 上的监听。
    // 无信号 / 门控关 → attachAbortRace 未介入,`raced === promise`,下面逐字节回退今日竞赛。
    let raced = promise;
    let _abortCleanup = null;
    if (_toolAbortSignal && _toolTimeoutLeaf && typeof _toolTimeoutLeaf.attachAbortRace === 'function') {
      try {
        const a = _toolTimeoutLeaf.attachAbortRace(raced, _toolAbortSignal, toolLabel, process.env);
        raced = a.promise;
        _abortCleanup = a.cleanup;
      } catch { raced = promise; _abortCleanup = null; }
    }
    if (TOOL_EXEC_TIMEOUT_MS <= 0) {
      return _abortCleanup ? Promise.resolve(raced).finally(_abortCleanup) : raced; // 超时禁用:仅 abort 竞赛
    }
    const out = Promise.race([
      raced,
      new Promise((_, reject) => {
        const timer = setTimeout(() => {
          const timeoutErr = new Error(`Tool execution timeout: ${toolLabel} exceeded ${TOOL_EXEC_TIMEOUT_MS}ms`);
          if (_toolTimeoutLeaf && typeof _toolTimeoutLeaf.markToolExecTimeoutError === 'function') {
            _toolTimeoutLeaf.markToolExecTimeoutError(timeoutErr, { toolLabel, timeoutMs: TOOL_EXEC_TIMEOUT_MS });
          }
          reject(timeoutErr);
        }, TOOL_EXEC_TIMEOUT_MS);
        // Prevent timer from keeping the process alive
        if (timer.unref) timer.unref();
      }),
    ]);
    return _abortCleanup ? out.finally(_abortCleanup) : out;
  };

  // Cross-process file lock (multi-instance safety). Acquired here — at the
  // single tool-execution gateway — so it spans the tool's ENTIRE execute(),
  // covering read-modify-write edit tools (else two instances could both read,
  // both edit, and the last writer would silently clobber the other). Returns
  // null for non-write tools / unresolvable paths (zero overhead, naked run).
  // 防呆: lock LOGIC lives in the tool layer (../tools/_fileLock); the scheduler
  // is untouched. A contention timeout throws and is surfaced to the Agent via
  // the existing ToolError path below. Released in `finally`.
  let _fileLockHandle = null;

  // ── evoEngine 运行态痛点观测（旁路抄送，协作而非替代）──────────────────
  // 工具真实失败时，把 friction 抄送 evoEngine 作轻量「感知 + 留痕」：归因铸造
  // EvoRequirement 落入不可变日志的 observations 积压，供离线 evolve 消费。**绝不**
  // 在此热路径跑代码生成/沙箱。核心循环始终权威，本桥 fail-soft、有界去重、永不
  // 阻断工具结果。接入开关 KHY_EVO_ENGINE（默认开启，=off 关闭）。定义在 try 之外，
  // 使软失败出口与硬抛 catch 出口都能调用。
  const _observeEvoFriction = (failure) => {
    // byte-identical to `KHY_EVO_ENGINE === 'off'` (offDisables).
    if (!getCapabilityMatrix().isEnabledAt(CAP_SEAMS.POST_TOOL_GOVERNANCE, 'evoEngine', {})) return;
    try {
      require('./evoEngine/frictionBridge').observeFailure({
        signal: 'tool-failure',
        surface: permissionKey,
        error: failure instanceof Error ? failure : (failure && failure.error) || failure,
        context: { tool: permissionKey, sessionId: traceCtx.sessionId },
      });
    } catch { /* 防呆: 观测异常绝不影响工具结果 */ }
  };

  try {
    try {
      _fileLockHandle = await require('../tools/_fileLock')
        .acquireForToolCall(permissionKey, normalizedParams);
    } catch (lockErr) {
      if (lockErr && lockErr.code === 'EFILELOCKTIMEOUT') throw lockErr; // → ToolError → Agent
      _fileLockHandle = null; // any other lock fault: 防呆 — never block the write
    }
    let result;
    // CC-aligned semantic-number coercion (src/utils/semanticNumber.ts): the model
    // occasionally quotes numbers — {"head_limit":"30"} — and a `type:'number'`
    // schema would reject the string outright. Coerce valid decimal-literal strings
    // to numbers ONCE here, so the SAME params feed both validation and
    // execute/handler below. Gated KHY_SEMANTIC_NUMBER (default on); gate-off / no
    // coercible param → returns the original reference (byte-identical fallback).
    // Only registry (inputSchema) and builtin (parameters) carry flat declarative
    // schemas; compat tools keep their bespoke inline coercion (_coerceValue).
    //
    // `normalizedParams` is `const` (2721) — 绝不重赋(其在守卫钩子分支 3027/3047 的重赋
    // 本就被 try/catch 静默吞没,等同 no-op)。改派生一个**只供校验 + 执行读取**的
    // execParams;诊断 / 回执 / 钩子等其余路径仍读原 normalizedParams,爆炸半径最小。
    let execParams = normalizedParams;
    try {
      const _numSchema = descriptor.source === 'registry'
        ? descriptor.tool.inputSchema
        : (descriptor.source === 'builtin' ? descriptor.tool.parameters : null);
      if (_numSchema) {
        execParams = require('../tools/semanticNumberCoerce')
          .coerceSchemaNumbers(_numSchema, normalizedParams);
      }
    } catch { execParams = normalizedParams; /* 防呆: 归一异常 → 退原 params */ }
    // Optional param-normalization hook (source-agnostic): a tool may clamp /
    // canonicalize params BEFORE schema validation. Used by shellCommand to clamp
    // an over-max timeout to the cap instead of hard-rejecting → opaque "Invalid
    // tool parameters" (KHY_SHELL_TIMEOUT_CLAMP). Runs before validate(3627+),
    // validateInput(3638+), builtin validateParams(3654+), and execute — one edit
    // covers every consumer. Fail-soft: any error → keep execParams unchanged.
    if (descriptor && descriptor.tool && typeof descriptor.tool.normalizeParams === 'function') {
      try { execParams = descriptor.tool.normalizeParams(execParams, process.env); }
      catch { /* fail-soft: 保留 execParams */ }
    }
    // Registry-source semantic/shape validation runs once, up front, with its
    // early-return contract preserved byte-for-byte (no behavior change).
    if (descriptor.source === 'registry') {
      if (typeof descriptor.tool.validate === 'function') {
        const validation = descriptor.tool.validate(execParams);
        if (!validation.valid) {
          return {
            success: false,
            error: require('../tools/ccValidationError').formatValidationError(
              descriptor.resolvedName || normalizedName || toolName, validation, process.env
            ),
          };
        }
      }
      if (typeof descriptor.tool.validateInput === 'function') {
        const semantic = await descriptor.tool.validateInput(execParams, toolExecutionContext);
        if (semantic && semantic.valid === false) {
          return {
            success: false,
            error: semantic.message || 'Semantic validation failed',
          };
        }
      }
    }
    // Builtin-source tools carry a declarative flat `parameters` schema but no
    // `.validate()` method (they are raw { name, parameters, handler } objects,
    // not defineTool() products). Enforce the same up-front schema check so that
    // EVERY tool source — not just registry — gets CC-aligned input validation
    // (invalid input → structured error the model can recover from, rather than
    // a deeper handler-time crash). Compat tools keep their bespoke inline checks.
    if (descriptor.source === 'builtin' && descriptor.tool.parameters) {
      const validation = validateParams(descriptor.tool.parameters, execParams);
      if (!validation.valid) {
        return {
          success: false,
          error: require('../tools/ccValidationError').formatValidationError(
            descriptor.resolvedName || normalizedName || toolName, validation, process.env
          ),
        };
      }
    }
    // The raw tool dispatch, factored into a closure so the dependency
    // self-healing loop can retry the *exact same* call once after installing a
    // missing dependency. No healing wraps this closure → the retry is naked,
    // so there is no risk of recursive healing (anti-loop, 防呆②).
    const _runDescriptor = async () => {
      if (descriptor.source === 'builtin') {
        return _withToolTimeout(
          descriptor.tool.handler(execParams, toolExecutionContext),
          permissionKey
        );
      }
      if (descriptor.source === 'registry') {
        return _withToolTimeout(
          descriptor.tool.execute(execParams, toolExecutionContext),
          permissionKey
        );
      }
      return _withToolTimeout(
        _executeCompatTool(descriptor.resolvedName, execParams, traceContext),
        permissionKey
      );
    };

    // ── 依赖自愈循环（非侵入接入单一漏斗）─────────────────────────────
    // 工具失败后，识别"依赖缺失"→交互询问安装→隔离执行→重试一次。任何异常都
    // fail-safe 返回 null（原错误照常透出）。总开关 KHY_DEP_HEALING（=off 关闭）。
    const _runDepHealing = async (failureSignal) => {
      // byte-identical to `KHY_DEP_HEALING === 'off'` (offDisables).
      if (!getCapabilityMatrix().isEnabledAt(CAP_SEAMS.POST_TOOL_GOVERNANCE, 'depHealing', {})) return null;
      // DESIGN-ARCH-048: dependency self-healing mutates the environment and is
      // non-deterministic; it must never run during a deterministic trajectory
      // replay. Bypass it when the caller marks the context as a replay run.
      if (traceContext?.replay) return null;
      try {
        const healing = require('./dependency/healingLoop');
        return await healing.heal({
          toolName: permissionKey,
          failure: failureSignal,
          retry: _runDescriptor,
          control: typeof traceContext?.onControlRequest === 'function' ? traceContext.onControlRequest : null,
          sessionId: traceCtx.sessionId,
        });
      } catch { return null; }
    };

    result = await (async () => {
      try {
        return await _runDescriptor();
      } catch (runErr) {
        // A hard-thrown dependency error (e.g. "Python3 not found. Install …")
        // gets one self-healing attempt too; on success we adopt the retry
        // result, otherwise we attach guidance and rethrow into the existing
        // structured-error catch below (no behavior loss).
        const outcome = await _runDepHealing(runErr);
        if (outcome && outcome.healed) return outcome.result;
        if (outcome) {
          try {
            runErr._depHealing = require('./dependency/healingLoop').summarizeForAgent(outcome);
          } catch { /* guidance best-effort */ }
        }
        throw runErr;
      }
    })();

    // ── MCP 结果结构化契约(在任何 result.success 分类之前施加)──────────────
    // MCP 工具 handler 返回原始协议形 `{ content:[...], isError }`:无 `success` 字段、
    // 且 `content` 是数组。**每一条运行时 agent 路径都直连调用 executeTool**(不走
    // tools/index.js 那个会归一的 wrapper),所以不归一的话:成功的 MCP 调用(isError:false、
    // 无 success)会被本函数下方的分类(`!!result.success` 遥测 / emitProgress)以及直连消费者
    // (toolUseLoop `!result.success` 等 20+ 处)读成失败;且 content 数组会被下游 JSON.stringify
    // 成畸形串。此处对 **MCP 形结果**走 canonical normalizeToolResult(isError→success、
    // content 数组→字符串),复用单一真源避免再造方言。对已带 `success` 的 KHY 内部结果
    // (静态 builtin / registry 工具全都设了 success),`_isMCPCallToolResult` 返回 false →
    // **逐字节零变化**。门控 KHY_MCP_RESULT_NORMALIZE(默认开)= off → 逐字节回退原样透出。
    // best-effort:归一自身绝不打断工具结果链(异常则维持原 result)。
    try {
      if (result && typeof result === 'object'
          && flagRegistry.isFlagEnabled('KHY_MCP_RESULT_NORMALIZE', process.env)
          && _isMCPCallToolResult(result)) {
        result = normalizeToolResult(result);
      }
    } catch { /* 归一 best-effort;失败则原样透出,绝不破坏工具结果路径 */ }

    // If the tool failed (soft error), try to self-heal a missing dependency
    // before reporting it.
    if (result && result.success === false) {
      const outcome = await _runDepHealing(result);
      if (outcome && outcome.healed) {
        result = outcome.result; // retry after install succeeded
      } else if (outcome) {
        try {
          const healing = require('./dependency/healingLoop');
          const summary = healing.summarizeForAgent(outcome);
          if (summary && result && typeof result === 'object') result._depHealing = summary;
        } catch { /* guidance is best-effort */ }
      }
    }

    // Genuine, unhealed soft failure → side-channel observe for self-evolution.
    if (result && result.success === false) _observeEvoFriction(result);

    // Wrap handler-returned error results as structured ToolError format
    if (result && result.success === false && result.error && typeof result.error === 'string') {
      try {
        const { ToolError } = require('./toolError');
        const wrapped = ToolError.fromGenericError(new Error(result.error));
        const structured = wrapped.toStructuredResult();
        // Preserve extra fields from original result (output, exitCode, etc.)
        Object.assign(structured, { output: result.output, exitCode: result.exitCode, denied: result.denied });
        // Audit
        try {
          const { logToolExecution } = require('./auditLog');
          logToolExecution({ tool: permissionKey, params: normalizedParams, result: structured, permission, elapsed: Date.now() - start });
        } catch { /* non-critical */ }
        try {
          require('./receiptService').appendToolCall({
            sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
            result: structured, permission, elapsedMs: Date.now() - start,
            stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel,
            error: structured.error || result.error,
          });
        } catch { /* receipt is non-critical */ }
        emitWrapper('end', {
          tool: permissionKey,
          success: false,
          permission,
          elapsedMs: Date.now() - wrapperStart,
          error: structured.error || result.error,
        });
        return structured;
      } catch { /* toolError not available — return as-is */ }
    }
    // Audit successful call
    try {
      const { logToolExecution } = require('./auditLog');
      logToolExecution({ tool: permissionKey, params: normalizedParams, result, permission, elapsed: Date.now() - start });
    } catch { /* audit is non-critical */ }
    try {
      require('./receiptService').appendToolCall({
        sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
        result, permission, elapsedMs: Date.now() - start,
        stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel,
        error: result?.success ? null : result?.error || null,
      });
    } catch { /* receipt is non-critical */ }
    // Telemetry tracking
    try {
      const telemetry = require('./telemetryService');
      telemetry.trackToolCall({ tool: permissionKey, success: !!result.success, elapsed: Date.now() - start });
    } catch { /* telemetry is non-critical */ }
    emitWrapper('end', {
      tool: permissionKey,
      success: !!result?.success,
      permission,
      elapsedMs: Date.now() - wrapperStart,
      error: result?.success ? null : result?.error || null,
    });
    emitActivity({
      phase: 'execute_end',
      tool: permissionKey,
      success: !!result?.success,
      elapsedMs: Date.now() - start,
    });
    emitProgress(`${permissionKey} ${result?.success ? 'succeeded' : 'finished with error'}`);
    return result;
  } catch (err) {
    const elapsed = Date.now() - start;
    // Honest, retryable shaping for a per-tool-execution funnel timeout. The
    // tool call hit its time budget and was cut, but this is NOT a terminal
    // failure and the AI gateway was never aborted — tell the model plainly it
    // may retry with a DIFFERENT method (narrower scope / a faster tool / a
    // smaller batch / an explicit larger timeoutMs). Gated KHY_TOOL_TIMEOUT;
    // off (or leaf unavailable) → falls through to today's generic ToolError
    // shaping below, byte-identical.
    let structuredResult = null;
    let _isToolExecTimeout = false;
    try {
      const _tt = require('../tools/_toolTimeout');
      if (_tt && typeof _tt.isToolExecTimeoutError === 'function' && _tt.isToolExecTimeoutError(err)) {
        const shaped = _tt.buildToolExecTimeoutResult({
          toolLabel: permissionKey,
          timeoutMs: err.__timeoutMs,
          elapsedMs: elapsed,
          env: process.env,
        });
        if (shaped) { structuredResult = shaped; _isToolExecTimeout = true; }
      }
    } catch { /* fail-soft → generic shaping below */ }
    // Honest shaping for a user-initiated cancellation (ESC / interrupt reached
    // the in-flight tool via the abort signal). Distinct from a timeout: the user
    // asked to stop. Retryable, and NOT a code defect (skip evo-friction, like a
    // timeout). Gated KHY_TOOL_ABORT_SIGNAL; off / leaf unavailable → falls through
    // to generic ToolError shaping, byte-identical.
    if (!structuredResult) {
      try {
        const _tt = require('../tools/_toolTimeout');
        if (_tt && typeof _tt.isToolCancelledError === 'function' && _tt.isToolCancelledError(err)) {
          const shaped = _tt.buildToolCancelledResult({
            toolLabel: permissionKey,
            elapsedMs: elapsed,
            env: process.env,
          });
          if (shaped) { structuredResult = shaped; _isToolExecTimeout = true; }
        }
      } catch { /* fail-soft → generic shaping below */ }
    }
    if (!structuredResult) {
      // Wrap as ToolError for structured error reporting
      let toolError;
      try {
        const { ToolError } = require('./toolError');
        toolError = ToolError.isToolError(err) ? err : ToolError.fromGenericError(err);
      } catch { toolError = null; }
      structuredResult = toolError ? toolError.toStructuredResult() : { success: false, error: err.message };
    }
    // Surface dependency self-healing guidance attached upstream (declined /
    // install-failed / manual-required), so the Agent gets an actionable hint
    // instead of an opaque hard error.
    if (err && err._depHealing) {
      try { structuredResult._depHealing = err._depHealing; } catch { /* non-critical */ }
    }
    // Hard-thrown tool failure → side-channel observe for self-evolution.
    // A timeout is a time/resource condition, not a code defect — do not
    // pollute the evo backlog (or trigger dep-healing signals) with it.
    if (!_isToolExecTimeout) _observeEvoFriction(err);
    // Audit failed call
    try {
      const { logToolExecution } = require('./auditLog');
      logToolExecution({ tool: permissionKey, params: normalizedParams, result: structuredResult, permission, elapsed });
    } catch { /* audit is non-critical */ }
    try {
      require('./receiptService').appendToolCall({
        sessionId: traceCtx.sessionId, tool: permissionKey, params: normalizedParams,
        result: structuredResult, permission, elapsedMs: elapsed,
        stepType: stepAssessment.stepType, risk: stepAssessment.riskLevel,
        error: err?.message || 'unknown error',
      });
    } catch { /* receipt is non-critical */ }
    try {
      const telemetry = require('./telemetryService');
      telemetry.trackToolCall({ tool: permissionKey, success: false, elapsed, error: err.message });
    } catch { /* telemetry is non-critical */ }
    emitWrapper('end', {
      tool: permissionKey,
      success: false,
      permission,
      elapsedMs: Date.now() - wrapperStart,
      error: err?.message || 'unknown error',
    });
    emitActivity({
      phase: 'execute_end',
      tool: permissionKey,
      success: false,
      elapsedMs: Date.now() - start,
      error: err?.message || 'unknown error',
    });
    emitProgress(`${permissionKey} failed`);
    return structuredResult;
  } finally {
    if (_fileLockHandle) {
      try { _fileLockHandle.release(); } catch { /* best-effort lock release */ }
    }
  }
}

/**
 * Get the tool definitions in Claude/OpenAI function-calling format.
 * Used when sending messages to AI models that support tool use.
 */
function getToolDefinitions() {
  const defs = _allTools.map(tool => ({
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

  const registry = _getToolRegistry();
  if (registry && typeof registry.getEnabledDefinitions === 'function') {
    try {
      defs.push(...registry.getEnabledDefinitions());
    } catch { /* best effort */ }
  } else if (registry && typeof registry.getDefinitions === 'function') {
    try {
      defs.push(...registry.getDefinitions());
    } catch { /* best effort */ }
  }

  defs.push(...getClaudeCompatToolDefinitions());

  // Deduplicate: normalize snake_case/camelCase to catch duplicates like
  // shell_command vs shellCommand, data_fetch vs dataFetch, etc.
  const _normalize = (name) => String(name || '').trim().toLowerCase().replace(/_/g, '');
  const seen = new Set();
  const deduped = [];
  for (const def of defs) {
    const key = String(def?.name || '').trim();
    const norm = _normalize(key);
    if (!key || seen.has(norm)) continue;
    seen.add(norm);
    deduped.push(def);
  }

  // Tool-redundancy collapse (KHY_TOOL_DEDUP, default on): fold verified
  // duplicate implementations (readFile→Read / writeFile→Write / editFile→Edit)
  // into the canonical tool's aliases so the model sees ONE tool per operation.
  // Folded names stay callable via the existing alias resolution → zero
  // capability loss; gate off → byte-identical legacy list. Single source of
  // truth for the duplicate pairs lives in the pure leaf toolRegistryDedup.
  let collapsed = deduped;
  try {
    collapsed = require('./toolRegistryDedup').collapseRedundant(deduped);
  } catch { collapsed = deduped; /* fail-soft */ }

  // [P1#3] 参数命名统一(KHY_TOOL_PARAM_NAMING,默认开):把暴露给模型的参数键统一
  // 成 snake_case(纯大小写折叠,绝不合并语义不同的词),让模型只看到一种风格。
  // 执行侧 expandParamAliases 会把入参补回工具期望的拼写 → 往返无损、能力零损失。
  try {
    collapsed = require('./toolParamNaming').canonicalizeDefs(collapsed);
  } catch { /* fail-soft:命名归一失败绝不阻断工具定义 */ }

  // Stable-prefix mode (DESIGN-ARCH-047): sort tool definitions by name so the
  // tool block is byte-stable across requests — async MCP registration / lazy
  // toolSearch reveals otherwise reorder the tail and bust the Anthropic
  // "last tool" cache breakpoint. Order is not semantically significant
  // (consumers key on name/id, never index). Off by default → today's order.
  if (process.env.KHY_STABLE_PREFIX === '1') {
    collapsed.sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')));
  }
  // Claude Code SDK alignment: `--allowedTools` / `--disallowedTools` (print mode).
  // Applied at this single chokepoint so every khy-native adapter path inherits
  // the same gating — the model can only see, and therefore only call, the
  // permitted tools. `disallowed` wins over `allowed`. The gate lives in the
  // shared toolAccessGateway leaf (also consumed by the external Claude Code
  // delegate in cliToolAdapter).
  return _toolAccessGateway().filterToolDefs(collapsed);
}

// Lazy require to avoid any load-order coupling; the leaf is dependency-free.
function _toolAccessGateway() {
  return require('./toolAccessGateway');
}

/**
 * Tool definitions for the chat Agent, including a user's enabled marketplace
 * plugin tools (`plugin__<slug>__<op>`). The static `getToolDefinitions()` is
 * synchronous + global; per-user plugin tools require a DB lookup, so this async
 * variant layers them on top. Falls back to the static list if userId is absent
 * or the plugin lookup fails (plugins must never break the base tool surface).
 *
 * @param {number|string|null} userId
 * @returns {Promise<Array>}
 */
async function getToolDefinitionsForUser(userId) {
  const base = getToolDefinitions();
  if (userId == null || process.env.KHY_PLUGINS === 'off') return base;
  try {
    const pluginBridge = require('./plugins/pluginToolBridge');
    const pluginTools = await pluginBridge.listUserPluginTools(userId);
    if (!pluginTools || !pluginTools.length) return base;
    const have = new Set(base.map((d) => String(d && d.name || '')));
    for (const t of pluginTools) {
      if (have.has(t.name)) continue;
      have.add(t.name);
      base.push({
        name: t.name,
        description: t.description,
        // openapiTools already emits a JSON-Schema input_schema; expose it as
        // `parameters` to match the rest of the definitions.
        parameters: t.input_schema || { type: 'object', properties: {} },
      });
    }
  } catch { /* plugins are additive; never break the base tool list */ }
  return base;
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
          const result = await server.callTool(tool.name, params);
          if (result && typeof result === 'object') {
            result._source = 'mcp';
            result._mcpServer = server.name;
          }
          return result;
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
  const list = _allTools.map(t => ({
    name: t.name,
    description: t.description,
    category: t.category,
    risk: t.risk,
  }));

  const registry = _getToolRegistry();
  if (registry) {
    try {
      const all = registry.getAll();
      if (all && typeof all.values === 'function') {
        for (const tool of all.values()) {
          list.push({
            name: tool.name,
            description: tool.description,
            category: tool.category,
            risk: tool.risk,
          });
        }
      }
    } catch { /* best effort */ }
  }

  list.push(..._claudeCompatTools);

  const seen = new Set();
  const deduped = [];
  for (const item of list) {
    const key = String(item?.name || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

/**
 * Get MCP servers.
 */
function getMCPServers() {
  return _mcpServers;
}


module.exports = {
  // Core
  executeTool,
  getToolDefinitions,
  getToolDefinitionsForUser,
  listTools,
  formatToolCall,

  // Tool access gateway (Claude Code --allowedTools / --disallowedTools).
  // Re-exported from the shared leaf for backward-compatible call sites.
  setToolAccessGateway: (...a) => require('./toolAccessGateway').setToolAccessGateway(...a),
  clearToolAccessGateway: (...a) => require('./toolAccessGateway').clearToolAccessGateway(...a),

  // Permissions
  requestPermission,
  _decisionFromControl,
  enableDangerousMode,
  disableDangerousMode,
  isDangerousMode,
  acknowledgeDangerousMode,
  setPermissionMode,
  getPermissionMode,
  permissionModeToProfile,
  PERMISSION_MODES,
  approveTool,
  isApproved,
  setReadlineProvider,
  getReadlineProvider,
  setPreflightContext,
  clearPreflightContext,

  // Registration
  registerTool,
  registerMCPServer,
  getMCPServers,

  // Bridge to new tool registry
  getToolRegistry: () => { try { return require('../tools'); } catch { return null; } },

  // Constants
  RISK_LEVELS,
  BUILTIN_TOOLS,

  // App launching helpers (reused by adapters)
  APP_ALIAS_MAP,
  _normalizeAppQuery,
  _buildAppCandidates,
  _matchInstalledApp,
  hasInstalledAppMatch,
  _primeInstalledAppsForTest,
  _resolveOpenDefaultTarget,

  // Policy
  _checkToolPolicy,
  _checkActiveSkillPolicy,
};
