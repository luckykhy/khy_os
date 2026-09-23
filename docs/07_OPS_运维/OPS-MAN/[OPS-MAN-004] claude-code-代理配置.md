<!-- 文档分类: OPS-MAN-004 | 阶段: 运维 | 原路径: docs/指南/claude-code-代理配置.md -->
# 通过 KHY 代理接入 Claude Code

KHY 的 AI Gateway 代理服务器可以将 Kiro、Trae、Codex 等 IDE 适配器中的模型（DeepSeek、GPT-5.3、Claude 等）暴露为 Anthropic Messages API，让 Claude Code 直接使用。

## 工作原理

```
Claude Code
  ↓  POST /v1/messages (Anthropic SSE)
KHY Proxy (127.0.0.1:9100)
  ↓  协议转换 + 适配器级联
kiro / trae / codex / ollama / ...
  ↓  实际模型（DeepSeek、GPT-5.3 等）
流式响应 → Anthropic SSE → Claude Code
```

- Claude Code 以为自己在调用 Claude 模型，实际由 KHY 透明代理到可用的 IDE 适配器
- 适配器级联优先级：kiro → cursor → trae → claude → codex → ollama → relay_api → api
- 每个适配器自动选择最佳可用模型，无需手动指定

## 推荐：`khy claude` 一键启动（零残留）

下面「快速开始」一节是**手动**配置环境变量的底层路径，便于你理解原理。日常使用更推荐一条命令 `khy claude`——它自动把代理相关环境变量**只注入到子进程**里再拉起 `claude`，**不写任何 settings.json、不污染你原生的 `claude` 认证**：你退出后，直接敲 `claude` 仍然用回原来的官方账号。

```bash
khy claude            # 用 KHY 网关拉起 Claude Code（零残留 env 注入）
khy claude --list     # 只列出当前可用模型后退出
khy claude --model kiro/claude-sonnet-4.6   # 指定主模型直接启动
```

### 混合模式：主模型与子智能体分走不同来源

当你**手里有外部 Anthropic 官方额度**（`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` 不以 `khy-` 开头）时，可以让「主控模型」和「子智能体（sub-agent）」走不同来源，省着用官方额度：

| 命令 | 主控模型 | 子智能体 | 适合 |
| --- | --- | --- | --- |
| `khy claude --hybrid` | **外部 Anthropic**（官方 Opus/Sonnet） | **KHY 网关**（IDE 适配器） | 主控要最强官方模型，子任务用 KHY 省额度 |
| `khy claude --hybrid-sub` | **KHY 网关** | **外部 Anthropic**（官方 Sonnet） | 主控用 KHY，仅子智能体偶尔借官方模型 |

> 混合模式要求你已配置外部 Anthropic 认证；若检测到只有 `khy-` 开头的 token，会自动回退为普通模式并给出提示。

### `--marshal`：皇权特许，强制任命任意在线模型为主控

```bash
khy claude --marshal kiro/claude-opus-4.6   # 强制把某个在线模型任命为「元帅」（主控）
```

`--marshal` 注入 `KHY_MARSHAL`，只校验该模型在线且协议可用，不做能力门控——把任意在线模型抬为主控控制器。

> 实现：Python 启动器 `platform/khy_platform/cli.py`（`_run_claude_code_launcher`、`_build_khy_proxy_env`）。它把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` / 模型变量等只 `update` 进子进程 env 后 `subprocess.run`，从不落盘——这正是「零残留」的代码依据。

## 快速开始

### 1. 安装 / 更新 KHY

```bash
pip install khy-os --upgrade
```

首次启动会自动初始化（安装 npm 依赖、生成配置、初始化数据库）：

```bash
khy
```

### 2. 启动代理服务器

```bash
khy proxy start
```

启动后会打印 auth token 和监听地址：

```
[Proxy] Auto-generated auth token: khy-a1b2c3d4e5f6...
[Proxy] Listening on http://127.0.0.1:9100
```

> 忘记 token 可随时运行 `khy proxy status` 查看。

### 3. 配置 Claude Code 环境变量

#### Linux / macOS

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9100
export ANTHROPIC_API_KEY=khy-你的token
claude
```

写入 `~/.bashrc` 或 `~/.zshrc` 永久生效：

```bash
echo 'export ANTHROPIC_BASE_URL=http://127.0.0.1:9100' >> ~/.bashrc
echo 'export ANTHROPIC_API_KEY=khy-你的token' >> ~/.bashrc
source ~/.bashrc
```

#### Windows (PowerShell)

临时生效：

```powershell
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:9100"
$env:ANTHROPIC_API_KEY = "khy-你的token"
claude
```

永久生效（写入用户环境变量，需重开终端）：

```powershell
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_BASE_URL", "http://127.0.0.1:9100", "User")
[System.Environment]::SetEnvironmentVariable("ANTHROPIC_API_KEY", "khy-你的token", "User")
```

### 4. 验证

```bash
# 检查代理健康状态
curl http://127.0.0.1:9100/health

# 查看可用模型列表
curl -H "Authorization: Bearer khy-你的token" http://127.0.0.1:9100/v1/models
```

## 指定特定模型（可选）

默认情况下，Claude Code 发送的请求会由 KHY 自动级联到第一个可用的 IDE 适配器，适配器自动选择最佳模型。

如需精确控制，可以设置 `ANTHROPIC_MODEL` 环境变量，使用 `适配器/模型名` 语法：

```bash
# 使用 Trae 中的 DeepSeek
export ANTHROPIC_MODEL=trae/deepseek-v3

# 使用 Codex 中的 GPT-5.3
export ANTHROPIC_MODEL=codex/gpt-5.3-codex

# 使用 Kiro 中的模型
export ANTHROPIC_MODEL=kiro/claude-sonnet-4.6

# 使用本地 Ollama 模型
export ANTHROPIC_MODEL=ollama/qwen2.5:32b
```

也可通过 `PROXY_MODEL_ROUTE_MAP` 环境变量配置自定义路由规则：

```bash
# 将所有 claude-sonnet 请求路由到 trae 的 deepseek
export PROXY_MODEL_ROUTE_MAP='claude-sonnet-4-*=trae:deepseek-v3'
```

## 代理管理

```bash
khy proxy start       # 启动代理（默认端口 9100）
khy proxy stop        # 停止代理
khy proxy status      # 查看代理状态和 auth token
khy proxy token       # 管理 auth token
khy proxy client add <名称>  # 为新客户端创建专属 token
```

自定义端口：

```bash
PROXY_PORT=8080 khy proxy start
```

## 支持的协议

KHY 代理同时支持多种 API 协议，不同客户端可以通过同一个代理接入：

| 端点 | 协议 | 客户端 |
|------|------|--------|
| `POST /v1/messages` | Anthropic Messages API | Claude Code |
| `POST /v1/chat/completions` | OpenAI Chat API | Cursor / 通用 |
| `POST /v1/responses` | OpenAI Responses API | Codex CLI |
| `GET /v1/models` | 模型列表 | 通用 |

## 常见问题

### 代理启动后 Claude Code 报 401

检查 `ANTHROPIC_API_KEY` 是否与 `khy proxy status` 显示的 token 一致。

### Claude Code 无响应

1. 确认代理在运行：`curl http://127.0.0.1:9100/health`
2. 确认有可用适配器：在 KHY REPL 中运行 `/model` 或 `khy gateway status`
3. 检查 IDE（Kiro/Trae）是否已登录

### Windows 上 Trae/Kiro 模型未检测到

确保对应 IDE 已安装并登录。KHY 通过读取 IDE 的本地 storage 文件自动发现 token：
- Kiro: `%APPDATA%/Kiro/`
- Trae: `%APPDATA%/Trae/`

### 想用其他端口

```bash
PROXY_PORT=8443 khy proxy start
# 相应修改 ANTHROPIC_BASE_URL
export ANTHROPIC_BASE_URL=http://127.0.0.1:8443
```
