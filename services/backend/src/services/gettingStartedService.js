/**
 * Getting Started Service — generates first-run guide with promotional content.
 *
 * Creates ~/.khyquant/GETTING_STARTED.md on first run after pip install,
 * and displays a welcome banner in the REPL.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const KHY_DIR = path.join(os.homedir(), '.khyquant');
const GUIDE_PATH = path.join(KHY_DIR, 'GETTING_STARTED.md');
const SHOWN_MARKER = path.join(KHY_DIR, '.getting_started_shown');

/**
 * Generate the getting-started guide markdown file.
 */
function generateGettingStarted() {
  try { fs.mkdirSync(KHY_DIR, { recursive: true }); } catch { /* exists */ }

  const version = process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version;

  const content = `# khy OS v${version} — AI Platform Operating System Terminal

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 国内首个 Claude Code 风格 AI 量化分析框架终端

khy OS 是面向中文开发者的 AI 平台操作系统，内置默认应用 khyquant（量化能力），
并集成多模型 AI 网关、Agentic 工作流、策略引擎与专业级回测系统。

### 核心特性

| 特性 | 说明 |
|------|------|
| 🤖 多模型 AI 网关 | Kiro / Cursor / Claude / Codex / Windsurf / VSCode / Ollama / 云 API |
| 📊 实时数据 | AkShare + TuShare A 股实时行情、资金流、基本面 |
| 🧪 专业回测 | 多策略对比、滑点模拟、佣金计算、最大回撤分析 |
| 🧠 多智能体 | 基本面/技术面/新闻/风控/策略 5 角色协作分析 |
| 🖼️ 图片分析 | 终端内粘贴图片，AI 视觉分析走势图 |
| 📋 计划模式 | 复杂任务自动分解 → 用户审批 → 逐步执行 |
| 🔧 Agentic 工具 | Search / Read / Bash 等工具实时展示 (Claude Code 风格) |
| 🔌 IDE 反向代理 | khy --kiro/--cursor/--claude/--codex 一键切换 IDE 模型源 |
| 🛡️ IP 匿名化 | 反向代理自动隐藏真实 IP，防止封禁 |

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 快速上手 — 10 条必备命令

| 命令 | 说明 |
|------|------|
| \`khy\` | 启动终端 (自动启动后端服务) |
| \`行情 600519\` | 查看贵州茅台实时行情 |
| \`k线 600519\` | 查看 K 线数据 |
| \`分析 600519\` | AI 综合分析 (自动调用最佳可用 AI) |
| \`回测 ma均线交叉 600519\` | 回测策略 |
| \`gateway status\` | 查看 AI 网关状态 |
| \`proxy quickstart\` | 一键启动 OpenAI 兼容反向代理并查看接入参数 |
| \`/plan\` | 进入计划模式 |
| \`/image test.png 分析走势\` | 图片分析 |
| \`综合分析 贵州茅台\` | 多智能体协作分析 |

## AI 配置

khy OS 自动检测以下 AI 来源 (按优先级):

1. **Claude Code / Codex** — 本地已安装的 AI CLI 工具
2. **Kiro / Cursor / Trae / Windsurf / VSCode** — IDE 内置 AI 模型
3. **Ollama** — 本地大模型推理 (默认 qwen2.5:7b)
4. **云 API** — Gemini / Groq / OpenRouter / 智谱 (需配置 key)
5. **Web 中转** — 手动浏览器中转 (备用)

设置 API Key: 编辑 \`~/.khyquant/.env\` 或使用 \`settings\` 命令。

## IDE 反向代理

\`\`\`bash
khy --kiro        # 使用 Kiro IDE 的 AI 模型
khy --cursor      # 使用 Cursor 的 AI 模型
khy --claude      # 使用 Claude Code
khy --codex       # 使用 OpenAI Codex
khy --windsurf    # 使用 Windsurf (Codeium)
khy --vscode      # 使用 VS Code Copilot
khy --trae        # 使用 Trae (字节跳动)
khy --warp        # 使用 Warp 终端
\`\`\`

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

## 社区 & 支持

- 官网: https://khyquant.top
- GitHub: https://github.com/khyquant/khy-quant
- 问题反馈: https://github.com/khyquant/khy-quant/issues

_感谢使用 khy OS，祝使用顺利！_
`;

  fs.writeFileSync(GUIDE_PATH, content, 'utf8');
}

/**
 * Check if the getting-started guide should be displayed.
 */
function shouldShow() {
  return !fs.existsSync(SHOWN_MARKER);
}

/**
 * Mark the getting-started guide as shown.
 */
function markAsShown() {
  try {
    fs.mkdirSync(KHY_DIR, { recursive: true });
    fs.writeFileSync(SHOWN_MARKER, new Date().toISOString());
  } catch { /* ignore */ }
}

/**
 * Display the getting-started guide in the terminal.
 * Uses aiRenderer if available, otherwise plain console output.
 */
function displayGettingStarted() {
  if (!shouldShow()) return false;

  try {
    const chalk = require('chalk').default || require('chalk');
    const version = process.env.KHYQUANT_PKG_VERSION || require('../../package.json').version;

    console.log('');
    console.log(chalk.cyan('  ━━━ khy OS v' + version + ' — AI Platform Operating System Terminal ━━━'));
    console.log('');
    console.log(chalk.bold('  国内首个 Claude Code 风格 AI 量化分析框架终端'));
    console.log('');
    console.log(chalk.yellow('  快速上手:'));
    console.log(chalk.dim('    行情 600519       查看实时行情'));
    console.log(chalk.dim('    分析 600519       AI 综合分析'));
    console.log(chalk.dim('    综合分析 贵州茅台 多智能体协作'));
    console.log(chalk.dim('    gateway status    查看 AI 状态'));
    console.log(chalk.dim('    proxy quickstart  一键启动反代并显示客户接入参数'));
    console.log(chalk.dim('    help             查看全部命令'));
    console.log('');
    console.log(chalk.dim(`  详细指南: ${GUIDE_PATH}`));
    console.log('');

    markAsShown();
    return true;
  } catch {
    markAsShown();
    return false;
  }
}

// Allow Node.js require() from _bootstrap.py
if (require.main === module) {
  generateGettingStarted();
}

module.exports = { generateGettingStarted, displayGettingStarted, shouldShow, markAsShown };
