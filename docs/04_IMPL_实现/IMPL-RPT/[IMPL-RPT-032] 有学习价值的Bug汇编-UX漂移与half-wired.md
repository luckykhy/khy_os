# [IMPL-RPT-032] 有学习价值的 Bug 汇编：UX 漂移与 half-wired 一类

> 实现报告 · 遵循 [MGMT-STD-001] 文档铁律 · 对应设计归 `docs/03_DESIGN_设计/`，本目录索引见 `00_INDEX_实现-分类索引.md`

- **日期**：2026-07-02
- **范围**：收录**有学习价值**的 bug——不是简单的崩溃/超时事故（那类进 [IMPL-RPT-015] 时间线），
  而是**根因隐蔽、修复方法可迁移**的一类：交互面漂移（TUI vs 经典 REPL）、half-wired（底座算好了却没接上呈现）、
  以及「按类别聚合」这类看似简单实则有结构陷阱的前端改造。
- **状态**：活文档（随新案例追加）；本轮收录 2 例（分支 `feat/0.1.104-multi-subsystem-batch`，未提交）。

## 零、为什么单独立一篇

[IMPL-RPT-015] 修复记录时间线收录的是 **P0/P1 硬故障**（宿主终端被破坏、网关断链、认证污染）——
「什么坏了、什么时候修」的导航页。但项目里还有另一类 bug，**用户能明显感觉到「不对」，可代码里找不到报错**：

- 某个功能**在 TUI 里有、在经典 REPL 里没有**（或反过来）——同一能力两条界面实现，只富化了一条 = **漂移（drift）**。
- 底座**已经把数据/计算准备好**，却**没接到呈现侧**——看起来「做了」，实则半截 = **half-wired**。
- 呈现的内容**是过时假值或空洞提示**，与真实状态矛盾 = **幽灵显示 / hollow hint**。

这类 bug 的价值在于**根因定位法**与**修复套路可复用**。本篇按「现象 / 根因 / 方案 / 教训」四段记录，
供后续遇到同型问题时对照。

```svg
<svg viewBox="0 0 700 200" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="12.5">
  <text x="350" y="22" text-anchor="middle" fill="#1f2328" font-size="13" font-weight="800">同一能力 · 两条界面实现</text>

  <rect x="40" y="44" width="260" height="60" rx="10" fill="#eff4ff" stroke="#2563eb"/>
  <text x="170" y="68" text-anchor="middle" fill="#2563eb" font-weight="700">TUI（ink）</text>
  <text x="170" y="88" text-anchor="middle" fill="#374151" font-size="11">已富化：role:qa 持久回显 ✓</text>

  <rect x="400" y="44" width="260" height="60" rx="10" fill="#fff" stroke="#e5e7eb"/>
  <text x="530" y="68" text-anchor="middle" fill="#6b7280" font-weight="700">经典 REPL</text>
  <text x="530" y="88" text-anchor="middle" fill="#b91c1c" font-size="11">未接：选完即消失 ✗（drift）</text>

  <rect x="150" y="132" width="400" height="46" rx="8" fill="#fff7ed" stroke="#f59e0b"/>
  <text x="350" y="151" text-anchor="middle" fill="#92400e" font-size="11" font-weight="700">漂移 = 只富化了一侧</text>
  <text x="350" y="168" text-anchor="middle" fill="#92400e" font-size="10.5">修复：给缺席那侧补上（不动已工作的一侧）</text>

  <line x1="170" y1="104" x2="300" y2="132" stroke="#cbd5e1"/>
  <line x1="530" y1="104" x2="400" y2="132" stroke="#cbd5e1"/>
</svg>
```

---

## 一、AskUserQuestion 答完即消失（TUI vs 经典 REPL 漂移）

### 现象

用户在 khy 里回答 AskUserQuestion 弹出的问题，**选完选项后问题和答案就一起消失了**；
希望像 Claude Code 那样**保留显示「用户给出的答案」**，能在滚动历史里回看「问了什么、选了什么」。

### 根因（跑通完整代码路径才看清）

这是一处典型的 **TUI-vs-经典 REPL 漂移**：

- **TUI（ink）侧早已有回显**：`useQueryBridge.js` 的 `buildDecisionRecord()` 在 AskUserQuestion 结算后
  产出 `{ role:'qa', qa:[{question,choice}] }` 记录（注释原文「so the question + chosen answer stays
  visible in scrollback after the overlay clears」），由 `Transcript.js` 渲染成 `❓ 问题` / `→ 所选`。
- **经典 REPL 侧缺席**：`repl.js` 的 AskUserQuestion 分支用 `renderer.askInlineQuestion()` 收答案，
  但其 `cleanup()`（`aiRenderer.js`）在选中后 `moveCursor + clearScreenDown` **把整段菜单（含问题）
  擦除且不留任何字**，收完直接 `return {behavior:'allow'}`——**从不打印回显**。→ 选完即消失。

**关键洞察**：问「为什么消失」不能只看 REPL 分支，要**对照 TUI 有没有同款能力**。一旦发现「TUI 有 / 经典 REPL 无」，
根因就从「消失了」精确到「经典 REPL 侧从未接回显，且 cleanup 会擦掉菜单不留字」。

### 方案

经典 REPL 侧**补一条持久回显**，对齐 TUI 语义：

- 新纯叶子 `cli/qaEchoLines.js`（零 IO、门控 `KHY_QA_ECHO` 默认开）：`buildQaEchoLines(answers, env) → string[]`，
  每题两行 `  ❓ {question}` / `     → {choice}`；门控关 / 空 answers / 坏输入 → `[]`（逐字节回退「选完即消失」）。
  叶子返**明文**行，着色留调用方（同 `envInfoLines` / `themePanelLines` 惯例）。
- `repl.js` 在 `askInlineQuestion` 擦除**之后**打印该回显块（落进滚动历史，不再被清），fail-soft `try/catch`
  绝不影响 `behavior:'allow'`。

**刻意不动**：TUI 侧（已工作，改了反而造新漂移）；`cleanup` 擦除逻辑（擦交互菜单是对的，持久回显是擦除后**另打印**，两者正交）。

### 教训

1. **判缺口要跑真代码路径 + 对照另一界面**：TUI 有回显 vs 经典 REPL 无，是本仓已知的漂移家族（承刀105/106 中断标记、刀114 缓存警告孪生）。
2. **「擦除交互菜单」与「持久回显」是正交的两件事**：不要去改擦除逻辑，而是在擦除之后另打印——两者互不干扰。
3. **纯叶子返明文 + 调用方着色**：可测性（不依赖 chalk）与视觉兼得。
4. **门控默认开 + 关闭即逐字节回退**：新增可见行为永远可安全关掉。

---

## 二、网关配置按类别聚合：14 个交错 section 的 el-tabs 改造

### 现象

用户要求把网关配置里「apikey / 模型 / URL 等**类似功能按类别放在一起**，好查看使用」。
目标简单，但两个页面（管理页 `AIGateway.vue` / 用户页 `MyGateway.vue`）结构差异巨大，直接搬块风险悬殊。

### 根因（不是 bug 是**结构陷阱**）

- **用户页 `MyGateway.vue`（整洁）**：5 张卡片一条到底，可以直接用 `<el-tabs><el-tab-pane>` 把卡片搬进对应 pane。
- **管理页 `AIGateway.vue`（重灾区）**：14 个 section **按类别交错**排列（models = §3/§4/§6 中间夹着 §5；
  routing = §8(~420 行)/§10/§11b/§12；accounts = §11a/§13）。**物理搬块 = 重定位 400+ 行**，极易在
  重缩进 / 移动 el-dialog 时引入错误。

**关键洞察**：同一个诉求，两个页面**不能用同一招**。整洁页搬卡片；交错重灾页**绝不搬块**。

### 方案

- **用户页**：真 `<el-tab-pane>` 包卡片（4 个 pane）；巨型 catalog 卡（~115 行）**字节不动**，两次 edit 上下包住它，不重排内部。
- **管理页**：改用 **v-show-per-section 就地显隐**——插一条**空 pane 的 el-tabs 选择器条**（6 类，label + name 无内容），
  给**每个 section 根**加 `v-show="activeTab === '<cat>'"`。section 全部**字节留原位**，4 个 el-dialog 是模态浮层
  **无需重定位**，script 逻辑零改。scoped CSS `.gateway-tabs :deep(.el-tabs__content){display:none}` 隐藏空 pane 内容只留标签头。

**为何 `v-show` 不用 `<template v-if>`**：`v-if` 卸载非激活 section → 切 tab 丢响应式状态；el-tab-pane 默认
**非 lazy** 也是常驻 DOM。两者都保「切页不卸载数据不丢」——**绝不设 `lazy`**。（初版误写 `<template v-if>`，立即改回 el-card 根加 v-show。）

一个连带 bug：用户页 `scrollToProviderEditor()` 原本 `getElementById + scrollIntoView`，但卡片搬进未激活 pane 后
`display:none` **滚不动** → 先 `activeTab.value = 'keys'` 切页，再 `nextTick()` 后滚。

### 教训

1. **同一诉求，两页两手法**：整洁页真 pane 搬卡；交错重灾页 v-show 就地显隐（同样的 tab UX，却零搬块、零重定位弹窗、零脚本改）。
2. **保状态用 `v-show` 非 `v-if`**：`v-if` 卸载丢响应式；el-tab-pane 非 lazy 常驻——绝不设 `lazy`。
3. **el-dialog 模态浮层与 tab 无关，永不重定位**。
4. **巨型卡「上下包住字节不动」**，避免重缩进错误。
5. **卡搬进未激活 pane 后 `scrollIntoView` 失效**（`display:none` 滚不动）：需先切 tab + `nextTick`。
6. **前端纯 UX 批次无门控直接落地**（后端 pure-leaf + gate + byte-fallback 模式不适用前端）。

---

## 三、共性方法论（遇到同型 bug 先问这几句）

从上面两例（及历史漂移家族）抽出的通用定位法：

```svg
<svg viewBox="0 0 700 170" xmlns="http://www.w3.org/2000/svg" font-family="sans-serif" font-size="12.5">
  <text x="350" y="22" text-anchor="middle" fill="#1f2328" font-size="13" font-weight="800">half-wired：算好了 · 没接上</text>

  <rect x="40" y="46" width="180" height="56" rx="10" fill="#eff4ff" stroke="#2563eb"/>
  <text x="130" y="70" text-anchor="middle" fill="#2563eb" font-weight="700">计算侧（service）</text>
  <text x="130" y="88" text-anchor="middle" fill="#374151" font-size="11">数据/结果已 live ✓</text>

  <rect x="480" y="46" width="180" height="56" rx="10" fill="#fff" stroke="#e5e7eb"/>
  <text x="570" y="70" text-anchor="middle" fill="#6b7280" font-weight="700">呈现侧（UI）</text>
  <text x="570" y="88" text-anchor="middle" fill="#b91c1c" font-size="11">从不消费它 ✗</text>

  <line x1="220" y1="74" x2="470" y2="74" stroke="#cbd5e1" stroke-width="2" stroke-dasharray="6 5"/>
  <text x="350" y="66" text-anchor="middle" fill="#b91c1c" font-size="18" font-weight="700">✂</text>
  <text x="350" y="94" text-anchor="middle" fill="#6b7280" font-size="10.5">断点 = 「看起来做了，实则半截」</text>

  <text x="350" y="138" text-anchor="middle" fill="#374151" font-size="11">定位：看 service 有没有 live 数据 · UI 有没有真的读它</text>
  <text x="350" y="156" text-anchor="middle" fill="#374151" font-size="11">修复：补一根接线（薄壳 + fail-soft），不重写计算侧</text>
</svg>
```

| 问题 | 怎么判 |
| --- | --- |
| 这功能是不是「一边有一边没有」？ | grep 特性叶子被谁 `require`；对照 TUI（`useQueryBridge`/`Transcript`）与经典 REPL（`repl.js`）两侧 |
| 呈现的是不是过时假值？ | 找呈现内容的 SSOT，看它是不是硬编码 / 与真实状态矛盾（幽灵显示） |
| 底座算好了却没接？ | 看计算侧（service）有没有 live 数据、呈现侧有没有消费它（half-wired = 算了没接） |
| 前端「按类别聚合」能不能直接搬？ | 先看目标 section 是否**按类别交错**；交错就用 v-show 就地显隐，别搬块 |

**修复套路（后端类）**：新纯叶子（零 IO + 门控默认开 + 空/关 → 逐字节回退）→ 薄壳接线（fail-soft）→ 叶子单测 + 三守卫 + 端到端。
**修复套路（前端类）**：复用现有子组件、非侵入（script 不动）、`v-show` 保状态、模态不重定位、巨型块上下包住。

---

## 四、维护约定

新增本类案例时：

1. 按「现象 / 根因 / 方案 / 教训」四段写，**根因要写清「怎么定位到的」**（跑了哪条代码路径、对照了哪一侧）。
2. 若同时是 P0/P1 硬故障，另在 [IMPL-RPT-015] 时间线补一行；本篇专收「根因隐蔽、方法可迁移」的一类。
3. 关联的纯叶子 / 组件路径写明，便于回溯。
