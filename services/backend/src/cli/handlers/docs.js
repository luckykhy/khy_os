/**
 * CLI Handlers for built-in documentation / tutorials.
 * Renders markdown docs directly in the terminal.
 */
const chalk = require('chalk').default || require('chalk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { printInfo, printSuccess } = require('../formatters');
const { getDataHome, getLegacyDataHome } = require('../../utils/dataHome');

const DOCS_DIR = path.resolve(__dirname, '../../../docs');
const BUNDLED_DOCS_DIR = path.resolve(__dirname, '../../bundled/docs');
const FASTLANE_DOC_REL_PATH = path.join('指南', 'ai-快速通道.md');
const MAINTAINER_MAP_REL_PATH = path.join('维护者', '维护映射表.json');

function getRepoRoot() {
  // forest layout: handlers/ -> cli -> src -> backend -> services -> repo root (mirrored in bundle)
  return path.resolve(__dirname, '../../../../../');
}

function getDocsDir() {
  if (fs.existsSync(DOCS_DIR)) return DOCS_DIR;
  if (fs.existsSync(BUNDLED_DOCS_DIR)) return BUNDLED_DOCS_DIR;
  return null;
}

function getFastlaneDocPath() {
  const candidates = [];
  const docsDir = getDocsDir();
  if (docsDir) candidates.push(path.join(docsDir, FASTLANE_DOC_REL_PATH));
  candidates.push(path.join(getRepoRoot(), 'docs', FASTLANE_DOC_REL_PATH));

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) return filePath;
    } catch {
      // try next
    }
  }
  return null;
}

function getMaintainerMapPath() {
  const candidates = [];
  const docsDir = getDocsDir();
  if (docsDir) candidates.push(path.join(docsDir, MAINTAINER_MAP_REL_PATH));
  candidates.push(path.join(getRepoRoot(), 'docs', MAINTAINER_MAP_REL_PATH));

  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) return filePath;
    } catch {
      // try next
    }
  }
  return null;
}

function getContributingPath() {
  const filePath = path.join(getRepoRoot(), 'CONTRIBUTING.md');
  try {
    return fs.existsSync(filePath) ? filePath : null;
  } catch {
    return null;
  }
}

function readMaintainerMap() {
  const filePath = getMaintainerMapPath();
  if (!filePath) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function buildAiFastlaneContextPack() {
  const repoRoot = path.resolve(__dirname, '../../../../../');
  const keyFiles = [
    'AGENTS.md',
    'README.md',
    'khy_platform/cli.py',
    'backend/bin/khy.js',
    'services/backend/src/cli/router.js',
    'services/backend/src/cli/handlers/gateway.js',
    'services/backend/src/services/aiManagementServer.js',
    'services/backend/scripts/ai-manage-daemon.js',
    'services/backend/src/services/changeRegressionGate.js',
    'services/backend/src/services/bugfixRegressionGate.js',
    'apps/ai-frontend/src/main.js',
    'apps/ai-frontend/src/router/index.js',
    'docs/07_OPS_运维/[OPS-MAN-001] ai-快速通道.md',
  ];

  const existingFiles = keyFiles.filter((relPath) => fs.existsSync(path.join(repoRoot, relPath)));
  const now = new Date().toISOString();

  const lines = [
    '# KHY AI Fast Lane Context Pack',
    '',
    `GeneratedAt: ${now}`,
    `RepoRoot: ${repoRoot}`,
    '',
    '## Mission',
    'Use this pack as the first read to understand KHY-OS quickly without full-repo scanning.',
    '',
    '## Architecture in 8 lines',
    '1. Entry command: `khy` (Python launcher in `platform/khy_platform/cli.py`).',
    '2. Core runtime: Node.js backend (`services/backend/`).',
    '3. CLI routing: `services/backend/src/cli/router.js` + per-command handlers.',
    '4. AI gateway orchestration: `services/backend/src/cli/handlers/gateway.js`.',
    '5. Management backend server: `services/backend/src/services/aiManagementServer.js`.',
    '6. Management daemon/session: `services/backend/scripts/ai-manage-daemon.js`.',
    '7. Management frontend: `apps/ai-frontend/` (Vue + Vite).',
    '8. Project-level constraints: `AGENTS.md` (must read first).',
    '',
    '## Mandatory Read Order',
    ...existingFiles.map((relPath, idx) => `${idx + 1}. ${relPath}`),
    '',
    '## Fast Task Routing',
    '- Command parse/dispatch issues -> `services/backend/src/cli/router.js`',
    '- AI provider/model/management page -> `services/backend/src/cli/handlers/gateway.js`',
    '- Admin API or websocket behavior -> `services/backend/src/services/aiManagementServer.js`',
    '- Management startup/timeout/auto-shutdown -> `services/backend/scripts/ai-manage-daemon.js`',
    '- Low-tier model change regressions -> `services/backend/src/services/changeRegressionGate.js` (legacy compatibility: `bugfixRegressionGate.js`)',
    '- Management page routing/session bridge -> `apps/ai-frontend/src/main.js`, `apps/ai-frontend/src/router/index.js`',
    '',
    '## Handoff Prompt Template',
    '```text',
    'You are maintaining KHY-OS.',
    'Read files in this order first, then propose and implement the minimal patch:',
    ...existingFiles.map((relPath, idx) => `${idx + 1}) ${relPath}`),
    'Constraints:',
    '- Follow AGENTS.md rules',
    '- Keep behavior backward compatible',
    '- Include verification commands and expected output',
    '```',
    '',
  ];

  return `${lines.join('\n')}\n`;
}

function writeAiFastlaneContextPack() {
  const fileName = 'ai_fastlane_context.md';
  const payload = buildAiFastlaneContextPack();
  const repoRoot = getRepoRoot();
  const targets = Array.from(new Set([
    path.join(getDataHome(), fileName),
    path.join(getLegacyDataHome(), fileName),
    path.join(repoRoot, '.khy-runtime', fileName),
    path.join(os.tmpdir(), fileName),
  ]));
  const written = [];

  for (const filePath of targets) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, payload, 'utf-8');
      written.push(filePath);
    } catch {
      // best effort write for each data-home location
    }
  }
  return written;
}

function copyTextToClipboard(text) {
  try {
    const clipboardRelayAdapter = require('../../services/gateway/adapters/clipboardRelayAdapter');
    if (!clipboardRelayAdapter || typeof clipboardRelayAdapter.writeClipboard !== 'function') {
      throw new Error('clipboard writer unavailable');
    }
    clipboardRelayAdapter.writeClipboard(String(text || ''));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err || '') };
  }
}

function isTruthy(value) {
  // 布尔解析走 parseBoolean 单一真源（base tier；含 boolean 直通）。
  return require('../../utils/parseBoolean')(value, false, { extended: false });
}

/**
 * Render a markdown file as terminal-friendly output.
 */
function renderMarkdown(content) {
  const lines = content.split('\n');
  const output = [];

  for (const line of lines) {
    if (line.startsWith('# ')) {
      output.push('');
      output.push(chalk.cyan.bold('  ' + line.slice(2)));
      output.push(chalk.dim('  ' + '─'.repeat(50)));
    } else if (line.startsWith('## ')) {
      output.push('');
      output.push(chalk.yellow.bold('  ' + line.slice(3)));
    } else if (line.startsWith('### ')) {
      output.push(chalk.green('  ' + line.slice(4)));
    } else if (line.startsWith('```')) {
      output.push(chalk.dim('  ┄┄┄'));
    } else if (line.startsWith('- ')) {
      output.push('  ' + chalk.dim('•') + ' ' + line.slice(2));
    } else if (line.startsWith('> ')) {
      output.push(chalk.dim('  │ ') + chalk.italic(line.slice(2)));
    } else if (line.trim() === '') {
      output.push('');
    } else {
      output.push('  ' + line);
    }
  }

  return output.join('\n');
}

async function handleDocsQuickstart() {
  console.log('');
  console.log(chalk.cyan.bold('  🚀 khy OS 快速开始'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  console.log('  ' + chalk.bold('5 分钟上手：'));
  console.log('');
  console.log('  ' + chalk.green('Step 1') + ' — 查询行情:');
  console.log(chalk.dim('    $ khy hq 茅台'));
  console.log(chalk.dim('    $ khy hq sh000300'));
  console.log('');
  console.log('  ' + chalk.green('Step 2') + ' — 与 AI 对话:');
  console.log(chalk.dim('    $ khy'));
  console.log(chalk.dim('    ◉ khy ❯ 分析一下沪深300最近的走势'));
  console.log('');
  console.log('  ' + chalk.green('Step 3') + ' — 策略回测:');
  console.log(chalk.dim('    $ khy bt sh000300 --strategy 1'));
  console.log('');
  console.log('  ' + chalk.green('Step 4') + ' — 网关配置 (选择 AI 通道):');
  console.log(chalk.dim('    $ khy gateway model'));
  console.log('');
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  console.log('  ' + chalk.bold('常用命令:'));
  console.log('');
  console.log('  ' + chalk.cyan('hq <代码|名称>') + '  查询实时行情');
  console.log('  ' + chalk.cyan('bt <代码>') + '       快速回测');
  console.log('  ' + chalk.cyan('menu') + '            打开交互式菜单');
  console.log('  ' + chalk.cyan('gateway model') + '   选择 AI 模型');
  console.log('  ' + chalk.cyan('doctor') + '          环境诊断');
  console.log('  ' + chalk.cyan('docs maintainer') + '  查看仓库维护入口');
  console.log('  ' + chalk.cyan('help') + '            查看全部命令');
  console.log('');
  console.log(chalk.dim('  💡 提示: 直接输入中文问题，AI 会理解并执行'));
  console.log('');
}

async function handleDocsAiFastlane(args = [], options = {}) {
  const action = String(args[0] || '').trim().toLowerCase();
  const shouldCopy = action === 'copy'
    || action === 'clipboard'
    || action === 'cp'
    || isTruthy(options.copy);
  const packContent = buildAiFastlaneContextPack();
  const written = writeAiFastlaneContextPack();

  console.log('');
  console.log(chalk.cyan.bold('  ⚡ KHY AI 快速通道'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  if (shouldCopy) {
    const copied = copyTextToClipboard(packContent);
    if (copied.ok) {
      printSuccess(`已复制 AI 上下文包到系统剪贴板（${packContent.length} 字符）`);
    } else {
      printInfo(`复制到系统剪贴板失败: ${copied.error}`);
      printInfo('可改用: khy docs ai-fastlane  查看并手动复制。');
    }
    if (written.length > 0) {
      printInfo('已同时写入本地上下文包文件:');
      for (const filePath of written) {
        console.log(chalk.dim(`  ${filePath}`));
      }
    } else {
      printInfo('上下文包写入失败，请检查数据目录写权限。');
    }
    console.log('');
    return;
  }

  const fastlaneDocPath = getFastlaneDocPath();
  if (fastlaneDocPath) {
    const content = fs.readFileSync(fastlaneDocPath, 'utf-8');
    console.log(renderMarkdown(content));
    console.log('');
    printInfo(`项目快速通道文档: ${fastlaneDocPath}`);
  } else {
    printInfo('未找到项目快速通道文档（docs/07_OPS_运维/[OPS-MAN-001] ai-快速通道.md）。');
  }

  if (written.length > 0) {
    printSuccess('已生成可直接交给 AI 的上下文包:');
    for (const filePath of written) {
      console.log(chalk.dim(`  ${filePath}`));
    }
    console.log('');
    printInfo('一键复制: khy docs ai-fastlane copy');
    printInfo('交接方式: 把上述文件内容贴给 AI，再让 AI 执行具体任务。');
  } else {
    printInfo('上下文包写入失败，请检查数据目录写权限。');
  }
  console.log('');
}

async function handleDocsClaude() {
  const docsDir = getDocsDir();
  if (!docsDir) {
    printInfo('教程文件未安装。请使用完整版: pip install "khy-os[all]"');
    return;
  }

  const claudeDir = path.join(docsDir, 'claude-code');
  if (!fs.existsSync(claudeDir)) {
    printInfo('Claude Code 教程文件未找到');
    return;
  }

  const files = fs.readdirSync(claudeDir)
    .filter(f => f.endsWith('.md'))
    .sort();

  const { promptCompat } = require('../uiPrompt');
  const { doc } = await promptCompat([{
    type: 'list',
    name: 'doc',
    message: '选择教程:',
    choices: [
      ...files.map(f => ({
        name: f.replace('.md', '').replace(/^\d+-/, ''),
        value: f,
      })),
      { name: '↩️  返回', value: 'back' },
    ],
  }]);

  if (!doc || doc === 'back') return;

  const content = fs.readFileSync(path.join(claudeDir, doc), 'utf-8');
  // Show first 80 lines as preview. Route through ccTruncateLines so the cut is
  // never silent — a 500-line doc shown as 80 must carry an honest "… +N 行"
  // marker (CC truncateToLines parity). Gate off → byte-identical legacy slice.
  const preview = require('../ccTruncateLines').truncatePreview(content, 80, process.env);
  console.log(renderMarkdown(preview));
  console.log('');
  printInfo(`完整文档: ${path.join(claudeDir, doc)}`);
  console.log('');
}

async function handleDocsGateway() {
  console.log('');
  console.log(chalk.cyan.bold('  🌐 AI 网关使用指南'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  console.log('  khy OS 支持多种 AI 通道，按优先级自动选择:');
  console.log('');
  console.log('  ' + chalk.bold('通道优先级 (从高到低):'));
  console.log('  ' + chalk.green('1.') + ' CLI 工具桥接 — 复用已登录的 Claude/Codex');
  console.log('  ' + chalk.green('2.') + ' Kiro IDE — Amazon Q Developer (免费)');
  console.log('  ' + chalk.green('3.') + ' Cursor IDE — 复用 Cursor 订阅');
  console.log('  ' + chalk.green('4.') + ' Claude Code — 复用 Claude 订阅');
  console.log('  ' + chalk.green('5.') + ' Ollama 本地 — 完全离线，无需API密钥');
  console.log('  ' + chalk.green('6.') + ' API 云端 — 需配置密钥');
  console.log('  ' + chalk.green('7.') + ' Web 中转 — 手动复制粘贴到网页AI');
  console.log('');
  console.log('  ' + chalk.bold('通用扩展:'));
  console.log(chalk.dim('    CLIPBOARD_RELAY_EXTRA_SERVICES="myrelay|My Relay|https://example.com/chat,foo=https://foo.ai"'));
  console.log(chalk.dim('    RELAY_API_MODELS="gpt-4.1,claude-sonnet-4-6,deepseek-chat"'));
  console.log(chalk.dim('    GATEWAY_EXTRA_IDES="myide" + MYIDE_INSTALL_PATH/MYIDE_DATA_PATH'));
  console.log('');
  console.log('  ' + chalk.bold('配置方法:'));
  console.log(chalk.dim('    khy gateway status    查看所有通道状态'));
  console.log(chalk.dim('    khy gateway model     选择使用哪个模型'));
  console.log(chalk.dim('    khy gateway prefer-remote 一键切换到可用 API/桥接通道'));
  console.log(chalk.dim('    khy gateway config    配置参数'));
  console.log(chalk.dim('    khy gateway relay     启动 Web 中转'));
  console.log(chalk.dim('    khy gateway discover-models 自动发现本机模型并更新 RELAY_API_MODELS'));
  console.log('');
  console.log('  ' + chalk.bold('高级策略配置 (支持国内外多供应商/多渠道):'));
  console.log(chalk.dim('    gateway config → 高级: 模型路由规则'));
  console.log(chalk.dim('      GATEWAY_MODEL_ROUTE_MAP={\"gpt-4o-mini\":\"api/openai:gpt-4o-mini\",\"claude-*\":{\"target\":\"kiro/claude-sonnet-4\",\"strict\":true}}'));
  console.log(chalk.dim('      GATEWAY_MODEL_ROUTE_STRICT=false'));
  console.log(chalk.dim('    gateway config → 高级: Key 选择策略'));
  console.log(chalk.dim('      GATEWAY_KEY_SELECTION_STRATEGY=hybrid'));
  console.log(chalk.dim('      GATEWAY_KEY_SELECTION_STRATEGY_MAP={\"relay\":\"least-used\",\"openai\":\"least-fail\"}'));
  console.log(chalk.dim('    gateway config → 高级: API 池默认 provider'));
  console.log(chalk.dim('      GATEWAY_API_POOL_PROVIDER=deepseek'));
  console.log(chalk.dim('    gateway config → 高级: 供应商映射'));
  console.log(chalk.dim('      GATEWAY_API_POOL_PROVIDER_ALIAS_MAP={\"openai-sb\":\"openai\",\"myqwen\":\"qwen\"}'));
  console.log(chalk.dim('      GATEWAY_API_POOL_SERVICE_MAP={\"deepseek\":\"openai\",\"qwen\":\"alibaba\",\"glm\":\"zhipu\",\"relay\":\"openai\"}'));
  console.log(chalk.dim('      GATEWAY_API_POOL_DEFAULT_MODEL_MAP={\"deepseek\":\"deepseek-chat\",\"qwen\":\"qwen-plus\"}'));
  console.log('');
  console.log('  ' + chalk.bold('Ollama 本地部署 (推荐):'));
  console.log(chalk.dim('    1. 安装 Ollama: https://ollama.com'));
  console.log(chalk.dim('    2. 拉取模型: ollama pull qwen2.5:7b'));
  console.log(chalk.dim('    3. 导入本地模型: models import <path> [name] [--base qwen2.5:7b]'));
  console.log(chalk.dim('    3. 重启 khy，自动检测'));
  console.log('');
}

async function handleDocsStrategy() {
  console.log('');
  console.log(chalk.cyan.bold('  📊 量化策略入门'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  console.log('  ' + chalk.bold('内置策略:'));
  console.log('');
  console.log('  ' + chalk.green('1.') + ' 双均线交叉 — MA5/MA20 金叉死叉');
  console.log('  ' + chalk.green('2.') + ' RSI 超买超卖 — RSI > 70 卖 / RSI < 30 买');
  console.log('  ' + chalk.green('3.') + ' MACD 信号 — MACD 金叉做多');
  console.log('  ' + chalk.green('4.') + ' 布林带突破 — 突破上/下轨交易');
  console.log('  ' + chalk.green('5.') + ' ML 机器学习 — 基于 XGBoost 预测');
  console.log('');
  console.log('  ' + chalk.bold('回测示例:'));
  console.log(chalk.dim('    khy bt sh000300 --strategy 1 --start 2024-01-01'));
  console.log(chalk.dim('    khy bt sh600519 --strategy 3 --capital 200000'));
  console.log('');
  console.log('  ' + chalk.bold('指标说明:'));
  console.log('  • ' + chalk.yellow('年化收益率') + ' — 策略的年化投资回报');
  console.log('  • ' + chalk.yellow('夏普比率') + ' — 每承受1单位风险获得的超额收益');
  console.log('  • ' + chalk.yellow('最大回撤') + ' — 净值从最高点的最大跌幅');
  console.log('  • ' + chalk.yellow('胜率') + ' — 盈利交易占总交易数的比例');
  console.log('');
}

async function handleDocsFaq() {
  console.log('');
  console.log(chalk.cyan.bold('  🔧 常见问题 FAQ'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  console.log(chalk.bold('  Q: 安装时报 "WinError 5 拒绝访问"?'));
  console.log(chalk.dim('  A: Windows 文件被占用。解决方法:'));
  console.log(chalk.dim('     1. 关闭所有 Python 进程: taskkill /F /IM python.exe'));
  console.log(chalk.dim('     2. 关闭 VSCode / Jupyter'));
  console.log(chalk.dim('     3. 以管理员身份运行 PowerShell'));
  console.log(chalk.dim('     4. 或使用: pip install --user khy-os'));
  console.log('');
  console.log(chalk.bold('  Q: 行情显示乱码?'));
  console.log(chalk.dim('  A: Windows 终端编码问题。运行:'));
  console.log(chalk.dim('     chcp 65001'));
  console.log(chalk.dim('     或使用 Windows Terminal (推荐)'));
  console.log('');
  console.log(chalk.bold('  Q: AI 不回复?'));
  console.log(chalk.dim('  A: 检查网关状态: khy gateway status'));
  console.log(chalk.dim('     优先使用 Ollama 本地模型 (无需网络)'));
  console.log(chalk.dim('     或启动 Web 中转: khy gateway relay'));
  console.log('');
  console.log(chalk.bold('  Q: 如何升级?'));
  console.log(chalk.dim('  A: pip install --upgrade khy-os --no-cache-dir'));
  console.log(chalk.dim('     兼容旧包名: pip install --upgrade khy-quant --no-cache-dir'));
  console.log(chalk.dim('     如遇权限问题加 --user'));
  console.log('');
  console.log(chalk.bold('  Q: 如何配置 API 密钥?'));
  console.log(chalk.dim('  A: 运行 ai config，按提示输入密钥'));
  console.log(chalk.dim('     或直接设置环境变量: OPENAI_API_KEY=sk-xxx'));
  console.log('');
}

async function handleDocsSubscription() {
  console.log('');
  console.log(chalk.cyan.bold('  💳 AI 模型订阅与获取指南'));
  console.log(chalk.dim('  ' + '─'.repeat(55)));
  console.log('');
  console.log(chalk.bold.green('  🆓 免费方案 (国内直接可用):'));
  console.log('');
  console.log('  ' + chalk.green('1.') + chalk.bold(' Kiro IDE') + ' — 免费 Claude 4 Sonnet 额度');
  console.log(chalk.dim('     下载: https://kiro.dev'));
  console.log(chalk.dim('     安装后登录 Amazon 账号即可使用'));
  console.log(chalk.dim('     运行: khy gateway model → 选择 Kiro'));
  console.log('');
  console.log('  ' + chalk.green('2.') + chalk.bold(' Trae IDE') + ' — 免费 Claude/GPT 额度 (字节跳动)');
  console.log(chalk.dim('     下载: https://trae.ai'));
  console.log(chalk.dim('     国内直连，支持 doubao-1.5-pro / Claude / GPT'));
  console.log('');
  console.log('  ' + chalk.green('3.') + chalk.bold(' Ollama 本地模型') + ' — 完全离线，无需 API');
  console.log(chalk.dim('     安装: https://ollama.com'));
  console.log(chalk.dim('     推荐模型: ollama pull qwen2.5:7b'));
  console.log(chalk.dim('     高配推荐: ollama pull qwen2.5:32b'));
  console.log('');
  console.log(chalk.bold.yellow('  💰 付费订阅 (需代理/VPN):'));
  console.log('');
  console.log('  ' + chalk.yellow('4.') + chalk.bold(' Claude (Anthropic)'));
  console.log(chalk.dim('     订阅: https://claude.ai/pricing'));
  console.log(chalk.dim('     Pro $20/月, 安装 Claude Code CLI 后复用额度'));
  console.log(chalk.dim('     运行: npm i -g @anthropic-ai/claude-code && claude'));
  console.log('');
  console.log('  ' + chalk.yellow('5.') + chalk.bold(' OpenAI / Codex'));
  console.log(chalk.dim('     订阅: https://platform.openai.com'));
  console.log(chalk.dim('     安装 Codex CLI: npm i -g @openai/codex && codex'));
  console.log('');
  console.log('  ' + chalk.yellow('6.') + chalk.bold(' Cursor IDE'));
  console.log(chalk.dim('     订阅: https://cursor.com/pricing'));
  console.log(chalk.dim('     Pro $20/月，含 Claude/GPT 额度'));
  console.log('');
  console.log(chalk.bold.cyan('  🇨🇳 国内直连 API (无需代理):'));
  console.log('');
  console.log('  ' + chalk.cyan('7.') + chalk.bold(' 智谱AI (GLM)'));
  console.log(chalk.dim('     注册: https://open.bigmodel.cn'));
  console.log(chalk.dim('     运行: ai config → 输入 API 密钥'));
  console.log('');
  console.log('  ' + chalk.cyan('8.') + chalk.bold(' 通义千问 (阿里云)'));
  console.log(chalk.dim('     注册: https://dashscope.aliyun.com'));
  console.log('');
  console.log('  ' + chalk.cyan('9.') + chalk.bold(' DeepSeek'));
  console.log(chalk.dim('     注册: https://platform.deepseek.com'));
  console.log('');
  console.log(chalk.bold('  🌐 代理配置 (中国大陆访问海外 AI):'));
  console.log(chalk.dim('     运行 /proxy 自动检测 Clash 代理'));
  console.log(chalk.dim('     支持 HTTP/SOCKS5 手动配置'));
  console.log(chalk.dim('     配置后 Claude/OpenAI/Cursor 均可正常使用'));
  console.log('');
  console.log(chalk.bold.magenta('  🔗 API 中转渠道 (国内直连 Claude/GPT):'));
  console.log('');
  console.log('  ' + chalk.magenta('10.') + chalk.bold(' AWS Bedrock 中转'));
  console.log(chalk.dim('      通过 AWS 中国区或亚太区 Lambda/API Gateway 访问'));
  console.log(chalk.dim('      需要 AWS 账号 + Bedrock 模型权限'));
  console.log(chalk.dim('      注册: https://aws.amazon.com/cn/bedrock'));
  console.log('');
  console.log('  ' + chalk.magenta('11.') + chalk.bold(' 第三方中转站'));
  console.log(chalk.dim('      国内直连，按 token 计费，无需代理'));
  console.log(chalk.dim('      常见: OpenAI-SB, API2D, OhMyGPT, CloseAI 等'));
  console.log(chalk.dim('      配置: gateway config → 设置中转地址和密钥'));
  console.log('');
  console.log('  ' + chalk.magenta('12.') + chalk.bold(' 自建 VPS / Cloudflare Workers 反代'));
  console.log(chalk.dim('      购买海外 VPS (Vultr/DigitalOcean $5/月起)'));
  console.log(chalk.dim('      或使用 Cloudflare Workers 免费套餐'));
  console.log(chalk.dim('      反代 api.anthropic.com / api.openai.com'));
  console.log('');
  console.log(chalk.bold('  ⚙ 中转配置方法:'));
  console.log(chalk.dim('     gateway config → 选择 "API 中转"'));
  console.log(chalk.dim('     或设置环境变量:'));
  console.log(chalk.dim('       RELAY_API_ENDPOINT=https://your-relay.com/v1'));
  console.log(chalk.dim('       RELAY_API_KEY=sk-xxx'));
  console.log(chalk.dim('       RELAY_API_MODEL=claude-sonnet-4-20250514'));
  console.log('');
}

async function handleDocsMaintainer() {
  const map = readMaintainerMap();
  const contributingPath = getContributingPath();

  console.log('');
  console.log(chalk.cyan.bold('  🛠 仓库维护入口'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));
  console.log('');
  console.log('  目标: 让小白人工、小模型、大模型都能按同一套入口维护 KHY-OS。');
  console.log('');
  console.log('  ' + chalk.bold('首读入口:'));
  if (contributingPath) {
    console.log(chalk.dim(`    ${contributingPath}`));
  } else {
    console.log(chalk.dim('    CONTRIBUTING.md 未找到，请检查仓库完整性'));
  }
  if (getMaintainerMapPath()) {
    console.log(chalk.dim(`    ${getMaintainerMapPath()}`));
  }
  console.log('');
  console.log('  ' + chalk.bold('一键健康自检（单人维护者首选）:'));
  console.log(chalk.dim('    khy maintain          # 驾驶舱：元数据/架构债/基建裸奔/版本 一条命令看全 + 唯一下一步（红则退码1）'));
  console.log(chalk.dim('    khy maintain audit    # 展开本次改动文件的公共面缺口明细'));
  console.log('');
  console.log('  ' + chalk.bold('直接可执行命令:'));
  console.log(chalk.dim('    khy docs maintainer'));
  console.log(chalk.dim('    npm run maintainer:map'));
  console.log(chalk.dim('    npm run maintainer:check'));
  console.log(chalk.dim('    npm run check:maintainer:bootstrap'));
  console.log(chalk.dim('    npm run check:maintainer:safety'));
  console.log('');
  console.log('  ' + chalk.bold('分层最小回归:'));
  console.log(chalk.dim('    npm run test:maintainer:cli-routing'));
  console.log(chalk.dim('    npm run test:maintainer:gateway'));
  console.log(chalk.dim('    npm run test:maintainer:runtime'));
  console.log(chalk.dim('    npm run test:maintainer:ai-management'));
  console.log(chalk.dim('    npm run test:maintainer:publish'));
  console.log('');

  if (map && Array.isArray(map.startupFlow) && map.startupFlow.length > 0) {
    console.log('  ' + chalk.bold('启动链路:'));
    map.startupFlow.forEach((step) => {
      console.log(chalk.dim(`    ${step.order}. ${step.path}`));
    });
    console.log('');
  }

  if (map && Array.isArray(map.areas) && map.areas.length > 0) {
    console.log('  ' + chalk.bold('维护领域:'));
    map.areas.forEach((area) => {
      const summary = Array.isArray(area.whenToUse) && area.whenToUse.length > 0
        ? area.whenToUse[0]
        : '查看该领域入口文件';
      console.log(`    ${chalk.white(area.id.padEnd(26))} ${chalk.dim(area.label)} ${chalk.dim(`— ${summary}`)}`);
    });
    console.log('');
    printInfo('查看单个领域: npm run maintainer:map -- --area cli-routing');
  } else {
    printInfo('未找到维护地图 JSON，已回退到静态维护入口。');
  }

  printInfo('推荐顺序: 先看 CONTRIBUTING.md，再按 docs/维护者/维护映射表.json 选领域，再跑对应最小验证命令。');
  console.log('');
}

/**
 * `khy docs check`(别名 `docs freshness`)—— 文档新鲜度自检。
 *
 * 诉求:代码常更新,文档不能及时跟上 → 改了源码后提示「哪些文档可能过时,请复核」,
 * 并可选自动重生成产物(Layer 2)、按标记同步内嵌值(Layer 3)、AI 出改稿建议(Layer 4,--ai)。
 *
 * 选项:
 *   --fix        写盘(重生成产物 + 标记同步)并 re-stage;不加只报不写。
 *   --staged     只看已暂存改动(pre-commit hook 用)。
 *   --ci         有过时嫌疑 → 非零退出(同 KHY_DOCS_FRESHNESS_BLOCK=1)。
 *   --verbose    额外列出未匹配到文档的源码变更。
 *   --ai         对高置信嫌疑生成改稿建议(需 KHY_DOCS_AI_SUGGEST=1;绝不自动落地)。
 *
 * warn-only:默认只提示不阻断(fail-soft)。CI 门禁才非零退出。
 */
async function handleDocsFreshness(args, options = {}) {
  const opts = options || {};
  const flags = new Set(Array.isArray(args) ? args : []);
  const has = (name) => opts[name] === true || flags.has(`--${name}`);

  const repoRoot = getRepoRoot();
  let runner;
  try {
    runner = require('../../services/docsFreshness/docsFreshnessRunner');
  } catch (e) {
    printInfo('文档新鲜度模块不可用(源码树可能不完整): ' + ((e && e.message) || e));
    return;
  }

  const result = runner.runDocsFreshness(repoRoot, {
    staged: has('staged'),
    fix: has('fix'),
    env: process.env,
  });

  console.log('');
  console.log(chalk.cyan.bold('  📄 文档新鲜度自检'));
  console.log(chalk.dim('  ' + '─'.repeat(50)));

  if (!result.ran) {
    printInfo('未运行(门控 KHY_DOCS_FRESHNESS 关闭,或无可检项)。');
    console.log('');
    return;
  }

  const changedN = (result.changedSources || []).length;
  if (changedN === 0) {
    printSuccess('本次没有源码改动,无需复核文档。');
    console.log('');
    return;
  }

  const suspects = result.suspects || [];
  if (suspects.length === 0) {
    printSuccess(`检测到 ${changedN} 处源码改动,未发现引用它们的文档(无过时嫌疑)。`);
  } else {
    console.log('');
    console.log(`  检测到 ${changedN} 处源码改动,以下 ${chalk.bold(suspects.length)} 篇文档可能过时,请复核:`);
    console.log('');
    for (const s of suspects) {
      const badge = s.confidence === 'exact' ? chalk.yellow('● 高') : chalk.dim('○ 低');
      console.log(`   ${badge}  ${chalk.white(s.doc)}`);
      const srcs = (s.matchedSources || []).slice(0, 4).join(', ');
      if (srcs) console.log(chalk.dim(`         触发: ${srcs}${s.matchedSources.length > 4 ? ' …' : ''}`));
    }
  }

  // 修复动作汇报。
  const prod = result.productActions || [];
  const mark = result.markerActions || [];
  if (has('fix')) {
    const okProd = prod.filter((a) => a.ok);
    const okMark = mark.filter((a) => a.ok);
    if (okProd.length) console.log(chalk.dim(`   ↻ 重生成产物: ${okProd.map((a) => a.rel).join(', ')}`));
    if (okMark.length) console.log(chalk.dim(`   ↻ 同步标记值: ${okMark.map((a) => a.rel).join(', ')}`));
    if ((result.restaged || []).length) console.log(chalk.dim(`   ✚ 已 re-stage ${result.restaged.length} 个文件`));
  } else if (suspects.length) {
    console.log('');
    printInfo('这是提醒,不阻断。要同时重生成产物/同步标记值: khy docs check --fix');
  }

  // --verbose:未匹配到文档的源码变更。
  if (has('verbose') && (result.unmatchedChanges || []).length) {
    console.log('');
    console.log(chalk.dim(`  未匹配到文档的源码变更(${result.unmatchedChanges.length}):`));
    for (const u of result.unmatchedChanges.slice(0, 20)) console.log(chalk.dim(`     · ${u}`));
  }

  // --ai:AI 改稿建议(门控默认关,绝不自动落地)。
  if (has('ai')) {
    try {
      const draft = require('../../services/docsFreshness/docSuggestDraft');
      if (!draft.docSuggestEnabled(process.env)) {
        printInfo('AI 建议未启用(设 KHY_DOCS_AI_SUGGEST=1 开启;仅出草稿,绝不自动改文档)。');
      } else {
        printInfo('AI 建议为 opt-in 草稿功能,已生成提示词模板,具体接入见 handler --ai 分支。');
      }
    } catch {
      printInfo('AI 建议模块不可用。');
    }
  }

  // CI 门禁:有嫌疑 → 非零退出。
  const blockEnv = ['1', 'true', 'on', 'yes'].includes(String(process.env.KHY_DOCS_FRESHNESS_BLOCK || '').trim().toLowerCase());
  if ((has('ci') || blockEnv) && suspects.length > 0) {
    process.exitCode = 1;
    console.log('');
    console.log(chalk.yellow('  ⚠ CI 门禁:存在过时嫌疑,以非零退出(--ci / KHY_DOCS_FRESHNESS_BLOCK)。'));
  }
  console.log('');
}

module.exports = {
  handleDocsQuickstart,
  handleDocsAiFastlane,
  handleDocsMaintainer,
  handleDocsClaude,
  handleDocsGateway,
  handleDocsStrategy,
  handleDocsFaq,
  handleDocsSubscription,
  handleDocsFreshness,
};
