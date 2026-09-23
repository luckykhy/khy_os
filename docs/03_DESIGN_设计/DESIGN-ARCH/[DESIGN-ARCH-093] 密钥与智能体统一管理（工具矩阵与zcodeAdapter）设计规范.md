# [DESIGN-ARCH-093] 密钥与智能体统一管理（工具矩阵 + zcodeAdapter）设计规范

> 状态：**提案**（P1 代码已落地）· 2026-09-11
> 上位文档：`AGENTS.md`（工程红线）、`[DESIGN-ARCH-071] 通道选择决策矩阵`、`[DESIGN-ARCH-091] 密钥与端点中心管理（KeyManager）GUI设计规范`
> 外部调研源：`farion1231/cc-switch`、`sst/opencode`（docs/config+agents+models）、Claude Code 官方 docs（sub-agents/settings）、`kingsword09/zcode-cli`（CONFIGURATION.md）、`pjpv/zcode-switch`、`smartlizi/zcode-account-switcher`

---

## 1. 目标

**只在 khy 配置一次，全部 Agent 工具跟随。** 上游密钥只存于 khy（`api_keys.json` 池 / `cc_switch.json` 卡片 / ChannelApi 加密行），外部工具（Claude Code / OpenCode / Codex / Gemini / ZCode / Command Code / YCode / DeepSeek / Reasonix…）不再各自持有可管理的凭据与端点；Agent 定义同样以 khy 注册表为 SSoT，按需导出到各工具目录。

## 2. GitHub 调研结论（配置面）

| 工具 | 密钥配置位 | 机制要点 | Agent 定义位 |
|---|---|---|---|
| **Claude Code** | `~/.claude/settings.json` `env` 块（`ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`）或 `~/.claude.json` OAuth | 8 级设置优先级（managed > CLI > 项目 > 用户）；`env` 块承载代理指向 | `~/.claude/agents/*.md`、`.claude/agents/`、plugin、`--agents` JSON；md+YAML frontmatter，**文件热重载** |
| **OpenCode** | `~/.config/opencode/opencode.json` → `provider.<id>.options.apiKey` | 8 级合并（非替换）；**`{env:VAR}`/`{file:path}` 变量替换**（key 可指向外部文件）；`OPENCODE_CONFIG_DIR` 自定义目录；`enabled_providers` 白名单锁死 | `~/.config/opencode/agents/*.md` 或 JSON `agent` 键；frontmatter `description/mode/model/temperature/permission`（tools→permission 映射） |
| **ZCode** | `~/.zcode/cli/config.json`（Win `%USERPROFILE%\.zcode\cli\`）→ `provider.<slot>.options.apiKey/baseURL`，`kind: anthropic\|openai-compatible\|openai` | **登录门**：内联 key 仅在槽位 `zai`/`bigmodel` 下才算「已配置」，其它 id 触发登录向导；**env-only key 不满足登录门**（必须内联非空）；`model.main`+`model.lite` 双角色（lite 管 subagent/轻量）；项目级覆盖 `zcode.json`/`.zcode/config.json`；既有 CLI 侧同槽位 key 总是保留 | Subagent 随 **plugin** 捆绑（`@plugin` 引用 + marketplace），无独立 agent 目录 |
| **cc-switch**（参考设计） | SSoT `~/.cc-switch/cc-switch.db`（SQLite） | 双层存储（SQLite 可同步 + JSON 设备级）；**双向同步**（切换写 live、编辑回填 live）；原子写+10 代备份；本地代理热切换（协议转换/熔断/健康）；「最小侵入」原则 | 统一 MCP/Skills/Prompts 面板跨工具同步 |

## 3. 统一架构：双投递模式

```
             ┌──────────── khy SSoT ────────────┐
 上游 key ◄──┤ api_keys.json 池（轮转/冷却/审计）│
 (仅存 khy)  │ cc_switch.json 卡片 · ChannelApi │
             └───────────────┬──────────────────┘
                             │  khy 本地网关（单 token + 协议转换）
    ┌────────┬────────┬───────┼─────────┬──────────┐
    ▼        ▼        ▼       ▼         ▼          ▼
 claude-code codex  opencode  zcode   gemini    cmdc/ycode
 (env 块)   (toml)  (json)   (json)  (env 块)  (env 引用)
```

- **模式 A 中继（默认推荐）**：各工具 `baseURL` 指向 khy 本地网关 + 单一 khy 令牌。工具侧零上游密钥、零多份配置；换供应商/轮转/故障切换全在 khy 内完成。zcode 的「内联 key」约束在此模式下写入的是**可吊销的网关令牌**而非上游真 key。
- **模式 B 同步（cc-switch 式兜底）**：工具不支持代理时，khy 经 appWriters 原子写 live 配置直连上游；防漂移靠「编辑激活卡片时从 live 回填」（cc-switch 双向同步语义）。
- **Agent 导出**：khy agent 注册表（`agents/index.js` + `~/.khy/agents/*.md`）为 SSoT，按工具字段映射导出 md（CC/opencode 同构：markdown+frontmatter，`tools`→`permission` 映射；zcode 走 plugin 包）；导出文件打 `_khy_managed` 标记，GUI 跟踪漂移。Agent 内 `model` 字段引用 khy 网关模型别名 → 密钥不外泄。

## 4. 工具矩阵（khy 侧现状）

| 工具 | 写入器 | 模式 A | 模式 B | 协议约束（preflight） | Agent 导出 | 会话扫描 |
|---|---|---|---|---|---|---|
| claude-code | `claudeCodeAdapter`（settings.json env 块） | ✅ | ✅ | 任意（代理转换） | ✅（ccAgentBridge 已读） | ✅ |
| codex | `codexWriter`（config.toml + auth.json） | ✅ | ✅ | openai/responses | ⏳ P2 | ✅ |
| opencode | `opencodeAdapter`（opencode.json provider 树） | ✅（`{env:}`/`{file:}` 原生替换） | ✅ | openai/anthropic | ⏳ P2 | ✅ |
| gemini | `geminiCliAdapter`（settings.json env 块） | ✅ | ✅ | — | ⏳ P2 | ✅ |
| command-code | `commandCodeAdapter`（providers.json BYOK，env 引用） | ✅ | ✅ | openai/anthropic/responses | — | ✅ |
| ycode | `ycodeAdapter`（config.json provider 块，env 引用） | ✅ | ✅ | openai/responses | — | ✅ |
| deepseek / reasonix | `deepseekTuiAdapter` / `reasonixAdapter` | ✅ | ✅ | — | — | ✅ |
| **zcode** | **`zcodeAdapter`（本规范 P1）** | ✅ | ⚠️ 内联 key（见 §5） | **openai/anthropic** | ⏳ P2（plugin 包） | ✅（taste 侧） |
| openclaw / coze | adapter 已存在，未入 ccSwitch APPS 表 | ⏳ P2 | ⏳ P2 | — | — | — |

## 5. zcodeAdapter 规范（P1 已实现）

- 位置：`services/backend/src/services/domain/network/externalApps/zcodeAdapter.js`
- 契约对齐其它 adapter：`configPath / list / get / add / remove / usable`，fail-soft、merge-write（只动 `provider.<slot>` 与 `model` 角色，保留 `ui/modelStream/subagents/其它槽位`）、remove 带 confirmed 闸门。
- 关键语义（实证 zcode-cli CONFIGURATION.md）：
  - 槽位白名单 `GATE_SLOTS = ['zai','bigmodel']`（登录门），默认写 `zai`；非白名单槽位**拒绝写入**（写错槽位 = 永远卡在登录向导，比不写更糟）。
  - `kind` 映射：`anthropic`→`anthropic`；`openai`/`openai_responses`→`openai-compatible`（无 gemini/responses 原生 wire）。
  - key 策略差异：zcode 登录门要求 `options.apiKey` **内联非空**（env 引用无效）→ 与 command-code/ycode 的「只写 env 引用」不同；缓解=模式 A 下写 khy 网关令牌 + POSIX 0600 收敛（Windows best-effort）。
  - 无 key 时仍写端点/模型并返回 `warning`（zcode 首启要求登录补齐），**绝不丢既有内联 key**（zcode 官方保留语义）。
  - 模型双角色：`model.main = slot/modelId`、`model.lite = slot/(liteModel||modelId)`；模型引用可含 `provider/model` 前缀，自动取 modelId。
  - 路径：`~/.zcode/cli/config.json`（Win `%USERPROFILE%\.zcode\cli\`），`ZCODE_CLI_CONFIG_FILE` 可覆盖（测试/便携布局）。
- 注册面：`ccSwitch/constants.js` `APPS.ZCODE` + `APP_LABELS`；`appWriters.js` preflight（openai/anthropic 之外拒绝，提示经 khy 代理转换）+ `applyCardToApp` + `detectCardInApp`；`externalApps/index.js` shim 导出。

## 6. 本次修复的预存缺陷（调研附带发现）

1. **ccSwitch 子系统迁移断链**：`usageScan / routeResolver / connectivity / appWriters / apiHandlers / cli handlers ccSwitch.js` 6 处从 `domain/collab/proactiveCollaboration/constants`（只导出协作常量）取 `APPS/PROTOCOLS/APP_LABELS` → 全部 undefined。`usageScan` 模块级 `[APPS.CLAUDE_CODE]` 字面量直接**加载即抛**（`khy cc-switch scan/status/use` 自目录迁移起全部损坏）。已改为 require `domain/config/ccSwitch/constants`（SSoT，与 `store.js` 同源）。
2. `tests/.../externalApps.test.js` require 相对路径少一层（`../../src/...` → 应为 `../../../src/...`），套件自创建起未运行过。已修。
3. 预存（未动，仅记录）：`adapters.test.js` opencode 用例在本机存在 `Tools/opencode/config/opencode.json` 便携布局时被其抢占而失败（测试 env 未设 `OPENCODE_CONFIG`）；coze 降级路径 `add({})` 返回 success:true 使「fail-soft」断言失败。两者属测试可移植性问题，另开 IMPL 记录处理。

## 7. GUI 落点（091 P2 全矩阵）

- 桌面 KeyManager 新增 **工具矩阵 tab**：每工具 × 投递模式（A/B）× 激活卡片 × preflight 结果 × 健康探测（`connectivity.js`）× 反向探测（`detectCardInApp`）一屏可见；zcode 行展示 `zai/bigmodel` 槽位状态与登录门判定。
- **Agent tab**：khy 注册表列表 → 各工具导出状态/漂移标记（`_khy_managed`），导出走 §3 字段映射。
- 网页端：`/agents` 由监控升级为管理页并补 NAV 入口（080 P3.5 并轨）。

## 8. 里程碑与验收

- **P1（本次已落地）**：zcodeAdapter + 6 处 require 修复 + 注册面 + 单测（7 例 zcode + 2 套件导出断言，`check-agent-rules` 12 文件零违规）。
- **P2**：工具矩阵 GUI tab；Agent 导出器（CC/opencode 双目标，字段映射表定稿）；codex/opencode Agent 导出。
- **P3**：zcode plugin 包导出（subagent 捆绑）；openclaw/coze 入 APPS 矩阵；双向同步回填（cc-switch 语义）；测试可移植性修复（§6.3）。

## 9. 红线对照

- 零硬编码：zcode 路径走 `os.homedir()`/`ZCODE_CLI_CONFIG_FILE`（同 `~/.commandcode/` 等既有外部工具配置位先例）；端点全部来自卡片/网关，无字面量。
- 写必走正门：adapter 只写目标工具 live 配置（正门），khy 侧状态记录仍走 ccSwitch store；fail-soft 不吞错。
- 密钥策略：zcode 内联 key 为本工具唯一例外，已在 §5 与 091 安全章节联动说明（POSIX 0600 + 网关令牌降级敏感 + 审计）。
