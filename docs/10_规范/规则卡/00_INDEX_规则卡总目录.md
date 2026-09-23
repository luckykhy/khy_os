# 00_INDEX 规则卡总目录

> **索引总领文件** · 本目录唯一入口 · 排序首位 · 结构遵循 [MGMT-STD-001] 第三章
>
> 逐条规则卡，格式依据 [MGMT-STD-008] §1。共 91 张，覆盖 §3.1 十大域。
>
> **本目录全部文件由 `node scripts/docs/gen-rules-cards.js` 生成，禁止手改。**
> 字段真源是 `docs/10_规范/registry/RULES-REGISTRY.json`；正文原文在各卡 `ssot` 指向的位置。

## 一、分类内容边界

收：每条登记规则一张卡（frontmatter 14 字段 + 六个固定小节）。
不收：规则正文原文（留在各章程 / 规范文档，卡片只做渲染与指针）、
索引类文档（本文件除外）、非登记对象的散文。

## 二、文件清单

### API（12 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [API-001] 内外 API 边界.md | 内外 API 边界 | P1 / active |
| [API-002] API 版本化与弃用政策.md | API 版本化与弃用政策 | P1 / active |
| [API-003] 统一错误信封与四终态.md | 统一错误信封与四终态 | P1 / active |
| [API-004] 最小披露跨 transport 传播.md | 最小披露跨 transport 传播 | P2 / active |
| [CORS-001] CORS 跨域资源共享规范.md | CORS 跨域资源共享规范 | P0 / active |
| [DLQ-001] 死信队列规范.md | 死信队列规范 | P2 / active |
| [FF-001] Feature Flag 功能开关规范.md | Feature Flag 功能开关规范 | P2 / active |
| [GW-002] AI 模型降级与熔断规范.md | AI 模型降级与熔断规范 | P1 / active |
| [MIG-001] 数据迁移规范.md | 数据迁移规范 | P1 / active |
| [NOTIFY-001] 通知与邮件规范.md | 通知与邮件规范 | P2 / active |
| [OPS-003] Health Check 规范.md | Health Check 规范 | P2 / active |
| [PROMPT-001] Prompt Engineering 规范.md | Prompt Engineering 规范 | P2 / active |
### COMMS（5 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [COMMS-001] ACP 三态信封.md | ACP 三态信封 | P1 / active |
| [COMMS-002] ACP 方法登记制.md | ACP 方法登记制 | P1 / active |
| [COMMS-003] 全链路追踪标识.md | 全链路追踪标识 | P1 / active |
| [COMMS-004] 可观察终态与错误码.md | 可观察终态与错误码 | P1 / active |
| [NAM-002] A2A 与 ACP 命名及术语规范.md | A2A 与 ACP 命名及术语规范 | P1 / active |
### DOCS（7 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [DOCS-001] 文档命名与索引登记.md | 文档命名与索引登记 | P1 / active |
| [DOCS-002] 索引命名格式动态决策.md | 索引命名格式动态决策 | P2 / active |
| [DOCS-003] AI 指令文件标准.md | AI 指令文件标准 | P2 / active |
| [DOCS-004] README 内容规范.md | README 内容规范 | P2 / active |
| [MGMT-STD-008] 规则编写与管理规范（元规则）.md | 规则编写与管理规范（元规则） | P2 / active |
| [MOD-004] 治理总纲板块入口.md | 治理总纲板块入口 | P2 / active |
| [SKILL-001] Skill 编写规范.md | Skill 编写规范 | P1 / active |
### LAYOUT（7 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [LAYOUT-001] 目录层级与文件归类.md | 目录层级与文件归类 | P1 / active |
| [LAYOUT-002] 上帝文件门.md | 上帝文件门 | P1 / active |
| [LAYOUT-003] 任务入口命名规约.md | 任务入口命名规约 | P2 / active |
| [LAYOUT-004] 仓库整理与巡检.md | 仓库整理与巡检 | P2 / active |
| [LAYOUT-005] 构建产物单一根.md | 构建产物单一根 | P1 / draft |
| [LAYOUT-006] 仓库层级可发现性.md | 仓库层级可发现性 | P1 / draft |
| [LAYOUT-007] 三态目录立体分层.md | 三态目录立体分层 | P1 / draft |
### MEMORY（4 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [MEMORY-001] session 与 persistent 区分.md | session 与 persistent 区分 | P2 / active |
| [MEMORY-002] persistent 记录要素.md | persistent 记录要素 | P1 / active |
| [MEMORY-003] 指定读写入口.md | 指定读写入口 | P1 / active |
| [MEMORY-004] session 生命周期清除.md | session 生命周期清除 | P1 / active |
### PROCESS（16 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [BACKUP-001] 备份恢复规范.md | 备份恢复规范 | P2 / active |
| [DR-001] 灾备规范.md | 灾备规范 | P2 / active |
| [IR-001] 事件响应规范.md | 事件响应规范 | P2 / active |
| [PROCESS-001] 分支纪律.md | 分支纪律 | P0 / active |
| [PROCESS-002] 多轨道版本同步.md | 多轨道版本同步 | P1 / active |
| [PROCESS-003] 验收门禁.md | 验收门禁 | P1 / active |
| [PROCESS-004] 委派边界.md | 委派边界 | P1 / active |
| [PROCESS-005] 版本管理与发布触发.md | 版本管理与发布触发 | P1 / active |
| [PROCESS-006] 新机制落地四阶段.md | 新机制落地四阶段 | P1 / active |
| [PROCESS-007] 引导式搜索与压缩保留清单.md | 引导式搜索与压缩保留清单 | P1 / active |
| [PROCESS-008] 新机制落地阶段可校验.md | 新机制落地阶段可校验 | P1 / active |
| [PROCESS-009] 提交时机判据（到点就提交）.md | 提交时机判据（到点就提交） | P1 / active |
| [PROCESS-010] 软件著作权就绪.md | 软件著作权就绪 | P1 / active |
| [PROCESS-011] 规范-实现变更判定.md | 规范-实现变更判定 | P1 / active |
| [PROCESS-101] 贡献者规则提案权.md | 贡献者规则提案权 | P2 / active |
| [PROCESS-102] 下一步最该做什么决策标准.md | 下一步最该做什么决策标准 | P1 / draft |
### RUNTIME（12 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [AGENT-001] 子智能体交接契约.md | 子智能体交接契约 | P1 / active |
| [OPS-002] Graceful Shutdown 规范.md | Graceful Shutdown 规范 | P2 / active |
| [RUNTIME-001] 零硬编码.md | 零硬编码 | P1 / active |
| [RUNTIME-002] 状态透明.md | 状态透明 | P1 / active |
| [RUNTIME-003] 活动式超时.md | 活动式超时 | P1 / active |
| [RUNTIME-004] 终端无滚动区.md | 终端无滚动区 | P1 / active |
| [RUNTIME-005] CLI 错误标准化.md | CLI 错误标准化 | P1 / active |
| [RUNTIME-006] 网关首选通道不得硬钉.md | 网关首选通道不得硬钉 | P1 / active |
| [RUNTIME-007] 修复先复现（看病）.md | 修复先复现（看病） | P1 / active |
| [RUNTIME-008] 新增先提问（求学）.md | 新增先提问（求学） | P2 / active |
| [RUNTIME-009] 删除先报部位（搓澡）.md | 删除先报部位（搓澡） | P1 / active |
| [RUNTIME-010] 工具授权须明确授予（默认拒绝）.md | 工具授权须明确授予（默认拒绝） | P1 / active |
### SECURITY（8 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [AUD-001] 审计日志规范.md | 审计日志规范 | P1 / active |
| [AUTH-002] Session 管理规范.md | Session 管理规范 | P0 / active |
| [SEC-001] 安全规范（安全头 输入验证 注入防护 日志脱敏）.md | 安全规范（安全头 输入验证 注入防护 日志脱敏） | P0 / active |
| [SECURITY-001] 密钥防泄露.md | 密钥防泄露 | P0 / active |
| [SECURITY-002] critical gate 不可绕过.md | critical gate 不可绕过 | P0 / active |
| [SECURITY-003] 弱模型改动护栏.md | 弱模型改动护栏 | P1 / active |
| [SECURITY-004] 权限档 fail-closed.md | 权限档 fail-closed | P0 / active |
| [UPLOAD-001] 文件上传规范.md | 文件上传规范 | P0 / active |
### SOURCING（6 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [SOURCING-001] 上游源码不复制.md | 上游源码不复制 | P0 / active |
| [SOURCING-002] 许可证分级硬门槛.md | 许可证分级硬门槛 | P0 / active |
| [SOURCING-003] 六字段提案先行.md | 六字段提案先行 | P1 / active |
| [SOURCING-004] 能力域归属登记.md | 能力域归属登记 | P1 / active |
| [SOURCING-005] 实现唯一性与四步检索.md | 实现唯一性与四步检索 | P1 / active |
| [SOURCING-006] 决策只追加不改写.md | 决策只追加不改写 | P1 / active |
### TOOLING（14 张）

| 文件名(含编号) | 核心职责(10字内) | 状态 |
| --- | --- | --- |
| [COM-001] 代码注释规范.md | 代码注释规范 | P2 / active |
| [COMP-001] 代码复杂度规范.md | 代码复杂度规范 | P2 / active |
| [FE-004] 前端 CSS 与样式架构规范.md | 前端 CSS 与样式架构规范 | P2 / active |
| [NAM-001] 统一命名规范.md | 统一命名规范 | P1 / active |
| [TOOLING-001] 扩展一目录一 manifest.md | 扩展一目录一 manifest | P1 / active |
| [TOOLING-002] 工具注册契约.md | 工具注册契约 | P1 / active |
| [TOOLING-003] 最小权限与升级废弃.md | 最小权限与升级废弃 | P2 / active |
| [TOOLING-004] 检查入口脚本必须存在.md | 检查入口脚本必须存在 | P1 / active |
| [TOOLING-005] 本地与 CI 双注册.md | 本地与 CI 双注册 | P1 / active |
| [TOOLING-006] 规则登记表.md | 规则登记表 | P1 / active |
| [TOOLING-007] 规则登记表与真源双向可达.md | 规则登记表与真源双向可达 | P1 / active |
| [TOOLING-008] 规则卡由登记表生成.md | 规则卡由登记表生成 | P1 / active |
| [TOOLING-009] 规则接线完整性.md | 规则接线完整性 | P2 / active |
| [TOOLING-010] 维护成本可观测.md | 维护成本可观测 | P2 / active |

## 三、跨分类关联指引

- 规则格式与生命周期：`docs/08_MGMT_项目管理/MGMT-STD/[MGMT-STD-008] 规则编写与管理规范（元规则）.md`
- 字段级单一真源：`docs/10_规范/registry/RULES-REGISTRY.json`
- 板块入口与反例总表：`docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md`
- 本目录所属的编号段：`10`–`19` 跨阶段资产（`docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md` 第三节）
- 起草新规则：`npm run rules:scaffold -- <DOMAIN> "规则名"`
