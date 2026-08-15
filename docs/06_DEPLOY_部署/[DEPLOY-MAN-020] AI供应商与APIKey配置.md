<!-- 文档分类: DEPLOY-MAN-020 | 阶段: 部署 | 原路径: AI_MODEL_SETUP_GUIDE.md（根目录归档） -->
# AI 供应商与 API Key 配置

> 给 Khy-OS 接上一个能出 token 的模型来源：**本地 Ollama**、**云端 API Key**，或
> **IDE 桥接**（后者见 `[DEPLOY-MAN-021]`）。本文只讲前两条。
>
> 读本文前先读 `[DEPLOY-MAN-019]` 第一节：**「适配器 enabled」与「适配器 available」是两件事**，
> 空的 `/model` 菜单是后者的问题。本文讲的就是怎么让 `detect()` 通过。
>
> **归档来源**：本文由根目录 `AI_MODEL_SETUP_GUIDE.md` 重写而成（归档日期 2026-08-15）。
> 原文的三份 `.env` 示例里**内联了一份真实 `JWT_SECRET`**，且大部分变量名（`GATEWAY_OPENAI_ENABLED`、
> `GATEWAY_OPENAI_API_KEY`、`GATEWAY_CLAUDE_API_KEY`、`GATEWAY_OLLAMA_BASE_URL`、
> `GATEWAY_DEEPSEEK_ENABLED`）在代码中**不存在**。本文按代码实测重写，示例一律用占位符。
>
> 实现依据（核实来源）：
> - 供应商 key 清单：`services/backend/src/services/multiFreeService.js`、`src/services/apiKeyPool.js`
> - `api` 适配器探测：`services/backend/src/services/gateway/adapters/apiAdapter.js`
> - Ollama 适配器：`services/backend/src/services/gateway/adapters/ollamaAdapter.js`、`src/constants/serviceDefaults.js`
> - JWT 密钥自供给：`services/backend/src/bootstrap/ensureAuthSecret.js`
> - 网关配置写入：`services/backend/src/cli/handlers/gatewayConfigEditor.js`

---

## 一、先别手写 `.env`

两条能省掉大部分踩坑的事实：

**① `JWT_SECRET` 不需要你配。** `ensureAuthSecret.js` 是它的单一真源，解析顺序为
`process.env` → 规范 `.env` 文件 → **自动生成一个强随机值并持久化**。生成是一次性事件，
之后每次启动都读回同一个值，已签发的 token 继续有效。**手写 `JWT_SECRET` 没有必要，
把它抄进文档或提交则直接违反红线 R2。**

**② 优先用 `gateway config`，而不是手动编辑 `.env`。**

```powershell
khy
gateway config          # 交互式；写入由 gatewayEnvFile 统一管理（规范文件 + 镜像）
```

手写 `.env` 时容易漏掉镜像文件，也容易写出根本不存在的变量名（归档来源就是这么错的）。
规范 env 文件路径由 `KHY_ENV_FILE` 决定，默认 `services/backend/.env`；
该文件与 `services/backend/src/.env` **都已在 `.gitignore` 内**，实测未被跟踪。

`services/backend/.env.example` 是可以放心参考的模板（其中 `JWT_SECRET=` 刻意留空）。

---

## 二、Ollama（本地、免费、无 key）

个人开发与高隐私场景的首选：数据不出本地，无需 API Key。

```powershell
# 1) 安装：https://ollama.com/download
# 2) 拉模型
ollama pull llama3.2          # 小、快，够用
ollama pull qwen2.5           # 中文更好

# 3) 确认服务在跑 —— detect() 打的就是这个接口
curl http://localhost:11434/api/tags

# 4) 起 khy 选模型
khy
# CLI 内：/model
```

**不需要**设任何变量。默认端口 `11434` 写在 `src/constants/serviceDefaults.js` 的 `OLLAMA_HOST`。

| 变量 | 作用 | 备注 |
| --- | --- | --- |
| `OLLAMA_HOST` | 指向非默认地址的 Ollama | **注意名字**：不带 `GATEWAY_` 前缀，`gateway config` 里改也是写这个 |
| `OLLAMA_MODEL` | 默认模型名 | |
| `OLLAMA_AUTO_START` | 设 `false` 关掉自动拉起 Ollama 进程 | 默认开 |
| `GATEWAY_OLLAMA_ENABLED` | 设 `"false"` **关掉** ollama 通道 | 只有字符串 `false` 有效；不是开启开关 |
| `KHY_OLLAMA_NUM_PREDICT` | 生成 token 上限 | |
| `GATEWAY_OLLAMA_COLD_TIMEOUT_MS` / `_WARM_TIMEOUT_MS` / `_DEGRADED_TIMEOUT_MS` / `_SMALL_TASK_TIMEOUT_MS` | 分档超时 | 冷启动比热请求慢得多，故分档 |

**排查**：

```powershell
ollama list                                  # 服务在不在
curl http://localhost:11434/api/tags         # 端口对不对
```

`gateway status` 里 ollama 仍是 unavailable，而 `curl` 通 —— 检查是不是设了
`GATEWAY_OLLAMA_ENABLED=false`，或 `OLLAMA_HOST` 指到了别处。

---

## 三、云端 API Key（走 `api` 适配器）

**没有 per-provider 的 `GATEWAY_*_ENABLED` 开关**。云端供应商统一由 `api` 适配器
（priority 5）承载，它的 `detect()` 逻辑是：

```
MultiFreeService 有可用 provider？        → available
否则 apiKeyPool 里任一 provider 有可用 key？ → available
否则                                      → unavailable
```

也就是说：**环境里放上 key，通道自己就亮了**，不需要额外「启用」动作。

### 3.1 受支持的 key 变量名（实测清单）

`multiFreeService.js` / `apiKeyPool.js` 里读取的环境变量，**均不带 `GATEWAY_` 前缀**：

| 供应商 | 变量 |
| --- | --- |
| OpenAI | `OPENAI_API_KEY`（配套 `OPENAI_BASE_URL` / `OPENAI_API_ENDPOINT`） |
| Anthropic / Claude | `ANTHROPIC_API_KEY`（配套 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_ENDPOINT` / `ANTHROPIC_AUTH_TOKEN`） |
| DeepSeek | `DEEPSEEK_API_KEY`（配套 `DEEPSEEK_BASE_URL`） |
| Google Gemini | `GEMINI_API_KEY` / `GOOGLE_GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Groq | `GROQ_API_KEY` |
| 智谱 | `ZHIPU_API_KEY` |
| 阿里云 / DashScope | `ALIBABA_API_KEY` / `DASHSCOPE_API_KEY` |
| 百度 | `BAIDU_API_KEY` |
| 讯飞 | `XUNFEI_API_KEY` |
| Trae | `TRAE_API_KEY` |

Claude 另有 `CLAUDE_API_KEY`，以及一组模型别名变量（`ANTHROPIC_DEFAULT_OPUS_MODEL`、
`CLAUDE_OPUS_MODELS`、`CLAUDE_TIER_ALIASES` 等）用于把分层名映射到具体模型 id。

### 3.2 配置方式

```powershell
# 推荐：交互式，写入由 gatewayEnvFile 统一管理
khy
gateway config

# 或本机会话内瞬时注入（不落盘，最安全）
$env:OPENAI_API_KEY = "<你的 key>"
khy
```

> **红线 R2**：真 key / token **永不进 bundle、源码、提交**，只经环境变量瞬时注入。
> 本文所有 key 都是占位符 `<...>`。不要把真 key 写进任何被 git 跟踪的文件，也不要
> 贴进 issue 或聊天记录。

### 3.3 排查

```powershell
khy
gateway status              # api 通道 available 了吗
gateway test api            # 对 apiKeyPool 里每个 provider 的 endpoint 做 HTTP 连通测试
```

`gateway test api` 走的是 `detectAsync()`，会真的打一次 endpoint。常见失败原因按概率排序：
key 拼错 / 账户无余额 / 网络到不了该供应商 / `*_BASE_URL` 指到了错误的中转地址。

手工验证某个供应商是否可达（以 OpenAI 为例，key 从环境读，不写进命令行历史）：

```powershell
curl https://api.openai.com/v1/models -H "Authorization: Bearer $env:OPENAI_API_KEY"
```

---

## 四、怎么选

| 场景 | 建议 | 理由 |
| --- | --- | --- |
| 个人开发 / 试用 | Ollama，或 IDE 桥接 | 零成本，无 key 管理负担 |
| 高隐私要求 | 仅 Ollama | 数据不出本地 |
| 生产环境 | 云端 API Key | 稳定性与模型完整度优于桥接；桥接依赖 IDE 进程存活 |
| 多来源并存 | 直接都配上 | 网关按 `[DEPLOY-MAN-019]` 第二节的 priority 自动挑；要固定用某个，设 `GATEWAY_PREFERRED_ADAPTER` |

多来源并存时的固定优先项：

```powershell
$env:GATEWAY_PREFERRED_ADAPTER = "<adapter key>"   # 如 ollama / api / claude
$env:GATEWAY_PREFERRED_MODEL   = "<model id>"
$env:GATEWAY_PREFERRED_STRICT  = "true"            # 只用首选，不回退
```

---

## 五、常用命令

```powershell
gateway status          # 各通道 enabled / available（诊断第一现场）
gateway config          # 交互式改网关配置
gateway test <key>      # 单通道连通性 + 生成测试，如 gateway test ollama
/model                  # 选模型
```

---

## 关联

- 模型可用性与适配器探测（先读）：`[DEPLOY-MAN-019] 模型可用性与适配器探测`
- IDE 桥接模式：`[DEPLOY-MAN-021] IDE桥接模式`
- `/model` 慢与 `KHY_MODEL_*` 超时开关：`docs/_报告/历史/2026-08-根目录归档-修复记录.md`
- 环境开关命名规范：`docs/07_OPS_运维/[OPS-MAN-058] 环境开关与文档命名规范.md`
- 首次运行自动登录与凭据：`docs/07_OPS_运维/[OPS-MAN-175] 首次运行自动登录与凭据.md`
