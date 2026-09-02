/**
 * Tool Display Policy Registry — data-driven display rules per tool type.
 * Replaces if/else chains in printToolCallStart/printToolCallResult.
 *
 * 这是**显示矩阵单一真源**（[DESIGN-ARCH-073] §2.3）：家族 × tier × 渲染样式 ×
 * 说明文案（intentLabel）同表登记；分级依据 = 工具名（经 ALIASES 归一），不看参数。
 * 四条渲染路径（经典 REPL step 行 / 管道工具头行 / Ink TUI 叙述行 / headless stderr 行）
 * 消费同一份矩阵 —— 判定在叶子（本文件），着色/布局在接线处。
 *
 * Each policy controls how a tool call is rendered in the CLI:
 *   tier        — 显示分级：'core'（常驻 + ▌ 焦点锚点）| 'minor'（显示后折叠成摘要行）。
 *                 未注册工具默认 core —— 宁可见到，不可漏掉。
 *   intentLabel — 参数感知前的通用说明文案（如「提交变更」）；调用方可再拼目标链。
 *   showIntent  — show the conversational intent line (e.g. "Reading file...")
 *   boxPreview  — render a bordered box preview of the command/content
 *   resultStyle — how to render the result output:
 *     'tree'      — standard ⎿-prefixed lines (bash, grep, glob)
 *     'collapsed' — minimal output, fold aggressively (read, websearch)
 *     'diff'      — inline diff rendering (write, edit)
 *     'delegate'  — result handled by a sub-tracker (agent)
 *     'inline'    — compact single-section output (todowrite)
 *   maxLines   — max output lines before folding kicks in
 *   foldHead   — lines to keep at the top when folded
 *   foldTail   — lines to keep at the bottom when folded
 *
 * 完整性由 src/cli/toolDisplayMatrix.test.js 强制：注册表每个工具都必须命中显式
 * 家族（不得落 DEFAULT_POLICY），每条家族必须有合法 tier + 非空 intentLabel。
 * 新增工具 → 本测试红 → 在 ALIASES/POLICIES 给它一个明确显示位。
 */

'use strict';

// ── Policy Registry ─────────────────────────────────────────────────
// ★ = core（状态变更/委派/重操作：常驻显示 + ▌ 焦点锚点）
// ○ = minor（只读/信息类：显示后折叠成摘要行）

const POLICIES = {
  // ── ★ 执行类 ──
  bash: {
    tier: 'core',
    intentLabel: '执行命令',
    showIntent: true,
    boxPreview: true,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  codeexec: {
    tier: 'core',
    intentLabel: '执行代码',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  testrun: {
    tier: 'core',
    intentLabel: '运行测试',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  build: {
    tier: 'core',
    intentLabel: '构建编译',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  deps: {
    tier: 'core',
    intentLabel: '管理依赖',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },

  // ── ★ 写入类 ──
  write: {
    tier: 'core',
    intentLabel: '写入文件',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'diff',
    maxLines: 10,
    foldHead: 5,
    foldTail: 5,
  },
  edit: {
    tier: 'core',
    intentLabel: '编辑文件',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'diff',
    maxLines: 10,
    foldHead: 5,
    foldTail: 5,
  },

  // ── ★ 应用 / 桌面 / 浏览器 ──
  openapp: {
    tier: 'core',
    intentLabel: '打开应用',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  desktop: {
    tier: 'core',
    intentLabel: '桌面控制',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  browser: {
    tier: 'core',
    intentLabel: '操作浏览器',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },

  // ── ★ 委派 ──
  agent: {
    tier: 'core',
    intentLabel: '委派子代理',
    showIntent: false,
    boxPreview: false,
    resultStyle: 'delegate',
    maxLines: 0,
    foldHead: 0,
    foldTail: 0,
  },

  // ── ★ git 写操作 ──
  gitcommit: {
    tier: 'core',
    intentLabel: '提交变更',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  gitpush: {
    tier: 'core',
    intentLabel: '推送远端',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  gitclone: {
    tier: 'core',
    intentLabel: '克隆仓库',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  taskstop: {
    tier: 'core',
    intentLabel: '终止任务',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },

  // ── ★ 文档 / 脚手架 / 媒体 ──
  docwrite: {
    tier: 'core',
    intentLabel: '生成文档',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  convert: {
    tier: 'core',
    intentLabel: '转换/发布文件',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  scaffold: {
    tier: 'core',
    intentLabel: '创建文件结构',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  mediagen: {
    tier: 'core',
    intentLabel: '生成图片/视频',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  mediaedit: {
    tier: 'core',
    intentLabel: '编辑图片/视频',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },

  // ── ★ 配置 / 计划 / 系统 ──
  configwrite: {
    tier: 'core',
    intentLabel: '修改配置',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  importfam: {
    tier: 'core',
    intentLabel: '导入模型配置',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  cron: {
    tier: 'core',
    intentLabel: '管理计划任务',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  trigger: {
    tier: 'core',
    intentLabel: '远程触发',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  deploy: {
    tier: 'core',
    intentLabel: '部署',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  shutdown: {
    tier: 'core',
    intentLabel: '关闭系统',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  khyupdate: {
    tier: 'core',
    intentLabel: '更新 khyOS',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  diskcleanup: {
    tier: 'core',
    intentLabel: '清理磁盘',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  worktree: {
    tier: 'core',
    intentLabel: '切换工作树',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  planmode: {
    tier: 'core',
    intentLabel: '切换规划模式',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  mcp: {
    tier: 'core',
    intentLabel: 'MCP 操作',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  skillload: {
    tier: 'core',
    intentLabel: '加载技能',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  askuser: {
    tier: 'core',
    intentLabel: '向你提问',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  backtest: {
    tier: 'core',
    intentLabel: '运行回测',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },

  // ── ○ 只读 / 信息类（显示后折叠） ──
  read: {
    tier: 'minor',
    intentLabel: '读取文件',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 3,
    foldHead: 2,
    foldTail: 1,
  },
  grep: {
    tier: 'minor',
    intentLabel: '搜索内容',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  glob: {
    tier: 'minor',
    intentLabel: '查找文件',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  websearch: {
    tier: 'minor',
    intentLabel: '搜索网页',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  webfetch: {
    tier: 'minor',
    intentLabel: '抓取网页',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  todowrite: {
    tier: 'minor',
    intentLabel: '更新任务清单',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'inline',
    maxLines: 3,
    foldHead: 2,
    foldTail: 1,
  },
  taskmgmt: {
    tier: 'minor',
    intentLabel: '更新任务清单',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'inline',
    maxLines: 3,
    foldHead: 2,
    foldTail: 1,
  },
  gitread: {
    tier: 'minor',
    intentLabel: '查看 Git 仓库',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 8,
    foldHead: 4,
    foldTail: 4,
  },
  docread: {
    tier: 'minor',
    intentLabel: '查看文档',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  mediaread: {
    tier: 'minor',
    intentLabel: '分析图片/视频',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  cronread: {
    tier: 'minor',
    intentLabel: '查看计划任务',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  mcpread: {
    tier: 'minor',
    intentLabel: '查看 MCP 资源',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  dataread: {
    tier: 'minor',
    intentLabel: '拉取数据',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  dataquery: {
    tier: 'minor',
    intentLabel: '查询数据库',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  quote: {
    tier: 'minor',
    intentLabel: '查询行情',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  memory: {
    tier: 'minor',
    intentLabel: '记忆读写',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  verify: {
    tier: 'minor',
    intentLabel: '验证/检查',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  appquery: {
    tier: 'minor',
    intentLabel: '查询应用/位置',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  notify: {
    tier: 'minor',
    intentLabel: '发送消息/通知',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  screencap: {
    tier: 'minor',
    intentLabel: '截取屏幕',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  lsp: {
    tier: 'minor',
    intentLabel: 'LSP 查询',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 6,
    foldHead: 3,
    foldTail: 3,
  },
  registryread: {
    tier: 'minor',
    intentLabel: '检索注册表',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  toolssearch: {
    tier: 'minor',
    intentLabel: '搜索可用工具',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'collapsed',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
  aux: {
    tier: 'minor',
    intentLabel: '辅助操作',
    showIntent: true,
    boxPreview: false,
    resultStyle: 'tree',
    maxLines: 4,
    foldHead: 2,
    foldTail: 2,
  },
};

// Aliases — multiple raw tool names map to the same canonical policy key.
// 键与值都按「小写、去 [\s_-]」归一后比对（与 getToolPolicy 同一规则）。
// 分组按目标家族排列，注册表（services/tools）新增工具时在此登记。
const ALIASES = {
  // → bash
  shell: 'bash',
  shellcommand: 'bash',
  command: 'bash',
  powershell: 'bash',
  // → codeexec / testrun / build / deps
  executecode: 'codeexec',
  repl: 'codeexec',
  runtests: 'testrun',
  buildproject: 'build',
  compilefile: 'build',
  managedeps: 'deps',
  // → read / write / edit
  readfile: 'read',
  notebookread: 'read',
  writefile: 'write',
  createfile: 'write',
  editfile: 'edit',
  multiedit: 'edit',
  notebookedit: 'edit',
  applypatch: 'edit',
  replaceatlocation: 'edit',
  // → grep / glob
  search: 'grep',
  searchcontent: 'grep',
  find: 'glob',
  findfiles: 'glob',
  ls: 'glob',
  listdir: 'glob',
  // → agent（委派/团队/探索）
  task: 'agent',
  spawnworker: 'agent',
  subagent: 'agent',
  workflow: 'agent',
  adoptrole: 'agent',
  explore: 'agent',
  teamcreate: 'agent',
  teamdelete: 'agent',
  // → openapp / desktop / browser
  khyos: 'openapp',
  computeruse: 'desktop',
  rpa: 'desktop',
  desktopcontrol: 'desktop',
  webbrowser: 'browser',
  // → git 写 / git 读
  forgecommits: 'gitcommit',
  gitblame: 'gitread',
  gitdiff: 'gitread',
  gitlog: 'gitread',
  gitstatus: 'gitread',
  // → taskstop / taskmgmt
  killshell: 'taskstop',
  taskcreate: 'taskmgmt',
  taskget: 'taskmgmt',
  tasklist: 'taskmgmt',
  taskoutput: 'taskmgmt',
  taskupdate: 'taskmgmt',
  goaltool: 'taskmgmt',
  brief: 'taskmgmt',
  recordprogress: 'taskmgmt',
  // → worktree / planmode
  enterworktree: 'worktree',
  exitworktree: 'worktree',
  enterplanmode: 'planmode',
  exitplanmode: 'planmode',
  // → docwrite / docread
  createdocument: 'docwrite',
  renderdocument: 'docwrite',
  projectblueprint: 'docwrite',
  weipurewrite: 'docwrite',
  artifact: 'docread',
  reviewartifact: 'docread',
  inspectdocument: 'docread',
  // → convert / scaffold
  convertfile: 'convert',
  pdftoword: 'convert',
  image2web: 'convert',
  scaffoldfiles: 'scaffold',
  createtool: 'scaffold',
  projecttemplate: 'scaffold',
  // → 媒体生成 / 编辑 / 读取
  imagegenerate: 'mediagen',
  videogenerate: 'mediagen',
  imageedit: 'mediaedit',
  imageocr: 'mediaread',
  recognizeimage: 'mediaread',
  imagedetect: 'mediaread',
  videoanalyze: 'mediaread',
  // → 配置写 / 导入
  config: 'configwrite',
  configure: 'configwrite',
  configureexternalapp: 'configwrite',
  configuremodelprovider: 'configwrite',
  optimizeconfig: 'configwrite',
  importexternalappmodels: 'importfam',
  // → 计划任务 / 触发
  crondelete: 'cron',
  schedulecron: 'cron',
  cronlist: 'cronread',
  remotetrigger: 'trigger',
  // → mcp / mcpread
  mcptool: 'mcp',
  mcpauth: 'mcp',
  listmcpresources: 'mcpread',
  readmcpresource: 'mcpread',
  // → skillload / askuser
  skill: 'skillload',
  askuserquestion: 'askuser',
  // → websearch / webfetch
  news: 'websearch',
  forgesearch: 'websearch',
  forgecodesearch: 'websearch',
  forgerecon: 'websearch',
  vaulthttpfetch: 'webfetch',
  httprequest: 'webfetch',
  // → dataread / dataquery
  datafetch: 'dataread',
  sessioninsights: 'dataread',
  strategylist: 'dataread',
  databasequery: 'dataquery',
  // → memory
  savememory: 'memory',
  saveinstruction: 'memory',
  localmemoryrecall: 'memory',
  // → verify
  lintcode: 'verify',
  securityscan: 'verify',
  repoaudit: 'verify',
  coveragereport: 'verify',
  verifyplanexecution: 'verify',
  verifyartifact: 'verify',
  // → appquery / notify / screencap
  deviceapps: 'appquery',
  getlocation: 'appquery',
  sendmessage: 'notify',
  pushnotify: 'notify',
  senduserfile: 'notify',
  meshpeer: 'notify',
  snip: 'screencap',
  terminalcapture: 'screencap',
  // → registryread / toolssearch
  registrysearch: 'registryread',
  toolsearch: 'toolssearch',
  discoverskills: 'toolssearch',
  // → aux（低频辅助 / 内部运维）
  sleep: 'aux',
  unpack: 'aux',
  monitor: 'aux',
  bashoutput: 'aux',
  ctxinspect: 'aux',
  commentguidance: 'aux',
  diskanalyze: 'aux',
  khyself: 'aux',
  rtkgain: 'aux',
  structuredoutput: 'aux',
  syntheticoutput: 'aux',
  upstreamstudy: 'aux',
  weakmodelguidance: 'aux',
  agentassets: 'aux',
  analyzebinary: 'aux',
  reverseengineer: 'aux',
  doctitlestyle: 'aux',
};

// 未注册工具的兜底：tier 恒为 core（宁可见到，不可漏掉），样式按普通 tree 折叠。
// 刻意**不带** intentLabel —— 带了会被 toolDisplayMatrix.test 判成「显式家族」。
const DEFAULT_POLICY = {
  tier: 'core',
  showIntent: true,
  boxPreview: false,
  resultStyle: 'tree',
  maxLines: 6,
  foldHead: 3,
  foldTail: 3,
};

// ── Public API ──────────────────────────────────────────────────────

/**
 * Normalize a raw tool name the same way every consumer does:
 * lowercase + strip whitespace/underscore/hyphen.
 *
 * @param {string} toolName
 * @returns {string} normalized key ('' for falsy input)
 */
function _normalizeKey(toolName) {
  return String(toolName || '')
    .toLowerCase()
    .replace(/[\s_-]/g, '');
}

/**
 * Resolve a raw tool name to its canonical family key (never DEFAULT).
 *
 * @param {string} toolName
 * @returns {string} canonical POLICIES key, or '' when unregistered
 */
function _resolveFamilyKey(toolName) {
  const key = _normalizeKey(toolName);
  return ALIASES[key] || key;
}

/**
 * Normalize a raw tool name and return the matching display policy.
 * Falls back to DEFAULT_POLICY for unknown tools.
 *
 * @param {string} toolName — raw tool name from the model
 * @returns {{ tier: string, intentLabel?: string, showIntent: boolean, boxPreview: boolean, resultStyle: string, maxLines: number, foldHead: number, foldTail: number }}
 */
function getToolPolicy(toolName) {
  const canonical = _resolveFamilyKey(toolName);
  return POLICIES[canonical] || DEFAULT_POLICY;
}

/**
 * 显示分级（单一真源）:'core'（常驻 + ▌ 焦点锚点）| 'minor'（显示后折叠）。
 * 未注册 / 空 / null 一律 'core' —— 宁可见到，不可漏掉。
 *
 * @param {string} toolName — raw tool name from the model
 * @returns {'core'|'minor'}
 */
function getToolTier(toolName) {
  const canonical = _resolveFamilyKey(toolName);
  const p = POLICIES[canonical];
  return (p && p.tier) || DEFAULT_POLICY.tier;
}

/**
 * 是否按核心工具显示（▌ 焦点锚点 + 常驻不折叠）。
 *
 * @param {string} toolName
 * @returns {boolean}
 */
function isCoreToolDisplay(toolName) {
  return getToolTier(toolName) === 'core';
}

/**
 * core 工具的焦点说明行:`▌ {说明}：{目标}`。判定在叶子、拼接在此，
 * 四条渲染路径共用，保证同一工具在任何路径下锚点与措辞一致。
 *
 * @param {string} label — 说明文案（通常是矩阵 intentLabel 或调用方拼好的参数感知文案）
 * @param {string} target — 目标链（路径/命令/查询…），可空
 * @returns {string}
 */
function buildCoreFocusLine(label, target) {
  const head = typeof label === 'string' && label.trim() ? label.trim() : '核心操作';
  const t = typeof target === 'string' ? target.trim() : '';
  return t ? `▌ ${head}：${t}` : `▌ ${head}`;
}

/**
 * Collapse RUNS of consecutive identical lines into the first occurrence + a
 * dim "+N 行相同" marker. A command like `dir /s` (or anything piped through
 * `findstr`) can emit the same line hundreds of times — "0 File(s) 0 bytes"
 * over and over — which floods the preview and buries the one line that differs.
 * Showing the first occurrence once, with a count for the rest, keeps the
 * signal visible; the FULL, un-collapsed output stays reachable via Ctrl+O
 * (callers feed the raw lines to the expansion path, the collapsed lines only
 * to the inline preview).
 *
 * Pure & UI-agnostic — the single source shared by the ink TUI (ToolLines) and
 * the classic REPL (toolDisplay) so both collapse identically. Only runs of
 * `minRun` or longer collapse; a stray pair stays verbatim (a marker would save
 * nothing). Order and structure are preserved — this is `uniq`-like, never a
 * global de-dup, so non-adjacent repeats are left untouched.
 *
 * @param {string[]} lines
 * @param {{ minRun?: number, marker?: (repeats:number, sample:string)=>string }} [opts]
 * @returns {{ lines: string[], collapsed: boolean, hiddenCount: number }}
 */
function collapseConsecutiveDuplicates(lines, opts = {}) {
  if (!Array.isArray(lines) || lines.length === 0) {
    return { lines: lines || [], collapsed: false, hiddenCount: 0 };
  }
  // A run must reach this length before it collapses: at 2 the marker would
  // replace a single duplicate (2 lines → 2 lines, no gain), so start at 3.
  const minRun = Math.max(3, Number(opts.minRun) || 3);
  const marker =
    typeof opts.marker === 'function'
      ? opts.marker
      : (repeats) => `… +${repeats} 行相同（ctrl+o 展开）`;

  const out = [];
  let hiddenCount = 0;
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    let end = i + 1;
    while (end < lines.length && lines[end] === cur) {
      end++;
    }
    const runLen = end - i;
    out.push(cur);
    if (runLen >= minRun) {
      const repeats = runLen - 1; // lines hidden behind the first occurrence
      out.push(marker(repeats, cur));
      hiddenCount += repeats;
    } else {
      // Short run — keep the remaining duplicate(s) verbatim; not worth a marker.
      for (let k = i + 1; k < end; k++) {
        out.push(lines[k]);
      }
    }
    i = end;
  }
  return { lines: out, collapsed: hiddenCount > 0, hiddenCount };
}

/**
 * Fold an array of output lines according to a policy.
 * If lines.length <= policy.maxLines, returns the array unchanged.
 * Otherwise returns head + fold-indicator + tail.
 *
 * @param {string[]} lines   — full output lines
 * @param {{ maxLines: number, foldHead: number, foldTail: number }} policy
 * @returns {{ lines: string[], folded: boolean, hiddenCount: number }}
 */
function foldOutput(lines, policy) {
  if (!Array.isArray(lines) || !policy) {
    return { lines: lines || [], folded: false, hiddenCount: 0 };
  }
  const max = Number(policy.maxLines) || 0;
  if (max <= 0 || lines.length <= max) {
    return { lines, folded: false, hiddenCount: 0 };
  }

  const head = Math.max(0, Number(policy.foldHead) || 0);
  const tail = Math.max(0, Number(policy.foldTail) || 0);

  // Guard: if head+tail >= lines.length, no folding needed
  if (head + tail >= lines.length) {
    return { lines, folded: false, hiddenCount: 0 };
  }

  const headLines = lines.slice(0, head);
  const tailLines = tail > 0 ? lines.slice(-tail) : [];
  const hiddenCount = lines.length - head - tail;

  return {
    lines: [
      ...headLines,
      // Claude Code-style fold marker: single "…" ellipsis + "+N" + "(ctrl+o 展开)".
      `… +${hiddenCount} 行 (ctrl+o 展开)`,
      ...tailLines,
    ],
    folded: true,
    hiddenCount,
  };
}

module.exports = {
  POLICIES,
  ALIASES,
  DEFAULT_POLICY,
  getToolPolicy,
  getToolTier,
  isCoreToolDisplay,
  buildCoreFocusLine,
  foldOutput,
  collapseConsecutiveDuplicates,
};
