# [DESIGN-ARCH-119] 逐 hunk 拆分提交 — 进度与阻塞

生成时间：2026-09-18 12:40
基线：`1e35ee0a` → 现有 5 个提交

---

## 一、已落地（5 个提交，每个都跑过该步测试）

| 提交 | 步骤 | 内容 | 测试 |
|---|---|---|---|
| `07e01323` | 步骤 1 判据收窄 | `mouseButtons.js` +98：拆 `isShift/isAlt/isCtrl`、前置放行、press/release 条件性吞、改头部错误断言 | 8/8 |
| `f1763c2d` | 2a 选择模型 | `selection.js`（12 个导出）+ 验收标准文档 + `selection.test.js` | — |
| `dcb05c86` | 2b-0 档位/通道 | 三档 `mouseTier()`、`enableBytes({select})`→`1002`、`onWheel`、未知终端不接管 | 26/26 |
| `a2748b35` | 2b-1 渲染 | `Viewport` 可选 `selection` prop（三段 `Text`、中段 `inverse`），不传时逐字节不变 | 29/29 |
| `7f7ea242` | 2b-2 之一 调度层 | `createMouseDispatcher.onSelectEvent`（`down/move/up/cancel`），缺省回调逐字节不变 | 68/68 |

`2b-2` 拆成两次：调度层（已提交）+ App.js 接线（阻塞，见第三节）。

### 技术手法：行级精确重建

从 `git show HEAD:<file>` 出发，按 `-U0` hunk 子集重建每个中间态，
`node --check` 验语法 → 换盘 → 跑该步测试 → 提交。
重建器末态与工作区**字节一致**（`IDENTICAL`），证明拆分无损。

两个踩过的坑（值得记住）：

1. spec 里 `"all"` 是**字符串**，若按对象读 `s.add` 会静默不加行 ——
   表现为「选中了 11 个 hunk 却只加了 7 行」。
2. 纯插入 hunk（`@@ -107,0 +118,7 @@`）插入点在旧行 `h.a` **之后**，
   要复制到 `h.a` 为止；替换型 hunk 复制到 `h.a-1`。差一行会让整体错位。

### 一处必要的测试调度

`mouseNativeSelection.test.js` 的 **R7/R8** 断言「滚轮走 `onWheel`」，
属于 2b-0 能力 ⇒ 步骤 1 先提交裁剪版（8/8 绿），2b-0 再补回（9/9 绿）。
新文件用「先缺后补」两版提交，比改测试归属更省事。

---

## 二、hunk → 步骤 归属表（`mouseButtons.js`，31 个 U0 hunk）

| 步骤 | hunk 编号 |
|---|---|
| 步骤 1 | 1, 2, 19, 21, 22, 23(部分), 24, 25(部分), 26, 27, 28 |
| 2b-0 | 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15(部分), 17, 18, 30, 31 |
| 2b-2 | 15(部分), 16, 20, 23(部分), 25(部分), 29 |

hunk 内部再切的三处：`#15`（`onWheel` 归 2b-0 / `onSelectEvent` 归 2b-2）、
`#23`（`return false` 归步骤 1 / `fireSelect('down')` 归 2b-2）、
`#25`（`const item` 归步骤 1 / `fireSelect('up')` 归 2b-2）。

---

## 三、⛔ 阻塞：检测到并发写盘（正在进行时）

| 时刻 | 事件 |
|---|---|
| 12:21 | 我写入 `mouseButtons.js`（S2B0 中间态） |
| 12:26 | 新建 `services/backend/src/cli/tui/utils/selectGates.js` |
| 12:27 | 重写 `ink-components/App.js`，**并转成 CRLF** |
| 12:28 | 改 `ink-components/ccMessageProjection.js` |
| 12:38 | 往 `mouseButtons.js` 加 21 行 |
| 12:39 | 那 21 行又被撤回（文件回到与 HEAD 一致） |

证据链：

- `.gitattributes` 不管 `.js`，`core.autocrlf=false`，HEAD 版 `App.js` 是 LF、
  工作区是 CRLF（6521 处）⇒ `git diff` 把整个文件当成 6521 行重写，退化成 1 个 hunk。
- 工作区 `App.js` 第 152 行出现备份副本里没有的
  `// 三个门控(KHY_SELECT / _CLIP / _DRAG)的真源已提到 utils/selectGates.js`。
- `flagRegistry.js` 的 `KHY_SELECT_*` 从**文档写的 4 个**
  （`_COPY_ON_RELEASE` / `_WORD_BOUNDARY` / `_MAX_BYTES`）变成**实际 3 个**
  （`_CLIP` / `_DRAG`）—— 有人在改 119 的门控设计。

**结论**：有另一个进程正在改同一批文件，且在 1 分钟内加完又撤回，
说明它尚未收敛。此时提交 `App.js` 会把别人的半成品 + 6521 行 CRLF 空白改动一起入库。

---

## 四、剩余待办

| 项 | 文件 | 状态 |
|---|---|---|
| 2b-2 之二 | `ink-components/App.js`（13/81 hunk 属 119） | **阻塞**：并发写入 + CRLF 污染 |
| 2b-2 之三 | `services/flagRegistry.js`（`KHY_SELECT_*` 在 hunk #8，2840–2851 行） | 门控数量已被并发改动，等收敛 |
| 步骤 3 | `tui/AGENTS.md`、`[DESIGN-ARCH-119]`、`[DESIGN-ARCH-101]` §8、`[DESIGN-ARCH-102]` §6.2、`00_INDEX` | 待前两项落定后收口 |

`App.js` 的 119 hunk 集合（U0 编号）：
`3, 4, 21, 22, 23, 24, 25, 26, 27, 64, 67, 73, 74`
其余 68 个 hunk 是启动屏（ARCH-115）、Preview 布局、最近模型对账、IME 守卫、
redpass、checkpoint、Auth FormFlow 等 8 项无关工作。

---

## 五、可回滚保障

- 分支 `backup-workspace-20260918` + 标签 `backup-workspace-20260918-tag` → `40791a3e`
- 物理副本 `D:/Portable/BuildArtifacts/khy-os-工作区备份-2026-09-18`
  （其中 `App.js` 是 **LF、6501 行**，可用于还原 CRLF 污染）
- 5 个新提交均未推送，可随时 `git reset --soft 1e35ee0a` 回退
