'use strict';

/**
 * Command Schema — single source of truth for command metadata.
 *
 * This module centralizes:
 * - Canonical router commands
 * - Sub-command map
 * - Built-in slash command definitions
 *
 * Other modules (router, commandRegistry, tests) should derive from here
 * instead of maintaining parallel static lists.
 */

const ROUTER_COMMANDS = [
  'quote', 'data', 'cache', 'backtest', 'strategy',
  'server', 'db', 'ai', 'gateway', 'menu', 'help', 'clear', 'exit', 'quit', 'version',
  'account', 'position', 'order', 'search', 'watch', 'rank',
  'analyze', 'plugin', 'init', 'doctor', 'docs', 'profile', 'cloud',
  'kiro', 'cursor', 'claude', 'codex', 'trae', 'opencode', 'warp', 'vscode', 'windsurf', 'pool', 'proxy', 'skill', 'persona', 'log',
  'cost', 'usage', 'history', 'train', 'compute', 'update',
  'growth', 'agent', 'admin', 'prompt', 'voice', 'habit', 'knowledge', 'security', 'monitor', 'services',
  'login', 'register', 'logout', 'whoami', 'passwd', 'forgot',
  'self', 'cleanup', 'memory', 'resume', 'web_search', 'subscribe', 'sub',
  'image2web',
  'app', 'model', 'models', 'khymodel', 'linux', 'shell', 'verify', 'workspace', 'runtime',
  'device',
  'channels',
  'trace',
  'replay',
  'guide',
  'receipts',
  'rewind', 'undo',
  'publish', 'mobile', 'restore', 'companion', 'repo', 'deploy', 'storage',
  'uninstall',
  'features',
  'toollist',
  'toolcheck',
  'heal',
  'job',
  'metadata', 'meta', 'maintain', 'health',
  'extension', 'ext',
  'capability', 'doc', 'convert', 'role',
  'rtk',
  '20x',
  'lazy',
  'goal',
  'insights',
  'vault',
  'mesh',
  'notify',
  'msg',
  'buddy', 'coordinator', 'orchestrate', 'orch', 'assistant', 'brief', 'ultraplan', 'ulw-loop', 'bridge', 'daemon',
  'cron', 'skin', 'remote', 'remotedev', 'rdev', 'arena', 'moa', 'learn', 'manage',
  'pr', 'mr', 'ci',
  'forge',
  'evolve', 'evolution',
  'deps', 'dep', 'dependency',
  'workflow', 'wf',
  // Claude Code aligned commands
  'compact', 'snip', 'config', 'context', 'diff', 'effort', 'env', 'export', 'fast',
  'files', 'hooks', 'mcp', 'session', 'share', 'stats', 'status', 'statusline', 'summary',
  'tasks', 'theme', 'upgrade', 'branch', 'debug', 'stickers', 'remember', 'instructions', 'gitignore', 'add-dir', 'adddir', 'agents',
  'output-style', 'outputstyle',
  'lang',
  'release-notes', 'releasenotes',
  'terminal-setup', 'terminalsetup',
  'keybindings', 'keys', 'shortcuts',
  'perf-issue', 'perfissue',
  'issue',
  'feedback', 'bug',
  'sandbox-toggle', 'sandboxtoggle',
  'init-verifiers', 'initverifiers',
  'fork',
  'topology', 'forest',
  'btw',
  'autonomy',
  'proactive',
  'onboarding',
  'debug-tool-call', 'debugtoolcall',
  'recap',
  'thinkback',
  'copy',
  'rename',
  'tag',
  'heapdump',
  'break-cache',
  'color',
  'advisor',
  'autofix-pr',
  'claim-main',
  'ide',
  'subscribe-pr',
  'pr-comments', 'prcomments',
  'web-tools', 'webtools',
  'permissions',
  'md',
  'tools',
];

const ROUTER_SUB_COMMANDS = {
  data: ['fetch', 'list'],
  cache: ['clear'],
  md: ['open', 'register', 'unregister'],
  tools: ['list', 'ls', 'status', 'install', 'add', 'update', 'upgrade', 'path', 'where', 'help'],
  backtest: ['list'],
  strategy: ['list'],
  server: ['start', 'status'],
  db: ['init', 'seed', 'status'],
  ai: ['status', 'config', 'on', 'off', 'tools', 'dangerous', 'tech', 'owner', 'unrestricted'],
  gateway: ['status', 'trace', 'sample', 'debug-prompt', 'config', 'guide', 'help', 'relay', 'detect', 'model', 'models', 'prefer-remote', 'test', 'probe-tools', 'server', 'manage', 'protocols', 'oauth', 'discover-models', 'tune-local', 'key', 'add', 'pool', 'vertex'],
  plugin: ['list', 'reload', 'gateway', 'init', 'dev', 'doctor', 'link', 'unlink'],
  pool: ['status', 'add', 'reset', 'list', 'import', 'use', 'api', 'delete', 'remove', 'enable', 'disable', 'scheduling', 'auto-import'],
  proxy: ['start', 'stop', 'status', 'help', 'quickstart', 'cert', 'client', 'token', 'subscription', 'sub', 'tls', 'cursor2api', 'switch-center', 'switch', 'trae-switch', 'windsurf-switch', 'core'],
  docs: ['quickstart', 'start', 'ai-fastlane', 'ai', 'fastlane', 'maintainer', 'claude', 'gateway', 'strategy', 'faq', 'subscribe', 'sub', 'check', 'freshness'],
  skill: ['list', 'install', 'add', 'uninstall', 'search', 'run', 'learn', 'learned', 'forget', 'suggest', 'stats', 'curator', 'pin', 'unpin', 'archive', 'restore'],
  extension: ['list', 'search', 'install', 'uninstall', 'enable', 'disable', 'update', 'info', 'link', 'unlink', 'new'],
  ext: ['list', 'search', 'install', 'uninstall', 'enable', 'disable', 'update', 'info', 'link', 'unlink', 'new'],
  log: ['error', 'tail', 'clear'],
  usage: ['today', 'history', 'reset'],
  history: ['list', 'resume', 'clear'],
  train: ['start', 'cloud', 'distill', 'status', 'list', 'export', 'upload', 'data'],
  growth: ['export', 'import', 'snapshot', 'snapshots', 'restore', 'reset'],
  agent: ['list', 'templates', 'run', 'spawn'],
  pr: ['create', 'help'],
  mr: ['create', 'help'],
  ci: ['status', 'watch', 'help'],
  forge: ['search', 'find', 'recon', 'inspect', 'explore', 'commits', 'log', 'history', 'code', 'code-search', 'grep', 'ratelimit', 'rate-limit', 'rate', 'quota', 'clone', 'get', 'pull', 'update', 'help'],
  verdict: ['show', 'check', 'watch', 'emit', 'help'],
  evolve: ['status', 'rules', 'safety', 'classify', 'check', 'cascades', 'help'],
  evolution: ['status', 'rules', 'safety', 'classify', 'check', 'cascades', 'help'],
  deps: ['list', 'ls', 'versions', 'version', 'check', 'probe', 'install', 'add', 'help'],
  dep: ['list', 'ls', 'versions', 'version', 'check', 'probe', 'install', 'add', 'help'],
  dependency: ['list', 'ls', 'versions', 'version', 'check', 'probe', 'install', 'add', 'help'],
  workflow: ['import', 'add', 'list', 'ls', 'show', 'view', 'validate', 'check', 'run', 'exec', 'rm', 'delete', 'remove', 'del', 'help'],
  wf: ['import', 'add', 'list', 'ls', 'show', 'view', 'validate', 'check', 'run', 'exec', 'rm', 'delete', 'remove', 'del', 'help'],
  prompt: ['save', 'list', 'use', 'delete', 'search', 'folder', 'dir', 'compose', 'write', 'edit'],
  knowledge: ['search', 'stats', 'sync', 'self'],
  habit: ['predict'],
  security: ['scan', 'monitor', 'status', 'integrity', 'profile', 'audit', 'permissions'],
  monitor: ['status', 'tail', 'clear', 'dashboard', 'tools', 'selfcheck'],
  search: ['web'],
  session: ['list', 'ls', 'show', 'view', 'resume', 'load', 'open', 'rename', 'title', 'delete', 'rm', 'remove', 'export', 'search', 'stats', 'help'],
  services: ['list', 'health'],
  app: ['list', 'register', 'install', 'uninstall', 'start', 'stop', 'run', 'ipc', 'exports', 'status', 'cli-gen', 'cli-search', 'cli-install', 'cli-uninstall', 'cli-list', 'cli-sync', 'cli-import', 'cli-invoke', 'khy-add', 'khy-remove', 'khy-proxies', 'khy-run', 'khy-search', 'khy-install', 'khy-uninstall', 'khy-list', 'khy-sync', 'khy-import', 'khy-invoke', 'khy-gen'],
  models: ['list', 'pull', 'import', 'delete', 'set'],
  device: ['list', 'search', 'install', 'uninstall', 'download'],
  runtime: ['install', 'status', 'verify'],
  trace: ['list', 'show', 'verify'],
  replay: ['list', 'export', 'verify', 'run'],
  guide: ['map', 'export', 'list'],
  cleanup: ['status'],
  self: ['capabilities', 'boundaries', 'runtime'],
  linux: ['status', 'net', 'run', 'help'],
  shell: ['run', 'help'],
  verify: ['node', 'python', 'wasm', 'docker', 'workflow', 'wf', 'tasks', 'pipeline'],
  channels: ['status', 'order', 'reset'],
  workspace: ['save', 'restore', 'list', 'diff', 'delete', 'cleanup', 'stats'],
  repo: ['status', 'workspace', 'ws', 'save', 'commit', 'history', 'log', 'branch', 'publish', 'push', 'audit', 'risk', 'check', 'charter', 'rules', 'discipline', 'help'],
  gitignore: ['generate', 'gen', 'add', 'review', 'list', 'ls', 'approve', 'discard', 'clear', 'help'],
  deploy: ['list', 'status', 'stop', 'logs', 'help'],
  storage: ['status', 'migrate', 'help'],
  metadata: ['gen', 'refresh', 'check', 'show', 'link', 'hook'],
  meta: ['gen', 'refresh', 'check', 'show', 'link', 'hook'],
  capability: ['list', 'show', 'toggles', 'on', 'off', 'set'],
  rtk: ['gain', 'status', 'install', 'on', 'off'],
  '20x': ['status', 'on', 'off'],
  lazy: ['ladder', 'show', 'debt', 'ledger', 'level', 'on', 'off', 'help'],
  goal: ['show', 'status', 'set', 'add', 'clear', 'done', 'reset', 'list', 'ls', 'endurance', 'stamina', 'endure', 'on', 'off', 'help'],
  insights: ['show', 'report', 'list', 'ls', 'on', 'off', 'help'],
  vault: ['list', 'ls', 'set', 'add', 'put', 'get', 'show', 'rm', 'remove', 'del', 'delete', 'unset', 'on', 'off', 'help'],
  mesh: ['peers', 'list', 'ls', 'register', 'join', 'send', 'msg', 'tell', 'inbox', 'recv', 'read', 'attach', 'detach', 'on', 'off', 'help'],
  notify: ['status', 'show', 'set', 'config', 'test', 'send', 'push', 'clear', 'rm', 'remove', 'unset', 'on', 'off', 'help'],
  msg: ['status', 'show', 'list', 'platforms', 'providers', 'set', 'config', 'send', 'push', 'test', 'clear', 'rm', 'remove', 'unset', 'on', 'off', 'help'],
  doc: ['title'],
  maintain: ['status', 'health', 'doctor', 'audit', 'freshness', 'gen', 'refresh', 'check', 'show', 'link', 'hook'],
  receipts: ['list', 'show', 'search'],
  rewind: ['list'],
  publish: [
    'check', 'build', 'pypi', 'testpypi',
    'docker-bundle', 'bundle-docker', 'docker',
    'pip-dir-bundle', 'bundle-pip', 'pip-bundle', 'pipdir',
    'npm-dir-bundle', 'bundle-npm', 'npm-bundle', 'npmdir',
    'origin-code', 'restore-origin', 'origin',
    'git-push', 'push-git', 'push',
    'self-fix', 'self-bugfix', 'autofix',
    'self-pypi', 'self-testpypi', 'self-release',
    'help',
  ],
  buddy: ['hatch', 'pet', 'card', 'mute', 'unmute'],
  assistant: ['on', 'off', 'status', 'dream', 'log', 'brief'],
  ultraplan: ['status', 'list'],
  bridge: ['start', 'stop', 'status', 'token', 'nginx'],
  daemon: ['start', 'stop', 'status', 'restart', 'logs', 'sessions'],
  cron: ['list', 'add', 'remove', 'enable', 'disable', 'status'],
  job: ['list', 'new', 'jobs', 'ls', 'status', 'reply', 'help'],
  skin: ['set', 'list'],
  remote: ['hosts', 'connect', 'exec', 'sessions', 'disconnect'],
  remotedev: ['connect', 'attach', 'status', 'logs', 'stop', 'help'],
  rdev: ['connect', 'attach', 'status', 'logs', 'stop', 'help'],
  config: ['set', 'get', 'list', 'show', 'layers', 'openclaw', 'opencode'],
  coordinator: ['on', 'off', 'status', 'board'],
  orchestrate: ['run', 'status', 'list', 'pause', 'resume', 'replay', 'cancel', 'help'],
  orch: ['run', 'status', 'list', 'pause', 'resume', 'replay', 'cancel', 'help'],
  learn: ['progress', 'rank', 'roadmap', 'export', 'import', 'reset', 'next', 'done', 'bugs', 'note', 'memory', 'edit', 'check', 'sync', 'refresh', 'level', 'improve'],
  // Sub-commands are the manageable resource ids. The authoritative list lives
  // in services/management (managementRegistry); parityGuard asserts this stays
  // in sync. Kept static here so this constants module has no DB dependency.
  manage: ['list', 'users', 'api-keys', 'dependencies', 'custom-providers', 'model-overrides', 'model-config', 'cron'],
  statusline: ['show', 'status', 'render', 'preview', 'set', 'off', 'disable', 'clear', 'on', 'enable', 'setup', 'help'],
  mcp: ['governance', 'gov', 'add', 'remove', 'rm', 'serve'],
};

const CATEGORY_BY_COMMAND = {
  model: 'model',
  models: 'model',
  runtime: 'model',
  gateway: 'model',
  channels: 'model',
  max: 'model',
  high: 'model',
  medium: 'model',
  low: 'model',

  cost: 'data',
  history: 'data',
  prompt: 'data',
  knowledge: 'data',
  growth: 'data',

  permissions: 'security',
  security: 'security',
  scan: 'security',
  login: 'security',
  register: 'security',
  logout: 'security',
  whoami: 'security',
  passwd: 'security',
  forgot: 'security',

  review: 'dev',
  doctor: 'dev',
  hardware: 'dev',
  clipboard: 'dev',
  websearch: 'dev',
  image: 'dev',
  paste: 'dev',
  image2web: 'dev',
  publish: 'dev',
  repo: 'dev',
  forge: 'dev',
  mobile: 'system',
  shell: 'system',

  agent: 'workflow',
  skill: 'workflow',
  extension: 'workflow',
  ext: 'workflow',
  plan: 'workflow',
  'ulw-loop': 'workflow',
  profile: 'workflow',
  habit: 'workflow',
  resume: 'workflow',
  goal: 'workflow',
  insights: 'analysis',
  vault: 'security',
  mesh: 'system',
  notify: 'system',
  memory: 'workflow',
  proxy: 'workflow',
  subscribe: 'workflow',

  linux: 'system',
  cron: 'workflow',
  job: 'workflow',
  skin: 'system',
  remote: 'system',
  help: 'system',
  clear: 'system',
  exit: 'system',
  update: 'system',
  cleanup: 'system',
  self: 'system',
};

const BUILTIN_SLASH_COMMANDS = [
  { cmd: '/model', label: '切换 AI 模型', desc: '选择 AI 服务提供商和模型', route: 'gateway model' },
  { cmd: '/memory', label: '记忆管理', desc: '管理 khy.md 指令文件；`/memory distill` 蒸馏记忆（归档陈旧/重复/空记忆，可恢复）', route: 'memory' },
  { cmd: '/remember', label: '记住一条', desc: '追加一条记忆到 khy.md（等同输入 # 开头的行）', route: 'remember' },
  { cmd: '/instructions', label: '指令文件审核', desc: '审核 khy 主动写 khy.md/agent.md 的待审核候选：`list` 列出、`approve <id>` 批准写入、`discard <id>` 丢弃、`clear` 清空', route: 'instructions' },
  { cmd: '/gitignore', label: '忽略清单', desc: '生成/维护 .gitignore：`generate` 按技术栈生成、`add <pattern>` 追加、`review` 看待审核、`approve <id>` 批准写入、`discard <id>` 丢弃、`clear` 清空', route: 'gitignore' },
  { cmd: '/add-dir', label: '添加工作目录', desc: '授权会话访问额外的工作目录', route: 'add-dir' },
  { cmd: '/agents', label: '代理类型', desc: '列出可用的代理类型（内置 + .khy/agents/、.claude/agents/ 自定义）', route: 'agents' },
  { cmd: '/output-style', label: '输出风格', desc: '查看或切换 AI 输出风格（senior-engineer/concise/verbose/code-only/off）', route: 'output-style' },
  { cmd: '/lang', label: '输出语言', desc: '查看/设置输出语言偏好（zh/en/auto，对齐 Claude Code /lang）', route: 'lang' },
  { cmd: '/release-notes', label: '发布说明', desc: '显示本地 CHANGELOG.md 的发布说明（可按版本/数量，对齐 Claude Code /release-notes）', route: 'release-notes' },
  { cmd: '/terminal-setup', label: '终端配置', desc: '检测当前终端并给出 Shift+Enter 换行配置方案（对齐 Claude Code terminalSetup）', route: 'terminal-setup' },
  { cmd: '/keybindings', label: '键盘快捷键', desc: '按上下文列出所有键盘快捷键（可按上下文/关键词过滤，对齐 Claude Code keybindings）', route: 'keybindings' },
  { cmd: '/perf-issue', label: '性能报告', desc: '生成本会话 token/成本/回合/墙钟性能报告到本地（md/json/csv，离线，对齐 Claude Code perf-issue）', route: 'perf-issue' },
  { cmd: '/issue', label: '上报问题', desc: '从会话上下文创建 GitHub issue（gh 可用即创建，否则给浏览器链接/本地草稿，对齐 Claude Code /issue）', route: 'issue' },
  { cmd: '/feedback', label: '提交反馈', desc: '对 khy 工具本身提反馈/报 bug（--category bug|idea|praise|other <内容>，落本地草稿并指向上游 issues，绝不静默上传，对齐 Claude Code /feedback）', route: 'feedback' },
  { cmd: '/bug', label: '报告缺陷', desc: '把 khy 的问题记为反馈草稿（/feedback 的别名，落本地并指向上游，绝不静默上传，对齐 Claude Code /bug）', route: 'bug' },
  { cmd: '/sandbox-toggle', label: 'OS 沙箱开关', desc: '查看/切换 OS 级命令沙箱（bwrap/Seatbelt/Job Object）on|off|auto|toggle，持久化到 .env，对齐 Claude Code sandbox-toggle', route: 'sandbox-toggle' },
  { cmd: '/init-verifiers', label: '创建校验器', desc: '引导创建功能校验器技能（Web/CLI/API，脚手架到 .khy/skills），对齐 Claude Code init-verifiers', route: 'init-verifiers' },
  { cmd: '/fork', label: '分叉会话', desc: '把当前对话复制成一份独立副本并切过去探索岔路（原会话不动），对齐 Claude Code /fork', route: 'fork' },
  { cmd: '/topology', label: '会话拓扑', desc: '把历次 /fork 分叉组织成一张「会话拓扑网」并可视化（view 树视图 / digest 各分支摘要），学自 Stello 把线性对话炸开成一张网', route: 'topology' },
  { cmd: '/btw', label: '补充提示', desc: '不打断当前请求地排队一条补充提示，下一回合并入用户输入一起发给模型，对齐 Claude Code by-the-way', route: 'btw' },
  { cmd: '/autonomy', label: '自治巡检', desc: '只读巡检 khy 的自治活动（编排运行/受管 flow/cron 计划/proactive tick/远端会话/权限模式），并可对单个 flow 查看/取消/恢复，对齐 Claude Code /autonomy', route: 'autonomy' },
  { cmd: '/proactive', label: '主动模式', desc: '开/关主动 idle-tick 模式（on|off|toggle|status），开启后后台周期性驱动记忆 dream 整理，对齐 Claude Code /proactive', route: 'proactive' },
  { cmd: '/onboarding', label: '重跑引导', desc: '重跑首次引导的某个步骤（full|theme|trust|model|mcp|status；trust 委托真实文件夹信任 workspace-trust，显示当前信任状态并可当场信任本目录），对齐 Claude Code /onboarding', route: 'onboarding' },
  { cmd: '/debug-tool-call', label: '工具调用回看', desc: '从当前会话 transcript 配对展示最近 N 个工具调用(tool_use)及其结果，对齐 Claude Code /debug-tool-call(khy transcript 未存结果时如实标注,绝不编造)', route: 'debug-tool-call' },
  { cmd: '/recap', label: '会话回顾', desc: '回顾当前会话发生了什么(主题/决策/改动文件/命令/未决问题/洞见)，对齐 Claude Code /recap(khy 用确定性抽取,无模型也可用,绝不阻塞等模型)', route: 'recap' },
  { cmd: '/thinkback', label: '使用回顾', desc: '对本地使用数据做周期回顾(token/请求/成本/活跃天/会话/常用模型/高频话题，--days N 默认30，确定性离线，对齐 Claude Code /thinkback；khy 不复刻其云端/动画层，数据不足如实提示)', route: 'thinkback' },
  { cmd: '/copy', label: '复制回复', desc: '把最近(或第 N 条)助手回复 / 其中代码块复制到系统剪贴板(/copy · /copy N · /copy code [N])，对齐 Claude Code /copy(khy 走 pbcopy/xclip/wl-copy/Set-Clipboard,无内容时如实告知绝不假装成功)', route: 'copy' },
  { cmd: '/rename', label: '重命名会话', desc: '重命名当前会话标题(/rename <新标题>)，对齐 Claude Code /rename(khy 不在此命令偷起模型,无参时提示需显式给名绝不伪造)', route: 'rename' },
  { cmd: '/tag', label: '会话标签', desc: '给当前会话打/去可搜索标签(/tag 列出 · /tag <名...> 打或去,逗号/空格分隔,同名再打=移除)，对齐 Claude Code /tag', route: 'tag' },
  { cmd: '/heapdump', label: '堆快照', desc: '落一份 V8 堆快照(.heapsnapshot,供 Chrome DevTools 内存分析)+ 内存诊断 JSON(含原生内存指标,快照不含),对齐 Claude Code /heapdump', route: 'heapdump' },
  { cmd: '/break-cache', label: '击穿缓存', desc: '击穿 Anthropic 前缀提示缓存(once 一次性 · always 持久 · off 关闭 · status 查看),往系统提示前缀注入 nonce 强制下次/每次调用重算上下文,对齐 Claude Code /break-cache', route: 'break-cache' },
  { cmd: '/color', label: '会话颜色', desc: '给当前会话设/重置显示强调色(/color 列出 · /color <色> 设 · /color default 重置),应用到 TUI 输入框边框与 ❯ 标记并随会话持久化,对齐 Claude Code /color', route: 'color' },
  // ── CC 名别名(EQUIVALENT·菜单补齐)—— route 指向 khy 既有 canonical,绝不另起 case。账本 [IMPL-RPT-040] ──
  { cmd: '/mode', label: '行为模式', desc: '切换行为预设/人格(对齐 Claude Code /mode → khy persona)', route: 'persona' },
  { cmd: '/security-review', label: '安全审查', desc: '对工作树跑安全扫描(对齐 Claude Code /security-review → khy security scan)', route: 'security scan' },
  { cmd: '/force-snip', label: '强制裁剪', desc: '手动裁剪近期消息以省上下文(对齐 Claude Code /force-snip → khy snip)', route: 'snip' },
  { cmd: '/skills', label: '技能列表', desc: '列出可用技能(对齐 Claude Code /skills → khy skill list)', route: 'skill list' },
  { cmd: '/skill-learning', label: '技能学习', desc: '从近期会话学习/沉淀技能(对齐 Claude Code /skill-learning → khy skill learn)', route: 'skill learn' },
  { cmd: '/skill-search', label: '技能搜索', desc: '按关键词搜索技能(对齐 Claude Code /skill-search → khy skill search)', route: 'skill search' },
  { cmd: '/learn-skill', label: '提炼技能', desc: '把一个目录或网页提炼成可复用技能:/learn-skill dir <目录> · /learn-skill url <网页>(对齐 Hermes /learn → khy skill learn dir|url;顶层别名不撞 /learn 课程,尾参 dir/url 经 router 展开为 skill learn dir/url)', route: 'skill learn' },
  { cmd: '/local-vault', label: '本地密钥库', desc: '管理本地密钥库(对齐 Claude Code /local-vault → khy vault)', route: 'vault' },
  { cmd: '/local-memory', label: '本地记忆', desc: '查看/管理本地记忆(对齐 Claude Code /local-memory → khy memory)', route: 'memory' },
  { cmd: '/provider', label: 'AI 服务商', desc: '配置 AI 服务商/端点(对齐 Claude Code /provider → khy gateway config)', route: 'gateway config' },
  { cmd: '/reload-plugins', label: '重载插件', desc: '重新加载插件(对齐 Claude Code /reload-plugins → khy plugin reload)', route: 'plugin reload' },
  { cmd: '/commit-push-pr', label: '提交并开 PR', desc: '编排 git 提交/推送并开 PR(对齐 Claude Code /commit-push-pr → khy pr create)', route: 'pr create' },
  { cmd: '/poor', label: '省钱档', desc: '切到低 token 努力档(对齐 Claude Code /poor → khy effort low)', route: 'effort low' },
  { cmd: '/workflows', label: '工作流', desc: '工作流编排 CLI(对齐 Claude Code /workflows → khy workflow)', route: 'workflow' },
  { cmd: '/sandbox', label: '沙箱开关', desc: '切换沙箱执行模式(对齐 Claude Code /sandbox → khy sandbox-toggle)', route: 'sandbox-toggle' },
  { cmd: '/advisor', label: '模型顾问', desc: '基于实测表现(成功率×速度·多臂老虎机)推荐当前最佳可执行模型(recommend|status)，对齐 Claude Code /advisor', route: 'advisor' },
  { cmd: '/autofix-pr', label: '修复CI', desc: '读当前分支 CI;失败则在本地工作树跑审计修复闭环(status|run|stop)，对齐 Claude Code /autofix-pr(khy 本地修复而非云端 teleport)', route: 'autofix-pr' },
  { cmd: '/claim-main', label: '认领主角色', desc: '在同机多 khy 实例间认领唯一「主」角色(claim|status|release)，对齐 Claude Code /claim-main(khy 用 getDataDir 指针+PID 存活而非 socket/pipe IPC)', route: 'claim-main' },
  { cmd: '/ide', label: 'IDE集成状态', desc: '查看本机已探测 IDE + khy bridge 通道状态(status|list)，对齐 Claude Code /ide(khy 只读探测+bridge,不伪造 IDE 扩展握手)', route: 'ide' },
  { cmd: '/subscribe-pr', label: '订阅PR CI', desc: '订阅 PR/分支 CI(<ref>|list|check|unsubscribe);check 时本地轮询并在变终态时推送，对齐 Claude Code /subscribe-pr(khy 本地轮询+既有推送而非云端 OAuth 回推)', route: 'subscribe-pr' },
  { cmd: '/pr-comments', label: 'PR评论', desc: '把当前(或指定 <PR号>)GitHub PR 的讨论/评审/行内评论拉进会话，对齐 Claude Code /pr_comments(khy shell gh 只读抓取，仅 GitHub)', route: 'pr-comments' },
  { cmd: '/web-tools', label: '搜索引擎配置', desc: '查看当前联网搜索后端(Kiro MCP)与运行期动态引擎(search_engines.json / KHY_SEARCH_EXTRA_ENGINES)配置并给出编辑指引，对齐 Claude Code /web-tools(khy 只读浮现现状，写入式配置暂不移植)', route: 'web-tools' },
  { cmd: '/statusline', label: '状态栏配置', desc: '查看/预览/设置终端状态栏(show|preview|set|off|setup…，对齐 Claude Code /statusline → khy statusline，handler 早已存在,仅补菜单入口)', route: 'statusline' },
  { cmd: '/rewind', label: '回溯检查点', desc: '列出/恢复会话·版本检查点,或把文件回退到某个快照(list|<checkpointId>|file <path>，对齐 Claude Code /rewind → khy rewind)', route: 'rewind' },
  { cmd: '/undo', label: '撤销改动', desc: '撤销最近一次(或指定文件)的文件编辑(patch 级,对齐 Claude Code /undo → khy undo)', route: 'undo' },
  // ── 菜单补齐:可路由但此前从不出现在 /help 与 / 自动补全的 CC 对齐命令 ──
  // 这些命令键入即通过 router catch-all 正常执行(在 ROUTER_COMMANDS 中),缺的只是
  // 菜单登记(BUILTIN_SLASH_COMMANDS)→ 不可发现。此处仅补菜单入口,route 指向既有
  // canonical case,绝不新起 handler;菜单选中经 repl.js:4372 selected.route 路由,
  // 故一律指向只读子命令(status/card),避免菜单一点即触发副作用(如 bridge start)。
  { cmd: '/cron', label: '定时任务', desc: '持久化 cron 定时任务调度(list/add/remove/enable/disable/status,支持 --channel/--no-agent/--context-from/--timeout),对齐 Claude Code /schedule(khy 的 /cron 覆盖面更全)', route: 'cron', category: 'workflow' },
  { cmd: '/schedule', label: '定时任务(CC 名)', desc: 'Claude Code /schedule 的 khy 等价入口 → khy cron(持久化 cron 调度器)', route: 'cron', category: 'workflow' },
  { cmd: '/monitor', label: 'AI 监控', desc: '查看 AI 请求监控(总数/成功率/延迟/缓冲;status/tail/dashboard/tools/selfcheck),对齐 Claude Code /monitor', route: 'monitor status', category: 'system' },
  { cmd: '/coordinator', label: '协调者模式', desc: '多代理协调者模式(on/off/status/board),对齐 Claude Code /coordinator', route: 'coordinator status', category: 'workflow' },
  { cmd: '/ultraplan', label: '深度规划', desc: '查看深度规划会话(status/list),对齐 Claude Code /ultraplan', route: 'ultraplan status', category: 'workflow' },
  { cmd: '/assistant', label: '助理模式', desc: '后台助理模式与每日简报(on/off/status/dream/log/brief),对齐 Claude Code /assistant', route: 'assistant status', category: 'workflow' },
  { cmd: '/brief', label: '每日简报', desc: '生成当前会话/工作的简报,对齐 Claude Code /brief', route: 'brief', category: 'workflow' },
  { cmd: '/buddy', label: '伙伴', desc: '查看伙伴/宠物卡片(hatch/pet/card/mute),对齐 Claude Code /buddy', route: 'buddy card', category: 'system' },
  { cmd: '/bridge', label: 'IDE 桥接', desc: '查看 IDE 桥接服务状态(start/stop/status/token),对齐 Claude Code /bridge(只读默认,菜单不自动 start)', route: 'bridge status', category: 'system' },
  { cmd: '/init', label: '初始化项目', desc: '为当前项目生成/刷新项目记忆与元数据脚手架,对齐 Claude Code /init', route: 'init', category: 'dev' },
  { cmd: '/local', label: '本地模式', desc: '强制使用本地能力，不调用 AI 模型', route: null, flag: 'local' },
  { cmd: '/plan', label: '计划模式', desc: 'AI 制定执行计划后再操作', route: null, flag: 'plan' },
  { cmd: '/ulw-loop', label: 'ULW 循环', desc: '以 ultrawork 高强度模式执行任务', route: 'ulw-loop' },
  { cmd: '/cost', label: '查看费用', desc: '查看 Token 用量和费用统计', route: 'cost' },
  { cmd: '/permissions', label: '权限策略', desc: '查看/编辑细粒度权限策略（auto/confirm/deny、白名单、敏感操作）', route: 'permissions' },
  { cmd: '/history', label: '对话历史', desc: '查看和恢复历史对话', route: 'history list' },
  { cmd: '/profile', label: '用户画像', desc: '查看使用习惯和用户画像', route: 'profile' },
  { cmd: '/growth', label: '成长档案', desc: '查看量化学习成长进度', route: 'growth' },
  { cmd: '/knowledge', label: '知识库', desc: '搜索和管理量化知识', route: 'knowledge' },
  { cmd: '/skill', label: '技能管理', desc: '查看、安装和管理 Skills', route: 'skill list' },
  { cmd: '/ext', label: '扩展市场', desc: '查看、搜索、安装和管理扩展（extension marketplace）', route: 'ext list', category: 'workflow' },
  { cmd: '/resume', label: '恢复对话', desc: '恢复上次的 AI 对话上下文', route: 'resume' },
  { cmd: '/goal', label: '持久目标', desc: '设定/查看/清除持久目标(每轮提醒模型朝它推进,直到清除——对齐 Claude Code /goal)；`/goal set <文本>`、`/goal clear`', route: 'goal', category: 'workflow' },
  { cmd: '/insights', label: '会话洞见', desc: '回顾本次会话:轮次、最常用工具、话题关键词、耗时(对齐 Claude Code /insights)；`/insights`、`/insights list`', route: 'insights', category: 'analysis' },
  { cmd: '/vault', label: '密钥保险库', desc: '本地存放 API token 等机密(0600),模型用 {{vault:NAME}} 引用、真值服务端注入绝不进入上下文(对齐 Claude Code)；`/vault set <名称> <值>`、`/vault list`', route: 'vault list', category: 'security' },
  { cmd: '/mesh', label: '多实例协作', desc: '同机多个 khy 实例彼此发现、attach/detach、跨进程互发消息(对齐 Claude Code 多实例协作)；`/mesh peers`、`/mesh send <id> <消息>`', route: 'mesh peers', category: 'system' },
  { cmd: '/notify', label: '推送通知', desc: '把消息推到终端之外(手机/桌面 —— ntfy/Bark/Discord/Slack/webhook,对齐 Claude Code 推送);长任务完成或阻塞点主动提醒；`/notify set <provider> <目标>`、`/notify test`', route: 'notify status', category: 'system' },
  { cmd: '/msg', label: '多平台消息', desc: '向钉钉/飞书/企业微信群机器人收发消息:填入群机器人 webhook(及可选加签/收信密钥)即可发送;把 /webhooks/<平台> 配到平台后台可接收;`/msg set <平台> webhook=<url>`、`/msg send <平台> <文本>`', route: 'msg status', category: 'system' },
  { cmd: '/gateway', label: 'AI 网关', desc: '管理 AI 网关和适配器', route: 'gateway status' },
  { cmd: '/channels', label: '通道健康', desc: '查看通道熔断/冷却/错误率，管理故障转移顺序', route: 'channels status' },
  { cmd: '/apikey', label: 'API 密钥配置', desc: '引导配置 API Key、URL 与模型', route: 'gateway config' },
  { cmd: '/prompt', label: '提示词库', desc: '管理保存的提示词模板', route: 'prompt list' },
  { cmd: '/prompt compose', label: '撰写长提示词', desc: '在编辑器里从容撰写多行长提示词后发送', route: 'prompt compose' },
  { cmd: '/cleanup', label: '清理存储', desc: '清理历史数据释放磁盘空间', route: 'cleanup status' },
  { cmd: '/self', label: '自我画像', desc: '查看 khy OS 完整能力、边界与运行时状态', route: 'self', category: 'system' },
  { cmd: '/proxy', label: '代理设置', desc: '配置 Clash/HTTP/SOCKS5 代理', route: null, flag: 'proxy' },
  { cmd: '/models', label: '模型管理', desc: 'Ollama/NVIDIA 模型下载管理', route: null, flag: 'models' },
  { cmd: '/runtime', label: '推理运行时', desc: '查看/按需安装本地推理运行时 (ollama/llama.cpp)', route: 'runtime status' },
  { cmd: '/image', label: '图片分析', desc: '加载图片文件进行视觉分析或网页还原', route: null, flag: 'image' },
  { cmd: '/image2web', label: '网页还原', desc: '将网页截图转为可运行 HTML 并可自动保存', route: 'image2web' },
  { cmd: '/paste', label: '粘贴图片', desc: '从剪贴板粘贴图片进行分析', route: null, flag: 'paste' },
  { cmd: '/doctor', label: '系统诊断', desc: '检查依赖、数据库、网络状态', route: 'doctor' },
  { cmd: '/health', label: '健康体检', desc: '统一自助诊断：运行时/数据目录/认证/网络/模型通道/外部后端/磁盘/内存 一条命令聚合，支持 --json', route: 'health', category: 'dev' },
  { cmd: '/maintain', label: '维护驾驶舱', desc: '单人维护者健康总览：元数据/架构债/基建裸奔/版本 一条命令看全 + 唯一下一步', route: 'maintain', category: 'dev' },
  { cmd: '/maintainer', label: '维护入口', desc: '查看维护地图、入口文档与分层验证命令', route: 'docs maintainer' },
  { cmd: '/docs-check', label: '文档过时检查', desc: '改源码后哪些文档可能过时(过时提醒 + 产物重生成 + 内嵌值同步),--fix 修复 · --ai 出改稿建议', route: 'docs check', category: 'dev' },
  { cmd: '/publish', label: '发布工具', desc: '构建/发布 Python 包、导出 Docker/pip/npm 包、还原 origin code、自修复与自发布、推送 Git 远程', route: 'publish check' },
  { cmd: '/repo', label: '版本管理', desc: '小白安全版版本管理：看状态 / 保存版本 / 看历史 / 切分支 / 发布', route: 'repo status', category: 'dev' },
  { cmd: '/git', label: '工作区全貌', desc: '看当前工作区：位置 / 分支 / 远端 / 领先落后 / 待保存改动', route: 'repo workspace', category: 'dev' },
  { cmd: '/commit', label: '保存版本', desc: '保存一个版本快照（= git commit）：khy repo save "说明"', route: 'repo save', category: 'dev' },
  { cmd: '/push', label: '发布到远程', desc: '把保存的版本发布到远程仓库（= git push）', route: 'repo publish', category: 'dev' },
  { cmd: '/forge', label: '查找/侦察/拉取项目', desc: '在 GitHub/Gitee/GitLab 上搜索、侦察(元数据/结构/构建·部署提示)并克隆项目（search / recon / clone / pull）', route: 'forge help', category: 'dev' },
  { cmd: '/mobile', label: '手机扫码访问', desc: '生成二维码，手机扫描即可在同一局域网访问 Web 界面', route: 'mobile', category: 'system' },
  { cmd: '/scan', label: '病毒扫描', desc: 'ClamAV 病毒扫描项目文件', route: null, flag: 'scan' },
  { cmd: '/security', label: '安全状态', desc: '安全状态、完整性校验、威胁扫描', route: null, flag: 'security-full' },
  { cmd: '/hardware', label: '硬件信息', desc: '查看硬件配置和本地模型推荐', route: null, flag: 'hardware' },
  { cmd: '/review', label: '代码审查', desc: 'AI 审查当前 Git 改动', route: null, flag: 'review' },
  { cmd: '/clipboard', label: '剪贴板', desc: 'Web AI 剪贴板中继 + Windows 图片粘贴桥接', route: null, flag: 'clipboard' },
  { cmd: '/websearch', label: '联网搜索', desc: '通过 Kiro 搜索网页获取最新信息', route: null, flag: 'websearch' },
  { cmd: '/linux', label: 'Linux 能力', desc: '网络诊断与基础 Linux 命令执行', route: 'linux help' },
  { cmd: '/khyos', label: 'KHY OS 内核', desc: '进入裸机内核终端 (QEMU shell + KhyFS 磁盘)', route: 'khyos' },
  { cmd: '/shell', label: 'Shell 命令', desc: '执行 shell 命令（支持 --cwd/--timeout）', route: 'shell help' },
  { cmd: '/deploy', label: '项目部署', desc: '把项目部署到指定位置并启动 (list/status/stop/logs)', route: 'deploy help' },
  { cmd: '/storage', label: '存储位置', desc: '查看磁盘/数据家位置，迁移到非系统盘防止系统盘崩溃 (status/migrate)', route: 'storage status', category: 'system' },
  { cmd: '/uninstall', label: '完整卸载', desc: '预览并清理所有历史数据家/运行时残留 (默认仅预览，--yes 执行)', route: 'uninstall', category: 'system' },
  { cmd: '/features', label: '功能索引', desc: '按类别浏览全部可用命令 (可 /features <关键字> 过滤)', route: 'features', category: 'system' },
  { cmd: '/toollist', label: '工具清单', desc: '按类别浏览 khy 拥有的全部 AI 工具 (可 /toollist <关键字> 过滤)', route: 'toollist', category: 'system' },
  { cmd: '/toolcheck', label: '工具体检', desc: '审计 khy 工具契约与命名冲突，保证工具精准可用 (可 --json)', route: 'toolcheck', category: 'system' },
  { cmd: '/heal', label: '源码自愈', desc: '检查并修复缺失/损坏的运行时源码文件 (默认 dry-run；--apply 真修复)', route: 'heal', category: 'system' },
  { cmd: '/job', label: '模板任务', desc: '从 markdown 模板实例化可复现任务 (list/new/jobs/status/reply)，对齐 Claude Code /job', route: 'job', category: 'workflow' },
  { cmd: '/update', label: '检查更新', desc: '检查并安装最新版本', route: 'update' },
  { cmd: '/subscribe', label: '订阅指引', desc: 'AI 模型订阅与获取指南 (含国内方案)', route: null, flag: 'subscribe' },
  { cmd: '/arena', label: 'Arena 对比', desc: '多模型并行对比 (含排行榜)', route: 'arena' },
  { cmd: '/moa', label: 'MoA 合成', desc: '多模型并行 + aggregator 合成最终答案', route: 'moa' },
  { cmd: '/daemon', label: '守护进程', desc: '管理后台守护进程 (start/stop/status)', route: 'daemon status' },
  { cmd: '/help', label: '帮助', desc: '显示所有可用命令', route: 'help' },
  { cmd: '/clear', label: '清屏', desc: '清除终端内容', route: 'clear' },
  { cmd: '/max', label: '最高精度', desc: '切换 AI 到最高精度模式', route: null, flag: 'effort-max' },
  { cmd: '/20x', label: '20 倍模式', desc: '满负荷档开关（effort=max + 扩展思考 + 更高工具迭代/并行子代理上限，对齐 CC Max 20x 体感）：`/20x on|off|status`', route: '20x' },
  { cmd: '/high', label: '高精度', desc: '切换 AI 到高精度模式', route: null, flag: 'effort-high' },
  { cmd: '/medium', label: '标准精度', desc: '切换 AI 到标准精度模式', route: null, flag: 'effort-medium' },
  { cmd: '/low', label: '快速模式', desc: '切换 AI 到快速响应模式', route: null, flag: 'effort-low' },
  { cmd: '/thinking', label: 'Thinking', desc: 'Toggle extended thinking display (on/off)', route: null, flag: 'thinking' },
  { cmd: '/vim', label: 'Vim Mode', desc: 'Toggle vim keybinding mode', route: null, flag: 'vim' },
  { cmd: '/voice', label: 'Voice Mode', desc: 'Toggle voice input/output', route: null, flag: 'voice' },
  { cmd: '/desktop', label: '桌面操控', desc: '开关鼠标/键盘/窗口自动化 (on/ask/strict/off)', route: null, flag: 'desktop' },
  { cmd: '/exit', label: '退出', desc: '保存对话并退出 khy OS', route: 'exit' },

  // Claude Code aligned slash commands
  { cmd: '/compact', label: 'Compact', desc: 'Compact conversation to save context', route: null, flag: 'compact' },
  { cmd: '/snip', label: 'Snip', desc: 'Manually trim recent messages from context', route: null, flag: 'snip' },
  { cmd: '/config', label: 'Config', desc: 'View/edit configuration', route: null, flag: 'config' },
  { cmd: '/context', label: 'Context', desc: 'Show current context window usage', route: null, flag: 'context' },
  { cmd: '/diff', label: 'Diff', desc: 'Show git diff of recent changes', route: null, flag: 'diff' },
  { cmd: '/effort', label: 'Effort', desc: 'Set effort level (low/medium/high)', route: null, flag: 'effort' },
  { cmd: '/env', label: 'Environment', desc: 'Show environment information', route: null, flag: 'env' },
  { cmd: '/export', label: 'Export', desc: 'Export conversation to file', route: null, flag: 'export' },
  { cmd: '/fast', label: 'Fast Mode', desc: 'Toggle fast mode for quicker responses', route: null, flag: 'fast' },
  { cmd: '/files', label: 'Files', desc: 'List files in context', route: null, flag: 'files' },
  { cmd: '/hooks', label: 'Hooks', desc: 'Manage lifecycle hooks', route: null, flag: 'hooks' },
  { cmd: '/login', label: 'Login', desc: 'Authenticate with API', route: 'login' },
  { cmd: '/logout', label: 'Logout', desc: 'Clear authentication', route: 'logout' },
  { cmd: '/mcp', label: 'MCP', desc: 'Manage MCP servers', route: null, flag: 'mcp' },
  { cmd: '/plugin', label: 'Plugins', desc: 'Manage plugins', route: 'plugin list' },
  { cmd: '/session', label: 'Session', desc: 'Session management', route: null, flag: 'session' },
  { cmd: '/sessions', label: '历史会话', desc: '浏览/恢复/重命名/删除历史会话（list|show|resume|rename|delete）', route: 'session' },
  { cmd: '/share', label: 'Share', desc: 'Share conversation', route: null, flag: 'share' },
  { cmd: '/stats', label: 'Stats', desc: 'Show session statistics', route: null, flag: 'stats' },
  { cmd: '/status', label: 'Status', desc: 'Show current status', route: null, flag: 'status' },
  { cmd: '/summary', label: 'Summary', desc: 'Summarize conversation', route: null, flag: 'summary' },
  { cmd: '/tasks', label: 'Tasks', desc: 'Inspect and control runtime tasks', route: null, flag: 'tasks' },
  { cmd: '/theme', label: 'Theme', desc: 'Change color theme', route: null, flag: 'theme' },
  { cmd: '/upgrade', label: 'Upgrade', desc: 'Check for updates', route: 'update' },
  { cmd: '/usage', label: 'Usage', desc: 'Show usage statistics', route: 'usage' },
  { cmd: '/version', label: 'Version', desc: 'Show version info', route: 'version' },
  { cmd: '/branch', label: 'Branch', desc: 'Create/switch git branch', route: null, flag: 'branch' },
  { cmd: '/worktree', label: '工作区隔离', desc: '开/退隔离 git worktree（enter [名称] | exit [keep|remove] | list | status）', route: null, flag: 'worktree' },
  { cmd: '/debug', label: 'Debug', desc: 'Debug tool call', route: null, flag: 'debug' },
  { cmd: '/stickers', label: 'Stickers', desc: 'Fun stickers', route: null, flag: 'stickers' },
  { cmd: '/learn', label: '学习课程', desc: '从零学习 KHY OS 交互式课程 (10 层递进)', route: 'learn' },
  { cmd: '/checkpoint', label: '保存检查点', desc: '手动保存当前项目状态（可通过 /rollback 恢复）', route: null, flag: 'checkpoint' },
  { cmd: '/rollback', label: '回滚项目', desc: '回滚到最近的自动或手动检查点', route: null, flag: 'rollback' },
];

// ── 声明式命令别名 SSOT(收敛「命令过载」的编译期机制)──────────────────────────
// 背景(khyos 自审 #7「命令过载·173 命令重叠·/schedule vs /cron、/push vs /repo publish、
// /sandbox vs /sandbox-toggle」)。这些重叠**几乎全是有意的**——多为 Claude Code 名别名,
// route 指向 khy 既有 canonical(见各 BUILTIN_SLASH_COMMANDS 条目 desc「对齐 Claude Code …
// → khy …」)。但「有意」只写在自由文本 desc 里,**从无机器可判的声明**:于是「这条 /cmd
// 是那条的别名」只能靠人肉读注释发现,新加一条撞了别人 route 也无人察觉——正是报告说的
// 「叠加式无收敛」。本表把「哪些 slash 命令是有意别名、别名指向哪个 canonical route」变成
// **单一声明式真源**:commandOverlapAudit 据此把 route 碰撞分成 declared(有意别名,放行)与
// undeclared(未声明漂移,守卫失败)。未来再撞 route 而不在此登记 → 守卫拦下。
//   key = 别名 slash 命令(含前导 /);value = 它有意共享的 canonical route。
const COMMAND_ALIASES = {
  '/schedule': 'cron',            // CC /schedule → khy /cron
  '/apikey': 'gateway config',    // /apikey → /provider 的 gateway config
  '/local-memory': 'memory',      // CC /local-memory → khy /memory
  '/sandbox': 'sandbox-toggle',   // CC /sandbox → khy /sandbox-toggle
  '/skills': 'skill list',        // CC /skills → khy /skill list
  '/upgrade': 'update',           // CC /upgrade → khy /update
};

function inferCategory(commandName = '') {
  return CATEGORY_BY_COMMAND[String(commandName || '').trim()] || 'system';
}

function _cloneArray(values) {
  return Array.isArray(values) ? [...values] : [];
}

function getRouterCommandNames() {
  return _cloneArray(ROUTER_COMMANDS);
}

function getRouterSubCommands() {
  const out = {};
  for (const [name, values] of Object.entries(ROUTER_SUB_COMMANDS)) {
    out[name] = _cloneArray(values);
  }
  return out;
}

function getBuiltinSlashCommands() {
  return BUILTIN_SLASH_COMMANDS.map((item) => {
    const cmd = String(item.cmd || '').trim();
    const name = cmd.replace(/^\/+/, '');
    return {
      ...item,
      category: item.category || inferCategory(name),
    };
  });
}

function getStaticSlashCommands() {
  return getBuiltinSlashCommands();
}

/**
 * Full canonical command schema for lint/test/introspection use.
 *
 * Shape:
 * - name: string
 * - subCommands: string[]
 * - slash: { cmd, label, desc, route, flag, category } | null
 * - aliases: string[]
 * - flags: string[]
 * - category: string
 */
function getCommandSchema() {
  const ordered = [];
  const byName = new Map();

  for (const name of ROUTER_COMMANDS) {
    const entry = {
      name,
      subCommands: _cloneArray(ROUTER_SUB_COMMANDS[name]),
      slash: null,
      aliases: [],
      flags: [],
      category: inferCategory(name),
    };
    ordered.push(name);
    byName.set(name, entry);
  }

  for (const slash of getBuiltinSlashCommands()) {
    const name = String(slash.cmd || '').replace(/^\/+/, '');
    if (!name) continue;

    let entry = byName.get(name);
    if (!entry) {
      entry = {
        name,
        subCommands: [],
        slash: null,
        aliases: [],
        flags: [],
        category: slash.category || inferCategory(name),
      };
      byName.set(name, entry);
      ordered.push(name);
    }

    entry.slash = {
      cmd: slash.cmd,
      label: slash.label,
      desc: slash.desc,
      route: slash.route ?? null,
      flag: slash.flag ?? null,
      category: slash.category || entry.category,
    };

    if (slash.flag) {
      entry.flags = [...new Set([...entry.flags, slash.flag])];
    }

    if (!entry.category || entry.category === 'system') {
      entry.category = slash.category || inferCategory(name);
    }
  }

  return ordered.map((name) => {
    const entry = byName.get(name);
    return {
      ...entry,
      subCommands: _cloneArray(entry.subCommands),
      aliases: _cloneArray(entry.aliases),
      flags: _cloneArray(entry.flags),
      slash: entry.slash ? { ...entry.slash } : null,
    };
  });
}

function getCommandAliases() {
  const out = {};
  for (const [alias, route] of Object.entries(COMMAND_ALIASES)) out[alias] = route;
  return out;
}

module.exports = {
  getCommandSchema,
  getRouterCommandNames,
  getRouterSubCommands,
  getBuiltinSlashCommands,
  getStaticSlashCommands,
  getCommandAliases,
  inferCategory,
};
