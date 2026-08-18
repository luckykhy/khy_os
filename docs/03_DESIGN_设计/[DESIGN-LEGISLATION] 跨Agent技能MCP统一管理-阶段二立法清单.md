# [DESIGN-LEGISLATION] 跨 Agent 技能/MCP 统一管理 —— 阶段二立法规则清单

> 本清单是阶段三实现的冻结依据。回复「冻结」后，阶段三才进入代码变更。
> 依据阶段一调研报告 §1-§5 与铁律 F1-F8。

## §1 范围

阶段三包含：

- 新增 `khy unify` 命令，覆盖 `export`、`import/adopt`、`list/status`、`sync`。
- 建立 MCP 与技能 Agent bridge 注册表，消除 `loadConfig` 和 `discoverSkillsDeep` 中重复的桥接块。
- 增加其他 Agent 配置的存量纳管写入口，并保留来源、作用域与同步证据。
- 增加 `doctor --json` 的 MCP 配置完整性检查与结构化验证。

阶段三不包含：CC 插件市场迁移；未有本地样例的 Codex/OpenCode 等格式写入；技能 legacy 与 manifest 两种范式的全面重构；改变 khy 自身 `mcp.json` 的既有语义。

## §2 绑定规则

### A. CLI 命令面

**L-A1 三步注册。** `unify` 必须同时具备 handler、`aliases.js` 注册、`router.js` `case 'unify'` 分发；handler 导出 `handleUnifyCommand`。

**L-A2 不占用既有命令。** `unify` 为新增命令，不覆盖 `mcp`、`skill`、`doctor` 或 canonical `maintain`，不通过别名劫持 `maintain`。

**L-A3 子动作。** 支持 `export`、`import`/`adopt`、`list`/`status`、`sync`。缺省动作只显示用法，不产生写入。

**L-A4 可逆参数。** 所有会写入的动作支持 `--dry-run`、`--undo` 和 `--json`；`--json` 必须是机器可解析的稳定结构。

### B. 统一出口

**L-B1 stdio-first。** `unify export` 默认 stdio，可显式选择 `--transport stdio|http`；stdio 复用 `khy mcp serve` 的启动链路。

**L-B2 stdout 隔离。** 进入 stdio JSON-RPC 循环后不得执行 formatter、颜色输出或 CLI 尾部打印；日志只走 stderr/既有协议通道。

**L-B3 独立门控。** 导出服务使用独立的 `KHY_UNIFY_SERVE` flagRegistry 条目，采用 `mode: default-on`、`off: CANON` 与 `_FALSY = {'0','false','off','no'}`；不隐式复用 `KHY_MCP_ADD` 或 `KHY_MCP_SERVE`。

**L-B4 来源完整。** 导出视图合并 khy 自身与已启用 bridge 资产，但每项保留 `source`、`origin`、`scope`，不得静默丢弃冲突来源。

### C. 存量纳管与写回

**L-C1 明确目标。** `adopt/import` 可读取并纳管 CC 用户/项目配置、项目 `.mcp.json` 与 OpenClaw 配置；写回目标必须来自显式 Agent registry，不允许任意路径。

**L-C2 原子写协议。** 每次写回必须执行 read → merge → temp file → atomic rename；写前创建 `<file>.khy-backup-<timestamp>`；支持 `--dry-run` 与 `--undo`。

**L-C3 字段级合并。** 只合并目标 server/skill 字段，保留目标文件其他字段；CC 的 `{command,args,env}` 与 `{type:'sse'|'http',url}` 结构保持兼容；JSON5 目标不得因写回丢失既有注释或未知字段。

**L-C4 fail-soft。** 单个目标读取、解析、校验或写入失败时记录结构化错误并继续其他目标；纯 bridge 叶子不得向调用方抛异常。

**L-C5 路径白名单。** 目标路径只能由 registry 的安全 join helper（`_join`/`pathJoinSafe` 或 `_safeJoin`/`_sanitizeName`）生成；拒绝绝对路径逃逸、`..` 穿越和未登记目标。

### D. Bridge 注册表

**L-D1 MCP 注册表。** 将 `mcp/index.js` 的 CC/OpenClaw 重复块改为数据注册表与通用循环；每条包含稳定 `id`、启用函数、配置源、extractor、写目标与 scope 优先级。

**L-D2 技能注册表。** `skillLoader` 使用同一注册表语义遍历 CC/OpenClaw bridge；现有目录 basename 去重与 khy 优先级保持不变。

**L-D3 纯叶约束。** bridge 的 `isEnabled/configSources/extract` 必须零 IO、确定性、fail-soft、never-throw；注册表只追加声明，不复制桥接逻辑。

**L-D4 兼容约束。** 既有 bridge 模块的导出签名、返回结构、默认开启行为、`_ccBridged`/`_ocBridged` 来源标注和 `_scope: USER` 优先级保持兼容。

**L-D5 门控一致。** 新增 bridge flag 必须进入 flagRegistry，并保留 `_FALSY` 兜底；关闭一个 bridge 不影响其他 bridge 或 khy 自身配置。

### E. 证据与 doctor

**L-E1 状态结构。** `unify list/status --json` 每项至少输出 `id`、`kind`、`source`、`origin`、`scope`、`enabled`、`writeTarget`、`syncedAt`（无值时为 `null`）。

**L-E2 同步证据。** 成功写回记录目标路径、备份路径、时间戳、变更项与可回滚标识；dry-run 不创建文件和证据。

**L-E3 doctor 合并。** MCP 配置完整性检查接入 `handleDoctor` 现有异步检查 merge 通道，并可由 `doctor --json` 稳定断言；检查失败报告状态，不阻断无关诊断。

**L-E4 验证矩阵。** 阶段四必须覆盖：默认/关闭门控、空配置、损坏配置、路径逃逸、冲突合并、原子写与备份、undo、dry-run、stdio stdout 纯净、Windows 启动链路，以及旧 bridge API 回归。

## §3 F1-F8 映射

| 铁律 | 绑定条款 |
|---|---|
| F1 纯叶、零 IO、fail-soft、确定性、never-throw | L-C4、L-D3 |
| F2 原子写、备份、回滚、dry-run | L-A4、L-C2、L-E2 |
| F3 flagRegistry 与 `_FALSY` | L-B3、L-D5 |
| F4 路径安全 | L-C5 |
| F5 stdio-first 与 stdout 隔离 | L-B1、L-B2 |
| F6 来源与确定性 | L-B4、L-E1 |
| F7 兼容既有行为 | L-A2、L-D4 |
| F8 可逆操作 | L-A4、L-C2、L-E2 |

## §4 冻结门控

本清单冻结前只接受规则层面的修订，不进入阶段三代码实现。请回复 **「冻结」** 锁定上述 L-A1 至 L-E4；收到后执行阶段三，并在阶段四按 L-E4 输出证据报告。
