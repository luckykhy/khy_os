<!-- 文档分类: INIT-PRD-003 | 阶段: 立项 | 原路径: 新建 -->
# [INIT-PRD-003] KhyOS 的核心 —— 定位口径单一真源

> **定位**：回答「KhyOS 的核心是什么」，并**收口「核心」一词在全仓的多套口径**。
> **性质**：定位层收口件，不是新规范。它不推翻 [`DESIGN-TOOL-002`](../../10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md)（核的边界与契约）、[`DESIGN-ARCH-097`](../../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.md)（核心边界定稿）、[`DESIGN-PHILOSOPHY`](../../03_DESIGN_设计/其它设计/[DESIGN-PHILOSOPHY] 设计哲学总纲.md)（设计不变式）；本文只回答「这些核加起来的那个东西，是什么」。
> **证据基线**：工作树 `v1.1.15`，2026-09-14 一次实际扫描。文中每个数字都可复现，命令见附录。
> **状态**：定稿（2026-09-14）。

---

## 〇、一句话

**KhyOS 的核心是：一套把「模型调用」当作系统调用一样统一收口的 AI 平台运行时。**

它对外是一个 CLI / TUI 形态的智能体工作台；对内是一套 **壳 → 漏斗 → 网关** 的不可卸载运行时。其余一切——应用、工具、技能、MCP、IDE 桥接、自研内核——都是挂在这套运行时上的**可增删单元**。

这句话有两个推论，是本篇与既有文档最不同的地方：

1. **核心不是「功能最多的那部分」，而是「删了就跑不起来的那部分」。** 判据是删除实验，不是重要性排序。
2. **「核心」有两个轴，必须先切开再谈。** 混着用是当前全仓口径漂移的根源（见第一节）。

---

## 一、「核心」一词必须先一词一解

> 本节是本文存在的理由。不先切开，任何关于核心的讨论都会各说各话。

全仓至少有四处用「核心」/「核」，它们回答的是**不同的问题**：

| 口径 | 出处 | 回答的问题 | 判据 |
| --- | --- | --- | --- |
| **A · 不可卸载核** | [`069`](../../10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md)**，有机器守卫） | 删掉什么，系统就跑不起来？ | 「删掉它，还能启动并跑通一次工具调用吗？」 |
| **B · 产品核心**../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.md界定稿-一词一解.md)（定稿收口件） | 产品的价值由哪几块构成？ | A 的判据 **+** 「删掉它系统仍能跑，但产品主张塌掉一角」 |
| **C · 定位栈** | [`INIT-PRD-002`]([INIT-PRD-002] 项目-定位.md) / `README.md` | 对外怎么讲这个故事？ | 分层叙事，**无判据** |
| **D · 设计不变式** | [`DESIGN-PHILOSOPHY`](../../03_DESIGN_设计/其它设计/[DESIGN-PHILOSOPHY] 设计哲学总纲.md) | 代码必须遵守什么？ | 机器守卫 + 人工评审 |

**本文的裁定：A ⊂ B。**

- A 是 B 的**硬子集**——A 的每一项必然在 B 里。
- B 额外收录「删了还能跑、但产品主张塌一角」的项，所以 B 严格大于 A。
- C 是**叙事**，D 是**约束**，两者都不参与「哪几块是核心」的裁决。把 C 或 D 当成核心清单读，就会得出「核心有五个」或「核心有七条」这类无法互相验证的结论。

**为什么必须切开**：069 的「核」是**安全边界语义**（拓展必须穿过漏斗、不得绕过），097 的「核心」是**产品构成语义**。同一份仓库里，一个词承担两种语义，且 069 是强制规范、097 是定稿件——不显式声明 `A ⊂ B`，后来者只能靠猜。

---

## 二、核心清单（以 B 为准，标注 A 子集）

### 运行核（= A，删掉即无法启动或无法完成一次工具调用）

| 核 | 一句话 | 实测锚点（v1.1.15） |
| --- | --- | --- |
| **壳** | 承载启动、REPL/TUI 与命令路由的运行时底座 | `platform/khy_platform/` 16 个 `.py`；`services/backend/src/cli/` 顶层 177 个 `.js`（含子目录 535 个）；`router.js` / `aliases.js` / `repl.js` / `tui/` 均在位 |
| **漏斗** | 所有工具调用的唯一出口，权限与沙箱的裁决边界 | `services/backend/src/services/tool*` 35 个文件（`toolCalling` / `toolSandbox` / `permissionBroker` / `shellSafetyValidator` 均在位）；`src/tools/` 102 个子目录 + 122 个文件 |
| **网关** | 统一多供应商模型路由、密钥池与协议转换 | `services/backend/src/services/gateway/adapters/` 66 个文件，其中 19 个 `*Adapter.js`；`services/ai-backend/` 在位 |

### 主张核（= B \ A，删掉系统仍能跑，但产品主张塌一角）

| 核 | 一句话 | 实测锚点（v1.1.15） |
| --- | --- | --- |
| **智能体** | 驱动模型自主调用工具的循环引擎与内置智能体 | `services/backend/src/services/toolUseLoopCore.js` 12,018 行；`src/agents/built-in/` 26 个 `.js` |
| **工作流** | 登记 → 执行 → 裁决 → 交付 → 台账的任务收尾循环 | `taskClosure.js` / `backgroundTaskManager.js` / `deliveryLedger.js` 均在位；台账 `.khy/taskboard.db` 存在 |
| **记忆** | 会话续接、向量召回与 RAG 注入的跨回合连续性设施 | `services/backend/src/services/domain/memory/`（`memoryEngine/` / `compact/` / `cognitiveSnapshot/`）；`vectorRecall.js` / `vectorStore.js` / `distiller.js` 均在位 |
| **拓展契约** | 一套 `khy.extension.json` 机制承载 tool / plugin / scripts / mcp / software / 协议六类拓展 | 全仓 10 个 `khy.extension.json`；`extensions/` 为两层 `<分类>/<id>/` |

> **一处勘误**：097 把记忆锚点写作 `domain/memory/memoryEngine/`，实测完整路径是 `services/backend/src/services/domain/memory/memoryEngine/`。本文以实测为准。

### 为什么是这七个，而不是五个或三个

- **智能体入核而非归「壳」**：壳提供进程与命令路由，但「模型自主循环调用工具」是另一套引擎（12,018 行的 `toolUseLoopCore.js`），删掉它壳还在、命令还能敲，但没有 agent 了。它不满足 A 的判据（系统仍能启动），满足 B 的判据（产品主张塌掉最大一角）。
- **记忆入核而非归「功能」**：它不是装饰件——`memoryEngine/` 下有独立的向量召回、向量存储、蒸馏三层，是跨回合连续性的实现主体。
- **技能 / MCP 不入核**：069 §1.2 明确 tool / plugin / scripts / mcp / software / 协议是**同一套拓展机制下的六类实现**。它们不是独立的核，是拓展契约的内容。

---

## 三、非核心的裁决（明确排除，附理由）

| 被排除者 | 位置 | 裁决理由 |
| --- | --- | --- |
| **内核** | `kernel/` | **不占核心席位**。它是「操作系统」定位的**实验分支**：128 个 `.c/.h`（46 `.c` + 82 `.h`）在位，但**零构建产物**（无 `.iso` / `.bin` / `.img`，`kernel/iso/` 仅有 `boot/`），CI 为 `continue-on-error`，仓库自评「教学/实验/爱好级」。**见第四节的冲突登记** |
| **khyquant** | `software/khyquant/` | **内置默认示例应用**，非项目本身（`README.md` / `AGENTS.md` / `068` §1.1 三处同述）。判据：删掉它，Khy-OS 仍是 Khy-OS |
| **平台前端** | `apps/ai-frontend/` | L3，平台自带管理界面。经 Web API 消费核心，本身不是核心 |
| **桌面端 / 移动端** | `apps/khyos-desktop/`、`electron/` | 应用层，经 bridge / API 消费核心 |
| **工具集** | `services/backend/src/tools/`（102 个子目录） | **漏斗下的实现**。工具是核心能力的**内容**，不是核心机制本身——机制是漏斗（统一出口 + 权限裁决），工具可增删 |
| **IDE 桥接** | `extensions/bridges/` | `kind: ide-bridge` 类拓展，可卸载 |

**一条判据通吃**：问「删掉它，Khy-OS 还是 Khy-OS 吗？」——是 → 非核心；不是 → 核心。这条与 `068` §1.1 的 L3/L4 分界判据同构，是同一个思路在不同粒度上的应用。

---

## 四、口径冲突登记（本轮实测发现，需人工确认）

> 这些是「核心不清」的具体病灶。本文给出裁决，但**涉及 README 等对外材料的改写属独立一轮工作**，本文只登记、不擅自改。

### 4.1 内核：README 与 097 正面冲突 ⚠️

| 出处 | 表述 |
| --- | --- |
| `README.md` 项目简介 | 三大件之一：「**手写 OS 内核**（`kernel/`，C 语言）：抢占式调度、按需分页、写时复制 `fork`……**可在 QEMU 下引导运行**」 |
| `[INIT-PRD-002]` 架构栈 | 五层栈的**最底层**：「KHY Kernel — x86_../03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-097] KhyOS 核心边界定稿-一词一解.mdKhyOS%20核心边界定稿-一词一解.md) §定位裁决 | 「**不占核心席位**——『操作系统』定位的实验分支：零 build 产物、零 ISO、零启动日志，CI `continue-on-error`，README 自评『教学/实验/爱好级』」 |

**本文裁决**：以 097 为准——**内核不是核心**。实测支持这个裁决：当前工作树上 `kernel/` 无任何构建产物，「可在 QEMU 下引导运行」**无法从工作树复现**（需先 `make` 构建）。

**待办（不属本文）**：`README.md` 把内核列为「三大件」之一，与本文及 097 冲突。要么改 README 的措辞（降级为「实验分支」），要么在 README 里显式标注「需先构建」。**建议后者**——内核是项目叙事资产，直接删掉会损失「单人手写 OS」的差异化，但必须把「实验」二字显性化。

### 4.2 「核心」的多套口径并存

| 出处 | 口径 | 数量 | 本文裁决 |
| --- | --- | --- | --- |
| `README.md` | 智能体 CLI + AI 网关 + OS 内核 | 3 | 叙事口径（C），保留，但内核需按 4.1 降级 |
| `[INIT-PRD-002]` | Kernel / Shell / Gateway / Runtime / Apps | 5 | 叙事口径（C），保留 |
| [`069`](../../10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md) | 七核两层 | 7 | 口径 B，**定稿，不动** |
| 本文 | A ⊂ B，一句话定位 | — | **收口**：A 与 B 从此各有明确定义，不再混用 |

### 4.3 文档编号冲突（5 处，`docs-index-complete` 之外的债）

索引 `00_INDEX_文档索引.md` 自己已标注一处（`DESIGN-ARCH-067`），实测共 **5 组**编号被两个不同文档占用：

| 编号 | 文档甲 | 文档乙 |
| --- | --- | --- |
| `067` | opencode 高含金量功能教学… | 动态模型差异化适配引擎 |
| `072` | 模型上下文窗口探测规范 | 项目规范化总纲 |
| `073` | 规范快速参考卡 | khyos 核心任务循环-稳定交付总纲 |
| `076` | 任务最小闭环-裁决接线与交付台账 | （索引另列同名件） |
| `077` | khyos 核心任务循环-稳定交付总纲 | （索引另列同名件） |

**裁决**：属独立一轮工作（重编须同步改写全部入站引用）。本文只登记，供后续批量处理。

---

## 五、与既有文档的关系（避免本文自己制造漂移）

本文**不新增规范、不新增守卫、不改动任何既有文档的语义**。它只做三件事：

1. 把「核心」一词按 A / B / C / D 四个轴切开，声明 `A ⊂ B`；
2. 给出定位层的一句话核心；
3. 登记全仓仍在漂移的口径，并给出裁决。

**真源归属（谁管什么，从此不再重叠）**：

| 问题 | 真源 |
| --- | --- |
| 什么东西算「不可卸载核」，拓展与核的边界与契约 | [`069`](../../10_规范/其它规范/[DESIGN-TOOL-002] 拓展契约与核心边界规范.md) |
| **「核心」一词的轴切分与定位层的一句话** | **本文** |
| 顶层目录 L0–L6 与依赖边 | [`068`](../../10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md) |

---

## 附录 · 复现命令

```bash
# 运行核 / 主张核的锚点规模
ls platform/khy_platform/*.py | wc -l
find services/backend/src/cli -name '*.js' | wc -l
ls services/backend/src/services/tool*.js | wc -l
ls services/backend/src/services/gateway/adapters/ | wc -l
wc -l services/backend/src/services/toolUseLoopCore.js
ls services/backend/src/agents/built-in/*.js | wc -l
ls services/backend/src/services/domain/memory/

# 拓展契约
find . -name 'khy.extension.json' -not -path './node_modules/*' | wc -l

# 内核（关键：验证有无构建产物）
find kernel -name '*.c' | wc -l && find kernel -name '*.h' | wc -l
find kernel -name '*.iso' -o -name '*.bin' -o -name '*.img'   # 期望：空
```

---

## 变更记录

- 2026-09-14：初版。基于工作树 v1.1.15 的实际扫描建立；收口「核心」四套口径为 A/B/C/D 四轴并声明 `A ⊂ B`；登记 3 处口径冲突（内核 README vs 097、核心多口径、编号冲突 5 组）。
