<!-- 文档分类: MGMT-RPT-012 | 阶段: 项目管理 | 原路径: docs/指南/ai-显示-对标与对齐.md -->
# KHY OS AI 显示系统 — 四项目对标分析与对齐方案

> 基准日期：2026-05-20
> 对标项目：Claude Code、DeepSeek TUI、Qwen Code、LibreChat

## 一、架构对比矩阵

| 维度 | Claude Code | DeepSeek TUI | Qwen Code | LibreChat | KHY 现状 |
|------|------------|-------------|-----------|-----------|---------|
| 框架 | Ink (React CLI) | ratatui (Rust) | Ink (React CLI) | React (Web) | readline + console.log |
| 输入区 | FullscreenLayout 固定底部 | 5 区域布局固定底部 | Static+动态双缓冲 | ChatForm memo 隔离 | monkey-patch repaint |
| 流式渲染 | 稳定前缀/不稳定后缀增量 | LineBuffer 换行门控 + 双档位自适应 | Static 历史 + pending 动态区 | SSE→Recoil→全量重渲染 | 逐 chunk console.log |
| Markdown | marked 词法 + ANSI + Rust 高亮 | 自研 parse/render 两阶段 + AST 缓存 | 自研逐行正则 + lowlight | react-markdown + rehype | markdownLite 正则 |
| Spinner | shimmer/stall/token 计数/子代理树 | 无定时器渲染时算帧/鲸鱼/脉冲 | 三层 spinner + TMUX 降级 | CSS 伪元素光标 | DynamicSpinner + startSparkle |
| CJK 换行 | eastAsianWidth + grapheme + 边界安全 | unicode-width + grapheme + 回归测试 | Intl.Segmenter + LRU + string-width | react-markdown 自动 | _isCJK + displayWidth |
| 工具显示 | ToolUseLoader 闪烁 + ⎿ 嵌套 | ToolCard 家族图标 + 6 行截断 + pager | ToolGroup 圆角框 + compact + 耗时 | ToolCallGroup 分组折叠 + shimmer | printStepLine + printStepDetail |
| Thinking | 专用组件 + 最少显示 2s | 独立 block + 旁路换行门控 | 无专门处理 | 折叠/展开 + 灯泡图标 | 无 |
| 代码高亮 | Rust ColorFile 原生模块 | 单色 ITALIC + 保留缩进 | lowlight (highlight.js HAST) | rehype-highlight (lowlight) | 基础 ANSI 着色 |
| 同步输出 | Ink 虚拟 DOM diff | ratatui 帧率限制 120/30 FPS | ESC[?2026h/l 协议 | 浏览器 DOM batch | 无 |

## 二、对齐清单（P0-P2）

### P0 — 立即可做，效果显著

| # | 项目 | 来源 | 当前状态 | 目标 | 状态 |
|---|------|------|----------|------|------|
| 1 | 流式增量渲染 | Claude Code StreamingMarkdown | chunk 全量缓存完才输出 | 已完成段落即时渲染，尾部 pending 覆写 | DONE |
| 2 | Thinking 块显示 | Claude Code + LibreChat | `<think>` 内容丢弃或混入正文 | dim 前缀显示，完成后折叠为摘要 | DONE |
| 3 | 工具执行耗时 | Qwen Code ToolElapsedTime + DeepSeek | startSparkle 内部计时但不显示 | >2s 显示 `(3s)`，>8s 变红 | DONE |
| 4 | Spinner stall 检测 | Claude Code useStalledAnimation | spinner 只有闪烁，无 stall 反馈 | 3s 无新 token 渐变黄→红 | DONE |

### P1 — 中期改进

| # | 项目 | 来源 | 目标 | 状态 |
|---|------|------|------|------|
| 5 | CJK 宽度准确计算 | Claude Code + Qwen Code | 引入 string-width，支持 emoji/组合字符 | DONE |
| 6 | 工具输出智能截断 | DeepSeek + Qwen Code | head 3 + tail 3 + 折叠提示 | DONE |
| 7 | 终端同步输出防撕裂 | Qwen Code synchronizedOutput | ESC[?2026h/l 批量写入 | DONE |

### P2 — 长期优化

| # | 项目 | 来源 | 目标 | 状态 |
|---|------|------|------|------|
| 8 | Markdown AST 缓存 | DeepSeek parse/render 分离 | LRU 缓存 + resize 自动清缓存 | DONE |
| 9 | 代码块语法高亮 | Claude Code + Qwen Code | 轻量正则高亮 (JS/TS/Py/Bash/Go/Rust/SQL/JSON/HTML/CSS) | DONE |
| 10 | 虚拟滚动 | Claude Code VirtualMessageList | readline 架构替代：超长输出 head+tail+折叠 | DONE |

### P3 — UI 编排与交互（2026-05-20 新增）

| # | 项目 | 来源 | 目标 | 状态 |
|---|------|------|------|------|
| 11 | 统一菜单选择器 | Claude Code FuzzyPicker + DeepSeek CommandPalette | selectMenu() 统一入口，inkComponents.Select 零依赖渲染，inquirer 降级 | DONE |
| 12 | 帮助页面精致排版 | Claude Code 3-tab help | 带边框 Box 布局 + 分组图标 + 分隔线 + 底部主题提示 | DONE |
| 13 | 持久 Footer 状态栏 | Claude Code StatusBar + DeepSeek 5区域 | hudRenderer.renderStatusBar 接入 prompt 重绘，显示模型/tokens/git/cost | DONE |
| 14 | Slash 命令菜单增强 | Claude Code FuzzyPicker | 模糊匹配 + 相关度排序 + 匹配字符高亮 + label 显示 | DONE |
| 15 | 启动页信息增强 | Claude Code + Qwen Code | 动态 System/Status：认证方式/上下文窗口/网关状态/Git 分支 | DONE |
| 16 | 工具家族图标 | DeepSeek ToolCard 图标 + Qwen Code 圆角框 | ▶Bash ▷Read ◆Write ◇Update ⌕Search ⊙Web ◐Agent ☐Todo | DONE |

## 三、各项设计参考

### P0-1: 流式增量渲染

**核心思路**（取自 Claude Code + DeepSeek）：

```
SSE chunk 到达
  → 累积到 buffer
  → 找最后一个 \n\n（段落边界）
  → 之前的 = 稳定部分 → renderAiResponse() → console.log
  → 之后的 = pending → 下次 chunk 来时覆写
```

DeepSeek 的 LineBuffer 换行门控补充：代码围栏（` ``` `）内不在 `\n` 处断，必须等到围栏闭合。

### P0-2: Thinking 块

```
流式中：
  💭 思考中... (dim, 实时显示 thinking 文本)

完成后：
  💭 思考 (12s) — 已折叠，ctrl+o 查看
```

LibreChat 用 `<think>` 标签解析；Claude Code 用 content type 区分。KHY 需在 SSE chunk 中检测 `<think>` 标签。

### P0-3: 工具耗时

```
  ● Bash (npm test)                     ← 刚开始
  ● Bash (npm test) 3s                  ← 超过 2s
  ● Bash (npm test) 12s                 ← 超过 8s，红色
```

Qwen Code 3 秒阈值 + Shell 额外显示 timeout 预算。DeepSeek `running (5s)` 格式。

### P0-4: Spinner stall 检测

Claude Code 实现：
- 正常：白色闪烁
- 3s 无新 token：渐变为红色（`useStalledAnimation`）
- 恢复 token 流：渐变回白色

KHY DynamicSpinner 已有 `_lastTokenAt` 跟踪，只需在 `_render()` 中加 stall 色彩计算。

### P1-5: CJK 宽度

Claude Code 三级策略：
1. ASCII 快速路径 `charCodeAt < 127` → width = 1
2. `eastAsianWidth(codePoint)` → CJK = 2
3. `Intl.Segmenter` grapheme 分割 → emoji = 2

Qwen Code 补充：`Intl.Segmenter('zh', { granularity: 'word' })` 做中文分词，500 条 LRU 缓存。

### P1-6: 工具输出截断

DeepSeek 方案（最佳）：
```
  ⎿ line 1
    line 2
    ... (+42 行，Alt+V 查看完整)
    line N-1
    line N
```
默认 head 2 + tail 2，超出折叠。

### P1-7: 同步输出

Qwen Code 实现：monkey-patch `stdout.write`，每个 microtask 批次自动包裹 `ESC[?2026h` / `ESC[?2026l`。支持 WezTerm/iTerm/Kitty。

## 四、不适用于 KHY 的设计

| 设计 | 项目 | 不采用原因 |
|------|------|-----------|
| Ink 全屏布局 | Claude Code / Qwen Code | 需要完全重写 REPL 架构 |
| ratatui 帧率限制 | DeepSeek | Rust 原生，不可移植到 Node |
| React Compiler `_c()` | Claude Code | Ink 特有优化 |
| CSS 伪元素光标 | LibreChat | Web 专用 |
| Bun.stringWidth / Bun.wrapAnsi | Claude Code | 运行时特有 |
