# [DESIGN-ARCH-070] 治理总纲与可执行规则

> **定位**：本文件是既有治理规则的索引与缺口登记，不替代或推翻 `[DESIGN-ARCH-068]`、协议契约、维护映射表及现有 CI 脚本。发生冲突时，已声明为单一真源的原文优先；本文件在「未决冲突」登记差异和建议裁决，裁决权保留给维护者。
>
> **适用边界**：本文件只治理仓库结构、维护记忆、工具登记、内部消息与 API 契约；不在此处新增运行时业务逻辑。机械可判定的条款由 `node scripts/ci/check-gov-rules.js`、`npm run check:layout` 或既有专项守卫执行。

## 0. 审计矩阵：板块 × 已有规则 × 校验方式

| 板块 | 已有规则/真源 | 已有校验方式 | 空白或待工具化 |
|---|---|---|---|
| MOD | `[DESIGN-ARCH-068]` 定义 L0–L6、横切层、依赖方向、根目录和任务入口命名 | `npm run check:layout`；`scripts/ci/check-repo-layout.js` | 新五板块名称不是既有正式分类；跨 workspace 深层引用与 unresolved require 仍为基线债务 |
| MEM | ACP `context.share.scope` 区分 `session`/`persistent`；`AGENTS.md` 指向 `.ai/MAP.md`、`.ai/CONTEXT.yaml`、`.ai/GUARDS.md` | 无针对记忆生命周期的统一守卫 | 三份 `.ai` 元数据当前缺失；无单一读写入口或清理契约 |
| TOOL | `[DESIGN-ARCH-069]` 的目录+`khy.extension.json` 契约；工具注册表与 `toolContract` | `npm run check:layout`；`node scripts/ci/check-tool-contract.js` | 跨工具权限、升级和废弃流程尚无统一条款/守卫 |
| ACP | `acp-message.schema.json`、`acpTransport.js`、JSON-RPC 2.0 错误码与方法枚举 | ACP transport 测试、JSON schema 检查 | 无版本/trace/deadline/idempotency 元数据；schema 与 response 形式不一致 |
| API | gateway `_responseBuilder`、`gatewayErrorClassifier`、管理 HTTP/SSE/WS 与兼容 API | 路由/服务各自测试；`validate-protocol-contracts.js` | 无统一 OpenAPI、版本与弃用政策、统一外部错误信封 |

## 1. GOV-MOD — 模块与层级准入

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-MOD-001 | 新文件必须放入 `[DESIGN-ARCH-068]` 定义的 L0–L6 或横切层；未登记顶层目录不得承载代码或文档。 | 仓库根及全部新增路径 | 新建根级 `frontend/` 保存运行时代码。 | `npm run check:layout` 的 `layer-registry` |
| GOV-MOD-002 | 跨层依赖必须属于 `[DESIGN-ARCH-068]` 白名单；禁止层不得用深层相对导入绕过边界。 | L0–L6 运行时源码 | `apps/` 直接 require `software/` 源文件。 | `npm run check:layout` 的 `cross-layer-require`；存量基线 |
| GOV-MOD-003 | 新增根任务入口必须遵循 `<域>:<动作>[:<变体>]`，并解析到已存在脚本。 | 根 `package.json` 的 scripts | `check:foo` 指向不存在的 `scripts/ci/foo.js`。 | `GOV-TOOL-004`；`check:layout` 的 `dangling-task` |
| GOV-MOD-004 | 治理总纲必须保留 MOD、MEM、TOOL、ACP、API 五个板块，作为会话首屏可发现入口。 | 本文档 | 删除 `## GOV-API`。 | `node scripts/ci/check-gov-rules.js` |

## 2. GOV-MEM — 记忆与维护元数据

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-MEM-001 | 仅当前任务需要且无需跨会话复用的信息归为 session；跨会话稳定事实才归为 persistent。 | agent/ACP 上下文、维护记录 | 把一次性命令输出写入长期项目记忆。 | 待工具化：需先冻结记忆写入入口 |
| GOV-MEM-002 | persistent 记录必须包含主体、来源、写入时间、适用范围和清理条件，且不得把凭据写入记录。 | 长期记忆与 `.ai` 维护元数据 | 无来源的自由文本长期记录。 | 待工具化：格式契约未冻结 |
| GOV-MEM-003 | 代码不得绕过被指定的记忆读写入口直接写存储；入口、格式与清理职责必须在实现前登记。 | 未来记忆持久化模块 | 路由层直接写入持久化记忆文件。 | 待工具化：单一入口尚未指定 |
| GOV-MEM-004 | 会话结束、过期或主体删除时，session 数据必须按登记生命周期清除或归档，不能静默转为 persistent。 | session 缓存、队列、临时日志 | 进程重启后把临时上下文留作长期事实。 | 待工具化：生命周期策略待维护者裁决 |

## 3. GOV-TOOL — 工具与扩展登记

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-TOOL-001 | 每个内置扩展必须遵守 `[DESIGN-ARCH-069]` 的一目录一 `khy.extension.json`，删除目录即卸载。 | `extensions/` | 两个扩展共用一个 manifest。 | `npm run check:layout` 的 `extension-contract` |
| GOV-TOOL-002 | 工具注册条目必须通过名称归一、风险/类别和输入 schema 契约，避免解析顺序改变行为。 | 工具注册表 | 两个不同风险工具共享同一归一名称。 | `node scripts/ci/check-tool-contract.js` |
| GOV-TOOL-003 | 新工具或扩展必须声明最小权限边界；升级和废弃必须保留兼容期、迁移说明和移除版本。 | 工具、扩展及其 manifest | 直接移除公开工具名且无迁移说明。 | 待工具化：manifest 字段和版本策略尚未冻结 |
| GOV-TOOL-004 | 每个根 `check:*` 入口中引用的 `scripts/ci/` 脚本必须存在。 | 根 `package.json` | `check:missing` 指向 `scripts/ci/missing.js`。 | `node scripts/ci/check-gov-rules.js` |
| GOV-TOOL-005 | 治理检查必须同时在根 `check:structure` 和 PR gate 注册，避免本地/CI 任一侧失联。 | `package.json`、`.github/workflows/pr-gate.yml` | 只新增脚本但未纳入 CI。 | `node scripts/ci/check-gov-rules.js` |

## 4. GOV-ACP — 内部消息与通信契约

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-ACP-001 | ACP 请求、通知和响应必须按 JSON-RPC 2.0 区分：请求/通知含 `method`，响应含同一 `id` 与恰一 `result` 或 `error`。 | ACP schema、transport、bridge | response 同时携带 `result` 与 `error`。 | 待工具化：现 schema 对 response 仍要求 `method` |
| GOV-ACP-002 | 新 ACP 方法必须同时登记 method、params schema、错误码、兼容性影响和 transport 测试。 | ACP 方法扩展 | 只在 transport 加字符串方法名。 | `validate-json-schemas.js` + ACP 测试；兼容性登记待工具化 |
| GOV-ACP-003 | 可跨边界追踪的消息必须具有可传播的 correlation/trace 标识；并发工具调用必须有唯一调用标识。 | agent、task、tool message | 两个同名 tool 调用仅按 tool 名回配 result。 | 待工具化：信封元数据未冻结 |
| GOV-ACP-004 | 超时、取消、重试和关闭必须具有可观察的终态和错误码，transport 不得把协议级失败作为成功结果。 | ACP IPC/WS/HTTP transport | WS 发送失败被吞掉且调用者收到成功。 | 待工具化：错误可见性与取消契约待裁决 |

## 5. GOV-API — 内部与外部 API 边界

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-API-001 | 内部 adapter 结果与外部 REST/SSE/WS/兼容 API 必须明确边界；外部变更不得以内部对象形状作为隐式契约。 | `services/backend` API surfaces | 直接将 adapter attempts 原样作为公开响应。 | 待工具化：表面清单与 schema catalog 尚未建立 |
| GOV-API-002 | 新增或变更公开 API 必须登记版本、请求/响应字段、认证方式、错误码和迁移说明；破坏性变更需维护者裁决后发布。 | 外部 HTTP/SSE/WS API | 删除响应字段且无版本或迁移说明。 | 待工具化：OpenAPI/版本真源缺失 |
| GOV-API-003 | 外部错误响应必须提供稳定机器码与人类消息；SSE/WS 终态必须区分成功、降级、取消和失败。 | REST、SSE、WS、兼容 API | upstream 异常后仍发送 `stop` 与成功完成标记。 | 待工具化：统一错误模型未冻结 |
| GOV-API-004 | 认证后的 principal、请求 trace、deadline/retry/fallback 摘要必须按发布的最小披露规则跨 transport 传播。 | HTTP → gateway → ACP → SSE/WS | HTTP requestId 无法关联 gateway 尝试和 stream 事件。 | 待工具化：跨 transport 元数据契约待裁决 |

## 6. 未决冲突与已知缺口

| 编号 | 差异/缺口 | 建议裁决 | 本次处理 |
|---|---|---|---|
| UC-001 | `AGENTS.md` / OPS-MAN-169 指向 `.ai/MAP.md`、`.ai/CONTEXT.yaml`、`.ai/GUARDS.md`，磁盘中缺失。 | 由 `khy metadata refresh` 的维护者明确生成责任、提交策略与缺失时的 gate。 | 登记为 GOV-MEM 待工具化，不伪造文件。 |
| UC-002 | `[DESIGN-ARCH-068]` §3.2 根白名单点名 CLAUDE.md、khy.md、LICENSE；当前仓库缺失，而 OPS-MAN-169 又把 CLAUDE.md §1 作为索引。 | 将白名单、实际文件和引用入口统一到一份可生成清单，再裁决是否补文件。 | 不修改 068 或补占位文件。 |
| UC-003 | CODEOWNERS 自称由维护映射生成，但维护映射的 areaOwners 为空，实际落到默认 owner。 | 维护者为 area 分配 owner，或明示默认 owner 是正式策略。 | 仅记录；不改生成物。 |
| UC-004 | ACP schema 要求 `method`，运行时却接受无 `method` response；且缺 version/trace/deadline/idempotency。 | 先冻结 ACP response + meta 扩展模型，再版本化 schema。 | 不改 runtime/schema。 |
| UC-005 | 管理 REST、SSE、WS、兼容 API 的错误与响应形状分裂，未发现 OpenAPI 或统一版本政策。 | 建立公开 API catalog 后，分阶段定义信封与迁移策略。 | 不动业务接口。 |

## 7. 维护与验证

- 新增顶层目录、跨层依赖、扩展或任务入口前，先读 `[DESIGN-ARCH-068]` 与本文对应板块。
- 修改本文、根治理入口或 PR gate 后运行：

```powershell
node scripts/ci/check-gov-rules.js
npm run check:layout
node scripts/ci/check-agent-rules.js --changed
```

- 修改治理守卫时，必须同时更新 `scripts/tests/check-gov-rules.test.js`，并用临时 fixture 证明每条新增 error 可使退出码非零。
