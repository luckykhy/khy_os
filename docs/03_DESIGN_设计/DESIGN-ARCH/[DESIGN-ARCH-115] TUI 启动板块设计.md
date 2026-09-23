# [DESIGN-ARCH-115] TUI 启动板块设计

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> **状态**：提案（未接线） · **日期**：2026-09-16 · **编号**：[DESIGN-ARCH-115] · **落点目录**：`docs/03_DESIGN_设计/`
> **板块序列**：本文是「khy TUI 按板块设计」的**第一块（启动）**。后续板块（对话 / 工具 / 权限 / 命令 / 看板…）各立文档，**不在本文范围**；本文只定义启动板块的边界、节拍、契约与验收，并确立「板块 = 一段可独立断言的用户可见生命周期」这一划分口径。
> **单一真源声明**：本文是启动板块的**结构真源**。
> 　- **不覆盖** `[DESIGN-ARCH-102]` 的 P1–P8 原则与 H1–H10 硬约束（本文只引用，不改写）；二者冲突一律以 102 为准。
> 　- **不覆盖** `services/backend/src/cli/tui/AGENTS.md` 的 CC 模式约束（§0.6 输入框无边框等）；二者冲突见 §2.2 的裁决建议。
> 　- **不替代** `[DESIGN-ARCH-079]` 的组件尺寸与配色真源，本文只改「启动期组件从哪取尺寸、何时出现」。
> **落地目标**（尚未执行，见 §9）：`services/backend/src/cli/startupBeats.js`（新增，纯叶子）、`services/backend/src/cli/tui/ink-components/BootScreen.js`（降为渲染器）、`services/backend/src/cli/repl/startupHeader.js`（共享节拍文案）、`services/backend/src/cli/tui/app.js:253-255`（C-1 裁决落地）。
> **证据基准**：全部 `文件:行号` 为 2026-09-16 实测（仓库 `D:\Portable\khy-os`，分支 `main`）。凡推测项均显式标注「【推测】」。
> **关联**：[DESIGN-ARCH-102] Khy TUI 统一规则手册 · [DESIGN-ARCH-103] TUI 终端界面重设计方案 · [DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记 · [DESIGN-ARCH-079] TUI界面设计规范 · [DESIGN-LAY-005] 仓库层级板块规范 · [DESIGN-ARCH-071] 通道选择决策矩阵 · [DESIGN-ARCH-111] 规则遵守保障机制

---

## 0. 一句话

把「从进程启动到输入框可用」从**五个各自为主的可视件**收敛成**一条单向、单调推进、可观测、可降级的节拍链**——界面只是节拍表的投影，TUI / 经典 / pre-Ink 三个渲染器消费**同一份**节拍表。

**为什么必须改**：`services/backend/src/cli/tui/AGENTS.md` §4.1 早就规定「阶段 2 异步、不阻塞交互」、§0.3 规定「冷启动 < 100ms」、§8.4 把「启动速度 < 100ms」列为最终验收项。而默认路径当前**整屏阻塞 ≥1.9s 才允许输入**，且这 1.9s 由一个**与启动无关的 git 来源探测**决定。

> **所以本板块不是「缺设计」，是「实现背离了仓库自己写下的设计」。** 本文的工作是把 §4.1 真正落地，而不是另起一套。

---

## 1. 板块边界

**「板块」的划分口径**：一段**可独立断言的用户可见生命周期**——它有明确的输入、输出、可观测的状态迁移、以及可以单独红灯的验收。

| | 内容 |
| --- | --- |
| **输入** | 启动参数、环境变量、`.khy/settings.json` 级联（用户级 / 项目级 / local / managed）、终端能力（`isTTY` / 尺寸 / 鼠标） |
| **输出** | 一个**已就绪的 REPL**：三区布局稳定、输入框可提交、网关可用、会话已恢复 |
| **负责** | 模式判定（TUI / 经典）、预检与认证、渲染引擎装载与首帧、工作区准备、网关连接、会话恢复、首帧布局 |
| **不负责** | 稳态布局与滚动、会话内容渲染、工具执行与权限审批、退出与清理 |
| **边界判据** | 「输入框第一次可以提交」是本板块的终点；此后发生的任何事都不属于本板块 |

---

## 2. 前置裁决（本文成立的前提）

有四处真源互相冲突。不裁决，启动板块无法被确定性地设计。

### 2.1 C-1 主屏 vs 备用屏 —— **已裁定：主屏**

| 方 | 主张 | 落点 |
| --- | --- | --- |
| `[DESIGN-ARCH-102]` P1 | **禁**备用屏（`?1049h`）；理由：Gemini CLI 上线 alt-mode 后一周内回滚，Amp 被批「find 找不到屏外文本」；alt mode 破坏选择 / 原生滚动 / 搜索三个终端核心能力 | 原则级 |
| `tui/app.js:253-255` | Legacy 路径 `KHY_ALT_SCREEN` **默认 `1` → 进备用屏**；CC 模式默认 `0` | 实现 |
| `tui/AGENTS.md` §0.9.2 | 以「本 TUI 跑在备用缓冲区，没有回滚缓冲」为**前提**论证帧高约束与滚轮接管 | 约束 |
| `tui/app.js:6133-6137` 注释 | 「本 TUI 跑在备用缓冲区，没有回滚缓冲，<Static> 写进去的行一旦滚出视口就永久消失」→ 转录改走应用内 Viewport | 实现 |

**裁决（2026-09-16，维护者拍板）**：**Legacy 也改默认主屏**，`KHY_ALT_SCREEN=1` 转为 **opt-in**。

**连带影响（必须同批改，否则留下新矛盾）**：

1. **A 区（滚动区）恢复成立** —— 三区模型在默认路径上物理可得，本文 §5.1 的「banner 只落一次」才有落点。
2. **`tui/startupAnchor.js` 恢复默认开** —— 它存在的全部理由是「把 shell 已有输出推进原生回滚」与「消除登录行与 banner 之间的空白」（`startupAnchor.js:5-11`）。备屏下原生回滚不可见，该理由失效；主屏下理由重新成立，`KHY_TUI_ANCHOR_BOTTOM` 的默认应翻转为开。
3. **`KHY_INLINE_TRANSCRIPT` 的前提消失** —— 它因「备屏无回滚」而改走应用内 Viewport。主屏下需重估：建议**保持开**（应用内 Viewport 已解决滚动与高度问题），但 §0.9.2 的论证文字必须改写，不能再以备屏为前提。
4. **帧高约束 H1 仍然有效** —— 主屏下超限的后果从「转录被抹」变为「触发终端整屏滚动」，仍须守住。
5. `tui/AGENTS.md` §0.9.2 / §0.9.3 与 `app.js:6133-6137` 注释**同步改写**。

> **【推测】** 此项改动会改变大量视觉与滚动行为，建议独立成一个 P0 子任务并单独验收，不与节拍链改造混在同一次提交。

### 2.2 C-2 Spinner 帧率 —— 建议 160ms（待维护者确认）

- `tui/AGENTS.md` §3.3 计时器优先级表：`Spinner 80ms`
- `[DESIGN-ARCH-102]` §5.3 C9：`帧间隔 160ms（⚠️ 非 ccTimers 的 80ms）` —— 102 已显式点出这个分歧并判 160
- 实现：`BootScreen.js:24` `const FRAME_MS = 80;` **硬编码**，违反 `tui/AGENTS.md` §3.1「计时器常量唯一来源 `utils/ccTimers` 的 `TIMING`」

**建议**：统一到 `ccTimers.TIMING.spinner.interval` 单一常量，取 **160ms**（102 是统一规则手册，优先于 CC 复刻工程约束），同步改 `tui/AGENTS.md` §3.3 与 `BootScreen.js`。

### 2.3 C-3 输入框最大高度 —— 建议取 102（待维护者确认）

- `tui/AGENTS.md` §2.1：`min(10, rows * 0.3)`
- `[DESIGN-ARCH-102]` §4.2：`clamp(floor(rows/3), 3, 10)`

**建议**：取 **102 §4.2**。理由：它有 H4（上下边框等宽）的全组合属性测试覆盖，而 §2.1 无对应断言。启动期的 chrome 账本必须用**同一个**值。

### 2.4 C-4 启动模型 —— 不是冲突，是实现背离

`AGENTS.md` §4.1 已给出正确的三阶段模型（阶段 1 <50ms 同步渲染 / 阶段 2 异步不阻塞交互 / 阶段 3 <100ms 交互就绪）。实现未遵守，见 D1–D3。**本文按 §4.1 落地，不另起模型。**

---

## 3. 现状测绘

### 3.1 五个各自为主的可视件

| # | 可视件 | 落点 | 门控 | 默认 |
| --- | --- | --- | --- | --- |
| 1 | pre-Ink 阶段行 | `cli/bootPhaseLine.js` | `KHY_BOOT_PHASE_LINE` | 开 |
| 2 | 首帧贴底 anchor | `cli/tui/startupAnchor.js`，调用 `cli/tui/app.js:228` | `KHY_TUI_ANCHOR_BOTTOM` | **关** |
| 3 | 启动加载屏 | `cli/tui/ink-components/BootScreen.js` | `KHY_BOOT_SCREEN` | 开 |
| 4 | 欢迎横幅（TUI） | `cli/tui/ink-components/WelcomeBanner.js` | 无 | 常开 |
| 5 | 启动头（经典） | `cli/repl/startupHeader.js`（含 `printBanner` 与 `KHY_CLAUDE_UI` 边框盒 + mascot 图片三分支） | `KHY_CLAUDE_UI` | 分三态 |

> **五件全部未登记**在 `[DESIGN-ARCH-102]` §5 组件目录（C1–C18）。`[DESIGN-ARCH-079]` §2.1 只有一行：`① BANNER | WelcomeBanner | 7~9 rows（启动时）→ 0（提交后变透明占位）`。**启动平面目前没有单一真源。**

### 3.2 真实执行顺序（实测）

```
khy.bat:112 → python -m khy_platform → cli.py:2436 main()
  → check_node(≥20) / ensure_bootstrap        cli.py:2586 / 2653
  → node services/backend/bin/khy.js          cli.py:2663
→ bin/khy.js main()                            khy.js:1353
  → bootPhaseLine 起                            khy.js:1362
  → init()（.env + 5 路 allSettled + dbHealth） bootstrap/init.js:48-224
  → ensureAuthenticated()                      khy.js:1943
  → setup({mode:'khy'})                        khy.js:1946
  → startRepl()                                replSession.js:315
      ├ 预热 commandAvailability/toolUseLoop    replSession.js:332-379
      ├ Ink 预加载 + App 预 require             replSession.js:382-419
      ├ LAN bridge / workspace trust / git init replSession.js:433-528
      ├ 任务清理 / checklist / 源码自愈 / onboarding  replSession.js:538-638
      └ startInkApp()                          replSession.js:671
          → loadInk() → render()               app.js:92 / 307
          → BootScreen（4 步）                  App.js:905-946
          → _bootComplete → 主 UI 挂载          App.js:6125-6127
```

### 3.3 缺陷清单（D1–D11）

| # | 缺陷 | 证据 | 后果 |
| --- | --- | --- | --- |
| **D1** | 就绪判定被 git 来源探测绑架 | `App.js:930-946`：`markSession` **只由 `setTimeout(markSession,1500)` 触发**；注释称 `bannerUpdateLine` 是信号，但它只是**依赖项**（effect 重跑 = 重置计时器，不触发完成）。而 `bannerUpdateLine` 来自 `App.js:502-516` 的 `getSourceProvenanceAsync()`（git 来源探测） | 启动时长不可预测，且由无关功能决定 |
| **D2** | boot 期输入框**不存在** | `App.js:6125-6127` `if (_bootScreenEl) return _bootScreenEl;` —— 主 UI（含 `PromptFrame`）整棵不挂载 | 固定 ≥1.9s 不可输入，违反 `AGENTS.md` §4.1 / §0.3 |
| **D3** | 4 步里 2 步是空壳 | `ready` 无任何对应代码（`App.js:939` `setTimeout(setBootComplete,400)`）；`session` = 1.5s 超时。`BootScreen.js:26-31` 的 `STEPS` 是常量，与真实工作顺序不符 | 进度显示与实际不符 |
| **D4** | pre-mount 的 8 件事用户看不到 | `replSession.js:332-638`（预热 / workspace trust / git init / 任务清理 / checklist / 源码自愈 / onboarding / skill sync）全在 Ink 出现**之前** | 真实工作零可见性 |
| **D5** | 双 logo | `BootScreen.js:95-101` 5 行 ASCII 四叶草 + `WelcomeBanner.js:32-56` 13×9 三色像素四叶草，同屏先后出现 | 品牌符号重复且风格不统一 |
| **D6** | 宽度失明 | `BootScreen.js:118` `'─'.repeat(14)` 硬编码；`WelcomeBanner.js:181` 左列 + `marginLeft:4` + 13 列图案无宽度感知；`WelcomeBanner.js:148` 的 `process.cwd()` 行长不可控 | 80 列下折行 |
| **D7** | 组件未登记 | 启动平面五件全不在 `102 §5`（C1–C18） | 无单一真源 |
| **D8** | 零测试覆盖 | `BootScreen` / `createBootTracker` / `_bootComplete` 全仓 grep 无命中（`startupAnchor` 有测试） | 回归无锁 |
| **D9** | 无失败态 | `BootScreen.js:69-91` 只有 `done` / `active` / `pending`，**无 failed** | 出错要么静默取默认，要么直接 exit(1) |
| **D10** | 帧率常量硬编码 | `BootScreen.js:24` `FRAME_MS=80`，违反 `tui/AGENTS.md` §3.1 | 与 C-2 叠加 |
| **D11** | 门控超标 | `check:tui-gates` 实测 `tui/` 子树唯一 `KHY_*` = **216**（上限常量 212）→ 当前 FAIL；H7 目标 ≤40 | CI 红灯 |

---

## 4. 目标架构：节拍链

### 4.1 节拍表（六拍 + 就绪）

| 拍 | id | 真实工作 | 确定性完成信号 | critical |
| --- | --- | --- | --- | --- |
| 1 | `env` | `.env` 加载、settings 级联、`init()` 五路、dbHealth | `init()` resolve | ✅ |
| 2 | `auth` | `ensureAuthenticated()` | 认证态确定（含失败） | ✅ |
| 3 | `render` | Ink 装载、首帧 commit、anchor | 首帧 effect 触发 | ✅ |
| 4 | `workspace` | 命令可用性预热、workspace trust、git init | 各 promise settle | ❌ |
| 5 | `gateway` | `gateway.init()`、适配器就绪、skill sync | adapter 数确定 | ❌ |
| 6 | `session` | 会话恢复、banner 数据、onboarding | 会话态确定 | ❌ |

**「就绪」不是第 7 拍，而是第 6 拍完成后的**一次原子重绘**（见 §4.3）。**

### 4.2 节拍契约（硬规则）

1. **每拍必须有真实工作负载** —— 禁止时长驱动的空壳拍（修 D3）。没有对应工作的拍直接删掉。
2. **完成信号必须是本拍自己的 resolve** —— **禁止引用其它功能的副作用**（修 D1）。跨拍引用一律视为违规。
3. **就绪 = 最后一拍完成**。超时只用于**降级并告知用户**，绝不用来判定完成。
4. **单调推进** —— 状态只允许 `pending → active → done|failed`，不可回退。
5. **非 critical 拍失败 = 降级 + `⚠`**，继续推进；critical 拍失败 = 阻断退出（§6）。
6. **首帧已完成的拍直接显示为 `✓`** —— 节拍表支持「预热起点」，避免首屏出现「已完成的工作还在转圈」。

### 4.3 两个渲染层与原子交接

启动板块横跨两个渲染层，**层间交接是当前最脆弱处**（阶段行残留、贴底抖动、banner 顺序）。

```
L1  pre-Ink   行内阶段行（cli/bootPhaseLine.js，\r\x1b[K 覆写，用完即抹）
       │
       ├── 交接（必须原子一次写入）：清阶段行 → anchor → Ink 首帧
       │
L2  post-Ink  B 区节拍表（行数恒定 6）+ C 区常驻输入框
```

**交接硬规则**：清阶段行 + 写 anchor + Ink 首帧必须**一次写入**，禁止分步。分会产生「阶段行残影 + 首帧抖动」，是 D 类缺陷的高发区。

---

## 5. 视觉规范

### 5.1 首屏三区（启动期）

```
┌─ A 区 · 滚动区（只写不读）────────────────────────────────┐
│  ℹ 已登录 tester                                          │
│  （启动前 shell 输出原样保留；就绪后 banner 只落一次）      │
├─ B 区 · 节拍表（行数恒定 6）──────────────────────────────┤
│  启动中 · 3/6 · 1.2s                                      │
│  ✓ 环境与配置   本地设置 + 5 路初始化                      │
│  ✓ 认证         已登录 tester                              │
│  ◐ 渲染引擎     Ink 首帧                                   │
│  · 工作区       等待                                       │
│  · 网关         等待                                       │
│  · 会话         等待                                       │
├─ C 区 · 固定框架（首帧即存在）────────────────────────────┤
│  ╭────────────────────────────────────────────────────╮   │
│  │ ❯ 可以直接打字，回车排队，就绪后自动发送              │   │
│  ╰────────────────────────────────────────────────────╯   │
│  Khy · ~/khy-os · auto::auto · 启动中 3/6                  │
└───────────────────────────────────────────────────────────┘
```

### 5.2 硬规则

| 规则 | 内容 | 依据 |
| --- | --- | --- |
| **S1 节拍表行数恒定 6** | 从首帧就画全部六行，状态 `· → ◐ → ✓` 原地变化；**绝不 0→N 追加** | P7 高度恒定 |
| **S2 C 区首帧即存在** | 输入框从第一帧就在，未就绪态**接受输入并缓冲**（回车不提交，显示「就绪后自动发送」）；禁止整树切换 | P7 / 修 D2 |
| **S3 启动期禁用覆盖层交互** | 补全菜单、`Ctrl+R`、`Ctrl+P`、`↑↓` 历史浏览在启动期一律不激活；只收纯文本 | H10 / 可预测性 |
| **S4 只有一张 logo** | 删除 `BootScreen` 的 ASCII 四叶草；logo 归 `WelcomeBanner`，就绪后落入 A 区一次 | 修 D5 |
| **S5 `更新：` 行移出关键路径** | banner 先印且不含该行；provenance 探测结果改由 `Ctrl+O` 呈现，**绝不回头重印 banner** | 修 D1 根因 / P2 只写不读 |
| **S6 就绪是一次原子重绘** | B 区节拍表退场 + C 区转就绪态 + A 区落 banner，同帧完成 | P5 一个尺寸 = 一次重绘 |
| **S7 帧高 ≤ `rows − 1`** | 启动期同样受 H1 约束，chrome 走 `chromeBudget` 单一账本 | H1 |
| **S8 零 `ESC[2J` / `ESC[3J`** | 启动期同样受 H2 约束 | H2 |

### 5.3 宽度与截断

- 宽度一律由 App 通过 `contentWidth()` 下发 props；**组件内仍禁止读 `process.stdout.columns/rows`**（守 H8）。
- `WelcomeBanner` 的 `showArt` 由 App 按 `contentWidth()` 决定：`< 80` 列**隐藏右侧图案**（单列布局），`≥ 120` 列并排。
- `WelcomeBanner.js:148` 的 `工作目录` 行改用 `~` 缩写 + 按**显示宽度**截断（与 `wrapCell()` / `visualRows()` 同源，守 H6），**绝不折行**——banner 落在 A 区，折行会破坏行数恒定的假设。

### 5.4 双 logo 收敛（2026-09-23 修订）

删除 `BootScreen.js:95-101` 的 5 行 ASCII 四叶草与 `BootScreen.js:118` 的 `'─'.repeat(14)` 分隔线 —— **这条照旧成立**：`╱╲` 只画出两叶、读不出「四叶」，注释自称 clover 名不副实，本就是两套风格里该淘汰的那套。

> **【2026-09-23 修订】** 原措辞「logo 归 `WelcomeBanner`，`BootScreen` 不再承担品牌展示」改判为
> **「只有一份 logo 资产，启动屏与欢迎横幅共用它」**（落点 `cli/tui/logoArt.js`）。
> 修订理由：S4 要修的是 D5 的「两种**风格**」，不是「两处**出现**」；启动屏是用户看到的第一屏，
> 纯文字清单零品牌识别，而紧随其后的欢迎横幅立刻有 —— 视觉上是断的。视觉契约与阶梯见
> `[DESIGN-ARCH-134] TUI 启动屏视觉重设计` §2.6 / §3.4，组件登记 `[DESIGN-ARCH-102]` §5.6 C22。

---

## 6. 失败态与降级

节拍失败后按 `critical` 二分（现无此能力，修 D9）：

```
                    ┌─ critical: true  ──→ ✗ 红标 + 1 行可操作指引
                    │                      → Ink 卸载，指引留在主屏 → 非零退出
节拍失败 ───────────┤
                    │                      ⚠ 黄标，继续推进
                    └─ critical: false ──→ → 底部汇总「! N 项降级，Ctrl+O 查看」
```

- **阻断类**：指引必须是**一行可执行的下一步**（如 `运行 khy login 后重试`），**不是堆栈**。Ink 卸载后指引须留在终端可见（守 P1 主屏优先）。
- **降级类**：黄标继续推进，不阻塞交互；底部恒定 1 行汇总（守 H10 单槽瞬时信息只有一条）。

---

## 7. 门控策略（净新增 0 个）

扩展既有 `KHY_BOOT_SCREEN` 的**取值**，不新增 token（守 H7 与 `102 §3 H7`「新增用户偏好一律进 `tui.json`，不再新增环境变量」）：

| 取值 | 行为 |
| --- | --- |
| `1` / 默认 | 新节拍表（本文设计） |
| `0` | 直接进主 UI（与今天关掉的行为逐字节一致） |
| `legacy` | 旧 `BootScreen` 逐字节回退（保留**一个版本**的回退窗，满足 `tui/AGENTS.md` §0.1 零破坏原则），下版本删除 |

**迁出**到 `~/.khy/tui.json` 的 `startup.*` 段（env 优先、settings 兜底，登记 sunset 版本）：
`KHY_WORKSPACE_TRUST`、`KHY_AUTO_GIT_INIT`、`KHY_TASK_CLEANUP`、`KHY_SESSION_TODO_RESET`、`KHY_SOURCE_HEAL`、`KHY_ONBOARDING`、`KHY_SKILL_VERSION_SYNC`、`KHY_BRIDGE_AUTOSTART`、`KHY_SESSION_WATCHDOG`、`KHY_STARTUP_MODEL_PICKER`。

**翻转**：`KHY_TUI_ANCHOR_BOTTOM` 默认由**关**改为**开**（C-1 裁决的连带项，§2.1 第 2 条）。

---

## 8. 经典模式与 TUI 的一致性

沿用 `[DESIGN-ARCH-110]` 已建立的 `uiFacade` / `uiAdapter` 模式：**命令处理器返回结构化响应，UI 适配器按模式渲染**。启动板块照此办理——

- **一份节拍表**（`startupBeats.js`）+ **两个渲染器**（`startupBeats` 的 TUI 渲染器 / 经典渲染器）。
- **节拍文案（label）是单一真源**，由 `startupBeats.js` 导出；`startupHeader.js` 不再自带文案（消除 TUI 与经典漂移）。
- 经典模式的三个分支（`printBanner` / `KHY_CLAUDE_UI` 边框盒 / mascot 图片）**保持三个渲染器**，但消费同一份节拍状态。

---

## 9. 落地路线与代码落点

| 阶段 | 内容 | 对应缺陷 |
| --- | --- | --- |
| **P0 正确性**（不改视觉） | ① 修 D1：完成信号解绑 provenance；② 修 D2：C 区常驻；③ 修 D3：真实拍 + 确定性信号；④ 修 D7：登记组件；⑤ 修 D8：补测试 | D1 D2 D3 D7 D8 |
| **P1 视觉统一** | ① 修 D5：删第二个 logo；② 修 D6：宽度感知 / 显示宽度截断；③ 修 D10：帧率入 `ccTimers` | D5 D6 D10 |
| **P2 收编** | ① 修 D4：pre-mount 八件事进节拍表；② 修 D9：失败态；③ 修 D11：门控迁 `tui.json` | D4 D9 D11 |
| **P0' 独立子任务** | C-1 主屏切换 + 连带五处改写（§2.1） | —— |

**代码落点**：

| 文件 | 动作 | 说明 |
| --- | --- | --- |
| `services/backend/src/cli/startupBeats.js` | **新增** | 纯叶子：节拍表定义 + 状态机 + 完成判据。**零 IO**，可单测。与 `cli/bootPhaseLine.js` / `cli/startupProfiler.js` 同级 |
| `services/backend/src/cli/tui/ink-components/BootScreen.js` | 改造 | 降为**渲染器**，消费 `startupBeats`，不再自带 `STEPS` 常量 |
| `services/backend/src/cli/repl/startupHeader.js` | 改造 | 经典渲染器，共享 `startupBeats` 的 label |
| `services/backend/src/cli/replSession.js:332-638` | 改造 | 各 pre-mount 步骤改调 `beats.done(id)` 上报 |
| `services/backend/src/cli/tui/app.js:253-255` | 改造 | C-1 默认翻转 |

> **登记义务**：按 `[DESIGN-LAY-005]` §4，新增文件须登记进 `packaging/modules/modules.json` 的 **`khy-ai`** 板块（`handlers` / `services` 数组）。漏登记的后果是模块化构建产物缺功能，而全量构建正常——**开发期不会暴露**。

---

## 10. 验收（可机器验证）

| # | 判据 | 怎么测 |
| --- | --- | --- |
| 1 | 首帧即三区，帧高 ≤ `rows − 1` | 复用 H1 属性测试 |
| 2 | 启动期 B 区行数**恒定 6**，不随推进变化 | 逐帧快照比对 |
| 3 | 「最后一拍完成」→「输入框可提交」之间 ≤ **1 次**原子重绘 | 渲染字节计数 |
| 4 | **注入 3s 延迟的 provenance mock，就绪时刻不变** | 回归测试（锁死 D1） |
| 5 | 全启动期零 `ESC[2J` / `ESC[3J` | 复用 H2 门 |
| 6 | A 区启动期写入 ≤ 1 次，1000 帧内字节不变 | 复用 P2 判据 |
| 7 | 启动期按键 `/`、`Ctrl+R`、`Ctrl+P`、`↑` 逐条断言**无覆盖层**出现 | 键序列测试 |
| 8 | mock 认证失败 → 恰好 1 行指引 + 非零退出码，且指引在 Ink 卸载后仍可见 | 端到端测试 |
| 9 | `BootScreen` 单测覆盖 `pending → active → done → failed` 全迁移 | `npm run test:one -- <path>` |
| 10 | 启动板块 **net-new `KHY_*` = 0**，`check:tui-gates` 计数不上升 | `npm run check:tui-gates` |

---

## 11. 不采纳清单（附理由）

| 不采纳 | 理由 |
| --- | --- |
| 备用屏全屏启动动画 | 违反 P1（Gemini CLI 一周回滚的前车之鉴） |
| 就绪后清屏重绘 | 违反 H2；清屏会被用户强烈反弹 |
| 把启动做成独立 React 根组件 | 会变成**第三条**根路径，违反 P8「一条路径胜过两条」 |
| 新增 `KHY_*` 门控 | 违反 H7；现状 216 已严重超标 |
| logo 动画 / 跑马灯 | 帧率与残影成本，收益为负 |
| 节拍表做成可滚动列表 | 违反 P3 高度恒定 |
| 用超时判定完成 | D1 的根因；超时只能用于降级 |

---

## 12. 交叉引用与遗留

**遗留问题（本文不解决，登记待办）**：

1. **C-2 / C-3 待维护者确认**（§2.2 / §2.3）。
2. **`tui/AGENTS.md` 与 `[DESIGN-ARCH-102]` 的冲突不止本文列出的三处**（帧率、输入框高度、备用屏）。二者没有声明真源优先级，建议专开一轮把「统一规则手册 vs CC 复刻工程约束」的适用范围划清——否则每做一个板块都要重新裁一次。
3. **D11 门控 216 → ≤40** 是独立一轮的清理工作，本文只保证「不新增」。

**关联文档**：

- 规则真源：`[DESIGN-ARCH-102] Khy TUI 统一规则手册`（P1–P8 / H1–H10 / §4 布局 / §5 组件目录）
- 渲染架构论证：`[DESIGN-ARCH-103] TUI 终端界面重设计方案`
- 双模式同步：`[DESIGN-ARCH-110] TUI-CLASSIC-SYNC 设计笔记`
- 组件尺寸与配色真源：`[DESIGN-ARCH-079] TUI界面设计规范`
- 板块与登记义务：`[DESIGN-LAY-005] 仓库层级板块规范` §4
- CC 模式约束：`services/backend/src/cli/tui/AGENTS.md`（§0.1 零破坏 / §0.3 性能底线 / §3 计时器 / §4.1 启动阶段）

---

## 13. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-09-16 | 初版。确立板块边界与划分口径；裁决 C-1（主屏，已拍板）、建议 C-2/C-3；登记 D1–D11 实测缺陷；给出六拍节拍表与契约、视觉硬规则 S1–S8、失败态二分、门控净新增 0 策略、P0/P0'/P1/P2 路线与 10 条验收 |
| 2026-09-23 | §5.4 修订：S4 的「logo 归 WelcomeBanner、启动屏不承担品牌展示」改判为「只有一份 logo **资产**，启动屏与欢迎横幅共用」（`cli/tui/logoArt.js`）。删除 `╱╲` 图案与 `'─'.repeat(14)` 的决定不变。见 `[DESIGN-ARCH-134]` §2.6 |
