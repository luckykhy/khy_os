'use strict';

/**
 * selfProfile.js — khy OS 自我画像服务（单一事实来源）
 *
 * 设计理念：像人一样，清晰的自我认知让 agent 更明确自己能做什么、怎么做。
 *
 * 三重输出：
 *   formatForSystemPrompt()  → 注入 system prompt，agent 自知（token-efficient）
 *   formatForHuman()         → khy self 命令输出，学习者他知（中文 Markdown）
 *   formatForAPI()           → JSON，供前端/外部系统消费
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

// ─── Lazy requires (avoid circular deps at startup) ──────────────────────────

let _skillsModule = null;
function getSkillsModule() {
  if (!_skillsModule) _skillsModule = require('../skills/index');
  return _skillsModule;
}

let _commandSchema = null;
function getCommandSchema() {
  if (!_commandSchema) _commandSchema = require('../constants/commandSchema');
  return _commandSchema;
}

let _gateway = null;
function getGateway() {
  if (!_gateway) {
    try { _gateway = require('./gateway/aiGateway'); } catch { _gateway = null; }
  }
  return _gateway;
}

let _localLLM = null;
function getLocalLLM() {
  if (!_localLLM) {
    try { _localLLM = require('./localLLMService'); } catch { _localLLM = null; }
  }
  return _localLLM;
}

let _knowledgeService = null;
function getKnowledgeService() {
  if (!_knowledgeService) {
    try { _knowledgeService = require('./knowledgeTeachingService'); } catch { _knowledgeService = null; }
  }
  return _knowledgeService;
}

let _toolsModule = null;
function getToolsModule() {
  if (!_toolsModule) {
    try { _toolsModule = require('../tools/index'); } catch { _toolsModule = null; }
  }
  return _toolsModule;
}

function getWasmDefaults() {
  return require('../constants/wasmDefaults');
}

let _dataHome = null;
function getDataHome() {
  if (!_dataHome) {
    try { _dataHome = require('../utils/dataHome'); } catch { _dataHome = null; }
  }
  return _dataHome;
}

let _selfLocation = null;
function getSelfLocation() {
  if (!_selfLocation) {
    try { _selfLocation = require('./selfLocation'); } catch { _selfLocation = null; }
  }
  return _selfLocation;
}

let _commandCatalog = null;
function getCommandCatalog() {
  if (!_commandCatalog) {
    try { _commandCatalog = require('./commandCatalog/commandCatalog'); } catch { _commandCatalog = null; }
  }
  return _commandCatalog;
}

function getPackageVersion() {
  try {
    const pkg = require('../../package.json');
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ─── Static profile (cacheable, no runtime dependency) ───────────────────────

let _staticCache = null;

/**
 * Derive gateway adapter count and names from the actual registry.
 * Falls back to empty if gateway is not yet initialized.
 */
function _deriveAdapterInfo() {
  const gw = getGateway();
  if (!gw) return { count: 0, names: [] };
  try {
    const status = typeof gw.getStatus === 'function' ? gw.getStatus() : [];
    const all = Array.isArray(status) ? status : [];
    return { count: all.length, names: all.map(a => a.name || a.key || '').filter(Boolean) };
  } catch {
    return { count: 0, names: [] };
  }
}

/**
 * Derive tool count and category breakdown from the actual tools registry.
 */
function _deriveToolInfo() {
  const tm = getToolsModule();
  if (!tm) return { count: 0, categories: {} };
  try {
    const total = typeof tm.count === 'function' ? tm.count() : 0;
    const grouped = typeof tm.getByCategory === 'function' ? tm.getByCategory() : {};
    const categories = {};
    for (const [cat, tools] of Object.entries(grouped)) {
      categories[cat] = tools.map(t => t.name || '').filter(Boolean);
    }
    return { count: total, categories };
  } catch {
    return { count: 0, categories: {} };
  }
}

function buildStaticProfile() {
  if (_staticCache) return _staticCache;

  const { SUPPORTED_ABIS } = getWasmDefaults();
  const adapterInfo = _deriveAdapterInfo();
  const toolInfo = _deriveToolInfo();

  const adapterDesc = adapterInfo.count > 0
    ? `${adapterInfo.count} 适配器 (${adapterInfo.names.join(', ')})，自动检测与故障转移`
    : '多模型适配器，自动检测与故障转移';

  const toolDesc = toolInfo.count > 0
    ? `${toolInfo.count} 工具`
    : '工具集';

  // Build human-readable tool category descriptions from actual registry
  const toolCategories = {};
  if (Object.keys(toolInfo.categories).length > 0) {
    for (const [cat, names] of Object.entries(toolInfo.categories)) {
      toolCategories[cat] = `${names.length} tools (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', ...' : ''})`;
    }
  } else {
    // Fallback: broad category labels when tools not yet loaded
    Object.assign(toolCategories, {
      file_ops: '文件操作 (read/write/edit/glob/grep)',
      git: 'Git 版本控制',
      task: '任务管理',
      web: 'Web 搜索与抓取',
      code_exec: '代码执行',
      media: '媒体处理',
      agent: '多智能体',
      lsp: '代码智能 (LSP)',
    });
  }

  _staticCache = {
    identity: {
      name: 'khy OS',
      version: getPackageVersion(),
      positioning: 'AI platform operating system with extensible default app runtime',
      personality: '务实、主动、像朋友一样的同事',
    },

    // ====== OS 平台能力（与上层应用严格解耦） ======
    capabilityDomains: {
      ai_gateway: {
        summary: '多模型 AI 网关',
        description: adapterDesc,
      },
      local_inference: {
        summary: '本地 LLM 推理',
        description: '4 级 fallback: ollama-runner → node-llama-cpp → llama-cpp-python → Ollama HTTP',
      },
      tools: {
        summary: toolDesc,
        description: '文件读写编辑、Git、任务管理、Web 搜索/抓取、代码执行、媒体处理、LSP 代码智能',
        categories: toolCategories,
      },
      skills: {
        summary: '可扩展技能系统',
        description: '内置技能 + 用户自定义，支持自动发现、学习、固定/归档',
      },
      commands: {
        summary: 'CLI 命令体系',
        description: '路由命令 + 斜杠命令，涵盖网关/技能/系统/应用管理',
      },
      multi_agent: {
        summary: '多智能体协作',
        description: '进程内 worker + 子进程隔离 + 文件级任务板，支持嵌套、并发限制、超时',
        modes: ['worker (in-process)', 'process (fork isolation)', 'taskBoard (file-based queue)'],
      },
      wasm_runtime: {
        summary: 'WASM 应用沙箱',
        description: `注册/运行 WASM 模块，支持 ${SUPPORTED_ABIS.join('/')} ABI，M1 IPC 模拟`,
        abis: [...SUPPORTED_ABIS],
      },
      os_operations: {
        summary: '系统操作',
        description: 'Alpine ISO 构建、服务管理、安全包管理、环境诊断',
        features: ['Alpine ISO build', 'service management', 'package management', 'khy doctor diagnostics'],
      },
      app_runtime: {
        summary: '应用运行时',
        description: 'khy OS 是平台，上层应用通过 app register/install/run 接入。默认内置应用: khyquant (量化交易)',
        features: ['app register/install/uninstall/start/stop/run', 'app IPC', 'plugin system', 'extension marketplace'],
      },
      learning: {
        summary: '学习引导系统',
        description: '平台级学习框架：XP 等级制、知识库管理、上下文知识推送、知识提炼与同步，上层应用可注册领域知识',
      },
      security: {
        summary: '安全体系',
        description: '工具权限门控、Shell 安全校验、SSRF 防护、审计日志、沙箱执行',
      },
    },

    // ====== OS 层的能力边界（不包含应用层边界） ======
    boundaries: [
      { short: '工具受权限约束', detail: '执行范围由用户权限模式决定，危险操作需确认' },
      { short: '本地推理受硬件限制', detail: '模型精度和速度取决于本机 GPU/CPU 和模型大小' },
      { short: '上下文有限', detail: '超长对话会自动压缩历史，早期信息可能被裁剪' },
      { short: '不伪装确定性', detail: '信息不足时标注「已知/假设/未知」，不编造事实' },
      { short: '平台不等于应用', detail: 'khy OS 提供基础设施，具体业务能力由上层应用 (如 khyquant) 提供' },
    ],
  };

  return _staticCache;
}

// ─── Runtime detection (session-specific, call per request) ──────────────────

function detectRuntimeCapabilities(opts = {}) {
  const runtime = {
    platform: `${os.platform()} ${os.arch()}`,
    nodeVersion: process.version,
    pythonVersion: _detectPython(),
    cwd: opts.cwd || process.cwd(),
    permissionMode: opts.permissionMode || 'normal',
    studyMode: opts.studyMode || false,
  };

  // Gateway state
  const gatewayState = { adapters: [], currentAdapter: null, currentModel: null };
  const gw = getGateway();
  if (gw) {
    try {
      const status = typeof gw.getStatus === 'function' ? gw.getStatus() : {};
      gatewayState.currentAdapter = status.adapter || null;
      gatewayState.currentModel = status.model || opts.model || null;
      if (typeof gw.listAdapters === 'function') {
        gatewayState.adapters = gw.listAdapters()
          .filter(a => a.available)
          .map(a => a.name || a.key);
      }
    } catch { /* gateway not initialized */ }
  }
  if (!gatewayState.currentModel && opts.model) {
    gatewayState.currentModel = opts.model;
  }

  // Local LLM state
  const llmState = { status: 'unknown', backend: null, backends: [] };
  const llm = getLocalLLM();
  if (llm) {
    try {
      const st = typeof llm.getStatus === 'function' ? llm.getStatus() : {};
      llmState.backend = st.backend || null;
      llmState.status = st.loaded ? 'loaded' : (st.available ? 'available' : 'unavailable');
      if (st.backend) llmState.backends.push(st.backend);
    } catch { /* not loaded */ }
  }

  // Tools
  const toolState = {
    enabled: (opts.enabledTools || []).length,
    list: (opts.enabledTools || []).map(t => (typeof t === 'string' ? t : (t.name || t.tool || ''))),
  };

  // Skills
  const skillState = { count: 0, loaded: [] };
  try {
    const sm = getSkillsModule();
    const cmds = typeof sm.getSkillCommands === 'function' ? sm.getSkillCommands() : [];
    skillState.count = cmds.length;
    skillState.loaded = cmds.map(s => s.name);
  } catch { /* skills not available */ }

  // Commands
  const cmdState = { routerCount: 0, slashCount: 0 };
  try {
    const cs = getCommandSchema();
    if (typeof cs.getRouterCommandNames === 'function') {
      cmdState.routerCount = cs.getRouterCommandNames().length;
    }
    if (typeof cs.getBuiltinSlashCommands === 'function') {
      cmdState.slashCount = cs.getBuiltinSlashCommands().length;
    }
  } catch { /* schema not available */ }

  // Self-location: where khy itself is installed + its own source dir. Derived from
  // the real dataHome resolvers so the agent knows the ABSOLUTE path to grep its own
  // code (GrepTool honors absolute paths outside cwd). selfSrcDir = services/backend/src.
  const install = _resolveInstall();

  // Installed apps (detected at runtime). BUG FIX: previously probed opts.cwd (the
  // USER's working dir) for backend/src/services/comprehensiveDataService.js — the
  // root was wrong so it almost never found khy's own files. Probe khy's OWN source
  // dir (install.selfSrcDir === services/backend/src) instead.
  const appsState = { installed: [] };
  try {
    const svcDir = install && install.selfSrcDir
      ? path.join(install.selfSrcDir, 'services')
      : null;
    if (svcDir && fs.existsSync(path.join(svcDir, 'comprehensiveDataService.js'))) {
      appsState.installed.push('khyquant');
    }
  } catch { /* detection failure is fine */ }

  // Learning system (OS-level capability, knowledge content provided by apps)
  const learningState = { level: 'unknown', xp: 0, builtinCount: 0, learnedCount: 0, completionRate: 0 };
  const ks = getKnowledgeService();
  if (ks) {
    try {
      if (typeof ks.getLevelProgress === 'function') {
        const lp = ks.getLevelProgress();
        learningState.level = lp.levelName || lp.level || 'unknown';
        learningState.xp = lp.xp || 0;
        const total = Math.max(lp.totalTopics || 0, 1);
        learningState.completionRate = Math.round(((lp.completedTopics || 0) / total) * 100);
      }
      if (typeof ks.getKnowledgeStats === 'function') {
        const stats = ks.getKnowledgeStats();
        learningState.builtinCount = stats.builtinCount || 0;
        learningState.learnedCount = stats.learnedCount || 0;
      }
    } catch { /* knowledge service not ready */ }
  }

  return { runtime, gateway: gatewayState, localLLM: llmState, tools: toolState, skills: skillState, commands: cmdState, apps: appsState, learning: learningState, install };
}

/**
 * Resolve khy's own install location by feeding the real dataHome resolvers into the
 * selfLocation leaf. selfSrcDir is derived from this module's own __dirname
 * (services/backend/src). Fail-soft: returns a best-effort object even if resolvers throw.
 */
function _resolveInstall() {
  const sl = getSelfLocation();
  // services/backend/src — this file lives at services/backend/src/services/selfProfile.js
  const selfSrcDir = path.resolve(__dirname, '..');
  let appRoot = '';
  let dataHome = '';
  let projectDataHome = '';
  let baseHome = '';
  const dh = getDataHome();
  if (dh) {
    try { if (typeof dh.getAppRoot === 'function') appRoot = dh.getAppRoot(); } catch { /* ignore */ }
    try {
      if (typeof dh.getStorageReport === 'function') {
        const sr = dh.getStorageReport();
        const homes = (sr && sr.homes) || {};
        dataHome = homes.dataHome || '';
        projectDataHome = homes.projectDataHome || '';
        baseHome = homes.baseHome || '';
      }
    } catch { /* ignore */ }
  }
  if (sl && typeof sl.resolveSelfLocation === 'function') {
    try {
      return sl.resolveSelfLocation({ appRoot, selfSrcDir, dataHome, projectDataHome, baseHome });
    } catch { /* fall through */ }
  }
  return { appRoot, selfSrcDir, dataHome, projectDataHome, baseHome, installKind: 'dev', enabled: true };
}

function _detectPython() {
  try {
    const { execFileSync } = require('child_process');
    const { isWin, searchExecutable } = require('../tools/platformUtils');
    const candidates = isWin ? ['python', 'python3'] : ['python3', 'python'];
    for (const cmd of candidates) {
      if (!searchExecutable(cmd)) continue;
      try {
        const ver = execFileSync(cmd, ['--version'], {
          encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        return ver.replace(/^Python\s*/i, '');
      } catch { /* try next */ }
    }
    return 'not found';
  } catch {
    return 'not found';
  }
}

// ─── Full profile (static + runtime merged) ──────────────────────────────────

function getFullProfile(opts = {}) {
  const staticProfile = buildStaticProfile();
  const runtimeCaps = detectRuntimeCapabilities(opts);
  return { ...staticProfile, runtime: runtimeCaps };
}

// ─── Output: System Prompt (token-efficient, 仅注入行为相关信息) ────────────────────

function formatForSystemPrompt(profile) {
  if (!profile) profile = getFullProfile();
  const rt = profile.runtime || {};
  const gw = rt.gateway || {};
  const llm = rt.localLLM || {};
  const id = profile.identity || {};

  // Minimal injection — only adapter/model info not already in getEnvironmentSection().
  // CC doesn't inject self-descriptions ("I am", "I cannot") — the model knows its
  // capabilities from tool definitions and system prompt sections.
  const lines = [
    `# Runtime (${id.name || 'khy OS'} v${id.version || '?'})`,
    `Adapter: ${gw.currentAdapter || 'auto'}, Model: ${gw.currentModel || 'auto'}`,
  ];

  // 模型身份不可伪装(A 层, goal 2026-07-04):在 Adapter/Model 行后注入反伪装指令,命令模型
  // 被问身份时如实报「真实供应渠道 + 真实模型」、绝不冒充其他 AI。真值取当前网关状态(装配时
  // 可能仍为 auto,指令仍成立——它命模型以运行时真实后端为准)。门控 KHY_MODEL_IDENTITY_TRUTH
  // 关 → formatIdentityDirective 返 '',不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const mit = require('./modelIdentityTruth');
    const directive = typeof mit.formatIdentityDirective === 'function'
      ? mit.formatIdentityDirective(
          { channel: gw.currentAdapter, model: gw.currentModel },
          { env: process.env },
        )
      : '';
    if (directive) { lines.push(''); lines.push(directive); }
  } catch { /* identity directive is best-effort; never break the system prompt */ }

  // 缓存命中率如实上报(A 层, goal 2026-07-04, 截图):模型常谎称「没有访问实时监控数据的工具」,
  // 但 khy 网关确有缓存遥测。注入指令告诉模型缓存命中率可观测、被问须据实答或指向缓存透明报告。
  // 门控 KHY_CACHE_METRICS_TRUTH 关 → formatMetricsDirective 返 '',不注入(字节回退)。fail-soft。
  try {
    const cmt = require('./cacheMetricsTruth');
    const mdir = typeof cmt.formatMetricsDirective === 'function'
      ? cmt.formatMetricsDirective({ env: process.env })
      : '';
    if (mdir) { lines.push(''); lines.push(mdir); }
  } catch { /* cache-metrics directive is best-effort; never break the system prompt */ }

  // 视觉能力路由透明(A 层, 自审 #6):主模型可能纯文本、视觉靠网关改选视觉模型或本地 OCR 兜底。
  // 注入指令告知模型「视觉是路由而非原生」、被问须据实答并回显实际模型。门控 KHY_VISION_ROUTING_TRUTH
  // 关 → formatVisionDirective 返 '',不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const vrt = require('./visionRoutingTruth');
    const vdir = typeof vrt.formatVisionDirective === 'function'
      ? vrt.formatVisionDirective({ env: process.env })
      : '';
    if (vdir) { lines.push(''); lines.push(vdir); }
  } catch { /* vision directive is best-effort; never break the system prompt */ }

  // 自我认知/自审知识(A 层, goal 2026-07-04「khy 对自己的情况做到自知」):把 khyos 自审报告
  // (#1..#7,此前只散落在代码注释里,模型读不到)变成机器可读 SSOT 并推入系统提示,让模型被问
  // 「khyos 最大的问题有哪些 / 你的局限」时据实快答、不凭空猜、不夸大。门控 KHY_SELF_AUDIT_AWARENESS
  // 关 → formatForSystemPrompt 返 '',不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const sar = require('./selfAuditRegistry');
    const adir = typeof sar.formatForSystemPrompt === 'function'
      ? sar.formatForSystemPrompt({ env: process.env })
      : '';
    if (adir) { lines.push(''); lines.push(adir); }
  } catch { /* self-audit awareness is best-effort; never break the system prompt */ }

  // 20 倍模式(twentyXMode, goal 2026-07-04「cc 有 20 倍模式,khy 没有需要补充」):开启时在系统
  // 提示注入当前满负荷状态,让模型被问「是否在 20x 模式」时如实回答。opt-in 默认关 → describe
  // 返 enabled:false,不注入(字节回退)。fail-soft:绝不因此打断系统提示。
  try {
    const { describeTwentyXState } = require('./twentyXMode');
    const tx = describeTwentyXState(process.env);
    if (tx && tx.enabled) {
      lines.push('');
      lines.push(`## 20 倍模式（当前：开）`);
      lines.push(`当前运行在满负荷档：effort=${tx.effort}（含扩展思考）· 工具循环迭代上限 ${tx.maxIterations} · 并行子代理扇出 ${tx.maxChildren}/${tx.maxTotalAgents}。被问到「是否开启 20x / 满负荷模式」时如实确认已开启；用 \`/20x off\` 可关闭回到常规档。`);
    }
  } catch { /* 20x directive is best-effort; never break the system prompt */ }

  // Capability boundaries — single source of truth (profile.boundaries). Injected
  // so the agent has REAL self-knowledge of its limits and does not overclaim.
  // Token-efficient: one line per boundary, short label + detail.
  const boundaries = Array.isArray(profile.boundaries) ? profile.boundaries : [];
  if (boundaries.length > 0) {
    lines.push('');
    lines.push('## Capability boundaries (know these about yourself)');
    for (const b of boundaries) {
      if (!b || !b.short) continue;
      lines.push(`- ${b.short}${b.detail ? ` — ${b.detail}` : ''}`);
    }
    // Runtime honesty signals: surface CURRENT availability so the agent does not
    // claim it can do something the environment cannot do right now.
    const signals = [];
    if (llm.status === 'unavailable' || llm.status === 'degraded') {
      signals.push(`本地推理当前不可用（${llm.status}），无法保证离线模型可用`);
    }
    if (!gw.currentModel || gw.currentModel === 'auto') {
      signals.push('当前模型/通道为自动解析，具体后端以实际网关状态为准');
    }
    if (signals.length > 0) {
      lines.push(`- 实时可用性：${signals.join('；')}`);
    }
  }

  // Self-location + own-command overview — so the agent KNOWS where its own source
  // lives (can Grep/Read it by absolute path) and WHAT commands it can invoke (no
  // guessing). Gated by KHY_SELF_LOCATION (default on); off → both blocks empty
  // (byte-identical fallback to prior behavior). Fail-soft: never throws.
  try {
    const sl = getSelfLocation();
    if (sl) {
      const locBlock = typeof sl.formatLocationForSystemPrompt === 'function'
        ? sl.formatLocationForSystemPrompt((profile.runtime || {}).install)
        : '';
      if (locBlock) { lines.push(''); lines.push(locBlock); }

      const cc = getCommandCatalog();
      if (cc && typeof cc.buildCommandCatalog === 'function' && typeof sl.formatCommandOverviewForSystemPrompt === 'function') {
        let catalog = null;
        try { catalog = cc.buildCommandCatalog(); } catch { catalog = null; }
        const cmdBlock = catalog ? sl.formatCommandOverviewForSystemPrompt(catalog) : '';
        if (cmdBlock) { lines.push(''); lines.push(cmdBlock); }
      }
    }
  } catch { /* self-location is best-effort; never break the system prompt */ }

  // Skill protocol self-knowledge (goal 2026-07-11「工具使用和 skill 格式对 khy
  // 自身还需现场调查是不对的…自己的协议格式都是清楚的，直接使用」). khy's OWN
  // skill format is fixed and authoritative — the agent must USE it directly, not
  // field-investigate (现场调查) it at runtime. Without this the agent guessed
  // non-existent shapes (`*.skill.json`), got 0 hits, and fell back to text
  // parsing. Authoritative format single-sourced from skills/skillLoader.js (the
  // sole loader). Gated by KHY_SKILL_FORMAT_AWARENESS (default on); off → block
  // omitted (byte-identical fallback). Token-cheap: three short lines.
  const _skillAwareRaw = String(process.env.KHY_SKILL_FORMAT_AWARENESS || 'true').trim().toLowerCase();
  if (!['0', 'false', 'off', 'no'].includes(_skillAwareRaw)) {
    lines.push('');
    lines.push('## Skill format (khy-native — use directly, do not field-investigate)');
    lines.push('A khy skill is a directory containing `SKILL.md` (fixed filename) with YAML frontmatter (`name`/`version`/`description`/`layer`/`lifecycle`/`tags`/`platforms`/`dependencies`) followed by a Markdown body (instructions for the AI). There is NO `*.skill.json` / `manifest.json` shape — to author a skill, write `SKILL.md` directly; do not search for or reverse-engineer the format.');
    lines.push('Discovery (nearest wins): project `./.khy/skills/` → user `~/.khy/skills/` → built-in `backend/src/skills/`. Placing `<name>/SKILL.md` under `~/.khy/skills/` loads it natively. Manage: `khy skill list`.');
  }

  return lines.join('\n');
}

// ─── Output: Human-readable (khy self, 中文 Markdown) ────────────────────────

function formatForHuman(profile) {
  if (!profile) profile = getFullProfile();
  const rt = profile.runtime || {};
  const gw = rt.gateway || {};
  const llm = rt.localLLM || {};
  const tools = rt.tools || {};
  const skills = rt.skills || {};
  const cmds = rt.commands || {};
  const apps = rt.apps || {};
  const env = rt.runtime || {};
  const id = profile.identity || {};
  const domains = profile.capabilityDomains || {};

  const statusIcon = (status) => {
    if (status === 'loaded' || status === 'available') return '\u2713';
    if (status === 'degraded') return '~';
    return '\u2717';
  };

  const sections = [];

  // Header
  sections.push(`# ${id.name} 自我画像 (v${id.version})`);
  sections.push('');
  sections.push(`我是 ${id.name}，${id.positioning}。`);
  sections.push(`上层应用 (如 khyquant) 运行在此平台之上 — 我是操作系统，不是应用。`);
  sections.push(`性格: ${id.personality}`);
  sections.push('');

  // Capabilities
  sections.push('## 我能做什么');
  sections.push('');

  sections.push(`### AI 网关`);
  sections.push(`${domains.ai_gateway?.description || ''}`);
  if (gw.currentAdapter) {
    sections.push(`当前通道: ${gw.currentAdapter} / ${gw.currentModel || 'auto'}`);
  }
  if (gw.adapters && gw.adapters.length > 0) {
    sections.push(`可用适配器: ${gw.adapters.join(', ')}`);
  }
  sections.push(`切换: \`khy gateway config\``);
  sections.push('');

  sections.push(`### 本地推理`);
  sections.push(`${statusIcon(llm.status)} 状态: ${llm.status}${llm.backend ? ` (${llm.backend})` : ''}`);
  sections.push(`${domains.local_inference?.description || ''}`);
  sections.push(`安装 Ollama: https://ollama.com/download`);
  sections.push('');

  sections.push(`### 工具 (${tools.enabled} 已启用)`);
  const cats = domains.tools?.categories || {};
  for (const [key, desc] of Object.entries(cats)) {
    sections.push(`- ${key}: ${desc}`);
  }
  sections.push('');

  sections.push(`### 技能 (${skills.count} 已加载)`);
  sections.push(`${domains.skills?.description || ''}`);
  if (skills.loaded && skills.loaded.length > 0) {
    sections.push(`已加载: ${skills.loaded.join(', ')}`);
  }
  sections.push(`管理: \`khy skill list\``);
  sections.push('');

  sections.push(`### 命令 (${cmds.routerCount} CLI + ${cmds.slashCount} 斜杠)`);
  sections.push(`查看: \`khy --help\` 或 \`/help\``);
  sections.push('');

  sections.push(`### 多智能体协作`);
  sections.push(`${domains.multi_agent?.description || ''}`);
  sections.push('');

  sections.push(`### WASM 应用沙箱`);
  sections.push(`${domains.wasm_runtime?.description || ''}`);
  sections.push(`ABI: ${(domains.wasm_runtime?.abis || []).join(', ')}`);
  sections.push('');

  sections.push(`### 系统操作`);
  sections.push(`${domains.os_operations?.description || ''}`);
  sections.push('');

  sections.push(`### 应用运行时`);
  sections.push(`${domains.app_runtime?.description || ''}`);
  sections.push(`功能: ${(domains.app_runtime?.features || []).join(', ')}`);
  sections.push(`查看已安装应用: \`khy app list\``);
  sections.push('');

  sections.push(`### 学习引导系统`);
  sections.push(`${domains.learning?.description || ''}`);
  const learning = rt.learning || {};
  sections.push(`知识库: ${learning.builtinCount} 内置 + ${learning.learnedCount} 学习`);
  sections.push(`等级: ${learning.level} (${learning.xp} XP, 完成率 ${learning.completionRate}%)`);
  sections.push(`进入学习模式: \`khy ai --study\``);
  sections.push('');

  sections.push(`### 安全体系`);
  sections.push(`${domains.security?.description || ''}`);
  sections.push('');

  // Boundaries
  sections.push('## 我的局限');
  sections.push('');
  (profile.boundaries || []).forEach((b, i) => {
    sections.push(`${i + 1}. **${b.short}** — ${b.detail}`);
  });
  sections.push('');

  // Runtime
  sections.push('## 当前状态');
  sections.push('');
  sections.push(`- 平台: ${env.platform}`);
  sections.push(`- Node: ${env.nodeVersion}`);
  sections.push(`- Python: ${env.pythonVersion}`);
  sections.push(`- 工作目录: ${env.cwd}`);
  sections.push(`- 权限模式: ${env.permissionMode}`);
  // 20 倍模式(twentyXMode):开启时如实告知模型当前处于满负荷档,让它据实回答「是否 20x」。
  // 关 → 不追加本行(系统提示逐字节回退)。绝不抛。
  try {
    const { describeTwentyXState } = require('./twentyXMode');
    const tx = describeTwentyXState(process.env);
    if (tx && tx.enabled) {
      sections.push(`- 20 倍模式: 开（满负荷）— effort=${tx.effort} · 工具迭代上限 ${tx.maxIterations} · 并行子代理 ${tx.maxChildren}/${tx.maxTotalAgents}；被问到时如实说明已开启`);
    }
  } catch { /* twentyXMode 不可用 → 不追加 */ }
  const inst = rt.install || {};
  if (inst.selfSrcDir || inst.appRoot) {
    sections.push(`- 自身源码: ${inst.selfSrcDir || '?'}（可用 Grep/Read 直接搜索此绝对路径）`);
    sections.push(`- 安装根: ${inst.appRoot || '?'}${inst.installKind ? ` (${inst.installKind})` : ''}`);
    if (inst.dataHome) sections.push(`- 数据主目录: ${inst.dataHome}`);
  }
  sections.push(`- 已安装应用: ${(apps.installed || []).join(', ') || '无'}`);

  return sections.join('\n');
}

// ─── Output: API JSON ────────────────────────────────────────────────────────

function formatForAPI(profile) {
  if (!profile) profile = getFullProfile();
  return JSON.parse(JSON.stringify(profile));
}

// ─── Brief one-liner ─────────────────────────────────────────────────────────

function formatBrief(profile) {
  if (!profile) profile = getFullProfile();
  const id = profile.identity || {};
  const rt = profile.runtime || {};
  const gw = rt.gateway || {};
  const tools = rt.tools || {};
  const skills = rt.skills || {};
  const llm = rt.localLLM || {};
  const apps = rt.apps || {};

  return `${id.name} v${id.version} | ` +
    `Gateway: ${gw.currentAdapter || 'auto'}/${gw.currentModel || 'auto'} | ` +
    `Tools: ${tools.enabled} | Skills: ${skills.count} | ` +
    `LLM: ${llm.status} | Apps: ${(apps.installed || []).join(', ') || 'none'}`;
}

// ─── Cache invalidation ──────────────────────────────────────────────────────

function invalidateStaticCache() {
  _staticCache = null;
}

/**
 * Lightweight install-location accessor: resolves ONLY khy's own paths (install
 * root / self source dir / data homes / installKind) WITHOUT the expensive runtime
 * detection (no python probe, no gateway/LLM status). Safe to call from a tool on
 * every invocation. Returns the same shape as runtime.install.
 */
function getInstallLocation() {
  return _resolveInstall();
}

module.exports = {
  getFullProfile,
  getInstallLocation,
  formatForSystemPrompt,
  formatForHuman,
  formatForAPI,
  formatBrief,
  invalidateStaticCache,
};
