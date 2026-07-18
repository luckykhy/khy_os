<!-- 文档分类: MGMT-RPT-010 | 阶段: 项目管理 | 原路径: docs/报告/windows-工具调用循环冻结-2026-05-28.md -->
# Windows 工具调用冻结排查与快速修复（2026-05-28）

## 范围
- 问题来源：Windows CLI 运行时（用户观察到 `khy os v0.1.57`）。
- 症状类别：
  1. 模型说"我将要做 ..."并打印一行看似工具调用的内容（例如 `⌕ Search()` / `◆ Write()`），但随后并没有真正的工具执行。
  2. 用户输入 `继续`，会话不断重放排队的输入；最终返回 `AI 未返回有效回复` 或表现为冻结。

## 观察到的复现信号
- REPL 显示如下分阶段输出行：
  - `⌕ Search()`
  - `▶ Bash()`
  - `◆ Write()`
- 随后没有任何有意义的工具结果被消费，队列重放行持续出现：
  - `继续处理排队输入: "..."`

## 根因假设（已在代码层面验证）

### H1. 带符号前缀的伪工具调用未被完全解析
- 位置：`backend/src/services/toolUseLoop.js`（`_parseToolCalls`）。
- 修复前：解析器能识别 `▶ ToolName(...)` 和裸写的 `ToolName(...)`，但某些模型/终端常见的 UI 前缀（`⌕`、`◆` 等）未被覆盖。
- 影响：模型输出在用户看来像是在使用工具，但解析器在某些情况下返回不了可执行的工具调用。

### H2. `Search()` 别名与空参数处理不匹配
- 位置：`backend/src/services/claudeCompat.js` + `toolUseLoop` 补丁阶段。
- 修复前：
  - 在回退解析路径中，`Search()` 可能仍保留为非规范的 `Search` 而非规范的 `search`。
  - 对于 `search` 工具，空的 `Search()` 没有 `keyword`，因此执行可能失败或被下游行为跳过。
- 影响：额外的无进展轮次和提示循环。

### H3. 前缀抑制可能造成"半截回复"的感知
- 位置：`backend/src/cli/ai.js`（`_createStreamToolInterceptor`、`suppressPrefixOnToolCall`）。
- 当前行为：在工具循环模式下，工具标记之前的短前缀可能被缓冲/抑制，以避免噪音式的开场白。
- 风险：如果模型产生混合的叙述文本 + 工具标记风格，用户可能感知到文本缺失/半截。
- 今晚状态：已记录并推迟，待后续谨慎跟进（避免破坏流式输出 UX）。

## 已实施的快速修复（今晚）

### 修复 A. 扩展带前缀的工具调用解析
- 文件：`backend/src/services/toolUseLoop.js`
- 改动：
  - 扩展 Format-5 正则以解析带符号前缀的调用：
    - 从仅支持 `▶ ToolName(...)`
    - 扩展为 `[▶⌕◆⏺⎿] ToolName(...)`
- 预期影响：
  - `⌕ Search()` / `◆ Write(...)` 现在会被解析为真正的工具调用。

### 修复 B. 确保 `search` 别名规范化
- 文件：`backend/src/services/claudeCompat.js`
- 改动：
  - 添加别名映射：`search -> search`。
- 预期影响：
  - 回退解析器不再将 `Search` 留为非规范形式。

### 修复 C. 从用户上下文补全空的 `Search()` 关键字
- 文件：`backend/src/services/toolUseLoop.js`
- 改动：
  - 新增 `_patchEmptyLocalSearchKeyword(toolCalls, userMessage)`。
  - 在 shell/search 补丁器之后挂入预执行补丁阶段。
- 行为：
  - 如果工具调用是 `search` 且没有 `keyword/query`，则从清洗后的用户消息中填充 `keyword`。

## 今晚完成的验证
- 语法加载检查：
  - `node -e "require('./backend/src/services/claudeCompat'); require('./backend/src/services/toolUseLoop'); console.log('ok')"`
  - 结果：`ok`
- 新增回归测试：
  - `backend/tests/toolUseLoop.symbolParsingRegression.test.js`
  - 覆盖：
    1. 解析 `⌕ Search()` 和 `◆ Write(...)`
    2. 通过用户上下文补全空的 `Search()` 关键字
- 运行测试：
  - `npm --prefix backend test -- backend/tests/toolUseLoop.symbolParsingRegression.test.js`
  - 结果：PASS (2/2)

## Linux 部署指引（供明天使用）

### 1. 拉取或 cherry-pick 这些确切的文件
- `backend/src/services/toolUseLoop.js`
- `backend/src/services/claudeCompat.js`
- `backend/tests/toolUseLoop.symbolParsingRegression.test.js`

### 2. 在 Linux 上运行针对性回归测试
```bash
npm --prefix backend test -- backend/tests/toolUseLoop.symbolParsingRegression.test.js
```

### 3. 可选的运行时健全性检查（CLI）
- 用于验证的提示词模式：
  - "你真的具有工具调用能力吗"
  - 要求演示一次文件搜索。
- 通过标准：
  - 带符号前缀的行应导致真正的工具执行和最终回复，而不是无尽的队列重放。

## 推迟的事项（今晚未完成）

1. 流拦截器安全性优化（`ai.js`）
- 目标：在 `suppressPrefixOnToolCall=true` 时，避免过度抑制有意义的短前缀。
- 候选策略：
  - 仅对纯填充内容保留抑制。
  - 在工具标记之前保留语义前缀（阶段标签、带编号的步骤标签）。

2. `repl.js` 中的队列重放保护
- 目标：当跨多轮检测不到向前推进信号时，硬停止重复的内部重放。
- 候选策略：
  - 跟踪 `(queuedText hash + no-progress rounds)`，超过阈值后带明确诊断信息退出。

3. 端到端的 Windows 专项测试套件
- 为以下场景添加模拟会话记录测试：
  - `⌕ Search()` -> `continue` -> 无限重放不再发生。

## 明天任务清单
1. 在 `backend/src/cli/ai.js` 中实现保守的拦截器优化，并为前缀保留添加单元测试。
2. 在 `backend/src/cli/repl.js` 中添加 REPL 无进展重放保护。
3. 添加集成风格的回归测试（mock chat stream + tool loop + queue drain）。
4. 运行与工具循环和 REPL 相关的完整后端测试子集。

## 当前状态
- 针对解析器/别名/空参数路径的快速解锁修复已就位。
- 高风险的流式行为变更被有意推迟，以避免深夜引入回归。
