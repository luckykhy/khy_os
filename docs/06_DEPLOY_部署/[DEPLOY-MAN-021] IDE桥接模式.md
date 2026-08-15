<!-- 文档分类: DEPLOY-MAN-021 | 阶段: 部署 | 原路径: IDE_BRIDGE_GUIDE.md（根目录归档） -->
# IDE 桥接模式

> 把 Khy-OS 接到你**已经在用**的 IDE（Claude Code、Cursor、Windsurf、VS Code…），
> 复用 IDE 里的模型配额，**不需要额外 API Key**。
>
> 桥接的核心是**探测已有凭据**：适配器去磁盘上找 IDE 自己落下的 CLI 或 token 文件。
> 因此「启用桥接」这个动作**基本不存在**——装好 IDE 并登录过一次，探测就会通过。
>
> 读本文前先读 `[DEPLOY-MAN-019]` 第一、三节：18 个适配器默认全部 enabled，
> `GATEWAY_<KEY>_ENABLED` 是**关闭开关**而非开启开关。
>
> **归档来源**：本文由根目录 `IDE_BRIDGE_GUIDE.md` 重写而成（归档日期 2026-08-15）。
> 原文内联了一份**真实 `JWT_SECRET`**，并把 `GATEWAY_CLAUDE_ENABLED=true` 一类写法说成
> 「启用桥接的必要步骤」（实为 no-op），Cursor token 路径也与代码不一致。本文按代码实测重写。
>
> 实现依据（核实来源）：
> - 适配器清单与优先级：`services/backend/src/services/gateway/aiGateway.js`
> - 开关与探测编排：`services/backend/src/services/gateway/aiGatewayRoutingMethods.js`
> - 各适配器：`adapters/{claude,cursor,cursor2api,windsurf,vscode,warp,kiro,trae,codex}Adapter.js`
> - IDE 安装探测：`adapters/ideDetector.js`、`adapters/_ideTokenMixin.js`

---

## 一、支持的桥接通道

`[DEPLOY-MAN-019]` 第二节的 18 个适配器里，靠**探测本机 IDE 凭据**工作的是这九个
（`GATEWAY_<KEY>_ENABLED=false` 这组 kill switch 覆盖的正是它们）：

| priority | key | 对应 IDE / 服务 | `detect()` 实际检查什么 |
| --- | --- | --- | --- |
| 0 | `kiro` | Kiro | Kiro 凭据 |
| 1 | `cursor` | Cursor | Cursor 本地 token（`storage.json` / `state.vscdb`），或账号池 pool token |
| 2 | `trae` | Trae | Trae 凭据 / `TRAE_API_KEY` |
| 3 | `claude` | Claude Code | `claude` 命令存在（PATH，或便携版 `~/.khy/tools` 下的 claude） |
| 4 | `codex` | Codex | Codex 凭据 |
| 6 | `windsurf` | Windsurf（Codeium） | Windsurf 安装路径 + storage 里的 `windsurfAuth` / `codeium` token |
| 7 | `vscode` | VS Code + Copilot | Copilot token 形状校验通过 |
| 8 | `warp` | Warp | Warp 凭据 |
| 9 | `cursor2api` | Cursor（API 化通道） | 同 `cursor`，走 API 化路径 |

**只要有一个 available，`/model` 就有内容。** 不必凑齐。

---

## 二、Claude Code 桥接（探测最简单的一条）

`claudeAdapter.detect()` 的全部逻辑就是「`claude` 命令在不在」：

```js
_available = commandExists('claude');
if (!_available && _portableClaudeInstalled()) { _available = true; }
```

所以检查也只有一步：

```powershell
claude --version        # 有输出 → claude 通道会 available
where claude            # 找不到时看 PATH
```

**找不到 `claude` 命令时**：确认 Claude Code 已安装、且 `claude` 在 PATH 中，
并在 Claude Code 里至少完整跑过一次对话（CLI 通常在首次使用时才落到系统）。

`detectAsync()` 比同步版多做一步：**当环境里存在 Anthropic key 时**，额外对 API 根做一次
轻量 GET 验证端点可达（401/405 也算可达，只有超时 / ECONNREFUSED 才判为不可达）。
这是为了让健康检查在用户选中直连模型**之前**就发现端点配错，而不是在生成时才炸。
探测走 `execFile` 而非 `spawnSync`，因此网关初始化不会卡住事件循环。

**桥接失败但命令存在**：多为 Claude Code 未登录或 token 过期。

```powershell
gateway test claude     # 看详细错误
claude auth login       # 重新登录
```

---

## 三、Cursor 桥接

`cursorAdapter` 按序在**多个 home 根**下找这些文件（`buildCursorStoragePaths()` 实测清单）：

```
<home>/.config/Cursor/User/globalStorage/storage.json                      # Linux
<home>/Library/Application Support/Cursor/User/globalStorage/storage.json  # macOS
<home>/AppData/Roaming/Cursor/User/globalStorage/storage.json              # Windows
```

以及同三处目录下的 SQLite 库 `state.vscdb` 与 `state-global.vscdb`（token 存在 DB 里时从这里读）。

**非标准安装位置**：用 `CURSOR_STORAGE_PATHS`（复数，逗号分隔）或 `CURSOR_STORAGE_PATH`
显式追加路径——这两个变量在代码里真实生效。

**找不到 token 时**：打开 Cursor → 确认已登录 → 用一次 AI 功能（让它落盘）→ 重启 khy。

**账号池**：`cursor` 适配器还接受来自账号池的 token（`source` 以 `pool:` 开头）。
本地 token 缺失但池里有可用 token 时，通道仍会 available。

---

## 四、Windsurf / VS Code 桥接

**Windsurf**：`detect()` 先经 `ideDetector` 的 `findInstallation('windsurf')` /
`findDataPath('windsurf')` 定位安装，再从 storage 快照里取 token，接受的键名很宽
（`windsurfAuth.accessToken`、`windsurf.auth.accessToken`、`codeium/accessToken`、
`codeium.auth.accessToken`、裸 `accessToken`），endpoint 同样从快照里读。

找不到时：打开 Windsurf → 确认已登录 Codeium → 用一次 Cascade → 重启 khy。

**VS Code**：`detect()` 只做一件事——读 Copilot token 并校验形状。
所以前提是 VS Code 装了 Copilot 且已登录。

---

## 五、多通道并存与固定首选

启用多个通道时，网关按 `[DEPLOY-MAN-019]` 第二节的 priority 自动挑第一个 available 的。
要固定用某一个：

```powershell
$env:GATEWAY_PREFERRED_ADAPTER = "claude"      # 适配器 key
$env:GATEWAY_PREFERRED_MODEL   = "<model id>"
$env:GATEWAY_PREFERRED_STRICT  = "true"        # 只用首选，不回退
```

反过来，**排除**探测很慢或本机没装的 IDE（这才是 `_ENABLED` 的正确用法）：

```powershell
$env:GATEWAY_WINDSURF_ENABLED = "false"
$env:GATEWAY_VSCODE_ENABLED   = "false"
```

> 只有字符串 `"false"` 有效。设 `"true"` 是 no-op —— 默认已是开。

---

## 六、验证

```powershell
khy
gateway status          # 逐通道 enabled / available，第一现场
gateway test claude     # 单通道连通性 + 生成测试
/model                  # 看模型列表
```

| 现象 | 读法 | 处理 |
| --- | --- | --- |
| 通道 enabled 但 available=false | 探测没找到凭据 | 按第二～四节补上对应 IDE 的登录状态 |
| 通道 enabled=false | 设了 `GATEWAY_<KEY>_ENABLED=false` | 取消该环境变量 |
| 桥接一度可用后失效 | IDE token 过期，或 IDE 进程/登录态变了 | 在 IDE 里重新登录，重启 khy |
| 探测阶段整体很慢 | 逐适配器探测累加 | 关掉本机没装的 IDE 通道；或调 `GATEWAY_INIT_TIMEOUT_MS`（默认 15000ms） |

> 桥接读的是 IDE 落在磁盘上的**真实凭据**。红线 R2 同样适用：不要把探测到的 token 值
> 抄进文档、issue 或提交。排查只需报告「找到 / 没找到」与 `source` 字段，不需要贴 token。

---

## 七、桥接 vs API 直连

| 维度 | IDE 桥接 | API 直连 |
| --- | --- | --- |
| 配置成本 | 几乎为零（探测已有凭据） | 需要申请并注入 key |
| 费用 | 复用 IDE 配额 | 按用量付费 |
| 稳定性 | 依赖 IDE 安装、登录态与 token 有效期 | 更稳定 |
| 模型范围 | 受限于该 IDE 开放的模型 | 供应商全量 |
| 工具调用 | 视通道而定 | 云端结构化适配器有原生 `tool_use` |

**结论**：本机开发用桥接（省事），生产用 API 直连（可控）。两者可以同时配，
用 `GATEWAY_PREFERRED_*` 决定谁优先。API 直连的配置见 `[DEPLOY-MAN-020]`。

---

## 关联

- 模型可用性与适配器探测（先读）：`[DEPLOY-MAN-019] 模型可用性与适配器探测`
- AI 供应商与 API Key 配置：`[DEPLOY-MAN-020] AI供应商与APIKey配置`
- 环境开关命名规范：`docs/07_OPS_运维/[OPS-MAN-058] 环境开关与文档命名规范.md`
- `/model` 慢与 `KHY_MODEL_*` 超时开关：`docs/_报告/历史/2026-08-根目录归档-修复记录.md`
