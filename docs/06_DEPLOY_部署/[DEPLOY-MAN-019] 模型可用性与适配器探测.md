<!-- 文档分类: DEPLOY-MAN-019 | 阶段: 部署 | 原路径: COMPLETE_DEPLOYMENT_GUIDE.md（根目录归档） -->
# 模型可用性与适配器探测

> 回答一个问题：**`/model` 菜单是空的，为什么，怎么修。**
>
> 结论先写在这里：**不是「适配器没启用」**。18 个适配器在网关构造时全部 `enabled: true`，
> 空菜单的真实原因是**每个适配器的 `detect()` 都返回了 false** —— 也就是运行环境里
> 既没有可用的 IDE CLI、也没有 API Key、也没有本地模型服务。
>
> **归档来源**：本文由根目录 `COMPLETE_DEPLOYMENT_GUIDE.md` 重写而成（归档日期 2026-08-15）。
> 原文是会话产物（带具体机器路径、「告诉我诊断脚本的输出」式对话口吻），且**把「适配器启用」
> 与「适配器可用」混为一谈**，据此给出的 `GATEWAY_OPENAI_ENABLED=true` 一类配置在代码中
> 并不存在。本文按代码实测重写。
>
> 实现依据（核实来源）：
> - 适配器清单与优先级：`services/backend/src/services/gateway/aiGateway.js`（`AIGateway` 构造函数）
> - 开关与探测编排：`services/backend/src/services/gateway/aiGatewayRoutingMethods.js`
> - 各适配器 `detect()`：`services/backend/src/services/gateway/adapters/*.js`
> - 模型清单构建：`services/backend/src/cli/handlers/gatewayModelChoices.js`

---

## 一、两个概念必须分开：enabled ≠ available

网关初始化分两拍：

```
① enabled —— 这个适配器要不要参与探测
     18 个适配器在构造函数里一律写死 enabled: true
     只有环境变量显式设成字符串 "false" 才会被关掉（见第三节）

② available —— 探测后它到底能不能用
     对每个 enabled 的适配器并行调用 detectAsync() ?? detect()
     单个探测超时 GATEWAY_INIT_TIMEOUT_MS（默认 15000ms）
     超时或抛错 → available = false（静默，不阻断其他适配器）
```

`/model` 只列出 **available === true** 的适配器的模型。所以：

- **把某个 `GATEWAY_*_ENABLED` 设成 `true` 不会让菜单多出东西** —— 它本来就是 enabled。
- 要让菜单有内容，必须让至少一个适配器的 `detect()` 通过，也就是**在环境里补上它要找的东西**。

---

## 二、适配器优先级与探测条件

`aiGateway.js` 构造函数里的完整清单，按 `priority` 升序（数字小者优先被自动选中）：

| priority | key | 分组 | `detect()` 找什么 |
| --- | --- | --- | --- |
| 0 | `kiro` | 云端结构化 | Kiro 凭据 |
| 1 | `cursor` | 云端结构化 | Cursor token 文件（或账号池里的 pool token） |
| 2 | `trae` | 云端结构化 | Trae 凭据 / `TRAE_API_KEY` |
| 3 | `claude` | 云端结构化 | `claude` 命令存在（PATH 或便携版 `~/.khy/tools`） |
| 4 | `codex` | 云端结构化 | Codex 凭据 |
| 5 | `api` | 云端结构化 | MultiFreeService 有可用 provider，或 `apiKeyPool` 里有可用 key |
| 6 | `windsurf` | IDE 桥接 | Windsurf 安装路径 + token |
| 7 | `vscode` | IDE 桥接 | VS Code + Copilot |
| 8 | `warp` | IDE 桥接 | Warp 凭据 |
| 9 | `cursor2api` | IDE 桥接 | Cursor token（走 API 化通道） |
| 10 | `relay_api` | IDE 桥接 | 中继 API 配置 |
| 11 | `ollama` | 本地模型 | `GET /api/tags` 探活（默认 `http://localhost:11434`） |
| 12 | `localLLM` | 本地模型 | LocalLLM 服务在跑 |
| 13 | `cli` | 辅助通道 | 通用 CLI 工具 |
| 14 | `relay` | 辅助通道 | Web 中继 |
| 15 | `clipboard` | 辅助通道 | 剪贴板中继 |
| 16 | `opencode` | 定向指挥 | opencode 二进制（**刻意置于低位**，不抢占自动回退） |
| 17 | `openclaw` | 定向指挥 | 门控 `KHY_OPENCLAW` **默认关**，关闭时 `detect()` 恒为 false |

> 分组注释在代码里写得很清楚：云端结构化适配器有原生 `tool_use`，最可靠；IDE 桥接依赖 IDE 进程，
> 次可靠；本地模型 function calling 弱或缺失，所以排在最后。`opencode` / `openclaw` 有自己的
> provider/model 配置，属「定向指挥」类，**不应成为通用聊天的默认回退**，因此排在自动优先级最末；
> 显式 `preferredAdapter: 'opencode'` 走定向路由，不受此顺序影响。

**只要有任意一个适配器 available，`/model` 就有内容。** 不需要凑齐多个。

---

## 三、`GATEWAY_<KEY>_ENABLED` 是**关闭开关**，不是开启开关

代码里这组变量名是**用模板拼出来的**（`` `GATEWAY_${ideKey.toUpperCase()}_ENABLED` ``），
判定条件是 `=== 'false'`：

```js
// aiGatewayRoutingMethods.js
for (const ideKey of ['kiro','cursor','trae','claude','codex','windsurf','vscode','warp','cursor2api']) {
  const envKey = `GATEWAY_${ideKey.toUpperCase()}_ENABLED`;
  if (process.env[envKey] === 'false') { entry.enabled = false; }
}
```

由此可得三条事实：

1. **存在**且生效的 kill switch：`GATEWAY_KIRO_ENABLED`、`GATEWAY_CURSOR_ENABLED`、
   `GATEWAY_TRAE_ENABLED`、`GATEWAY_CLAUDE_ENABLED`、`GATEWAY_CODEX_ENABLED`、
   `GATEWAY_WINDSURF_ENABLED`、`GATEWAY_VSCODE_ENABLED`、`GATEWAY_WARP_ENABLED`、
   `GATEWAY_CURSOR2API_ENABLED`，另有独立三个 `GATEWAY_CLI_ENABLED`、
   `GATEWAY_OLLAMA_ENABLED`、`GATEWAY_RELAY_ENABLED`。
2. **只有字符串 `"false"` 有效果**。设 `true`、`1`、`yes` 一律等同于不设——因为默认已经是开。
3. **不存在**的变量（归档来源里写过、实测全仓无此名）：`GATEWAY_OPENAI_ENABLED`、
   `GATEWAY_CLAUDE_API_ENABLED`、`GATEWAY_DEEPSEEK_ENABLED`、`GATEWAY_OPENAI_API_KEY`、
   `GATEWAY_CLAUDE_API_KEY`、`GATEWAY_OLLAMA_BASE_URL`。设它们**不会有任何效果**。
   OpenAI / Claude API / DeepSeek 一类云端供应商走的是 `api` 适配器，读的是**不带 `GATEWAY_` 前缀**
   的标准 key 名（见 `[DEPLOY-MAN-020]`）。

**典型用法**：临时排除某个探测很慢的通道，而不是「打开」它。

```powershell
$env:GATEWAY_WINDSURF_ENABLED = "false"   # 本机没装 Windsurf，省掉这次探测
$env:GATEWAY_VSCODE_ENABLED   = "false"
khy
```

---

## 四、让菜单有内容：三条最短路径

按上手难度排序。三条都不需要改任何 `GATEWAY_*_ENABLED`。

### 路径 1：Ollama（本地、免费、无 key）

```powershell
# 1) 装 Ollama：https://ollama.com/download
# 2) 拉一个模型
ollama pull llama3.2
# 3) 确认服务在跑（detect 就是打这个接口）
curl http://localhost:11434/api/tags
# 4) 起 khy → /model
khy
```

非默认端口用 `OLLAMA_HOST` 指过去（**不是** `GATEWAY_OLLAMA_BASE_URL`）。详见 `[DEPLOY-MAN-020]` 第二节。

### 路径 2：IDE 桥接（用 IDE 已有的配额）

正在用 Claude Code / Cursor / Windsurf / VS Code 的话，桥接是零成本的——`detect()` 找的
就是这些 IDE 已经落在磁盘上的 CLI 或 token。配置细节与各 IDE 的 token 位置见 `[DEPLOY-MAN-021]`。

最短检查：

```powershell
claude --version        # claude 适配器 detect() 就是查这个命令
```

### 路径 3：API Key（`api` 适配器）

在环境里放一个受支持的供应商 key，`api` 适配器的 `detect()` 就会通过。key 名清单与
配置方式见 `[DEPLOY-MAN-020]` 第三节。

> 红线：**真 key 只经环境变量瞬时注入，绝不写进源码、配置模板或提交**。本文与
> `[DEPLOY-MAN-020]`/`[DEPLOY-MAN-021]` 里出现的一切 key、secret 都是占位符。

---

## 五、诊断顺序

```powershell
khy                     # 进 CLI
gateway status          # 逐通道看 enabled / available，这是第一现场
gateway test claude     # 单通道连通性 + 生成测试
gateway config          # 交互式改网关配置（会写 .env）
```

`gateway status` 才是判断依据：它把 enabled 与 available 分列出来，直接告出
「是被关掉了」还是「探测没通过」。

| 现象 | 读法 | 处理 |
| --- | --- | --- |
| 所有通道 available=false | 环境里没有任何可用凭据/服务 | 走第四节任一路径 |
| 某通道 enabled=false | 有人设了 `GATEWAY_<KEY>_ENABLED=false` | 取消该环境变量 |
| `/model` 很久才出 | 逐个适配器探测累加 | 见 `docs/_报告/历史/2026-08-根目录归档-修复记录.md` 第二节的 `KHY_MODEL_*` 超时开关 |
| 探测阶段整体挂住 | 单适配器探测超时兜底 | 调低 `GATEWAY_INIT_TIMEOUT_MS`（默认 15000ms，下限 3000ms） |

---

## 关联

- AI 供应商与 API Key 配置：`[DEPLOY-MAN-020] AI供应商与APIKey配置`
- IDE 桥接模式：`[DEPLOY-MAN-021] IDE桥接模式`
- `/model` 慢与 `KHY_MODEL_*` 超时开关：`docs/_报告/历史/2026-08-根目录归档-修复记录.md`
- 首次运行自动登录：`docs/07_OPS_运维/[OPS-MAN-175] 首次运行自动登录与凭据.md`
- 环境开关命名规范：`docs/07_OPS_运维/[OPS-MAN-058] 环境开关与文档命名规范.md`
