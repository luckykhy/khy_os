/**
 * Command Alias Registry
 *
 * Maps pinyin, English abbreviations, and Chinese to canonical commands.
 * Users type whatever feels natural; the router normalizes via this table.
 *
 *   huice sh600519         → backtest sh600519
 *   hq 茅台                → quote 茅台
 *   xz sh000001            → data fetch sh000001
 *   cl                     → strategy list
 */

// { alias → { command, [subCommand], [defaultArgs], [defaultPositionals] } }
const ALIAS_MAP = {
  // ── 行情 ──
  hq:        { command: 'quote' },
  hangqing:  { command: 'quote' },
  '行情':    { command: 'quote' },
  price:     { command: 'quote' },
  p:         { command: 'quote' },

  // ── 回测 ──
  bt:        { command: 'backtest' },
  huice:     { command: 'backtest' },
  '回测':    { command: 'backtest' },

  // ── 策略 ──
  cl:        { command: 'strategy', subCommand: 'list' },
  celue:     { command: 'strategy', subCommand: 'list' },
  '策略':    { command: 'strategy', subCommand: 'list' },

  // ── 数据下载 ──
  xz:        { command: 'data', subCommand: 'fetch' },
  xiazai:    { command: 'data', subCommand: 'fetch' },
  download:  { command: 'data', subCommand: 'fetch' },
  dl:        { command: 'data', subCommand: 'fetch' },
  '下载':    { command: 'data', subCommand: 'fetch' },

  // ── 数据列表 ──
  sj:        { command: 'data', subCommand: 'list' },
  shuju:     { command: 'data', subCommand: 'list' },
  '数据':    { command: 'data', subCommand: 'list' },

  // ── 持仓 ──
  cc:        { command: 'position' },
  chicang:   { command: 'position' },
  '持仓':    { command: 'position' },
  pos:       { command: 'position' },

  // ── 下单 ──
  xd:        { command: 'order' },
  xiadan:    { command: 'order' },
  '下单':    { command: 'order' },
  buy:       { command: 'order', defaultArgs: { side: 'buy' } },
  sell:      { command: 'order', defaultArgs: { side: 'sell' } },
  '买入':    { command: 'order', defaultArgs: { side: 'buy' } },
  '卖出':    { command: 'order', defaultArgs: { side: 'sell' } },
  mai:       { command: 'order', defaultArgs: { side: 'buy' } },
  mairu:     { command: 'order', defaultArgs: { side: 'buy' } },
  maichu:    { command: 'order', defaultArgs: { side: 'sell' } },

  // ── 账户 ──
  zh:        { command: 'account' },
  zhanghu:   { command: 'account' },
  '账户':    { command: 'account' },
  acc:       { command: 'account' },

  // ── 分析 (AI) ──
  fx:        { command: 'analyze' },
  fenxi:     { command: 'analyze' },
  '分析':    { command: 'analyze' },
  analyze:   { command: 'analyze' },

  // ── 图转网页 ──
  image2web: { command: 'image2web' },
  i2w:       { command: 'image2web' },
  webify:    { command: 'image2web' },
  '网页还原': { command: 'image2web' },
  '图转网页': { command: 'image2web' },
  '截图还原': { command: 'image2web' },

  // ── 服务 ──
  fw:        { command: 'server' },
  fuwu:      { command: 'server' },
  '服务':    { command: 'server' },
  '启动':    { command: 'server', subCommand: 'start' },

  // ── Linux 能力 ──
  linux:     { command: 'linux' },
  shell:     { command: 'shell' },
  sh:        { command: 'shell' },
  bash:      { command: 'shell' },
  lx:        { command: 'linux' },
  '终端':    { command: 'linux' },
  '网络':    { command: 'linux', subCommand: 'net' },
  '联网':    { command: 'linux', subCommand: 'net' },
  '系统状态': { command: 'linux', subCommand: 'status' },

  // ── 数据库 ──
  sjk:       { command: 'db' },
  shujuku:   { command: 'db' },
  '数据库':  { command: 'db' },

  // ── 本地模型 (Ollama) ──
  '模型':     { command: 'models', subCommand: 'list' },
  '本地模型': { command: 'models', subCommand: 'list' },
  moxing:    { command: 'models', subCommand: 'list' },
  '导入模型': { command: 'models', subCommand: 'import' },
  importmodel: { command: 'models', subCommand: 'import' },

  // ── 推理运行时 (按需拉取 ollama/llama.cpp) ──
  '运行时':     { command: 'runtime', subCommand: 'status' },
  yunhangshi:  { command: 'runtime', subCommand: 'status' },
  runtime:     { command: 'runtime', subCommand: 'status' },
  '安装运行时': { command: 'runtime', subCommand: 'install' },
  runtimeinstall: { command: 'runtime', subCommand: 'install' },
  '验证运行时': { command: 'runtime', subCommand: 'verify' },
  runtimeverify: { command: 'runtime', subCommand: 'verify' },

  // ── 轨迹溯源查看 (DESIGN-ARCH-047) ──
  '轨迹':       { command: 'trace', subCommand: 'show' },
  gj:          { command: 'trace', subCommand: 'show' },

  // ── 轨迹回放 / 确定性复现 (DESIGN-ARCH-048) ──
  '回放':       { command: 'replay', subCommand: 'run' },
  hf:          { command: 'replay', subCommand: 'run' },

  // ── 地图模板 / 轨迹即教材 (DESIGN-ARCH-049) ──
  '地图':       { command: 'guide', subCommand: 'map' },
  dt:          { command: 'guide', subCommand: 'map' },

  // ── 通道健康 / 故障转移顺序 ──
  '通道':       { command: 'channels', subCommand: 'status' },
  tongdao:     { command: 'channels', subCommand: 'status' },
  channels:    { command: 'channels', subCommand: 'status' },
  '通道顺序':   { command: 'channels', subCommand: 'order' },
  tongdaoshunxu: { command: 'channels', subCommand: 'order' },

  // ── 缓存 ──
  hc:        { command: 'cache', subCommand: 'clear' },
  huancun:   { command: 'cache', subCommand: 'clear' },
  '清缓存':  { command: 'cache', subCommand: 'clear' },

  // ── 菜单 ──
  cd:        { command: 'menu' },
  caidan:    { command: 'menu' },
  '菜单':    { command: 'menu' },

  // ── 帮助 ──
  bz:        { command: 'help' },
  bangzhu:   { command: 'help' },
  '帮助':    { command: 'help' },
  h:         { command: 'help' },
  'ai快速通道': { command: 'docs', subCommand: 'ai-fastlane' },
  'ai快通道':   { command: 'docs', subCommand: 'ai-fastlane' },
  'ai快捷通道': { command: 'docs', subCommand: 'ai-fastlane' },
  'ai快速通道复制': { command: 'docs', subCommand: 'ai-fastlane', defaultPositionals: ['copy'] },
  'ai快通道复制':   { command: 'docs', subCommand: 'ai-fastlane', defaultPositionals: ['copy'] },
  'ai快捷通道复制': { command: 'docs', subCommand: 'ai-fastlane', defaultPositionals: ['copy'] },
  aifastlane: { command: 'docs', subCommand: 'ai-fastlane' },
  aifastlanecopy: { command: 'docs', subCommand: 'ai-fastlane', defaultPositionals: ['copy'] },
  maintainer: { command: 'docs', subCommand: 'maintainer' },
  // 注意：`maintain` 是 canonical 命令（维护者驾驶舱，见 router case 'maintain'），
  // 不在此设别名，否则会劫持掉 canonical 分发。文档入口仍可经 maintainer/维护 到达。
  weihu: { command: 'docs', subCommand: 'maintainer' },
  '维护': { command: 'docs', subCommand: 'maintainer' },
  '维护入口': { command: 'docs', subCommand: 'maintainer' },
  '维护文档': { command: 'docs', subCommand: 'maintainer' },
  '维护指南': { command: 'docs', subCommand: 'maintainer' },

  // ── 退出 ──
  q:         { command: 'exit' },
  tuichu:    { command: 'exit' },
  '退出':    { command: 'exit' },

  // ── 清屏 ──
  cls:       { command: 'clear' },
  qp:        { command: 'clear' },
  qingping:  { command: 'clear' },
  '清屏':    { command: 'clear' },

  // ── 监控 ──
  jk:        { command: 'watch' },
  jiankong:  { command: 'watch' },
  '监控':    { command: 'watch' },
  watch:     { command: 'watch' },

  // ── 排行 ──
  ph:        { command: 'rank' },
  paihang:   { command: 'rank' },
  '排行':    { command: 'rank' },
  rank:      { command: 'rank' },
  top:       { command: 'rank' },

  // ── 搜索 ──
  ss:        { command: 'search' },
  sousuo:    { command: 'search' },
  '搜索':    { command: 'search' },
  find:      { command: 'search' },
  websearch: { command: 'search', subCommand: 'web' },
  '联网搜索': { command: 'search', subCommand: 'web' },

  // ── 网关 ──
  wg:        { command: 'gateway' },
  wangguan:  { command: 'gateway' },
  '网关':    { command: 'gateway' },
  apikey:    { command: 'gateway', subCommand: 'config' },
  '密钥配置': { command: 'gateway', subCommand: 'config' },
  '配置密钥': { command: 'gateway', subCommand: 'config' },
  guanli:    { command: 'gateway', subCommand: 'manage' },
  khyguanli: { command: 'gateway', subCommand: 'manage' },
  aiguanli:  { command: 'gateway', subCommand: 'manage' },
  'ai管理':  { command: 'gateway', subCommand: 'manage' },
  '管理页':  { command: 'gateway', subCommand: 'manage' },
  // The "manage" surface is really a frontend shell (chat + gateway UI), so the
  // primary launch verb is `khychat`. Legacy `khyguanli`/`guanli` aliases above
  // are kept for backward compatibility.
  khychat:   { command: 'gateway', subCommand: 'manage' },
  chat:      { command: 'gateway', subCommand: 'manage' },
  aichat:    { command: 'gateway', subCommand: 'manage' },
  'ai对话':  { command: 'gateway', subCommand: 'manage' },
  relay:     { command: 'gateway', subCommand: 'relay' },
  '中转':    { command: 'gateway', subCommand: 'relay' },
  zhongzhuan: { command: 'gateway', subCommand: 'relay' },
  '模型发现': { command: 'gateway', subCommand: 'discover-models' },
  modelscan: { command: 'gateway', subCommand: 'discover-models' },
  discovermodels: { command: 'gateway', subCommand: 'discover-models' },
  '密钥健康': { command: 'gateway', subCommand: 'key', defaultPositionals: ['health'] },
  keyhealth: { command: 'gateway', subCommand: 'key', defaultPositionals: ['health'] },
  '密钥轮换': { command: 'gateway', subCommand: 'key', defaultPositionals: ['rotate'] },
  keyrotate: { command: 'gateway', subCommand: 'key', defaultPositionals: ['rotate'] },

  // ── Cursor2API 集成 ──
  c2a:         { command: 'proxy', subCommand: 'cursor2api' },
  cursor2api:  { command: 'proxy', subCommand: 'cursor2api' },
  switchcenter: { command: 'proxy', subCommand: 'switch-center' },
  switch:       { command: 'proxy', subCommand: 'switch-center' },
  '统一切换':    { command: 'proxy', subCommand: 'switch-center' },
  '模型切换中心': { command: 'proxy', subCommand: 'switch-center' },
  traeswitch:  { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'trae' } },
  traeproxy:   { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'trae' } },
  'trae切换':  { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'trae' } },
  'trae代理':  { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'trae' } },
  windsurfswitch: { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'windsurf' } },
  windsurfproxy:  { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'windsurf' } },
  'windsurf切换': { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'windsurf' } },
  'windsurf代理': { command: 'proxy', subCommand: 'switch-center', defaultArgs: { provider: 'windsurf' } },
  nir:         { command: 'pool', subCommand: 'import', defaultPositionals: ['nirvana'] },
  nrv:         { command: 'pool', subCommand: 'import', defaultPositionals: ['nirvana'] },
  antigravity: { command: 'trae' },
  nirvana:     { command: 'trae' },
  fanzhongli:  { command: 'trae' },
  'api提取':   { command: 'proxy', subCommand: 'cursor2api' },
  '提取api':   { command: 'proxy', subCommand: 'cursor2api' },
  '代理帮助':   { command: 'proxy', subCommand: 'help' },
  '代理一键':   { command: 'proxy', subCommand: 'quickstart' },
  '一键代理':   { command: 'proxy', subCommand: 'quickstart' },
  '客户token': { command: 'proxy', subCommand: 'client' },
  '客户令牌':  { command: 'proxy', subCommand: 'client' },
  '代理订阅':  { command: 'proxy', subCommand: 'subscription' },
  'vpn订阅':   { command: 'proxy', subCommand: 'subscription' },
  'clash订阅': { command: 'proxy', subCommand: 'subscription' },
  '翻墙订阅':  { command: 'proxy', subCommand: 'subscription' },
  '梯子订阅':  { command: 'proxy', subCommand: 'subscription' },

  // ── 竞技场 ──
  jjc:        { command: 'arena' },
  jingji:     { command: 'arena' },
  '竞技场':   { command: 'arena' },
  '对比':     { command: 'arena' },
  duibi:      { command: 'arena' },

  // ── 初始化 ──
  '初始化':  { command: 'init' },
  chushihua: { command: 'init' },
  setup:     { command: 'init' },
  anzhuang:  { command: 'init' },
  '安装':    { command: 'init' },

  // ── 诊断 ──
  '诊断':    { command: 'doctor' },
  zhenduan:  { command: 'doctor' },
  check:     { command: 'doctor' },
  jiankang:  { command: 'doctor' },
  '健康':    { command: 'doctor' },
  doctorfix: { command: 'doctor', defaultArgs: { 'fix-claude-conflict': true } },
  docfix:    { command: 'doctor', defaultArgs: { 'fix-claude-conflict': true } },
  claudefix: { command: 'doctor', defaultArgs: { 'fix-claude-conflict': true } },
  fixclaude: { command: 'doctor', defaultArgs: { 'fix-claude-conflict': true } },
  'claude冲突修复': { command: 'doctor', defaultArgs: { 'fix-claude-conflict': true } },
  '修复claude冲突': { command: 'doctor', defaultArgs: { 'fix-claude-conflict': true } },

  // ── 发布 ──
  fabu:      { command: 'publish' },
  '发布':    { command: 'publish' },
  '发布检查': { command: 'publish', subCommand: 'check' },
  '构建发布': { command: 'publish', subCommand: 'build' },
  'docker发布': { command: 'publish', subCommand: 'docker-bundle' },
  '发布docker': { command: 'publish', subCommand: 'docker-bundle' },
  'pip打包': { command: 'publish', subCommand: 'pip-dir-bundle' },
  'pip目录打包': { command: 'publish', subCommand: 'pip-dir-bundle' },
  '发布pip目录': { command: 'publish', subCommand: 'pip-dir-bundle' },
  'npm打包': { command: 'publish', subCommand: 'npm-dir-bundle' },
  'npm目录打包': { command: 'publish', subCommand: 'npm-dir-bundle' },
  '发布npm目录': { command: 'publish', subCommand: 'npm-dir-bundle' },
  '源码还原': { command: 'publish', subCommand: 'origin-code' },
  '还原源码': { command: 'publish', subCommand: 'origin-code' },
  'origin还原': { command: 'publish', subCommand: 'origin-code' },
  '还原': { command: 'restore' },
  '完整还原': { command: 'restore' },
  '还原项目': { command: 'restore' },
  '同伴': { command: 'companion' },
  '数字同伴': { command: 'companion' },
  '智能体仓库': { command: 'companion' },
  '自修复': { command: 'publish', subCommand: 'self-fix' },
  '修bug': { command: 'publish', subCommand: 'self-fix' },
  '自动修复': { command: 'publish', subCommand: 'self-fix' },
  '自发布': { command: 'publish', subCommand: 'self-pypi' },
  '自测发布': { command: 'publish', subCommand: 'self-testpypi' },
  '推送发布': { command: 'publish', subCommand: 'git-push' },
  '发布推送': { command: 'publish', subCommand: 'git-push' },
  'git推送': { command: 'publish', subCommand: 'git-push' },
  '推送仓库': { command: 'publish', subCommand: 'git-push' },
  testpypi:  { command: 'publish', subCommand: 'testpypi' },

  // ── 稳定性工作流测试 ──
  '稳定测试': { command: 'verify', subCommand: 'workflow' },
  '工作流测试': { command: 'verify', subCommand: 'workflow' },
  liantongceshi: { command: 'verify', subCommand: 'workflow' },
  workflowtest: { command: 'verify', subCommand: 'workflow' },

  // ── 恢复上下文 ──
  huifu:     { command: 'history', subCommand: 'resume' },
  '恢复':    { command: 'history', subCommand: 'resume' },
  resume:    { command: 'history', subCommand: 'resume' },
  '上下文':  { command: 'history', subCommand: 'resume' },

  // ── 费用 ──
  feiyong:   { command: 'cost' },
  '费用':    { command: 'cost' },

  // ── 训练 ──
  xunlian:   { command: 'train' },
  '训练':    { command: 'train' },

  // ── 历史 ──
  lishi:     { command: 'history' },
  '历史':    { command: 'history', subCommand: 'list' },

  // ── 更新 ──
  gengxin:   { command: 'update' },
  '更新':    { command: 'update' },
  upgrade:   { command: 'update' },

  // ── 成长 ──
  cz:        { command: 'growth' },
  chengzhang: { command: 'growth' },
  '成长':    { command: 'growth' },
  '成长导出': { command: 'growth', subCommand: 'export' },
  '成长导入': { command: 'growth', subCommand: 'import' },

  // ── 智能体 ──
  znt:       { command: 'agent' },
  zhinengti: { command: 'agent' },
  '智能体':  { command: 'agent' },
  '智能体状态': { command: 'agent', subCommand: 'status' },

  // ── ULW Loop ──
  ulw:       { command: 'ulw-loop' },
  ultrawork: { command: 'ulw-loop' },
  ulwloop:   { command: 'ulw-loop' },
  '高强度循环': { command: 'ulw-loop' },
  '超强循环': { command: 'ulw-loop' },

  // ── 提示词 ──
  tsc:       { command: 'prompt' },
  tishici:   { command: 'prompt' },
  '提示词':  { command: 'prompt' },
  '保存提示词': { command: 'prompt', subCommand: 'save' },

  // ── 语音 ──
  yuyin:     { command: 'voice' },
  '语音':    { command: 'voice' },

  // ── 技能 ──
  jineng:    { command: 'skill' },
  '技能':    { command: 'skill', subCommand: 'list' },
  '学技能':  { command: 'skill', subCommand: 'learn' },
  '已学习':  { command: 'skill', subCommand: 'learned' },

  // ── 能力缺口 ──
  '能力缺口': { command: 'skill-gap' },
  nllq:       { command: 'skill-gap' },
  skillgap:   { command: 'skill-gap' },

  // ── 学习课程 ──
  '学习':    { command: 'learn' },
  xuexi:     { command: 'learn' },
  '教程':    { command: 'learn' },
  jiaocheng: { command: 'learn' },
  tutorial:  { command: 'learn' },
  '课程':    { command: 'learn' },
  kecheng:   { command: 'learn' },
  '学习进度': { command: 'learn', subCommand: 'progress' },
  '成长路线': { command: 'learn', subCommand: 'roadmap' },
  '修行之路': { command: 'learn', subCommand: 'roadmap' },
  '境界':    { command: 'learn', subCommand: 'rank' },
  '段位':    { command: 'learn', subCommand: 'rank' },
  '导出进度': { command: 'learn', subCommand: 'export' },
  '导入进度': { command: 'learn', subCommand: 'import' },
  '刷新课程': { command: 'learn', subCommand: 'refresh' },
  '同步课程': { command: 'learn', subCommand: 'refresh' },
  '下一课':  { command: 'learn', subCommand: 'next' },
  'Bug案例':  { command: 'learn', subCommand: 'bugs' },
  'bug案例':  { command: 'learn', subCommand: 'bugs' },
  'bug修复':  { command: 'learn', subCommand: 'bugs' },
  bugfix:     { command: 'learn', subCommand: 'bugs' },
  bugcases:   { command: 'learn', subCommand: 'bugs' },
  '学习笔记':  { command: 'learn', subCommand: 'note' },
  '学习记忆':  { command: 'learn', subCommand: 'memory' },
  '编辑课程':  { command: 'learn', subCommand: 'edit' },
  '课程校验':  { command: 'learn', subCommand: 'check' },
  '课程同步':  { command: 'learn', subCommand: 'sync' },
  '难度':    { command: 'learn', subCommand: 'level' },
  '档位':    { command: 'learn', subCommand: 'level' },
  nandu:     { command: 'learn', subCommand: 'level' },
  '零基础':  { command: 'learn', subCommand: 'level', defaultPositionals: ['beginner'] },
  '改进':    { command: 'learn', subCommand: 'improve' },
  '反馈':    { command: 'learn', subCommand: 'improve' },
  '记不足':  { command: 'learn', subCommand: 'improve' },
  gaijin:    { command: 'learn', subCommand: 'improve' },
  '改进清单': { command: 'learn', subCommand: 'improve', defaultPositionals: ['list'] },
  '技能策展': { command: 'skill', subCommand: 'curator' },
  '固定技能': { command: 'skill', subCommand: 'pin' },
  '归档技能': { command: 'skill', subCommand: 'archive' },
  '恢复技能': { command: 'skill', subCommand: 'restore' },

  // ── 定时任务 ──
  '定时任务': { command: 'cron', subCommand: 'list' },
  '定时':    { command: 'cron', subCommand: 'list' },
  dingshi:   { command: 'cron', subCommand: 'list' },
  '添加定时': { command: 'cron', subCommand: 'add' },
  '定时状态': { command: 'cron', subCommand: 'status' },

  // ── 主题 / 皮肤 ──
  '皮肤':    { command: 'skin', subCommand: 'list' },
  '主题':    { command: 'skin', subCommand: 'list' },
  pifu:      { command: 'skin', subCommand: 'list' },
  zhuti:     { command: 'skin', subCommand: 'list' },
  '切换主题': { command: 'skin', subCommand: 'set' },

  // ── 会话搜索 ──
  '会话搜索': { command: 'session', subCommand: 'search' },
  '搜索会话': { command: 'session', subCommand: 'search' },
  huihuasousuo: { command: 'session', subCommand: 'search' },
  '会话统计': { command: 'session', subCommand: 'stats' },

  // ── 习惯 ──
  xiguan:    { command: 'habit' },
  '习惯':    { command: 'habit' },
  '预测':    { command: 'habit', subCommand: 'predict' },

  // ── 知识库 ──
  zhishi:    { command: 'knowledge' },
  '知识':    { command: 'knowledge' },
  '知识库':  { command: 'knowledge' },
  '知识搜索': { command: 'knowledge', subCommand: 'search' },
  '知识同步': { command: 'knowledge', subCommand: 'sync' },
  kb:        { command: 'knowledge' },

  // ── 安全 ──
  anquan:    { command: 'security' },
  '安全':    { command: 'security' },
  '安全扫描': { command: 'security', subCommand: 'scan' },
  '安全监控': { command: 'security', subCommand: 'monitor' },

  // ── 认证 ──
  denglu:    { command: 'login' },
  '登录':    { command: 'login' },
  zhuce:     { command: 'register' },
  '注册':    { command: 'register' },
  '退出登录': { command: 'logout' },
  tuichudenglu: { command: 'logout' },
  '我是谁':  { command: 'whoami' },
  woshishui: { command: 'whoami' },
  '改密码':  { command: 'passwd' },
  gaimima:   { command: 'passwd' },
  '忘记密码': { command: 'forgot' },
  wangjimima: { command: 'forgot' },
  '找回密码': { command: 'forgot' },
  zhaohuimima: { command: 'forgot' },

  // ── 守护进程 ──
  '守护':    { command: 'daemon', subCommand: 'status' },
  '守护进程': { command: 'daemon', subCommand: 'status' },
  shouhu:    { command: 'daemon', subCommand: 'status' },
  '启动守护': { command: 'daemon', subCommand: 'start' },
  '停止守护': { command: 'daemon', subCommand: 'stop' },

  // ── 自我画像 ──
  '自知':    { command: 'self' },
  zizhi:     { command: 'self' },
  '画像':    { command: 'self' },
  huaxiang:  { command: 'self' },
  '我是谁系统': { command: 'self' },

  // ── 应用管理 ──
  '应用':    { command: 'app', subCommand: 'list' },
  yingyong:  { command: 'app', subCommand: 'list' },
  '安装应用': { command: 'app', subCommand: 'install' },
  '运行应用': { command: 'app', subCommand: 'run' },

  // ── CLI-Anything ──
  'cli生成':    { command: 'app', subCommand: 'cli-gen' },
  'cli搜索':    { command: 'app', subCommand: 'cli-search' },
  'cli安装':    { command: 'app', subCommand: 'cli-install' },
  'cli列表':    { command: 'app', subCommand: 'cli-list' },
  'cli卸载':    { command: 'app', subCommand: 'cli-uninstall' },
  'cli调用':    { command: 'app', subCommand: 'cli-invoke' },
  'cli同步':    { command: 'app', subCommand: 'cli-sync' },
  'cli导入':    { command: 'app', subCommand: 'cli-import' },
  'cli离线导入': { command: 'app', subCommand: 'cli-import' },
  cligen:       { command: 'app', subCommand: 'cli-gen' },
  clisearch:    { command: 'app', subCommand: 'cli-search' },
  cliinstall:   { command: 'app', subCommand: 'cli-install' },
  clilist:      { command: 'app', subCommand: 'cli-list' },
  '软件接入':    { command: 'app', subCommand: 'cli-gen' },
  '工具生成':    { command: 'app', subCommand: 'cli-gen' },
  'agent工具':   { command: 'app', subCommand: 'cli-list' },

  // ── KHYanything (即时代理接入；保留上方旧 cli-* 别名) ──
  '接入':       { command: 'app', subCommand: 'khy-add' },
  '代理接入':    { command: 'app', subCommand: 'khy-add' },
  'khy接入':    { command: 'app', subCommand: 'khy-add' },
  '项目接入':    { command: 'app', subCommand: 'khy-add' },
  khyadd:       { command: 'app', subCommand: 'khy-add' },
  'khy移除':    { command: 'app', subCommand: 'khy-remove' },
  khyremove:    { command: 'app', subCommand: 'khy-remove' },
  '代理列表':    { command: 'app', subCommand: 'khy-proxies' },
  khyproxies:   { command: 'app', subCommand: 'khy-proxies' },
  '代理运行':    { command: 'app', subCommand: 'khy-run' },
  khyrun:       { command: 'app', subCommand: 'khy-run' },
  'khy搜索':    { command: 'app', subCommand: 'khy-search' },
  'khy安装':    { command: 'app', subCommand: 'khy-install' },
  'khy卸载':    { command: 'app', subCommand: 'khy-uninstall' },
  'khy列表':    { command: 'app', subCommand: 'khy-list' },
  'khy同步':    { command: 'app', subCommand: 'khy-sync' },
  'khy导入':    { command: 'app', subCommand: 'khy-import' },
  'khy调用':    { command: 'app', subCommand: 'khy-invoke' },
  'khy生成':    { command: 'app', subCommand: 'khy-gen' },
  khysearch:    { command: 'app', subCommand: 'khy-search' },
  khyinstall:   { command: 'app', subCommand: 'khy-install' },
  khylist:      { command: 'app', subCommand: 'khy-list' },
  khygen:       { command: 'app', subCommand: 'khy-gen' },

  // ── 配置 ──
  '配置':    { command: 'config', subCommand: 'show' },
  peizhi:    { command: 'config', subCommand: 'show' },
  '查看配置': { command: 'config', subCommand: 'show' },
  '修改配置': { command: 'config', subCommand: 'set' },

  // ── 协调器 ──
  '协调':    { command: 'coordinator', subCommand: 'status' },
  xietiao:   { command: 'coordinator', subCommand: 'status' },
  '协调器':  { command: 'coordinator', subCommand: 'status' },
  '协调面板': { command: 'coordinator', subCommand: 'board' },

  // ── 远程 SSH ──
  '远程':    { command: 'remote', subCommand: 'hosts' },
  yuancheng: { command: 'remote', subCommand: 'hosts' },
  ssh:       { command: 'remote', subCommand: 'hosts' },
  '远程连接': { command: 'remote', subCommand: 'connect' },
  '远程执行': { command: 'remote', subCommand: 'exec' },
  '远程会话': { command: 'remote', subCommand: 'sessions' },

  // ── CC 名别名(claude-code-main(1).zip 对齐·EQUIVALENT 菜单补齐)──
  // 这些是 CC 用的命令名;khy 早有同义逻辑,只补别名让裸词 + /菜单都能分发。
  // 详见账本 [IMPL-RPT-040]。绝不另起 switch case —— 全部路由到既有 canonical。
  mode:               { command: 'persona' },                       // 行为预设
  'security-review':  { command: 'security', subCommand: 'scan' },  // 安全扫描
  'force-snip':       { command: 'snip' },                          // 手动裁剪近期消息
  skills:             { command: 'skill', subCommand: 'list' },     // 技能列表
  'skill-learning':   { command: 'skill', subCommand: 'learn' },    // 技能学习
  'skill-search':     { command: 'skill', subCommand: 'search' },   // 技能搜索
  'local-vault':      { command: 'vault' },                         // 本地密钥库
  'local-memory':     { command: 'memory' },                        // 本地记忆
  provider:           { command: 'gateway', subCommand: 'config' }, // AI 服务商配置
  'reload-plugins':   { command: 'plugin', subCommand: 'reload' },  // 重载插件
  'commit-push-pr':   { command: 'pr', subCommand: 'create' },      // git/gh 编排
  poor:               { command: 'effort', defaultPositionals: ['low'] }, // 低 token 档
  workflows:          { command: 'workflow' },                      // 工作流 CLI
  sandbox:            { command: 'sandbox-toggle' },                // 沙箱开关
};

/**
 * Resolve an alias to its canonical command.
 * @param {string} input - The raw command token
 * @returns {{ command: string, subCommand?: string, defaultArgs?: object, defaultPositionals?: string[] } | null}
 */
function resolveAlias(input) {
  if (!input) return null;
  // 自然语言短语守卫(门控 KHY_NL_ALIAS_GUARD 默认开):`我是谁` 这类完整问句应转发给 AI,
  // 不被别名劫持成命令面板。命中 → 返回 null,落到「未识别命令 → 转发 AI」路径。命令入口不受损
  // (拼音 woshishui / 显式 /whoami 仍解析)。门控关 → 恒 false,逐字节回退历史行为。绝不抛。
  try {
    const nlGuard = require('./naturalLanguageAliasGuard');
    if (nlGuard.isReservedNaturalLanguagePhrase(input)) return null;
  } catch { /* best-effort;守卫不可用则照常解析 */ }
  const key = input.toLowerCase();
  return ALIAS_MAP[key] || ALIAS_MAP[input] || null;
}

/**
 * Get all aliases for a canonical command (for help display).
 */
function getAliasesForCommand(canonicalCmd) {
  return Object.entries(ALIAS_MAP)
    .filter(([, v]) => v.command === canonicalCmd)
    .map(([k]) => k);
}

/**
 * Get all alias keys for auto-complete.
 */
function getAllAliasKeys() {
  return Object.keys(ALIAS_MAP);
}

module.exports = { resolveAlias, getAliasesForCommand, getAllAliasKeys, ALIAS_MAP };
