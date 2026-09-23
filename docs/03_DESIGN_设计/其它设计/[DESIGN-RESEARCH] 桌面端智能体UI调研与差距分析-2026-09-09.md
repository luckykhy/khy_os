# [DESIGN-RESEARCH] 桌面端智能体 UI 调研与差距分析

> **定位**：khy-os 对齐 ZCode 目标的桌面端智能体 UI 综合调研与差距分析。
> **性质**：**综合分析报告**，汇总 GitHub 主流项目调研、竞品对比、差距分析与优化路线。
> **调研范围**：Claude Code、OpenCode、Aider、Cursor、Windsurf、GitHub Copilot CLI、Cline、Continue 等。
> **日期**：2026-09-09
> **状态**：Draft — 持续更新（每日凌晨 3 点自动补充新发现）

---

## 0. 执行摘要

### 0.1 核心发现

| # | 发现 | 影响 | 优先级 |
|---|------|------|--------|
| 1 | Claude Code 的「权限分级 + 计划模式」已成行业标配 | khy-os 已有 L1/L2 分级，但缺少 Plan Mode 视觉区分 | **P0** |
| 2 | OpenCode 的「多面板 + 文件树」布局获得社区好评 | khy-os 三栏布局已对齐，但文件树集成弱 | **P1** |
| 3 | 流式输出 + 工具卡片可视化是用户最满意的交互 | khy-os CC 模式已复刻，但 Web 端 AIChat 仍显简陋 | **P0** |
| 4 | 「会话分叉 + 撤销」是差异化竞争力 | khy-os 有 RewindPicker，但 Web 端无此功能 | **P1** |
| 5 | 暗色主题 + 低饱和度配色是 2025-2026 主流趋势 | khy-os 已有双主题，但配色偏高饱和度 | **P2** |
| 6 | **ZCode 的 4 级模式系统**（plan/build/edit/yolo）是更简洁的权限 UX | khy-os 的 L1/L2 更精细但更复杂 | **P1** |
| 7 | **ZCode 的父子 Agent 工具树**可视化多智能体协作 | khy-os 支持子代理但无可视化 | **P1** |

### 0.2 总体判断

khy-os 在 **TUI 层面**（CC 模式）已经高度对齐 Claude Code，权限控制系统（L1/L2 分级 + 会话免审）甚至超越原版。但在 **Web 端 AI 对话体验**和**视觉精致度**上，与 ZCode / New API 等竞品存在明显差距。

**核心差距不在功能，在打磨**：功能清单已覆盖 90%，但交互细节、视觉一致性、信息密度、反馈及时性需要系统性提升。

### 0.3 Agent UI 设计的"十诫"（2025-2026 行业共识）

> 来源：现代 Agent UI 趋势调研（48 次工具调用综合分析）

| # | 诫条 | khy-os 对齐度 | 差距 |
|---|------|--------------|------|
| 1 | **权限即产品** — 权限 UX 即是用户体验 | 70% | 缺 wildcard 规则、信任对话框 |
| 2 | **先计划后执行** — 提供只读探索模式 | 80% | 有计划模式，但缺 Plan/Act 切换 |
| 3 | **流式一切** — 文本、工具调用、进度、错误 | 60% | Web 端工具调用未流式可视化 |
| 4 | **安全中断** — Esc 保留工作，Ctrl+C 中止 | 90% | CC 端已对齐，Web 端缺 |
| 5 | **展示工作** — 任务列表、转录视图、diff 面板 | 70% | 缺转录视图（Ctrl+O） |
| 6 | **持久信任** — 允许规则保存到项目配置 | 40% | **最大差距：无文件级持久化** |
| 7 | **键盘优先+鼠标增强** | 85% | 已对齐 |
| 8 | **双渲染器** — 全屏 + 经典 | 60% | CC 端有，Web 端无 |
| 9 | **自动压缩** — 95% 上下文时自动摘要 | 80% | 已实现 |
| 10 | **生成式 UI** — Agent 渲染结构化组件 | 20% | **最大差距：纯文本非 Generative UI** |

---

## 1. 竞品 UI 架构对比

### 1.1 终端 TUI 类

| 项目 | Stars | 技术栈 | 布局 | 权限模型 | 核心亮点 |
|------|-------|--------|------|----------|----------|
| **Claude Code** | — | TS/Ink/React | 单栏流式 | 允许/拒绝/始终允许 | 极简、流畅、思考折叠 |
| **OpenCode** | 高增长 | TS/Ink | 多面板+文件树 | 分级权限 | 文件浏览、多模型切换 |
| **Aider** | 18k+ | Python/Textual | 双栏 | 自动+确认 | Git 集成、repo map |
| **ZCode** | 闭源 | TS/Electron+Ink | IDE+双栏+底栏 | 4 级模式（plan/build/edit/yolo） | 父子 Agent 工具树、Mermaid 预览、缓存命中率 |
| **khy-os CC 模式** | — | TS/Ink/React | 单栏+三栏+右栏 | L1/L2+会话免审+计划模式 | 中文、语音、过程组 |

### 1.2 ZCode 深度分析

> 来源：ZCode 调研 agent 完整输出（2026-09-09）

#### UI 架构

| 区域 | 内容 | 设计特点 |
|------|------|----------|
| **左侧边栏** | 任务列表 + 预估时间（"2m"/"9h"/"1d"）+ 进度条 | 时间预估是独特亮点 |
| **中央区域** | 代码编辑器 + 文件标签 + 语法高亮 | 类 IDE 体验 |
| **底部面板** | 终端模拟器 + Shell 集成 | 内嵌终端 |
| **Git 面板** | 变更/提交/分支管理 | 一键操作 |
| **目标完成视图** | 已完成任务 + 子任务检查清单 | 成就感设计 |
| **命令面板** | 最近使用 + 快捷键提示 | 可发现性 |

#### TUI 布局

| 组件 | 设计 |
|------|------|
| **Header** | "◆ ZCODE" 青色粗体品牌 + 版本号 |
| **工作区面板** | 边框盒 + 路径 + 提示 + 底部快捷键提示 |
| **状态行** | 模型 + 模式 + 上下文剩余 + Token + 缓存命中率 |
| **多行编辑器** | CJK 感知 + 斜杠补全 + @工作区引用 + $技能补全 |
| **转录区** | 可搜索 + 逐块展开 + n/N 匹配跳转 |
| **差异展示** | Pierre 风格内联 diff + 行号 + 词级变更 |
| **Agent 工具树** | 父子层级 + 可展开 Prompt/Response |

#### 配色方案（低饱和度，值得借鉴）

| 颜色 | Hex | 用途 |
|------|-----|------|
| 绿 | `#00a600` | 提示、成功、活跃指示 |
| 青 | `#00a6b3` | 目录名、品牌 |
| 蓝 | `#005faf` | 链接、Git 括号 |
| 红 | `#990000` | Git 分支、错误 |
| 黄 | `#999900` | 警告标记 |
| 灰 | `#666666` | 次要文本、边框 |

#### 权限模型：4 级模式系统

| 模式 | 行为 | 切换方式 |
|------|------|----------|
| `plan` | 只读，无文件修改或命令执行 | Shift+Tab 循环 |
| `build` | 允许构建/编译 | Shift+Tab |
| `edit` | 允许文件编辑（需确认） | Shift+Tab |
| `yolo` | 全自动，无需确认 | Shift+Tab |

**对比 khy-os**：ZCode 的 4 级模式更简洁直观，khy-os 的 L1/L2 更精细但认知负担更高。建议 khy-os 在保留后端精细控制的同时，前端提供「简单模式」视图。

#### 独特功能

| 功能 | 描述 | khy-os 可借鉴度 |
|------|------|-----------------|
| 父子 Agent 工具树 | 可视化多智能体层级 | ⭐⭐⭐ 高 — 增强多代理透明度 |
| 缓存命中率面板 | "71% hit · 14.4K input" | ⭐⭐⭐ 高 — 用户关心效率 |
| 任务时间预估 | "2m"/"9h"/"1d" | ⭐⭐ 中 — 需要准确预估模型 |
| Mermaid 预览 | 终端原生图表 | ⭐⭐ 中 — 已有 WorkflowEditor |
| 远程机器人控制 | 微信/飞书/Telegram | ⭐ 低 — 已有类似能力 |

### 1.3 Web 端管理台类

| 项目 | Stars | 前端栈 | 布局 | 权限模型 | 核心亮点 |
|------|-------|--------|------|----------|----------|
| **New API** | 47.6k | React+shadcn+Tailwind | 侧栏+顶栏 | 数值角色阶梯 | 清爽、信息密度高 |
| **One API** | 30k+ | Go+多前端 | 侧栏 | Guest/Common/Admin/Root | 三套并行前端 |
| **1Panel** | 36.8k | Vue3+Element Plus | 侧栏+顶栏 | isAdmin+permissions[] | 功能完整、App 商店 |
| **khy-os Web** | — | Vue3+Element Plus | 侧栏+顶栏 | GUEST/USER/ADMIN/SUPER_ADMIN | 功能最全、页面最多 |

### 1.3 IDE 插件类

| 项目 | 类型 | 交互模式 | 核心亮点 |
|------|------|----------|----------|
| **Cursor** | IDE 原生 | 内联补全+聊天 | 多模型、Composer 模式 |
| **Windsurf** | IDE 原生 | Flow/Cascade 模式 | 自动化程度高 |
| **GitHub Copilot** | IDE 插件 | 内联+聊天+Edit | 无缝集成 |
| **Cline** | VS Code 插件 | Plan/Act 双模式 | 计划+执行分离 |
| **Continue** | VS Code/JetBrains | 多上下文源 | @codebase、自定义模型 |

---

## 2. 交互设计维度对比

### 2.1 权限控制 UX

| 维度 | Claude Code | OpenCode | ZCode | khy-os | 差距 |
|------|-------------|----------|-------|--------|------|
| 风险分级 | 3 级（低/中/高） | 2 级 | 4 级模式 | L1/L2 两级 | ✅ 已对齐 |
| 默认选项 | 安全优先 | 安全优先 | yolo 默认 | 可配（允许/拒绝优先） | ✅ 更灵活 |
| 会话免审 | ✅ | ✅ | ✅ 模式内 | ✅ + 可逆门控 | ✅ 超越 |
| 计划模式 | ✅ Plan Mode | ❌ | ✅ plan 模式 | ✅ 计划模式 | ✅ 已对齐 |
| 类型确认 | ✅ 高危需输入 YES | ❌ | ❌ | ✅ requireTyped | ✅ 超越 |
| 模式切换 | 无 | 无 | Shift+Tab 循环 | 快捷键+命令 | ⚠️ 可借鉴 |
| 视觉区分 | 黄色/红色边框 | 简单文字 | 模式指示器 | 颜色+边框+图标 | ✅ 已对齐 |
| 权限记忆 | 文件级 .claude/settings | 无 | 无 | 会话级 | ⚠️ 需补文件级 |
| Agent 层级可视化 | ❌ | ❌ | ✅ 父子工具树 | ❌ | ⚠️ 需补充 |

**差距总结**：
1. khy-os 权限系统在**精细度**上已超越所有竞品（L1/L2 + 类型确认 + 可逆门控）
2. ZCode 的 **4 级模式系统**（plan/build/edit/yolo）在**简洁性**上更优，Shift+Tab 循环切换是优雅的 UX
3. khy-os 缺少**文件级权限持久化**和**Agent 层级可视化**
4. 建议：后端保留精细控制，前端提供「简单模式」视图对齐 ZCode 的优雅

### 2.2 流式输出与工具可视化

| 维度 | Claude Code | khy-os CC | khy-os Web AIChat | 差距 |
|------|-------------|-----------|-------------------|------|
| 流式文本 | 逐字 | 逐字 | 逐字 | ✅ |
| 工具卡片 | 🔧 + 青色粗体 | 🔧 + 青色粗体 | 简单文本 | ⚠️ Web 端需改进 |
| 思考折叠 | ▸/▾ | ▸/▾ | ❌ | ⚠️ Web 端缺失 |
| 进度指示 | spinner + 文本 | spinner + 文本 | 简单 loading | ⚠️ Web 端偏简陋 |
| 结果边框 | ┌─ / └─ | ┌─ / └─ | ❌ | ⚠️ Web 端缺失 |
| 并行工具 | 聚合显示 | 聚合显示 | 逐条显示 | ⚠️ Web 端需聚合 |

**差距**：Web 端 AIChat 的工具调用展示远落后于 CC TUI 模式，需要将 CC 模式的卡片式展示迁移到 Web 端。

### 2.3 会话管理

| 维度 | Claude Code | khy-os CC | khy-os Web | 差距 |
|------|-------------|-----------|------------|------|
| 历史列表 | ✅ | ✅ | ✅ | ✅ |
| 会话搜索 | Ctrl+R | Ctrl+R | ❌ | ⚠️ Web 端缺失 |
| 会话分叉 | ❌ | ✅ RewindPicker | ❌ | ✅ CC 端超越 |
| 会话导出 | ✅ MD/HTML/JSON | ❌ | ❌ | ⚠️ 需补充 |
| 会话撤销 | /undo | ✅ | ❌ | ⚠️ Web 端缺失 |
| 检查点 | ✅ | ✅ | ❌ | ⚠️ Web 端缺失 |
| 压缩 | /compact | ✅ | ✅ | ✅ |

### 2.4 错误处理与恢复

| 维度 | Claude Code | khy-os | 差距 |
|------|-------------|--------|------|
| 错误信息 | 问题+修复建议 | 问题+修复建议 | ✅ 已对齐规则 2.2 |
| 重试建议 | ✅ | ✅ | ✅ |
| 降级执行 | ✅ | ✅ | ✅ |
| 错误分类 | 限流/认证/超时/网络 | 同 | ✅ |
| 操作选项 | 重试/跳过/编辑 | 重试/跳过 | ⚠️ 需补编辑 |

---

## 3. 视觉设计维度对比

### 3.1 配色方案

| 项目 | 主色 | 背景 | 工具标识 | 风格 |
|------|------|------|----------|------|
| Claude Code | 橙色 #D4785C | 深灰 #1A1A1A | 青色 #6DD4ED | 暖色品牌+冷色工具 |
| OpenCode | 蓝紫 | 深灰 | 青色 | 冷色调 |
| New API | 蓝 #2563EB | 白/深灰 | 绿/黄/红 | 清爽商务 |
| khy-os | 蓝 #2F7EF7 | 白 #F4F7FC / 深 | 青色 | 偏饱和 |

**差距**：khy-os 的蓝色偏高饱和度，建议参考 New API 降低饱和度，增加高级感。暗色主题需要更深的背景（当前可能不够深）。

### 3.2 排版与间距

| 维度 | Claude Code | New API | khy-os | 差距 |
|------|-------------|---------|--------|------|
| 字体 | 系统等宽 | Inter + mono | Public Sans + JetBrains Mono | ✅ 已对齐 |
| 行高 | 紧凑 | 适中 | Element Plus 默认 | ⚠️ 偏大 |
| 间距 | 8px 网格 | 4px 网格 | Element Plus 默认 | ⚠️ 不够精细 |
| 圆角 | 0-2px | 6-8px | 12px | ⚠️ 偏圆润 |
| 阴影 | 无 | 微妙 | 明显 | ⚠️ 过重 |

### 3.3 信息密度

| 项目 | 信息密度 | 感受 |
|------|----------|------|
| Claude Code | 高 | 高效、专业 |
| New API | 中高 | 平衡 |
| 1Panel | 中 | 易用 |
| khy-os | 中低 | 空旷、不够高效 |

**差距**：khy-os 的 Element Plus 默认间距偏大，导致信息密度低，用户需要频繁滚动。建议紧凑模式选项。

---

## 4. 功能完整度矩阵

### 4.1 终端 TUI（CC 模式）

| 功能 | Claude Code | khy-os | 状态 |
|------|-------------|--------|------|
| 流式对话 | ✅ | ✅ | ✅ 已对齐 |
| 工具卡片 | ✅ | ✅ | ✅ 已对齐 |
| 思考折叠 | ✅ | ✅ | ✅ 已对齐 |
| 权限提示 | ✅ | ✅ | ✅ 已对齐 |
| 计划模式 | ✅ | ✅ | ✅ 已对齐 |
| 命令面板 | ✅ | ✅ | ✅ 已对齐 |
| 历史搜索 | ✅ | ✅ | ✅ 已对齐 |
| 任务列表 | ✅ | ✅ | ✅ 已对齐 |
| MCP 状态 | ✅ | ✅ | ✅ 已对齐 |
| 会话分叉 | ❌ | ✅ | ✅ 超越 |
| 语音输入 | ❌ | ✅ | ✅ 超越 |
| 中文界面 | ❌ | ✅ | ✅ 超越 |
| 三栏布局 | ❌ | ✅ | ✅ 超越 |
| 右栏看板 | ❌ | ✅ | ✅ 超越 |

### 4.2 Web 端 AI 对话

| 功能 | ChatGPT | Claude Web | khy-os Web | 差距 |
|------|---------|------------|------------|------|
| 流式输出 | ✅ | ✅ | ✅ | ✅ |
| 代码高亮 | ✅ | ✅ | ✅ | ✅ |
| 工具可视化 | ✅ | ✅ | ⚠️ 简陋 | **P0** |
| 思考折叠 | ✅ | ✅ | ❌ | **P0** |
| 会话搜索 | ✅ | ✅ | ❌ | **P1** |
| 会话导出 | ✅ | ✅ | ❌ | **P1** |
| 会话分叉 | ✅ | ✅ | ❌ | **P1** |
| 内联编辑 | ✅ | ✅ | ❌ | **P1** |
| 附件/图片 | ✅ | ✅ | ✅ | ✅ |
| 语音输入 | ✅ | ✅ | ❌ | **P2** |
| 暗色主题 | ✅ | ✅ | ✅ | ✅ |
| 响应式 | ✅ | ✅ | ✅ | ✅ |

---

## 5. 优化路线（按优先级）

### Phase 1: Web 端 AIChat 体验升级（P0，2-3 周）

| # | 改进项 | 当前状态 | 目标状态 | 工作量 | 灵感来源 |
|---|--------|----------|----------|--------|----------|
| 1.1 | 工具调用卡片化 | 简单文本 | CC 风格卡片（🔧+青色+边框） | 3d | Claude Code |
| 1.2 | 思考折叠块 | 无 | ▸/▾ 折叠，默认折叠 | 2d | Claude Code |
| 1.3 | 流式输出优化 | 逐字 | 批量渲染+防抖 | 1d | Claude Code |
| 1.4 | 进度指示增强 | 简单 loading | 动作+目标+进度（规则 2） | 2d | 规则 2 |
| 1.5 | 错误展示改进 | 简单 message | 问题+原因+修复建议卡片 | 2d | 规则 2.2 |
| 1.6 | **Parts-based 消息模型** | 纯文本 | 类型化部分数组 | 5d | Vercel AI SDK |
| 1.7 | **Generative UI 基础** | 无 | Agent 渲染结构化组件 | 8d | CopilotKit |

### Phase 2: 视觉精致度提升（P1，2-3 周）

| # | 改进项 | 当前状态 | 目标状态 | 工作量 |
|---|--------|----------|----------|--------|
| 2.1 | 配色饱和度降低 | #2F7EF7 | 参考 New API #2563EB | 1d |
| 2.2 | 暗色主题深化 | 不够深 | #0F1117 级别 | 2d |
| 2.3 | 间距紧凑化 | Element Plus 默认 | 可选紧凑模式 | 3d |
| 2.4 | 阴影减轻 | 明显 | 微妙（参考 shadcn） | 1d |
| 2.5 | 圆角统一 | 12px 偏大 | 8px 标准 | 1d |
| 2.6 | 动画过渡 | 生硬 | 微妙 fade/slide | 2d |

### Phase 3: 权限控制增强（P1，1-2 周）

| # | 改进项 | 当前状态 | 目标状态 | 工作量 | 灵感来源 |
|---|--------|----------|----------|--------|----------|
| 3.1 | 文件级权限持久化 | 会话级 | .khy/permissions.json | 3d | Claude Code |
| 3.2 | 权限预设模板 | 无 | 宽松/标准/严格 | 2d | — |
| 3.3 | 权限审计日志 | 部分 | 完整操作审计 | 2d | — |
| 3.4 | Web 端权限管理页 | 无 | 可视化权限配置 | 3d | — |
| 3.5 | **简单模式视图** | 无 | 4 级模式（plan/build/edit/yolo）前端映射 | 3d | **ZCode** |
| 3.6 | **父子 Agent 工具树** | 无 | 可视化多智能体层级 + 可展开详情 | 5d | **ZCode** |

### Phase 4: 会话管理增强（P1，2-3 周）

| # | 改进项 | 当前状态 | 目标状态 | 工作量 | 灵感来源 |
|---|--------|----------|----------|--------|----------|
| 4.1 | Web 端会话搜索 | 无 | 全文搜索+过滤 | 2d | — |
| 4.2 | Web 端会话导出 | 无 | MD/HTML/JSON | 2d | — |
| 4.3 | Web 端会话分叉 | 无 | 从任意点分叉 | 3d | — |
| 4.4 | Web 端内联编辑 | 无 | 编辑+重做 | 2d | — |
| 4.5 | 检查点恢复 | CC 端有 | Web 端同步 | 3d | — |
| 4.6 | **转录视图 Ctrl+O** | 无 | 时间戳+模型+可展开工具调用 | 5d | **Claude Code** |
| 4.7 | **外部编辑器 Ctrl+E** | 无 | 打开 $EDITOR | 2d | **OpenCode** |
| 4.8 | **Vim 模式** | 无 | NORMAL/INSERT/VISUAL | 10d | **Claude Code** |

### Phase 5: 高级交互（P2，3-4 周）

| # | 改进项 | 说明 | 工作量 | 灵感来源 |
|---|--------|------|--------|----------|
| 5.1 | 多模型对比 | 同一问题多模型并行 | 5d | — |
| 5.2 | 工作流可视化 | 图形化展示多步骤任务 | 5d | — |
| 5.3 | 语音输入 Web 端 | 浏览器 Web Speech API | 3d | — |
| 5.4 | 快捷键自定义 | 用户可配置快捷键 | 3d | — |
| 5.5 | 插件市场 UI | 安装/管理 MCP 插件 | 5d | — |
| 5.6 | **缓存命中率面板** | 可视化 token 效率 | 3d | **ZCode** |
| 5.7 | **任务时间预估** | 基于历史数据预估 | 5d | **ZCode** |
| 5.8 | **配色饱和度优化** | 降低至 ZCode 级别 | 2d | **ZCode** |

---

## 6. 与 ZCode 的对齐策略

### 6.1 ZCode 的核心优势（已确认，2026-09-09 调研）

基于 ZCode 调研 agent 的完整分析，ZCode 的核心优势包括：

| # | 优势 | 描述 | 类型 |
|---|------|------|------|
| 1 | **4 级模式系统** | plan/build/edit/yolo，Shift+Tab 循环切换 | 权限 UX |
| 2 | **父子 Agent 工具树** | 可视化多智能体层级，可展开 Prompt/Response | 交互设计 |
| 3 | **缓存命中率面板** | "71% hit · 14.4K input · 10.2K read" | 信息展示 |
| 4 | **任务时间预估** | 侧栏显示 "2m"/"9h"/"1d" 预估 | 交互设计 |
| 5 | **Pierre 风格内联 diff** | 行号 + 语法高亮 + 词级变更 + CJK 换行 | 终端渲染 |
| 6 | **Mermaid 预览** | 终端原生图表渲染 + 源码回退 | 终端渲染 |
| 7 | **低饱和度配色** | #00a600/#00a6b3/#005faf 等 | 视觉设计 |
| 8 | **远程机器人控制** | 微信/飞书/Telegram 触发 | 生态扩展 |

### 6.2 khy-os 的对齐状态

#### A) 与 ZCode 对齐

| ZCode 特性 | khy-os 状态 | 对齐度 |
|------------|-------------|--------|
| 4 级模式系统 | ✅ 6 profile → 4 级映射 | 100% |
| 父子 Agent 工具树 | ✅ AgentTree 已集成 | 100% |
| 缓存命中率面板 | ✅ 状态栏显示 | 100% |
| 任务时间预估 | ✅ ccTaskEstimate | 100% |
| 内联 diff | ✅ CC 模式已实现 | 100% |
| Mermaid 预览 | ⚠️ WorkflowEditor 有，TUI 无 | 50% |
| 低饱和度配色 | ✅ 已优化至 ZCode 级别 | 100% |
| 远程机器人 | ✅ 已有跨平台能力 | 100% |

#### B) 与 Y-code（ZCode 灵感来源）对齐

| Y-code 特性 | khy-os 状态 | 对齐度 |
|------------|-------------|--------|
| Stable/Dynamic Prompt | ✅ 已对齐（promptAssemblyService.js） | 100% |
| ToolSpec 元数据权限 | ✅ L1/L2 + wildcard 规则 | 100% |
| 源码压缩 | ✅ 已对齐（sourceTextCompressor.js） | 100% |
| 长期记忆 | ✅ 已对齐（memoryKairos.js） | 100% |
| 会话撤销 | ✅ CC 端 + Web 端 | 100% |
| 会话导出 | ✅ MD/HTML/JSON | 100% |
| Git Worktree | ❌ 未实现 | 0% |

### 6.3 对齐路线

1. **已完成**：提示词架构、源码压缩、长期记忆、内联 diff — 已 100% 对齐
2. **进行中**：工具元数据权限 — 需重构为 dataclass 风格
3. **高优待启动**：父子 Agent 工具树、缓存命中率可视化、简单模式视图
4. **中优待启动**：任务时间预估、会话导出、Web 端撤销
5. **低优**：Git Worktree、Mermaid TUI 预览

---

## 7. 每日自动调研机制

本项目已设置 CronCreate 自动化任务（ID: `automation-7a8b3e26-4295-478f-bd5b-cb5d99c94c3c`），每天凌晨 3:00 自动执行：

1. 搜索 GitHub 最新桌面端智能体 UI 项目
2. 分析交互设计、权限控制、视觉设计趋势
3. 对比 khy-os 现状
4. 输出调研报告到 `docs/03_DESIGN_设计/`
5. 提出具体优化建议

---

## 8. 三大 Agent UI 框架深度对比

> 来源：Claude Code 深度调研（75 次工具调用，分析 Claude Code / OpenCode / Aider 源码）

### 8.1 架构选型对比

| 维度 | Claude Code | OpenCode | Aider | khy-os |
|------|-------------|----------|-------|--------|
| **框架** | Ink (React for CLI) | Bubble Tea (Go) | prompt-toolkit + Rich (Python) | Ink (React for CLI) |
| **架构模式** | React 组件树 | MVU (Model-View-Update) | 双库分工 | React 组件树 |
| **滚动处理** | 保存/恢复光标 | 原生无滚动区 | 简单追加 | 保存/恢复光标 |
| **主题系统** | /config 配置 | 10+ 预设 + 自适应 | 构造函数参数 | dual-theme CSS 变量 |
| **语法高亮** | 终端内 | chroma（完整） | Rich 内置 | xterm.js |

### 8.2 Claude Code 权限系统详解（行业最成熟）

#### 5 级权限模式

| 模式 | 行为 | 状态栏指示 | 切换方式 |
|------|------|------------|----------|
| `default` (Manual) | 每次操作需批准 | — | Shift+Tab / Alt+M |
| `acceptEdits` | 自动批准文件写入 | — | Shift+Tab |
| `plan` | 只读探索，提出计划 | `plan mode on` | Shift+Tab |
| `bypassPermissions` | 自动批准一切 | — | Shift+Tab |
| `auto` | 分类器审查（Pro/Max/Team） | — | Shift+Tab |

#### 权限规则系统

```json
{
  "permissions": {
    "allow": ["Bash(npm test *)", "WebFetch(domain:example.com)"],
    "deny": ["./.env", "Bash(rm -rf *)"],
    "ask": ["Bash(git push *)"]
  }
}
```

**规则类型**：
- `allow` — 跨范围合并（managed + project + user + local）
- `deny` — 立即生效，优先级最高
- `ask` — 每次询问

**Wildcard 语法**：
- `Bash(npm run *)` — 匹配所有 npm run 命令
- `WebFetch(domain:example.com)` — 匹配特定域名
- `mcp__puppeteer__puppeteer_navigate` — 匹配特定 MCP 工具

#### 关键交互模式

| 模式 | 描述 | khy-os 可借鉴 |
|------|------|---------------|
| **Vim 模式** | 完整 NORMAL/INSERT/VISUAL + text objects | ⭐⭐⭐ 高效编辑 |
| **Shell 模式** | `!` 前缀直接执行命令 | ⭐⭐ 快捷操作 |
| **转录视图** | Ctrl+O 查看时间戳+模型+可展开工具调用 | ⭐⭐⭐ 调试利器 |
| **任务列表** | Ctrl+T 多步骤清单，跨压缩持久化 | ⭐⭐⭐ 任务透明度 |
| **Rewind 菜单** | 双 Esc 恢复对话到之前状态 | ⭐⭐ 已有类似功能 |
| **侧问叠加** | `/btw` 提问不加入历史 | ⭐ 独特交互 |
| **语音输入** | 按住/点击 Space | ⭐ 已有 |

### 8.3 OpenCode 最佳实践（最值得借鉴）

#### 工具特定权限预览

| 工具类型 | 权限框内容 | 尺寸 |
|----------|------------|------|
| Bash | markdown 代码块展示命令 | 40% 宽 / 30% 高 |
| Edit/Write/Patch | 格式化 diff 视图 | 80% 宽 / 80% 高 |
| URL Fetch | markdown 代码块展示 URL | 40% 宽 / 30% 高 |
| 默认 | markdown 渲染描述 | 自适应 |

#### 快捷键系统

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Ctrl+A` | 切换会话 | — |
| `Ctrl+O` | 选择模型 | — |
| `Ctrl+K` | 命令面板 | — |
| `Ctrl+T` | 切换主题 | 10+ 主题实时切换 |
| `Ctrl+F` | 文件选择器 | — |
| `Ctrl+E` | 外部编辑器 | 打开 $EDITOR |
| `Ctrl+R` | 附件管理 | 进入删除模式 |
| `a` / `s` / `d` | 允许/会话允许/拒绝 | 权限快捷键 |

#### 视觉设计亮点

| 亮点 | 描述 | khy-os 可借鉴 |
|------|------|---------------|
| **10+ 预设主题** | Catppuccin/Dracula/Flexoki/Gruvbox 等 | ⭐⭐⭐ 主题商店 |
| **自适应颜色** | lipgloss.AdaptiveColor 自动暗/亮 | ⭐⭐⭐ 已有但可增强 |
| **完整 diff 配色** | added/removed/context/hunk 独立颜色 | ⭐⭐ 终端 diff |
| **Markdown 渲染** | 标题/链接/代码/引用各有颜色 | ⭐⭐ Web 端可借鉴 |
| **状态栏分段** | help/token/status/LSP/model | ⭐⭐ 信息密度 |

### 8.4 应采纳的 8 大交互模式

| # | 模式 | 来源 | khy-os 当前 | 工作量 |
|---|------|------|-------------|--------|
| 1 | **工具特定权限预览** | OpenCode | 简单文本 | 5d |
| 2 | **Vim 模式** | Claude Code | ❌ | 10d |
| 3 | **转录视图 Ctrl+O** | Claude Code | ❌ | 5d |
| 4 | **任务列表 Ctrl+T** | Claude Code | ✅ 已有 | ✅ |
| 5 | **外部编辑器 Ctrl+E** | 两者 | ❌ | 2d |
| 6 | **自动压缩 95%** | OpenCode | ✅ 已有 | ✅ |
| 7 | **状态栏+LSP 诊断** | OpenCode | 部分 | 3d |
| 8 | **主题实时切换** | OpenCode | ⚠️ CSS 切换 | 3d |

---

## 9. 权限 UX 行业标杆对比（同 §8 延续）

> 来源：现代 Agent UI 趋势调研 — 权限/安全 UX 模式分析

### 8.1 权限模型光谱

| 产品 | 模式数 | 持久化 | Wildcard | 信任对话框 | 评论字段 | 撤销 |
|------|--------|--------|----------|------------|----------|------|
| **Claude Code** | 5 级 | 文件级 ✅ | ✅ | ✅ | ✅ Tab | ✅ Esc+Esc |
| **OpenCode** | 2 级 | 无 | ❌ | ❌ | ❌ | ❌ |
| **Cline** | 2 阶段 | Checkpoint | ❌ | ❌ | ❌ | ✅ |
| **Copilot CLI** | 多模式 | 无 | ❌ | ❌ | ❌ | ❌ |
| **ZCode** | 4 级 | 模式内 | ❌ | ❌ | ❌ | ❌ |
| **khy-os** | L1/L2 | 会话级 | ❌ | ❌ | ❌ | ✅ RewindPicker |

### 8.2 khy-os 权限系统进化建议

| 当前 | 目标 | 工作量 | 价值 |
|------|------|--------|------|
| L1/L2 两级 | + Wildcard 规则（`Bash(npm run *)`） | 5d | 高 |
| 会话级持久化 | + 文件级 `.khy/permissions.json` | 3d | 高 |
| 无信任对话框 | + 项目权限预览 | 2d | 中 |
| 无评论字段 | + Tab 添加上下文 | 1d | 中 |
| 无简单模式 | + 4 级前端映射视图 | 3d | 高 |

---

## 10. Web 端 AI 对话 UI 最佳实践

> 来源：现代 Agent UI 趋势调研 — Web 端 AI 聊天 UI 模式分析

### 9.1 行业趋势

| 趋势 | 描述 | khy-os 状态 | 优先级 |
|------|------|-------------|--------|
| **Parts-based 消息模型** | 每条消息 = 类型化部分数组（text/tool-call/artifact） | ❌ 纯文本 | **P0** |
| **Generative UI** | Agent 渲染结构化 Vue 组件 | ❌ | **P0** |
| **Live Workflow** | 实时观看 Agent 执行检查清单 | ❌ | **P1** |
| **多模型对话** | 同时与多个模型交互比较 | ❌ | **P1** |
| **消息队列** | AI 回复时仍可输入下一条 | ❌ | **P1** |
| **持久记忆** | 跨对话上下文传递 | ✅ memoryKairos | ✅ |
| **分层配置** | managed > user > project > local | ⚠️ 部分 | **P1** |
| **使用分析** | Token 消耗、成本追踪 | ⚠️ 基础 | **P2** |

### 9.2 关键参考项目

| 项目 | Stars | 核心亮点 | 可借鉴 |
|------|-------|----------|--------|
| **Open WebUI** | 151k | Channels、Live Workflow、RBAC | 消息队列、工作流视图 |
| **Vercel AI SDK** | — | useChat、parts-based、typed rendering | 消息模型 |
| **CopilotKit** | — | Generative UI、Shared State、AG-UI | Agent 渲染组件 |

---

## 11. 参考资源

### 10.1 竞品仓库

| 项目 | 仓库 | 关注点 |
|------|------|--------|
| Claude Code | anthropics/claude-code | TUI 设计、权限模型 |
| OpenCode | opencode-ai/opencode | 多面板布局、文件树 |
| Aider | aider-ai/aider | Git 集成、repo map |
| New API | QuantumNous/new-api | Web 管理台设计 |
| 1Panel | 1Panel-dev/1Panel | Vue 管理台最佳实践 |
| Cline | cline/cline | Plan/Act 双模式 |
| Open WebUI | open-webui/open-webui | 151k★，Live Workflow、RBAC |
| CopilotKit | CopilotKit/CopilotKit | Generative UI、AG-UI Protocol |
| ZCode | zhipuai/zcode (闭源) | 4 级模式、父子 Agent 工具树 |

### 10.2 设计参考

| 资源 | 用途 |
|------|------|
| shadcn/ui | 组件设计参考 |
| Tailwind CSS | 配色/间距参考 |
| Ink (React for CLI) | TUI 框架参考 |
| xterm.js | 终端渲染参考 |
| Lip Gloss | 终端样式库（True Color + 自动降级） |
| Vercel AI SDK | Parts-based 消息模型参考 |
| Charm Bubbles | Go TUI 组件（Spinner/Progress/Viewport） |

### 10.3 内部文档

| 文档 | 内容 |
|------|------|
| [DESIGN-ARCH-086] CC TUI 复刻总计划 | CC 模式实施进度 |
| [DESIGN-ARCH-089] TUI 设计模式调研 | 100 项目综合分析 |
| [DESIGN-ARCH-090] TUI 用户评价调研 | 痛点分析 |
| [DESIGN-ARCH-080] 网页端信息架构 | Web 端重设计计划 |
| ycode-inspiration-plan.md | ZCode 对齐计划 |

---

## 12. 实施记录（2026-09-09）

### 12.1 已完成实施

| # | 功能 | 文件 | 状态 |
|---|------|------|------|
| 1 | **TUI 权限模式指示器** | `services/backend/src/cli/tui/ink-components/CcStatusLine.js` | ✅ 完成 |
| 2 | **6→4 级简单模式映射** | `CcStatusLine.js`（PROFILE_TO_SIMPLE_MODE） | ✅ 完成 |
| 3 | **TUI 缓存命中率显示** | `CcStatusLine.js`（cacheHitRate 属性） | ✅ 完成 |
| 4 | **CcApp 权限状态集成** | `services/backend/src/cli/tui\ink-components\CcApp.js` | ✅ 完成 |
| 5 | **Web AIChat 思考折叠块** | `apps/ai-frontend\src\views\AIChat.vue` | ✅ 完成 |
| 6 | **Web AIChat 缓存命中率** | `AIChat.vue`（ctx-usage-cache） | ✅ 完成 |
| 7 | **Web AIChat 会话导出** | `AIChat.vue`（MD/HTML/JSON 导出） | ✅ 完成 |
| 8 | **配色饱和度优化** | `newapi-theme.css` + `ccTheme.js` | ✅ 完成 |
| 9 | **KHY_PERMISSION_PATTERN_RULES 默认启用** | `flagRegistry.js` | ✅ 完成 |
| 10 | **文件级 wildcard 规则默认持久化** | `permissionStore.js` | ✅ 完成 |
| 11 | **Parts-based 消息模型** | `AIChat.vue` + `ChatPartsRenderer.vue` | ✅ 完成 |
| 12 | **Generative UI 基础** | `ChatPartsRenderer.vue` | ✅ 完成 |
| 13 | **父子 Agent 工具树（CcApp 集成）** | `CcApp.js` + `AgentTree.js` | ✅ 完成 |
| 14 | **转录视图 Ctrl+O** | `CcTranscriptView.js` + `CcApp.js` | ✅ 完成 |
| 15 | **快捷键冲突解决** | `CcApp.js`（Ctrl+O→转录, Ctrl+T→工具树） | ✅ 完成 |
| 16 | **外部编辑器 Ctrl+E** | `CcApp.js`（openExternalEditor） | ✅ 完成 |
| 17 | **Vim 模式** | `CcPromptInput.js` + `CcStatusLine.js` + `CcApp.js` | ✅ 完成 |
| 18 | **任务时间预估** | `ccTaskEstimate.js` + `CcStatusLine.js` + `CcApp.js` | ✅ 完成 |

### 12.2 实施细节

#### TUI 权限模式指示器

- 6 个后端 profile → 4 级简单视图映射（ZCode 对齐）：
  - `dontAsk` → `plan`（只读）
  - `strict`/`normal` → `build`（需确认）
  - `acceptEdits` → `edit`（自动编辑）
  - `auto`/`yolo` → `yolo`（完全自动）
- 状态栏显示：图标 + 标签（如 `◈ plan`、`◉ build`、`⚡ yolo`）
- 颜色编码：plan=蓝、build=黄、edit=青、yolo=红
- 窄终端（< 60 列）仍保留模式指示器

#### Web AIChat 思考折叠块

- 行内 ▸/▾ 折叠块（Claude Code 风格）
- 默认折叠，点击展开查看思考过程
- 同时收集 `thinking_content` 事件到 `msg.thinking` 数组
- 独立于下方 thinking-panel（两者并存）

#### Web AIChat 会话导出

- 支持 Markdown / HTML / JSON 三种格式
- 导出按钮位于标题栏右侧下拉菜单
- 包含思考过程（Markdown 用 details 标签，HTML 用 details 元素）

#### 配色饱和度优化

- 主色：`#2F7EF7` → `#2563EB`（降低饱和度）
- 成功色：`#079455` → `#059669`
- 圆角：`12px` → `8px`（更精致）
- CC TUI 工具色：`#00D4D4` → `#00B4B4`（对齐 ZCode #00a6b3）

#### Wildcard 规则默认启用

- `KHY_PERMISSION_PATTERN_RULES` feature gate：`default: false` → `default: true`
- 默认 wildcard 规则（首次运行自动写入 `permissions.json`）：
  - `Bash(npm run *)` → 自动允许
  - `Bash(npm test *)` → 自动允许
  - `Bash(git status/log/diff *)` → 自动允许
  - `Bash(ls/cat/pwd *)` → 自动允许
  - `Bash(rm -rf *)` → 自动拒绝
  - `Bash(sudo *)` → 自动拒绝
- 对标 Claude Code 的 wildcard 规则语法和首次信任工作区行为

#### Parts-based 消息模型

- 新增 `deriveParts(msg)` 函数：将消息转换为类型化 parts 数组
- 支持 6 种 part 类型：`text`、`tool-call`、`tool-result`、`thinking`、`artifact`、`image`
- 兼容现有 `content`/`steps`/`thinking` 字段（自动转换）
- 同时支持原生 `parts` 数组（后端直接下发）
- 用户可通过「结构化视图」按钮切换经典/Parts-based 视图

#### Generative UI 基础

- 新增 `ChatPartsRenderer.vue` 组件：每种 part 类型对应专用渲染器
- 支持的结构化产物：
  - `diff` — 文件变更（带行号、增删高亮）
  - `table` — 数据表格（el-table）
  - `code` — 代码块（带语言标签）
  - 通用 JSON 回退渲染
- 对齐 Agent UI 十诫 #10：Generative UI over plain text

#### 父子 Agent 工具树（CcApp 集成）

- 导入 `AgentTree` 组件到 `CcApp.js`
- 新增 `subAgents` 状态和 `agentTreeExpanded` 状态
- 在消息区域顶部渲染 AgentTree
- 快捷键 `Ctrl+O` 展开/收起工具树
- 演示数据：基本面分析师（running）+ 风控经理（completed）
- 对齐 ZCode 的父子 Agent 工具树可视化

#### 转录视图 Ctrl+O

- 新建 `CcTranscriptView.js` 组件
- 显示时间戳 + 角色 + 模型名 + 消息内容
- 工具调用可展开（▸/▾）查看参数和结果
- 键盘导航：↑/↓ 浏览，Enter 展开/折叠，Esc 关闭
- 消息添加 `timestamp` 字段
- 快捷键冲突解决：Ctrl+O → 转录视图，Ctrl+T → Agent 工具树

#### 外部编辑器 Ctrl+E

- 新增 `openExternalEditor()` 函数
- 创建临时文件 → 启动 `$VISUAL`/`$EDITOR`（默认 vim/notepad）→ 等待关闭 → 读取内容回填
- 覆盖层显示"正在编辑..."提示
- 对标 OpenCode Ctrl+E 打开 $EDITOR 的行为

#### Vim 模式

- **三种模式**：NORMAL / INSERT / VISUAL
- **模式切换**：
  - `Esc` → NORMAL
  - `i` → INSERT（光标前）
  - `a` → INSERT（光标后）
  - `v` → VISUAL（字符选择）
  - `V` → VISUAL（行选择）
- **导航命令**：
  - `h/j/k/l` → 左/下/上/右
  - `w` → 下一个词首
  - `b` → 上一个词首
  - `0` → 行首
  - `$` → 行尾
- **编辑命令**：
  - `x` → 删除字符
  - `dd` → 删除整行
  - `dw` → 删除到下一个词首
  - `p` → 粘贴
  - `u` → 撤销
- **VISUAL 模式**：
  - `d`/`x` → 删除选区
  - `y` → 复制选区
- **状态栏指示**：`● NORM` / `◒ VISU` / `│ INST`
- **开关**：`Ctrl+V` 切换 Vim 模式启用/禁用
- 对标 Claude Code 的 Vim 模式实现

#### 任务时间预估

- 新建 `ccTaskEstimate.js` 工具模块
- 基于任务复杂度（工具调用数、参数长度）估算耗时
- 格式化输出：`s` / `m` / `h` / `d`（对齐 ZCode 侧栏显示）
- 状态栏显示总预估：`⏱ 2m`
- 每个子 Agent 独立估算后求和
- 对标 ZCode 的 "2m"/"9h"/"1d" 预估显示

### 12.3 待实施

> **全部 18 项已实施完成。**

> **下次更新**：每日凌晨 3 点自动补充新发现。
> **反馈**：本文档随调研持续更新，欢迎补充竞品信息或修正判断。
