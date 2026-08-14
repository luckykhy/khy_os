# DESIGN-ARCH-065 Hermes Agent v0.18.0 参考学习：判断 / 验证 / 自我进化

> **核心判断**：Hermes Agent v0.18.0 的三大关键词——**判断（MoA）/ 验证（evidence-based
> completion）/ 自我进化（/learn·/journey）**——对 Khy-OS 各有不同的落地价值。经**只读研究 +
> 逐特性 gap 分析**后判定:**「验证」支柱最贴合、最高杠杆、且 Khy-OS 基础设施已就位**——遂将其
> 落地为 `/goal` 的**证据门**（本设计的可交付实现）；**「判断」（MoA）与「自我进化」缺口较大、
> 工程量高，列为后续候选**，本文给出移植路线但不在本次实现。
>
> 本研究遵循 [DESIGN-ARCH-061]（更新包学习：取其精华弃其糟粕）的红线：**只读研究、绝不整包合并、
> 取舍留给掌握上下文的人**。样本仅供设计参考，未引入任何 Hermes 源码/依赖。

---

## 一、研究对象与方法

- **样本**：`hermes-agent-main`（`pyproject.toml` version = **0.18.2**），Python agentic CLI。仅
  在 `/tmp` 沙盒内**只读**探查，未落盘进本仓、未合并任何文件。
- **方法**：四路并行 Explore（每特性一路，读节选定位实现，产出 file:line 锚点而非文件堆），再对
  Khy-OS 现状做对照 gap 分析（两路 Explore），全部锚点经二次核验。
- **非目标**：不移植 Hermes 代码；不做语义 diff；不追求把四特性全部落地——只落地经论证的最高价值项。

---

## 二、Hermes v0.18.0 四特性设计（附 Hermes 侧锚点）

### 2.1 判断 · Mixture-of-Agents（MoA）
MoA 不是工具、也不是特殊循环，而是一个**虚拟 provider `moa`**，其「模型」即命名 **preset**。选中后
主 agent 循环不变，只是把 `agent.client` 换成进程内 facade `MoAClient`——它拦截每次
chat-completions 调用，扇出到「参考模型」，再让 aggregator 作为真实模型作答。

- 虚拟 provider 注册：`hermes_cli/providers.py:47`；preset 作为「可选模型」出现在选择器：
  `hermes_cli/inventory.py:497`。
- 装配点：`agent/agent_init.py:816`（`provider=='moa'` → 装 `MoAClient`）。
- 编排引擎：`agent/moa_loop.py:800`（`MoAChatCompletions.create()`）。
- **参考模型并行**：`agent/moa_loop.py:336`（`ThreadPoolExecutor`，上限 8，**等全部完成**、保序）。
- **aggregator 策略**：参考输出以 `Reference N — provider:model:` 编号拼接，**追加到消息数组末尾**
  （`_attach_reference_guidance`，`moa_loop.py:661`）——刻意置尾以保 KV-cache 前缀稳定；aggregator
  带真实 tools/stream 调用，其输出即用户可见答案。
- **fail-soft**：单个参考失败返回 `[failed: …]` 标注、不抛，aggregator 仍以部分上下文作答。
- 单元数据结构：`(label, text, _RefAccounting)` 三元组（`moa_loop.py:30`），按各自模型计价。

### 2.2 验证 · completion contract + evidence-based verification
本特性核心在 `hermes_cli/goals.py`：一个 **judge 模型把门的 Ralph 式循环**——每轮结束后由辅助
「judge」模型对用户预定义的**契约**裁决 `done/continue/wait`，只有非 `done` 才重新注入续驱提示。
**agent 不能自证完成，由外部 judge 裁决，且被要求索取具体证据**。

- 契约数据模型 `GoalContract`（5 字段：outcome / verification / constraints / boundaries /
  stop_when）：`goals.py:293`；`/goal draft` 用辅助模型把朴素目标扩成 5 字段：`goals.py:987`。
- judge 提示（**证据必需**决策规则）：`goals.py:193`——原文要点：*"DONE only when the Verification
  criterion is satisfied AND the response shows concrete evidence of it (a command result, file
  contents excerpt, test/benchmark output) — not a claim like 'done' or 'all tests pass' without
  evidence"*。
- 门（防提前 done）：`evaluate_after_turn`（`goals.py:1382`）——judge→verdict→continue/done/wait/pause；
  续驱提示 `goals.py:83`；后台进程未结束时返回 `wait` 而非误 continue：`goals.py:967`。
- 兜底：turn 预算、连续 parse 失败自动 pause。

### 2.3 自我进化 · /learn
`/learn` **没有蒸馏引擎**——它是「提示构造」特性：拼一条受标准约束的指令注入 agent 输入队列，agent
用既有工具（read_file / web_extract / skill_manage）自行采集并撰写 skill。

- 一条指令按来源类型分支（目录/文件、URL、"刚才做的"、粘贴笔记）：`agent/learn_prompt.py:134`。
- 产物 = `SKILL.md`（YAML frontmatter + markdown），落 `~/.hermes/skills/<category>/<name>/`：
  写入 `tools/skill_manager_tool.py:793`，路径 `:579`。
- 「学习图」**读时派生**（非单一图文件）：`agent/learning_graph.py:254`；节点=学到的 skill + memory 卡。
- 检索：紧凑 name+description **索引**注入系统提示（描述 ≤60 字符），按需再全量载入：
  `agent/prompt_builder.py:1445`。

### 2.4 自我进化 · /journey
终端原生「让学习可见」：把学到的 skill + memory 按时间线（旧→新）渲染成条形图。

- 载荷 `build_learning_graph()`：`agent/learning_graph.py:254`（skill 只留「学到的」：非 base 且
  agent-created 或 use_count>0，`:263`；memory 卡读 `MEMORY.md`/`USER.md` 按 `\n§\n` 切，`:193`）。
- 增删改：`journey list|delete|edit`（`hermes_cli/journey.py:332`）→ `learning_mutations.py:124`
  （删 skill=可恢复归档；改 skill=重写 SKILL.md；memory 原子重写）。
- 时间线渲染：`agent/learning_graph_render.py:455`。
- （附）后台子 agent 并行：`tools/delegate_tool.py:2538`（`DaemonThreadPoolExecutor` 扇出）。

---

## 三、Gap 分析（Hermes vs Khy-OS 现状）

| 支柱 | Hermes v0.18.0 | Khy-OS 现状（锚点） | Gap | 结论 |
|---|---|---|---|---|
| 判断 · MoA | 虚拟 provider + 参考并行 + aggregator 综合作答 | **无综合式集成**；仅 Arena「比较排名」不综合（`services/arenaManager.js:68`，未接入 goal/tool-loop） | 高 | 后续候选（工程量大） |
| 验证 · 证据 | 5 字段契约 + 外部 judge 裁决 + **要求具体证据**才判 done | 自由文本目标（`goalCore.js` 无契约）+ **正则自证**（`goalStopGate.looksLikeGoalSatisfied:125`）+ turn 预算；**无证据门** | **高，且基础设施已就位** | ★**本次落地** |
| 进化 · /learn | 目录/网页/工作流 → SKILL.md | `skill learn` 仅 npm/github/工作流序列（`cli/handlers/skill.js:200`），**缺目录/网页** | 中 | 后续候选 |
| 进化 · /journey | 时间线可视化 memory+skills，可增删改 | memdir（`memdir/memdir.js`）+ `skill *` CLI 分散，**无统一 /journey 视图** | 中 | 后续候选 |

**为何选「验证」落地**：
1. **直击现有弱点**：`goalStopGate.js:105` 把「已验证通过 / 全部测试通过 / all tests passed」直接
   当作完成信号——这正是 Hermes judge 明确拒绝的「无证据的声称」。当前 khy 完全接受空口声称。
2. **基础设施已就位**：`goalStopGate.evaluateGoalStop` 已是纯叶子决策中枢，`redrive` 预算、门控父子
   链、字节回退机制齐备——加一道证据校验是**自然扩展**而非新建子系统。
3. **成本/风险最低**：纯叶子 + 默认开门控 + 关即字节回退 + 有界 redrive；误判方向皆有界安全（见 §4.3）。
4. **对齐用户诉求**：用户原话强调「以前很多 Agent 做完只说'我完成了'…v0.18 更强调 evidence」。

---

## 四、本次落地：`/goal` 证据门（KHY_GOAL_EVIDENCE_GATE）

### 4.1 设计
在 `goalStopGate.evaluateGoalStop` 的 `satisfied` 分支**插入一道证据校验**（不改既有判定语义，只加拦截）：
当达成判定**建立在一个「验证声称」之上**（如「已验证通过」「全部测试通过」「all tests passed」）却
**看不到任何具体证据**时，把 `clear/satisfied` **降级为 `redrive`**，注入一条要求出具证据的指令。

- 纯叶子实现（Khy-OS 侧锚点，均在 `services/backend/src/services/goalStopGate.js`）：
  - `_VERIFICATION_CLAIM_RE`：识别「验证/测试/检查成功」的声称。
  - `_EVIDENCE_RE` + `hasConcreteEvidence(reply)`：识别真实产物——代码块 ```` ``` ````、测试通过数
    （`12 passed`/`8 通过`）、比值（`9/9`）、退出码（`exit code 0`/`退出码 0`）、TAP/node:test 行
    （`ok 1`/`# pass 8`）、对勾叉号（✓✔✅❌）、jest `PASS`/`FAIL`、shell 提示符（`$ …`）、测试框架
    调用（`npm test`/`node --test`/`pytest`/`jest`）。
  - `claimsVerificationWithoutEvidence(reply)`：**声称验证 ∧ 无证据** → true。
  - `buildEvidenceRedriveMessage(goal)`：要求**实际运行**验证并**原样粘贴**输出后再收尾。
  - `isEvidenceGateEnabled(env)`：门 `KHY_GOAL_EVIDENCE_GATE`，父 `KHY_GOAL_STOP_GATE`。
- 门注册：`flagRegistry.js` `KHY_GOAL_EVIDENCE_GATE: { default-on, off:CANON, parent:KHY_GOAL_STOP_GATE }`。

### 4.2 判定流（evaluateGoalStop 内）
```
satisfied?
 ├─ 否 → 原 redrive/pass 逻辑不变
 └─ 是 → 证据门开 且 claimsVerificationWithoutEvidence?
          ├─ 否 → clear / pass（原逻辑，纯"目标已完成"不受扰动）
          └─ 是 → redrive 预算未耗尽 ? redrive(evidence-missing) : pass(evidence-missing-exhausted)
```
预算耗尽时**降级为 `pass` 而非 `clear`**——不自动清除一个未经证实的目标，交由每轮开头的 goalCore
指令注入 + 跨轮轮次预算继续兜底。

### 4.3 安全性（误判方向皆有界）
- **保守不扰动**：仅拦「声称了验证却无证据」这一精确失败模式；纯「目标已完成」（不声称验证）走原
  接受路径不变。
- **证据识别偏松**：`hasConcreteEvidence` 内部异常 → 偏向「有证据」（不误拦）；即便漏判也只多推一次
  （有界 redrive 预算），代价小且可控。
- **关即字节回退**：`KHY_GOAL_EVIDENCE_GATE=0`（或父门 `KHY_GOAL_STOP_GATE`/祖父门 `KHY_GOAL` 关）
  → 逐字节回退到「声称即接受」的今日行为。
- **纯叶子零 IO**：判定/文案全在叶子，绝不抛。

### 4.4 验证证据
```
$ node --test src/services/__tests__/goalStopGate.test.js
ℹ tests 26  ℹ pass 26  ℹ fail 0
$ node --test tests/services/flagRegistry.test.js
ℹ tests 44  ℹ pass 44  ℹ fail 0
```
守卫（对 untracked 新叶子显式扫，`--changed` 走 git diff 不含 untracked）：
```
leaf-contract / agent-rules / change-safety / model-hardcoding : PASS（我文件净）
check:flag-registry : registry table is structurally sound
```

---

## 五、后续候选（本次不实现，给移植路线）

- **MoA（判断）**：Khy-OS 已有 Arena（比较排名）与网关多适配器/apiKeyPool/accountPool 兜底，但缺
  **综合作答**。移植路线：新增一个「aggregator」纯叶子（拼接编号参考输出 + 置尾引导，复用
  `arenaManager` 的并行扇出采集），由网关 `generate` 边缘在选中「moa」伪模型时接住。风险：计价/流式
  /工具调用穿透，工程量高——须单独立项。
- **/learn 目录+网页蒸馏（进化）**：扩 `skillLearningService`（`services/ai-backend`）新增
  `learnFromDirectory` / `learnFromUrl` 两来源，产物仍走既有 skill 目录格式与索引注入。中等工程量。
- **/journey 统一视图（进化）**：Khy-OS 已有 memdir + `skill *` CLI，缺统一时间线。移植路线：新增
  纯叶子聚合 memdir 索引 + skill 注册表为时间线数据 + ASCII 渲染叶子（复用 upstreamStudyReport 同构），
  再加 `/journey list|edit|delete` 路由分派。中等工程量。

---

## 六、传承指针
- 承 [DESIGN-ARCH-061]（更新包学习红线）、[DESIGN-ARCH-060/064]（接线/生命周期总图）。
- 实现文件：`services/backend/src/services/goalStopGate.js`（证据门叶子）、`flagRegistry.js`（门注册）、
  `services/backend/src/services/__tests__/goalStopGate.test.js`（+11 用例）。
- 门控清单新增：`KHY_GOAL_EVIDENCE_GATE`（default-on，父 `KHY_GOAL_STOP_GATE`）。
