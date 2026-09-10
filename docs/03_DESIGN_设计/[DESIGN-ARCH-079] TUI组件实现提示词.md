# [DESIGN-ARCH-079] TUI 组件实现提示词

## 说明

本提示词基于 `[DESIGN-ARCH-079] TUI界面设计规范.md` 第 12 节「组件详细规范」生成，覆盖 8 个核心组件的实现任务。

**使用方式**：
1. 选择一个组件任务
2. 将下方提示词复制到 khy-os 目录下打开的任意 AI 执行
3. 完成后回填状态

---

## 任务清单

| 任务 ID | 组件 | 优先级 | 预估工时 |
|---------|------|--------|----------|
| T-079-01 | PromptFrame 输入框增强 | P0 | 2h |
| T-079-02 | CompletionMenu 斜杠菜单 | P1 | 1h |
| T-079-03 | TaskListPanel 任务看板 | P1 | 2h |
| T-079-04 | StreamingBlock 流式输出 | P0 | 3h |
| T-079-05 | Spinner 加载指示器 | P2 | 0.5h |
| T-079-06 | 输出表格无框模式 | P1 | 1h |
| T-079-07 | Markdown 结构化输出 | P1 | 2h |
| T-079-08 | 输入回显 Transcript | P2 | 1h |

---

## 提示词模板

### T-079-01: PromptFrame 输入框增强

> **角色**：khy-os TUI 高级工程师，熟悉 Ink 渲染模型、Yoga 布局引擎、IME 输入法处理。
>
> **目标**：实现 `[DESIGN-ARCH-079]` 第 12.1 节定义的 PromptFrame 规范，包括：
> - 宽度 = `cols - 1`（防 anti-spill）
> - 最小高度 4 行，最大高度 `max(4, vrows - 10)`
> - 光标样式：INSERT 默认 / NORMAL 绿色 / 禁用不可见
> - IME 候选窗跟随（`useCursor().setCursorPosition()`）
> - Shell 模式：`!` 前缀切换，`Escape`/`Backspace` 退出
> - 粘贴处理：短文本直接插入，长文本折叠为 `[Pasted ~N lines]`
> - Prompt 历史：`↑/↓` 浏览，`Ctrl+R` 反向搜索
>
> **工作目录**：`D:\Portable\khy-os`
>
> **执行流程**：
>
> 1. **审计现有代码**：
>    - 读取 `services/backend/src/cli/tui/ink-components/PromptFrame.js`（487 行）
>    - 读取 `services/backend/src/cli/tui/effectiveCols.js`（宽度计算）
>    - 读取 `services/backend/src/cli/tui/viewportHeight.js`（高度计算）
>    - 读取 `services/backend/src/cli/tui/ink-components/caretGeometry.js`（光标几何）
>    - 对比 OpenCode 的 `packages/opencode/src/cli/render.ts` 中 Input 组件实现
>
> 2. **逐项检查规范与实现的差距**：
>    - [ ] 宽度是否使用 `cols - 1`
>    - [ ] 高度是否限制在 `max(4, vrows - 10)`
>    - [ ] 光标样式是否按 Vim 模式切换
>    - [ ] IME 跟随是否使用 yoga node 链遍历计算
>    - [ ] Shell 模式是否支持 `!` 前缀
>    - [ ] 粘贴是否有长度门控（150 字符 / 3 行）
>    - [ ] Prompt 历史是否支持双向搜索
>
> 3. **实现差距修复**：
>    - 每个修复使用环境变量门控（如 `KHY_PROMPT_IME_FOLLOW=1`）
>    - 保持向后兼容：未设置环境变量时行为与改动前完全一致
>    - JS 风格：2 空格缩进、单引号、分号、CommonJS
>
> 4. **自测**：
>    - 运行 `node services/backend/src/cli/tui/ink-components/PromptFrame.js` 无报错
>    - 手动测试：输入长文本 → 验证高度限制
>    - 手动测试：切换 Vim 模式 → 验证光标样式
>    - 手动测试：粘贴长文本 → 验证折叠行为
>
> 5. **输出报告**：
>    - 列出所有修改的文件和行号
>    - 列出所有新增的环境变量
>    - 列出所有通过/未通过的验收项
>
> **验收标准**：
> - [ ] 宽度计算使用 `cols - 1`
> - [ ] 高度限制在 `max(4, vrows - 10)`
> - [ ] 光标样式按 Vim 模式切换
> - [ ] IME 候选窗跟随光标位置
> - [ ] Shell 模式可通过 `!` 前缀激活
> - [ ] 长粘贴自动折叠为占位符
> - [ ] Prompt 历史支持 `↑/↓` 和 `Ctrl+R`
> - [ ] 所有增强都在环境变量门控下
> - [ ] `hq_check.py` 全绿
>
> **工程铁律**：
> 1. 零盘符硬编码：一切路径从脚本自身位置推算
> 2. 向后兼容：新增环境变量默认 off
> 3. JS 风格：2 空格缩进、单引号、分号、CommonJS
> 4. 不改 `platform/khy_platform/__init__.py`
> 5. 改完必跑 `python scripts/hq_check.py`
> 6. 布局计算使用 `effectiveCols.js` 和 `viewportHeight.js` 作为 SSOT
>
> **回填**：
> ```bash
> python scripts/update_status.py task T-079-01 done --note "PromptFrame 输入框增强：宽度 cols-1、高度限制、IME 跟随、Shell 模式、粘贴折叠、Prompt 历史"
> ```

---

### T-079-04: StreamingBlock 流式输出增强

> **角色**：khy-os TUI 高级工程师，熟悉 Ink 渲染模型、流式输出架构、反阶梯机制。
>
> **目标**：实现 `[DESIGN-ARCH-079]` 第 12.5 节定义的 StreamingBlock 规范，包括：
> - 反阶梯架构：高度预算管理 `liveBudget = max(6, rows - reserve)`
> - 流式组件：Thinking section（可折叠）、Body timeline、Status broadcast
> - 归一化管道：分层门控（强模型 sanitize / 其他 normalize）
> - 前缀稳定：live 预览中不关闭 fence/不去重/不修剪
> - 内容键控缓存：`streamNormCache` 优化 O(n²)/轮 → O(n)/轮
> - Markdown 流式渲染：`renderMarkdownStreaming()` 关闭悬挂 fence
>
> **工作目录**：`D:\Portable\khy-os`
>
> **执行流程**：
>
> 1. **审计现有代码**：
>    - 读取 `services/backend/src/cli/tui/ink-components/StreamingBlock.js`（441 行）
>    - 读取 `services/backend/src/cli/tui/markdownRenderer.js`（流式渲染）
>    - 读取 `services/backend/src/cli/tui/ink-components/TextBlock.js`（文本块）
>    - 读取 `services/backend/src/cli/tui/ink-components/ToolCard.js`（工具卡片）
>    - 对比 OpenCode 的 streaming 实现
>
> 2. **逐项检查规范与实现的差距**：
>    - [ ] liveBudget 是否使用 `max(6, rows - reserve)` 计算
>    - [ ] Thinking section 是否可折叠且有 thinkBudget 限制
>    - [ ] Body timeline 是否有序且无重复
>    - [ ] 归一化是否使用分层门控
>    - [ ] 前缀稳定是否在 live 预览中生效
>    - [ ] streamNormCache 是否正确实现内容键控
>    - [ ] renderMarkdownStreaming 是否关闭悬挂 fence
>
> 3. **实现差距修复**：
>    - 每个修复使用环境变量门控
>    - 保持向后兼容
>    - JS 风格：2 空格缩进、单引号、分号、CommonJS
>
> 4. **自测**：
>    - 运行 `node services/backend/src/cli/tui/ink-components/StreamingBlock.js` 无报错
>    - 手动测试：流式输出 → 验证无阶梯伪影
>    - 手动测试：长输出 → 验证高度预算管理
>    - 手动测试：复制输出 → 验证无硬换行符
>
> 5. **输出报告**：
>    - 列出所有修改的文件和行号
>    - 列出所有新增的环境变量
>    - 列出所有通过/未通过的验收项
>
> **验收标准**：
> - [ ] 流式输出不出现阶梯伪影
> - [ ] liveBudget 正确计算并限制高度
> - [ ] Thinking section 可折叠且有独立预算
> - [ ] Body timeline 有序且无重复
> - [ ] 复制输出不包含 `\n`（软换行对齐 opencode）
> - [ ] 归一化缓存命中率 > 80%
> - [ ] `hq_check.py` 全绿
>
> **工程铁律**：
> 1. 零盘符硬编码
> 2. 向后兼容：新增环境变量默认 off
> 3. JS 风格：2 空格缩进、单引号、分号、CommonJS
> 4. 不改 `platform/khy_platform/__init__.py`
> 5. 改完必跑 `python scripts/hq_check.py`
> 6. 流式归一化只用于全宽文本块：表格、边框等精确布局仍使用硬换行
>
> **回填**：
> ```bash
> python scripts/update_status.py task T-079-04 done --note "StreamingBlock 流式输出增强：反阶梯架构、高度预算、归一化缓存、Markdown 流式渲染"
> ```

---

### T-079-06: 输出表格无框模式

> **角色**：khy-os TUI 高级工程师，熟悉 CLI 表格渲染、CJK 字符处理、ANSI 转义序列。
>
> **目标**：实现 `[DESIGN-ARCH-079]` 第 12.7 节定义的输出表格规范，包括：
> - 无框模式（默认）：空白对齐 + 2 空格缩进 + dim 分隔线
> - 全框模式：`╭─╮│╰─╯` 完整框
> - 切换方式：`KHY_TABLE_BORDERS=minimal|full`
> - CJK 支持：`padToWidth()` 使用显示宽度（非字符数）
>
> **工作目录**：`D:\Portable\khy-os`
>
> **执行流程**：
>
> 1. **审计现有代码**：
>    - 读取 `services/backend/src/cli/tableStyle.js`（边框风格决策）
>    - 读取 `services/backend/src/cli/formatters.js`（printTable, printErrorPanel, _dressBorderlessTable）
>    - 读取 `node_modules/cli-table3/lib/utils.js`（padToWidth 实现）
>    - 对比 OpenCode 的 TextTable 组件
>
> 2. **逐项检查规范与实现的差距**：
>    - [ ] 默认是否使用无框模式
>    - [ ] 无框模式是否有 2 空格缩进
>    - [ ] 表头下划线是否使用 dim `─`
>    - [ ] 全框模式是否使用 `╭─╮│╰─╯`
>    - [ ] `KHY_TABLE_BORDERS` 环境变量是否正确切换
>    - [ ] CJK 字符是否使用显示宽度计算
>    - [ ] ANSI 转义序列是否不计入宽度
>
> 3. **实现差距修复**：
>    - 每个修复使用环境变量门控
>    - 保持向后兼容
>    - JS 风格：2 空格缩进、单引号、分号、CommonJS
>
> 4. **自测**：
>    - 运行 `node services/backend/src/cli/formatters.js` 无报错
>    - 手动测试：ASCII 表格 → 验证无框对齐
>    - 手动测试：CJK 表格 → 验证宽度计算
>    - 手动测试：`KHY_TABLE_BORDERS=full` → 验证全框显示
>    - 手动测试：复制表格 → 验证无框模式不复制边框
>
> 5. **输出报告**：
>    - 列出所有修改的文件和行号
>    - 列出所有通过/未通过的验收项
>
> **验收标准**：
> - [ ] 默认使用无框模式
> - [ ] 无框模式有 2 空格缩进 + dim 分隔线
> - [ ] 全框模式使用 `╭─╮│╰─╯`
> - [ ] `KHY_TABLE_BORDERS` 正确切换模式
> - [ ] CJK 字符宽度计算正确（中文 2 列）
> - [ ] ANSI 转义序列不计入宽度
> - [ ] 复制无框表格不包含边框字符
> - [ ] `hq_check.py` 全绿
>
> **工程铁律**：
> 1. 零盘符硬编码
> 2. 向后兼容：`KHY_TABLE_BORDERS` 默认 `minimal`
> 3. JS 风格：2 空格缩进、单引号、分号、CommonJS
> 4. 不改 `platform/khy_platform/__init__.py`
> 5. 改完必跑 `python scripts/hq_check.py`
> 6. 表格宽度计算使用 `padToWidth()` 而非 `.length`
>
> **回填**：
> ```bash
> python scripts/update_status.py task T-079-06 done --note "输出表格无框模式：空白对齐、CJK 宽度计算、环境变量切换"
> ```

---

## 通用工程铁律（所有任务适用）

1. **零盘符硬编码**：一切路径从脚本自身位置推算（`hq_common.py` 已封装）
2. **向后兼容**：所有增强都在环境变量门控下，默认 off
3. **JS 风格**：2 空格缩进、单引号、分号、CommonJS
4. **不改 `platform/khy_platform/__init__.py`**
5. **改完必跑** `python scripts/hq_check.py`
6. **软换行只用于全宽文本块**：表格、边框等需要精确布局的组件仍使用硬换行

---

## 验证命令

```bash
# 全量检查
python scripts/hq_check.py

# 单组件测试
node services/backend/src/cli/tui/ink-components/PromptFrame.js
node services/backend/src/cli/tui/ink-components/StreamingBlock.js
node services/backend/src/cli/formatters.js

# Lint 检查
npx eslint services/backend/src/cli/tui/ink-components/*.js
```

---

*基于 `[DESIGN-ARCH-079] TUI界面设计规范.md` 第 12 节生成*
*最后更新：2026-09-08*
