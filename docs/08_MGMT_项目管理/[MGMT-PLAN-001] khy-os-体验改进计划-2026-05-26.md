<!-- 文档分类: MGMT-PLAN-001 | 阶段: 项目管理 | 原路径: docs/报告/khy-os-体验改进计划-2026-05-26.md -->
# KHY OS 功能扫描与体验改进建议（2026-05-26）

## 1. 目标与结论

- 目标：基于当前 `khy-os` 能力，评估体验短板，并给出可执行的改进路线。
- 当前主观体验基线：**15/100**（按“CLI 编程工具可用性”标准评估）。
- 结论：当前主要问题不是“功能不够多”，而是“能力过载、路径分叉、状态不确定、部分能力未闭环”。

---

## 2. 扫描范围

- CLI 命令体系：`backend/src/cli/*`
- 工具与智能体执行链路：`backend/src/tools/*`、`backend/src/services/toolUseLoop.js`
- AI 网关与多适配器：`backend/src/services/gateway/*`
- 启动与引导链路：`khy_platform/cli.py`、`khy_platform/_bootstrap.py`、`backend/bin/khy.js`
- 前端状态反馈：`frontend/src/api/request.js`、`frontend/src/utils/request.js`
- 文档与版本一致性：`README.md`、`pyproject.toml`、`backend/package.json`

---

## 3. 关键发现（按体验影响排序）

### 3.1 命令规模过大，认知负担高（高影响）

- 主命令数量：110
- 子命令总量：271
- 结果：新用户很难建立“先用什么、后用什么”的心智模型。
- 证据：`backend/src/cli/commandSchema.js`

### 3.2 命令入口存在模式分叉（高影响）

- `khy` 与 `khyquant` 的职责分层对新用户不直观。
- 用户输入后出现“请改用 khy xxx”的二次跳转，损耗操作流畅度。
- 证据：`backend/src/cli/router.js` 中 `khyquant app-only` 分支提示。

### 3.3 暴露了未闭环功能（高影响）

- `order/watch/rank/voice` 等能力仍为预览或开发中提示，但暴露在主命令路径。
- 结果：用户期望与实际交付不一致，降低信任。
- 证据：`backend/src/cli/router.js`（预览模式/开发中提示）。

### 3.4 关键模块过于庞大（高影响）

- `router.js` / `repl.js` / `liteRepl.js` / `aiGateway.js` / `toolUseLoop.js` 合计约 2.3 万行。
- 结果：回归风险高、迭代慢、定位成本高。

### 3.5 超时治理不完全一致（高影响）

- 工具主循环已有 activity-aware idle timeout。
- 但 `cronScheduler` 中仍有 `Promise.race + hard timeout` 路径。
- 结果：长任务即使有进展，也可能被硬切断。
- 证据：`backend/src/services/toolUseLoop.js`、`backend/src/services/cronScheduler.js`

### 3.6 状态文案可观测性不足（中高影响）

- 前端与部分 CLI 状态文案仍有“加载中/稍后”类泛化描述。
- 缺少 Action + Target + Progress，用户不清楚系统卡在哪里。
- 证据：`frontend/src/api/request.js`、`frontend/src/utils/request.js`

### 3.7 文档与版本信息不同步（中影响）

- `README.md` 仍展示 0.1.3/0.1.2 发布说明。
- 实际版本为 `0.1.51`（Python/Node 已同步）。
- 结果：对外认知与实际交付不一致。
- 证据：`README.md`、`pyproject.toml`、`backend/package.json`

### 3.8 代码库存在“并行形态”与潜在重复（中影响）

- 存在 `backend/frontend` 与 `ai-backend/ai-frontend` 等并行目录。
- 工具体系存在多种实现形态（目录工具、平铺工具、legacy bridge）。
- 结果：维护边界不清、协作心智成本高。

---

## 4. 改进建议（P0/P1/P2）

## P0（先做，直接决定从 15 分提升到 50+）

1. 建立“模式化命令视图”
- 提供 `khy code` / `khy quant` / `khy ops` 三种入口视图。
- 默认只展示对应模式命令，`help` 做分层。
- 预期收益：显著降低学习成本与误用率。

2. 对未闭环能力做“下线或隔离”
- 未完成功能移到 `--experimental` 或隐藏菜单，不在主路径展示。
- 只有通过最小验收（可执行、有结果、有错误处理）才进入主命令。

3. 统一入口策略
- `khy` 作为唯一主入口；`khyquant` 保留兼容但不再作为推荐入口。
- 避免“命令重定向提示”成为常见路径。

4. AI 请求路由优化
- 首选通道失败时进行短链路降级，不做长链盲探测。
- 对“不可用适配器”增加冷却期与快速跳过策略。

5. 统一超时模型
- 所有长任务改为 activity/sliding timeout。
- 严禁“固定墙钟时间硬杀”活跃任务。

## P1（第二阶段，推动到 70+）

6. 拆分超大模块
- 将 `router/repl/gateway/toolLoop` 按域拆分：解析层、策略层、渲染层、执行层。
- 增加边界测试与契约测试，降低回归概率。

7. 状态透明化改造
- CLI/前端统一状态协议：`动作 + 目标 + 进度 + 下一步`。
- 例如：`连接 Codex 通道（第 1/3 次）`、`同步会话索引（342/1280）`。

8. 工具体系收敛
- 统一 tool 定义规范，逐步移除 legacy 双轨桥接层。
- 建立“工具能力目录 + 风险标签 + 所属域 + 生命周期”清单。

9. 端口与服务发现统一
- 启动后统一输出“实际监听端口 + 对应客户端配置”。
- 避免用户看到默认端口但服务实际已自增到其它端口。

## P2（第三阶段，冲击 80+）

10. 体验级测试补齐
- 前端补 Vitest + 核心 E2E（登录、路由切换、关键请求失败恢复）。
- CLI 增加用户旅程测试（新手首日路径、网络受限路径、本地模型路径）。

11. 文档自动同步
- 发布流程自动生成并校验 release notes 版本一致性。
- README 首页只保留最新稳定版摘要，旧版本移到 changelog。

12. 目录治理
- 明确 `backend/frontend` 与 `ai-*` 的定位（合并、拆分或桥接说明）。
- 对重复能力建立唯一权威模块，减少多处演化。

---

## 5. 提分预估（主观）

- 完成 P0：15 → **50~60**
- 完成 P0 + P1：15 → **70~80**
- 完成 P0 + P1 + P2：15 → **80~85**

---

## 6. 建议的 4 周执行节奏

- 第 1 周：命令分层视图、未闭环能力隔离、入口统一
- 第 2 周：AI 路由与超时统一、状态透明化一期
- 第 3 周：核心大文件拆分与回归测试补齐
- 第 4 周：文档/发布同步、目录治理与技术债收口

---

## 7. 验收指标（建议）

- 新用户首次完成核心任务成功率（安装、配置、首条 AI 任务）
- 首次可用时间（TTFS: Time To First Success）
- 命令误用率（重定向/未知命令触发率）
- AI 任务失败率、平均恢复时间、超时中断率
- CLI 与前端关键路径自动化覆盖率

---

## 8. 逐项对齐清单（可直接执行）

说明：
- `状态`：`未开始` / `进行中` / `已完成`
- 当前默认全部标记为 `未开始`，后续每次改动后更新本表。

| 编号 | 建议项 | 状态 | 当前现状（扫描） | 目标状态（对齐标准） | 主要改动点（文件） | 验收方式 |
|---|---|---|---|---|---|---|
| P0-1 | 模式化命令视图（code/quant/ops） | 未开始 | 命令总量 110 + 子命令 271，首屏信息密度高 | `help` 与 `/` 菜单按模式分层展示，默认仅展示核心集 | `backend/src/cli/commandSchema.js`, `backend/src/cli/repl.js`, `backend/src/cli/router.js` | 新用户 3 分钟内完成首次任务；未知命令率下降 |
| P0-2 | 未闭环功能隔离 | 未开始 | `order/watch/rank/voice` 有预览/开发中提示但在主路径可见 | 未达标能力移至 `--experimental` 或隐藏，不污染主路径 | `backend/src/cli/router.js`, `backend/src/cli/commandSchema.js`, `backend/src/cli/aliases.js` | 主命令无“开发中”提示；占位能力仅实验入口可见 |
| P0-3 | 统一入口策略（khy 主入口） | 未开始 | `khyquant` 常触发“请使用 khy xxx”重定向提示 | 文档与交互均以 `khy` 为唯一推荐入口，`khyquant` 仅兼容别名 | `khy_platform/cli.py`, `backend/bin/khy.js`, `README.md` | 用户主流程不再出现入口纠偏提示 |
| P0-4 | AI 路由快速降级 | 未开始 | 多适配器探测链较长，失败恢复路径复杂 | 首选失败后按短链路降级，失败通道带冷却窗口 | `backend/src/services/gateway/aiGateway.js`, `backend/src/cli/ai.js` | 首次可用成功率提升；平均响应时间下降 |
| P0-5 | 统一超时模型（activity-based） | 未开始 | 主循环已 activity-aware，但 cron 仍 hard timeout | 长任务统一滑动超时；仅 idle 才超时 | `backend/src/services/cronScheduler.js`, `backend/src/services/toolUseLoop.js` | 长任务无误杀；超时信息包含已完成/未完成项 |
| P1-6 | 拆分超大模块 | 未开始 | `router/repl/gateway/toolLoop` 体量大，耦合高 | 解析/调度/渲染/执行分层，单文件体量可控 | `backend/src/cli/router.js`, `backend/src/cli/repl.js`, `backend/src/services/gateway/aiGateway.js`, `backend/src/services/toolUseLoop.js` | 拆分后测试全绿；关键路径无行为回归 |
| P1-7 | 状态透明化 | 未开始 | 存在“加载中...”等弱信息提示 | 状态文案统一 Action + Target + Progress | `frontend/src/api/request.js`, `frontend/src/utils/request.js`, `backend/src/cli/*` | 状态可定位卡点；用户无需猜当前阶段 |
| P1-8 | 工具体系收敛 | 未开始 | 目录工具 + 平铺工具 + legacy bridge 并存 | 统一 tool 定义规范，逐步下线 legacy 入口 | `backend/src/tools/index.js`, `backend/src/services/toolCalling.js`, `backend/src/tools/*` | 工具注册链路单一；重复实现减少 |
| P1-9 | 端口与服务发现统一 | 未开始 | 自动端口递增已存在，但客户端提示不总是同源 | 始终输出“实际端口 + 客户端配置方式” | `backend/server.js`, `backend/src/cli/handlers/service.js`, `frontend/src/config/*` | 端口冲突下仍可一次连通 |
| P2-10 | 前端/旅程测试补齐 | 未开始 | 后端测试较多，前端自动化较弱 | 前端关键链路自动化 + CLI 用户旅程测试 | `frontend/*`, `.github/workflows/*`, `backend/tests/cli/*` | 回归缺陷前置发现率提升 |
| P2-11 | 文档自动同步 | 未开始 | README 发布说明版本滞后于 0.1.51 | 发布流程自动更新/校验文档版本块 | `README.md`, `scripts/ci/*`, `.github/workflows/release*.yml` | 文档版本与发布版本始终一致 |
| P2-12 | 目录治理与能力归一 | 未开始 | `backend/frontend` 与 `ai-*` 并行，边界心智成本高 | 明确边界：合并、桥接或淘汰路线 | `docs/03_DESIGN_设计/*`, `package.json`, `scripts/*` | 新成员可在 30 分钟内理解目录职责 |

---

## 9. 对齐执行顺序（建议）

1. 先做 P0-2（下线占位能力）与 P0-3（入口统一），立刻减少“误导体验”。
2. 再做 P0-5（超时统一）与 P0-4（路由降级），解决“可用性不稳定”。
3. 最后做 P0-1（模式化视图），在稳定基础上优化“可学性”。

---

## 10. 每项完成后的提交模板（建议）

```
feat(cli): align P0-2 hide unfinished commands behind experimental flag

- move order/watch/rank preview commands out of default help/menu
- add explicit --experimental access path
- update docs and command aliases

Acceptance:
- no preview placeholder in default command flow
- tests: backend tests/cli/* pass
```
