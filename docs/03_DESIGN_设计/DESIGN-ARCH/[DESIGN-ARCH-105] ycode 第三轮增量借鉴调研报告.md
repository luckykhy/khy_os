# [DESIGN-ARCH-105] ycode（星瑶）第三轮增量借鉴调研报告

> 状态：调研 / 提案（**未实施任何代码改动**）
> 日期：2026-09-15
> 范围：gitee.com/feng-chenhao/xingyao-y-code @ `dev` 分支，HEAD `ba07477`（2026-09-14 23:09，v1.2.27）；上一轮止点 `b00ed5b`（2026-09-13 21:06，v1.2.26）
> 血缘：接续 [DESIGN-ARCH-083]（第一轮，2026-08-08~10，已落地 8 项服务）与 [DESIGN-ARCH-096]（第二轮，2026-09-14，提出 8 项对标 A–H）
> 治理：本报告全部提案按 [DESIGN-SOURCING-001]《借鉴与实现统一规则》判定；GOV-BORROW-003 要求**先提案后编码**，故本文只出提案、不写代码
> 编号：DESIGN-ARCH 当前最大号 104，本文取 **105**（092 断档按 [MGMT-STD-007] R5 不回填）

---

## 0. 方法、许可证门槛与第二轮回执

### 0.1 调研口径

两轮间隔 27 小时，增量共 4 个提交，其中 3 个为品牌与官网资产（黑名单范畴，见 §3），**技术增量仅 1 个**：`3dc5546` `perf(skills): 启动提速——技能指纹剪枝与首屏异步加载（1.2.27）`。

单靠 1 个提交不足以支撑一轮报告，因此本轮把范围扩到**一/二轮从未对标的 6 个能力域**（harness 静态内核、权限终止语义、MCP 硬化、计算机控制纪律、自定义子代理注册、桌面能力可审计性），形成 8 项提案（P-01 ~ P-08）。khy-os 侧现状由只读核查逐一给出文件证据，标注 HAS / PARTIAL / LACKS。

### 0.2 许可证门槛（B-S4，先行判定，决定全部提案的方式上限）

- 上游许可证：**MIT**（核实位置：`/tmp/xingyao-y-code/LICENSE`，21 行，`Copyright (c) 2026 feng-chenhao`）。按 [DESIGN-SOURCING-001] §1 B-S4 表，MIT 档名义上允许 `verbatim`。
- 但 B-S4.1 已登记一个未闭合缺口：khy-os 仓库根**无 LICENSE 文件**，`services/backend/package.json` 与 `packaging/npm/package.json` 声明 `LicenseRef-Source-Available` 而**无许可文本载体**。按 B-S4.1 原文，`verbatim` 档在自身许可补齐前**必须降级为 `reference`**。
- **本轮裁决**：8 项提案一律取 `idea` 或 `reference`，**不取 `verbatim`、不取 `vendored`、不取 `fork`**。既避免悬空风险，也无需走 B-P3 的维护者显式批准通道。

### 0.3 第二轮行动项回执（B-L3：追加留痕，不改写 [DESIGN-ARCH-096] 原文）

核查发现第二轮提出的行动项在 khy-os 侧**已大部分落地**，但存在「实现了能力、没接上门控」的形态。如实登记如下，供后续复盘：

| 第二轮项 | 原优先级 | khy-os 当前状态 | 证据 |
|---|---|---|---|
| **A** turn_undo 深化 | HIGH | 三件套**已实现并接线 6 个写工具**；启动校验门**未接线** | `turnCheckpointService.js:271 rollbackTurn` 两阶段 + `:308` 冲突零写入、`:397 validateRecorderCoverage`、`:434 buildSemanticCorrection`；生产源码 `grep validateRecorderCoverage` 仅命中定义与导出，仅测试调用 |
| **D** 内置技能指纹升级 | HIGH | 指纹/随版升级/恢复内置版**已实现**；但**缺剪枝、缺签名缓存、缺口径版本迁移** | `skillVersionSync.js:42 computeDirFingerprint` + `:55 _collectRelativeFiles`（递归进入**所有**目录，无剪枝集合） |
| **F** 事件断点续传 | MEDIUM | 远程执行流已有完整同构模型；移动端 WS 桥**仍是 50 条整段重放** | `remoteExecStreamStore.js:367 getEventsSince` 有 `after_seq`/`first_available_seq`/`truncated`；`bridgeServer.js:36 HISTORY_MAX=50`、`:626` 全量切片重放、无 `last_seq` 游标 |
| **H** 会话级权限档位 | LOW | **仍缺** | `canonicalState.js:51 buildSnapshot` 字段为 goal/constraints/facts/openLoops/pending，无 permissionMode |
| **E** `/changes` + 批次偏差记录 | LOW | **仍缺** | — |

**结论**：第二轮的真正遗留不是「没做」，而是「做了 90%」。本轮 §5 单列这一现象，因为它比任何新借鉴都更紧急。

---

## 1. 本轮唯一技术增量：`3dc5546` 技能指纹剪枝与首屏异步加载

### 1.1 上游设计（结论级描述，不搬代码）

该提交修的是启动卡顿：技能指纹原实现遍历技能目录的**每一个文件**再逐个读字节，跳过规则只有 `__pycache__` 与 `.pyc`。上游内置的一个公众号发布类技能会携带 `scripts/node_modules`（6326 个文件），而该技能目录本体只有 29 个文件——装完依赖约 200 倍膨胀。上游自测：冷盘首次扫描 25.6 秒，读取文件数 6355 → 29，单目录提速 204 倍、整轮 11.5 倍（注：上游无对应基准脚本，此数据无法用提交代码复现，按推算值对待）。

三层机制：

1. **遍历即剪枝**：改用递归 `os.scandir` 而非「`rglob` 全量遍历后过滤」，在**进入目录之前**用段名集合（`node_modules`/`.git`/`dist`/`build`/`.venv`/`__pycache__`/`.pytest_cache` 等）`continue`，整棵树不进入。
2. **两级失效**：廉价**元数据签名**（只 stat，含相对路径 + 是否目录 + `mtime_ns` + 长度）作缓存键，昂贵**内容哈希**作缓存值；签名变化才重算内容哈希。刻意不只看顶层目录 mtime——嵌套子目录内的增删必须让签名变化。
3. **口径版本迁移**：跳过规则一旦改动就等于换了哈希算法，旧索引记录与新指纹必然永不匹配 → 所有内置技能被误标为「用户」，且自动升级永久失效。解法是给口径加版本号 + 首次启动按新口径重建，且「无法验证用户副本是否与内置源一致的既有记录原样保留、不删除」。

配套还有两处易漏细节：原子目录替换后**必须显式失效缓存**（`copytree` 保留源 mtime，替换后签名可能与替换前撞车）；目录不存在返回空串而非「空目录指纹」（旧实现会对不存在的目录算出一个**常量哈希**，会让两个不同的错误路径被判成内容相同）。

### 1.2 khy-os 现状（已实现第二轮 D 项，但正踩同一个坑）

`services/backend/src/services/skillVersionSync.js` 已具备完整语义：`INDEX_VERSION=1`、内容指纹（逐文件 sha256 + 相对路径排序再 sha256）、首次同步释放副本、khy 版本变更时未改动的自动**原子替换**（staging → `fs.renameSync`）、用户改动保留并标 `user_modified`、用户删除 tombstone 永不复活、索引 schema 不兼容时跳过且不改动任何文件、6 个写工具外的 43 个内置技能目录随版分发。

**但 `_collectRelativeFiles`（`:55`）递归进入每一个子目录，没有任何剪枝集合；`computeDirFingerprint`（`:42`）每次全量读所有文件字节，没有签名缓存，没有口径版本迁移。** 这正是上游 3 天前刚修掉的同一缺陷。khy 的内置技能目录是随 pip wheel / npm 包分发的，一旦某个技能携带 `scripts/node_modules`（上游已有实例），冷启动会重复踩 200 倍膨胀。

### 【借鉴提案 P-01】技能指纹剪枝 + 两级失效缓存 + 口径版本迁移

```
1. 借鉴对象：xingyao-y-code @ 3dc5546（v1.2.27，2026-09-14）
2. 借鉴内容：结论 + 结构。借「遍历即剪枝」「廉价签名作缓存键 / 昂贵哈希作缓存值」
   「哈希口径加版本号并做保守一次性迁移」三条设计结论
3. 解决的问题：khy-os 已实现的第二轮 D 项（`skillVersionSync.js`）其指纹遍历会读入
   技能目录下的每一个文件、无剪枝、无缓存；43 个内置技能目录中任一携带依赖目录
   即触发 200 倍膨胀式冷启动扫描（上游实例：6355 → 29）
4. 许可证与代码性质：MIT（核实位置 `/tmp/xingyao-y-code/LICENSE`，21 行）。
   按 B-S4 名义允许 verbatim，但按 B-S4.1（khy-os 无 LICENSE 文本载体）降级
5. 借鉴方式：idea —— 只取三条设计结论，本仓从零实现；不保留上游痕迹
   （判定依据：上游是 Python + `os.scandir` + `pathlib.rglob`，本仓是 Node
   `fs.readdirSync({withFileTypes})` + 同步递归，无逐行对应关系）
6. 落点与现有实现对比：
   a. 落点：`services/backend/src/services/skillVersionSync.js`（第二轮 D 项的唯一
      canonical，`computeDirFingerprint` 与 `_collectRelativeFiles` 原地扩展，不新建模块）
   b. 四步检索（B-U2）：① FEATURE-OWNERSHIP.json 无 skills 能力域登记（现有仅
      ai-gateway / token-usage / cli-router 三条），本提案建议新增登记（附录 B）；
      ② 符号检索 `grep computeDirFingerprint` 全仓仅 `skillVersionSync.js` 命中，
      无并行实现；③ 模式注册表无「指纹缓存」条目，本仓既有实现即「内容哈希」，
      不新增模式名；④ 层级：L2（services），与第二轮 D 项一致
7. 验收方式：
   - 新建带 `scripts/node_modules/pkg/index.js` 与 `dist/bundle.js` 的技能目录，
     改 node_modules 内文件 / 在 node_modules 新增文件 / 删 dist 内文件，
     断言指纹**不变**；改 `manifest.json` 或 `prompt.md` 断言指纹**必须变**
     （双向断言，防剪枝过度误伤）
   - 包一层计数器统计真实哈希调用次数：两次同目录调用后 `calls == 1`（缓存命中即
     昂贵函数不被调用，断言不依赖计时）；改**嵌套子目录**内文件后 `calls == 2`
   - `node -e "require('./services/backend/src/services/skillVersionSync')"` 快速校验
```

### 【借鉴提案 P-02】首屏「返回缓存 + 事件补齐」与空态消歧

```
1. 借鉴对象：xingyao-y-code @ 3dc5546
2. 借鉴内容：交互行为。借「初始态先返回缓存、由事件推送终态」「把『空列表』视为
   歧义态直到收到终态事件」「非阻塞锁去重防重复扫描」三条行为结论
3. 解决的问题：khy-os 启动序列 `replSession.js:783` 与 `tui/app.js:87` 同步调用
   `runStartupSkillSync`（同步 fs 扫描）；且 GUI 侧**完全不消费技能列表**
   （`apps/ai-frontend/src` grep skill 仅命中 `views/Workflows.vue`，后端唯一
   skill 命中是 `routes/wellKnown.js:85` 的 A2A agent-card，无 /skills 端点）
4. 许可证与代码性质：MIT（同上）；按 B-S4.1 降级
5. 借鉴方式：idea —— 只取交互行为结论，不搬运 pywebview 的 JS 队列与派发线程设计
   （那是 pywebview 同步 `evaluate_js` 的产物，本仓对应 WebSocket/SSE writer）
6. 落点与现有实现对比：
   a. 落点：`services/backend/src/skills/index.js`（`getCachedSkills` 是内存单一
      真源）；前端接入经由此新增 HTTP 路由，不另建索引
   b. 四步检索：① 注册表无 skills 能力域；② 符号检索 `getCachedSkills` /
      `discoverAllSkills` 集中在 `skills/index.js`，`skillRegistry.js:51 BUILTIN_SKILLS`
      是遗留的 5 个硬编码 slash 命令（与目录式体系**并行分裂**，属 B-U3 第 5 条
      重复度信号，另立 B-L2 迁移议题，不并入本提案）；③ 模式注册表既有值；
      ④ 层级 L2
7. 验收方式：冷启动下首屏不等待技能扫描；技能列表终态经事件推送；扫描期间前端
   显示「加载中」而非「暂无技能」；并发触发两次扫描仅执行一次（用计数器断言）
```

---

## 2. 一/二轮未覆盖的能力域（本轮新增对标）

### 2.1 回合 harness 静态内核 —— 本轮最有分量的架构借鉴

**上游设计**（`core/harness/`，设计规格 `docs/superpowers/specs/2026-08-14-static-harness-kernel-design.md`）：

- **状态机**：Turn 8 态（`created → preparing → running → {completed|cancelling→cancelled|failed|interrupted}`）、Step 10 态（`assistant_ready` 是「模型说完话」的分叉点：有 tool_calls 走 `tools_running → tools_committed → completed`，无则直接 `completed`）。转移表是「状态 → 允许的目标集合」，非法迁移抛错且**不静默修正**；4 个终态的目标集合为空集，物理上无法再变。
- **Journal 硬隔离**：4 张表记状态机位置、ID、序号、时间戳、耗时、SHA-256 哈希、结果状态枚举、脱敏错误码。**严禁记**：用户/assistant 正文、原始流 chunk、原始工具参数与结果、API Key 与认证头、缓存亲和 ID 原值。这条铁律靠类型强制（事件草稿是字段白名单的不可变结构，**根本没有 payload 字段**），不靠自觉。
- **原子提交接缝**：正文插入、序列号自增、Journal 事件插入**在同一事务内**提交，任一处失败整体回滚、Turn 显式 failed。删消息时 Journal 事件靠外键 `ON DELETE SET NULL` 保留审计轨迹但切断内容引用。
- **请求指纹**：5 路 sha256 + 4 路字节数 + attempt，在**规范化链末端**捕获，只读、不参与发送，序列化刻意**保序**（重排 dict 会直接破坏前缀缓存）。用途不是幂等键，而是**缓存漂移定位**——命中率下降时查哪一步指纹开始变化，把「缓存回归」从玄学变成可查表。
- **崩溃恢复的「四条不」**：不修改消息内容、不补造工具结果、不自动发起模型请求、不重放副作用工具。崩溃只标 `interrupted`，不猜测是否成功。
- **确定性进展熔断**：只比 3 个状态哈希 + 修改类提交标记 + **有界读取预算**（每回合最多 48 个新读取签名，真实进展时重置），**完全不读模型自然语言**。真实调查链（读新文件、搜新代码）不算停滞，复制粘贴式空转仍熔断。熔断点在**创建新 Step（即发下一次请求）之前**。
- **迁移策略**：固定内核 + 兼容外观层 + 阶段 0 先冻结黄金字节夹具；阶段切换是代码审查门禁而非运行时双轨，**不引入静默 fallback 或长期 feature flag**。

**khy-os 现状（PARTIAL，且形态与上游相反）**：显式 FSM 内核**已存在**（`services/domain/state/stateMachine/fsm.js:60 FiniteStateMachine`，声明式转移表 + 5 台机：`toolLoopPhases.js` 9 状态 10 事件、`replPhases`、`startupPhases`、`agentLifecycle`、`turnPhaseTracker` 16 阶段），**但它是影子观测层**——`fsm.js:6-13` 明写「非法转移永不抛、只记 illegal」「hook 走 `queueMicrotask` 吞异常」「影子观测调用方绝不能让宿主热路径崩溃」，唯一接入点 `toolUseLoopCore.js:142-154` 只做观测。真实回合状态由 `toolUseLoopCore.js`（**12018 行**隐式分支）管理。请求指纹**存在但不在 AI 回合上**（在 `remoteExecStreamStore.js:151`，用于远程执行流）。无 AI 回合事件 Journal、无 turn 级单调 seq。

**方向判断**：上游是「把隐式主循环下沉成数据不变式」，khy 是「已有形式完备的 FSM 但语义上是观测层」。两者方向一致，khy 的障碍不是缺 FSM 而是缺「让 FSM 驱动控制流」的增量勇气。**不建议一次性照搬上游全套内核**——那等于重写 1.2 万行主循环，违反 [DESIGN-SOURCING-001] B-L1「不做一次性大重构」。建议按 B-L2 三步迁移分期推进。

### 【借鉴提案 P-03】回合事件 Journal + 单调 seq + 事务内提交 + 不重放语义（分期立项）

```
1. 借鉴对象：xingyao-y-code @ ba07477（`core/harness/` + 设计规格 2026-08-14）
2. 借鉴内容：结构与测试策略。借「Journal 只存元数据与哈希、不含正文」
   「正文与事件同事务提交」「CAS 乐观并发 + 唯一序号约束」
   「崩溃只标 interrupted、绝不重放副作用」四条结构结论
3. 解决的问题：khy-os 无 AI 回合事件 Journal，崩溃恢复是进程级
   （`crashRecovery.js` uncaughtException 守卫）+ 跨会话 checkpoint，不是回合内
   事件重放；多租户场景下审计表若含正文会成为第二个正文库（合规风险）
4. 许可证与代码性质：MIT（同上）；按 B-S4.1 降级
5. 借鉴方式：reference —— 保留结构语义（表关系、事务边界、非目标清单），
   逐字改写命名与实现（判定依据：SQLite → PostgreSQL，单进程 owner →
   按 tenant+turn 的租约粒度，需整体重新设计）
6. 落点与现有实现对比：
   a. 落点：扩展 `services/domain/state/stateMachine/fsm.js` 的
      `FiniteStateMachine` + `toolLoopPhases.js` 转移表；序号模型直接复用
      `remoteExecStreamStore.js` 的 `getEventsSince`/`lastSeq` 同构实现
   b. 四步检索：① 注册表无该能力域；② 符号检索 `FiniteStateMachine` 全仓仅
      `fsm.js` 命中，无并行 FSM；`remoteExecStreamStore.js:325` 是全仓唯一的
      单调 seq 实现；③ 模式注册表 `State`(25)/`Observer`(28)/`Memento`(22) 既有；
      ④ 层级 L2 services + L3 domain 分层，需按 [DESIGN-LAY-005] 复核归属
7. 验收方式：本提案只到「立项 + 规格」，不验收代码。立项后按 B-L2 三步走：
   步骤 1/3 标记（`turnPhaseTracker` 影子态转 deprecated，写替代路径与删除日期）
   → 步骤 2/3 迁调用方 → 步骤 3/3 删旧实现，每步独立可回滚
   （注：B-U5.1 禁止「旧实现有 bug 所以新写一个」，故必须先走标记再迁移）
```

### 2.2 权限终止语义 —— 最小改动、最高语义价值

**上游设计**（`core/permission_broker.py` + `gui_bridge.py:3906`）：同一份裁决代码，**两种终止语义**——

- 无人值守回合的权限请求当场判定为拒绝，不弹卡、不等待。上游给出的理由是：这类回合不存在「人重新出现在界面」的时刻，等待必然把回合挂成死等。
- 人工回合的权限确认则反向处理：无限期保持待决，用户离开也不自动拒绝。理由是自动拒绝会被模型当成「用户说不」的信号，诱发继续跑偏或反复重试；保持待决则任务只是安全暂停，用户回来仍能作答或手动停止。
- `CANCELLED_RESULT` 与「用户拒绝」是**两个独立结果值**（拒绝是有意的安全信号，取消是没有信号）。
- **凭据写入不给「总是允许」选项**（放行粒度跟着目标敏感度走，而不是跟着操作类型走）。

**khy-os 现状（PARTIAL）**：权限本体成熟——`toolCallingPermissions.js:65-72` 7 档 mode、`:103-111` `_MODE_TO_PROFILE` 唯一映射、`permissionStore.js:291 check` 13 步判定链、`unattendedAutoAnswer.js:34-44` `KHY_UNATTENDED_AUTOANSWER` **默认关**且经 `autoAnswerIntentGuard` 按用户原始本意校准。缺的是**按调用来源切换终止语义**的显式规则与「取消 vs 拒绝」的结果值分离。

### 【借鉴提案 P-04】权限双终止语义与「取消 ≠ 拒绝」结果分离

```
1. 借鉴对象：xingyao-y-code @ ba07477（`core/permission_broker.py`、`gui_bridge.py`）
2. 借鉴内容：结论。借三条行为结论：按调用来源（人工 / 自动化）切换终止语义；
   取消与用户拒绝是两个独立结果值；放行粒度跟随目标敏感度而非操作类型
3. 解决的问题：khy-os 的 `unattendedAutoAnswer` 是「自动选择推荐项」而非
   「自动拒绝」，两者语义相反（自动选择可能把高风险请求变成自动放行）；
   且无「取消」与「拒绝」的结果值区分，超时会被模型误读为「用户说不」
4. 许可证与代码性质：MIT（同上）；按 B-S4.1 降级
5. 借鉴方式：idea —— 三条结论均可一句话抽象，本仓自写
6. 落点与现有实现对比：
   a. 落点：`services/backend/src/services/permissionStore.js` 的 `check`
      判定链 + `unattendedAutoAnswer.js`；不改 `toolCallingPermissions.js` 的
      7 档 mode 分类（khy 的 7 档是上游 4 档的超集，见 §4）
   b. 四步检索：① 注册表无权限能力域；② 符号检索 `_MODE_TO_PROFILE` / `check`
      集中在 `toolCallingPermissions.js` 与 `permissionStore.js` 两处，
      `desktopControl/safetyGate.js` 是桌面专用不可复用；③ 模式注册表
      `Chain of Responsibility`(15)/`Strategy`(144) 既有；④ 层级 L2
7. 验收方式：自动化来源 + 高风险请求 → 立即得到「自动拒绝」结果且带独立错误码；
   人工来源 + 用户离开 → 请求保持待决且不计入执行超时；用户点取消与点拒绝
   在结果结构中可区分；`node scripts/ci/check-agent-rules.js --changed` 绿
```

### 2.3 MCP 硬化 —— 四项低成本低风险改进

**上游设计**（`core/mcp_client.py`）：

1. **tools 列表按工具名排序**：各 server 连接完成顺序随网络波动，不排序会导致每轮 tools 数组顺序变化 → **前缀缓存全部失效**、隐性成本暴涨。这是本轮最便宜的一处纯收益。
2. **启动命令白名单 + 危险 env 黑名单 + 连接前强制复核**：命令必须是裸 basename 且匹配固定前缀，含路径分隔符直接拒绝；黑名单含 `BASH_ENV`/`LD_PRELOAD`/`NODE_OPTIONS`/`PYTHONPATH`/`DYLD_*` 等；**在建立连接前再复核一遍同一套准入规则**（因为手工编辑配置文件会绕过新增接口的校验）；子进程 env 走**白名单继承**，使模型 API 凭据不会泄漏进第三方子进程。
3. **失败后重置标记允许下次重试**：避免一次连接失败把 MCP 永久变砖，且后续每次调用都重复阻塞等待超时。
4. **server 级前缀幂等替换 schema**：同 server 的取消-重试竞态下不会产生重复工具与重复子进程。

**khy-os 现状（PARTIAL）**：MCP 栈量级远超上游（`services/domain/messaging/mcp/` 合计约 6836 行，含 OAuth 令牌存储、HTTP server、治理、工具池、CC/OC/OE 三桥），但**该目录下 grep `.sort(` 结合 tool/schema/name 零命中**——tools 列表未按名排序。

### 【借鉴提案 P-05】MCP tools 列表按名排序 + 凭据隔离复核

```
1. 借鉴对象：xingyao-y-code @ ba07477（`core/mcp_client.py`）
2. 借鉴内容：结论。借「tools 列表按名排序保证前缀缓存字节稳定」
   「连接前强制复核启动命令与 env 白名单」两条
3. 解决的问题：khy-os MCP 工具池按 server 连接完成顺序拼接，连接时序随网络波动
   → 每轮 tools 数组顺序漂移 → 前缀缓存失效（多租户下成本影响放大）
4. 许可证与代码性质：MIT（同上）；按 B-S4.1 降级
5. 借鉴方式：idea —— 一句话可抽象，本仓自写（一行稳定排序）
6. 落点与现有实现对比：
   a. 落点：`services/domain/messaging/mcp/toolPool.js` 的 schema 聚合出口
   b. 四步检索：① 注册表无 MCP 能力域；② 符号检索 `.sort(` 在该目录
      tool/schema/name 上下文零命中，确认无既有排序；③ 模式注册表既有；
      ④ 层级 L3 domain
7. 验收方式：两次冷启动（模拟 server 连接顺序不同）产出的 tools 数组**逐字节一致**；
   带路径分隔符或黑名单 env 的 server 配置被拒绝且报错含修复建议
```

### 2.4 计算机控制纪律层 —— 借纪律，不借实现

**上游设计**（8374 行 Windows 专用，ctypes/COM/Playwright 深度耦合，**不借实现**）：

- **实例封闭 + 执行权不提前交接**：实例超时后**永久封闭**（拒绝后续所有输入而非静默重试），后台进程真正退出前不把执行权交给新实例。解决「超时后用户以为已停止，输入副作用仍发生」这一类不可感知的数据损坏——结果未知时宁可拒绝一切后续操作，也绝不假装成功或假装未执行。
- **分段耗时如实上报**：未发生的阶段**不出现该字段**，绝不默认 0ms。上游实测结论：6 步任务共 14.4s，Provider 决策 14.19s（98.5%），本地键鼠+截图合计 0.21s（1.5%）——直接推翻「加 sleep 或调提示词」这类错误优化方向。
- **审计矩阵落 docs**：平台×通道×应用×重复性×环境五维，明确写出做不到的平台，以及「后台进程被操作系统限制把目标窗口提到前台」这类 OS 层约束；桌面 native 像素滚动**维持显式拒绝**并注明这属于 OS 能力边界而不是实现缺口。
- **能力闸门的发现性补强**：开关已开但模型不合格时，设置接口返回可操作的原因码，而非让模型如实回答「我没有这个功能」。

**khy-os 现状（PARTIAL）**：功能实体完备（`computerUseAgent.js` 2023 行、`backendRegistry.js` 三平台后端、UIA/atspi 无障碍树、500 次/会话熔断、批量工作流授权），但**无审计矩阵**（`capabilityMatrix/` grep desktop/computer_use/screenshot 零命中）、**无 benchmark**（`benchmarkSuite.js` grep desktop 零命中）。

### 【借鉴提案 P-06】桌面能力审计矩阵 + 分段耗时如实上报

```
1. 借鉴对象：xingyao-y-code @ ba07477（`docs/computer-apps-matrix.json`、
   `docs/computer-local-benchmark.json`、`docs/computer-control-audit-20260905.md`）
2. 借鉴内容：测试与验证策略 + 结论。借「审计矩阵按平台×操作×可用性形式化落文档」
   「分段耗时未发生则不出现该字段」「做不到就在协议里显式拒绝而非静默近似」
3. 解决的问题：khy-os 桌面能力实体完备但**不可审计**——能力目录未收录桌面能力，
   benchmark 套件零桌面项，无法回答「某平台某操作是否可用」，也无法区分
   模型慢 / 排队慢 / 动作慢
4. 许可证与代码性质：MIT（同上）；按 B-S4.1 降级。注意：审计报告 JSON 与
   审计脚本属上游**测试资产**，不搬文件，只借维度定义
5. 借鉴方式：idea —— 借维度与纪律，本仓自写矩阵与探针
6. 落点与现有实现对比：
   a. 落点：审计矩阵扩展 `services/domain/catalog/capabilityMatrix/descriptors.js`
      （已有 descriptor+predicate 骨架）；benchmark 挂在
      `services/backend/src/services/benchmarkSuite.js` 的 results 数组；
      风险分级沿用 `desktopControl/safetyGate.js` 的 `OP_RISK`（已是唯一真源）
   b. 四步检索：① 注册表无桌面能力域；② 符号检索 capabilityMatrix 目录
      desktop 零命中、benchmarkSuite desktop 零命中，确认无既有实现；
      ③ 模式注册表既有；④ 层级 L3 domain（能力目录）+ L2（benchmark）
7. 验收方式：矩阵文件覆盖 win32/darwin/linux × 全部动作类型，每项标注
   可用 / 不可用 / 未验证及原因；benchmark 输出分段耗时，未发生的阶段字段缺失
   而非 0ms
```

### 2.5 自定义子代理注册中心

**上游设计**（`core/subagent_registry.py`，318 行）：扫描用户级与项目级 `agents/*.md`，frontmatter 含 `name`/`description`/`when_to_use`/`base_type`/`model`/`allowed_tools`/`color`，正文即系统提示词。内置 5 种类型（explore/implement/test/review/general）各带**工具白名单**；自定义代理用 `base_type` 决定角色。缓存指纹 = (path, mtime, size) + 小文件内容哈希前缀——只用 mtime/size 会被等长改写命中旧缓存。防御：与内置类型重名跳过并告警、非法值回落、解析失败只写日志不裸 print。

配套运行时约束值得单列：子代理深度上限 3（作用域**必须包住事件消费循环**而非只包生成器创建语句，否则深度会在真正执行前复位、限制永久失效）；并发上限 5 且**排队等待的时限按任务自身的超时预算计算**（名额被卡死任务占用时直接判超时，避免前台无限阻塞）；审批等待**不计入**执行超时但设独立上限（中间层无响应时任务不得无限期悬挂并占住并发名额）。

**khy-os 现状（LACKS）**：有 `subAgentOrchestrator.js`、`subAgentModelSelect.js`、`subAgentTextStream.js`、`subagentContextSummary.js`（编排层），但**无用户可定义的自定义子代理注册中心**（全仓 `find *subagent*` 无 registry/scanner 文件）。

### 【借鉴提案 P-07】用户可定义的自定义子代理注册中心

```
1. 借鉴对象：xingyao-y-code @ ba07477（`core/subagent_registry.py`）
2. 借鉴内容：接口形状 + 结论。借「Markdown 文件即子代理定义」的输入 schema、
   三级缓存指纹、与内置类型重名告警与非法值回落的防御策略
3. 解决的问题：khy-os 子代理编排层完备但子代理**类型硬编码**，用户无法声明
   新的受限角色（工具白名单 + 专用系统提示词），只能改源码
4. 许可证与代码性质：MIT（同上）；按 B-S4.1 降级。注意 frontmatter 解析
   直接复用本仓既有解析器，不搬上游的正则手写解析（上游只认 3 个字段，
   已存在解析正确性缺陷）
5. 借鉴方式：reference —— 保留输入 schema 与防御语义，命名与存储路径按本仓约定
   改写为 `~/.khyquant/agents/` 与 `<workspace>/.khy/agents/`（B-S2 第 3 条：
   不落上游的 `.ycode/` 路径布局）
6. 落点与现有实现对比：
   a. 落点：扩展 `services/backend/src/services/subAgentOrchestrator.js`
      （编排层唯一 canonical），新增读取注册表的能力，不新建并行编排器
   b. 四步检索：① 注册表无子代理能力域；② 符号检索 `subAgent` 命中 4 个编排文件
      但无 registry/scanner；③ 模式注册表 `Factory Method`(9)/`Singleton`(40) 既有；
      ④ 层级 L2 services
7. 验收方式：新建 `<workspace>/.khy/agents/reviewer.md`（含 allowed_tools 白名单）
   后无需改码即可被编排层发现；与内置类型重名时跳过并告警；
   工具白名单外的调用被拒绝
```

---

## 3. 明确不借鉴清单（B-S2 黑名单命中，无决策权，直接拒绝）

| # | 上游内容 | 命中条款 | 处置 |
|---|---|---|---|
| 1 | 2026-09-14 三个品牌提交（界面文案统一为「星瑶Code」、技能与提示词统一为「星瑶」、官网更名与站点资源） | **B-S2 第 5 条**：品牌素材（名称/logo/站点资源）属品牌资产，搬运即侵权 | 不借。khy-os 的品牌与文案保持自有 |
| 2 | `assets/CHANGELOG.md`、`README.md`、`LICENSE` 文本 | B-S2 第 5 条 | 不借。许可证仅用于判定借鉴方式（§0.2），不入库 |
| 3 | 官网一键部署脚本 `scripts/` + 站点部署流程 | **B-S2 第 2 条**：上游的构建/发布/CI 系统 | 不借。khy-os 有独立的 pip+npm 双轨版本同步（6 真源） |
| 4 | 上游目录布局（`core/`/`待开发/`/`skills/`/`vendor/ripgrep/`） | **B-S2 第 1 条**：上游内部约定；khy-os 分层真源是 [DESIGN-LAY-005] | 不借 |
| 5 | `~/.ycode/` 数据目录布局与 SQLite 表 schema（harness_owners/harness_turns/harness_steps/harness_events、`permissions.json`、`builtin_skills_index.version`） | **B-S2 第 3 条**：运行时数据目录与状态文件格式，破坏 `~/.khyquant/` 与 `.khy/` 既有消费者 | 只借信息模型，落本仓自己的路径（如 P-07 已改写为 `.khy/agents/`） |
| 6 | 上游治理/决策文档条款（`AGENTS.md`、`CLAUDE.md`、`待开发/*/01-完整设计规格.md` 的章节措辞、验收清单措辞） | **B-S2 第 4 条 + B-S5**：治理必须内源；连续 12 个中文字以上完全相同即判 ERROR | 只提炼原则，重写成本仓条款。§6 的工程文化经验已全部改写，不含上游连续 12 字以上原文 |
| 7 | 上游 Python 源码文件本体（`core/harness/`、`core/computer/`、`core/skills.py`、`core/permission_broker.py` 等） | **B-S3 红线**：不得复制进 `services/`、`apps/`、`platform/`、`scripts/`；且本轮已按 B-S4.1 排除 `vendored` | 不搬任何文件 |
| 8 | `core/llm.py` 6704 行单文件 + 27 处 `if harness_runtime is not None` 守卫挂接的形态 | B-S2 第 1 条（模块分层） | 这是渐进迁移的**历史产物**，上游自己在规格里承认目标是逐步收缩该文件。本仓不应复制该形态，应直接分层（P-03） |
| 9 | 上游 LSP-lite 正则跳转定义、Git Worktree 四函数 | 非黑名单，但属**反向不借** | 见 §4：khy-os 已有完整真实 LSP 客户端（`lspClient.js` 780 行，含 definition/references/hover/completion/codeActions/diagnostics）与更重的 worktree 支持（`worktreeManager.js` + `worktreeSessionCwd.js` + `repl/worktreeCommand.js`）。上游的正则版是其严格子集，作为对标基准会误导方向 |

---

## 4. khy-os 反向优势（ycode 缺、无需动作）

记录在案，避免后续误以为要「补齐」：

- **回合级撤销的冲突零写入**已实现并接线 6 个写工具（上游是同期新增，两者持平）
- **MCP 栈量级**：约 6836 行含 OAuth、HTTP、治理、工具池、CC/OC/OE 三桥（上游只有 stdio、无 OAuth、无 HTTP、无治理）
- **权限分类**：7 档 mode（default/plan/acceptEdits/auto/dontAsk/bypass/RedPass）+ 6 profile + 三级 scope + 13 步 fail-closed 判定链 + learned ledger 隐式放行 + 确定性 risk 门槛（上游 4 档 confirm/accept_edits/plan/full 是子集）
- **桌面操控**：win32/darwin/linux 三平台后端 + UIA/atspi 无障碍树 + 500 次/会话熔断 + 批量工作流授权 + `OP_RISK` 五级风险表（上游只有 Windows 真实现，macOS/Linux 显式不可用）
- **LSP**：完整真实 LSP 客户端，六类能力（上游只做跳转定义）
- **远程执行流**：已有教科书式的单调 seq + `after_seq` 游标续传 + 截断告知 + 请求指纹（600 事件/流、240 流、30min/12h TTL）——本仓内唯一成熟的游标续传实现，比上游 LAN 侧的 128 条环形缓冲更完整
- **技能语义**：tombstone 永不复活 + 索引 schema 不兼容时跳过且不改动任何文件 + 6 个写工具全覆盖（这些在 P-01 中保留，不属于可替换项）

---

## 5. 比新借鉴更紧急：khy-os 三处「名义具备但生产未接线」

只读核查发现本仓存在一个重复出现的形态——**能力已实现、门控未接线**。这类缺口不会被任何新借鉴覆盖，且风险已经真实存在：

| # | 位置 | 名义能力 | 实际状态 | 建议 |
|---|---|---|---|---|
| 1 | `services/backend/src/services/turnCheckpointService.js:397` `validateRecorderCoverage` | 启动校验撤销覆盖无死角（第二轮 A 项的核心红线：凡声明会改文件的工具必须接入记录器，否则启动即失败） | **生产源码零调用**，仅测试调用 | 接入 `replSession.js:783` 与 `tui/app.js:87` 的启动序列（与 `runStartupSkillSync` 同一位置），按既有 `flagRegistry` 门控风格加 env 门 |
| 2 | `services/domain/state/stateMachine/fsm.js` + `turnPhaseTracker.js` | 显式 FSM 内核 + 16 个用户可读阶段 | **影子观测**：`fire()` 非法转移永不抛、hook 走 `queueMicrotask` 吞异常，唯一接入点只做观测 | 属 P-03 分期议题。**不建议单独修**——单独把观测层改成驱动层就是「新写一个」，违反 B-U5.1 |
| 3 | `apps/ai-frontend/src` 技能消费 + `routes/` 技能端点 | GUI 技能视图 | **GUI 完全不消费技能列表**；后端唯一 skill 命中是 `routes/wellKnown.js:85` 的 A2A agent-card | 属 P-02 议题，需先出端点再出视图 |

另有一处**并行分裂**应登记为 B-U3 第 5 条重复度信号：`services/skills/index.js`（目录式，43 个内置技能）与 `services/skillRegistry.js:51 BUILTIN_SKILLS`（遗留的 5 个硬编码 slash 命令）是两套并行体系。按 B-L1 归为 **P2 级**（一处已事实上旁路但仍存在），建议记入 `forbidden` 后走 B-L2 三步迁移，**不做一次性合并**。

---

## 6. 工程文化可迁移经验（B-S5：只提炼原则，条款文字已改写）

比单项功能更值得学的是协作与文档纪律。以下 5 点为改写后的结论，**不含上游连续 12 个中文字以上的原文**（按 B-S5 人工评审口径自查）：

1. **每个特性四件套**：工作包索引 + 唯一实施需求基线 + 分角色的开发提示词（主开发 / 评审 / 修复 / 验收四个角色各一份）+ 验收清单。基线文档首行即声明它是唯一需求基线，并明确禁止用占位实现、内存状态或强制覆盖替代规格要求的持久化与事务语义。khy-os 的 AGENTS.md 有治理总纲，但缺「每特性四件套 + 非目标清单」的落地模板。
2. **非目标清单带理由与分期**：排除项不止于罗列名词，每一条都同时回答「为什么这一期不做」与「何时回头做」。更关键的是配一条兜底纪律：被排除的状态仍要在界面上如实呈现并标明其归属，绝不因为「不在本模块范围内」就当作普通情况吞掉。这是防止「未处理状态被静默解释」的有效手法。
3. **产品原则带可证伪行为**：每条原则都落成一组具体的「不做」承诺，例如：不在用户没要求时替他收纳工作区改动、不替他化解冲突、不对网络失败做隐式重试、不碰用户仓库里的锁文件、工具链版本不够时直接给出可读错误而不是拿旧语法凑出「看起来能用」的行为。另有一条专门划定人工功能与模型能力的边界：新加的服务只允许人工入口调用，不新增给模型的工具、不改动系统提示词与工具清单——这一条直接封住了「顺手给模型多个工具」这种最常见的范围蔓延。
4. **偏差显式记录**：交付批次附偏差记录，格式是「原计划内容 → 实际情况与原因 → 以哪边为准」，被评审推翻的原方案**不隐藏**，并写明「计划文字以本条为准」。静默偏离视为实现错误。
5. **证据强度分级与修复轮留档**：验收清单每条带验证来源标注（测试用例名或字节稳定性套件名），并区分「机制已验证、量值为推算」与「实测（确定性部分）」；未修项保留并写明「正确性不受影响」的具体理由；评审与修复按 H/M/L 分级逐条留档，且修复环节明确要求评审结论必须逐条复现或用代码取证后再动手，不得照单全收。

**两处上游自身的漂移**（抄模板时应纳入变更检查，不要原样继承）：上游架构图与流程图写「连续 6 步无进展」，代码常量是 12 步且运行时报文也是 12 轮——架构图与实现脱节；上游技能指纹的量化提速数据在仓库内无对应基准脚本，属作者自测值。

---

## 7. 行动项总表（按优先级，供后续立项）

| 优先级 | 提案 | 行动 | 依据 | 预计落点 |
|---|---|---|---|---|
| **HIGH** | P-05 | MCP tools 列表按名排序（前缀缓存字节稳定）+ 连接前强制复核凭据隔离 | §2.3 | `services/domain/messaging/mcp/toolPool.js` schema 聚合出口 |
| **HIGH** | P-01 | 技能指纹剪枝 + 两级失效缓存 + 口径版本迁移 | §1.1（已验证 khy 正踩同一坑） | `skillVersionSync.js` `computeDirFingerprint` / `_collectRelativeFiles` |
| **HIGH** | P-04 | 权限双终止语义 + 取消/拒绝结果分离 + 放行粒度跟敏感度 | §2.2 | `permissionStore.js` 判定链 + `unattendedAutoAnswer.js` |
| **HIGH（分期）** | P-03 | 回合事件 Journal + 单调 seq + 事务内提交 + 不重放语义 | §2.1 | `fsm.js` + `toolLoopPhases.js`，序号模型复用 `remoteExecStreamStore.js` |
| **HIGH（非借鉴）** | — | 把 `validateRecorderCoverage` 接入生产启动序列 | §5 #1 | `replSession.js:783` / `tui/app.js:87` |
| **MEDIUM** | P-07 | 用户可定义的自定义子代理注册中心 | §2.5 | 扩展 `subAgentOrchestrator.js` |
| **MEDIUM** | P-02 | 首屏异步加载 + 空态消歧 + 非阻塞去重 | §1.2 | `skills/index.js` `getCachedSkills` + 新增 HTTP 端点 |
| **MEDIUM** | P-06 | 桌面能力审计矩阵 + 分段耗时如实上报 | §2.4 | `capabilityMatrix/descriptors.js` + `benchmarkSuite.js` |
| **MEDIUM（遗留）** | — | `bridgeServer` 由「50 条整段重放」升级为按 `last_seq` 游标续传 | §0.3（第二轮 F 项） | `bridgeServer.js:36-37`，复用 `remoteExecStreamStore.js:367` 语义 |
| **LOW（遗留）** | — | 会话级权限档位入会话快照 | §0.3（第二轮 H 项） | `canonicalState.js:51 buildSnapshot` 增 3 字段 |
| **LOW（遗留）** | — | `/changes` 跨回合文件变更回看 + 批次偏差记录流程 | §0.3（第二轮 E 项） | 新 CLI handler（3 步：alias + handler + router） |
| **登记** | — | `skillRegistry.js BUILTIN_SKILLS` 记入 `forbidden`，走 B-L2 三步迁移 | §5 | `FEATURE-OWNERSHIP.json` |
| **记录** | §3 / §4 | 品牌资产、CI、数据目录、治理文档、源码本体不借；反向优势无需动作 | — | — |

---

## 附录 A：提案索引（8 项 B-P2 字段完整性一览）

| 提案 | 借鉴方式 | 能力域是否需新登记 | 落点类型 | 触及黑名单 | 决策权限（B-P3） |
|---|---|---|---|---|---|
| P-01 指纹剪枝 | `idea` | 需（`builtin-skill-sync`） | 扩展既有 canonical | 无 | 作者自评 + 任一评审 |
| P-02 首屏异步 | `idea` | 需（`skill-catalog`） | 扩展既有 canonical | 无 | 作者自评 + 任一评审 |
| P-03 回合 Journal | `reference` | 需（`turn-harness-journal`） | 扩展既有 canonical + B-L2 迁移 | 无 | 作者自评 + 任一评审 |
| P-04 权限双语义 | `idea` | 需（`permission-arbitration`） | 扩展既有 canonical | 无 | 作者自评 + 任一评审 |
| P-05 MCP 排序 | `idea` | 需（`mcp-tool-pool`） | 扩展既有 canonical | 无 | 作者自评 + 任一评审 |
| P-06 桌面审计 | `idea` | 需（`desktop-control`） | 扩展既有 canonical | 无 | 作者自评 + 任一评审 |
| P-07 子代理注册 | `reference` | 需（`subagent-registry`） | 扩展既有 canonical | 无（路径已改写） | 作者自评 + 任一评审 |
| —（非借鉴） | — | — | 接入门控 / B-L2 迁移 | — | 按对应条目 |

**无一项取 `vendored` 或 `fork`**，故无需 B-P3 的维护者显式批准通道；无一项触及 B-S2 黑名单或 B-S3 红线。

## 附录 B：FEATURE-OWNERSHIP.json 新增登记建议（**提案，未写入文件**）

按 [DESIGN-SOURCING-001] §4 B-U1 schema（11 字段）建议。`pattern` 取值均已在 `docs/16_设计模式/registry/模式注册表.json` 既有 23 个值中核实存在。`updated` 应改为 `2026-09-15`，`status` 建议由 `seeded` 推进到 `baseline`（登记条目从 3 条扩到 10 条后）。

```jsonc
[
  { "domain": "builtin-skill-sync", "summary": "内置技能的内容指纹同步、随版原子升级与恢复",
    "canonical": "services/backend/src/services/skillVersionSync.js", "ownedLayers": ["L2"],
    "pattern": "Strategy", "method": "reference",
    "source": "xingyao-y-code@3dc5546 — 遍历即剪枝、两级失效缓存、口径版本迁移",
    "aliases": ["skillVersionSync", "内置技能同步", "技能指纹", "builtin skill sync"],
    "forbidden": [], "status": "active",
    "notes": "第二轮 A/D 项落地件。指纹算法口径变更必须递增 INDEX_VERSION 并保守迁移，不得静默改跳过规则" },
  { "domain": "skill-catalog", "summary": "技能发现的内存单一真源与前端消费入口",
    "canonical": "services/backend/src/skills/index.js", "ownedLayers": ["L2"],
    "pattern": "Facade", "method": "self-developed", "source": null,
    "aliases": ["getCachedSkills", "discoverAllSkills", "技能目录", "技能清单"],
    "forbidden": ["services/backend/src/services/skillRegistry.js"], "status": "active",
    "notes": "skillRegistry.js 的 BUILTIN_SKILLS 是遗留的 5 个硬编码 slash 命令，与目录式体系并行（B-U3 第 5 条重复度信号，B-L1 P2 级）。走 B-L2 三步迁移，不做一次性合并" },
  { "domain": "turn-harness-journal", "summary": "回合状态机位置、事件序号与脱敏审计的持久化",
    "canonical": "services/backend/src/services/domain/state/stateMachine/fsm.js", "ownedLayers": ["L2"],
    "pattern": "State", "method": "reference",
    "source": "xingyao-y-code@ba07477 — Journal 只存元数据与哈希、正文同事务提交、崩溃只标 interrupted 不重放",
    "aliases": ["FiniteStateMachine", "回合状态机", "事件日志", "harness journal"],
    "forbidden": [], "status": "active",
    "notes": "当前为影子观测层，B-U5.1 禁止单独改为驱动层；须走 B-L2 三步迁移。Journal 严禁含正文/API Key/工具原始参数" },
  { "domain": "permission-arbitration", "summary": "工具调用权限的裁决链、profile 存储与无人值守语义",
    "canonical": "services/backend/src/services/permissionStore.js", "ownedLayers": ["L2"],
    "pattern": "Chain of Responsibility", "method": "self-developed", "source": null,
    "aliases": ["permissionStore", "权限裁决", "permissionStore check", "toolCallingPermissions"],
    "forbidden": ["services/backend/src/services/domain/desktop/desktopControl/safetyGate.js"], "status": "active",
    "notes": "safetyGate 是桌面专用不可复用（记入 forbidden 防重复借用）。mode↔profile 唯一映射真源在 toolCallingPermissions.js 的 _MODE_TO_PROFILE，新增档位必须双处同步" },
  { "domain": "mcp-tool-pool", "summary": "MCP server 生命周期与工具 schema 聚合分发",
    "canonical": "services/domain/messaging/mcp/toolPool.js", "ownedLayers": ["L3"],
    "pattern": "Adapter", "method": "self-developed", "source": null,
    "aliases": ["toolPool", "MCP 工具池", "MCP server", "mcp selector"],
    "forbidden": [], "status": "active",
    "notes": "tools 列表必须按名排序以保证前缀缓存字节稳定（P-05）；新增 server 接入点校验与连接前复核必须共用同一规则" },
  { "domain": "desktop-control", "summary": "跨平台桌面操控后端、风险分级与会话熔断",
    "canonical": "services/backend/src/services/domain/desktop/desktopControl/safetyGate.js", "ownedLayers": ["L3"],
    "pattern": "Strategy", "method": "self-developed", "source": null,
    "aliases": ["safetyGate", "OP_RISK", "桌面控制", "computer use", "desktop control"],
    "forbidden": [], "status": "active",
    "notes": "OP_RISK 是桌面风险分级唯一真源。审计矩阵扩展 capabilityMatrix/descriptors.js，benchmark 挂 benchmarkSuite.js；分段耗时未发生则字段缺失而非 0ms" },
  { "domain": "subagent-registry", "summary": "子代理编排与用户可定义的自定义子代理注册",
    "canonical": "services/backend/src/services/subAgentOrchestrator.js", "ownedLayers": ["L2"],
    "pattern": "Factory Method", "method": "reference",
    "source": "xingyao-y-code@ba07477 — Markdown 文件即子代理定义、三级缓存指纹、重名告警与非法值回落",
    "aliases": ["subAgentOrchestrator", "子代理编排", "自定义子代理", "subagent registry"],
    "forbidden": [], "status": "active",
    "notes": "自定义定义落 ~/.khyquant/agents/ 与 <workspace>/.khy/agents/（B-S2 第 3 条：不落上游 .ycode/ 布局）。深度上限的作用域必须包住事件消费循环" },
  { "domain": "stream-cursor-resume", "summary": "事件流的单调序号与游标续传（断线补发）",
    "canonical": "services/backend/src/services/domain/network/remote/remoteExecStreamStore.js", "ownedLayers": ["L3"],
    "pattern": "Memento", "method": "self-developed", "source": null,
    "aliases": ["getEventsSince", "after_seq", "断点续传", "游标续传", "lastSeq"],
    "forbidden": ["services/backend/src/bridge/bridgeServer.js"], "status": "active",
    "notes": "bridgeServer.js 仍是 HISTORY_MAX=50 整段重放（B-L1 P1 级：两处都被维护且行为分歧）。改造应复用 getEventsSince 语义，不新建第三套缓冲" }
]
```

## 附录 C：附录 A 清单（A1–A10）逐条自查

| 项 | 结论 |
|---|---|
| A1 是否新能力域 | 8 项提案中 7 项为本仓此前不存在的能力域（注册表现有仅 3 条，无 skills/permissions/mcp/desktop/subagent/journal 相关），全部走 B-P2 六字段提案 |
| A2 六字段齐全 | 附录 A 逐条核对，含第 6b 检索结论 |
| A3 四步检索 | 每项均含注册表别名 / 符号 grep / 模式注册表 / 层级判断四项结论 |
| A4 许可证核实 | MIT，核实位置 `/tmp/xingyao-y-code/LICENSE`（21 行，`Copyright (c) 2026 feng-chenhao`） |
| A5 借鉴方式判定 | 全部 `idea` 或 `reference`，判定依据见各提案第 5 字段 |
| A5′ fork 准入 | **无一项取 fork**，无需 B-M3 三点评估 |
| A6 黑名单自查 | §3 八类逐条登记为不借 |
| A7 红线自查 | **无一项把上游源码文件复制进源码目录**；本轮无 `vendored` |
| A8 层级自查 | 各项 `ownedLayers` 只填一个值（B-U4 第 1 条） |
| A9 落库后跑门 | 本轮未落库。落地后须跑 `check:agent-rules --changed` / `check:layout` / `check:duplication` / `check:pattern-coverage` / `check:gov-rules` |
| A10 登记 | **未修改 `FEATURE-OWNERSHIP.json`**——附录 B 为提案，写入需经 B-P3 决策权限 |

**三条铁律自查**：① 本报告是提案文档，未先实现（B-P2.1）；② 无一项以「旧实现有 bug 所以新写一个」为由新增并行实现，§5 #2 明确拒绝单独改造影子 FSM（B-U5.1）；③ 无一项以「上游更好」为由整包搬入（B-S3 / B-S4）。

## 附录 D：局限与说明

- 本报告基于 `dev` 分支 `ba07477`（2026-09-14 23:09，v1.2.27），ycode 迭代极快（631 次提交），行动项实施前应重新核对对应符号名。所有引用以符号名为准，行号仅供定位。
- ycode 是 Python + pywebview，khy-os 是 Node.js 后端 + Vue 前端。借鉴的是**设计模式与工程文化**，非直接移植代码。各项提案的「不适合跨栈移植」部分已就地标明（pywebview 同步 JS 桥与事件队列、PyInstaller 资源根与首启释放模型、Windows 文件身份 API、`threading.local` → 本仓对应 `AsyncLocalStorage`、单机 SQLite 全局锁与进程级 owner → 多租户需按 tenant+turn 重新设计租约粒度、厂商特定的缓存 lane 逻辑不应抽象成通用机制）。
- 上游的量化提速数据（204 倍 / 11.5 倍 / 25.6 秒）与桌面 benchmark 数据（14.19s Provider 占比 98.5%）在仓库内**无对应基准脚本**，属作者自测值，本报告按推算值对待，不作为 khy-os 侧的预期收益承诺。
- 本报告为「调研 + 提案」，**未实施任何代码改动**，未修改 `FEATURE-OWNERSHIP.json`。落地前需按 AGENTS.md 工程规则（零硬编码 / 状态透明 / 活动超时 / 滚动区）过一遍，并按 B-L2 三步迁移处理存量。
- 已知待裁决措辞漂移（如实登记，不自行裁决）：[DESIGN-SOURCING-001] §3 B-P2 标题写「六字段模板」，但模板正文实际列 7 项（第 7 项「验收方式」）；GOV-BORROW-003 沿用「六字段」措辞。本报告一律按 7 项填齐。
- 索引与孪生件：本报告落地后须按 [MGMT-STD-007] R4 同步 `docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` 与 `docs/00_INDEX_文档索引.md`，并跑 `npm run docs:build` 生成 `.html` 孪生（R6：禁手改 `.html`）。不需要改 `check-gov-rules.js`（该脚本不含设计文档清单，仅校验 GOV 板块与接线）。

---

*调研工具：本地克隆 `C:/Users/25789/AppData/Local/Temp/xingyao-y-code`（`git fetch --unshallow` 后 631 提交全量）；khy-os 现状经并行只读核查 + 承重结论人工复核（§1.1 `_collectRelativeFiles` 无剪枝、§1.2 `validateRecorderCoverage` 生产零调用、§2.3 MCP 无排序、§0.3 `canonicalState.buildSnapshot` 无 permissionMode、§2.1 `fsm.js` 影子契约、§2.5 无子代理注册表、§2.4 capabilityMatrix 与 benchmarkSuite 桌面零命中，均已直接验证）。*
