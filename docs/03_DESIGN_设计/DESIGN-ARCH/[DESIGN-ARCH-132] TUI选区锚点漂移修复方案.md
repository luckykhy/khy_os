# [DESIGN-ARCH-132] TUI 选区锚点漂移修复方案（内容指纹重定位）

> 状态：**第一期已落地**（纯新增，未接线）；二、三期待做
> 落点：`docs/03_DESIGN_设计/DESIGN-ARCH/`
> 关联：`[DESIGN-ARCH-119]`（TUI 文本选择与复制 · 验收标准 —— 本提案补它的 §六 缺口 4）、
> `[DESIGN-ARCH-111]`（规则遵守保障机制）、`[DESIGN-SOURCING-001]`（B-P1 §165 bugfix 豁免）
> 前置实证：`services/backend/tests/cli/tui/selectionAnchorDrift.test.js`（**已落盘，D-02/D-04 为红**）
> 第一期单测：`services/backend/tests/cli/tui/selectionRelocate.test.js`（**17 条全绿**）
> 模板合规：§2 已按 B-P2 体例填写，并**显式声明本提案属 B-P1 豁免**（理由见该节）

---

## 0. 一句话

`selection.js` 的选区锚点存的是**行号**，而 `extractText` 在**松手那一帧**按行号重新切片 ——
一个数字、两个时刻。手势期间只要 `lines` 发生「行插入 / 行删除 / 折行重排」，
同一行号就指向不同内容，表现为**复制出来的比选中的少一截 / 整段错位**。

修复方式：给锚点补**内容指纹**（行首 hash + 行序号），松手时按指纹在当帧 `lines` 里
**重定位**锚点后再切片。**不是**缓存按下时的行快照（那会制造第二种不一致，见 §6）。

| 维度 | 现状 | 目标 |
|---|---|---|
| 锚点标识 | 裸行号（`{line, col}`） | 行号 + **内容指纹**（行首 hash + 行序号） |
| 取文依据 | 松手帧按行号切片 | 松手帧按**指纹重定位**后切片 |
| 手势期间流式输出 | 复制内容错位（实测错位量 = 插入行数） | 复制内容 = 用户看到的那段 |
| 纯叶子约束 | 零 IO / 确定性 / 不抛 | **不变**（指纹由调用方随锚点传入，叶子不自己读行数组） |

---

## 1. 现状实证（file:line 可复核）

### 1.1 两次独立读取 —— 缺陷的骨架

| 环节 | 真源 | 实况 |
|---|---|---|
| 锚点写入 | `services/backend/src/cli/tui/selection.js:157-160` | `beginSelection` 存 `{anchor: {line, col}, head, dragging}` —— `line` 是**行号** |
| 行数组来源 | `App.js:5878` | `_mainContentLinesRef.current = _mainContentLines`（**每帧覆盖**） |
| 行数组依赖 | `App.js:5859-5874` | 依赖数组含 **`query.streaming`** 与 **`query.turnPhase`** ⇒ 流式期间**逐段重建** |
| 取文 | `App.js:1617` | `sel.extractText(_mainContentLinesRef.current, finished)` —— 用**松手那一帧**的行数组按行号切片 |
| 拖动改活动端 | `App.js:1589` | `extendSelection(_selectRegionRef.current, pt.line, pt.col)` —— 只改 head，anchor 不动 |
| 手势护栏 | `App.js:1551 / 1564 / 1593 / 1641` | `_selectingRef` 只标记「手势进行中」，**不阻止 `_mainContentLines` 重建** |

**关键事实：手势期间没有任何「冻结行投影」的护栏。** 用户在 AI 正吐字时拖选，
`_mainContentLines` 会在手势中途被重建数次，锚点行号随之失效。

### 1.2 实测：探针已把缺陷钉死

`services/backend/tests/cli/tui/selectionAnchorDrift.test.js`（本提案的前置实证，已落盘）：

| 用例 | 结果 | 实际取到 | 用户选的是 |
|---|---|---|---|
| D-01 基线（内容不动） | ✅ 绿 | 正确 | — |
| **D-02 头部插入 3 行** | ❌ **红** | `L07..L11` | `L10..L14` |
| D-03 尾部追加（对照） | ✅ 绿 | 不受影响 | — |
| **D-04 折行重排**（4 视觉行塌成 2） | ❌ **红** | `'para-part-1..3\nTAIL'` | `para-part-1..3` |
| D-05 内容缩短 | ✅ 绿 | fail-soft 不抛 | — |

**D-02 的错位量恰好 = 插入行数（3）** —— 这是「纯行号锚定」的算术必然，不是偶发。

探针复刻了 `App.js:1530-1648` 的坐标换算与取文，并在**手势中途替换 `lines`**。
D-01 基线与 D-03 对照均为绿，**担保了「两条红不是探针自己算错」**。

### 1.3 三层单测为何全绿 —— 缝在它们都没跨过的地方

| 文件 | 条数 | 覆盖 | 为何抓不到 |
|---|---|---|---|
| `mouseSelectEvent.test.js` | 15 | 事件侧：down/move/up 齐备、修饰键放行、坐标透传 | 只验事件序列，不看行数组 |
| `selection.test.js` | 37 | 模型侧：切片算术、词边界、fail-soft、纯函数性 | **全部在单一 `LINES` 快照上跑**，从不中途改动 |
| `viewportDragEdgeScroll.test.js` | 8 | 拖到边缘自动滚动时行号怎么算 | 只验**偏移**变化，不验**内容**变化 |

⇒ 与 `App.js:1523` 注释里说的完全同型：**「单测各自自洽，只有端到端探针抓得到」**。

### 1.4 原始设计文档里就没有这一条

`[DESIGN-ARCH-119]` 的「§七 待核实项」表格第 3 行只登记了**软换行**（视觉行 ≠ 逻辑行），
**没有锚点漂移**；`selection.js` 头部「已知偏差」原本也只写了软换行。
⇒ 这是**原始设计时未识别的缺口**，不是「知道但没做」。

---

## 2. 借鉴提案（B-P2 体例）

### 2.0 ★ 先声明：本提案属 `B-P1` 豁免，不适用 B-P2 七字段

`[DESIGN-SOURCING-001]` §3 `B-P1`（doc line 165）原文：

> **豁免**：对已登记能力域的**行为修正**（bugfix、补字段、文案调整）不需要提案。
> 豁免的判定依据是该能力域已在注册表中存在且有 `canonical` 路径。

判定依据（逐条对应 B-P1 第 159-166 行的三个新能力域判据）：

| B-P1 判据 | 本提案 | 是否命中 |
|---|---|---|
| 新增此前没有的顶层概念（新工具/服务/命令/UI 视图族） | 无新增，改的是既有 `selection.js` | ❌ |
| 新增此前不存在的对外契约（新 API/协议/配置键/env） | **无新增 env、无新增配置键**（指纹随锚点对象传递，属内部数据结构） | ❌ |
| 首次引入上游实现方式（`FEATURE-OWNERSHIP.json` 的 `source` 为新值） | 不引入任何上游件 | ❌ |
| **豁免判据**：能力域已登记且有 `canonical` | `selection.js` 已登记（`[DESIGN-ARCH-119]` §4.2 第二层） | ✅ |

⇒ **本提案属 bugfix 豁免，B-P2 七字段不适用。** 下文按 B-P2 体例逐项**据实**填写，
命中处填「不适用 + 依据」，**不留空**（B-P2 只规定「缺一不落地」，「据实声明不适用」不等于缺）。

```
【借鉴提案】（据实填写，逐项标注适用性）
1. 借鉴对象：不适用 —— 本提案无上游借鉴对象。
2. 借鉴内容：不适用 —— 同上。
3. 解决的问题：TUI 拖选在「手势期间内容重排」时复制内容错位。
   现象：复制出来的比选中的少一截 / 整段错位（错位量 = 内容位移行数）。
   指向：selection.js:157-160（锚点存行号）+ App.js:1617（松手帧按行号切片）。
   实证：selectionAnchorDrift.test.js 的 D-02（红，错位 3 行）、D-04（红，混入 TAIL）。
4. 许可证与代码性质：不适用 —— 不引入任何上游代码/二进制/资源。
5. 借鉴方式：不适用 —— 无借鉴。判定依据：改动落在本仓自有的既有叶子模块内。
6a. 落点：selection.js（改锚点结构 + 加指纹重定位）；App.js（锚点写入时附指纹）。
   两者均已存在，无新增文件。
6b. 现有同类实现：**已搜索**。搜索词与结论见 §2.1。
7. 验收方式：见 §7。核心一条：selectionAnchorDrift.test.js 的 D-02 / D-04 转绿，
   且 selection.test.js 的 37 条、mouseSelectEvent.test.js 的 15 条**零回归**。
```

### 2.1 现有同类实现搜索结果（B-P2 第 6b 项要求「搜过哪些词、在哪些目录」）

| 搜索词 | 目录 | 结论 |
|---|---|---|
| `anchor` / `锚点` | `services/backend/src/cli/tui/` | **唯一实现在 `selection.js`**（`{anchor, head, dragging}`） |
| `charColForDisplay` | 同上 | 已有列换算（显示列 → 字符下标），**本提案复用，不另起** |
| `hash` / `fingerprint` / `指纹` | `services/backend/src/cli/tui/` | **零命中** —— 本仓此前无「行内容指纹」概念，需新建（这是本提案唯一的新增件） |
| `softWrap` / 软换行元数据 | 同上 | 零命中 —— 与 `[DESIGN-ARCH-119]` §六 缺口 4 同一片空白 |
| `messageId` / 消息元数据 | 同上 | 零命中（行投影无消息锚点，见 `[DESIGN-ARCH-119]` §七 风险 1） |

⇒ 结论：**扩展既有 `canonical`（`selection.js`），不新增并行实现。**
指纹是本仓首个此类概念，但它是**修既有缺陷所必需**，不是新能力域。

---

## 3. 目标形态（组件级契约）

### 3.1 `selection.js`：锚点从「行号」升级为「行号 + 指纹」

```js
// 锚点形状（向后兼容：无 fingerprint 时退化为纯行号，逐字节保持老行为）
{
  line: 42,          // 行号（保留：同帧内仍可用，且是渲染层的坐标系）
  col: 7,            // 字符下标（不变）
  fp: {              // 【新增】内容指纹，可为 null（老调用方不传）
    head: '3f2a1b',  // 行首 N 字符的 hash（N=24，够区分同屏内多数行）
    seq: 118,        // 该行在**逻辑内容流**里的序号（见 §3.3）
  }
}
```

**契约要点**：

1. **纯叶子不变**：`selection.js` 仍是零 IO、确定性、绝不抛。指纹由**调用方**（`App.js`）
   在 `beginSelection` / `extendSelection` 时随锚点传入 —— 叶子**不自己读 `lines`**。
2. **向后兼容**：`fp` 为 `null` / 缺失时，行为与今天**逐字节相同**（`extractText` 走原路径）。
   这是硬承诺：老调用方（`CcApp.js`、`ccMessageProjection`、单测）零影响。
3. **重定位是独立纯函数**：新增 `relocate(range, lines)` —— 输入「带指纹的 range」+
   「当帧 lines」，输出「重定位后的 range」或 `null`（定位失败）。
   单独导出便于**直接单测**，也让 App 层可显式处理失败（§4.3 降级策略）。

### 3.2 取文流程（改造后）

```
T0 按下  → beginSelection(sel, line, col, fp)   ← fp 由 App 从当帧 lines 算出
T0..T1   → extendSelection(...)                  ← 只改 head（anchor 含 fp 不动）
T1 松手  → extractText(lines, sel)               ← 内部先 relocate 再 slice
             │
             ├─ relocate 成功 → 按重定位后的行号切片 ✅
             └─ relocate 失败 → 回退纯行号切片（今天的行为）+ 返回信号给调用方
```

### 3.3 指纹构成：为什么是「行首 hash + 序号」

| 方案 | 能否抗行插入 | 能否抗折行重排 | 判断 |
|---|---|---|---|
| 仅行号（现状） | ❌ 错位 = 插入量 | ❌ 整体错位 | 缺陷本体 |
| 仅行首 hash | ✅ | ⚠️ 折行会**改变行首内容**（半行被切走）⇒ 失配 | 不足 |
| 仅行序号 | ✅ | ❌ 折行会改变行数 ⇒ 序号漂移 | 不足 |
| **hash + 序号（双判据）** | ✅ | ✅（见下） | **采用** |

**折行重排的处理**：折行会让同一逻辑段的**视觉行首**变化，故 `head` hash 可能失配。
此时以 `seq`（逻辑内容流序号）为主判据、`hash` 为校验：
- `seq` 命中且 `hash` 也命中 → 高置信，直接用；
- `seq` 命中但 `hash` 失配（发生折行）→ **中置信**：用 `seq` 定位到该逻辑段，
  再在段内按 `col` 的相对位置重新映射（`selection.js` 已有 `charColForDisplay` 可复用）；
- 两者都失配 → **定位失败**，走 §4.3 降级。

> ⚠ **`seq` 从哪来是待核实项**（§8）。`_mainContentLines` 目前是**扁平字符串数组**，
> 不含「这一行属于哪条消息 / 哪个逻辑行」的元数据。最省的做法是让
> `buildTranscriptLines` 顺带产出**平行数组** `lineSeqs`（与 `lines` 等长），
> App 层把它和 `lines` 一起交给 `selection`。这属于行投影改动，见 §4 分期。

---

## 4. 实施分期（每期独立可回滚）

### 第一期：指纹基础设施 + 重定位纯函数（**不含 App 接线**）—— ✅ 2026-09-23 已落地

**实际落地的函数（与本节原拟名称不同，见下方「偏离说明」）**：

| 函数 | 签名 | 作用 |
|---|---|---|
| `relocateLine` | `(from, to, point) → number` | 按指纹把单个行号从 `from` 重定位到 `to` |
| `relocateSelection` | `(selection, from, to) → selection` | 两端各自重定位，丢弃已消费的 `fp` |
| `extractTextRelocated` | `(lines, fromLines, sel) → string` | 取文的重定位版；`fromLines` 非数组 → 等价 `extractText` |

- `beginSelection(sel, line, col, fp?)` 接受可选 `fp`；`extendSelection` / `endSelection`
  经新增的 `_anchor()` 保指纹（漏一处锚点就退化成纯行号）。
- 新增内部规范化 `_fp(v)`：非字符串 → `''`；`v.replace(/\s+/g,' ').trim()` 折叠空白。
  **指纹是「归一化后的行原文」，不是 hash**（偏离说明见下）。
- **回滚点**：不传 `fp` 时行为与今天逐字节相同 ⇒ 即使后续期全部回滚，本期也无害。
  由 `selectionRelocate.test.js` 的 R-02 / R-05 / R-14 / R-16 四条**显式钉住**。
- 验收（实测）：新增单测 **17/17 绿**；老套件 **57/57 绿**（零回归）；
  D-02 / D-04 **仍红**（未接线，符合预期）。

> ### ⚠ 偏离说明（本节原拟 vs 实际落地 —— 逐条给原因）
>
> | 原拟（本节上一版） | 实际落地 | 为什么改 |
> |---|---|---|
> | `relocate(range, lines)` 两参 | `relocateLine(from, to, point)` 三参 + `relocateSelection(sel, from, to)` | 原拟的两参把「两个行数组」藏进了 `range` 里 —— 那要求 `range` 携带 T0 的 `lines`，而 `range` 是从选区派生的**纯坐标**，塞行数组进去会让它变成半个游标对象。改成**显式的 `from` / `to` 两数组**后，「一个数字跨两个时刻」这件事在签名上直接可见，且重定位逻辑与选区结构解耦（单测可只喂数组）。 |
> | `makeFingerprint(line, seq)`（hash + 序号双判据） | 不设此函数；指纹 = `_fp(行原文)` | **原案的 `seq` 判据是过度设计**。§3.3 原以为「折行重排」必须靠逻辑行序号才能救，但实际验证：**两数组之间直接做内容比对就能定位**，不需要预先的 `seq` 元数据。删掉 `seq` 的直接收益：第三期的 `buildTranscriptLines` 改动**不再被第一期依赖**，两期真正解耦。 |
> | hash 取前 24 字符（§8 待核实 2） | 不做 hash，直接存归一化整行 | 行数组长度通常 ≤ 数千，逐行字符串比较的成本可忽略；而 hash 会引入**额外的碰撞风险面**（碰撞 = 静默定位到错行，正是本缺陷的另一种形态）。**不做 hash 就不需要论证碰撞率** —— 这是把 §8 待核实 2 直接消掉，而不是留给未来。 |
> | 三档置信 | 保留三档，但第 2 档定义收窄 | 原拟第 2 档「中置信：seq 命中 hash 失配 → 段内按 col 重映射」依赖 `seq`，已随 `seq` 一并删除。新第 2 档 = **「指纹多次命中 → 取离原行号最近者」**，这是无 `seq` 下唯一能保持确定性的策略，且覆盖原第 2 档想解决的场景（整体平移）。 |

### 第二期：App 层接线（`App.js` 一处改动）

- `App.js:1560` 的 `beginSelection` 调用点补 `fp`（从当帧 `_mainContentLines[line]` 算出）。
- **回滚点**：`selection.js` 的 `fp` 参数本就可选（第一期已保证 `undefined` → 老行为）。
  回滚 = 把 `App.js` 那一处调用改回不传 `fp`，**无需新 env**（理由见下）。
- 验收：`selectionAnchorDrift.test.js` 的 **D-02 转绿**。

> ⚠ **刻意不新增 `KHY_SELECT_FP` env** —— 依据是本项目的棘轮守卫（已实测）：
> `scripts/ci/check-tui-gates.js:32` 的 `MAX_GATES = 220`，注释写明「**only moves DOWN**」，
> 且 `:28-30` 记载 2026-09-18 曾为 `KHY_SELECT*` 一族破例 +8。再开一个新门会**撞棘轮**，
> 而 `services/backend/src/cli/tui/utils/selectGates.js:18` 又明写「三个子开关……**别合并**」
> ⇒ 往 `selectGates` 里加第四个门也会与该叶子的设计意图冲突。
> **但本修复根本不需要门**：指纹重定位是「让复制正确」，不是「行为取舍」——
> 三条子门控（`KHY_SELECT` / `_CLIP` / `_DRAG`）各自对应一种**用户可见的权衡**，
> 而「复制对的内容」没有第二面可权衡。回滚能力由「`fp` 可选参数」天然提供，不需要 env。
> ⇒ 这也**保住了本提案的 B-P1 豁免地位**（§2.0 第 2 条判据：无新增配置键）。

### 第三期：行投影补 `seq` 元数据（**最大的一期，可独立放弃**）

- `buildTranscriptLines` 顺带产出 `lineSeqs` 平行数组（逻辑行序号）。
- 覆盖 **D-04（折行重排）**。
- **诚实说明**：若第三期不做，D-02（行插入，最高频场景）**已修复**，D-04 仍红。
  两期分开是刻意的 —— 让「高频场景修好」不必等「折行元数据」这个大改。

---

## 5. 诚实边界（刻意不纳入 —— 逐条给原因）

| # | 不做的事 | 原因 |
|---|---|---|
| 1 | 手势期间**冻结**行投影（不渲染新内容） | 用户拖选时往往正想看新内容流进来；冻结会让人以为程序卡死。且与 `[DESIGN-ARCH-087]` 的流式反馈设计冲突 |
| 2 | 缓存「按下时的 lines 快照」直接切片 | **制造第二种不一致**：流式内容会被复制成旧文本，且与「用户松手时看到什么」再次背离（§6 详述） |
| 3 | 消息级锚点（复制整条消息） | `[DESIGN-ARCH-119]` §七 风险 1 已列为独立议题，需 `buildTranscriptLineRecords`，不与本缺陷混做 |
| 4 | 行级 `softWrap` 元数据（还原逻辑行） | `[DESIGN-ARCH-119]` §六 缺口 4 的另一半；本提案只解决**定位**，不解决**逻辑行还原**（跨软换行仍带硬 `\n`） |
| 5 | 改 `CC` 模式（`CcApp.js` / `ccMessageProjection`） | CC 走 `extractByAnchors` + `projection`，锚点语义不同。**本提案只覆盖 Legacy `App.js` 路径**；CC 侧若同病，另立提案（§8 待核实） |

---

## 6. 反模式（这条路别走 —— 逐条给为什么）

### ❌ 反模式 1：让 `extractText` 用「按下时的行快照」

听起来最直接（「存一份开始时的 `lines` 不就对齐了」），但它把**错位**换成了**陈旧**：

| | 行号锚定（现状） | 快照切片（诱人但错的修法） | 指纹重定位（本提案） |
|---|---|---|---|
| 流式期间拖选 | 取到**别的内容** | 取到**旧内容**（用户松手时那行已变） | 取到**用户选的那段** |
| 用户感受 | 「复制出来不对」 | 「复制出来是过时的，还得重来一次」 | 正确 |

根因是：**用户要的是「我看到的那段」，而「我看到的」在松手那一刻已经变了。**
唯一能对齐两端的是**按内容（而非数字）锚定**。快照切片把问题从「错位」搬成「陈旧」，
两者都是错的。

### ❌ 反模式 2：手势期间禁用流式渲染

会与流式反馈的全部设计冲突（`[DESIGN-ARCH-087]`），且用户拖选**常常正是为了复制正在生成的内容**。
冻结 = 让用户复制不到他想复制的东西。

### ❌ 反模式 3：把 `relocate` 做成有状态的缓存

`selection.js` 是纯叶子（零 IO / 确定性，`selection.test.js:12-16` 把这条写成了纪律）。
若 `relocate` 内部缓存上一次的 `lines` 以便比对，就**破了叶子契约** ——
它会变得「同输入不同输出」（取决于缓存状态），单测失去确定性。

### ❌ 反模式 4：只改 `App.js` 加个「重算 anchor」的补丁，不动 `selection.js`

`App.js` 是 6000 行巨石，往里塞「按内容重定位」的逻辑会有两个后果：
① 该逻辑**无法被单测直接驱动**（它藏在 useCallback 里，三层单测的实验已证明这类缝抓不住）；
② 与 `selection.test.js` 已有的「坐标系在叶子、状态在 React」分工背离。
**正解是逻辑进叶子（可测），App 只负责取指纹传进去。**

### ❌ 反模式 5：为了 D-04 折行场景先做第三期（`seq` 元数据）

行投影加元数据是**大改**（`buildTranscriptLines` 是热路径，`[DESIGN-ARCH-119]` 提过它）。
先做它会让「高频的 D-02」跟着一起等 —— 顺序应反过来：**先修高频、再补低频**。

---

## 7. 验收方式（可复现命令 + 关联门禁）

### 7.1 核心验收（一条命令）

```bash
cd "D:/Portable/khy-os" && \
"D:/WorkBuddyData/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" \
  --test services/backend/tests/cli/tui/selectionAnchorDrift.test.js \
         services/backend/tests/cli/tui/selectionRelocate.test.js
```

| 期 | 验收判据 | 2026-09-23 实测 |
|---|---|---|
| **第一期** | D-01 / D-03 / D-05 保持绿；`relocate` 单测全绿；**D-02 / D-04 仍红**（未接线） | ✅ **达标**：探针 3 绿 / 2 红；relocate **17/17 绿** |
| 第二期 | **D-02 转绿** | 待做 |
| 第三期 | **D-04 转绿**（全五绿） | 待做 |

> ⚠ **第一期无法让探针变绿，这是设计使然、不是失败。** 探针走的是
> `mouseButtons → selection → extractText` 的**端到端**路径，而第一期**刻意不接线**
> —— 所以 D-02 / D-04 必须仍红。第一期的证据在**另一份文件**：`selectionRelocate.test.js`
> 用**纯函数**路径证明了「同一段内容在 T1 能被正确定位」（R-01 / R-15），
> 以及「不接线时必然漂移」（R-16，用 `notStrictEqual` 钉住）。
> 两份文件合起来才是完整的「缺陷存在 → 修复有效」闭环。

#### 为什么红的测试可以留在仓库里

D-02 / D-04 是**缺陷固化**（failing test as documentation），不是坏测试。它们：

1. **本身就是第二期的验收判据** —— 先有红的探针，才能证明第二期的接线真的生效
   （而不是「改完顺手把断言改松了」）。
2. **已按本仓约定登记入册**：`tests/DEBT.md` §十一（分类 `@bug`，含根因 / 处置状态 /
   复现命令 / 截止 ≈2026-12-23）。这满足该册首条规则「每个失败套件必须登记」。
3. **当前不卡任何 PR**（实测，见 §8.1）：pr-gate 的 `test-baseline` job 是
   `continue-on-error: true`。但它计入该 job 的失败数，而该 job 的目标是「清零后转阻断」
   ⇒ 登记 + 限期正是它该待的地方。
4. 同批两条绿（D-01 基线 / D-03 对照组）是「复刻链路可信」的**担保**，**不要动** ——
   删了它们，那两条红就失去意义（无法区分「真缺陷」与「探针自己写错」）。

### 7.2 零回归验收

```bash
cd "D:/Portable/khy-os" && \
"D:/WorkBuddyData/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" --test \
  services/backend/tests/cli/tui/selection.test.js \
  services/backend/tests/cli/tui/selectionDisplayCol.test.js \
  services/backend/tests/cli/tui/mouseSelectEvent.test.js \
  services/backend/tests/cli/tui/viewportDragEdgeScroll.test.js
```

基线（2026-09-23 实测）：**57 条全绿**（实测明细：`selection` 27 / `selectionDisplayCol` 7 /
`mouseSelectEvent` 15 / `viewportDragEdgeScroll` 8）。
第一期改造后复测：**仍 57/57 绿，零回归** —— `fp` 为 `null` 的向后兼容路径由这批测试担保。

> ⚠ **基线订正**：本节原写「60 条」。逐文件实测为 **57**（27+7+15+8）；
> `selection.test.js` 实为 27 条而非原估的 37 条。数字来自
> `node --test` 的 `# tests` 汇总行，可复核。

### 7.3 关联门禁

```bash
npm run check:tui-gates        # 自绘选择三个门控未被破坏
npm run check:leaf-contract    # selection.js 仍满足纯叶子契约（零 IO / 确定性）
npm run check:changed          # 改动面清单
```

> ⚠ `check:tui-gates` 在 2026-09-23 的巡检中已存在**既有失败**（+6 棘轮突破，与本次无关）。
> 验收时应比对**改动前后 counts 行零漂移**（见 `.workbuddy/memory/MEMORY.md` 的三步区分法），
> 而不是要求「全绿」。
>
> **本次已按该口径核完，结论：零漂移。** `selection.js` 的 `KHY_*` token 改动前后均为 `[0 -> 0]`；
> 226 与 220 的差额已**逐文件归因 + 算术闭合**：新增 7 个 token 全在并行会话的文件里
> （`KHY_WATCHDOG_NOTICE` / `KHY_CC_OVERLAY_FIT` / `KHY_UI_LANG` / `KHY_ALT_SCREEN` /
> `KHY_TERM_FALLBACK_ROWS` / `KHY_TUI_CONSOLE_LOG` / `KHY_VIM_PASTE_CAP`），
> 再减去 `vim/operators.js` 删掉的 1 个 → `220 + 7 − 1 = 226`。

---

## 8.1 「故意红的探针」在 CI 里的归宿（原 §8 待核实项 6 的结案）

**问题**：D-02 / D-04 是刻意保持红的，它们会不会让流水线变红？

**实测答案（2026-09-23，逐项可复核）**：

| 查什么 | 结果 |
|---|---|
| 探针会被谁扫到 | `services/backend/package.json` 的 `test:node` = `node --test tests/**/*.test.js` ⇒ **会**扫到 |
| 会不会被 jest 重复跑 | **不会**。`jest.config.js` 有 `findNodeTestFiles` + `testPathIgnorePatterns`，凡含 `require('node:test')` 的文件被**排除出 jest**，只由 `test:node` 执行 ⇒ 无双 runner 问题 |
| 会不会卡住 PR | **不会**（今天）。`.github/workflows/pr-gate.yml:420-423` 的 `test-baseline` job 是 `continue-on-error: true`（**Phase 1 report-only**），且 `:409` 记有既知基线「4 suite / 9 用例失败」 |
| 但会不会有别的代价 | **会**。该 job 的升级路径写死为「**失败用例清零后**删掉 `continue-on-error` 即转为阻断」（`:412`、`:516`）⇒ 每加一条红用例，就把这个目标推远一步 |

**⇒ 处置：登记入册，而不是藏起来。**

本仓对「已知失败测试」有**单一真源** `tests/DEBT.md`（根级，已跟踪，受
`check-repo-layout.js` 登记为合规例外），其首条规则即
「**每个失败套件必须登记，包含分类、根因、处置状态**」，
并规定「`@bug` 类 3 个月后阻断 PR」。

已在 `tests/DEBT.md` 新增 **§十一** 登记本探针（分类 `@bug`，含根因 / 处置状态 /
复现命令 / 截止日 ≈2026-12-23）。

> ⚠ **`check-debt-ledger.js` 管的不是这份册子** —— 它读的是 `scripts/ci/debt-ledger.json`
> （门禁债务台账，管 `measured → target` 单调改善）。不要混淆，改 `DEBT.md` 不需要动它。

**为什么不用 `{ todo: true }` 或把文件挪出 `tests/`**：
① 本仓的既定约定就是「登记 + 限期」，绕开它等于绕过治理；
② 这两条红**本身就是第二期的验收判据** —— 现在藏起来，第二期就没有「改之前是红的」这个凭据；
③ 登记带来一个**有日期的义务**（≈2026-12-23），比「以后再说」强。


---

## 8. 待核实项

| # | 事项 | 为什么 | 怎么核 | 状态 |
|---|---|---|---|---|
| 1 | ~~`seq`（逻辑行序号）从哪来~~ | ~~§3.3 的 `seq` 依赖逻辑行元数据~~ | — | ✅ **已消解**：第一期确认**不需要 `seq`** —— 两数组间直接做内容比对即可定位。第三期因此不依赖第一期 |
| 2 | ~~指纹 hash 算法与长度~~ | ~~需抗碰撞又要够快~~ | — | ✅ **已消解**：改为存**归一化整行原文**，不做 hash。逐行字符串比较成本可忽略，且不引入碰撞风险面（碰撞 = 静默定位到错行，正是本缺陷的另一种形态） |
| 3 | `CC` 模式（`CcApp.js`）是否同病 | CC 走 `extractByAnchors` + `projection`，锚点语义不同 | 读 `ccMessageProjection.js:833-890`，实测 CC 下流式拖选 | ⬜ 未核 |
| 4 | `Preview` 布局 + 拖到边缘自动滚动（A-09）叠加时的行为 | 自动滚动**故意**改 `offset`（`App.js:1576`），可能与重定位互相干扰 | 扩展探针加 D-06：手势中途触发 A-09 自动滚动 | ⬜ 未核 |
| 5 | ~~`KHY_SELECT_FP` 新 env 是否需要登记~~ | **已核实，结论：不新增 env** | 见第二期说明 —— `check-tui-gates.js:32` 的 `MAX_GATES=220` 只降不升，且 `selectGates.js:18` 明写「别合并」；本修复不需要门，回滚靠 `fp` 可选参数 | ✅ 已结案 |
| 6 | ~~第二期前必须确认：CI 是否全量跑 `tests/**`~~ | ~~若 CI 全量跑，D-02 / D-04 两条**故意红**的探针会让流水线变红~~ | — | ✅ **已核实并处置**，见 §8.1 |

---

## 9. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-23 | 首版。基于 `selectionAnchorDrift.test.js` 的实测（D-02 / D-04 红）撰写 |
| 2026-09-23 | 同轮：`selection.js` 头部「已知偏差」补第 2 条（锚点漂移），此前只登记了软换行 |
| 2026-09-23 | 核实 `check-tui-gates.js:32`（`MAX_GATES=220` 只降不升）与 `selectGates.js:18`（「别合并」）
⇒ **删除原拟的 `KHY_SELECT_FP` env**，改为靠 `fp` 可选参数提供回滚。
此举保住了 B-P1 豁免（无新增配置键），并把 §8 待核实项 5 结案 |
| 2026-09-23 | **第一期落地**。`selection.js` 新增 `relocateLine` / `relocateSelection` / `extractTextRelocated` 三个纯函数 + `_anchor()` / `_fp()` 规范化；`beginSelection` 收可选 `fp`。新建 `selectionRelocate.test.js`（17 条全绿）。**四处偏离原案**（`relocate` 签名 / 不做 `seq` / 不做 hash / 第 2 档重定义）已在 §4 第一期「偏离说明」逐条给原因，并把 §8 第 1、2 项结案 |
| 2026-09-23 | **基线订正**：§7.2 的「60 条」改为实测 **57 条**（初稿是估值，未逐文件跑） |
| 2026-09-23 | 新增 §8 待核实项 6（CI 是否全量跑 `tests/**`）—— 两条故意红的探针可能影响流水线，**标记为第二期前的优先项** |
| 2026-09-23 | **§8-6 当场结案**（不留待核实项）：新增 **§8.1** 记录实测结论 —— 探针会被 `test:node` 扫到、被 jest 排除（无双 runner）、pr-gate 的 `test-baseline` job 当前 `continue-on-error` **不会卡 PR**；但该 job 的升级目标是「失败清零后转阻断」，故按本仓约定在 **`tests/DEBT.md` 新增 §十一**登记（`@bug`，截止 ≈2026-12-23）。同时核实 `check-debt-ledger.js` 管的是另一份台账，与之无涉 |
