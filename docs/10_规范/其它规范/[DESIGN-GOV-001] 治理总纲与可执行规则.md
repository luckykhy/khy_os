# [DESIGN-GOV-001] 治理总纲与可执行规则

<!-- RULES-REGISTRY: TOOLING-004, TOOLING-005, TOOLING-006, TOOLING-007, TOOLING-008, MOD-004 -->


> **定位**：本文件是既有治理规则的索引与缺口登记，不替代或推翻 `[DESIGN-LAY-005]`、协议契约、维护映射表及现有 CI 脚本。发生冲突时，已声明为单一真源的原文优先；本文件在「未决冲突」登记差异和建议裁决，裁决权保留给维护者。
>
> **适用边界**：本文件是 Khy OS 全部治理规则的**可检索入口层**，覆盖仓库结构、维护记忆、工具登记、内部消息、API 契约、外部借鉴、运行时行为、流程纪律、安全权限与文档治理十个板块；不在此处新增运行时业务逻辑。**十个板块与元规则 `[MGMT-STD-008]` §3 十大域一一对应**（MOD↔LAYOUT、MEM↔MEMORY、TOOL↔TOOLING、ACP↔COMMS、API↔API、BORROW↔SOURCING、RUNTIME↔RUNTIME、PROCESS↔PROCESS、SECURITY↔SECURITY、DOCS↔DOCS）。机械可判定的条款由 `node scripts/ci/check-gov-rules.js`、`npm run check:layout`、`npm run check:duplication`、`node scripts/ci/check-agent-rules.js` 或既有专项守卫执行；规则的三元字段（约束/权力/福利）与生命周期登记在 `docs/10_规范/registry/RULES-REGISTRY.json`。

## 0. 审计矩阵：板块 × 已有规则 × 校验方式

| 板块 | 已有规则/真源 | 已有校验方式 | 空白或待工具化 |
|---|---|---|---|
| MOD | `[DESIGN-LAY-005]` 定义 L0–L6、横切层、依赖方向、根目录和任务入口命名 | `npm run check:layout`；`scripts/ci/check-repo-layout.js` | 新五板块名称不是既有正式分类；跨 workspace 深层引用与 unresolved require 仍为基线债务 |
| MEM | ACP `context.share.scope` 区分 `session`/`persistent`；`AGENTS.md` 指向 `.ai/MAP.md`、`.ai/CONTEXT.yaml`、`.ai/GUARDS.md`；GOV-MEM 契约冻结于 `[DESIGN-MEM-006]`（2026-09-10） | 无针对记忆生命周期的统一守卫 | 机械守卫待工具化（`[DESIGN-MEM-006]` §6 三条）；指定入口与格式已冻结，`.ai` 三件套已按指定入口补齐 |
| TOOL | `[DESIGN-TOOL-002]` 的目录+`khy.extension.json` 契约；工具注册表与 `toolContract`；升级/废弃契约冻结于 `[DESIGN-TOOL-001]`（2026-09-10） | `npm run check:layout`；`node scripts/ci/check-tool-contract.js` | 跨工具权限、升级和废弃的机械守卫待工具化（`[DESIGN-TOOL-001]` §5 三条）；manifest 字段与版本策略已冻结 |
| ACP | `acp-message.schema.json`、`acpTransport.js`、JSON-RPC 2.0 错误码与方法枚举；信封/元数据/终态契约冻结于 `[DESIGN-ACP-001]`（2026-09-10） | ACP transport 测试、JSON schema 检查 | schema v2 与 transport 接线待落地（`[DESIGN-ACP-001]` §5 三步）；冻结前现状偏差（response 无 `method`、无 meta）以本文为准 |
| API | gateway `_responseBuilder`、`gatewayErrorClassifier`、管理 HTTP/SSE/WS 与兼容 API；错误信封与版本政策冻结于 `[DESIGN-API-002]`（2026-09-10） | 路由/服务各自测试；`validate-protocol-contracts.js` | API 目录与统一信封实现待落地（`[DESIGN-API-002]` §6 三步）；冻结前存量分裂形状以本文为目标态 |
| BORROW | 借鉴范围/方式/流程/实现唯一性/生命周期/自动化门六组条款，单一真源 `[DESIGN-SOURCING-001]`；上游归档学习红线在 `[DESIGN-ARCH-061]` | `npm run check:duplication`（重复实现）、`npm run check:layout`（层级唯一）、`npm run check:gov-rules`（本板块入口接线） | 归属登记表 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 与其守卫 `check:feature-ownership` 尚未落地（`[DESIGN-SOURCING-001]` §6 B-G1/B-G2 分阶段建设项）；`fork`/`vendored` 的批准属维护者人工裁决 |
| RUNTIME | `AGENTS.md` 工程规则 1–4：零硬编码 / 状态透明 / 活动式超时 / 无滚动区 UI，另有代码评审清单与本地检查说明；子智能体交接契约冻结于 `[DESIGN-AGENT-001]`（2026-09-18） | `node scripts/ci/check-agent-rules.js --changed`（硬编码/状态文本/超时/滚动区/无界循环）；`exploreAgent.js` 的 `disallowedTools` 硬闸 | 子规则 2.2–2.6（错误消息、工具/思考/等待状态、多阶段进度）无自动检查，人工评审兜底；规则 2.1 简洁性属 P3 建议级；`AGENT-001` 的 AG-5（`file:line` 证据）因 `output` 是自由文本而无法自动校验 |
| PROCESS | 分支纪律、版本同步、验收门禁、行为准则 B1–B5，真源 `CLAUDE.md` §一/§二/§三；委派边界 `[DESIGN-PROCESS-001]`；机制落地四阶段冻结于 `[DESIGN-PROCESS-002]`（2026-09-18） | `scripts/ci/check-version-sync.js`（版本三轨道）、`check-change-safety.js`、`check-repo-layout.js`、`arch:god` | R1 分支纪律、B1–B5 行为准则为流程约定，无机械守卫，靠人工评审；`PROCESS-006`（四阶段毕业判据）执行器 `check-rollout-stage.js` 待建；`PROCESS-007` 的 B5 有 `PreCompact` hook 通路但尚无 `.khy/hooks.json` 配置 |
| SECURITY | 密钥防泄露、权限档与 critical gate、弱模型改动护栏、能力分档，真源 `CLAUDE.md` §一 R2 与 `[OPS-MAN-169]` §四 | `scripts/ci/check-security-headers.js`、`check-auth-session.js`；权限漏斗代码 `toolCallingPermissions.js` | 密钥「不进 bundle」的 wheel 审计属发布流程人工步骤，非 CI 守卫 |
| DOCS | 文档命名/放置/登记/生命周期、规则卡格式与元规则，真源 `[MGMT-STD-007]` 与 `[MGMT-STD-008]`；README 禁项表 `[DESIGN-DOC-003]`；Skill 书写约束冻结于 `[DESIGN-SKILL-001]`（2026-09-18） | `npm run docs:verify`、`npm run docs:build`、`docs:check-beginner`、`check:layout` 的 `docs-index-*`、`check-gov-rules` 的 GOV-TOOL-006 | `[MGMT-STD-001]` CP-6 与 `[MGMT-STD-007]` R3 的编号管辖边界由裁决 X-001 划定（scope 分层，非优先级覆盖）；`SKILL-001` 的 `check-skill-triggers.js` 待建，**且属概率性检查建议不进三守卫** |

## 1. GOV-MOD — 模块与层级准入

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-MOD-001 | 新文件必须放入 `[DESIGN-LAY-005]` 定义的 L0–L6 或横切层；未登记顶层目录不得承载代码或文档。 | 仓库根及全部新增路径 | 新建根级 `frontend/` 保存运行时代码。 | `npm run check:layout` 的 `layer-registry` |
| GOV-MOD-002 | 跨层依赖必须属于 `[DESIGN-LAY-005]` 白名单；禁止层不得用深层相对导入绕过边界。 | L0–L6 运行时源码 | `apps/` 直接 require `software/` 源文件。 | `npm run check:layout` 的 `cross-layer-require`；存量基线 |
| GOV-MOD-003 | 新增根任务入口必须遵循 `<域>:<动作>[:<变体>]`，并解析到已存在脚本。 | 根 `package.json` 的 scripts | `check:foo` 指向不存在的 `scripts/ci/foo.js`。 | `GOV-TOOL-004`；`check:layout` 的 `dangling-task` |
| GOV-MOD-004 | 治理总纲必须保留 MOD、MEM、TOOL、ACP、API、BORROW、RUNTIME、PROCESS、SECURITY、DOCS **十个板块**（与 `[MGMT-STD-008]` §3 十大域一一对应），作为会话首屏可发现入口。 | 本文档 | 删除 `## GOV-API` 或 `## GOV-RUNTIME`。 | `node scripts/ci/check-gov-rules.js` |

## 2. GOV-MEM — 记忆与维护元数据

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-MEM-001 | 仅当前任务需要且无需跨会话复用的信息归为 session；跨会话稳定事实才归为 persistent。 | agent/ACP 上下文、维护记录 | 把一次性命令输出写入长期项目记忆。 | 契约已冻结：`[DESIGN-MEM-006]` §1；机械守卫待工具化 |
| GOV-MEM-002 | persistent 记录必须包含主体、来源、写入时间、适用范围和清理条件，且不得把凭据写入记录。 | 长期记忆与 `.ai` 维护元数据 | 无来源的自由文本长期记录。 | 契约已冻结：`[DESIGN-MEM-006]` §2；机械守卫待工具化 |
| GOV-MEM-003 | 代码不得绕过被指定的记忆读写入口直接写存储；入口、格式与清理职责必须在实现前登记。 | 未来记忆持久化模块 | 路由层直接写入持久化记忆文件。 | 指定入口已登记：`[DESIGN-MEM-006]` §3（`.ai/` 走 `khy metadata`，上下文走 ACP `context.share`）；守卫待工具化 |
| GOV-MEM-004 | 会话结束、过期或主体删除时，session 数据必须按登记生命周期清除或归档，不能静默转为 persistent。 | session 缓存、队列、临时日志 | 进程重启后把临时上下文留作长期事实。 | 契约已冻结：`[DESIGN-MEM-006]` §4；生命周期策略随该文裁决，守卫待工具化 |

## 3. GOV-TOOL — 工具与扩展登记

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-TOOL-001 | 每个内置扩展必须遵守 `[DESIGN-TOOL-002]` 的一目录一 `khy.extension.json`，删除目录即卸载。 | `extensions/` | 两个扩展共用一个 manifest。 | `npm run check:layout` 的 `extension-contract` |
| GOV-TOOL-002 | 工具注册条目必须通过名称归一、风险/类别和输入 schema 契约，避免解析顺序改变行为。 | 工具注册表 | 两个不同风险工具共享同一归一名称。 | `node scripts/ci/check-tool-contract.js` |
| GOV-TOOL-003 | 新工具或扩展必须声明最小权限边界；升级和废弃必须保留兼容期、迁移说明和移除版本。 | 工具、扩展及其 manifest | 直接移除公开工具名且无迁移说明。 | 契约已冻结：`[DESIGN-TOOL-001]`（manifest `lifecycle` 块、工具名弃用兼容期、版本策略、最小权限边界）；机械守卫待工具化 |
| GOV-TOOL-004 | 每个根 `check:*` 入口中引用的 `scripts/ci/` 脚本必须存在。 | 根 `package.json` | `check:missing` 指向 `scripts/ci/missing.js`。 | `node scripts/ci/check-gov-rules.js` |
| GOV-TOOL-005 | 治理检查必须同时在根 `check:structure` 和 PR gate 注册，避免本地/CI 任一侧失联。 | `package.json`、`.github/workflows/pr-gate.yml` | 只新增脚本但未纳入 CI。 | `node scripts/ci/check-gov-rules.js` |
| GOV-TOOL-006 | 规则必须登记进 `docs/10_规范/registry/RULES-REGISTRY.json`：字段齐全（含三元字段 `nature`/`grants`/`benefit`）、ID 全局唯一且格式为 `<DOMAIN>-<NNN>`、`domain`/`priority`/`status` 枚举合法、授予权力必有约束边界配对、同 domain 同名判职责重叠预警。 | `docs/10_规范/registry/RULES-REGISTRY.json` | 只写约束不写 `grants`/`benefit`；两条规则 ID 相同；授予权力却无 `scope`/`constraint`。 | `node scripts/ci/check-gov-rules.js` 的 `checkRulesRegistry`（元规则 `[MGMT-STD-008]` §1/§3/§5.8） |
| GOV-TOOL-007 | 登记规则的语义真源（`ssot` 首个目标）必须在其文件内以 `RULES-REGISTRY` 标记行声明该规则 ID，且标记行不得出现未登记的 ID —— 登记表与真源**双向可达**；`enforcement` 列出的执行/常量真源必须存在。 | `docs/10_规范/registry/RULES-REGISTRY.json` 及各条目 `ssot` / `enforcement` 指向的文件 | 登记表改了 ID 但真源文档未标 ID（反向查不到）；真源标了未登记的 `RULES-REGISTRY: X-999`；`enforcement` 指向已删除的脚本。 | `node scripts/ci/check-rules-registry.js`（根入口 `check:rules`，已纳入 `check:structure` 与 PR gate） |
| GOV-TOOL-008 | 逐条规则卡（`[MGMT-STD-008]` §1 形态）是 `scripts/docs/gen-rules-cards.js` 的**构建产物**，禁止手工编辑；规则字段以 `RULES-REGISTRY.json` 为唯一真源，卡片的 frontmatter 与六小节必须出自同一次生成。 | `docs/10_规范/规则卡/**`、`docs/10_规范/registry/RULES-REGISTRY.json` | 手改某张规则卡的 `constraint` 而登记表仍是旧值（两处不一致）；只改卡不重跑生成器，产物过期。 | `npm run check:rules`（`gen-rules-cards.js --check` 比对脏 diff，同 CODEOWNERS / `.html` 孪生件的棘轮） |

## 4. GOV-ACP — 内部消息与通信契约

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-ACP-001 | ACP 请求、通知和响应必须按 JSON-RPC 2.0 区分：请求/通知含 `method`，响应含同一 `id` 与恰一 `result` 或 `error`。 | ACP schema、transport、bridge | response 同时携带 `result` 与 `error`。 | 契约已冻结（UC-004 裁决）：`[DESIGN-ACP-001]` §1 三态信封拆分；schema v2 与 transport 接线按该文 §5 排期，落地前待工具化 |
| GOV-ACP-002 | 新 ACP 方法必须同时登记 method、params schema、错误码、兼容性影响和 transport 测试。 | ACP 方法扩展 | 只在 transport 加字符串方法名。 | `validate-json-schemas.js` + ACP 测试；兼容性登记待工具化 |
| GOV-ACP-003 | 可跨边界追踪的消息必须具有可传播的 correlation/trace 标识；并发工具调用必须有唯一调用标识。 | agent、task、tool message | 两个同名 tool 调用仅按 tool 名回配 result。 | 契约已冻结：`[DESIGN-ACP-001]` §2（`meta.traceId/correlationId/callId/idempotencyKey/deadline/version`）；schema 与 transport 接线按该文 §5 排期，落地前待工具化 |
| GOV-ACP-004 | 超时、取消、重试和关闭必须具有可观察的终态和错误码，transport 不得把协议级失败作为成功结果。 | ACP IPC/WS/HTTP transport | WS 发送失败被吞掉且调用者收到成功。 | 契约已冻结：`[DESIGN-ACP-001]` §3（-32001 超时 / -32002 取消 / -32003 传输失败 / -32004 关闭，四态互斥）；错误码接线按该文 §5 排期，落地前待工具化 |

## 5. GOV-API — 内部与外部 API 边界

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-API-001 | 内部 adapter 结果与外部 REST/SSE/WS/兼容 API 必须明确边界；外部变更不得以内部对象形状作为隐式契约。 | `services/backend` API surfaces | 直接将 adapter attempts 原样作为公开响应。 | 契约已冻结（UC-005 裁决）：`[DESIGN-API-002]` §1 内外边界红线；表面清单按该文 §6/§7 目录表逐步填实 |
| GOV-API-002 | 新增或变更公开 API 必须登记版本、请求/响应字段、认证方式、错误码和迁移说明；破坏性变更需维护者裁决后发布。 | 外部 HTTP/SSE/WS API | 删除响应字段且无版本或迁移说明。 | 契约已冻结：`[DESIGN-API-002]` §4 版本化 + 弃用政策 + 五要素登记制；API 目录真源为该文 §7 |
| GOV-API-003 | 外部错误响应必须提供稳定机器码与人类消息；SSE/WS 终态必须区分成功、降级、取消和失败。 | REST、SSE、WS、兼容 API | upstream 异常后仍发送 `stop` 与成功完成标记。 | 契约已冻结：`[DESIGN-API-002]` §2 统一错误信封 + §3 四终态（done/degraded/cancelled/failed 互斥）；存量端点按该文 §6 迁移 |
| GOV-API-004 | 认证后的 principal、请求 trace、deadline/retry/fallback 摘要必须按发布的最小披露规则跨 transport 传播。 | HTTP → gateway → ACP → SSE/WS | HTTP requestId 无法关联 gateway 尝试和 stream 事件。 | 契约已冻结：`[DESIGN-API-002]` §5 最小披露白名单 + `[DESIGN-ACP-001]` §2 `traceId` 全链路传播 |

## 6. GOV-BORROW — 外部借鉴与实现唯一性

> 单一真源 `[DESIGN-SOURCING-001]`。本节只登记裁决入口与红线，条款全文与判定标准在 104。
> 上游压缩包的学习与「绝不自动整包合并」在 `[DESIGN-ARCH-061]`，是 104 的下位执行件。

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-BORROW-001 | 上游源码文件不得复制进 khyos 源码目录；唯一例外是 `vendored` 档且六条件全过。 | `services/`、`apps/`、`platform/`、`software/`、`kernel/`、`tools/`、`scripts/` | 把上游 `src/` 目录整体拷进本仓再改命名。 | `[DESIGN-SOURCING-001]` §1 B-S3；人工评审 + `check:duplication` 的克隆类信号 |
| GOV-BORROW-002 | 许可证分级是硬门槛：无法核实许可证的文件按最严格档 `idea` 处理，GPL/AGPL 家族禁止进入源码目录。 | 一切外部代码与文档片段 | 以「大概 MIT」为由直接 vendored。 | `[DESIGN-SOURCING-001]` §1 B-S4；人工评审（许可证文件路径必须在提案中可复核） |
| GOV-BORROW-003 | 新能力域必须先出六字段提案再编码，事后补写不得豁免。 | 新增工具/服务/命令/视图族/API 端点/协议消息/配置键 | 代码写完后在 PR 里补一句「参考了 X 项目」。 | `[DESIGN-SOURCING-001]` §3 B-P2/B-P2.1；人工评审（提案六字段齐全） |
| GOV-BORROW-004 | 每个能力域必须在 `docs/10_规范/registry/FEATURE-OWNERSHIP.json` 登记唯一 `canonical`；`vendored`/`fork` 档的批准人不得是作者本人。 | 能力域注册表与 PR 裁决 | 两个服务各实现一份「多供应商 AI 调用」，无人登记。 | 现有 `check:duplication`；`check:feature-ownership` 待建（104 §6 B-G1/B-G2）；裁决留痕由 `check:gov-rules` 覆盖入口接线 |
| GOV-BORROW-005 | 同一功能只允许一个公开名称与一个实现层；写新代码前必须完成四步检索并留下检索结论。 | 新增实现、重命名、换实现范式 | 已存在 `aiGateway` 又新增 `gatewayClient` 并行入口。 | `[DESIGN-SOURCING-001]` §4 B-U2/B-U4；`check:layout` 的 `layer-registry` 判层级错放；命名分歧交维护者一次裁决 |
| GOV-BORROW-006 | 架构决策只能追加新决策，不得原地改写或删除旧决策；改已存在功能只走 `canonical` 扩展或三步迁移。 | 注册表 `notes`、设计文档、提案正文 | 把既有决策措辞改掉以掩盖曾经的决定；以「旧实现有 bug」为由新开并行实现。 | `[DESIGN-SOURCING-001]` §4 B-U5、§5 B-L2/B-L3；`check:duplication` 挡新重复；迁移分步回滚由评审逐 PR 确认 |

## 7. GOV-RUNTIME — 运行时行为红线

> 语义真源：`AGENTS.md` 工程规则 1–4（本板块只登记与指路，不复制正文）。
> 守卫：`node scripts/ci/check-agent-rules.js --changed`；运行时兜底 `services/backend/src/services/sessionWatchdog.js`。
> 四条规则均登记于 `docs/10_规范/registry/RULES-REGISTRY.json`（`RUNTIME-001`~`RUNTIME-004`、`AGENT-001`）。

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-RUNTIME-005（`AGENT-001`） | 子智能体之间**不得假定共享内存**，跨体传递必须走报文：派发时须给自包含 prompt 并显式传 `parent_context_summary`（禁止指望父对话自动可见），须声明所有权；子体产出须带 `file:line`；只读型禁派写任务；续用须 `SendMessage` 而非重 spawn；子体产出对用户不可见，主须转述。 | 一切经 `Agent` 工具派发或 `SendMessage` 续用的子智能体调用 | 派发时只写「接着把上面的改了」，指望子体能看见父对话（子体只收 compact summary） | 人工评审（`gate=manual`）；**AG-6 已有硬闸**：`exploreAgent.js` 的 `disallowedTools`；真源 `[DESIGN-AGENT-001]` |
| GOV-RUNTIME-001（`RUNTIME-001`） | 源码不得出现字面量 IP/端口/绝对路径/第一方生产域名；端点必须从 `constants/serviceDefaults.js` 导入或由 env 覆盖；dev server 端口冲突必须自动探测下一个可用端口。 | 全部运行时源码（非测试文件） | `fetch('http://localhost:3000/api')` | `check-agent-rules.js` 的硬编码端点 / 生产域名 / 绝对路径检查（error 级） |
| GOV-RUNTIME-002（`RUNTIME-002`） | 面向用户的状态、日志、spinner、错误消息必须含「动作 + 目标 + 进度」；禁止单独使用「正在工作/处理中/Loading/Connecting/尝试连接/请稍候/Processing」。 | CLI 输出、TUI 状态行、后端 `console.log` / `logger.info` | `任务处理中...` | `check-agent-rules.js` 覆盖 6 个含糊 token（warning 级）；子规则 2.2–2.6（错误消息具体化、工具/思考/等待状态、多阶段步骤编号）人工评审兜底 |
| GOV-RUNTIME-003（`RUNTIME-003`） | 超时机制不得在固定时长后无条件杀死仍在推进的长任务；必须用空闲/滑动超时，由进度事件重置计时器。 | AI 循环、构建、回测、数据同步等长任务 | 固定 wall-clock 截止后直接 kill | `check-agent-rules.js` 的超时审计（硬超时 error；固定超时缺重置机制 warning）；无界循环检查（warning，`khy-allow-unbounded-loop` 豁免） |
| GOV-RUNTIME-004（`RUNTIME-004`） | 与回滚输出共存的 CLI 内联 UI 禁用 ANSI 滚动区（DECSTBM），须用保存/恢复光标 + 绝对定位；仅切到备用屏幕缓冲区的全屏 TUI 例外。 | REPL、交互式 prompt、状态行渲染 | DECSTBM 转义直接写入 stdout | `check-agent-rules.js` 的 DECSTBM 扫描（无备用缓冲区上下文判 error，有则降级 warning） |

## 8. GOV-PROCESS — 流程纪律

> 语义真源：`CLAUDE.md` §一 R1/R3、§二 B1–B5、§三 验收门禁；`[OPS-MAN-169]` §一 是索引与速查。
> 规则登记于 `docs/10_规范/registry/RULES-REGISTRY.json`（`PROCESS-001`~`PROCESS-003`、`PROCESS-004`、`PROCESS-006`、`PROCESS-007`、`PROCESS-008`~`PROCESS-011`）。

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-PROCESS-001（`PROCESS-001`） | 禁止直接在主干开发；**禁止 AI 自动 `commit`/`push`**，必须用户明确点头。 | 全部贡献者（含 AI 代理） | AI 在未获指示时自行提交并推送 | 人工评审（流程约定，无机械守卫）；分支保护基线见 `[OPS-MAN-009]` |
| GOV-PROCESS-002（`PROCESS-002`） | 三条版本轨道共 9 个真源，**组内必须完全一致、组间刻意不同**：G1 主包 4 源、G2 ai-backend 2 源、G3 浏览器 UI 3 源。 | `pyproject.toml`、`packaging/npm/package.json`、`services/backend/package.json`、`packaging/modules/modules.json`、`services/ai-backend/package.json`、`platform/packages/shared/package.json`、`platform/packages/ui-shared/package.json`、`apps/ai-frontend/package.json`、`software/khyquant/frontend/package.json` | 只 bump pip 不 bump npm；G3 的 `@khy/ui-shared` 依赖与包版本不一致 | `node scripts/ci/check-version-sync.js`（error）；`publish-dual.sh` 发布时同步 G1 前三源 |
| GOV-PROCESS-003（`PROCESS-003`） | 多步任务先列 plan、每步带 verify，**未跑过验证不许声称完成**；验收门禁任一红即未完成。 | AI 代理与人类贡献者 | 「已修复」但未运行任何检查 | `CLAUDE.md` §三 验收门禁清单；`.claude/commands/goal.md`（`/goal`，轮数上限 6） |
| GOV-PROCESS-004 | 治理总纲、根治理入口或 PR gate 变更，必须同时更新 `scripts/tests/check-gov-rules.test.js`，并用临时 fixture 证明每条新增 error 可使退出码非零。 | 治理守卫脚本与接线 | 新增 error 但测试未跟随 | `node --test scripts/tests/check-gov-rules.test.js` |
| GOV-PROCESS-007（`PROCESS-007`） | **B4** 多文件任务必须按 Grep 符号定位 → Glob 列目录 → 仅 Read 2–3 个最相关文件 → 大输出任务先评估委派，**禁止无目标大范围读取**（且必须按**符号名**而非文件名定位）；**B5** 压缩时必须保留四类：已改文件完整路径 / 失败用例与堆栈 / 未完成步骤 / **本次守卫结论**（三守卫绿灯不得被压缩掉）。 | AI 代理编辑本仓时的上下文取用（含压缩时机） | 为一个改动机无目标 Read 整个目录；压缩后忘了三守卫已跑过而重跑一遍 | 人工评审；**B5 已有机制通路**：`contextCompressor.js:745` 任务锚点保护 + `:624` `PreCompact` hook 支持 `additionalContext`；真源 `CLAUDE.md` §二 B4/B5 |
| GOV-PROCESS-006（`PROCESS-006`） | 拦截型机制（hook / 规则 / 门禁 / 预算）**禁止直接进 S3 门禁**，必须先过 S1 观测；**阶段毕业以样本量计、禁止以时间计**（S1 ≥200 事件 / S2 误报 <10% / S3 豁免 <20%）；S1/S2 必须旁路记录不得阻断；每阶须有回退动作且回退不依赖未提交代码。 | 一切新增或升级拦截能力的改动（含 hook 从记录改拦截、门禁 warning 提升为 error） | 新 hook 一上线就拦截，无观测样本；用「跑了两周」当毕业理由 | 人工评审（`gate=manual`，`scripts/ci/check-rollout-stage.js` 待建）；真源 `[DESIGN-PROCESS-002]` |
| GOV-PROCESS-008（`PROCESS-011`） | 规范写的与实现做的不一致时，**先裁「改哪一边」再动手**：按 T1 规范空转（规范 active 但执行器缺失/未接线/名不副实）/ T2 实现越界（代码里在跑但规范无条款）/ T3 双轨分叉（两边都在但语义漂移）/ T4 外部倒逼（上游新版/事故/合规）归类；再按 **Q1 该存在吗 → Q2 可机械判定吗 → Q3 哪边已被消费 → Q4 多严重**的顺序定归宿（改规范 / 改实现 / 双改 / 接受偏差）；**偏差必须有到期日且到期自动升级**；**禁止用改文档掩盖实现缺陷**；**AI 不得自行裁决归宿或自行接受偏差**。 | 一切「规范文本的应有行为」与「规范实现的实有行为」存在可观测差异的场景（实现载体：守卫/检查器、真源登记表、运行时闸门、生成器、测试断言） | 改了守卫阈值却同步改规范措辞以「保持一致」；差异根因是守卫误报却让规范表述迁就实现；偏差写成「暂无计划」无到期日；AI 自行宣布「先接受偏差」 | 人工评审（`gate=manual`，四问裁决本质是判断而非机械比对）；真源 `[DESIGN-PROCESS-003]` |

## 9. GOV-SECURITY — 安全与权限

> 语义真源：`CLAUDE.md` §一 R2、`[OPS-MAN-169]` §四；权限漏斗代码
> `services/backend/src/services/toolCallingPermissions.js`、`riskGate.js`、`permissionStore.js`。
> 规则登记于 `docs/10_规范/registry/RULES-REGISTRY.json`（`SECURITY-001`~`SECURITY-003`）。

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-SECURITY-001（`SECURITY-001`） | 真 key/token 永不进 bundle、源码或提交；只经 env 变量瞬时注入、绝不落盘；占位 key 必须一眼假。 | 全部源码、打包产物、`.mcp.json` | 把真实 API key 写进 `config.json` 模板并提交 | 发布前 wheel 对已知泄露 key 0 命中（人工审计）；密钥注入真源 `customProviderRegistrar.js`（无默认值，不设即能力不可用） |
| GOV-SECURITY-002 | 不可逆操作或显式 `critical` 的 critical gate **不可绕过**——即便 `KHY_SYSCALL_GATEWAY=off`、即便 bypass/yolo，也要求键入 `YES`；持久化 `allow` 规则与 `policyAutoAllow` 都覆盖不了它。 | `riskGate.js`、`toolCallingPermissions.js`、`syscallGateway/` | yolo 模式下 `rm -rf` 被自动放行 | 代码路径审查（`isUnbypassableGate`）；人工评审 |
| GOV-SECURITY-003 | 弱模型改动护栏默认开：弱档 + red-line 路径（`.env`、发布/CI、flagRegistry SSOT、版本三源、权限核心、`.git`）→ 拒并要求强模型复核；关闭或异常时逐字节回退。 | `weakModelChangeGuard.js`（门控 `KHY_WEAK_MODEL_EDIT_GUARD`） | 弱模型直接改 `flagRegistry` SSOT | 代码路径审查；env 家族见 `[OPS-MAN-058]` |
| GOV-SECURITY-004 | 权限档共 6 档（strict/normal/acceptEdits/auto/dontAsk/yolo），**失败即拒（fail-closed）**；模式化 allow/deny 规则库中 deny 优先于 allow。 | `permissionStore.js`、`permissions/rules.js` | 未显式 allow 的调用被默认放行 | `scripts/ci/check-auth-session.js`；人工评审 |

## 10. GOV-DOCS — 文档与规则治理

> 语义真源：`[MGMT-STD-007]` 文档规则总纲（命名/放置/登记/生命周期）、
> `[MGMT-STD-001]` 索引铁律、`[MGMT-STD-008]` 规则编写与管理规范（元规则）。
> 规则登记于 `docs/10_规范/registry/RULES-REGISTRY.json`（`DOCS-001`、`MGMT-STD-008`、`DOCS-004`、`SKILL-001`）。

> **`SKILL-001` 属本板块管辖**：Skill 的 `manifest.json` / `prompt.md` 是**文档形态的契约**，
> 故归 DOCS 域而非 TOOLING 域（TOOLING 管「什么是核/什么是拓展」的收纳边界）。

| 规则 ID | 一句话规则 | 适用范围 | 反例 | 校验方式 |
|---|---|---|---|---|
| GOV-DOCS-005（`SKILL-001`） | Skill 的 `description` 必须四段式且**触发短语落在前 60 字符内**（上限 1024 字符）；`when_to_use` 必填且 ≤120 字符；任务型 Skill 必须 `disableModelInvocation: true`；需工具的 Skill 必须写 `allowed-tools` 最小权限，Bash 项用 `Bash(<prefix>:*)` 而**非** glob ` *`。 | `.khy/skills/**/manifest.json`、`prompt.md`、`reference/**` | `description` 写成「Helps with skills.」（空泛无触发信号）；`allowed-tools` 留空表示全部允许；前缀写成 `Bash(git *)` 致静默失效 | 人工评审（`gate=manual`，`scripts/ci/check-skill-triggers.js` 待建，**且属概率性检查建议不进三守卫**）；真源 `[DESIGN-SKILL-001]` |
| GOV-DOCS-001（`DOCS-001`） | 每篇业务文档必须带编号前缀 `[<STAGE>-<TYPE>-NNN] 中文名.md`（严禁裸名）；每个 `docs/` 子目录必须有排序首位的 `00_INDEX_*` 索引文件；新增/移动文档必须同步两处索引；编号删除不回收。 | `docs/**` | `BORROWINGS.md` 裸名；新增文档不更新 `00_INDEX` | `check:layout` 的 `docs-index-first` / `docs-index-complete` / `root-whitelist`；`npm run docs:verify` |
| GOV-DOCS-002 | 索引文件的**命名格式**由执行 AI 依目录既有惯例动态决策（严禁在规范或提示词中写死 `00-`、`_index` 等固定格式）；业务文档编号前缀不在本条管辖，归 `[MGMT-STD-007]` R3 写死。 | 索引总领文件的命名 | 规范里强制「一律 `00-` 前缀」 | 人工评审（`[MGMT-STD-001]` §2.3 管辖边界，裁决 X-001） |
| GOV-DOCS-003 | 每条规则必须是一张规则卡（`[MGMT-STD-008]` §1 全 14 字段，含三元字段 `constraint`/`grants`/`benefit`），ID 全局唯一不复用，授予的权力必须有约束边界配对（配对铁律）。 | 一切被登记或被引用的规则 | 只写约束不写权力与福利；两条规则 ID 重复 | `node scripts/ci/check-gov-rules.js` 的 GOV-TOOL-006 |
| GOV-DOCS-004 | 规则的 `.html` 孪生件是 `npm run docs:build` 的构建产物，禁止手改；文档变更必须更新主索引与目录索引。 | `docs/**` | 手改 `.html`；文档变更后索引未回写 | `npm run docs:build` / `docs:verify`；`check:build-artifacts` |

## 11. 未决冲突与已知缺口

| 编号 | 差异/缺口 | 建议裁决 | 本次处理 |
|---|---|---|---|
| UC-001 | `AGENTS.md` / OPS-MAN-169 指向 `.ai/MAP.md`、`.ai/CONTEXT.yaml`、`.ai/GUARDS.md`，磁盘中缺失。 | 由 `khy metadata refresh` 的维护者明确生成责任、提交策略与缺失时的 gate。 | 已裁决（2026-09-10）：生成责任 = 指定入口 `khy metadata gen`（确定性生成器，非 AI 代笔）；提交策略 = 三件套随仓库提交，git 仓库挂 `khy metadata hook install`；缺失门禁 = `khy metadata check` 非零退出。真源 `[DESIGN-MEM-006]` §5；登记日的缺失三件套已按裁决生成补齐 |
| UC-002 | `[DESIGN-LAY-005]` §3.2 根白名单点名 CLAUDE.md、khy.md、LICENSE；当前仓库缺失，而 OPS-MAN-169 又把 CLAUDE.md §1 作为索引。 | 将白名单、实际文件和引用入口统一到一份可生成清单，再裁决是否补文件。 | 已裁决（2026-09-10）：白名单保持封闭口径不变（`root-whitelist` 只查「多出的说明性文件」，不查白名单内缺失项）；`CLAUDE.md` 已在盘（068 §3.2 已知缺口注记已同步修正），`khy.md` / `LICENSE` 仍缺——红线原文定稿与许可证属法律/口径决策，保留维护者裁决，不代笔占位文件 |
| UC-003 | CODEOWNERS 自称由维护映射生成，但维护映射的 areaOwners 为空，实际落到默认 owner。 | 维护者为 area 分配 owner，或明示默认 owner 是正式策略。 | 仅记录；不改生成物。owner 分配属维护者人事决策，待维护者裁决 |
| UC-004 | ACP schema 要求 `method`，运行时却接受无 `method` response；且缺 version/trace/deadline/idempotency。 | 先冻结 ACP response + meta 扩展模型，再版本化 schema。 | 已裁决（2026-09-10）：信封三态拆分 + `meta` 块 + 终态错误码已冻结于 `[DESIGN-ACP-001]` §1/§2/§3（schema v2）；runtime/schema 接线按该文 §5 排期落地，本次不改 runtime |
| UC-005 | 管理 REST、SSE、WS、兼容 API 的错误与响应形状分裂，未发现 OpenAPI 或统一版本政策。 | 建立公开 API catalog 后，分阶段定义信封与迁移策略。 | 已裁决（2026-09-10）：统一错误信封 + 机器码登记表 + SSE/WS 四终态 + 版本弃用政策冻结于 `[DESIGN-API-002]`；API 目录（§7 占位表）与存量端点迁移按该文 §6 排期，本次不动业务接口 |

## 12. 维护与验证

- 新增顶层目录、跨层依赖、扩展或任务入口前，先读 `[DESIGN-LAY-005]` 与本文对应板块。
- 修改本文、根治理入口或 PR gate 后运行：

```powershell
node scripts/ci/check-gov-rules.js
npm run check:layout
node scripts/ci/check-agent-rules.js --changed
```

- 修改治理守卫时，必须同时更新 `scripts/tests/check-gov-rules.test.js`，并用临时 fixture 证明每条新增 error 可使退出码非零。
- 新增或修订**规则本身**时，须先读元规则 `[MGMT-STD-008]`，按 §1 规则卡模板起草、在
  `docs/10_规范/registry/RULES-REGISTRY.json` 查重并登记，再跑：

```powershell
node scripts/ci/check-gov-rules.js        # 十板块 + 规则登记表三元字段 + 权力-约束配对
node scripts/ci/check-agent-rules.js --changed
```

- 可用 `npm run rules:scaffold <DOMAIN>` 生成带全字段的规则卡骨架
  （`[MGMT-STD-008]` §4.6 第 1 条福利）。

## 13. LAYOUT 缺口登记（2026-09-12）

| 编号 | 差异/缺口 | 建议裁决 | 本次处理 |
|---|---|---|---|
| UC-LAYOUT-001 | docs/ 下存在 05_GUIDE_指南 与 05_TEST_测试 两个同级编号目录，违反 `[MGMT-STD-007]` §2.1 编号轴（阶段目录与编号前缀一一对应，不得重号） | 05_GUIDE_指南 重编号为 06A_GUIDE_指南，CPA 指南补 [GUIDE-001]/[GUIDE-002] | 已裁决并修复（2026-09-12）。**引用更正（2026-09-15，裁决 X-005）**：原引 `[MGMT-STD-001]` 第 2.1/2.2 条，但该两条只规定「索引必须存在且排序首位」，不含阶段编号唯一性，依据不成立，已改为 `[MGMT-STD-007]` §2.1 |
| UC-LAYOUT-002 | 07_OPS_运维 等阶段目录存在大量无编号业务文档 | 按 [OPS-MAN-NNN] 编号补齐 | 已裁决并修复（2026-09-12） |
| UC-LAYOUT-003 | 09_STORY_修仙学AI 章节/番外文件无编号 | 按 [STORY-章节-NNN]/[STORY-番外-NNN] 编号 | 已裁决并修复（2026-09-12） |
| UC-LAYOUT-004 | 10_规范 下 17 篇 [DESIGN-<域>-NNN] 缺 .html 孪生 | 导出占位 .html | 已裁决并修复（2026-09-12） |
| UC-STD-001 | docs/10_规范/ 缺 GB/T 8567-2006 国标映射文档，新写规范无分类指引 | 新建 [DESIGN-STD-001] 文档国标映射规范，映射国标分类到 khy-os 阶段目录 | 已裁决并修复（2026-09-12） |
| UC-RULES-001 | 规则散落于 `AGENTS.md` / 本文 GOV-* / `[OPS-MAN-169]` R1–R4 / `[MGMT-STD-001/007]`，四套编号法并存，无统一 ID、无三元字段、无可检索登记表 | 以 `[MGMT-STD-008]` 为元规则建 `RULES-REGISTRY.json`，板块与十大域一一对应 | 已裁决并修复（2026-09-15）：十板块建成，`RULES-REGISTRY.json` 覆盖全部规则族，裁决记录 X-001~X-005 见 `[MGMT-STD-008]` §5.1 |
