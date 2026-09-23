# ROADMAP.md — khy-os 进步路线图（按模块分域）

> **分工**：本文件是给人看的规划板；`PROGRESS.json` 是脚本的机读真源。
> 规划新任务时：先在 `PROGRESS.json` 的 `tasks[]` 里加条目（ID 递增 T-XXX），
> 再在下表加同 ID 行。状态列由 `update_status.py task <ID> <状态>` 自动双向同步，
> 行格式必须保持 `| T-XXX | 标题 | 类型 | 优先级 | 状态 |` 才能被同步。
>
> 状态取值：`todo / doing / review / done`　优先级：`P0 > P1 > P2 > P3`

---

## 📋 总览

| 域 | 说明 | 任务数 |
|----|------|--------|
| cli | CLI 层（REPL/路由/TUI/handler） | 0 |
| gateway | AI 网关（多供应商/熔断/转移） | 0 |
| services | 服务层（审计/IM 通道/统计/训练） | 3 |
| kernel | 手写 C 内核 | 0 |
| frontend | ai-frontend (Vue3) | 3 |
| khyquant | 量化交易终端 | 0 |
| platform | Python 启动器 / @khy/shared | 3 |
| packaging | 打包分发 / CI / 版本同步 | 1 |
| cross | 跨域/仓库级任务 | 10 |

> 上表任务数由人维护即可（或让 AI 在规划时顺手更新），脚本不强制校验。

---

## services（服务层）

| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-001 | 微信 ilink 通道端到端手测收尾：扫码登录→发消息→工具审批→回复闭环 | feature | P1 | todo |
| T-002 | 全量跑 check-agent-rules.js 清零硬编码端点与含糊状态文本 | quality | P2 | todo |
| T-003 | auditLog 幂等去重与 getModuleStats 前缀过滤补单测 | quality | P2 | todo |
| T-021 | toolUseLoopCore.js 拆分批次 C1-C3：顶层叶子外迁 + runToolUseLoop 阶段拆解 | refactor | P2 | doing |
## cross（跨域/仓库级）

| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-004 | 同步 AGENTS.md / .ai/MAP.md 与实际目录树的一致性 | docs | P3 | todo |
| T-006 | 多机（N 机）协作与「一处出错不处处报」遏制闭环 | feature | P2 | todo |
| T-010 | 五通道决策矩阵：API/CLI/状态直读/服务直调/看屏幕的清晰判定机制（khy-os DESIGN-ARCH-071） | docs | P2 | done |
| T-011 | 启动提速第一刀：dbHealth 完整性检查后台化 + chcp 直调 + TUI enhanced 预热延后 | performance | P1 | done |
| T-012 | 启动提速第二刀（深水区）：Ink 1.4s 载入、Python 稳态 bootstrap 串行检查合并、双重版本检查去重 | performance | P2 | todo |
| T-016 | 可维护性阶段0·立护栏：文件体积门禁 + 根目录残留清理（绞杀者重构前置） | quality | P1 | done |
| T-017 | 可维护性阶段1·拆双子星：replSession.js(13421行) 与 toolUseLoopCore.js(12227行) 按职责提取子模块 | refactor | P2 | done |
| T-019 | 可维护性阶段3·功能审计裁剪：flagRegistry(2331行) 开关盘点 + 死功能归档 | refactor | P3 | todo |
| T-022 | 四端跨设备同步：手机+网页+桌面+终端 WebSocket 实时同步与会话交接 | feature | P1 | todo |
| T-023 | 密钥与端点中心管理（KeyManager）：GUI 一处配 key/端点，全 Agent 双模式一键激活（DESIGN-ARCH-091 P1） | feature | P1 | review |
## frontend（前端）


| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-013 | 打造 khy-os 手机端智能体 APK：Flutter 项目骨架 + 对话页面 + 直连 AI API + 本地存储 | feature | P1 | todo |
| T-014 | khy-os 手机端 APK Sprint 2：WebSocket 连接 khy-os 后端 + 扫码配对 + 远程对话 + 工具调用可视化 | feature | P2 | todo |
| T-015 | khy-os 手机端 APK Sprint 3：语音交互 + 多对话管理 + 文件上传 + 搜索 + APK 签名发布 | feature | P2 | todo |

## cli（CLI 层）

| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-020 | replSession.js 拆分批次 B2-B11：按 [MGMT-PLAN-008] 拆分分批计划逐批提取至 repl/ 子模块 | refactor | P2 | doing |
| T-024 | 长任务收敛机制：review→done 验收清算门 + todo→doing 边界锁 + acceptance 路径核对 | feature | P1 | done |
## gateway（AI 网关）

| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-018 | 可维护性阶段2·网关适配器去重：claude/codex/trae/kiro 等 adapter 抽公共基类 | refactor | P2 | todo |


## kernel（内核）


## frontend（前端）


## khyquant（量化终端）


## platform（Python 启动器）


| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-007 | sync.py 自动判断分支合并时机（方案 A：检测后询问） | feature | P2 | done |
| T-008 | 环境/运行时管理：网页端可列出、下载安装、卸载 node/python/js/jdk 等运行时 | feature | P2 | todo |
| T-009 | T-008 收尾：SHA-256 按(版本/平台/架构)存+安装时取官方 SHASUMS 校验+实测国内镜像 jdk 命名+接入 khy doctor 运行环境体检 | feature | P2 | todo |
## packaging（打包分发）

| ID | 标题 | 类型 | 优先级 | 状态 |
|----|------|------|--------|------|
| T-005 | 为 no-hardcoded-abs-path 增加「第三方安装探测候选表」显式豁免通道 | quality | P2 | todo |

---

## 🌱 种子任务说明

初始 4 条任务（T-001~T-004）依据 khy-os 的 CHANGELOG 1.1.9、`.claude/plans/`
微信 ilink 方案及 AGENTS.md 检查清单整理，属于「有据可查的下一步」。
请按实际进展增删改——本路线图的唯一约束是：**与 PROGRESS.json 保持同 ID 同步**。

## 🧭 排期原则

1. **五档瀑布**（真源 `[PROCESS-102] 下一步最该做什么决策标准`，docs/10_规范/其它规范/）：
   G0 验收债（review/pending_verify/过期租约）→ G1 open Bug → G2 P0/P1 待办 → G3 P2/P3 待办
2. 同档并列按「延迟成本 cod × 把握 conf ÷ 工量 size」评分决胜；缺字段或平分 → G4 停下来问，**禁止按登记先后任取**
3. 单任务以「一次 AI 会话可完成 + 有明确验收标准」为粒度；过大就拆
4. 每个 done 任务应在 khy-os 的 CHANGELOG.md 有对应条目（版本更新时一并写）
