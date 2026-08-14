<!-- 文档分类: OPS-MAN-027 | 阶段: 运维 | 原路径: docs/指南/快速开始.md -->
# KHY-OS 快速开始 — 安装与使用

在 **Windows、macOS 和 Linux** 上安装并运行 KHY-OS 的完整指南。

## 📦 pip 安装后，先读哪篇？

| 你的情况 | 读这篇 |
| --- | --- |
| 第一次安装，想要一条龙逐步操作 | **本文** [OPS-MAN-027] 快速开始（👈 你在这里） |
| 0 基础，想要「装完 → 配 AI → 日常 → 进阶 → 高手」成长阶梯 | [OPS-MAN-043] 从 0 到高手 |
| 装完想知道「能干什么」，功能逐项清单 | [OPS-MAN-023] 完整功能清单 |
| 按「我想要某种体验」反查该配什么 | [OPS-MAN-024] 按需配置体验 |
| 还原可读源码树 / 构建自研内核 ISO，开启全部能力 | [OPS-MAN-037] 完整还原与全功能 |
| 只想确认运行 / 构建环境要求 | [OPS-MAN-028] 环境要求 |

> **命令前缀图例**（全文统一）：
> - `$` / `PS>` = 在**系统终端**（Linux/macOS 的 shell、Windows 的 PowerShell）里直接运行。
> - `khy >` = 先运行 `khy` **进入 REPL** 之后，在 REPL 内输入。
> - 四个入口命令 `khy` / `khy-os` / `khy-quant` / `khyquant` 完全等价，本文统一用 `khy`。

> **装完第一件事永远是体检**（不是直接开聊）：
>
> ```bash
> khy preflight     # 体检 Node/依赖/PATH，给可粘贴的修复命令（不启动后端，最快）
> khy where         # 看装到哪了、依赖是否就绪（不是 PATH 垫片，是真实后端目录）
> khy doctor        # 尝试自动修复（会启动后端做更深的检查）
> ```
>
> 环境要求（硬性）：**Node.js ≥ 20**（后端 engines 约束；若本机没装，首次运行会自动下载便携版 Node，可用 `KHY_AUTO_INSTALL_NODE=0` 关闭）、**Python ≥ 3.8**（pip 安装门槛，`pyproject.toml` `requires-python`）。
> 当前稳定版以 `khy --version` 为准（本文撰写时为 `0.1.140`）。

---

## 目录

### 第一部分：Windows
1. 环境准备（Windows）
2. 安装 KHY-OS（Windows）
3. 首次运行与初始化（Windows）
4. AI 配置（Windows）
5. 日常使用（Windows）
6. 从 Windows 进行移动端远程控制
7. 故障排查（Windows）

### 第二部分：macOS
M1. 环境准备与安装（macOS）
M2. 首次运行、AI 配置与日常使用（macOS）

### 第三部分：Linux 服务器
8. 环境准备（Linux）
9. 安装 KHY-OS（Linux）
10. 首次运行与初始化（Linux）
11. AI 配置（Linux）
12. 日常使用（Linux）
13. 后台服务（Linux）
14. 使用 nginx 公网部署（Linux）
15. 故障排查（Linux）

### 第四部分：通用
16. 命令参考
17. AI 服务商配置
18. 斜杠命令（REPL）
19. 常见问题
20. 两个 Web 界面与两套手机访问，到底用哪个？

---

# 第一部分：Windows

## A1. 环境准备（Windows）

### Node.js（>= 20）

> khy 后端基于 Ink 6 的 TUI，**要求 Node.js ≥ 20**（这是 `services/backend/package.json` 的硬性 engines 约束）。

1. 从 https://nodejs.org/ 下载（推荐 LTS 版本，确保 ≥ 20）
2. 运行安装程序，勾选 "Add to PATH"
3. 打开 **PowerShell** 并验证：

```powershell
node -v    # Should show v20.x or higher
npm -v     # Should show 10.x or higher
```

### Python（>= 3.8）

1. 从 https://www.python.org/downloads/ 下载
2. **重要**：安装时勾选 "Add Python to PATH"
3. 验证：

```powershell
python --version   # Should show 3.8+
pip --version
```

> 如果 `python` 无法运行，请尝试 `python3` 或 `py -3`。

### Git（可选，但推荐）

从 https://git-scm.com/download/win 下载 —— 便于版本控制和更新。

---

## A2. 安装 KHY-OS（Windows）

打开 **PowerShell**（或 CMD）：

```powershell
pip install khy-os
```

验证安装：

```powershell
khy --version
```

### 安装扩展组件（可选）

```powershell
# Data analysis (pandas, akshare)
pip install "khy-os[data]"

# Machine learning (scikit-learn, xgboost, lightgbm)
pip install "khy-os[ml]"

# Everything
pip install "khy-os[full]"
```

### 升级

```powershell
pip install --upgrade khy-os
```

---

## A3. 首次运行与初始化（Windows）

```powershell
khy
```

首次启动会触发自动初始化：
- 安装 Node.js npm 依赖
- 生成 `.env` 配置文件
- 创建 SQLite 数据库
- 打印欢迎信息

这可能需要 1-2 分钟。完成后，你将进入**交互式 REPL**：

```
╭─────────────────────────────────╮
│  KHY OS v0.1.x                  │
│  Type /help for commands        │
╰─────────────────────────────────╯
khy >
```

输入 `/help` 查看所有可用命令，或输入 `/exit` 退出。

### 系统诊断

运行内置的 doctor 来验证一切正常：

```
khy > doctor
```

或在 REPL 之外运行：

```powershell
khy doctor
```

---

## A4. AI 配置（Windows）

KHY-OS 至少需要配置一个 AI 服务商才能使用 AI 功能。

### 方式一：使用云端 API Key（推荐）

最省心的方式是交互式网关配置向导，它会引导你选服务商、填 Key、并写入正确位置：

```powershell
khy gateway config         # 在系统终端运行（推荐，canonical 入口）
```

或在 REPL 内运行等价命令：

```
khy > /apikey              # /apikey 是别名，等价于 khy gateway config
```

按照向导配置你的 API Key。支持的服务商：

| Provider | Environment Variable | Get Key From |
|----------|---------------------|--------------|
| Anthropic (Claude) | `ANTHROPIC_API_KEY` | https://console.anthropic.com/ |
| OpenAI | `OPENAI_API_KEY` | https://platform.openai.com/ |
| DeepSeek | `DEEPSEEK_API_KEY` | https://platform.deepseek.com/ |
| Google (Gemini) | `GOOGLE_API_KEY` | https://aistudio.google.com/ |
| OpenRouter | `OPENROUTER_API_KEY` | https://openrouter.ai/ |

如果你想手动设置，也可以用环境变量，或直接编辑 `.env` 文件：

```powershell
# PowerShell — 仅当前会话临时生效
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# 永久写入 .env：.env 位于「bundled 后端目录」内，先用 khy where 查出真实路径再编辑。
# 注意：不存在 ~/.khy-os 这样的目录，请勿手写该路径。
khy where                  # 看 “backend dir” 那一行，即 .env 所在目录
notepad (python -c "from khy_platform.cli import get_bundle_dir; print(get_bundle_dir())")\.env
```

### 方式二：使用本地模型（Ollama）

从 https://ollama.ai/ 安装 Ollama。**前提：Ollama 服务必须在后台运行**——
先用 `ollama list`（或访问 http://localhost:11434）确认服务已起来，否则拉取模型会连接失败。
确认后拉取一个模型，再让网关自动发现它：

```powershell
ollama pull qwen2.5:7b     # 用 ollama 自己拉取（标签需真实存在，如 qwen2.5 系列）
khy gateway detect         # 让 KHY 网关自动发现本地 Ollama 及其模型
```

> 进入 REPL 后可用 `/model` 切换到刚拉取的 Ollama 模型。

### 查看 AI 状态

```powershell
khy gateway status         # 列出已配置的服务商及在线状态（装完未配 key 属正常）
khy gateway detect         # 自动检测可用服务商（含本地 Ollama）
```

---

## A5. 日常使用（Windows）

### 交互式 REPL（主要模式）

```powershell
khy
```

这是使用 KHY-OS 的主要方式。在 REPL 内：

```
khy > 帮我分析一下最近的A股走势
khy > 查看沪深300指数
khy > backtest list
khy > quote 600519
```

### 单次 AI 查询

```powershell
khy ai "summarize the current market conditions"
khy -p "explain what a moving average crossover strategy is"
```

### 数据命令

```powershell
khy data list              # List available data sources
khy data fetch 600519      # Fetch stock data
khy quote 600519           # Quick stock quote
```

### Web 界面（两个，别混淆）

KHY 有**两个不同的 Web 服务**，新手最容易搞混：

| 命令 | 是什么 | 默认端口 | 何时用 |
| --- | --- | --- | --- |
| `khy server start` | 量化 / 项目 Web UI（旧 server.js） | `:3000`（`--port` 或 `PORT` 覆盖） | 看行情、回测、项目图形界面 |
| `khychat`（REPL 内） | **AI 网关管理页 / 对话页**（Vue 前端） | API `:9090`、前端 `:8090` | 配置 AI 服务商、网页里和 AI 对话 |

```powershell
khy server start           # 量化 Web UI → http://localhost:3000
```

在浏览器打开 http://localhost:3000 即可使用量化图形界面。
要打开 **AI 网关管理 / 对话页**，则进入 REPL 后运行 `khychat`（详见 C5 节）。

### 网关管理

```powershell
khy gateway status         # View AI gateway status
khy gateway detect         # Auto-detect available AI providers
khy pool list              # View API key pool
```

---

## A6. 从 Windows 进行移动端远程控制

在同一局域网下，从手机访问 KHY 的网关管理 / 对话页。**推荐 `khy mobile`**（扫码即用）：

```powershell
khy mobile                 # 生成二维码，手机扫码访问；默认端口 9090
khy mobile 192.168.1.9:9090   # 也可指定 主机:端口
```

手机与电脑需在同一局域网。二维码指向 `http://<本机内网IP>:9090/admin/ai-gateway`。

> **高级 / 底层用法 `khy bridge`**：`khy bridge start` 是更底层的移动远程服务（端口 `:9222`，
> 用 PIN + 账号认证），适合需要账号体系或自建反代的场景：
>
> ```
> 📱 Mobile: http://192.168.1.5:9222/  PIN: 836201
> ```
>
> 一般用户用 `khy mobile` 即可。两者区别与进阶配置详见 [移动端远程指南.md](%5BOPS-MAN-030%5D%20移动端远程指南.md)。

---

## A7. 故障排查（Windows）

### 找不到 "khy" 命令

```powershell
# Check Python Scripts is in PATH
python -m site --user-site
# Usually: C:\Users\<you>\AppData\Roaming\Python\Python3x\Scripts

# Or use module directly
python -m khy_platform.cli
```

如果 pip 安装到了用户目录，请将其添加到 PATH：

```powershell
# Find the Scripts directory
python -c "import sysconfig; print(sysconfig.get_path('scripts'))"

# Add to PATH permanently (PowerShell)
[Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";" + "C:\Users\<you>\AppData\Local\Programs\Python\Python3x\Scripts", "User")
```

### npm install 失败

```powershell
# If behind a corporate proxy
npm config set proxy http://127.0.0.1:7890
npm config set https-proxy http://127.0.0.1:7890

# If npm registry is slow (use China mirror)
npm config set registry https://registry.npmmirror.com
```

### 初始化期间找不到 Node.js

确保 Node.js 已加入 PATH：

```powershell
node -v
# If not found, reinstall Node.js and check "Add to PATH"
```

### 端口冲突（server 或 bridge）

```powershell
# Find what's using a port
netstat -ano | findstr :3000
netstat -ano | findstr :9222

# Kill by PID
taskkill /PID <pid> /F
```

### 中文字符乱码

设置终端编码：

```powershell
# PowerShell
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
chcp 65001
```

或使用 **Windows Terminal**（推荐），它对 Unicode 的支持更好。

---

# 第二部分：macOS

> macOS 上的日常使用、AI 配置、命令与 Linux 完全一致（都是 Unix shell）。本部分只补 macOS 特有的
> **安装前置**；装好后请直接照「第三部分：Linux」的 B3 起步骤操作。

## M1. 环境准备与安装（macOS）

推荐用 [Homebrew](https://brew.sh/) 一次装齐前置：

```bash
# 没有 Homebrew 先装它（官网命令），然后：
brew install node python git      # Node ≥ 20、Python ≥ 3.8、git

node -v        # 确认 ≥ v20
python3 --version   # 确认 ≥ 3.8

# 安装 KHY-OS
pip3 install khy-os
# 可选扩展：pip3 install "khy-os[data]" / "[ml]" / "[full]"

khy --version  # 验证
```

> 如果装完提示 `khy: command not found`，是 pip 的可执行目录不在 PATH。查出并加入：
>
> ```bash
> python3 -c "import sysconfig; print(sysconfig.get_path('scripts'))"   # 打印 Scripts 目录
> echo 'export PATH="'$(python3 -c "import sysconfig; print(sysconfig.get_path('scripts'))")':$PATH"' >> ~/.zshrc
> source ~/.zshrc
> ```

## M2. 首次运行、AI 配置与日常使用（macOS）

```bash
khy preflight   # 先体检
khy             # 首次运行：自动装依赖 / 建库 / 写 .env，然后进入 REPL
```

- **AI 配置**：`khy gateway config`（与 Windows A4 / Linux B4 相同）。
- **本地模型（Ollama）**：`brew install ollama`，`ollama serve` 起服务，`ollama pull qwen2.5:7b`，再 `khy gateway detect`。
- **Web 界面 / 手机访问 / 日常命令**：完全照「第三部分：Linux」的 B5、以及通用部分的 C 节。`khy mobile` 在 macOS 同样可用。

---

# 第三部分：Linux 服务器

## B1. 环境准备（Linux）

### Node.js（>= 20）

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Verify
node -v
npm -v
```

### Python（>= 3.8）

```bash
python3 --version    # Need >= 3.8; most modern distros already ship 3.10+

# If not:
# Ubuntu/Debian
sudo apt-get install -y python3 python3-pip

# CentOS/RHEL
sudo dnf install -y python3 python3-pip
```

### 构建工具（用于原生 npm 包）

```bash
# Ubuntu/Debian
sudo apt-get install -y build-essential

# CentOS/RHEL
sudo dnf groupinstall -y "Development Tools"
```

---

## B2. 安装 KHY-OS（Linux）

```bash
pip install khy-os

# Verify
khy --version
```

### 安装扩展组件（可选）

```bash
pip install "khy-os[data]"     # Data analysis
pip install "khy-os[ml]"       # Machine learning
pip install "khy-os[full]"     # Everything
```

### 升级

```bash
pip install --upgrade khy-os
```

---

## B3. 首次运行与初始化（Linux）

```bash
khy
```

首次启动会自动初始化：
- 为后端依赖执行 `npm install`
- 生成 `.env` 文件
- 创建 SQLite 数据库

初始化完成后，你将进入交互式 REPL：

```
khy >
```

### 系统诊断

```bash
khy doctor
```

检查 Node.js、Python、数据库、网络连通性以及 AI 服务商状态。

---

## B4. AI 配置（Linux）

### 设置 API Key

最省心的是交互式向导（推荐）：

```bash
khy gateway config     # canonical 入口，引导选服务商 / 填 Key / 写入正确位置
```

也可以手动设置环境变量或直接编辑 `.env`：

```bash
# 方式一：环境变量（临时，仅当前会话）
export ANTHROPIC_API_KEY="sk-ant-..."

# 方式二：写入 shell 配置（持久）
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc

# 方式三：直接编辑 .env（位于 bundled 后端目录，路径由 get_bundle_dir() 推导）
nano $(python3 -c "from khy_platform.cli import get_bundle_dir; print(get_bundle_dir())")/.env
```

### 使用本地模型

```bash
# 安装 Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 前提：确认 Ollama 服务在运行（Linux 安装脚本通常已注册为 systemd 服务）
ollama list        # 能列出即服务就绪；否则 `systemctl start ollama` 或 `ollama serve`

# 用 ollama 拉取一个真实存在的模型标签，再让网关发现它
ollama pull qwen2.5:7b
khy gateway detect     # 自动发现本地 Ollama 及其模型
```

### 验证

```bash
khy gateway status     # 已配置的服务商及在线状态
khy gateway detect     # 自动检测可用服务商（含本地 Ollama）
```

---

## B5. 日常使用（Linux）

### 交互式 REPL

```bash
khy
```

在 REPL 内，可以使用任意命令，或用自然语言向 AI 提问：

```
khy > 帮我分析上证指数
khy > quote 600519
khy > data fetch 000001
khy > backtest list
```

### 单次查询

```bash
khy ai "what is the current sentiment on A-shares?"
khy -p "explain RSI indicator"
```

### Web 服务器

```bash
khy server start
# Open http://localhost:3000
```

### 后台 REPL（tmux）

在服务器上保持会话持续运行：

```bash
# Create a tmux session
tmux new -s khy

# Run khy inside
khy

# Detach: Ctrl+B then D
# Reattach later:
tmux attach -t khy
```

---

## B6. 后台服务（Linux）

在生产环境中，可将 KHY 作为 systemd 服务运行，开机自启动。

### 查找后端路径

```bash
BACKEND_DIR=$(python3 -c "from khy_platform.cli import get_bundle_dir; print(get_bundle_dir())")
NODE_BIN=$(which node)
echo "Backend: $BACKEND_DIR"
echo "Node: $NODE_BIN"
```

### 创建服务

```bash
sudo tee /etc/systemd/system/khy-backend.service > /dev/null << EOF
[Unit]
Description=KHY Backend API Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$BACKEND_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
StandardOutput=journal
StandardError=journal
SyslogIdentifier=khy-backend

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable khy-backend
sudo systemctl start khy-backend
```

### 管理

```bash
sudo systemctl status khy-backend    # Check status
sudo systemctl restart khy-backend   # Restart
journalctl -u khy-backend -f         # Follow logs
```

如需完整的多服务部署（backend + AI + bridge + nginx），请参阅：
- [部署指南-域名.md](../06_DEPLOY_部署/%5BDEPLOY-MAN-016%5D%20部署指南-域名.md) —— 带 SSL 的域名部署
- [部署指南-无域名.md](../06_DEPLOY_部署/%5BDEPLOY-MAN-017%5D%20部署指南-无域名.md) —— 仅 IP 部署

---

## B7. 使用 nginx 公网部署（Linux）

> 说明：`khy deploy` 是**通用项目部署器**（`khy deploy <目标> [源] --start …`，子命令
> `list/status/stop/logs`），**不是**一键 nginx/SSL/域名部署命令。khy 自身的公网部署
> （nginx + SSL + systemd）走下面的专项指南，按文档步骤执行。

### 有域名（nginx + SSL）

带域名与 SSL 的完整部署请参阅 [部署指南-域名.md](../06_DEPLOY_部署/%5BDEPLOY-MAN-016%5D%20部署指南-域名.md)，
其中给出 nginx 反代、证书申请/续期与 systemd 守护的逐步命令。

### 无域名（仅 IP）

逐步手动部署请参阅 [部署指南-无域名.md](../06_DEPLOY_部署/%5BDEPLOY-MAN-017%5D%20部署指南-无域名.md)。

### 快速 nginx 配置（仅 Bridge）

如果你只想把移动端远程控制页面放在 nginx 后面：

```bash
khy bridge nginx --prefix /remote
```

这会生成一段 nginx 配置片段，你可以将其粘贴到你的 server 块中。

---

## B8. 故障排查（Linux）

### 找不到 "khy" 命令

```bash
# Check where pip installed it
python3 -m site --user-base
# Usually: ~/.local/bin/khy

# Add to PATH
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc

# Or use directly
python3 -m khy_platform.cli
```

### npm install 因权限错误失败

```bash
# Don't use sudo with npm — fix ownership instead
sudo chown -R $(whoami) ~/.npm
npm cache clean --force

# Or use a Node version manager (nvm)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
nvm install 20
```

### npm registry 缓慢（中国）

```bash
npm config set registry https://registry.npmmirror.com
```

### 端口已被占用

```bash
sudo lsof -i :3000
sudo kill $(sudo lsof -t -i :3000)
```

### SQLite 报 "database locked"

通常是由于多个进程访问同一个数据库：

```bash
# Check for stale processes
ps aux | grep node | grep khy

# Kill duplicates
kill <pid>
```

---

# 第三部分：通用

## C1. 命令参考

### 顶层命令

| Command | Description |
|---------|-------------|
| `khy` | 启动交互式 REPL（首次自动初始化） |
| `khy preflight` | 启动依赖体检（不启动后端，最快） |
| `khy where` | 真实安装位置（backend 目录 / 依赖是否就绪） |
| `khy gateway config` | 配置 AI 服务商 / Key（canonical） |
| `khy ai "..."` | 单次 AI 查询 |
| `khy -p "..."` | 单次 AI 输出（适合管道） |
| `khy server start` | 启动量化 Web UI（默认端口 3000） |
| `khy doctor` | 系统诊断（会启动后端） |
| `khy --version` | 显示版本 |
| `khy --help` | 显示帮助 |

### 数据与交易

| Command | Description |
|---------|-------------|
| `khy quote <code>` | 股票行情（例如 `600519`） |
| `khy data list` | 列出数据源 |
| `khy data fetch <code>` | 获取股票数据 |
| `khy backtest list` | 列出回测 |
| `khy analyze <code>` | 技术分析 |
| `khy search <keyword>` | 搜索股票 |

### AI 与模型

| Command | Description |
|---------|-------------|
| `khy gateway config` | 配置 AI 服务商 / Key（canonical 入口） |
| `khy gateway status` | 网关状态 / 已配置服务商 |
| `khy gateway detect` | 自动检测服务商（含本地 Ollama） |
| `ollama pull <model>` | 用 ollama 下载本地模型（标签需真实存在） |
| `khy claude` | 经 KHY 代理启动 Claude Code（需全局 `claude` CLI） |
| `khy pool list` | API key 池 |

> 旧命令 `khy ai status` / `khy models pull` 仍可用，但推荐改用上表的 `khy gateway *` / `ollama pull`。

### 工具与系统

| Command | Description |
|---------|-------------|
| `khy mobile` | 手机扫码访问网关管理页（推荐，:9090 + 二维码） |
| `khy bridge start` | 移动端远程服务器（高级 / 底层，:9222 + PIN） |
| `khy bridge status` | Bridge 服务器状态 |
| `khy plugin list` | 列出插件 |
| `khy skill list` | 列出技能 |
| `khy log tail` | 跟踪错误日志 |
| `khy config list` | 查看配置 |

### 部署

| Command | Description |
|---------|-------------|
| `khy deploy <目标> [源] --start` | 通用项目部署（自动探测/安装/构建/启动） |
| `khy deploy list` | 列出所有部署 |
| `khy deploy status [name]` | 查看部署状态 |
| `khy deploy stop [name]` | 停止已启动的部署 |
| `khy deploy logs [name]` | 查看部署日志 |
| `khy bridge nginx --prefix /remote` | 为移动端远程页生成 nginx 配置片段 |

---

## C2. AI 服务商配置

### 云端服务商

| Provider | Key | Models |
|----------|-----|--------|
| Anthropic | `ANTHROPIC_API_KEY` | Claude 4.5, Claude 4 |
| OpenAI | `OPENAI_API_KEY` | GPT-4o, o3, o4-mini |
| DeepSeek | `DEEPSEEK_API_KEY` | DeepSeek-V3, R1 |
| Google | `GOOGLE_API_KEY` | Gemini 2.5 Pro/Flash |
| OpenRouter | `OPENROUTER_API_KEY` | 200+ 个模型 |
| Groq | `GROQ_API_KEY` | LLaMA, Mixtral（快速） |

### 本地模型（Ollama）

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh    # Linux
# Or download from https://ollama.ai              # Windows / macOS

# 用 ollama 拉取模型（标签需真实存在）
ollama pull qwen2.5:7b       # 4.7 GB, good for most tasks
ollama pull llama3.1:8b      # 4.7 GB, strong general model
ollama pull deepseek-r1:7b   # 4.1 GB, reasoning-focused

khy gateway detect           # 让 KHY 网关发现本地 Ollama 及其模型

# Use（没有 `khy ai run` 子命令；用一次性查询，模型由网关当前选择决定）
khy ai "hello"
# 在 REPL 内可用 /model 切到刚拉取的 ollama 模型
```

### 代理配置（中国）

如果你处于防火墙之后，需要通过代理访问 API：

```
khy > /proxy
```

或设置环境变量：

```bash
export HTTPS_PROXY=http://127.0.0.1:7890
export HTTP_PROXY=http://127.0.0.1:7890
```

---

## C3. 斜杠命令（REPL）

在交互式 REPL（`khy`）内，使用 `/` 命令：

### 最常用

| Command | Description |
|---------|-------------|
| `/help` | 显示所有命令 |
| `/model` | 切换 AI 模型 |
| `/apikey` | 配置 API Key |
| `/cost` | 查看 token 用量 |
| `/history` | 对话历史 |
| `/exit` | 保存并退出 |

### AI 功能

| Command | Description |
|---------|-------------|
| `/plan` | AI 先规划再执行 |
| `/max` | 最高精度模式 |
| `/fast` | 快速响应模式 |
| `/thinking` | 切换思考过程显示 |
| `/compact` | 压缩上下文 |
| `/websearch` | 网络搜索 |
| `/image` | 图像分析 |
| `/review` | 代码审查 |

### 系统

| Command | Description |
|---------|-------------|
| `/doctor` | 系统诊断 |
| `/gateway` | AI 网关管理 |
| `/proxy` | 代理设置 |
| `/config` | 配置 |
| `/update` | 检查更新 |
| `/self` | 查看能力 |

### 数据与交易

| Command | Description |
|---------|-------------|
| `/subscribe` | AI 订阅指南 |
| `/growth` | 学习进度 |
| `/knowledge` | 知识库 |
| `/arena` | 多模型对比 |
| `/skill` | 技能管理 |

---

## C4. 常见问题

### 问：`khy` 和 `khyquant` 有什么区别？

两者都可用。`khy` 是平台外壳（推荐），`khyquant` 是为兼容旧版量化应用保留的名称。它们指向同一个程序。

### 问：不用 AI 能用 KHY 吗？

可以。数据获取、回测、Web 服务器和插件系统都无需 AI 即可工作。只有 AI 对话和 AI 驱动的功能（分析、代码审查等）才需要 API Key 或本地模型。

### 问：如何使用中文命令？

KHY 在 REPL 中支持中文命令别名：

```
khy > 行情 600519       # = quote 600519
khy > 回测               # = backtest list
khy > 分析 000001       # = analyze 000001
khy > 买入              # = order buy
```

### 问：如何更新 KHY？

```bash
pip install --upgrade khy-os
```

或在 REPL 内：

```
khy > /update
```

### 问：数据存储在哪里？

| Data | Location |
|------|----------|
| SQLite 数据库 | `<backend>/data/` |
| 配置 | `<backend>/.env` |
| 用户账号（bridge） | `<backend>/data/bridge-users.db` |
| 对话历史 | `<backend>/data/` |
| npm 包 | `<backend>/node_modules/` |

查找后端目录：

```bash
python3 -c "from khy_platform.cli import get_bundle_dir; print(get_bundle_dir())"
```

### 问：可以运行多个实例吗？

可以，但要使用不同的端口：

```bash
PORT=3001 khy server start
BRIDGE_PORT=9223 khy bridge start
```

### 问：运行本地 AI 模型的最低硬件要求？

| Model Size | RAM Required | GPU (Optional) |
|------------|-------------|----------------|
| 4B 参数 | 4 GB | 任意 4GB+ 显存 |
| 8B 参数 | 8 GB | 任意 6GB+ 显存 |
| 14B 参数 | 16 GB | 10GB+ 显存 |
| 32B 参数 | 32 GB | 16GB+ 显存 |

CPU 推理可以工作，但明显更慢。对于 >= 8B 的模型，推荐使用 GPU（NVIDIA CUDA 或 Apple M 系列）。

### 问：除了 `<backend>` 目录，KHY 还往哪里写文件？

`.env`、数据库、首启标记都在 **bundled 后端目录**（`khy where` 的 `backend dir`）。此外还有几个家目录子目录：

| 用途 | 位置 |
|------|------|
| 内核构建缓存 / 状态 | `~/.khyos/cache` |
| 自动下载的便携 Node | `~/.khyquant/node`（Windows：`%LOCALAPPDATA%\khy\node`） |
| 代理 / Claude 相关 | `~/.khy`（兼容 `~/.khyquant`） |

> 历史提示：早期的「`khychat` 打不开页面 / Windows `spawn EINVAL`」问题已于 `0.1.95` 修复，
> 当前版本无需关注；遇到任何异常先 `khy preflight` 体检即可。

---

## C5. 两个 Web 界面与两套手机访问，到底用哪个？

新手最容易困惑的两组「看起来重复」的命令，一张表讲清：

### 两个 Web 界面

| 命令 | 是什么 | 默认端口 | 何时用 |
| --- | --- | --- | --- |
| `khy server start` | 量化 / 项目 Web UI | `:3000` | 行情、回测、项目图形界面 |
| `khychat`（REPL 内） | AI 网关管理页 / 网页对话页 | API `:9090` / 前端 `:8090` | 配 AI 服务商、网页和 AI 对话 |

打开 AI 网关管理 / 对话页（进入 `khy` REPL 后）：

```
khy > khychat                  # 启动管理后端 + 前端，并打开浏览器到 /admin/ai-gateway
khy > gateway manage status    # 查看运行状态
khy > gateway manage stop      # 停止
```

> `khychat` 是 REPL 内命令（等价于 `gateway manage open`）。可用 `--api-port` / `--frontend-port` 覆盖端口。

### 两套手机访问

| 命令 | 端口 | 认证 | 适合 |
| --- | --- | --- | --- |
| `khy mobile`（推荐） | `:9090` | 扫二维码 | 一般用户，同局域网即开即用 |
| `khy bridge start` | `:9222` | PIN + 账号 | 高级 / 需账号体系或自建反代 |

一般用户**用 `khy mobile` 即可**；`khy bridge` 是更底层的方案。进阶配置见 [移动端远程指南.md](%5BOPS-MAN-030%5D%20移动端远程指南.md)。

---

## C6. 插件开发（进阶）

KHY 支持用插件扩展自己的命令、工具和数据源。`khy plugin` 提供了从脚手架到体检的一条龙开发链路。

| 命令 | 作用 |
| --- | --- |
| `khy plugin init` | 交互式脚手架，生成一个新插件骨架（别名 `create`/`new`） |
| `khy plugin dev [dir]` | 开发模式：前端起 Vite，纯后端则监听 `src/` 改动热重载 |
| `khy plugin doctor [dir]` | 体检：校验 manifest、语法检查、依赖解析、`activate()` 冒烟、命令/工具一致性 |
| `khy plugin list` | 列出已安装插件及其健康/告警状态（别名 `ls`） |
| `khy plugin link [dir]` | 把本地插件目录软链进数据目录的 `plugins/`，便于本地调试 |
| `khy plugin unlink <name>` | 取消软链 |

`plugin doctor` 常用开关：`--strict`（告警即失败）、`--deep`（轻量执行命令/工具）、`--json`（机器可读输出 + 退出码）。

### 插件骨架长什么样

- **SDK**：插件依赖 `@khy/plugin-sdk`（peerDependency）。
- **manifest 不是独立文件**——它是插件 `package.json` 里的 `khy` 字段，关键项：

```jsonc
{
  "name": "khy-myplugin",
  "peerDependencies": { "@khy/plugin-sdk": "^1.0.0" },
  "khy": {
    "namespace": "myplugin",          // 1-12 位小写字母数字
    "displayName": "My Plugin",
    "main": "src/index.js",
    "permissions": { "network": false, "database": false, "spawn": false },
    "contributions": { "commands": [], "tools": [], "dataSources": [] }
  }
}
```

```bash
khy plugin init                 # 按提示填 namespace / 模板 / 权限
khy plugin doctor ./khy-myplugin --strict
khy plugin link ./khy-myplugin  # 链入后即可在 khy 里调用你的命令
```

> 注意区分：上面是**写插件**（作者工具链）。网关侧还有一个 `khy plugin gateway`（请求/响应拦截器链，`pluginChain`），那是**运行期网关**概念，和写插件不是一回事。

实现定位：`services/backend/src/cli/handlers/plugin-dev.js`；SDK 在 `platform/packages/plugin-sdk/`。
