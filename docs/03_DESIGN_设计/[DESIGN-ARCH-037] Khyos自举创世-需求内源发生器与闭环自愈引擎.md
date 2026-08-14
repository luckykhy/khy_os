# [DESIGN-ARCH-037] Khyos 自举创世——需求内源发生器与闭环自愈引擎

> 架构与设计规范 · 遵循 [MGMT-STD-001] · 关联 [DESIGN-ARCH-025] 元规划约束注入、[DESIGN-ARCH-044] 自愈微循环、[DESIGN-ARCH-033] 双轨热插拔、[DESIGN-ARCH-034] 动态约束求解

## 1. 目标与定位

为 Khyos 植入**需求内源发生器与闭环自愈引擎**，废弃「人类提需求 → Agent 实现」的低效链路：系统在**运行态**自主发现痛点、推演需求规格、生成候选代码、沙箱验证并受控热融合，实现系统级达尔文式进化。

协作而非替代：自成一个纯子系统 `src/services/evoEngine/`，经 `frictionBridge` 旁路**接入**（非接管）`executeTool` 单漏斗——工具真实失败时顺手抄送一份 friction，核心循环始终权威产出/降级它自己的结果。代码生成为**注入式**（`codeGenerator`）——引擎本身不内嵌模型，使其模型无关、可确定性单测。

### 1.1 接入点（frictionBridge → executeTool）

`frictionBridge.observeFailure(friction)` 是离线引擎接进运行态的唯一接缝，做**轻量感知 + 留痕**：经 `PainPointScanner` 归因铸造 `EvoRequirement`，落入 `evoLedger` 的 `observations` 分支作运行态痛点**待办积压**，供离线 `SelfBootstrapEngine.evolve` 消费。**绝不**在此热路径跑代码生成或沙箱。

- 接入位置：`executeTool` 的两个失败出口——软失败（`result.success === false`，依赖自愈后仍未愈）与硬抛 `catch (err)`。助手 `_observeEvoFriction` 定义在外层 `try` 之前，使两个出口都能引用。
- fail-soft 三连：有界去重（同一痛点签名每进程只留痕一次，`SEEN_CAP=2000` 淘汰最旧）、永不抛、永不阻断工具结果。
- 接入开关 `KHY_EVO_ENGINE`（默认**关闭**，置 `on` 启用）——新生的自进化观测默认不介入。
- 非对称设计：观测（friction-in）廉价（scan→requirement→积压）在热路径；昂贵的 `evolve`（codeGenerator + 沙箱）留在热路径之外离线消费积压。

## 2. Meta-Plan（扫栈自决）

| 决策 | 选择 | 复用既有真源 |
| --- | --- | --- |
| 归因从何来 | 不臆造，复用三源合一诊断 | `selfHeal/errorDiagnostician.ErrorDiagnostician` |
| 演进级如何升 | 单调取严的最小上界格 | 镜像 `metaplan/constraintStrategy` |
| 沙箱边界 | `vm` 空冻结上下文 + 超时 + 静态毒性 | 新增（与 dualTrack 物理隔离同精神） |
| 沙箱→热载信任 | HMAC 凭证（每进程随机密钥）+ timingSafeEqual | 新增 |
| 黑历史不可篡改 | append-only 哈希链落盘 | `utils/dataHome.getProjectDataDir` |
| 失控保险 | 分支熔断 / 引擎只读 / 回滚 | 镜像 `metaplan/trustCircuitBreaker` |

## 3. 架构蓝图：达尔文式闭环

```
阻力捕获 ──► 归因铸造 ──► 代码生成 ──► 沙箱验证 ──► 热融合
PainPoint    EvoRequirement  codeGenerator  Organogenesis   HostPatcher
Scanner      (evoLevels      (注入式)        Sandbox         (三闸门)
             分级 L0/L1/L2)                  (影子+毒性+差异)
   │              │                              │               │
   └──────────────┴──────── evoLedger 不可变哈希链全程留痕 ───────┴──── EvoTrustBreaker
                                  (防呆⑤)                              (熔断/只读/回滚 防呆③④)
```

### 模块职责（`src/services/evoEngine/`）

| 模块 | 职责 | §对应 |
| --- | --- | --- |
| `painPointScanner.js` | 感知端：四类阻力信号 → 元认知归因（缺工具/规则误杀/阈值僵化/逻辑死角）→ 铸造 `EvoRequirement`；不生码不碰沙箱 | §3.1 |
| `evoRequirement.js` | 需求七要素真源；缺归因 Why 即抛；签名稳定（数字归一）为熔断计数锚点 | §3.1 |
| `evoLevels.js` | L0⊏L1⊏L2 升级格；`planL2` 为防呆②唯一闸门 | §3.2 |
| `organogenesisSandbox.js` | 静态毒性 + `vm` 影子执行 + 差异校验；仅 passed 签发 HMAC 凭证 | §3.3 |
| `hostPatcher.js` | 三闸门（凭证/宪法/只读）→ 演进轨影子注册表，绝不覆写核心 | §3.3 |
| `evoTrustBreaker.js` | 分支熔断 + 引擎只读 + 回滚；守护受保护不变量；自举逻辑只读 | §3.4 |
| `evoLedger.js` | append-only 哈希链不可变日志；无 update/delete API | 防呆⑤ |
| `index.js` | `SelfBootstrapEngine` 门面，编排全闭环 | §4 |

### 三级自举演进协议（§3.2）

| 级别 | 触发 | 行动 | 落点 |
| --- | --- | --- | --- |
| L0 启发式缝合 | 边缘 Case、无系统性风险 | 改 Prompt / 注入 If-Then | 记忆区补丁 |
| L1 器官新生 | 能力拓扑空洞，缺工具/解析器 | 自主编码新函数并注册 | 新增代码 + 注册条目 |
| L2 宪法修正 | 核心流转（压缩/网关）系统性缺陷 | 重构核心引擎/元约束 | **强制降级 L0 + 3 步验证** |

## 4. 场景验证：一次完整的 L1 演进流

> 场景：Khyos 因现有解析器无法处理特殊格式（`k=v;k2=v2`）数据报错，自主推演需求，编写新解析器，沙箱验证通过后热注册生效。

| 步骤 | 阶段 | 输入 | 引擎动作 | 产物 / 留痕 |
| --- | --- | --- | --- | --- |
| ① | 阻力捕获 | `tool-failure`：`parser cannot handle format: unsupported`，surface=`dataParser` | `PainPointScanner.scan` 经 ErrorDiagnostician 归因 | Why=`missing-tool` 能力空洞 |
| ② | 需求铸造 | 归因 + surface | `evoRequirement.forge`，`classify`→**L1** | `EvoRequirement{id, level:L1, executionLevel:L1, 验收标准}`；ledger `requirement` |
| ③ | 代码生成 | EvoRequirement | 注入式 `codeGenerator` 产出候选器官 `organ()` + 探针 | `{code, entry, probes}`；ledger `code` |
| ④ | 沙箱验证 | 候选器官 | 静态毒性✔ → `vm` 影子执行探针 → solved && !regressed | `verdict{passed:true, passToken}`；ledger `sandbox` |
| ⑤ | 热融合 | verdict + 代码 | `HostPatcher.applyPatch` 过三闸门 → 影子注册表登记 `parser:kv-semicolon` | `{ok, patchId}`；ledger `hotload` |
| ⑥ | 生效 | — | `patcher.resolve('parser:kv-semicolon')('a=1;b=2')` → `{a:'1',b:'2'}` | 新器官在演进轨可调用，核心源文件零改动 |

毒性/退化/未解决任一不成立 → ④ 否决，不签发凭证，⑤ 永不可达（防呆①）。

## 5. 防呆规则与硬边界

| # | 铁律 | 落点 |
| --- | --- | --- |
| ① | 绝不跳过沙箱直接注入宿主（系统级自杀） | 沙箱仅 passed 签发 HMAC `passToken`；`HostPatcher` 必校验 `verifyToken`，无/伪造凭证抛 `SandboxBypassError` |
| ② | L2 必须输出架构对比 + 爆炸半径，且强制降级 L0 执行 3 步验证 | `evoLevels.planL2` 缺 `architectureDiff`/`blastRadius` 即 invalid；`forge` 据此设 `executionLevel=L0, validationSteps=3`；需求闸门拦死裸 L2 |
| ③ | 绝不允许演进引擎修改信任熔断机制与防呆规则 | `EvoTrustBreaker.PROTECTED_INVARIANTS`（熔断/日志/沙箱/红线/constraints）；热载命中抛 `ConstitutionViolation`；`evoLedger` 无 update/delete |
| ④ | 连续 2 次沙箱失败强制熔断引擎锁定只读 | `recordSandboxResult` 跨痛点连续失败计数达阈 → `isEngineReadOnly()`，`HostPatcher` 拒一切热载 |
| ⑤ | 所有自举演进历史以不可变日志持久化，绝不允许模型篡改 | `evoLedger` append-only 哈希链；`verify()` 当场定位任何篡改/断链 |

§3.4 补充：同一痛点连续 2 次沙箱失败 → 熔断该分支 + 架构级人类告警；已热载补丁后续 3 次任务引发新异常 → 强制回滚卸载。

## 6. 验证

`tests/services/evoEngine/evoEngine.test.js`：28 测试全绿，覆盖六条防呆 + 分支熔断 + 回滚 + 端到端 L1 演进流。邻近子系统（metaplan/selfHeal/cognitiveSnapshot）80 测试零回归。测试经 `KHY_PROJECT_DATA_HOME` 隔离至临时领地，不污染真实 `.khy` 数据区。
