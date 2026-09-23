# [DESIGN-ARCH-041] Khyos意图精准裁决 — 意图光谱解析与动态提权网关

> 状态：定稿 · 归属：`services/backend/src/services/intentArbiter/` · 关联：[[DESIGN-ARCH-040]]（数据主权网关，执行带下游）、[[DESIGN-ARCH-019]]（用户输入预处理规范）、[[DESIGN-ARCH-037]]（自举闭环自愈，进化需求）

## 一、目标

在「**防误触**（宁可沉默也绝不误动）」与「**识意图**（绝不漏掉真实命令）」之间建立动态平衡的精准裁决层。摒弃非黑即白的硬关键词分类，把任意自然语言输入坍缩为连续的「指令置信度」∈[0,1]，再按光谱分段路由到安全等级递增的分级沙箱；并把用户对误判的纠正行为升维为针对意图引擎自身的进化需求。

零侵入、加法式：自成纯子系统，不接管输入主循环。可由后续 PR 把真实 NL 输入接入 `dispatch`，把执行带放行结果串到数据主权网关与权限审批之前。

## 二、意图光谱（§3.1）

连续置信度三段，左闭右开覆盖 [0,1]：

| 区间 | 光谱段 | 沙箱 | 语义 |
| --- | --- | --- | --- |
| [0.0, 0.3) | 安全对话带 | `ChatSandbox` | 纯生成、零工具。闲聊 / 「你是什么模型」物理隔绝于系统模式 |
| [0.3, 0.7) | 歧义模糊带 | `ConfirmSandbox` | 只产出零风险确认请求，**禁止自主猜测执行**（防呆②） |
| [0.7, 1.0] | 指令执行带 | `ExecutionGateway` | 意图明确，放行入闸；执行前仍须经数据主权网关 + 权限审批 |

## 三、动态提权特征引擎（§3.2）

置信度由多特征**综合**叠加（绝不单因子决定，防呆①）。权重单源 `intentLexicon.js`：

| 特征 | 权重 | 说明 |
| --- | --- | --- |
| 基线 BASE | 0.1 | 默认偏闲聊 |
| 特权动词 PRIVILEGED_VERB | 0.45 | 进入/执行/切换/调用/开启/关闭… 最强提权 |
| 目标宾语 TARGET_OBJECT | 0.2 | 本地模式/调试工具/系统/内核…（关键词 + 「X模式」「X工具」构词正则） |
| 强调副词 EMPHASIS | 0.2 | 明确要求/立刻/必须/务必… |
| 弱动词 WEAK_VERB | 0.2 | 看看/瞧瞧/了解…（仅拉入歧义带，不足以执行） |
| 祈使引导 IMPERATIVE_LEAD | 0.1 | 给我/请/帮我…（句法结构，祈使 >> 疑问） |
| 疑问衰减 QUESTION_DAMPEN | ×0.5 | 命中疑问标记 → 提权项整体衰减 |
| **NO_VERB_CAP** | 0.69 | 防呆①硬上限：缺特权动词时置信度封顶，绝不入执行带 |

示例：`你是什么模型` → 0.1（疑问、无动词无目标）；`看看本地模式` → 0.5（弱动词+目标，歧义带）；`我明确要求进入本地模式` → 1.0（特权动词+目标+强调+祈使，执行带）。

## 四、分级沙箱网（§3.3）+ 门面编排（§4）

三个命名类 + 门面：

- **`IntentSpectrumAnalyzer`** — `analyze(text)` → `{confidence, band, features, reasons}`；纯函数确定性，不调模型。
- **`TieredResponseRouter`** — `route(analysis)` 映射三沙箱；`assertZeroRisk` 在装配确认沙箱时断言零副作用（防呆④）。
- **`MisjudgmentQuencher`** — `classifySignal` / `quench` 把误触/漏判纠正升维为 `EvoRequirement`（复用 [[DESIGN-ARCH-037]] 的 `evoRequirement` 真源）。
- **`IntentArbiter`（门面）** — `dispatch(text)`（解析→路由）；`confirm(originalText, reply)`（二次裁决，显式确认才放行）；`feedback(correctionText, ctx)`（淬火落 `evoLedger` 不可变哈希链，branch `intent_arbiter_pool`）。

## 五、误判淬火（§3.4 / 防呆③）

| 误判类型 | 触发信号 | 进化等级 | 定向目标 |
| --- | --- | --- | --- |
| 误触（过激进） | 「我没让你执行」「只是在聊天」 | L0 启发式补丁 | 增加负样本、下调相关特征提权权重 |
| 漏判（过保守） | 「我刚才说了」「快执行」 | L1 器官新生 | 扩充特权动词库、新增语义框架解析工具 |

`why` 措辞经 `evoLevels.classify` 校准锁定等级，规避「网关/调度/压缩/核心流转」L2 触发词；`_decorate` 内置 L2→L1 不变式自检兜底。

## 六、防呆铁律（写死，不可绕过）

1. **绝对禁止** 意图解析器仅依靠单一关键词（如「模式」）进行路由，必须结合动词类型、句式结构和强调词进行综合提权或降权。 → `IntentSpectrumAnalyzer._score` 硬上限 `NO_VERB_CAP=0.69`：缺特权动词时无论命中多少关键词都不得入执行带。
2. **必须强制** 对于落入歧义模糊带(0.3-0.7)的输入，系统绝对禁止自主猜测并执行，必须生成确认请求交由用户裁决。 → 歧义带只入 `ConfirmSandbox`；唯有 `confirm()` 收到显式肯定答复才升入执行带。
3. **必须强制** 用户的否定反馈（「我没说…」「别执行…」）与肯定追加（「我刚才说了…」「快执行…」）必须作为淬火信号，自动触发 `MisjudgmentQuencher`，生成针对意图解析引擎的进化需求。 → `feedback()` → `quench()` → `evoLedger`。
4. **绝对禁止** 在 ConfirmSandbox（确认沙箱）中包含任何具有副作用的工具调用或状态变更接口，确认过程必须是零风险的。 → `assertZeroRisk` 断言确认沙箱 `sideEffectsAllowed=false`、`toolsAllowed=false`、无 exec/tool/mutate/apply/commit/downstream 接口，渗入即抛 `ZeroRiskViolationError`。

## 七、验证

`tests/services/intentArbiter/intentArbiter.test.js` — 22 测试全绿：光谱场景表、祈使>>疑问、防呆①封顶、三沙箱映射、防呆④零风险断言、dispatch 分流、防呆②确认/否决/仍歧义、防呆③误触L0/漏判L1/落账本、哈希链校验、空输入降级。邻近回归（dataSovereignty/envSymbiosis/evoEngine）83 测试零回归。
