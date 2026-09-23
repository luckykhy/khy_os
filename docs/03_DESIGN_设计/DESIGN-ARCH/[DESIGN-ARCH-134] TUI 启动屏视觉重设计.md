# [DESIGN-ARCH-134] TUI 启动屏视觉重设计

> **隶属**：本文属 **TUI 设计族**（总纲 `[DESIGN-ARCH-122]`）；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。
> **状态**：**P0 已实施（2026-09-23，45/45 绿）** · **日期**：2026-09-23 · **编号**：[DESIGN-ARCH-134] · **落点目录**：`docs/03_DESIGN_设计/`
> **单一真源声明**：本文只改**启动屏的视觉呈现**（水平居中 / 进度表达 / 品牌资产）。**不覆盖** `[DESIGN-ARCH-115]` 的节拍表与节拍契约（六拍定义、完成信号、就绪判据、失败态二分）——本文是它的**渲染侧**，只消费 `startupBeats` 已有状态，不新增拍、不改判据。与 `[DESIGN-ARCH-115]` §5.4 的 **S4 冲突一处**，处置见 §2.6 与 §3.4。
> **证据基准**：2026-09-23 实测，仓库 `D:\Portable\khy-os`，分支 `chore/tui-ux-nightly`。凡推测项显式标注「【推测】」。
> **关联**：`[DESIGN-ARCH-115]` TUI 启动板块设计 · `[DESIGN-ARCH-102]` Khy TUI 统一规则手册 · `[DESIGN-ARCH-103]` TUI 终端界面重设计方案 · `[DESIGN-ARCH-122]` TUI 设计族总纲 · `[DESIGN-ARCH-079]` TUI界面设计规范 · `[DESIGN-ARCH-129]` TUI 滚动-选择-历史-固定底部共存设计 · `[DESIGN-ARCH-081]` 环境变量门控策略

---

## 0. 一句话

把启动屏从「贴终端左边缘的一列字」改成「屏幕内**水平居中**的一张启动卡」：**品牌**（四叶草 + 字标 + 一句话）+ **进度**（条形 / N 拍 / 耗时）+ **六拍明细**，全部信息真实可得，**零新增 env、零新增门控**，改动面收敛到 3 个文件 + App 一行 props 下发。

**为什么必须改**：`[DESIGN-ARCH-115]` 把启动板块的**状态与节拍**设计到位并已落地（`startupBeats.js` 已接线、17+8 条测试在用），但**视觉面从未定稿**——它只写了 S1–S8 八条硬规则，其中「居中」「进度条」「品牌资产」都不在规则里；结果是实现停在「能显示状态」这一层，用户看到的就是贴左边缘的一列字（截图实证）。

---

## 1. 现状实证

### 1.1 病灶表（B1–B7，file:line 可复核）

| # | 病灶 | 证据 | 用户可见后果 |
| --- | --- | --- | --- |
| **B1** | 整块贴在终端**左上角** | `BootScreen.js:132-138` 根 Box 只有 `paddingX:2 / paddingY:1`，**无 `alignItems`**；而 ink 根节点宽度被硬设为终端列数（`node_modules/ink/build/ink.js:242` `rootNode.yogaNode.setWidth(terminalWidth)`）⇒ 竖排容器的子 Box 默认 stretch 满宽 ⇒ 内容左对齐 | 右侧与下方大片空白（截图实证） |
| **B2** | **零进度表达** | `startupBeats.js:190-197` 的 `progress()` 早就返回 `{done,total,ready,elapsedMs}`；`BootScreen.js` 全文**无一处调用它** | 用户不知道还剩多少、等了多久 |
| **B3** | **三枚品牌标记并存**，且启动屏用的那枚最简陋 | ① `BootScreen.js:120-126`（`╱╲` 双菱形，注释自称 clover 却只画出**两叶**）② `WelcomeBanner.js:32-56`（13×9 像素四叶草，三档绿，注释同为「khyos lucky clover」）③ `CcLogo.js:22-33`（`✳ Khy` + tagline，品牌字来自 `utils/ccBrand.js:15`） | 同一进程内三种品牌样子 |
| **B4** | 分隔线宽度硬编码 | `BootScreen.js:141` `'─'.repeat(14)` | 窄/宽终端都不对齐（`[DESIGN-ARCH-115]` D6） |
| **B5** | 帧内信息量近乎为零 | 无版本、无耗时、无「当前在做什么」；`step.note` 仅在 `fail()` 时才有值（`BootScreen.js:105`） | 首屏只证明「进程活着」 |
| **B6** | **零测试覆盖** | `services/backend/tests/**` 内只有 `cli/startupBeats.test.js`(17) 与 `cli/tui/startupBeatsWiring.test.js`(8)，**无 BootScreen 用例**（`[DESIGN-ARCH-115]` D8 仍未闭合） | 视觉回归无锁 |
| **B7** | 同一进程内三种产品写法 | 启动屏 `khy-os`（`BootScreen.js:125`）· 欢迎横幅 `khy OS`（`WelcomeBanner.js:117`）· CC 品牌 `Khy`（`ccBrand.js:13`） | 品牌名漂移 |

> **B3 的裁决依据**：CC 模式是**预览态且默认关闭**——`utils/ccMode.js:53-55` `isCcMode()` 只在 `KHY_CC_TUI === '1'` 时为真，文件头 `:9-19` 明写「CC 模式当前是**预览态**（preview）」。因此 `✳ Khy` 只服务一条非默认路径；**默认主路径的品牌资产是欢迎横幅那枚像素四叶草**（`App.js:5924-5935` 的 `_bannerShowArt` 负责在 ≥80 列时渲染它）。

### 1.2 门禁与测试基线（实测，不得凭印象）

| 对象 | 实测值 | 说明 |
| --- | --- | --- |
| `tests/cli/startupBeats.test.js` | `# tests 17 / pass 17 / fail 0` | 本设计必须保持全绿 |
| `tests/cli/tui/startupBeatsWiring.test.js` | `# tests 8 / pass 8 / fail 0` | 同上 |
| `tests/tui/liveFrameGeometry.test.js` | `# tests 1 / pass 0 / fail 1` | **改动前就已红**（他人未提交的新文件 `??`，用 jest 全局 `describe/test` 写在 `tests/tui/` 下，被 `test:node` 的 glob 扫到） |
| `npm run check:tui-gates` | `FAIL — 226 unique KHY_* tokens (limit 220)` | **改动前就已红**；`scripts/ci/check-tui-gates.js:32` `MAX_GATES = 220`，注释写明「only moves DOWN」 |
| CI 测试选择范围 | `services/backend/package.json:59` `test:node = node --test tests/**/*.test.js`，被 `.github/workflows/pr-gate.yml` 调用 | ⇒ **新增测试必须落地即绿**，本设计不采纳「先落一条红探针」 |
| ink 真帧套件 | `services/backend/scripts/run-ink-tui-tests.js` 存在（`test:tui` = jest `tests/tui`）；其 `:15` 声称「Used by …the CI 'Ink TUI' job」，但 `.github/workflows/` 内**不存在该 job** | ink TUI 套件当前**零 CI 覆盖**；见 §8 |

### 1.3 与并行会话的冲突面（动工前必看）

| 文件 | 本次动作 | 是否正被他人改 |
| --- | --- | --- |
| `cli/tui/ink-components/BootScreen.js` | **重写渲染** | ✅ 干净（不在 git porcelain 里） |
| `cli/tui/ink-components/WelcomeBanner.js` | 改 require 共享资产 | ✅ 干净 |
| `cli/tui/ink-components/ProgressBar.js` | **只 import，不改** | ⚠️ **在 porcelain 里**（` M`） |
| `cli/tui/ink-components/App.js` | **加 1 行 props 下发** | ⚠️ **在 porcelain 里**（` M`），且是 6800 行巨石 |

> 本次实测 porcelain = **539 条**，其中 `services/backend/src/cli/tui/**` 约 40 个文件被他人修改。**投放顺序建议**：先落 `logoArt.js` + `bootLayout.js` + BootScreen/WelcomeBanner（互不冲突），`App.js` 那一行**等 `chore/tui-ux-nightly` 收工后再打**。

---

## 2. 借鉴提案

### 2.0 B-P1 豁免判定：**不成立**

`[DESIGN-SOURCING-001]` §3 B-P1 的豁免判据是「该能力域已在注册表中存在且有 `canonical` 路径」。启动平面**未登记**——`[DESIGN-ARCH-115]` §3.1 明写「启动平面五件全不在 `[DESIGN-ARCH-102]` §5 组件目录（C1–C18）」（即该文档的 D7）。

⇒ **本文就是补上 D7 的那份提案**，不能走豁免。处置见 §4 P0 的第 5 项（登记义务）。

### 【借鉴提案 P-00】不适用 —— 仓内组件重设计，无外部上游

按 B-P2 体例逐项据实声明，不留空：

1. **借鉴对象**：不适用。本次不借鉴任何外部项目，无上游名、无版本/commit 可填。
2. **借鉴内容**：不适用。视觉形态（居中 + 进度 + 品牌块）是本仓既有组件的**重组**，不引入外部结论/结构/行为/测试。
3. **解决的问题**：不适用（此项仅在存在上游时才有意义）。本仓自身缺口见 §1.1 B1–B7。
4. **许可证与代码性质**：不适用。**不引入任何上游代码、二进制或资源**；全部素材来自本仓现有文件（`WelcomeBanner.js:32-56` 的四叶草、`ProgressBar.js` 的进度条、`BootScreen.js` 的节拍渲染）。
5. **借鉴方式**：不适用。若要归类，形态是**仓内复用（canonical 扩展）**：把 `WelcomeBanner` 私有的四叶草提成共享资产、把 `ProgressBar` 提成启动屏的进度源，**不新增并行实现**。
6. **落点与现有实现对比**：
   - a. **落点**：`services/backend/src/cli/tui/logoArt.js`（新增，共享品牌资产）· `services/backend/src/cli/tui/bootLayout.js`（新增，纯叶子阶梯）· `cli/tui/ink-components/BootScreen.js`（改造）· `cli/tui/ink-components/WelcomeBanner.js`（改为 require 共享资产）。
   - b. **现有同类实现**：已搜过的词与目录 —— 在 `services/backend/src/cli/tui/` 下搜 `BootScreen` / `WelcomeBanner` / `ProgressBar` / `CcLogo` / `logo`（`Glob **/*Logo*` 命中 `CcLogo.js` 唯一），在 `apps/khyos-desktop/` 下搜 `*{logo,Logo}*.{svg,png,ico,tsx,ts}`（无命中，仅 `public/icon.ico` 等二进制）。结论：**TUI 侧无居中版品牌组件可复用**（`CcLogo.js:24` 的 `alignItems:'center'` 是唯一既有居中实现，但它绑 CC 主题与 CC 品牌字符串，见 B3 裁决），故本次是**提取既有资产**而非新增第二份。
7. **验收方式**：见 §7；一条命令是 `node --test services/backend/tests/cli/tui/bootLayout.test.js`。

### 2.6 与 `[DESIGN-ARCH-115]` §5.4 S4 的冲突与处置

| 方 | 原文 | 冲突点 |
| --- | --- | --- |
| `[DESIGN-ARCH-115]` §5.4（S4） | 「**只有一张 logo**。删除 `BootScreen` 的 ASCII 四叶草；**logo 归 `WelcomeBanner`**，就绪后落入 A 区一次」 | 字面禁止启动屏出现 logo |
| 本文 | 启动屏**要有**品牌块 | 直接冲突 |

**处置（推定，需维护者确认）**：S4 的**意图**是「不得有两种风格的品牌符号」（修它的 D5），而**措辞**被写成了「启动屏不得有 logo」。

- 启动屏是用户看到的**第一屏**；一个 1–2 秒的纯文字清单没有任何品牌识别，而紧随其后的欢迎横幅立刻有 —— 视觉上是断的。
- 本次让两处**共用同一资产**（`logoArt.js` 一份 13×9 像素四叶草），比 S4 原措辞更贴近「只有一张 logo」的本意。
- ⇒ 建议把 S4 措辞修订为「**只有一份 logo 资产**；启动屏与欢迎横幅共用它」。**修订 `[DESIGN-ARCH-115]` 属独立动作**，本文不代改；在 §8 登记为待确认项。

---

## 3. 目标形态（组件级契约）

### 3.1 布局树

```
Box  flexDirection=column  alignItems=center  paddingX=2  paddingY=1     ← 唯一新增的居中属性
 ├ Box flexDirection=column alignItems=flex-start      ← 品牌块（整块居中，内部左齐）
 │   ├ 四叶草 9 行（13 列 × 9 行，三档绿）              ← 来自 logoArt.js
 │   ├ 字标 `khy OS`（bold, green）
 │   └ tagline `AI-powered coding assistant`（dim）
 ├ Text ''                                              ← 空行
 ├ ProgressBar kind='count'                             ← 进度行（自带 marginY 1×2）
 ├ Box flexDirection=column alignItems=flex-start      ← 节拍块（整块居中，内部左齐）
 │   ├ 六拍行 × 6（`✓ 环境与配置` / `⠹ 渲染引擎` / `· 工作区` …）
 │   └ 尾部汇总行（0 或 1 行：阻断红 / `! N 项降级`）
 └ Text ''
```

### 3.2 居中机制 —— **零新机制、零 props**

ink 把根节点宽度硬设为终端列数（`node_modules/ink/build/ink.js:242`）；竖排容器的子 Box 默认 `alignItems: stretch` 撑满该宽度。所以只要在 BootScreen 根 Box 上加 `alignItems: 'center'`，**水平居中即成立，不需要任何尺寸 props**。这与 `CcLogo.js:24` 已在用的手法同源。

> ⚠️ **硬规则（否则左边不齐）**：`alignItems:'center'` 是**逐个子元素**居中。若把六拍行直接作为根 Box 的子元素，**每行会各自居中**，六个 label 的左边缘就会参差。必须把「品牌块」「节拍块」各自包进一个 `alignItems:'flex-start'` 的内层 column Box，**只让内层 Box 这一层居中**。

### 3.3 进度行 —— 复用 `ProgressBar`，不写第二个进度条

```
h(ProgressBar, { kind: 'count', current: done, total: total, label: '启动中 · ' + elapsed })
```

- 渲染为 `◆ ████████████░░░░░░░░ 3/6 启动中 · 1.2s (50%)`（`ProgressBar.js:145-158`，`BAR_WIDTH = 20` 在 `:43`）。
- `done` / `total` / `elapsedMs` 全部取自 `beats.progress()`（`startupBeats.js:190-197`），**零新增状态**。
- 耗时格式化复用 `cli/bootPhaseLine.js:64-72` 的 `_elapsedMsToStr`（`320ms` / `3.2s` / `1m 04s`）——**同一份人读时长口径，不再写第二个**。
- `(50%)` 保留：它说的是**六拍里完成了三拍**，是真实值。**不得**把它改写成「时间进度」或在文案里出现「预计剩余」——见 §6 反模式 6。

### 3.4 品牌资产 —— 一份四叶草，两个渲染器

**新增 `services/backend/src/cli/tui/logoArt.js`（纯叶子）**

- 从 `WelcomeBanner.js:32-56` **原样搬出** `CLOVER_ART`（13×9 单宽 Unicode 块字符）与 `CLOVER_SHADE`（同尺寸三档映射：`D`=暗边 dim、`M`=主体、`B`=高光 `greenBright`），不重画、不改一点像素。
- 导出：`CLOVER_ART` · `CLOVER_SHADE` · `CLOVER_COLS = 13` · `CLOVER_ROWS = 9` · `shadeRows()`（把两表合成 `string[9]` 供两个渲染器消费，避免各自解析）。
- 纯叶子契约（同 `startupBeats.js` 头部纪律）：**零 IO、确定性、绝不抛、绝不读 env、不改入参**。
- `WelcomeBanner.js` 改为 `require('../../logoArt')` 并删除本地副本；`BootScreen.js` 也从它 require。
- ⇒ 满足 S4 的**意图**（一份资产），同时给启动屏品牌识别。

**字标收敛（B7）**：启动屏字标改用 **`khy OS`**，与 `WelcomeBanner.js:117` 的 `── khy OS vX.X.X ──` 同字面，不再用 `khy-os`（那是仓库目录名）。CC 品牌串 `Khy` 不动（属 `[DESIGN-ARCH-081]` 的品牌替换规范，见 §5）。

### 3.5 H1 阶梯 —— 新增 `bootLayout.js`（纯叶子）

启动屏是**没有主 UI chrome 的整屏帧**，帧高就是它自己的高度；加了品牌块后必须按 rows 分档，否则短终端会触 H1。既有 canonical 先例是 `chromeBudget.js:203-245` 的 `ccChromePlan`——同样是「按 rows 给出品牌行预算，账本与渲染同源」，本设计**照它的形状办**，不另立一套。

固定行数（与品牌块无关的部分）：

```
paddingY 1 + 空行 1 + ProgressBar 3 + 六拍 6 + 尾空行 1 + paddingY 1 = 13
frameH = 13 + brandRows + tailRows          （tail ∈ {0,1}：阻断/降级汇总行）
```

| 档 | 品牌块 | brandRows | frameH（含 tail） | 需要 rows ≥ |
| --- | --- | --- | --- | --- |
| **F 全档** | 四叶草 + 字标 + tagline | 11 | 25 | 26 |
| **G 去 tagline** | 四叶草 + 字标 | 10 | 24 | 25 |
| **H 去四叶草** | 字标 + tagline | 2 | 16 | 17 |
| **I 仅字标** | 字标 | 1 | 15 | 16 |
| **J 无品牌块** | — | 0 | 14 | 15 |

- 判据：`frameH ≤ rows − 1`（H1 的 `−1` 复用 `chromeBudget.CC_TRAILER_ROWS` 的既有口径，**不在 `bootLayout.js` 里重写 `rows - 1` 字面量**）。
- **`rows` 非法/缺失 ⇒ 取最保守的 J 档**（frameH 13–14）。这条很重要：**现状 BootScreen 的帧高是 17**（`paddingY 2 + art 5 + 空 1 + 分隔 1 + 空 1 + 六拍 6 + 尾空 1`）。J 档 13 ≤ 17 ⇒ **即使 App 没下发 `rows`，本次改动也永不比现状更差**，这是它的自动回滚语义。
- **节拍块与进度行永不降级**——它们是启动屏的本职；可降的只有装饰性的品牌块。
- 实测基线：Windows Terminal 默认 30 行 ⇒ F 档全开。

### 3.6 文案约束

| 位置 | 文案 | 来源 |
| --- | --- | --- |
| 字标 | `khy OS` | 与 `WelcomeBanner.js:117` 同字面 |
| tagline | `AI-powered coding assistant` | `utils/ccBrand.js:16` 的 `BRAND.tagline`（**复用，不再写字面量**） |
| 进度行 | `启动中 · 1.2s` | 固定词 + `_elapsedMsToStr()` |
| 六拍 label | 六个 `env/auth/render/workspace/gateway/session` | `startupBeats.js:39-46` 的 `BEATS[].label`（**单一真源，渲染器不得自带文案**） |
| 降级汇总 | `! N 项降级，Ctrl+O 查看` | 现状保留（`BootScreen.js:116`） |
| 阻断指引 | `→ <note>` | 现状保留（`BootScreen.js:114`） |

### 3.7 门控 —— **净新增 0 个**

不新增任何 `KHY_*` token。理由：`check:tui-gates` 实测 **226 / 上限 220 已 FAIL**（`check-tui-gates.js:32`，注释「only moves DOWN」），且 `[DESIGN-ARCH-102]` H7 要求「新增用户偏好一律进 `~/.khyquant/tui.json`，不再新增环境变量」。回滚能力由 §3.5 的**可选参数缺省语义**提供（`rows` 缺省 ⇒ 最保守档），不需要开关。

---

## 4. 实施分期

**P0 —— 本次落地**（全部可独立回滚）

| # | 动作 | 文件 |
| --- | --- | --- |
| 1 | 新增共享品牌资产（纯叶子） | `cli/tui/logoArt.js`（新） |
| 2 | 新增帧高阶梯（纯叶子） | `cli/tui/bootLayout.js`（新） |
| 3 | 根 Box 加 `alignItems:'center'`；品牌块 + 进度行；删 `'─'.repeat(14)`；字标改 `khy OS`；接收可选 `rows`/`cols` | `cli/tui/ink-components/BootScreen.js` |
| 4 | 改为 require 共享资产，删本地四叶草副本 | `cli/tui/ink-components/WelcomeBanner.js` |
| 5 | 下发尺寸 props（**1 行**） | `cli/tui/ink-components/App.js:5969` → `h(BootScreen.BootScreen, { key:'boot-screen', rows: _resRows, cols: _resCols })` |
| 6 | 补测试：`bootLayout.test.js` + 扩 `startupBeatsWiring.test.js` 的源码断言 | `services/backend/tests/cli/tui/` |
| 7 | **登记义务**：在 `[DESIGN-ARCH-102]` §5 组件目录补一条启动屏登记（消 D7 的本组件部分） | `docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-102] …md` |

**投放顺序**：1→2→3→4 可同批（`BootScreen.js` / `WelcomeBanner.js` 实测不在他人改动列表里，459 行以内低风险）；**第 5 项（`App.js`）等并行会话收工后再打**——它是 6800 行巨石且正在被改，混改会让回归无法归因。

**明确不做（登记为遗留，不在本期）**

| 不做 | 原因 |
| --- | --- |
| 每拍真实说明（`认证 · 已登录 mfplg075`） | 需改 `startupBeats.done(id)` 签名并接 3 处调用点（`App.js:1059/1067`、`replSession`），违反本次「零新增接线面」的取舍；且 `preload()` 路径（`App.js:1059`）本就无 note，会出现「四拍没说明、两拍有」的不一致，要做得先设计 note 的默认语义 |
| 版本号上启动屏 | 用户 2026-09-23 拍板不做；它 1 秒后由欢迎横幅给出（`WelcomeBanner.js:117`） |
| 垂直居中 | 见 §6 反模式 2，代价不可接受 |
| 修正 `run-ink-tui-tests.js:15` 声称的 CI job | 属独立问题（ink 套件零 CI 覆盖），本文只登记 |
| 把 `✳ Khy`（CC）与四叶草跨模式收敛 | 属 `[DESIGN-ARCH-081]` 的品牌替换规范，且 CC 模式定性未作出（`ccMode.js:9-19`） |

---

## 5. 诚实边界

| 边界 | 说明 |
| --- | --- |
| **不改节拍语义** | 六拍数量、完成信号、`isReady()` 判据、失败二分全部不动。本次只读 `beats` 的状态与 `progress()`。 |
| **不加任何 env / 配置键** | 见 §3.7。 |
| **不新增品牌素材** | 四叶草是 `WelcomeBanner.js:32-56` 的**原像素**搬家，不重画、不调色。tagline 复用 `BRAND.tagline`。 |
| **不写假进度** | 只有 `beats.progress()` 的真实值上屏。不出现「正在加载资源 78%」这类无来源的百分比。 |
| **小终端仍是既有状况** | `rows < 15` 时 J 档（14 行）仍可能触 H1。但**现状是 17 行**，所以这是**净改善**，不是新引入。 |
| **CC 模式的品牌串不动** | `CcLogo` 的 `✳ Khy` 保持原样；本次只统一 TUI 默认主路径（启动屏 + 欢迎横幅）。 |
| **不代改 `[DESIGN-ARCH-115]`** | §2.6 的 S4 措辞修订需维护者确认后单独动作。 |
| **CI 只保证「不红」** | 真字节几何断言需要 `--experimental-vm-modules`，CI 不带该 flag ⇒ 相关用例会 skip（见 §7 限制）。 |

---

## 6. 反模式（这条路别走）

1. ❌ **用 `height: rows-1 + justifyContent:'center'` 做垂直居中**。
   帧高被推到 `rows-1` 后，每 80ms 一次 spinner 重绘 = 近乎整屏重写；而 ink 在 `outputHeight >= stdout.rows` 时进 fullscreen 分支，下一帧走 `clearTerminal + fullStaticOutput + output`（`node_modules/ink/build/ink.js:320` 判定、`:322-327` 执行）⇒ 每帧清屏 + 全量重印。**这是 H1 的原始病灶，不要用视觉理由把它请回来。**

2. ❌ **真垂直居中（一次性 CUP 定位）**。
   ink 擦帧是相对位移（`eraseLines(lastOutputHeight)`），所以主 UI 会从**居中块顶部**开始 ⇒ **整个会话被下移半屏**，输入框停在屏幕中部 —— 这正是 `cli/tui/startupAnchor.js:7-13` 记录的「**下面留下了大量的空白**」那条用户抱怨。为了 1.5 秒的启动动画，把稳态布局永久改坏。

3. ❌ **把六拍行直接挂在带 `alignItems:'center'` 的根 Box 下**。
   逐子元素居中 ⇒ 六行 label 左边缘参差。必须包一层 `alignItems:'flex-start'` 的内层 column Box。

4. ❌ **新增 `KHY_BOOT_*` 开关做回滚**。
   撞 `check-tui-gates` 的门预算棘轮（实测 226 > 220 已 FAIL，且注释写明只降不升），且会把一个纯视觉改动从「可选参数缺省」拉进「新增配置键」。回滚用 `rows` 缺省语义 + `git revert`，不用开关。

5. ❌ **引入 figlet / ASCII 字库生成大字标**。
   新依赖 + 宽度不可控（H6）+ 会把 `logoArt.js` 从「纯叶子搬像素」变成「运行时拼字形」，收益为负。

6. ❌ **把 `(50%)` 解读成时间进度**。
   六拍耗时极不均衡（`gateway` 是唯一带降级看门狗的拍，`App.js:46-48`），等权百分比只对「拍数」成立。**不得**在界面上出现「预计剩余 Xs」「已完成 50%」这类措辞；要说就说「3/6 拍」。

7. ❌ **为了「看起来统一」把 `CcLogo` 的 `✳ Khy` 也换成四叶草**。
   `✳` 是 `[DESIGN-ARCH-081]` 品牌替换规范下的 CC 面资产，且 CC 模式定性未作出（`ccMode.js:9-19` 明写「预览态，需产品判断」）。跨模式品牌收敛不是本次的粒度。

8. ❌ **在 `tests/tui/` 下用 jest 全局写新用例**。
   CI 的 `test:node` 是 `node --test tests/**/*.test.js`（`services/backend/package.json:59`），会把该目录一并扫走 ⇒ 引用未定义的 `describe`/`test` ⇒ 落地即红。`tests/tui/liveFrameGeometry.test.js` 就是这么红的（见 §1.2）。新用例一律用 `node:test` 写，并显式条件 skip。

---

## 7. 验收方式

### 7.1 可机器验证（CI 会跑，必须落地即绿）

| # | 判据 | 命令 |
| --- | --- | --- |
| 1 | 阶梯纯函数：给定 `rows` ∈ {10,15,16,17,25,26,30} 与 `rows=undefined`，返回的 `frameH ≤ rows − 1`（`undefined` ⇒ J 档）；且降级顺序为 F→G→H→I→J | `node --test services/backend/tests/cli/tui/bootLayout.test.js` |
| 2 | 零回归：`startupBeats` 两条既有套件仍 17 + 8 全绿 | `node --test services/backend/tests/cli/startupBeats.test.js services/backend/tests/cli/tui/startupBeatsWiring.test.js` |
| 3 | 源码断言（扩 `startupBeatsWiring.test.js`）：BootScreen 根 Box 含 `alignItems` 且值为 `'center'`；全文**不含** `'─'.repeat(`；全文**不含** `khy-os`（字面量）；`require` 了 `logoArt` | 同 #2 |
| 4 | 零新增门控：token 计数**仍为 226**（不得上升） | `node scripts/ci/check-tui-gates.js` |
| 5 | 两个新文件满足纯叶子契约 | `node scripts/ci/check-leaf-contract.js services/backend/src/cli/tui/logoArt.js services/backend/src/cli/tui/bootLayout.js` |
| 6 | 共享资产唯一：全仓 `CLOVER_ART` 定义只出现 1 处 | `node --test services/backend/tests/cli/tui/logoArtSingleSource.test.js`（新，源码扫描） |

### 7.2 真字节几何（本地跑，CI 不跑）

用既有的最小 VT 屏幕模型 `services/backend/tests/tui/vtScreen.js`（与 BUG-91 真帧守卫同源），把 BootScreen 在假 TTY 上渲染出的字节流喂进去，断言：

1. 帧首行的前导空白 ≈ `floor((cols − blockCols) / 2)`（容差 ±1）——**居中的唯一可信判据**；
2. 帧高 ≤ `rows − 1`；
3. 全启动期零 `ESC[2J` / `ESC[3J`（H2）；
4. 六拍行数**恒定 6**（S1），不随推进变化。

命令：`NODE_OPTIONS=--experimental-vm-modules npm run --workspace backend test:tui -- tests/tui/bootFrame.test.js`

> ⚠️ **限制（如实登记）**：该断言依赖 `--experimental-vm-modules`，而 CI 的 `test:node` 不带此 flag。所以文件必须用 `node:test` 写并**在前置条件不满足时显式 skip**——CI 上它只保证「不红」，真断言只在本地生效。这与 ink TUI 套件整体的现状一致（§1.2 末行）。

### 7.3 人工目视

| 尺寸 | 期望 |
| --- | --- |
| 80×30 | F 档：四叶草 + `khy OS` + tagline + 进度条 + 六拍，**整块水平居中** |
| 80×24 | G 档：去 tagline（四叶草仍在） |
| 80×20 | H 档：去四叶草，只留 `khy OS` + tagline |
| 80×12 | J 档：无品牌块，只剩进度 + 六拍；**无闪烁、无整屏重绘** |
| 拖动改宽 | `alignItems:'center'` 逐帧跟随，宽窄都不折行 |

---

## 8. 待核实项

| # | 事项 | 影响 | 处置 |
| --- | --- | --- | --- |
| 1 | ~~`[DESIGN-ARCH-115]` §5.4 S4 措辞是否按 §2.6 修订~~ | —— | **已解决（2026-09-23）**：S4 已按「只有一份 logo **资产**」修订，`[DESIGN-ARCH-115]` §13 已记变更行 |
| 2 | ~~`App.js:5969` 那一行何时投放~~ | —— | **已投放**：下发 `rows`/`cols`，`rows` 缺省时 `bootLayout` 落 I 档，即使该行被并行会话的后续改动覆盖也只降档、不回归 |
| 3 | `ProgressBar.js` 正被他人改（` M`） | 其 API 若变，进度行会连带失败 | 投放前重跑 §7.1 #2；若其 `kind:'count'` 签名变了则改用 `kind:'stage'`（同样复用，不新写） |
| 4 | `run-ink-tui-tests.js:15` 声称的 CI「Ink TUI」job 在 `.github/workflows/` 内**不存在** | ink TUI 套件零 CI 覆盖（既有问题，非本文引入） | 独立问题，登记待办；本文不改 |
| 5 | `tests/tui/liveFrameGeometry.test.js` 在 `test:node` 下 1 fail（他人未提交） | 会让 CI 的 `test:node` 变红 | 非本文引入；投放前确认它已被作者修好或移除 |
| 6 | 新增 `logoArt.js` / `bootLayout.js` 是否需登记 `packaging/modules/modules.json` | `[DESIGN-ARCH-115]` §9 有「新增文件须登记进 `khy-ai` 板块」的义务声明 | **已当场查清 = 不需要**：`modules.json` 只有 4.3KB，登记的是**模块 id + handlers + services 名单**（`khy-ai` 的 `handlers` 是命令名如 `arena/session/skill`），**不按源码路径枚举** `cli/tui/*`。已实测 `startupBeats` / `startupAnchor` / `bootPhaseLine` / `ink-components` 在 `modules.json` 中命中数均为 **0**。⇒ 115 §9 的措辞对「新增服务模块/命令」成立，对「新增 UI 组件文件」不适用 |
| 7 | `rows` 的真实下限（`rows < 15` 时是否仍有闪烁） | 影响 §5「小终端」那条的强度 | 【推测】按 `ink.js:320` 的 `outputHeight >= rows` 判定，`rows < 14` 必进 fullscreen；需在 §7.2 的假 TTY 里实测确认 |

---

## 9. 实施记录（P0，2026-09-23）

### 9.1 落地清单

| 文件 | 动作 | 行数变化 |
| --- | --- | --- |
| `cli/tui/logoArt.js` | **新增**：四叶草像素 + 字标 + tagline 的唯一资产，`cloverRows()` 供两个渲染器消费 | 新 107 行 |
| `cli/tui/bootLayout.js` | **新增**：H1 五档阶梯（F–J），判据复用 `chromeBudget.CC_TRAILER_ROWS` | 新 124 行 |
| `cli/tui/ink-components/BootScreen.js` | 重写：`alignItems` 居中 + 进度行 + 品牌块；删 `╱╲` 图案与 `'─'.repeat(14)` | 150 → 216 行 |
| `cli/tui/ink-components/WelcomeBanner.js` | 删本地像素表，改 `require('../logoArt')` | 186 → 145 行 |
| `cli/tui/ink-components/App.js` | **1 处**：`_bootScreenEl` 下发 `rows`/`cols` | +7 行（含注释） |
| `tests/cli/tui/bootLayout.test.js` | **新增** 8 条 | —— |
| `tests/cli/tui/logoArt.test.js` | **新增** 6 条（含「定义只允许出现一次」的仓内扫描） | —— |
| `tests/cli/tui/bootScreenVisual.test.js` | **新增** 6 条（源码断言） | —— |
| `[DESIGN-ARCH-102]` §5.6 | 新增 **C22** 组件登记 | —— |
| `[DESIGN-ARCH-115]` §5.4 | S4 措辞修订 + 变更记录行 | —— |

### 9.2 验收实测

| 判据 | 结果 |
| --- | --- |
| `bootLayout` + `logoArt` + `bootScreenVisual` | **8 + 6 + 6 = 20 绿** |
| 既有套件零回归 | `startupBeats` 17 / `startupBeatsWiring` 8 全绿 ⇒ **合计 45/45** |
| `check-leaf-contract.js`（两个新叶子 + 两个渲染器） | **PASS**，零违规 |
| `check-tui-gates.js` | **仍为 226**（与改动前逐字节相同 ⇒ 零新增门控；既有的 226>220 FAIL 不是本次引入） |
| 真帧验证（`tests/tui/vtScreen.js` 最小 VT 模型，5 档） | 80×30→**F**、80×24→**H**、80×16→**I**、80×12→**J**、30×30→F+放弃居中，**全部符合预期**；全启动期**零 `ESC[2J`**；80×30 下四叶草 lead=**33**（= `2 + floor((76−13)/2)`，与手算一致）；节拍块六行左边缘对齐（35 = 35） |

### 9.3 与方案的偏离（逐条给原因）

| # | 偏离 | 原因 |
| --- | --- | --- |
| 1 | **`rows` 缺省档从 J 改为 I**（提案 §3.5 写 J 档 13/14 行） | I 档帧高 15 **同样 ≤ 现状 17**，回滚语义一个不少；但缺省形态保留字标，不至于「完全没有品牌」。J 档只在 `rows < 16` 时才需要 |
| 2 | **品牌三行各自居中，不包内层 Box**（提案 §3.1 写「品牌块整块居中、内部左齐」） | 真帧实测推翻：内层 Box 的宽度 = 最宽子行（tagline 27 列），四叶草（13 列）被带着左移 7 列（实测 lead 27，手算应为 33）。经典 splash 的对称形态要求**每行各自居中**；只有**节拍块**需要 `flex-start` 内层（六行 label 左边缘必须对齐，实测 35 = 35 ✓）。此教训已写进 `[DESIGN-ARCH-102]` §5.6 C22 硬规则 ④ |
| 3 | **视觉断言独立成 `bootScreenVisual.test.js`，未并入 `startupBeatsWiring.test.js`**（提案 §4 第 6 项） | 那个文件是「节拍接线锁」，单一职责；视觉契约与接线是两个关注点，混进去会让两把锁都变钝 |
| 4 | `require` 路径初版写错一层（`../../logoArt` → 应为 `../logoArt`），被 `startupBeatsWiring` 的既有 8 条第一时间抓红 | 佐证「既有测试先跑」的价值；已修正 |
| 5 | **额外实测出 ink 的宽度模型**（`measureElement`：块字符 1 列、CJK 2 列，`20█=20`、`环境与配置(5字)=10`） | 这推翻了排查居中偏差时的第一直觉（「ink 不认 CJK」）；结论：**`alignItems` 居中可信，偏差全部来自内层 Box 宽度取最宽子行**。已登记为 C22 硬规则 ④ |

### 9.4 明确不做（沿用 §4）

每拍真实说明、版本号、垂直居中、`run-ink-tui-tests.js` 的 CI job、CC 品牌跨模式收敛 —— 理由见 §4。

---

## 10. 变更日志

| 日期 | 变更 |
| --- | --- |
| 2026-09-23 | 初版。登记 B1–B7 实测病灶与门禁基线（含两条**改动前就已红**的既有失败）；声明与 `[DESIGN-ARCH-115]` S4 的冲突与修订建议；给出居中机制（`alignItems`，零 props）、进度行（复用 `ProgressBar` + `_elapsedMsToStr`）、品牌资产（`logoArt.js` 一份四叶草）、H1 五档阶梯（F–J，`rows` 缺省落最保守档）；门控净新增 0；P0 七项落地清单与 8 条反模式；7 项待核实（其中「`modules.json` 是否需登记」已当场查清）。 |
| 2026-09-23 | **P0 实施**。10 个文件落地（2 新叶子 + 2 渲染器 + App 一处 + 3 新测试 + 3 真源文档）；45/45 绿、leaf-contract PASS、门预算零漂移；真帧 5 档验证全过、零 `ESC[2J`。五处偏离见 §9.3；`[DESIGN-ARCH-102]` 新增 C22，`[DESIGN-ARCH-115]` §5.4 完成修订 |
