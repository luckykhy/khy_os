# TUI 重构细化执行计划（小模型可执行版）

规则真源 = `[DESIGN-ARCH-102]`（H1–H10），设计说明 = `[DESIGN-ARCH-103]`。
**执行纪律（每步必须遵守）**：
- 每个任务 = 独立 PR 级改动；完成标准里写了「验收命令」，跑绿才算完成。
- 代码注释/标识符用英文；用户可见字符串用中文；2 空格缩进、单引号、分号。
- 每个任务完成后跑：`node --check <改动的每个 .js 文件>` 不报错。
- 不得删任何现有 key handler / 组件导出（防功能回退）。

## Step 0 — 基线与验证脚本（已实测，供引用）
- TUI 套件：`cd services/backend && node scripts/run-ink-tui-tests.js` → 基线 **430/435 通过，4 个失败**（全部在 `tests/tui/inkRenderSmoke.test.js`，属文档要求的「陈旧断言」）：
  1. L1383/L1408：`buildSpinnerMeta(90,…)` 期望 `' · 1m 30s · ~1.2k tok'`，实际 `' · 1m · …'`（`ccFormat.ccFormatDuration` 的 `mostSignificantOnly` 取 `1m`；CC 真实 parity 是 `1m 30s` → 改实现，见 Step 8）
  2. L1494：断言 spinner 停帧含 `'等待响应'`，实际已合规为 `'⏳ 等待中 · 执行工具…'` → 改测试断言
  3. L1691 rail on App 帧：`FooterBar` 第 2 行/带外 rail 行超出 `contentCols(150)`（楼梯残影，根因 B）→ 由 Step 7/9 修
- `string-width@5` 可直接 `require('string-width')`（已验证存在于 backend node_modules）。
- `terminalCapabilities.js`（tui/runtime/，147 行）已存在，导出 `{detectCapabilities, invalidateCache}`，直接复用，不新建。

---

## Step 1 — P0-1 新增 `tui/effectiveDims.js`（唯一尺寸真源，H8）
**新建** `services/backend/src/cli/tui/effectiveDims.js`，API（全部纯函数，零 process 直读）：
```js
stickyCols(env)            // 读 process.stdout.columns 的唯一地点；沿用现有 effectiveCols.js 的三态 stickyDim 规则
stickyRows(env)            // 同上，读 process.stdout.rows；fallback 统一 sidebarLayout.fallbackRows(env)
contentWidth(colsArg=null, env)   // colsArg 为 null 时用 stickyCols；rail 激活 → sidebarLayout.mainColumnCols；否则全宽
contentHeight(rowsArg=null, env)   // rowsArg 为 null 时用 stickyRows
bandCols(cols, wasActive, env)     // R1-2 带宽：进入需 >=120、退出需 <=108（双阈值死区）；带内值量化到 4 的倍数
```
**改造** `tui/effectiveCols.js`（118 行）：文件内容改为
```js
'use strict';
const m = require('./effectiveDims');
module.exports = { effectiveCols: m.contentWidth, stickyCols: m.stickyCols, _resetStickyColsForTest: m._resetStickyForTest };
```
（导出名不变，`tui/` 内所有 `require('../effectiveCols')` 调用点零改动）
- 现有 `effectiveCols.js` 里的 `_lastValidCols/_lastRailActive` 缓存逻辑**迁入 effectiveDims.js 内部**，保留同一语义（conpty 抖动序列 120→undefined→120 取值稳定）。
- **验收**：新建 `tests/cli/tui/effectiveDims.test.js`：抖动序列 `['120', undefined, '120', '0', '119']` 逐次调用 stickyCols/stickyRows，断言稳定值不变、0 视为 garbage 回落上一有效值；断言 `bandCols(119,false)` 与 `bandCols(118,false)` 的 contentWidth 相同（死区）。跑 `npx jest tests/cli/tui/effectiveDims.test.js`（在 backend 目录）绿。

## Step 2 — P0-4 新增 `tui/wrapCell.js`（折行+计费同一函数，H6）
**新建** `tui/wrapCell.js`：
```js
wrapCell(text, width)        // → string[]；词边界折行；CJK 字符按显示宽度 2 计量（用 require('string-width')）；
                             // 单字符显示宽 > width → 独占一行不丢字符；宽度<=0 → 每字符一行
visualRows(text, width)      // = wrapCell(text, width).length（同一函数，构造性保证）
fitBorder(width, {left='╭', right='╮', mid='─'}) // 返回 display-width === width 的边框行（用 string-width pad；width<2 → left+'─'*0+right 兜底）
visWidth(s)                  // string-width 封装（fallback 到 s.length）
```
- 实现说明（给执行者）：宽度计量直接 `const sw = require('string-width')`；折行按 unicode code point 迭代（`[...text]`），每个字符宽度 = 该字符的 string-width；累加超 width 就切段。CJK 双宽由 string-width 天然处理。
- **改造** `tui/ink-components/ToolLines.js`：`estimateLiteralRows`（L855）中对结果体文本行数的手写估算（经 `_toolLiteralOutputMemo.memoPreview`/`memoFoldedLines` 的计数路径）改为调用 `wrapCell.js` 的 `visualRows(line, 0 /*列宽排除，折叠行是预截断的*/)`——**保持现状行为不变**（折叠行预截断，1 逻辑行=1 视觉行；本步只把「未来宽度感知」的计费口换成 visualRows，当前传 0 时 visualRows 退化回 split('\n').length，行为字节不变）。
- **验收**：新建 `tests/cli/tui/wrapCell.test.js`：`visualRows(t,w) === wrapCell(t,w).length`（30 组含 CJK/emoji/ASCII）；`fitBorder(80)` 的 visWidth===80；`wrapCell('abc',3)`===['abc']、`wrapCell('abracadabra',4)` 前两段 <=4 宽。

## Step 3 — P0-5 新增 `tui/chromeBudget.js`（chrome 单一账本，H1）
**新建** `tui/chromeBudget.js`：
```js
chromeRows({inputRows=1, statusRows=1, toastRows=0, messageBarRows=0, agentTreeRows=0, streamingRows=0, slack=2})
   // = 各项相加
liveBudget(rows, shares={}) // = clamp(rows - chromeRows(shares) - 1, 3, rows)
```
**改造 3 个旧函数为薄转发**（行为对齐：数值公式逐一对平后改实现）：
- `tui/utils/ccLayout.js` 的 `messageAreaCap(cols, rows, shares)`（L~170）：内部改为 `chromeBudget.liveBudget(rows, {inputRows: shares.inputRows, ...})`，但**保留 logoRows 的 CC 专属项**——做法：`chromeBudget` 增加可选 `extraRows` 参数，CcApp 调用时传 logoRows。若对平后数值不一致，以「帧高 ≤ rows-1」为准取较小预算（保守方向）。
- `tui/ink-components/liveRegionBudget.js` 的 `resolveStreamReserve`（L~80）：把其中 `BASE_CHROME` 常量计算段替换为 `chromeRows({inputRows:1, statusRows:1, slack:2, ...})`，toolRows/siblingHeight/footerExtra/winMargin 作为 `extraRows` 传入。
- `tui/railLayout.js` 的 `railBottomChrome`（L~190）：改为 `chromeRows({inputRows:1, statusRows:1, slack:2})`（保持默认值 2 不变）。
- **验收**：新建 `tests/cli/tui/chromeBudget.test.js`：① 随机 100 组 shares+rows 断言 `liveBudget ≤ rows-1`；② 断言 `ccLayout.messageAreaCap(100, 40, {inputRows:3, toasts:2}) === chromeBudget 对应值`（先跑对平测试，不一致就修公式再对齐）。

## Step 4 — P0-3 重写 `PromptFrame.js`（边框等宽 H4 + 唯一取数 H8）
**改造** `tui/ink-components/PromptFrame.js`（487 行），逐点：
1. L~247 `const cols = effectiveCols(80);` → **删除**；改为 props：`PromptFrame({ ..., width = 80, rows = 24 })`，`width` 为 contentWidth。父组件传入（见 Step 5）。
2. L~249 `const border = '─'.repeat(Math.max(1, cols - 1));` 与 L~263 MIC 变体的 `'─'.repeat(Math.max(1, cols - 1 - 5))` → **全部删除**，改为：
   ```js
   const topBorder = fitBorder(width, { left: '╭', right: '╮' });
   const botBorder = fitBorder(width, { left: '╰', right: '╯' });
   ```
   两条边框同函数产出（fitBorder 来自 `tui/wrapCell.js`）。
3. MIC 按钮（L~252–266 micButton/topBorder 组合）：MIC 从顶边框行**移出**，放到输入行内：第一行布局 `marker('❯ ') + [MIC button] + text`，顶/底边框保持完整 `width`。
4. L~277 `const vrows = process.stdout.rows && ... ? ... : 24; const maxRows = Math.max(4, vrows - 10);` → **删除**，改为 `const maxRows = Math.max(3, Math.min(10, Math.floor(rows / 3)));`（rows 来自 props）。
5. busy 态（L~248 `borderColor = busy ? undefined : accent||'cyan'` 与 `dimColor: busy`）→ 边框颜色**恒为** `accent || 'cyan'`；busy 只改左侧 gutter：边框 mid 字符 `'─'`→`'╌'`（fitBorder 加 `{ busy }` 参数切换 mid）。
6. dev 断言（模块尾，`if (process.env.NODE_ENV !== 'production')`）：`assert(visWidth(topBorder) === width && visWidth(botBorder) === width)`（用 wrapCell.js 的 visWidth；断言失败 `process.stderr.write` 一行，不 throw——ink 渲染中 throw 会炸整树）。
7. 导出保留：`PromptFrame.layoutPromptRows / .wrapByWidth / .windowRows`（测试在用）。`layoutPromptRows({cols})` 形参名保留（内部改叫 width，签名不变）。
- **验收**：`node --check` 通过；新建 `tests/cli/tui/promptFrame.test.js`：渲染（`ink-render` 风格或直调 layoutPromptRows）断言顶/底边框 visWidth 相等且 = 传入 width，覆盖 `width ∈ {40,79,80,119,120,121,200} × 输入长度 {0,1,79,80,1000}`，busy=true/false 各一组。

## Step 5 — App.js 尺寸下发 + PromptFrame/Spinner props 接线（H8）
**改造** `tui/ink-components/App.js`：
1. resize effect（L3724–3811）内 `_resolveResizeCols`（L3708）保留，但在 render body（L5957 附近 layout 计算处、已有 `_resCols/_resRows`）追加：
   ```js
   const _contentW = _railContentCols /* 现有变量，等价 contentWidth */;
   const _frameRows = Number(_resRows) > 0 ? Number(_resRows) : sidebarLayout.fallbackRows(process.env);
   ```
   （App 已有 sticky 化的 `_resCols/_resRows`——本步**不新增** process.stdout 直读，只把现有序列结果向下传。）
2. PromptFrame 渲染处（搜索 `h(PromptFrame` 的所有调用点，约 2–3 处）：追加 `width: _contentW, rows: _frameRows`。
3. Spinner 渲染处（L5776 `h(Spinner, { label, dimColor })`）：补传 `stalled`/`detail`/`elapsedSec`/`tokens`——从 `query` 上取：`detail: query.statusDetail || ''`，`stalled: <现有 stalled 判定变量，若无则 `busy && !query.streaming && (Date.now()-_lastActivityRef>600)` 简化为传 false 起步>`，`elapsedSec: Math.floor(_nowTick / 1000)`。若取不到的字段传 undefined 即可（Spinner 有默认值）。
- **验收**：`node --check App.js`；跑 `node scripts/run-ink-tui-tests.js tests/tui/inkRenderSmoke.test.js` 中 PromptFrame 相关用例不回归（rail on 边框用例 L1662 会因 width 改 props 而变化——把该用例断言更新为「rail on 时边框宽 = contentCols(150)（不带 -1，fitBorder 精确到 width）」，与 Step 10 同批）。

## Step 6 — P0-6 鼠标三档 + 探测兜底修正（§6.2 / P6）
**改造** `tui/mouseButtons.js`（473 行）：
1. L148 附近 `autoDetectTerminal()` 的兜底 `return true; // 默认开启` → `return false; // 未知终端不接管`。四条已知分支（WT_SESSION / 已知 GUI TERM_PROGRAM / 已知 TERM 子串 / **conhost 现代检测**）保留 `true`。
2. 新增三档入口 `mouseTier(env)`：
   ```js
   // KHY_MOUSE = off | click | full，默认 click
   function mouseTier(env) {
     const v = String((env&&env.KHY_MOUSE)||'').trim().toLowerCase();
     if (v==='off'||v==='0'||v==='no') return 'off';
     if (v==='full') return 'full';
     if (v==='click'||v==='1'||v==='on'||v==='yes'||v==='') return 'click';
     return 'click';
   }
   ```
3. `mouseButtonsEnabled`（现有，读 `KHY_MOUSE_BUTTONS`）改为：`KHY_MOUSE_BUTTONS` 显式值优先（兼容旧 env），否则 `mouseTier(env) !== 'off' && autoDetectTerminal(env)`——注意：**click 档默认 true 时不再吞滚轮**（滚轮走 fireNative，见第 4 条），所以「默认接管」的风险由第 4 条消除。
4. `enableBytes({hover})`：`click` 档 → `'\x1b[?1000h\x1b[?1006h'`（现状）；`full` 档 → 追加 `\x1b[?1003h`；`off` → 不发。`createMouseDispatcher` 里滚轮事件（button 4/5，即 SGR `;4;`/`;5;`）→ 调 `onNative()`（fireNative）而不消费。
5. 探测结果写入 `runtime/terminalCapabilities.js`：在其 `detectCapabilities(stdout)` 结果对象加字段 `mouseTier: mouseButtons.mouseTier(process.env)` + `mouseAuto: autoDetectTerminal(process.env)`（在 terminalCapabilities.js 内 lazy require mouseButtons，防循环依赖）。
- **验收**：`tests/cli/tui/mouseButtons.test.js`（已有 299 行）跑通；追加断言：`mouseTier({KHY_MOUSE:'off'})==='off'`、`mouseTier({})==='click'`、`autoDetectTerminal({TERM:'weird'})===false`（回归断言未知终端不接管）。

## Step 7 — P0-2 rail union-clear + 默认改关（根因 B 消除）
**改造** `tui/railLayout.js`（481 行）：
1. `railGateOn`（L68–75）：`KHY_SIDEBAR_RAIL` **默认改 0**（opt-in）：`if (!(_on(env,'KHY_SIDEBAR_RAIL')||_off(env,'KHY_SIDEBAR_RAIL'))) return false;`——即未显式设置时 off；保留 `KHY_SIDEBAR` 总闸语义。
2. 新增 `unionGeom(a, b)` 导出：两几何 `{on,width,left,top,height}` 的擦除并集——`left = min(a.left,b.left)`、`width = max(a.left+a.height行宽…)` 取覆盖双方全部单元的矩形；任一方 on=false → 另一方。
3. `buildRailClear(geom)` 保持签名；`runtime/sidebarRail.js`（729 行）的 `onResize`（L670）：
   ```js
   const prev = _state.lastGeom; const next = railLayout.railGeometry(cols, rows, env, opts);
   _writeRaw(railLayout.buildRailClear(railLayout.unionGeom(prev, next)));
   ```
   即**擦并集**（旧残片 + 新残片都擦），再 paint next。
4. 删除无消费者容差（railLayout/sidebarLayout 内）：`KHY_SIDEBAR_ZOOM_TOL`（`classifyResize` 内 tol，保留 classifyResize 函数但 tol 固定 0.15 默认，删 env 读取）、`KHY_SIDEBAR_FULLSCREEN_TOL`、`KHY_SIDEBAR_STACK_MAX_RATIO`、`KHY_SIDEBAR_HYSTERESIS`（hysteresis 由 Step 1 的 `bandCols` 双阈值替代；`railActiveHysteresis` 函数保留但改为调用 bandCols 死区逻辑）。
   **注意**：删 env 读取前先 `grep -rn "KHY_SIDEBAR_ZOOM_TOL" src/ tests/` 确认无其他读者，有读者就保留读取、只改默认。
- **验收**：`tests/cli/tui/railLayout.test.js`（已有）更新默认断言（rail 默认 off）；跑绿。

## Step 8 — 修 4 个陈旧测试（文档 §6 明确要求随改造一并修）
**改造** `tests/tui/inkRenderSmoke.test.js`：
1. L1383/L1408 `buildSpinnerMeta(90,…)`：改**实现**而非测试——`src/cli/ccFormat.js` 的 `ccFormatDuration(ms, {mostSignificantOnly})`：`mostSignificantOnly` 仅在 ms < 60_000 时取单一最大单位；**≥ 60s 时输出 `1m 30s` 形式（最大单位+次大单位）**。先读 ccFormat.js L44 现状再改（改动最小化：把 mostSignificantOnly 的截断逻辑改为「保留最大两位非零单位」，且 90s→`1m 30s`、125s→`2m 5s`、90s tokens 1234 不变）。**若 ccFormat 有别的调用点依赖单一单位**，grep `ccFormatDuration` 全部调用点，逐个核对，必要时给 Spinner 路径传新 option。
2. L1494 `Spinner flags a stall with 等待响应`：断言 `toContain('等待响应')` → `toContain('⏳ 等待中')`（实现已是合规文案，测试陈旧）。
3. L1691 rail on App 帧超宽用例：由 Step 7（rail 默认关，显式 `KHY_SIDEBAR_RAIL:'1'` 才激活）+ Step 4/5（边框精确 contentWidth 不再 -1）修复后重跑；该用例断言 `over` 为空的逻辑保留，若仍超宽，定位超出行来源（大概率 FooterBar 第 2 行）→ 由 Step 9 修 FooterBar 后重跑。
4. 同时检查 `tests/tui/ccFormat.test.js`、`toolResultTransparency.test.js`、`diffLineNumbers.test.js` 是否也有失败（当前 430/435 只 4 个失败，都在 inkRenderSmoke；这三个文件当前是通过的，**不要动**，文档说的笔误可能已修过）。
- **验收**：`node scripts/run-ink-tui-tests.js` 从 430/435 → **435/435**（与 Step 4/5/7/9 联动，最后统一跑）。

## Step 9 — P2 视觉收敛（删 Topbar 交通灯 / FooterBar 单行 / 状态栏）
**改造**（逐文件）：
1. `tui/ink-components/Topbar.js`（37 行）：删除交通灯 `● ● ●`——渲染内容改为单行 `Khy · <title>`；保留导出（App 可能有 import，grep 确认调用点，删调用处则整个文件删）。
2. `tui/ink-components/FooterBar.js`（241 行）：现状 2 行 → 第 2 行（`[auto · 中强度] 634.9MB · pid:… 0% ctx`）合并入第 1 行；总高恒 1 行（102 §C11）。保留 `buildContextStatus/formatModelLabel` 导出。
3. `tui/ink-components/Statusbar.js`：保留（三栏用 1 行状态条，与合并后 FooterBar 同源数据）。
4. **验收**：`node --check`；跑 inkRenderSmoke 中 FooterBar 相关用例（grep `FooterBar` 在测试里的断言，行高断言从 2 改 1）。

## Step 10 — P2 宽度公式单源 + `ccLayout.sidebarWidth` 删除（§4.2 分歧消除）
**改造**：
1. `tui/utils/ccLayout.js`：`sidebarWidth(cols)` 删除导出；`getLayout` 内部改为 `require('../sidebarLayout').sidebarWidth(cols)`；`shouldShowSidebar(cols)` 改为 `cols >= require('../sidebarLayout').minCols(process.env)`。导出对象里去掉 `sidebarWidth`。
2. **验收**：`tests/cli/tui/ccLayout.test.js`（258 行）更新：断言 `require(ccLayout).sidebarWidth === undefined`（102 §4.2 判据原文）；`getLayout(120).sidebarWidth === 24`（sidebarLayout 公式 `clamp(round(120×0.16),24,36)`）而非 30。grep `ccLayout.*sidebarWidth\|sidebarWidth.*ccLayout` 全仓（含 tests）确认无其他直接调用者，有则逐个改。
3. `hooks/useSidebarState.js:12` 的 `shouldShowSidebar` import 保留（函数还在，语义变）。

## Step 11 — P1 可折叠模型 + 行高签名（H5）+ 点击展开
**新建** `tui/foldModel.js`（纯叶子）：
```js
makeFoldItem({id, kind, text, width}) // → {id, kind, collapsedRows:1, expandedRows: visualRows(text,width), expanded:false}
lineHeightSignature(item) // = `${kind}:${item.expandedRows}:${item.expanded}` —— 字符串签名，展开态变化签名必变
toggle(item) // item.expanded = !item.expanded
```
**新建** `tui/foldLongLines.js`：
```js
foldLongLines(text, {limit=1000, width}) // → {lines: string[], folded: {count, hint}}
// 规则（dsh-TUI 同款，102 §4.5 四条硬约束）：
// ① 逐行处理（保留 \n 行边界）；行 displayWidth ≤ limit 且 ≤ width → 原样（零分配快路径：直接返回原数组）
// ② 超长行 → 截到 width 的整数倍（不劈半个显示宽），尾部提示 `… 已折叠 N 字符（点击或 Ctrl+O 展开）`
// ③ 代理对（surrogate pair）不劈半——按 [...line] 迭代再 join
```
**接线**：`ink-components/ToolLines.js` 工具卡片行（折叠态恒 1 行的摘要行 L~700 一带）：渲染函数计算 `const sig = foldModel.lineHeightSignature(item)`，把 `sig` 写进行对象；`hook/queryBridgeTimeline.js`（1144 行，负责把工具事件变行）里按 sig 变化触发重算。鼠标点击命中展开：`mouseButtons.createMouseDispatcher` 的 `onInput` 收到 click 后，App.js 的 mouseDispatcherRef 回调（L4049 起）里，若命中行的行对象有 `foldItem` 字段 → `foldModel.toggle(item)` 触发 setState 重渲（App 里 `expanded` state 已存在，L~ 找 `const [expanded, setExpanded]` 复用）。
- **验收**：新建 `tests/cli/tui/foldModel.test.js`：`item.expanded=false → sig1`；`toggle(item) → sig2 !== sig1`（回归断言 H5）；`foldLongLines` 1000 组随机文本断言「折叠后每行 displayWidth ≤ width 或为提示行」、代理对文本不劈半。

## Step 12 — P2 门控收敛 213 → ≤40 + `check-tui-gates.js`（H7）
1. **新建** `scripts/ci/check-tui-gates.js`（仓库根 scripts/ci/，与 check-agent-rules.js 同目录）：
   ```js
   // 1. 正则 KHY_[A-Z0-9_]+ 扫 services/backend/src/cli/tui/**/*.js（排除 .test.js、tests/）
   // 2. 去重计数；> 40 → exit 1 并列出超出 token
   // 3. 白名单常量 ALLOWED = [ ...≤40 个... ]（首版：把当前全部 token 拷入，后续 Step 删除时同步删白名单）
   ```
   接入 3 处（已探明机制）：根 `package.json` scripts 加 `"check:tui-gates": "node scripts/ci/check-tui-gates.js"`；`check:structure` 链尾追加 `&& npm run check:tui-gates`；`.github/workflows/pr-gate.yml` 加一步（照 :101 check-gov-rules 的写法）。
2. 收敛策略（**只做已验证 0 消费者的删除**，每删一个跑一次 check 计数）：
   - 已验证 14 个 App 专属 token 中，纯历史兼容且 App 内读处只喂给「默认值判断」的优先删：先 `grep -rn "KHY_<TOKEN>" src/`（全 backend）确认 0 读者再删。每删一个，把该读处的默认行为固化为代码常量。
   - 目标 40：保留平台差异类（KHY_TERM_*）+ 能力开关类（KHY_MOUSE、KHY_SOFT_WRAP、KHY_GHOST_BORDER）+ 高频行为门控；其余按 0 读者原则删。
   - **禁止**为凑数删有读者的门控（会改行为 → 回退风险）。若删完 0 读者 token 仍 >40，把白名单暂时定在实测值并登记「差距 N 个」，不强行删。
- **验收**：`node scripts/ci/check-tui-gates.js` exit 0；`npm run check:structure` 过。

## Step 13 — P2 看板收敛（4 tab → 2 段 + 3 参数）
**改造** `tui/ink-components/RightPanel.js`（三栏布局用的看板，非 rail）：
1. L20–25 `TABS` 4 项 → 2 段：`任务`（plan+tasks 合并段）/ `上下文`（模型·上下文·权限·桥接状态，对齐 102 §4.7 示意）。「终端」「文件」两段内容保留为 `/terminal`、`/files` 覆盖层路由（App.js 的 slash 命令注册处 grep `'/files'` 找到命令表，加两条命令指向现有 ShellView/文件列表组件；若 slash 命令注册在 router.js 则在 router 层加，**不新造渲染组件**，复用现有 ShellView）。
2. 完成项折叠：任务段内已完成项默认渲染为 1 行 `✓ N 已完成（点击展开）`，展开逻辑走 Step 11 的 foldModel（kind:'task'）。in_progress 行加 `formatDuration`（复用 `ToolLines.formatToolDuration`）。
3. 3 参数：`tui/tuiConfig.js`（新建，读 `~/.khyquant/tui.json`，fail-soft：文件不存在/损坏 → 全默认值）导出 `loadTuiConfig()` → `{sidebar: {width:'auto'|'narrow'|'wide', tab:'tasks', minCols:120}}`；`sidebarLayout.minCols`/`sidebarWidth` 优先读 tuiConfig，env 作 fallback。
- **验收**：`node -e "console.log(require('./src/cli/tui/tuiConfig').loadTuiConfig())"`（backend 目录）输出默认值；RightPanel 单测（grep tests 里 RightPanel 用例）更新 2 段断言。

## Step 14 — P2 语义色 token（§4.6）
**改造** `tui/theme/ccTheme.js`（98 行）：
```js
SEMANTIC = { accent, muted, success, warn, danger, border, focus } // name → 现 CC_COLORS 对应值
resolvePalette(env) // NO_COLOR → 全灰阶 7 token；CLICOLOR_FORCE → 彩色；colorDepth<8（terminalCapabilities.colorDepth）→ 16 色映射；否则 truecolor
```
现有 CC_COLORS 保留（别名转发到 SEMANTIC 的对应值，组件 import 不变）。
- **验收**：`NO_COLOR=1 node -e "…resolvePalette"` 输出零 hex 彩色（全 `'#808080'` 类灰阶）；`tests/cli/tui/` 无 ccTheme 用例就新建一个。

## Step 15 — 全量验证
1. `cd services/backend && node scripts/run-ink-tui-tests.js` → 435/435（或超出基线新增用例全绿）。
2. `npx jest tests/cli/tui` → 全绿。
3. `node scripts/ci/check-tui-gates.js`（根目录）exit 0。
4. `node scripts/ci/check-agent-rules.js --changed`（根目录）过（零硬编码/状态文案/滚动区红线）。
5. 手工冒烟：`node services/backend/bin/khy.js` 进 REPL，宽终端（≥120 列）验证看板 2 段、resize 120→80→200 无残影、Ctrl+O 展开、输入框边框等宽。

## 明确不做（防范围漂移）
- P3：cell-diff 渲染器、UI/业务线程分离、App.js 三区拆分、rail 彻底删除（KHY_SIDEBAR_RAIL=1 逃生舱保留）。
- `replSession.js`（13453 行）不动。
- ccFormat 单单位语义若被其他调用点依赖，只改 Spinner 路径的 option，不动全局默认。

## 与文档不一致 / 需确认
1. 门控 213→40 实际可达度取决于 0 读者 token 数量；若删完仍 >40，白名单暂放实测值并登记差距（不强行删有读者门控）。
2. `ccFormatDuration(90s)` 的 `1m 30s` 改法需先 grep 全部调用点确认无依赖方；若 Desktop 前端共享该函数，改动面要评估。
3. 键盘全功能（键位表 102 §6.1）全部保留不动；本计划只加不改键位语义。