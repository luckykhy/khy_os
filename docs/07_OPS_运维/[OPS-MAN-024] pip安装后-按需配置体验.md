<!-- 文档分类: OPS-MAN-024 | 阶段: 运维 | 原路径: docs/指南/pip安装后-按需配置体验.md -->
# pip 安装后 — 按需配置体验

> 装完 `khy-os` 之后，**你不需要把所有功能都配一遍**。本指南按「你想要什么体验」来组织：找到你的场景，照着那一节配，其余跳过即可——这就是「按需所取」。

> 📦 **pip 安装后，先读哪篇？**
>
> | 你的目的 | 看这篇 |
> | --- | --- |
> | 第一次装完，想最快跑起来 | [快速开始](%5BOPS-MAN-027%5D%20快速开始.md) |
> | 想按成长阶梯一步步进阶 | [OPS-MAN-043] 从 0 到高手 |
> | 想知道装完到底能干什么 | [完整功能清单](%5BOPS-MAN-023%5D%20pip安装后-完整功能清单.md) |
> | **本文** | 按场景的渐进式配置（每节自包含，可单独取用） |
> | 安装与运行的软硬件门槛 | [OPS-MAN-028] 环境要求 |
> | 还原源码树 / 自研内核全功能 | [OPS-MAN-037] 完整还原与全功能开启 |

---

## 三步心法

```
①  验证        ②  选体验            ③  配一次
khy preflight  →  从下面挑你要的场景  →  改 .env / 跑一条命令 → 立即生效
```

KHY-OS 的设计是**离线即可用**：什么都不配，`khy` 也能进交互界面、`/learn` 也能学。配置只是为了**解锁你想要的那一种体验**。不确定要什么？先跳到 [§3 我想要……（场景导航）](#3-我想要场景导航) 的导航表。

---

## 1. 装完先验证（30 秒）

四个命令名是**同一个入口**，随便用哪个都行：`khy` / `khy-os` / `khy-quant` / `khyquant`。

```bash
khy preflight     # 四层依赖体检：khy 在 PATH / Node≥20 / npm / 后端 node_modules / 全局 claude
khy where         # 打印真实安装位置（Python 启动器 / bundle / backend 目录 / 依赖是否就绪）
```

- `preflight` 退出码 `0` = 全过；有 `fail` 会**打印可直接粘贴的修复命令**。
- 首次跑 `khy`（非 `--help`/`--version`）会自动补齐 Node 依赖、生成 `.env`、初始化数据库——**这一步无需手动**。若想手动重跑自愈：`khy postinstall`（运行时依赖）/ `khy dev-setup`（开发工具链）。

> 卡在依赖？`khy preflight` 的输出就是你的修复脚本。不用猜。

---

## 2. 配置写在哪里（一次搞懂，后面都用得上）

| 你改的东西 | 写到哪 | 怎么改 | 是否需重启 |
|---|---|---|---|
| **网关 / 模型 / Provider / Key** | `backend/.env`（+ 镜像 `services/.env`） | 优先用 `khy gateway config`（交互）或 `khy gateway add`（一条命令）——它们**自动写 .env 并同步当前进程** | 否，写入即生效 |
| **路径 / 学习 / 界面类开关** | 你自己的 shell（`export`）或 `backend/.env` | 直接 `export KHY_XXX=...` 或写进 `.env` | shell 变量当场生效 |
| **CLI / TUI 用户设置** | `~/.khy/settings.json` | 交互界面里改，或编辑该文件 | 否 |
| **网关 bearer token** | `~/.khy/proxy_server_auth.json` | 自动生成；多租户在此扩展 | — |
| **API Key 池 / 自定义 Provider 元数据** | `~/.khyquant/api_keys.json`、`custom_providers.json` | 由 `khy gateway add` 写入 | — |
| **国内代理 / Clash** | `~/.khyquant/proxy.json` | 见 [§3-E](#e国内网络--代理clash) | — |

要点：

- **数据主目录**优先 `~/.khy`（旧数据在 `~/.khyquant`）。想换位置：`export KHY_DATA_HOME=/your/path`。
- **网关相关的 env 不必手改 .env**——`khy gateway` 系列命令会替你写好并即时生效。手改 .env 适合「路径 / 学习 / 界面」这类开关。
- 想换 `.env` 文件路径：`export KHY_ENV_FILE=/path/to/.env`。

---

## 3. 我想要……（场景导航）

| 我想要的体验 | 去这一节 | 一句话 |
|---|---|---|
| 零成本、全本地、不联网、不花钱 | [A](#a零成本全本地ollama) | 接本地 Ollama |
| 接云端大模型（自带 API Key / 第三方中转） | [B](#b接云端大模型自定义-provider) | `khy gateway add` 一条命令 |
| 复用我电脑上已装的 IDE（Kiro/Cursor/Windsurf/Warp/Trae） | [C](#c复用已装的-ide-账号) | `khy gateway detect` 自动发现 |
| 想用 Claude Code，但走 KHY 网关 | [D](#d用-claude-code-但走-khy-网关) | `khy claude` |
| 我在国内，网络要走代理 | [E](#e国内网络--代理clash) | `~/.khyquant/proxy.json` 或 `HTTPS_PROXY` |
| 我用顶级模型（Opus/GPT-5…），想要精简脚手架 | [F](#f顶级模型解锁精简脚手架) | `KHY_MODEL_TIER_MAP` |
| 我想系统学习 KHY-OS 自己的知识 | [G](#g学习-khy-os-知识learn-三模式) | `/learn` 三模式 |
| 手机 / 局域网访问 Web 管理 | [H](#h手机--局域网访问) | `khy mobile` |
| 调界面：全 TUI、输出风格、语言 | [I](#i界面体验全-tui--风格--语言) | 几个 `KHY_` 开关 |
| 多人共用一套网关（多租户） | [J](#j多租户网关) | per-user token + 账号池 |

> 大多数人只需要 **A 或 B 之一** + 可能加 **E**（国内）。其余按需。

---

### A：零成本、全本地（Ollama）

**适合**：不想花钱、不想联网、隐私优先。

1. 装好 [Ollama](https://ollama.com) 并拉一个模型，例如 `ollama pull qwen2.5:7b`。
2. 让 KHY 指向它（默认就是本地 11434，多数情况无需配）：
   ```bash
   export OLLAMA_HOST=http://localhost:11434
   export OLLAMA_MODEL=qwen2.5:7b        # 不设则用内置默认
   ```
3. 让网关认到本地通道并按机器性能调参：
   ```bash
   khy gateway detect        # 自动发现本地/已装通道
   khy gateway tune-local auto apply   # 按本机能力调本地模型参数（可选）
   khy gateway status        # 确认本地通道可用
   ```

之后 `khy` 交互、`khy -p "..."` 一次性问答全部走本地模型，**零外网、零费用**。

---

### B：接云端大模型（自定义 Provider）

**适合**：想要高质量回答，自带 OpenAI/Anthropic 兼容 Key 或第三方中转。

**最快路径——一条命令**（非交互，可写脚本）：

```bash
khy gateway add \
  --name "my-provider" \
  --base-url "https://your-endpoint/v1" \
  --api-key "sk-xxxx" \
  --model-id "your-model-id" \
  --extra-models "model-a,model-b" \
  --tier T0           # 顶级模型才设；普通模型省略
```

这条命令会自动：写入 Key 池（`~/.khyquant/api_keys.json`）+ Provider 元数据（`custom_providers.json`）+ 把路由/默认模型合并进 `.env`——**立即可用，无需重启**。

**想要交互式引导**（在终端里一步步选）：

```bash
khy gateway config        # 交互配置 API / 桥接通道（需要 TTY）
khy gateway model         # 选当前默认模型
khy gateway test my-provider   # 实测这条通道能否打通
```

**内置预设**：自定义 Provider 自带 **Agnes AI** 预设（端点 `https://apihub.agnes-ai.com/v1`，默认 `agnes-2.0-flash`），`khy gateway config` 里可一键选用。详见 [网关 — 自定义 provider 配置（Agnes）](%5BOPS-MAN-032%5D%20网关-自定义provider配置-agnes.md)。

---

### C：复用已装的 IDE 账号

**适合**：你电脑已装 Kiro / Cursor / Windsurf / Warp / Trae，想直接复用它们的登录态，不想再配 Key。

```bash
khy gateway detect        # 扫描已装 IDE，自动导入凭据
khy gateway status        # 看哪些适配器实测通过
khy gateway model         # 在可用通道里选模型
```

- 多数 IDE 凭据从其安装目录**自动导入**，通常无需设 env。
- 若默认不允许复用导入的凭据，显式开启：`export KHY_GATEWAY_ALLOW_IMPORTED_CREDENTIALS=1`。
- 微调单个适配器（以 Kiro 为例）：`KIRO_PROXY_URL` / `KIRO_AUTO_PROXY` / `KIRO_INJECT_CLAUDE_MODELS` 等；其余适配器同构。

---

### D：用 Claude Code，但走 KHY 网关

**适合**：习惯 Claude Code 命令行，但想让它走 KHY 的本地代理 / 模型池。

```bash
khy claude --list           # 列出可选模型
khy claude --model <id>     # 指定模型启动 Claude Code（自动起代理、注入代理 env）
khy claude --hybrid         # 混合模式
khy claude --hybrid-sub     # 混合子代理模式
```

- KHY **默认不会改写** `~/.claude/settings.json`，只在内存里注入代理环境变量。
- 若你确实想让 KHY 托管 settings.json：`export KHY_ALLOW_WRITE_CLAUDE_SETTINGS=1`（默认关，保守）。
- 四种使用模式与路由细节见 [Claude Code 代理配置](%5BOPS-MAN-004%5D%20claude-code-代理配置.md)。

---

### E：国内网络 / 代理（Clash）

**适合**：直连访问不稳，需要走代理。两种方式任选其一。

**方式一——KHY 托管代理（推荐，搜索/抓取/网关统一走）**：编辑 `~/.khyquant/proxy.json` 配好你的代理，启用后 KHY 会自动把 `HTTP(S)_PROXY` / `ALL_PROXY` / `NO_PROXY` 注入到所有出站请求（含浏览器搜索）。

**方式二——标准环境变量**：
```bash
export HTTPS_PROXY=http://127.0.0.1:7890   # Clash 默认端口示例
export HTTP_PROXY=http://127.0.0.1:7890
export NO_PROXY=localhost,127.0.0.1
```

**搜索路径开关**（联网搜索体验）：
```bash
export KHY_SEARCH_MODE=auto       # auto=请求优先,空则浏览器 | request=只用请求 | playwright=强制浏览器
```

---

### F：顶级模型解锁精简脚手架

**适合**：你用的是 frontier 模型（Opus 4.x / GPT-5 / Grok-4 / o3 等），希望少注入「教模型怎么做」的脚手架，让模型自由发挥。

KHY 会按模型自动分级（T0 frontier → T3 weak），**仅 T0 放松脚手架**。多数知名 frontier 模型已自动识别为 T0。若你的模型 ID 没被自动识别（如自建中转改了名）：

```bash
# 逐模型指定档位（精确匹配模型 ID，大小写不敏感）
export KHY_MODEL_TIER_MAP='{"your-model-id":"T0"}'

# 或全局强制一个档位（最高优先级，慎用）
export KHY_CAPABILITY_TIER=T0
```

T0 效果：精简提示词（`lean`）、关闭「继续干」型 nudge、能力门 `warn` 而非 `hard`、放开思维强度。普通模型保持完整脚手架即可，无需配。

> 用 `khy gateway add ... --tier T0` 注册时即可一并设好，省去这一步。

---

### G：学习 KHY-OS 知识（/learn 三模式）

**适合**：想系统理解 KHY-OS 自研内核、agent⇄OS 协同、网关等自有知识。`/learn` **三种条件下都能学**，形成知识闭环：

| 模式 | 条件 | 你需要配什么 | 体验 |
|---|---|---|---|
| **模式 1** | 本地、无网、无模型 | **什么都不用配** | 词法检索 + 离线交互，开箱即学 |
| **模式 2** | 有网、无模型 | `KHY_LEARN_DOCS_BASE_URL` | 自动补取本地缺失的文档再讲 |
| **模式 3** | 有网 + 有模型 | 模式2 基础上加 `KHY_LEARN_EMBED_URL` | 词法 + **向量重排**，AI 讲解，召回更准 |

```bash
# 模式1：直接用，无需配
learn            # 看课程层级
learn 11         # 进入某一层（如「内核与 Agent 协同」）
learn 11.8       # 进入具体知识点
learn check      # 校验课程文件引用完整性

# 模式2：联网补取缺失文档（远端按需配置，默认不开启 git 推导）
export KHY_LEARN_DOCS_BASE_URL="https://your-raw-docs-base/"

# 模式3：开启向量重排，提高 RAG 召回（端点可达才生效，不可达自动降级到词法）
export KHY_LEARN_EMBED_URL="http://localhost:11434/api/embeddings"   # ollama 风格
export KHY_LEARN_EMBED_MODEL="nomic-embed-text"
```

进入 `/learn` 时顶部会打一行**诚实的模式横幅**（如「📡 模式3 · 有网络有模型 · 检索 N 段」），告诉你当前实际处于哪种模式。其余可调项（`KHY_LEARN_RAG` 总开关、`KHY_LEARN_TOPK` 片段数等）默认即合理，按需微调。

> 向量端点也可不单独配——若你已配好 KHY 网关，模式3 会自动复用网关的 `/v1/embeddings`。

---

### H：手机 / 局域网访问

**适合**：想在手机或同局域网另一台机器上访问 KHY 的 Web 管理 / AI 网关页。

```bash
khy mobile               # 生成终端二维码，手机同局域网扫码即可访问（默认 /admin/ai-gateway）
khy mobile 9090          # 指定端口
khy mobile 0.0.0.0:9090  # 指定主机:端口
```

- 默认管理端口 `9090`（`export KHY_DAEMON_PORT=9090` 可改）。
- **改默认管理口令**（安全起见建议设置）：`export KHY_ADMIN_PASSWORD='your-strong-password'`。
- 远程（公网/域名）部署见 [移动端远程指南](%5BOPS-MAN-030%5D%20移动端远程指南.md) 与 [部署指南](../06_DEPLOY_部署/%5BDEPLOY-MAN-016%5D%20部署指南-域名.md)。

---

### I：界面体验（全 TUI / 风格 / 语言）

```bash
export KHY_FULL_TUI=1            # 默认开；=0 回退经典模式（某些未移植到 TUI 的高级命令需要经典模式）
export KHY_OUTPUT_STYLE=senior-engineer   # 输出风格（默认资深工程师风）
export KHY_LANGUAGE=zh           # 强制回复语言（留空=跟随上下文）
```

- 遇到旧版权限弹窗需求：`export KHY_LEGACY_PERMISSION_UI=1`。
- 这些都是纯界面偏好，不影响模型/网关，随用随调。

---

### J：多租户网关

**适合**：一套 KHY 网关给多个用户/客户用，各自隔离 token 与账号。

- 每用户的网关凭据存 `~/.khy/proxy_server_auth.json`，账号配额走账号池（SQLite `account_pool_config`）。
- 管理与隔离能力在 Web 管理页（`khy gateway manage open --daemon`）操作。
- 详细架构见 [pip 安装后 — 完整功能清单](%5BOPS-MAN-023%5D%20pip安装后-完整功能清单.md) 的「AI 网关与管理」小节。

---

## 4. 组合示例（几种典型用户的最小配置）

**① 极简离线党**（不花钱、不联网）
```bash
export OLLAMA_MODEL=qwen2.5:7b
khy gateway detect && khy gateway status
```

**② 云端高质量党**（自带顶级模型 Key）
```bash
khy gateway add --name pro --base-url https://ep/v1 --api-key sk-xxx --model-id big-model --tier T0
khy gateway model
```

**③ 国内省心党**
```bash
# 编辑 ~/.khyquant/proxy.json 配好代理，或：
export HTTPS_PROXY=http://127.0.0.1:7890
export KHY_SEARCH_MODE=auto
khy gateway add --name pro --base-url https://ep/v1 --api-key sk-xxx --model-id big-model
```

**④ Claude Code 党**
```bash
khy claude --list
khy claude --model <id>
```

**⑤ 探索内核党**（系统学 KHY-OS）
```bash
export KHY_LEARN_EMBED_URL=http://localhost:11434/api/embeddings   # 有 Ollama 时提升召回
learn 11
```

---

## 5. 配错了 / 没生效？怎么自查

| 现象 | 自查命令 | 说明 |
|---|---|---|
| 不确定装在哪、依赖齐不齐 | `khy where` / `khy preflight` | 打印真实路径 + 依赖体检 |
| 模型不回应 / 通道报错 | `khy gateway status` | 看每条通道实测结果与失败原因 |
| 想看某次请求为什么偏航 | `khy gateway status --json` / `khy gateway trace <requestId>` | 回查首段与最终答复 |
| 通道实测失败 | `khy gateway test <adapter>` | 单独复测一条通道 |
| `/learn` 不知处于哪种模式 | 进 `learn` 看顶部**模式横幅** | 如实显示模式1/2/3 与是否用了向量 |
| 改了 env 没生效 | 用 `khy gateway` 系列命令改（自动同步进程）；shell `export` 需在同一会话 | 网关 env 别只手改 .env |

**核心原则**：KHY 的状态都是**如实显示**的——`preflight`/`gateway status`/学习模式横幅都不会假装成功。看它们的真实输出，按提示修。

---

## 相关文档

- [快速开始 — 安装与使用](%5BOPS-MAN-027%5D%20快速开始.md)：第一次装的总流程
- [pip 安装后 — 完整功能清单](%5BOPS-MAN-023%5D%20pip安装后-完整功能清单.md)：功能逐项参考手册
- [pip — 安装布局参考](%5BOPS-MAN-022%5D%20pip-安装布局参考.md)：安装目录结构与源码映射
- [网关 — 自定义 provider 配置（Agnes）](%5BOPS-MAN-032%5D%20网关-自定义provider配置-agnes.md)
- [Claude Code 代理配置](%5BOPS-MAN-004%5D%20claude-code-代理配置.md)
- [移动端远程指南](%5BOPS-MAN-030%5D%20移动端远程指南.md) / [部署指南 — 域名](../06_DEPLOY_部署/%5BDEPLOY-MAN-016%5D%20部署指南-域名.md)
