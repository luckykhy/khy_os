# 00_INDEX 规范总目录

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章
>
> **本目录是跨阶段规范资产目录**（编号 ≥ 10 即跨阶段，见 `[DESIGN-LAY-005]` 第三节 3.1）。
> 一处入口回答两个问题：**「某件事怎么做」** → 读 §1 情景速查（含红线）；
> **「某条规范在哪、叫什么」** → 读 §3 文件清单。二者同表同行，不再分两页维护。
>
> 唯一真源：`RULES-REGISTRY.json`（机器登记表）、本文件（人读入口）。
> 原 `[DESIGN-INDEX-001] 规范索引.md` 已于 2026-09-17 并入本文件（见 §5 版本历史）。

## 一、内容边界

**收**：跨阶段生效的**约束型**文档 —— 规范、协议、契约、参考卡，以及机器可读登记表
（`RULES-REGISTRY.json` / `FEATURE-OWNERSHIP.json`）与 `规则卡/` 构建产物。

**不收**：架构设计方案（`[DESIGN-ARCH-*]`，留 `../03_DESIGN_设计/`）、实现记录
（`../04_IMPL_实现/`）、验证报告（`../05_TEST_测试/`）、运维手册（`../07_OPS_运维/`）。
判据不是「标题里有没有『规范』二字」，而是**是否承载跨阶段的约束语义**——
承载者迁入本目录并改号（2026-09-17 收尾：`ARCH-068/069/070/104/114` → `LAY/TOOL/GOV/SOURCING/PROCESS`），
不承载者留在 03。

## 二、情景速查（做什么 → 看哪篇 → 一条红线）

> 红线均出自对应正文；完整条文以正文为准，本表只做定位。
> 域码缩写：`DESIGN-<域>-NNN`，此处省略 `DESIGN-` 前缀。

**代码与结构**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|放新文件 / 建新目录 / 挪文件跨层|LAY-002|未登记顶层目录不得承载代码或文档；跨层依赖必须经 workspace 包，禁深层相对路径|在产|
|新建目录 / 新增 `npm run` 入口|LAY-005|顶层归属 L0–L6 之一；任务入口按 `<域>:<动作>[:<变体>]` 命名|在产|
|清存量杂物 / 每日巡检 / 隔离临时物|LAY-003|只整理生成物·临时物·产物三类；git 已跟踪文件一律不动；**只隔离不删除**；`.html` 孪生不得当孤儿清理|存档|
|产出构建物 / 加 `.gitignore` 条目|LAY-004|一切可再生产物落 `entries/<producer>[/<variant>]`（2026-09-18 由 `_build/` 迁入）；须在 `BUILD-OUTPUTS.json` 登记|在产|
|写 JS/Python/SQL/CSS|NAM-001 · COM-001 · COMP-001|命名按语言轴；TODO 须带归属；圈复杂度与函数长度超阈即拆|在产|
|修后端 `services/` 内部分层|LAY-001|层内单向依赖，不得反向 require|在产|

**接口与协议**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|做 REST/SSE/WS 端点|API-001 · API-002|所有 API 需认证（公开端点除外）；内部 adapter 形状禁外泄；破坏性变更只进新大版本|在产|
|处理错误、返回失败|ERR-001 · API-002 §2|统一错误格式 + 唯一错误码；对外走统一错误信封（12 机器码表）|在产|
|设计幂等接口|API-003|幂等键 UUID v4 + intent_hash + scope 隔离 + 409 冲突检测|在产|
|做 WebSocket/SSE 实时通信|COMM-002|统一信封格式；WS 10s 认证握手 + 30s 心跳；SSE 禁 nginx 缓冲|在产|
|加 ACP 方法 / 改 transport|ACP-001 · COMM-001|响应禁带 `method`（恰一 result/error）；跨边界消息必带 `meta.traceId`|在产|
|服务间通信选型|COMM-001 · MS-001|全通道统一消息格式；服务松耦合，单服务故障不影响整体|在产|
|跨 agent 协作（A2A）|A2A-001|发现靠能力广播、任务靠协商；通信加密 + 认证；能力按实测声明不虚报|在产|
|配置 CORS|CORS-001 · SEC-001 §7|严格 SameSite；`credentials: true` 时禁通配符 origin；预检缓存 24h|在产|
|选文件格式|`FILE-FORMAT-PROTOCOL`|每种格式有且仅有一个核心职责；违反过不了 `check-change-safety`|在产|

**数据与存储**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|做数据库 / 缓存|DB-001 · CACHE-001|结构变更全走迁移脚本；缓存失败不得影响主流程|在产|
|数据迁移|MIG-001|成对 up/down；大表分批；不可逆操作先备份；生产人工确认|在产|
|备份 / 发版|BACKUP-001 · `releaseGateStages.js`|备份可恢复 + 加密存储；发布必过 must 档门禁|在产|
|灾备|DR-001|RTO/RPO 目标 + 备份验证 + 故障转移 + 每季度演练|在产|
|容量规划|CAP-001|压测标准 + 成本预警阶梯 + 扩容决策流程|在产|
|文件上传|UPLOAD-001|32 位十六进制 ID + 魔数检测 + 分片上传 + 自动清理|在产|
|定义输出结构|OUT-001|源码与输出分离；输出位置可预测、可安全清理|在产|
|数据隐私|PRIV-001|数据最小化收集；保留期限有限|在产|

**认证与安全**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|实现认证 / Session|AUTH-002 · SEC-001|Refresh Token 轮换 + httpOnly cookie；并发 Session ≤ 5；Access Token 15 分钟|在产|
|安全 / 隐私总则|SEC-001 · PRIV-001|最小权限 + 安全默认 + 零信任|在产|
|限流|RL-001 · SEC-001 §6|滑动窗口；IP/用户/端点三维；成本加权；429 带 retryAfter|在产|
|审计日志|AUD-001|不可篡改；五字段（Who/When/What/Where/Result）；保留 1 年|在产|
|监控告警|MONITOR-001 · OPS-003|监控覆盖关键组件；三端点分离（/health /ready /live），依赖检查缓存 30s|在产|
|可观测性（Metrics/Traces）|OBS-001 · LOG-001|RED 指标命名 `khy_*`；传播 traceparent；三支柱共享 requestId|在产|
|写日志 / 改 CLI 输出|LOG-001 · `AGENTS.md` 规则 2|结构化 JSON + 请求 ID + 脱敏；面向用户状态必「动作+目标+进度」|在产|

**工程与流程**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|git 操作|GIT-001 · GIT-003|分支命名 `<type>/<area-id>/<description>`；分支纪律见 PROCESS-001|在产|
|写 Commit Message|GIT-002|type 祈使句 + scope + ≤50 字符 subject；BREAKING CHANGE 须标迁移路径|在产|
|写 / 改 README|DOC-003|不得成为第二真源（端口/版本/命令全集/目录树只给指针）；命令须实际可执行|在产|
|新增 / 移动文档|DOC-001 · DOC-002|业务文档须带 `[<STAGE>-<TYPE>-NNN]` 编号；每个 `docs/` 子目录须有排序首位索引|在产|
|写 / 改一个 Skill|SKILL-001|description 四段式且触发短语须在**前 60 字符**内；任务型必须 `disableModelInvocation`；`allowed-tools` 用 `Bash(<prefix>:*)` 不是 ` *`|在产|
|派发子智能体 / 交接|AGENT-001 · PROCESS-001|子智能体间是**报文不是共享内存**，承载信息须显式传 `parent_context_summary`；派发须声明所有权|在产|
|给新机制开门禁 / 让它开始拦人|PROCESS-002|**禁止直接进 S3**：先过 S1 观测，毕业以**样本量**计（S1 ≥200 事件）而非时间|在产|
|写 AI 指令文件|DOC-002（AI 指令标准）|落在读取器会扫到的位置；不超 tier 字符预算；同一事实只允许一处真源|在产|
|部署 / 环境配置|DEPLOY-001 · ENV-001|部署自动化、可重复、可回滚；敏感信息不进版本控制|在产|
|加依赖|DEP-001|只加必需依赖；定期安全审计|在产|
|写测试 / 提 PR|TEST-001 · REVIEW-001|测试独立、可重复；审查 24h 内响应；改守卫必同步 `scripts/tests/` 用例|在产|
|CI/CD 流程|CICD-001|门禁脚本即情景表各「看」列脚本，改动须同仓登记|在产|
|服务优雅关闭|OPS-002|SIGTERM → 停止监听 → drain → 持久化 → 关 DB → exit(0)|在产|
|事件响应|IR-001|分级响应（P0 ≤15min / P1 ≤1h）+ Escalation Matrix + Postmortem|在产|
|什么时候 bump 版本|SEMVER-002 · SEMVER-001 · CHANGELOG-001|按 `CHANGELOG.md` 段落可机判；工作区未收口不 bump|在产|
|长任务可靠性|`RELIABILITY-PROTOCOL`|七大约束（状态机/Watchdog/AbortSignal/Receipt/退避/Fail-Soft/资源保护），门禁 `reliability-gate`|在产|
|从外部项目借鉴实现|SOURCING-001|先过许可证分级硬门槛；六字段提案先行；上游源码不复制|在产|
|决定「谁做」这件事|PROCESS-004|默认自做；委派须命中 G1 用户点名 / G2 能力缺失 / G3 隔离要求之一|在产|
|决定「现在最该做什么」|PROCESS-102|五档瀑布：G0 验收债→G1 open Bug→G2 P0/P1→G3 P2/P3；同档按 cod×conf÷size 评分，算不出唯一赢家 G4 停下来问，**禁止按登记顺序任取**|在产|

**前端与体验**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|做前端页面 / 组件|FE-001 · FE-003（FE-002 标注目标态）|两前端不得互相 import；共用逻辑下沉 `@khy/ui-shared`|在产|
|写前端样式 / CSS|FE-004 · FE-001|颜色/圆角/阴影全走 `var(--khy-*)`；组件样式 scoped + BEM；双主题强制|在产|
|UI 设计验证|UI-TEST-001|不变量清单 + 测试金字塔 + CI 映射三者对齐|在产|
|国际化文案|I18N-001|翻译与代码分离；各语言术语一致|在产|
|性能预算|PERF-001|指标可量化有目标值（FCP<1.5s / LCP<2.5s / FID<100ms）|在产|
|可访问性|A11Y-001|WCAG 2.1 AA 为最低合规级别|在产|

**AI 与记忆**

|你正在做|看|一条红线|状态|
| --- | --- | --- | --- |
|AI 模型调用 / 降级|GW-002|P0→P1→P2 三级降级链；熔断器 50% 错误率触发；成本加权限流|在产|
|Prompt 编写 / 变更|PROMPT-001|模板版本化 + 参数化；长度上限 2000 字符；注入防护；回归测试|在产|
|功能开关 / 灰度发布|FF-001|默认关闭；4 级灰度；最长 3 个月|在产|
|死信与重试|DLQ-001|指数退避 + DLQ 管理|在产|
|记忆系统（运行时）|MEM-001/002/004|记忆分类带保留层级 + 保鲜天数；只记对未来有持久价值的事|在产|
|记忆 / `.ai` 治理|MEM-006|指定入口 `khy metadata`，不手写机器文件；持久记录必带五字段|在产|
|加 / 改工具或扩展|TOOL-001 · TOOL-002|废弃必带 `migration` + 移除版本；工具名是模型契约，兼容期到一个大版本|存档|
|通知 / 邮件|NOTIFY-001|HTML+纯文本双版本模板 + Webhook HMAC 签名 + 退订机制|在产|
|文档国标映射|STD-001|ISO/IEC/IEEE 15289 + GB/T 8567 双标映射|在产|

## 三、文件清单（按域分组，含状态）

> 编号轴：`DESIGN-<域>-NNN`；域字母是规范主题，不是生命周期阶段。
> 状态列取值：`定稿` / `目标态`（描述尚未实现的形态）/ `参考卡` / `机器可读` / `构建产物`。

**协议与边界**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-ACP-001] ACP消息元数据与终态契约.md`|GOV-ACP 契约冻结（三态信封·meta·终态错误码）|存档|
|`[DESIGN-A2A-001] A2A 协议规范.md`|智能体间 A2A 协议（含定位更正横幅）|在产|
|`[DESIGN-A2A-002] A2A 标准协议适配规范.md`|对外互操作的标准 A2A 适配|在产|
|`[DESIGN-API-001] API 设计规范.md`|API 设计总则|在产|
|`[DESIGN-API-002] 外部错误信封与版本弃用政策.md`|GOV-API 契约冻结（统一错误信封·版本弃用）|存档|
|`[DESIGN-API-003] API 幂等性规范.md`|幂等键格式（UUID v4）、意图哈希、scope 隔离、冲突检测|在产|
|`[DESIGN-COMM-001] 通信协议规范.md`|通信协议|在产|
|`[DESIGN-COMM-002] WebSocket 与 SSE 规范.md`|WebSocket/SSE 实时通信、心跳、重连、背压|在产|
|`[DESIGN-CORS-001] CORS 跨域资源共享规范.md`|CORS 策略|在产|
|`[DESIGN-MS-001] 微服务通信规范.md`|微服务通信|在产|
|`FILE-FORMAT-PROTOCOL.md`（未编号）|文件格式职责边界（`check-change-safety` 门控真源）|在产|
|`RELIABILITY-PROTOCOL.md`（未编号）|长任务可靠性协议（七大约束）|在产|

**结构、层级与工具**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-LAY-001] 后端分层架构规范.md`|L2 services 内部代码分层|在产|
|`[DESIGN-LAY-002] 目录层级与文件归类规范.md`|可见性轴 PUB/INT/PRV、分层命名映射、扩展名归类矩阵（规则 `LAYOUT-001`）|在产|
|`[DESIGN-LAY-003] 仓库整理与巡检规范.md`|HK-1–HK-8 红线、L1–L3 风险分级、**只隔离不删除**（规则 `LAYOUT-004`）|在产|
|`[DESIGN-LAY-004] 构建产物单一根规范.md`|唯一产物根 `entries/`（2026-09-18 由 `_build/` 迁入）、三条不变量、`BUILD-OUTPUTS.json` 一份真源（规则 `LAYOUT-005`）|派生|
|`[DESIGN-LAY-005] 仓库层级板块规范.md`|**代码侧层级单一真源**：L0–L6 定位、依赖方向白名单、`docs/` 编号轴、任务入口命名（规则 `LAYOUT-003`）|在产|
|`[DESIGN-LAY-006] 仓库层级可发现性规范.md`|**层内容量单一真源**：可发现性预算四档、前缀家族拆分、整族迁移代价模型、真编组索引判据（规则 `LAYOUT-006`）|在产|
|`[DESIGN-TOOL-001] 工具与扩展升级废弃规范.md`|GOV-TOOL-003 契约冻结（lifecycle 块·版本策略·最小权限）|存档|
|`[DESIGN-TOOL-002] 拓展契约与核心边界规范.md`|**「什么是核、什么是拓展」单一真源**：核 = 壳+漏斗+网关；一拓展一目录一 manifest（规则 `TOOLING-001`/`003`）|在产|

**代码基础**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-NAM-001] 统一命名规范.md`|全栈命名（JS/Python/SQL/CSS/env/tag）|在产|
|`[DESIGN-COM-001] 代码注释规范.md`|注释格式、JSDoc/docstring、TODO/FIXME|在产|
|`[DESIGN-COMP-001] 代码复杂度规范.md`|圈复杂度、函数长度、参数数量、嵌套深度|在产|

**数据与存储**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-DB-001] 数据库规范.md`|数据库|在产|
|`[DESIGN-CACHE-001] 缓存规范.md`|缓存|在产|
|`[DESIGN-BACKUP-001] 备份恢复规范.md`|备份恢复|在产|
|`[DESIGN-OUT-001] 输出结构规范.md`|输出结构|在产|
|`[DESIGN-MIG-001] 数据迁移规范.md`|迁移流程、回滚、大表分批、不可逆操作|在产|
|`[DESIGN-UPLOAD-001] 文件上传规范.md`|大小/类型限制、32 位十六进制 ID、魔数检测、分片上传|在产|

**认证与会话**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-AUTH-002] Session 管理规范.md`|Session 生命周期、Token 轮换、Revocation|在产|

**运维与容量**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-OPS-002] Graceful Shutdown 规范.md`|服务优雅关闭|在产|
|`[DESIGN-OPS-003] Health Check 规范.md`|/health /ready /live 端点|在产|
|`[DESIGN-IR-001] 事件响应规范.md`|事件分级（P0-P3）、Escalation Matrix、Postmortem 模板|在产|
|`[DESIGN-DR-001] 灾备规范.md`|RTO/RPO 目标、备份验证、故障转移、季度演练|在产|
|`[DESIGN-CAP-001] 容量规划规范.md`|容量模型、压测标准（k6）、成本预警阶梯|在产|

**质量与安全**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-TEST-001] 测试规范.md`|测试|在产|
|`[DESIGN-REVIEW-001] 代码审查规范.md`|代码审查|在产|
|`[DESIGN-SEC-001] 安全规范.md`|安全|在产|
|`[DESIGN-PRIV-001] 数据隐私规范.md`|数据隐私|在产|
|`[DESIGN-ERR-001] 错误处理规范.md`|错误处理|在产|
|`[DESIGN-MONITOR-001] 监控告警规范.md`|监控告警|在产|
|`[DESIGN-OBS-001] 可观测性三支柱规范.md`|Logs/Metrics/Traces 三支柱|在产|
|`[DESIGN-CICD-001] CI CD 规范.md`|CI/CD 流水线|在产|
|`[DESIGN-AUD-001] 审计日志规范.md`|不可篡改审计日志、五字段、保留 1 年|在产|
|`[DESIGN-UI-TEST-001] UI设计验证测试规范.md`|UI 设计不变量清单 + 测试金字塔 + CI 映射|在产|
|`[DESIGN-A11Y-001] 可访问性规范.md`|可访问性|在产|

**工程与交付**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-DEPLOY-001] 部署规范.md`|部署|在产|
|`[DESIGN-ENV-001] 环境配置规范.md`|环境配置|在产|
|`[DESIGN-DEP-001] 依赖管理规范.md`|依赖管理|在产|
|`[DESIGN-GIT-001] Git 工作流规范.md`|Git 工作流|在产|
|`[DESIGN-GIT-002] Commit Message 规范.md`|Commit 信息格式|在产|
|`[DESIGN-GIT-003] Git 自动化治理规范.md`|Git 提交/分支/文件组织与自动化治理|在产|
|`[DESIGN-DOC-001] 文档结构规范.md`|文档结构（§12 规范骨架 ≤150 行、§13 中文排版）|在产|
|`[DESIGN-DOC-002] AI 指令文件标准.md`|AI 指令文件的预算·真源·死指针·优先级登记（规则 `DOCS-003`）|在产|
|`[DESIGN-DOC-003] README 内容规范.md`|README 不得成为第二真源：禁项表、T0/T1/T2 档位（规则 `DOCS-004`）|在产|
|`[DESIGN-SKILL-001] Skill 编写规范.md`|Skill 作者的书写约束：description 四段式（触发短语前置）、1024 字符上限、任务型 `disableModelInvocation`、`allowed-tools` 最小权限（规则 `SKILL-001`）|在产|
|`[DESIGN-I18N-001] 国际化规范.md`|国际化|在产|
|`[DESIGN-LOG-001] 日志规范.md`|日志|在产|
|`[DESIGN-PERF-001] 性能规范.md`|性能（`[DESIGN-PERF-002]` 是设计提案，留 03）|在产|
|`[DESIGN-STD-001] 文档国标映射规范.md`|ISO/IEC/IEEE 15289 + GB/T 8567 双标→khy-os 映射|在产|

**前端**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-FE-001] 前端页面规范.md`|前端页面|在产|
|`[DESIGN-FE-002] 前端组件库规范.md`|前端组件库**主篇**（唯一入口；§1 概述 + 子篇索引）|在产|
|`[DESIGN-FE-003] 前端快速参考卡.md`|前端速查|在产|
|`[DESIGN-FE-004] 前端 CSS 与样式架构规范.md`|CSS 分层、BEM、响应式、动画|在产|
|`[DESIGN-FE-005] 组件开发规范.md`|FE-002 子篇：组件结构 / Props / Events / Slots / 样式|在产|
|`[DESIGN-FE-006] 组件API设计-基础组件.md`|FE-002 子篇：基础组件 API 目标态|在产|
|`[DESIGN-FE-007] 组件API设计-反馈组件.md`|FE-002 子篇：反馈组件 API 目标态|在产|
|`[DESIGN-FE-008] 组件API设计-数据组件.md`|FE-002 子篇：数据组件 API 目标态|在产|
|`[DESIGN-FE-009] 组件测试规范.md`|FE-002 子篇：单元 / 集成 / 视觉回归三层测试|在产|
|`[DESIGN-FE-010] 组件文档与发布规范.md`|FE-002 子篇：文档结构、版本管理、发布流程、CHANGELOG|在产|
|`[DESIGN-FE-011] 组件质量保证规范.md`|FE-002 子篇：代码质量 / 覆盖率 / 性能监控|在产|

> 📌 **2026-09-18 B7 拆分**：`[DESIGN-FE-002]` 原 1,490 行，按 `[DESIGN-DOC-001]` §12（规范骨架 ≤150 行，
> 超出的细则拆子篇）拆为**主篇 103 行 + 7 个子篇 `FE-005`~`FE-011`**。原文按 HK-3 留痕至
> `.khyos/housekeeping/2026-09-17-doc-plan/10_规范/`，未删除；7 个子篇随主篇同为**目标态、非现状**。

**AI 网关**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-GW-002] AI 模型降级与熔断规范.md`|P0→P1→P2 降级链 + Circuit Breaker|在产|
|`[DESIGN-PROMPT-001] Prompt Engineering 规范.md`|Prompt 模板版本化、参数化、安全、测试|在产|
|`[DESIGN-RL-001] Rate Limiting 限流规范.md`|滑动窗口限流、成本加权、分布式|在产|
|`[DESIGN-FF-001] Feature Flag 功能开关规范.md`|灰度发布、开关生命周期、审计|在产|
|`[DESIGN-DLQ-001] Dead Letter Queue 规范.md`|死信队列、指数退避重试、DLQ 管理|在产|

**记忆**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-MEM-000]`–`005`|记忆系统总结/标准规范/时机/模板库/速查卡/使用指南|在产|
|`[DESIGN-MEM-006] 记忆与维护元数据生命周期规范.md`|GOV-MEM 契约冻结（session/persistent·记录格式·指定入口）|存档|

**版本管理**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-SEMVER-001] 语义化版本规范.md`|SemVer 规则、双轨道、废弃周期|存档|
|`[DESIGN-SEMVER-002] 版本管理与发布触发规范.md`|何时 bump（T1/T2/T3）、推送分层与自动触发链路（规则 `PROCESS-005`）|在产|
|`[DESIGN-CHANGELOG-001] Changelog 格式规范.md`|Keep a Changelog 格式、自动化生成|在产|

**通知与消息**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-NOTIFY-001] 通知与邮件规范.md`|邮件投递、模板渲染（HTML+纯文本）、Webhook、退订|在产|

**治理与流程**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`[DESIGN-GOV-001] 治理总纲与可执行规则.md`|MOD/MEM/TOOL/ACP/API/BORROW/RUNTIME/PROCESS/SECURITY/DOCS 十板块索引与缺口登记|在产|
|`[DESIGN-SOURCING-001] 借鉴与实现统一规则.md`|从外部项目借鉴实现的统一规则（B 系列）：六字段模板、B-S/B-U/B-L|在产|
|`[DESIGN-PROCESS-001] 委派边界决策矩阵-第六通道外部智能体.md`|「谁做」先于「怎么做」：G1/G2/G3 三闸门、委派契约、降级回退|在产|
|`[DESIGN-PROCESS-002] 新机制落地四阶段流程.md`|拦截型机制的落地节奏：S1 观察→S2 顾问→S3 门禁→S4 主动修复，**毕业以样本量计**；含 Token 经济学判据卡（规则 `PROCESS-006`）|在产|
|`[DESIGN-AGENT-001] 子智能体交接契约.md`|交接的报文契约：下行派发信封（自包含 prompt + `parent_context_summary` + 所有权声明）、上行回报信封（结论/证据/未决/风险）；26 个内置 agent 的五模式映射（规则 `AGENT-001`）|在产|
|`PROCESS-102-下一步最该做什么决策标准.md`|「现在最该做什么」的唯一决策标准：五档瀑布（G0 验收债→G1 救火→G2 要事→G3 次事→G4 停问）+ 档内 WSJF 轻评分（cod×conf÷size），机器实现 `khy hq next`（规则 `PROCESS-102`）|在产|

**机器可读注册表与构建产物**

| 文件 | 核心职责 | 状态 |
| --- | --- | --- |
|`FEATURE-OWNERSHIP.json`（未编号）|能力域 → 唯一实现位置登记（`[DESIGN-SOURCING-001]` B-U1 单一真源）|在产|
|`RULES-REGISTRY.json`（未编号）|规则**族级**单一真源登记表（`[MGMT-STD-008]` §5 步骤 7）|在产|
|`MEMORY-RECORD-SCHEMA.json`（未编号）|持久记忆记录 schema（守卫 `check-memory-schema`）|在产|
|`BUILD-OUTPUTS.json`（未编号）|构建产物登记表（`[DESIGN-LAY-004]` 单一真源，派生 `.gitignore`/`.dockerignore`/`clean.js`）|派生|
|`SOURCING-PROVENANCE.json`（未编号）|外部借鉴溯源登记（`[DESIGN-SOURCING-001]`）|在产|
|`PROPOSAL-ARTIFACT-INDEX.json`（未编号）|提案产物索引|在产|
|`规则卡/`（子目录）|逐条规则卡 + `00_INDEX_规则卡总目录.md`；由 `npm run docs:rules-cards` 渲染|派生|

## 四、跨分类关联指引

- **文档总入口**：`docs/00_INDEX_文档索引.md`。
- **下游**：实现落地 `../04_IMPL_实现/`；验证 `../05_TEST_测试/`；运维手册 `../07_OPS_运维/`。
- **上游设计动机**：`../03_DESIGN_设计/`（纯设计文档，**不承载规则语义**）。
- **与 03 的边界**：标题含「规范」但属 ARCH 编号的纯设计文档留在 03
  （如 `[DESIGN-ARCH-015] 编码规范`、`[DESIGN-ARCH-023] 文档排版`、`[DESIGN-ARCH-079] TUI 界面设计规范`）；
  一旦为其登记规则，须连同文档迁入本目录改号（规则真源与登记表同址原则）。
- **规则卡总目录**：`规则卡/00_INDEX_规则卡总目录.md`（构建产物，禁手改）。
- **规范与设计的裁决冲突**：登记到 `[DESIGN-GOV-001]` §6 未决冲突表，不由本目录裁决。
- **历史台账**：`../04_IMPL_实现/[IMPL-RPT-049] 规范族文档拆分为独立规范目录-2026-09-10.md`、
  `[IMPL-RPT-050] 规范简洁化与情景速查-2026-09-10.md`。
- **新增规范流程**：取本域下一空号 → 按 `[DESIGN-DOC-001]` §12 骨架写（定位+红线+反例+守卫，≤150 行）
  → 同时登记本文件 §2/§3 与目录 `00_INDEX`（CP-3）；被守卫引用的条文改动须同步 `RULES-REGISTRY.json`
  的 `enforcement`/`exec` 字段与 `[DESIGN-GOV-001]` 校验方式列。

## 五、版本历史

|版本|日期|变更|状态|
|------|------|------| --- |
|1.0.0|2026-09-10|初始版本，随规范目录拆分建立|在产|
|1.1.0|2026-09-17|原 `[DESIGN-INDEX-001] 规范索引.md` 并入本文件：§2 情景速查（含「一条红线」列）与原 §2 分域清单合流为「一表一行」的 §2/§3；§1 补内容边界（收/不收判据）；§3 增「状态」列并补全 6 个未收录的机器可读注册表；§4 补与 03 的边界说明。依据 `[MGMT-PLAN-009]` §2 策略 A（情景索引取代清单索引）、§5 批次 B1。原文件按 `[DESIGN-LAY-003]` HK-3 只隔离不删除，隔离清单见 `.khyos/housekeeping/2026-09-17-doc-plan/manifest.json`|在产|
