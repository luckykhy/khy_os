# [DESIGN-ARCH-086] CC TUI 复刻总计划与子任务跟踪

> **隶属**：本文属 **TUI 设计族**（20 编号 / 21 文件），总纲与 scope 裁决见 `[DESIGN-ARCH-122] TUI 设计族总纲`；规则冲突一律以 `[DESIGN-ARCH-102] Khy TUI 统一规则手册` 为准。

> ## 📌 规则条款的归属已变更
>
> 本文包含的**规则性条款**（复制反馈文案、滚动指示器、Toast 时长、任务看板形态等）已收口至 **`[DESIGN-ARCH-102] Khy TUI 统一规则手册`**：微交互与反馈 → 102 §6.5；键盘 → 102 §6.1；组件 → 102 §5；看板 → 102 §5 C17。
> **本文保留其自身职责**：CC 复刻工程的**总计划与子任务跟踪**（Phase 划分、验证清单、风险登记、变更记录）——这部分 102 不管，仍以本文为准。
> **规则冲突一律以 102 为准；任务排期以本文为准。**

> **定位**：CC TUI 复刻工程的**总计划文档**，汇总所有子设计文档，跟踪实施进度。
> **适用边界**：`services/backend/src/cli/tui/` 下所有 CC 模式相关工作的统筹。

---

## 0. 总览

### 0.1 目标

在 khy-os 中实现 Claude Code TUI 的 1:1 视觉与交互复刻，品牌替换为 Khy，同时：
- 全面支持 OpenAI 协议
- 保留 khy 特色功能（中文、过程组、计划模式、语音输入）
- 零破坏：Legacy 模式行为不变
- 性能：冷启动 < 100ms，渲染 < 16ms

### 0.2 子文档索引

| # | 文档 | 状态 | 优先级 | 完成度 |
|---|------|------|--------|--------|
| 081 | 主设计规范（品牌、OpenAI、MCP、性能） | ✅ 完成 | P0 | 100% |
| 082 | 输入框与光标设计 | ✅ 完成 | P0 | 100% |
| 083 | 表格与折叠设计 | ✅ 完成 | P0 | 100% |
| 084 | 注意力与选择设计 | ✅ 完成 | P1 | 100% |
| 085 | 子视图、子菜单、卡片与滚动 | ✅ 完成 | P1 | 100% |
| 087 | 微交互与反馈设计 | ✅ 完成 | P1 | 100% |
| 088 | 快捷键系统、Redo/Fork 与执行偏差处理 | ✅ 完成 | P0 | 100% |
| 089 | TUI 设计模式调研报告（100 项目） | ✅ 完成 | P0 | 100% |
| 090 | TUI 用户评价调研与痛点分析 | ✅ 完成 | P0 | 100% |
| 095 | TUI 交互完善调研与实施路线（089/090 之后的收口件：差距分析 + P0–P3 路线） | ✅ 定稿 | P0 | 100% |

---

## 1. 子任务跟踪

### 1.1 Phase 0: 基础约束（已完成）

| 任务 | 状态 | 验证方式 |
|------|------|----------|
| 环境变量门控体系 | ✅ | `KHY_CC_TUI=1` 门控检测 |
| 品牌替换（Khy） | ✅ | `ccBrand.js` 集中管理 |
| OpenAI 协议支持 | ✅ | 模型名/上下文/定价 |
| MCP 状态显示 | ✅ | 状态栏 + 详情面板 |
| 性能优化策略 | ✅ | Resize/渲染/计时器/启动 |

### 1.2 Phase 1: 核心视觉（已完成）

| 任务 | 状态 | 验证方式 |
|------|------|----------|
| 配色方案（青色系工具标识） | ✅ | `ccTheme.js` |
| 用户消息无背景框 | ✅ | 纯文本显示 |
| 助手消息 ● 前缀 | ✅ | `CcAssistantMessage.js` |
| 工具调用卡片（🔧 + 粗体青色） | ✅ | `CcToolCard.js` |
| 工具结果边框块 | ✅ | `┌─` / `└─` 边框 |
| 思考折叠块（▸/▾） | ✅ | `CcThinkingBlock.js` |
| 状态栏单行格式 | ✅ | `CcStatusLine.js` |
| 输入框无边框 + 光标 | ✅ | `CcPromptInput.js` |

### 1.3 Phase 2: 交互组件（已完成）

| 任务 | 状态 | 验证方式 |
|------|------|----------|
| 单选列表（▸ + 反显） | ✅ | `CcSelectableList.js` |
| 多选列表（[x]/[ ]） | ✅ | `CcMultiSelectList.js` |
| 权限提示（默认安全） | ✅ | `CcPermissionPrompt.js` |
| 消息提示（错误/警告/信息） | ✅ | `CcMessageBar.js` |
| 折叠组件（▸/▾） | ✅ | `CcCollapsible.js` |
| 表格组件（表头 + 对齐） | ✅ | `CcTable.js` |
| MCP 服务器表格 | ✅ | `CcMcpTable.js` |
| 命令面板（Ctrl+P） | ✅ | `CcCommandPalette.js` |
| 历史搜索（Ctrl+R） | ✅ | `CcHistorySearch.js` |

### 1.4 Phase 3: 高级功能（已完成）

| 任务 | 状态 | 验证方式 |
|------|------|----------|
| 视图栈管理 | ✅ | `ViewProvider.js` |
| 命令面板 | ✅ | `CcCommandPalette.js` |
| 历史搜索 | ✅ | `CcHistorySearch.js` |
| 任务完成卡片 | ✅ | `CcTaskCompleteCard.js` |
| 剪贴板（OSC 52） | ✅ | `ccClipboard.js` |
| 历史持久化 | ✅ | `ccHistory.js` |

### 1.5 Phase 4: 微交互与反馈（已完成设计）

| 任务 | 状态 | 验证方式 |
|------|------|----------|
| 复制字符提示 | ✅ 已落地 | `copied N chars` —— CcApp `handleCopyLast` 走 `ccFormatters.formatCopyFeedback` 单一真源（emoji 安全 code-point 计数，门控 `KHY_CC_COPY_TOAST`，`0` → 中文旧文案逐字节回退；2026-09-15） |
| 滚动指示器 | ✅ 已落地 | `⋯ (3 above)` —— `CcTranscriptView` 分页视口 + `CcScrollIndicators`（2026-09-12 接入，见变更记录） |
| 瞬态消息/Toast | ✅ | 3 秒自动消失 |
| Token 用量警告 | ✅ | 80% 黄色 / 95% 红色 |
| 上下文窗口警告 | ✅ | 接近上限提示 |
| 工具执行超时反馈 | ✅ | 超时 + 重试建议 |
| 流式输出中断反馈 | ✅ | `Interrupted` 提示 |
| 粘贴大文本反馈 | ✅ | `Pasted ~200 lines` |
| 大输出截断反馈 | ✅ | `... (truncated, 50 lines)` |
| 权限模式切换反馈 | ✅ | 模式变化 Toast |
| 双击 Ctrl+C 退出 | ✅ | 首次提示，二次退出 |
| 会话恢复提示 | ✅ | `Resumed from checkpoint` |
| 连接状态变化 | ✅ | 断开/重连 Toast |

---

## 2. 遗漏细节清单

### 2.1 复制反馈

| 场景 | 反馈 | 示例 |
|------|------|------|
| 复制字符 | `copied N chars` | `copied 42 chars` |
| 复制行 | `copied N lines` | `copied 3 lines` |
| 复制到剪贴板失败 | `copy failed (no clipboard)` | — |
| 复制 JSON | `copied JSON (1.2KB)` | — |

### 2.2 滚动指示器

| 场景 | 显示 | 示例 |
|------|------|------|
| 上方有内容 | `⋯ (N above)` | `⋯ (3 above)` |
| 下方有内容 | `⋯ (N below)` | `⋯ (5 below)` |
| 到达顶部 | 无指示器 | — |
| 到达底部 | 无指示器 | — |

### 2.3 瞬态消息（Toast）

| 类型 | 显示 | 持续时间 |
|------|------|----------|
| 成功 | `✓ Message` | 3s |
| 错误 | `✗ Message` | 5s |
| 警告 | `⚠ Message` | 4s |
| 信息 | `ℹ Message` | 3s |

### 2.4 工具执行反馈

| 场景 | 反馈 | 示例 |
|------|------|------|
| 执行中 | `⏳ Running...` | spinner |
| 超时 | `Timeout (30s)` | + 重试建议 |
| 重试中 | `Retrying (2/3)...` | — |
| 被中断 | `Interrupted` | — |
| 输出截断 | `... (truncated)` | + 行数 |

### 2.5 输入反馈

| 场景 | 反馈 | 示例 |
|------|------|------|
| 粘贴大文本 | `Pasted ~N lines` | `Pasted ~200 lines` |
| 粘贴图片 | `Image attached` | — |
| 输入过长 | `Input truncated to N chars` | — |
| 历史导航 | 显示历史条目 | — |

### 2.6 系统状态反馈

| 场景 | 反馈 | 示例 |
|------|------|------|
| Token 80% | 黄色警告 | `Context 80% (160k/200k)` |
| Token 95% | 红色警告 | `Context 95% (190k/200k)` |
| 连接断开 | 红色圆点 | `● Disconnected` |
| 重连中 | 黄色圆点 | `◐ Reconnecting...` |
| 权限模式变化 | Toast | `Switched to auto-edit mode` |

---

## 3. 实施路线图

```
Phase 0 ──────────────────────────────────────────────── ✅ 设计完成
  门控体系 / 品牌替换 / OpenAI / MCP / 性能策略

Phase 1 ──────────────────────────────────────────────── ✅ 设计完成
  配色 / 消息样式 / 工具卡片 / 状态栏 / 输入框

Phase 2 ──────────────────────────────────────────────── ✅ 设计完成
  选择列表 / 权限提示 / 折叠 / 表格 / 命令面板

Phase 3 ──────────────────────────────────────────────── ✅ 设计完成
  视图栈 / 剪贴板 / 历史 / 完成卡片

Phase 4 ──────────────────────────────────────────────── ✅ 设计完成
  复制反馈 / 滚动指示 / Toast / 工具反馈 / 系统状态

Phase 5 ──────────────────────────────────────────────── ✅ 设计完成
  快捷键系统 / Redo/Fork / 执行偏差处理

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  实施阶段（待开始）
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  组件编码 → 集成测试 → 性能优化 → 用户验收
```

---

## 4. 文件清单

### 4.1 设计文档

| 文件 | 路径 | 状态 |
|------|------|------|
| 总计划 | `docs/03_DESIGN_设计/[DESIGN-ARCH-086]` | ✅ |
| 主设计规范 | `docs/03_DESIGN_设计/[DESIGN-ARCH-081]` | ✅ |
| 输入框与光标 | `docs/03_DESIGN_设计/[DESIGN-ARCH-082]` | ✅ |
| 表格与折叠 | `docs/03_DESIGN_设计/[DESIGN-ARCH-083]` | ✅ |
| 注意力与选择 | `docs/03_DESIGN_设计/[DESIGN-ARCH-084]` | ✅ |
| 子视图/菜单/卡片 | `docs/03_DESIGN_设计/[DESIGN-ARCH-085]` | ✅ |
| 微交互与反馈 | `docs/03_DESIGN_设计/[DESIGN-ARCH-087]` | ✅ |
| 快捷键/Redo/Fork | `docs/03_DESIGN_设计/[DESIGN-ARCH-088]` | ✅ |
| 100 项目调研 | `docs/03_DESIGN_设计/[DESIGN-ARCH-089]` | ✅ |
| 用户评价调研 | `docs/03_DESIGN_设计/[DESIGN-ARCH-090]` | ✅ |

### 4.2 工程约束文件

| 文件 | 路径 | 状态 |
|------|------|------|
| CC TUI 工程约束 | `services/backend/src/cli/tui/AGENTS.md` | ✅ |
| 项目上下文 | `CLAUDE.md` | ✅ |
| opencode 配置 | `.opencode/config.json` | ✅ |

### 4.3 参考实现文件

| 文件 | 路径 | 状态 |
|------|------|------|
| CC 输入框 | `tui/ink-components/CcPromptInput.js` | ✅ |
| CC 折叠组件 | `tui/ink-components/CcCollapsible.js` | ✅ |
| CC 表格组件 | `tui/ink-components/CcTable.js` | ✅ |
| CC 选择组件 | `tui/ink-components/CcSelectable.js` | ✅ |
| CC 视图栈 | `tui/ink-components/CcViewStack.js` | ✅ |
| 剪贴板工具 | `tui/utils/ccClipboard.js` | ✅ |
| 历史管理 | `tui/utils/ccHistory.js` | ✅ |

---

## 5. 验证清单

### 4.1 功能验证

- [ ] `KHY_CC_TUI=1 khy` 启动后显示 CC 风格 UI
- [ ] Legacy 模式（无门控）行为与修改前逐字节相同
- [ ] 复制操作显示字符/字节数反馈
- [ ] 滚动时显示上下方内容指示器
- [ ] 瞬态消息 3-5 秒自动消失
- [ ] Token 用量 80%/95% 显示警告
- [ ] 工具执行超时显示重试建议
- [ ] 粘贴大文本显示行数反馈
- [ ] 双击 Ctrl+C 退出（首次提示）

### 4.2 性能验证

- [ ] 冷启动 < 100ms
- [ ] 热启动 < 50ms
- [ ] 渲染帧率 ≥ 30 FPS
- [ ] 输入延迟 < 16ms
- [ ] Resize 无残影
- [ ] 内存 < 50MB

### 4.3 兼容性验证

- [ ] OpenAI 模型名格式化正确
- [ ] 上下文窗口计算正确
- [ ] 费用计算正确
- [ ] MCP 状态显示正确
- [ ] 历史持久化正常
- [ ] 剪贴板 OSC 52 工作

---

## 6. 风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Ink 渲染性能不达标 | 中 | 高 | 虚拟化 + memoize + 批量更新 |
| 滚动/选择/历史冲突 | 中 | 高 | 模式状态机 + ED0 |
| 用户习惯阻力 | 高 | 中 | 默认关闭，显式 opt-in |
| 过程组功能丢失反馈 | 中 | 低 | `KHY_CC_TOOL_STYLE=0` 可恢复 |
| 模型跑偏无法恢复 | 低 | 高 | 检查点 + 用户引导 |
| OpenAI 协议兼容性 | 低 | 中 | 适配器模式 + 统一接口 |
| 启动速度不达标 | 低 | 高 | 延迟加载 + 并行初始化 |

---

## 7. 交叉引用

| 引用文档 | 关系 |
|----------|------|
| `services/backend/src/cli/tui/AGENTS.md` | CC TUI 工程约束（红线） |
| `CLAUDE.md` | 项目上下文（opencode 读取） |
| `.opencode/config.json` | opencode MCP 配置 |
| `docs/03_DESIGN_设计/EXECUTION_PROMPT.md` | **AI 执行提示词** |
| `docs/03_DESIGN_设计/[DESIGN-ARCH-079]` | TUI 界面设计规范（Legacy） |
| `docs/10_规范/[DESIGN-GOV-001]` | 治理总纲 |

---

## 8. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-09 | 初始版本，汇总 [081]-[085] 子文档 |
| 2026-09-09 | 新增 Phase 4 微交互与反馈任务清单 |
| 2026-09-09 | 新增遗漏细节清单（复制/滚动/Toast/反馈） |
| 2026-09-09 | 新增 [087] 微交互与反馈设计 |
| 2026-09-09 | 新增 [088] 快捷键系统、Redo/Fork、执行偏差处理 |
| 2026-09-09 | 新增 [089] 100 项目调研报告 |
| 2026-09-09 | 新增 [090] 用户评价调研与痛点分析 |
| 2026-09-09 | 修复路线图 Phase 4 状态不一致 |
| 2026-09-09 | 新增文件清单、风险登记、交叉引用 |
| 2026-09-12 | CcTranscriptView 接入 CcScrollIndicators + 分页视口滚动（PageUp/PageDown 半页翻页、g/G 顶/底跳转，走 scrollActions.applyScroll 单一真源）；修复 CcApp 快速连发时 Date.now() 消息 id 碰撞导致的 React duplicate-key 隐患（key 改用稳定下标 tv-idx）；CcScrollIndicators 顶层 inkRuntime.get() 改为惰性调用（避免 require 期报错） |
| 2026-09-12 | 软换行 [DESIGN-ARCH-079] §14 Phase 1：新增 `cli/softWrap.js`（KHY_SOFT_WRAP 门控，默认 off）——全宽散文段落交由 ink/终端原生软换行，复制不带硬换行符；代码块/表格仍精确硬折（调研确认 markdownRenderer 散文层本就不插硬折行，KHY_SOFT_WRAP 提供显式开关与语义锚点）。Ghost Border §14 Phase 2：新增 `cli/ghostBorder.js`（KHY_GHOST_BORDER 门控，默认 off）——用 CUP 光标定位 + DECSC/DECRC 保存恢复绘制边框字符，不占内容流（复制不带走框线，对齐 OpenCode）；sidebarRail._border 增加 ghost 分支，开启时右栏看板竖边改由 CUP 叠加绘制。验证：check-agent-rules 零违规；paintBytes 无 DECSTBM（滚动区红线）；off 状态逐字节 legacy 不变 |
| 2026-09-12 | 新增 [DESIGN-ARCH-095] TUI交互完善调研与实施路线：三路 GitHub 实地调研（终端能力与框架层 / opencode·crush·gemini-cli·codex·Claude Code 五款 AI 代理 TUI / lazygit·yazi·fzf·atuin·k9s·helix·btop 经典 TUI）综合本地基线（79 组件、280 门控、能力检测/发射矩阵）成文——给出 §3 差距分析（内联渲染纪律/IME/剪贴板/Copy Mode/滚动三态/Esc 分级/键位可配置/OSC 8 发射等）与 §4 P0–P3 实施路线 + 不采纳清单；本文档 §0.2 子文档索引已登记 095 行 |
| 2026-09-13 | 095 §4 P0-4 IME 组字上屏守卫落地（`imeCommitGuard.js` 共享纯叶子：全宽字符插入后 120ms 守卫窗内吞掉裸 Enter，防半截输入被提交）：四接线 useTextInput / CcPromptInput / App.js revSearch / 补全菜单；CcPromptInput 六修（shift+return 先于 return 判定修复死分支、astral 字素步进 `_prevStep/_nextStep`、dwidth 回退链接 textMeasure.visWidth、粘贴标记 ESC[200~/201~ 剥离、Vim x/dw astral 安全、Ctrl+W 删前词）；测试 imeCommitGuard.test.js + ccPromptInput.test.js 源级契约 |
| 2026-09-13 | 095 §4 P0-2 帧高纪律四子步落地：①`ToolLines.estimateLiteralRows`（完成态字面输出体行数估算，与渲染共用 memo，±diff/shell 折叠体/展开透明体/12 行预览帽逐分支同源）；②`liveHeightClamp.tailTimelineToVisualRows` 新增 `toolCostOf` 回调 + StreamingBlock 下传 `estimateToolEntryRows`（tool 条目从恒记 1 行改为真实渲染行计费，消 [IMPL-RPT-044]「同段输出重复多份」的 fullscreen 重绘诱因；门控 `KHY_TOOL_ROW_BUDGET`）；③`ccLayout.messageAreaCap` 份额算术 + CcApp 消息区尾窗 slice（尾窗超帽时 `⋯ 已收起上方 N 条消息（Ctrl+O 查看完整转录）` 截断诚实提示；门控 `KHY_CC_MESSAGE_CAP`）；④flagRegistry 登记（总数 475）。**顺带修复 CcApp 挂载即崩的 ReferenceError ×3**（estimateAllAgents/formatDuration 未 import、AgentTree/CcTranscriptView 裸引用未走 getAgentTree()/getCcTranscriptView() 懒加载器——KHY_CC_TUI=1 此前完全无法挂载，生产路径实渲染证实已修复）。测试：ccLayout.test.js 18/18（含 messageAreaCap 算术 6 例 + CcApp 源级契约 2 例）、liveHeightClamp.test.js 27/27（toolCostOf 计费/回退/超帽兜底 5 例）、toolEntryRows.test.js 从 mojibake 空壳恢复 14/14（DEBT.md §六同步除名） |
| 2026-09-13 | 095 §4 P1-2 启动进度条与状态文案合规化：`bootPhaseLine.js` 重写为 `write(text, step, totalSteps)` 签名（无分母时每 1s 刷新 elapsed「已等待 Xs」，有分母时静态「(step/total)」；`stopElapsedTimer` 在 clear/end 均触发，`elapsedTimer.unref()` 防阻塞退出）；`bin/khy.js` 5 处调用点改传 step/total=5；裸等待文案合规化（规则 2）：`noiseFilter.js` 11 条 RULES 全改走 `formatStatusMessage(action, target, progress)`；`replyGuard.buildRetryStatusLabel` 与 `toolUseLoopCore` 续接 label 无 counter 时补「(第 1 次)」。check-agent-rules 5 文件零违规 |
| 2026-09-13 | 095 §4 P1-1 剪贴板统一出口落地：`ccClipboard.js` 整体重写为全模式剪贴板服务（native 系统工具先行 + OSC 52 非 TTY 兜底 + TMUX/STY DCS passthrough + 100KB 上限 + CJK UTF-8 字节）；legacy `/copy`（handlers/copy.js）、`/share`（routerDispatchSlash.js）与 CC 模式（CcApp Ctrl+Y 复制最近助手回复 + CcPromptInput vim `y` 剪贴板双写 + 命令面板 `/copy` 项 + CcHelpMenu/keybindingCatalog 补 Ctrl+Y）三路全收敛同一出口；`copyReply.describeClipboardFailure` 新纯叶子按 reasons 出具修复建议文案（gate/native/osc52:tty/oversize/全空五分支）；flagRegistry 登记 5 门控（KHY_CC_CLIPBOARD/KHY_CLIPBOARD_OSC52/KHY_CLIPBOARD_DUAL/KHY_CLIPBOARD_PASSTHROUGH/KHY_CLIPBOARD_MAX_BYTES，总数 480）。测试：ccClipboard.test.js（node:test）20/20 + copyReply.test.js 13/13 + router.test.js 55/55 回归绿 |
| 2026-09-15 | 复制/Toast 反馈对齐 [DESIGN-ARCH-087] §1 CC 规范（今日单项，优先级④）：① 修复 `CcApp.js` `handleCopyLast` 的 **TDZ 崩溃**（`addToast`/`dismissToast` 声明晚于其使用点，CC 模式挂载即抛 `Cannot access 'addToast' before initialization`，整树白屏）——将 Toast 管理块前移至 `handleCopyLast` 之前；② `handleCopyLast` 复制回执改走 `ccFormatters.formatCopyFeedback` 单一真源（`copied N chars / N lines / N.NKB` CC 规范文案），门控 `KHY_CC_COPY_TOAST`（默认开=CC 文案；显式 `0` → 中文旧文案逐字节回退，零破坏）；③ 修 `ccFormatters.formatCopyFeedback`/`formatPasteFeedback` 的 emoji 过计数 bug——字符计数由 `text.length`（UTF-16 码元，`😀` 记 2）改为 `[...text].length`（code-point，`😀` 记 1），对齐 Claude Code CHANGELOG「copied N chars overcounting emoji」修正；④ `CcToast.js` 顶层 `inkRuntime.get()` 改惰性（与 CcScrollIndicators 同模式，消除 require 期抛错）。调研背书：[RESEARCH-001] TUI微交互调研（opencode 单槽替换 toast 5s、CC 带 N 计数 toast、bubbles list 行内 1s、KHY_* 门控默认=旧行为+`0`回退惯例）。验证：node --check 3 文件 OK；check-agent-rules 零违规；formatCopyFeedback 纯 emoji 串（3 个 😀）正确输出 `copied 3 chars`；CcApp+CcToast+ccFormatters 加载 OK。flagRegistry 无需新增（KHY_CC_COPY_TOAST 随 KHY_CC_TUI 主开关，默认开） |
| 2026-09-16 | 子视图 ViewStack 完善落地（今日单项，优先级⑤，[DESIGN-ARCH-085] §1/§4.1）：`CcViewStack.js` 是 CcApp import 了但从未接入的死代码，且自身有 3 个挂载即崩的 bug——① 顶层 `inkRuntime.get()`（loadInk 前 require 即抛错，改惰性，与 CcToast/CcScrollIndicators 同模式）；② `CcCommandPalette`/`CcHistorySearch` 用了 `Text`/`useInput` 却从未 import（挂载即 `ReferenceError`）——补惰性导入；③ 真正接入 `CcApp`：门控 `KHY_CC_VIEW_STACK`（默认开）下 CC 模式 Ctrl+P 命令面板改走 `CcCommandPalette`（分组 + 实时过滤 + ↑/↓ 导航 + Enter 执行），`=0` 逐字节回退既有 `CcFuzzyPicker` 路径；`/copy` 命令在两路径下均路由到 `handleCopyLast`。对齐 [DESIGN-ARCH-085] §1「视图栈：Esc 返回 / 子视图不影响主对话 / 滚动独立」。验证：node --check 2 文件 OK；check-agent-rules 零违规；CcCommandPalette/CcHistorySearch 单独挂载 + CcApp 门控开/关两路径挂载全绿；ccClipboard.test.js 20/20 回归。`CcHistorySearch`（Ctrl+R 历史搜索）本次只修通、未接入 CcApp（遗留：下轮接 Ctrl+R 并走 ViewProvider 状态缓存） |
| 2026-09-17 | CcApp 子视图收尾落地（优先级⑤ 续，[DESIGN-ARCH-085] §1/§4.3 + [DESIGN-ARCH-087] §2.4 双击退出）：① `CcHistorySearch` 真正接入 `CcApp`——Ctrl+R 打开历史搜索覆盖层（反向增量搜索 `ccHistory.searchHistory` 持久化历史，选中条目回填 CcPromptInput 输入框，Esc 关闭），完成「子视图 ViewStack 完善」遗留项；② 修 CcApp 退出行为对齐 [DESIGN-ARCH-087] 验收项「双击 Ctrl+C 退出：首次提示，二次退出」——原 Ctrl+C/Ctrl+D 单按即 `exit()` 的裸行为改为 3s 窗口双击确认（`ccTimers.TIMING.doubleTapExit.windowMs` 单一真源），首次只发 `再按一次 Ctrl+C 退出` 警告 Toast。验证：node --check OK；check-agent-rules 零违规；CcApp 门控开/关（KHY_CC_VIEW_STACK）两路径挂载全绿；ccClipboard.test.js 20/20 回归。Legacy 模式（KHY_CC_TUI 未设置）未触碰 |

---

> **文档状态**：Active — 持续更新
> **创建日期**：2026-09-09
> **最后更新**：2026-09-17
