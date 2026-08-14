# 通过 KHY 学习模式：从 0 到 1 拿下大厂 Agent 岗的底气

> 个人学习路线图。把 KHY-OS（一套真实的端到端 Agent 系统）作为「带参考实现的教科书」，
> 用 `khy learn` 系统过一遍，再把 KHY 的内部叫法翻译成大厂面试通用术语，
> 最终能在白板/系统设计/项目深挖三类面试环节都接得住。

---

## 0. 为什么 KHY-OS 是绝佳的面试素材

大厂「Agent / Applied AI / Agent Infra」岗位面试，本质考的就这几块：
**Agent 循环、工具调用、上下文管理、多 Agent 编排、Provider 抽象、可靠性、护栏、RAG、流式、评测。**

而 KHY-OS **每一块都有真实可读的实现**，不是 PPT。这意味着每道面试题你都能答：
**「我不是看过文章，我读过/写过一套完整实现，它是这么做的、为什么这么做、踩过哪些坑。」**
这就是「底气」的来源——**用一套你能讲到代码行的系统，覆盖整张面试地图。**

---

## 1. 学习模式怎么用（命令速查）

```bash
khy learn                 # 进入课程总览（12 层）
khy learn 3               # 学第 3 层（AI 网关）整层
khy learn 3.2             # 学第 3 层第 2 个知识点（适配器协议层）
khy learn next            # 顺着进度学下一个知识点
khy learn progress        # 看已学进度
khy learn <关键词>         # 按关键词检索知识点（如 khy learn 工具循环）
khy learn check           # 校验课程链接完整性（94 检查点）
khy learn refresh         # 课程自进化：扫新模块/自愈失效引用/（有模型时）AI 扩充讲解
khy learn refresh clear   # 清空动态覆盖层，回到纯随包课程（地板）
khy learn reset           # 重置进度
khy learn note / memory   # 记笔记 / 看你的学习记忆

# 零基础讲解档位（持久化，默认 normal）
khy learn level           # 看当前讲解档位
khy learn level beginner  # 切「零基础」：先生活比喻→逐行点关键语法+「这门语言为什么这样写」→算法讲直觉→Agent 概念日常类比→结尾主动指出本段可改进点
khy learn level normal    # 切回常规档位（同一知识点回到原讲解，无零基础块）

# 边学边发现不足并完善（改进清单，只产建议不改代码）
khy learn improve <一句话描述>   # 把刚学知识点的「不足」记入清单；有模型时附 AI 修复提议（仅展示、不自动应用）
khy learn improve list           # 复盘改进清单（最新在前）
khy learn improve <描述> --route # 额外路由到 evo 改进管线（需 KHY_EVO_ENGINE=1，默认关）
```

> **零基础专用**：档位与改进清单都落 `~/.khyos/growth/`（随 pip 升级不丢），与进度同主权域；
> 无模型/无网时 `improve` 仍记清单（只是没有 AI 提议），banner 会显示「改进清单 N」。
> 别名：`难度/档位 → level`、`零基础 → level beginner`、`改进/反馈/记不足 → improve`、`改进清单 → improve list`。

**三种模式**（系统自动按能力探测，无需手配）：
- 模式 1（无模型/无网）：纯静态——源码预览 + 导航，照样能学。
- 模式 2（有网/无模型）：词法 RAG 补检索。
- 模式 3（有模型 + 混合 RAG）：**面谈式**讲解，像和资深工程师对话——**面试备战首选这个**。
  接一个云端网关（claude/kiro/cursor 等）即进入模式 3。

> 学法建议：每个知识点先 `khy learn <N>.<M>` 让它讲，**然后自己打开它指向的源码文件读一遍**，
> 再用下面 §3 的翻译表把这块「我用面试语言怎么讲」写进 `khy learn note`。

**课程随能力自我进化（不再硬编码）**：随包的 12 层课程是**离线确定性地板**——无网、无模型也永远能学。
但当文件系统/网络/模型可用时，课程会在地板之上叠加一个**动态覆盖层**，自动做三件事：
**①发现新模块**（仓库里新写的子系统自动进课程）、**②自愈失效引用**（源码重构后路径变了，按文件名在仓库内唯一匹配重定位）、
**③AI 扩充讲解**（接了云端网关时，为新发现的知识点现场生成要点、闭环扩充课程）。
动态内容会打「动态/AI 生成」徽标，写到 `~/.khyos/growth/curriculum_overlay.json`（**绝不改随包 JSON**），
随时 `khy learn refresh clear` 一键回到纯地板。离线场景下一切仍以随包课程为准，所以**断网照样能学、段位毕业线只按随包地板层计算**（动态新增的内容不会让「大师」线漂移）。
进 `khy learn` 时会低频机会式刷新（带 TTL + 指纹门禁，不卡顿）；设 `KHY_LEARN_DYNAMIC=0` 可完全关闭，强制纯地板。

---

## 1.5 成长段位与进度携带（从「白纸」到「大师」）

学习不是无感的，KHY 给你一条**修仙式成长路线**：每**通关一层**（该层所有知识点都 `learn done`）
就可能突破一个境界。零基础起步也有清晰路标和成长反馈。

```bash
khy learn roadmap     # 看完整成长路线图（修仙阶梯 + 当前境界 + 距下一境界还差几层）
khy learn rank        # 同上（别名）
khy learn export      # 导出进度到 ./khy-learning-progress.json（换电脑带得走）
khy learn export /path/to/p.json    # 导出到指定路径
khy learn import <文件>             # 在新设备导入（默认合并：取并集 + 较高 XP）
khy learn import <文件> --replace   # 整体覆盖本机进度
```

**八重境界**（按已通关层数解锁）：

| 等级 | 境界 | 解锁条件（已通关层数） |
|---|---|---|
| Lv0 | 凡人（白纸） | 0 |
| Lv1 | 练气 | ≥1 |
| Lv2 | 筑基 | ≥3 |
| Lv3 | 金丹 | ≥5 |
| Lv4 | 元婴 | ≥7 |
| Lv5 | 化神 | ≥9 |
| Lv6 | 大乘 | 通关全部内容层（≥11） |
| Lv7 | 大师（渡劫飞升） | 通关全部层（含 Bug 层）= 毕业认证 |

**三种「不丢进度」保障**：

1. **升级不丢**：进度存于 `~/.khyos/growth/learning_progress.json`（在你的主目录、属底座领地），
   `pip install -U` 升级/重装 KHY **不会覆盖**它；每次写入还会原子落盘 + 轮转一份 `.bak` 兜底。
2. **换电脑带得走**：`export` 导出成一个可携带 JSON，到新机器 `import` 即可合并恢复。
3. **课程随包自带**：12 层课程数据（`curriculum.json`）随 pip 包一起发布，
   离线、无模型也能 `khy learn` 开始修行（详见 §1 的「三种模式」）。

> 旧版本进度若存在于 `~/.khyquant/growth/`，首次运行会**自动迁移**到 `~/.khyos/growth/`，
> 旧文件保留不删——绝不丢进度。

---

## 2. 课程地图（12 层 → 面试价值分级）

| 层 | 主题 | 面试价值 | 说明 |
|---|---|---|---|
| 0 | 项目总览与愿景 | ⭐ | 建立全局观，面试讲项目背景用 |
| 1 | 启动链路 | ⭐ | 工程基本功，非重点 |
| 2 | CLI 路由系统 | ⭐ | 软件工程，非 agent 重点 |
| **3** | **AI 网关 / 适配器 / 密钥选择** | ⭐⭐⭐ | **Provider 抽象、多路由、熔断——系统设计高频** |
| **4** | **工具系统 / 工具调用编排** | ⭐⭐⭐ | **Function calling、工具 schema、结果结构化——必考** |
| **5** | **工具循环引擎 / Nudge / 安全守护 / 上下文管理** | ⭐⭐⭐ | **Agent 循环核心——这是面试的心脏** |
| 6 | REPL 交互层 / 流式渲染 | ⭐⭐ | 流式 SSE、TUI，加分项 |
| 7 | 量化核心 | ☆ | 与 agent 无关，可跳过（除非面金融方向） |
| 8 | 前端系统 | ☆ | 可跳过（除非全栈岗） |
| **9** | **多 Agent 协调 / WASM 沙箱 / 技能系统** | ⭐⭐⭐ | **多 Agent 编排 + 沙箱隔离——高级岗差异化** |
| **11** | **内核 ⇄ Agent 协同协议（A1–A8）** | ⭐⭐ | **系统底层深度——稀缺差异化，讲出来面试官记得住** |

**优先级学习顺序（面试导向）**：`5 → 4 → 3 → 9 → 6 → 11 → 0 → 1/2`，
量化(7)/前端(8)按目标岗位取舍。

---

## 3. ⭐核心：KHY 内部叫法 → 大厂面试标准术语翻译表

> KHY 有很多自创中文名（元规划/熔炉/淬火…），**面试时千万别用这些名字**——
> 它们背后是标准 agent 工程模式。下表把「你在 KHY 学到的东西」翻译成「面试官听得懂的话」。
> 这张表是本路线图的核心资产：**学完每一层，回到这里确认你能用右列的话讲左列的实现。**

### 3.1 Agent 循环（层 5）

| KHY 实现 | 面试标准术语 | 面试怎么讲 |
|---|---|---|
| 工具循环引擎主循环 `toolUseLoop` | **Agent loop / ReAct loop** | 「思考→调用工具→观察结果→再思考」的循环，直到模型不再请求工具或触发停止条件 |
| max_tokens 恢复 / 循环检测 | **Loop detection & stopping conditions** | 检测重复 tool_call 防死循环、设 max iterations、token 预算耗尽即停 |
| Nudge 机制 | **Steering / re-prompting** | 模型卡住或不调工具时注入引导，类似 reflection / self-correction |
| 上下文管理（冷热分区 / 压缩） | **Context window management / compaction** | 长对话超窗时摘要旧轮次、保留近窗，区分 RAW/压缩层 |
| 安全守护（guard） | **Guardrails / policy checks** | 工具执行前的红线校验 |

### 3.2 工具调用（层 4）

| KHY 实现 | 面试标准术语 | 面试怎么讲 |
|---|---|---|
| 工具基类 / 注册 | **Tool / function schema (JSON Schema)** | 工具用 JSON Schema 声明参数，模型按 schema 生成调用 |
| 工具调用编排 `executeTool` 单入口 | **Tool dispatcher / single funnel** | 所有工具走单一漏斗，便于统一鉴权/审计/锁/限流 |
| 结构化 tool_result | **Structured tool results** | 工具结果回传用结构化（非纯文本），含 isError/错误码，模型可消费 |
| 文件锁装饰器 | **Concurrency control / idempotency** | 多实例并发时工具层加锁，绝不静默覆盖 |

### 3.3 Provider 抽象（层 3）

| KHY 实现 | 面试标准术语 | 面试怎么讲 |
|---|---|---|
| AI 网关 + 16 适配器 | **Provider abstraction / LLM gateway** | 统一接口屏蔽各家 API 差异（OpenAI/Anthropic 协议） |
| 适配器级联 + fast-fail | **Fallback chain / failover** | 主 provider 失败级联到备用 |
| 断路器 / 冷却 | **Circuit breaker** | 连续失败的 provider 暂时熔断，避免雪崩 |
| modelRouter 模型→适配器 | **Model routing** | 按 tier/能力/成本把请求路由到合适模型 |
| 密钥选择器 P2C | **Load balancing (power-of-two-choices)** | 多账号/多 key 间负载均衡 |

### 3.4 多 Agent 与编排（层 9 + 记忆里的治理子系统）

| KHY 实现 | 面试标准术语 | 面试怎么讲 |
|---|---|---|
| 多 Agent 协调 | **Multi-agent orchestration** | planner/executor、子代理 fan-out/fan-in、handoff |
| 元规划协议（metaplan） | **Planner-executor / task decomposition** | 执行前先规划、动态约束注入（≈ 计划阶段 + 受控执行） |
| WASM 沙箱 / executeCode 进程隔离 | **Sandboxing / isolation** | 不可信代码在沙箱执行，进程级隔离防逃逸 |
| 系统级服务调用审批网关 | **Human-in-the-loop approval / capability-based security** | 高危操作分级审批（L0绿/L1黄/L2红），能力隔离 |
| 依赖自愈 / 自愈微循环 | **Self-healing / error recovery** | 错误先归因再自动修复，熔断防死循环重试 |
| 通信防御零静默失败 | **Structured error handling / observability** | 杜绝「未知错误」，所有失败带错误码 + 字段 |

### 3.5 RAG（learningRetrieval + 之前那段对话）

| KHY 实现 | 面试标准术语 | 面试怎么讲 |
|---|---|---|
| 混合检索（词法 + 向量） | **Hybrid retrieval (BM25 + dense)** | 词法兜底 + 向量召回，向量重排提召回率 |
| 三模式降级 | **Graceful degradation** | 无向量时退词法，无网退本地，永不挂死 |
| 「Agent 而非 RAG 处理代码」 | **当 RAG 不适用：agentic retrieval** | 代码价值在关系里，切片破坏逻辑；用 agent 按需 grep/read 重建结构。**这是高级面试的加分论述** |

### 3.6 系统底层（层 11，差异化王牌）

| KHY 实现 | 面试标准术语 | 面试怎么讲 |
|---|---|---|
| A5 决策面 OS→agent 阻塞问答 | **Agent-in-the-loop syscall / blocking RPC** | 内核遇决策点阻塞，向 agent 求决策，3s 超时兜底 |
| A1–A2 COBS+CRC16 帧协议 | **Wire protocol / framing** | 自定义二进制协议、校验、跨进程边界 |
| host 桥二进制⇄JSON | **Protocol bridging / serialization** | |

> 这一层别人没有，**讲出来能让面试官记住你**——「我做过一个让操作系统内核在决策点回调 AI agent 的协议」。

---

## 4. 四周冲刺计划（可压缩/拉长）

**第 1 周 · Agent 心脏**（层 5 + 4）
- `khy learn 5`（循环引擎四个知识点）→ 读 `toolUseLoop.js` 全文
- `khy learn 4`（工具系统）→ 读 `executeTool` 单入口
- 产出：能在白板画出完整 agent loop（含停止条件、循环检测、上下文压缩点）
- 自测题：「设计一个 agent 执行循环，如何防死循环？上下文爆了怎么办？」

**第 2 周 · 基础设施**（层 3 + 6）
- `khy learn 3`（网关/适配器/路由/熔断/密钥）
- `khy learn 6`（REPL/流式渲染）
- 产出：能讲清「多 provider 网关 + fallback + circuit breaker」系统设计
- 自测题：「设计一个支持多 LLM provider、有容灾的网关。」

**第 3 周 · 高级编排与安全**（层 9 + 记忆里的治理子系统）
- `khy learn 9`（多 agent / 沙箱 / 技能）
- 读 metaplan / resilience / 审批网关 / 自愈 子系统源码（`services/backend/src/services/` 下）
- 产出：能讲多 agent 编排 + 沙箱隔离 + human-in-the-loop 审批
- 自测题：「多 agent 系统如何拆分任务、如何防一个 agent 拖垮全局、危险操作怎么管控？」

**第 4 周 · 差异化 + 整合**（层 11 + 0 + 模拟面试）
- `khy learn 11`（内核⇄agent 协议，A1–A8）
- `khy learn 0`（项目愿景，准备项目介绍话术）
- 把 §3 翻译表过一遍，每行都能用右列的话脱口而出
- 做 §5 的模拟面试自检

---

## 5. 大厂 Agent 岗面试自检清单（学完逐条打勾）

**概念层（口述 30 秒讲清）**
- [ ] 什么是 agent loop / ReAct？停止条件有哪些？
- [ ] Function calling 的协议流程？tool schema 怎么设计？结果为什么要结构化？
- [ ] 上下文窗口管理：压缩 vs RAG vs 长上下文，各自取舍
- [ ] Provider 抽象 + fallback + circuit breaker 为什么需要
- [ ] 多 agent 编排模式：planner-executor、子代理、handoff
- [ ] RAG 的 chunking/embedding/rerank/hybrid；**什么时候不该用 RAG**
- [ ] Guardrails / 沙箱 / human-in-the-loop 审批
- [ ] 流式 SSE、token streaming
- [ ] 可靠性：重试、超时、降级、结构化错误、自愈

**系统设计层（能画图 + 取舍）**
- [ ] 设计一个 coding agent（工具循环 + 文件操作 + 沙箱执行 + 上下文管理）
- [ ] 设计一个多 provider LLM 网关（路由 + 容灾 + 限流 + 计费）
- [ ] 设计一个多 agent 任务系统（拆分 + 调度 + 故障隔离 + 结果合并）

**项目深挖层（你的王牌）**
- [ ] 用 §3 翻译表，把「我在 KHY-OS 做过/读过 X」翻成标准术语讲出来
- [ ] 准备 2–3 个「踩坑 + 怎么解决」的故事（KHY 记忆里全是真实案例：
      工具循环 tool_result 丢失、适配器级联、文件锁、内核 lost-wakeup…）
- [ ] 准备「KHY 内核⇄agent 协议」作为差异化记忆点

---

## 6. KHY 没覆盖、需要外部补的（诚实清单）

KHY-OS 强在「端到端真实实现」，但有几块面试会问、KHY 较弱，需自行补：

1. **Agent 评测（Eval）**：KHY 有 A/B 回归，但大厂要系统化 eval（成功率/轨迹评估/LLM-as-judge）。
   补：读 agent eval 框架思路（轨迹评估、工具调用准确率、端到端任务成功率）。
2. **规模化 / 分布式**：KHY 偏单机。大厂关心高并发、低延迟、成本优化、KV cache、batching。
   补：prompt caching、请求批处理、并发限流在分布式下的做法。
3. **业界标准框架词汇**：面试官可能用 LangGraph / function calling spec 等术语。
   补：把 KHY 概念映射到 1–2 个主流框架的命名（用 §3 表反向对照即可）。
4. **学术脉络**：ReAct、Reflexion、Toolformer、Tree-of-Thoughts 的一句话来历。
   补：每篇知道「解决什么问题 + 核心思想」即可，不必深读。

---

## 7. 一句话心法

> **不要去「背」agent 知识。把 KHY-OS 当成你能讲到代码行的参考实现，
> 学完每一层就用 §3 翻译表把它翻成面试语言。**
> 当每一道面试题你都能回答「这个我读过/做过，KHY 是这么实现的，取舍是 X，坑是 Y」——
> 底气就有了。
