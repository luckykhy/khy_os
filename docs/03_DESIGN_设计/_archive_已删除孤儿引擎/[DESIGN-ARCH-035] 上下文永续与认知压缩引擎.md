> ⚠️ **已归档（孤儿设计稿）· 请勿据此实现** ⚠️
>
> 本规范描述的治理引擎 `cognitiveSnapshot（与已在产 compactPipeline 平行重造）` 经 2026-06-14「接线或删除」证据级核实为 **ORPHAN**
> （零消费者、从 `executeTool`/`toolUseLoop`/`aiManagementServer` 三入口均不可达），
> 已按 `.ai/GOVERNANCE-LEDGER.md` §B.0 **删除其实现代码**（基线 `0437b6b`，删除提交
> `a76785e` + `99ea828`）。本文件仅作**历史可追溯**留存，**非在产、不得作为实现依据**。
> 判「在产」唯一标准见 `.ai/GUARDS-AI.md` §0。
>
> ——归档于 2026-06-14
# [DESIGN-ARCH-035] 上下文永续与认知压缩引擎

> 状态：定稿 · 归属 `services/backend/src/services/cognitiveSnapshot/` · 测试 `tests/services/cognitiveSnapshot/cognitiveSnapshot.test.js`（23 绿）
> 角色定位：**上下文永续与记忆压缩架构师**——让长链路任务在极窄上下文寄存器中无缝接力，token 溢出不再丢进度。

---

## 一、问题与目标

长链路 Agent 任务的死穴：上下文窗口是有限的「寄存器」，但任务状态是无限增长的「磁带」。
朴素方案要么**娇气病**（一满就躺平丢任务），要么**死缠烂打**（硬塞直到截断报错、进度全损）。

本引擎给出第三条路——**认知压缩 + 状态快照**：把窗口当 CPU 寄存器分区严管，历史按密度逐级折叠，
每步把「进度 + 压缩记忆」固化成盘上快照；窗口可随时被压缩甚至截断，但**快照是唯一真源**，
任何新会话据此零误差热启。

### 与既有设施的关系（扩展而非复制）

| 既有单源 | 本引擎如何复用 |
| --- | --- |
| `contextWasm.estimateTokens` | token 估算唯一真源，全模块可注入 `estimateTokensFn` 以便测试 |
| `utils/dataHome.getProjectDataDir` | 快照/卸载分桶持久化（与 `sessionPersistence` 同套），原子 tmp+fsync+rename |
| `canonicalState`（6 维、无热启） | 快照层补齐 taskId/step/nextInstruction/offloadPointers/retryCount 五字段，并真正接上 hotStart 自动注入 |
| `compactPipeline` / `contextRouter` | 互补：前者是对话消息级压缩，本引擎是**步骤级状态机**，关注跨会话续传而非单轮裁剪 |

---

## 二、元规划（Meta-Plan，先扫栈再决策）

| 决策点 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | Node.js CommonJS | 与 backend 全栈一致，零新依赖 |
| 序列化 | JSON（`null,2` 缩进） | 快照可人读可 diff，便于事故复盘 |
| 持久化 | 文件系统（非 DB） | 复用 dataHome 分桶，无新基础设施；原子写绝不留半截文件 |
| token 真源 | `contextWasm.estimateTokens` | 全项目唯一估算源，避免口径分裂 |
| 侵入面 | 零侵入纯模块 + 后续 PR 接 loop | 与既往 Goal 同款节奏，可独立单测、可独立驱动 |

---

## 三、架构蓝图

```
                  CognitiveContextEngine（门面/状态机）
                          │
   ┌──────────────┬───────┴───────┬────────────────┬───────────────┐
   ▼              ▼               ▼                ▼               ▼
workbench    compressionEngine  snapshotManager  overflowInterceptor  offloadStore
(§3.1冷热分层) (§3.2三级压缩)    (§3.3七要素快照)  (§3.4断点续传网关)   (L3卸载离境)
40/20/40     L0/L1/L2/L3        build/persist     requireBudgetPlan    offload/load
寄存器预算    防呆①②③          load/hotStart     preflight/紧急快照   <offloaded ref=…>
```

### §3.1 工作台冷热三分区（CPU 寄存器模式）

比例**写死、绝不可越界**，三者之和恒为 1：

```
[执行区 EXEC   40%]  当前步指令 + 输入输出 + 最近 1 步结果
[记忆区 MEMORY 20%]  核心状态机 + 高频实体词典；绝不存原始长文本（MEMORY_RAW_CHAR_CAP=600）
[缓冲区 BUFFER 40%]  预留给模型推理中间态与 API 返回
```

`partition(window)` 切预算，`measure(zonesText, window)` 报越界区，`assertNoRawLongText` 守记忆区铁律。

### §3.2 三级压缩（按占用逐级榨干）

| 级别 | 触发占用 | 动作 | 目标留存 |
| --- | --- | --- | --- |
| L0 无损 | <50% | 原文保留（旧步仍折叠以守防呆①） | <50% |
| L1 语义折叠 | 50–75% | 步骤 →{意图,动作,结果} 三元组，删推理/原文 | ~30% |
| L2 骨相抽取 | 75–90% | 仅留核心实体状态 + 错误教训 | ~5% |
| L3 卸载离境 | >90% | 冷数据驱赶至外部持久层，上下文仅留寻址指针 | ~0.1% |

`selectLevel(ratio)` 拿不到占用时 fail-safe 推到最严 L3。`RAW_WINDOW_HARD_CAP=2` 硬编码进算法。

### §3.3 状态快照（七要素，缺一不可）

```
taskId · step · ultimateGoal(指南针，永不删除) · compressedHistory ·
nextInstruction · offloadPointers · retryCount
```

`build()` 缺 taskId/ultimateGoal 即抛；`persist()` 原子落盘并返回 ok（防呆②的判据）；
`hotStart()` 自动解压注入、跳过寒暄（防呆⑥）。

### §3.4 断点续传网关

- **前置预算熔断**：`preflight()` 校验预算规划齐备（防呆⑤），并在「已用+预估 > 窗口×80%」时强制转压缩/卸载流，绝不硬撞溢出。
- **截断异常熔断**：`isTruncationError()` 识别多家网关截断措辞，`emergencySnapshot()` 从残存上下文按最严级抢救出 EMERGENCY 快照（防呆④）。
- **跨会话热启**：检测到未完成快照即全自动注入状态，模型从断点指令续作。

---

## 四、场景验证表

10 步任务（含失败步），窗口 1000 token，`estimateTokensFn = 字符数`，对照三种模式：

| 模式 | 触发占用 | 完整原始步 | 历史留存率 | 错误教训保留 | 冷数据落点 | 上下文里指针 | 任务可续传 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 不压缩（朴素硬塞） | — | 全部 10 步 | 100% | 偶发丢失 | 无 | 无 | ❌ 一满即截断、进度全损 |
| L1 语义折叠 | 60% | ≤2（防呆①） | ~14%（实测 0.138） | ✅ 随快照常驻 | 无 | 无 | ✅ |
| L2 骨相抽取 | 80% | ≤2 | ~8%（实测 0.083） | ✅（防呆③结构性保证） | 无 | 无 | ✅ |
| L2+L3 卸载 | 95% | ≤2 | ~9%（含寻址占位） | ✅ | 外部持久层 `cognitive_snapshots/offload/` | `<offloaded ref=… sha=… bytes=…/>` | ✅ 冷数据离境、按需回读 |

> 关键对比：朴素模式 100% 留存但**不可续传**——撞窗即死；本引擎留存压到个位数百分比却**全程可热启**，
> 错误教训与核心实体状态在任何级别都不丢。L3 留存率含寻址占位（in-context 仍留 l2 摘要供定位），
> 真实冷数据已落盘离境，上下文净负担降至 ~0.1%。

---

## 五、六条防呆（硬约束）

| # | 红线 | 落地点 |
| --- | --- | --- |
| ① | 绝不保留 >2 步完整原始 I/O（内存泄漏红线） | `compressionEngine.RAW_WINDOW_HARD_CAP=2`，连 L0 也照折叠 |
| ② | 每步必压缩评估并持久化最新快照，无快照=无效步 | `commitStep.valid = persist().ok`，持久化失败即判该步无效需重做 |
| ③ | L2 绝不丢失「错误教训」与「核心实体状态」 | `extractL2` 结构性恒返回 `{entities, errorLessons}` |
| ④ | 截断错误视作异常熔断，自动生成紧急快照 | `isTruncationError` + `emergencySnapshot` → EMERGENCY 快照落盘 |
| ⑤ | 执行前必出资源预算规划，未出者阻断 | `requireBudgetPlan` + `preflight` action=block |
| ⑥ | 恢复快照时绝不要求用户复述，全自动注入 | `hotStart` 返回 `injectionPrompt`（跳过寒暄、含指南针+下一步） |

---

## 六、交付物与后续

- 6 纯模块：`workbench` / `compressionEngine` / `snapshotManager` / `overflowInterceptor` / `offloadStore` / `index`(门面 `CognitiveContextEngine`)。
- 测试 23 绿，覆盖六条防呆 + 三区分层 + 级别阈值 + 卸载往返 + 端到端每步闭环。
- **零侵入**：尚未接管 `toolUseLoop` / 调度器，作为可独立驱动的状态机交付；接管真实 loop 是后续 PR。
