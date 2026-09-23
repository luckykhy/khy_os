# CC TUI 复刻工程 — AI 执行提示词

> **用途**：将此提示词交给 AI 编码助手（Claude Code / opencode / Codex），按步骤实施 CC TUI 复刻。
> **前提**：已阅读 `docs/03_DESIGN_设计/[DESIGN-ARCH-086]` 总计划文档。

---

## 🎯 项目目标

在 khy-os 的 `services/backend/src/cli/tui/` 目录下，实现 Claude Code TUI 的 1:1 视觉与交互复刻：
- 品牌替换为 **Khy**
- 全面支持 **OpenAI 协议**
- 保留 khy 特色功能（中文、过程组、计划模式、语音输入）
- **零破坏**：Legacy 模式行为不变
- 性能：冷启动 < 100ms，渲染 < 16ms

---

## 📋 实施前必读

按以下顺序阅读设计文档：

1. **`services/backend/src/cli/tui/AGENTS.md`** — 工程约束（红线，必须遵守）
2. **`docs/03_DESIGN_设计/[DESIGN-ARCH-086]`** — 总计划（单一真源）
3. **`docs/03_DESIGN_设计/[DESIGN-ARCH-081]`** — 主设计规范
4. **`docs/03_DESIGN_设计/[DESIGN-ARCH-082]`** — 输入框与光标
5. **`docs/03_DESIGN_设计/[DESIGN-ARCH-083]`** — 表格与折叠
6. **`docs/03_DESIGN_设计/[DESIGN-ARCH-084]`** — 注意力与选择
7. **`docs/03_DESIGN_设计/[DESIGN-ARCH-085]`** — 子视图/菜单/卡片/滚动
8. **`docs/03_DESIGN_设计/[DESIGN-ARCH-087]`** — 微交互与反馈
9. **`docs/03_DESIGN_设计/[DESIGN-ARCH-088]`** — 快捷键/Redo/Fork/偏差处理

---

## 🔴 绝对红线（不可违反）

```
❌ 禁止修改 Legacy 模式（KHY_CC_TUI 未设置）下的任何代码路径
❌ 禁止使用 \x1B[n;mr（DECSTBM 滚动区）
❌ 禁止使用 \x1B[2J（全屏清除）
❌ 禁止同步阻塞事件循环超过 16ms
❌ 禁止在渲染路径中执行 IO 操作
❌ 禁止在 CC 模式 UI 中出现 "Claude Code" 或 "Claude" 品牌文本
❌ 禁止冷启动超过 100ms
❌ 禁止单次渲染超过 16ms

✅ 所有 CC 模式代码必须通过 KHY_CC_TUI=1 门控
✅ 门控关闭时，行为必须与修改前逐字节相同
✅ 使用 \x1B[0J（ED0）清除光标到末尾
✅ 使用保存/恢复光标 + 绝对定位进行局部更新
✅ 品牌文本使用 "Khy"（定义在 ccBrand.js）
✅ 新增文件优先于修改现有文件
```

---

## 📐 实施步骤

### 步骤 1: 基础设施（Phase 0）

**目标**：建立门控体系和基础工具

- [ ] 1.1 创建 `tui/utils/ccMode.js` — 门控检测工具函数
- [ ] 1.2 创建 `tui/utils/ccBrand.js` — 品牌文本集中管理
- [ ] 1.3 创建 `tui/theme/ccTheme.js` — CC 主题色板
- [ ] 1.4 创建 `tui/utils/ccResizeHandler.js` — 终端 resize 无残影处理
- [ ] 1.5 创建 `tui/utils/ccRenderStrategy.js` — 渲染策略配置
- [ ] 1.6 创建 `tui/utils/ccTimers.js` — 计时器常量管理
- [ ] 1.7 创建 `tui/utils/ccLayout.js` — 布局计算（绝对值+相对值混合）
- [ ] 1.8 修改 `tui/theme/themeRegistry.js` — 新增 `cc` 主题注册

**验证**：
```bash
KHY_CC_TUI=1 khy  # 应显示 CC 风格主题
khy               # Legacy 模式行为不变
```

---

### 步骤 2: 核心视觉（Phase 1）

**目标**：实现 CC 风格的核心 UI 组件

- [ ] 2.1 创建 `tui/ink-components/CcAssistantMessage.js` — 助手消息（● 前缀）
- [ ] 2.2 创建 `tui/ink-components/CcToolCard.js` — 工具调用卡片（🔧 + 粗体青色）
- [ ] 2.3 创建 `tui/ink-components/CcStatusLine.js` — 单行状态栏
- [ ] 2.4 创建 `tui/ink-components/CcPromptInput.js` — 无边框输入框 + 光标
- [ ] 2.5 创建 `tui/ink-components/CcLogo.js` — Khy 品牌 Logo
- [ ] 2.6 修改 `tui/ink-components/MessageBlock.js` — 用户消息无背景框
- [ ] 2.7 修改 `tui/ink-components/WelcomeBanner.js` — CC 风格欢迎界面

**验证**：
```bash
KHY_CC_TUI=1 khy
# 检查：用户消息无背景框
# 检查：助手消息以 ● 开头
# 检查：工具调用显示 🔧 + 粗体青色
# 检查：状态栏为单行
# 检查：输入框无边框
```

---

### 步骤 3: 交互组件（Phase 2）

**目标**：实现选择、折叠、表格等交互组件

- [ ] 3.1 创建 `tui/ink-components/CcCollapsible.js` — 折叠组件（▸/▾）
- [ ] 3.2 创建 `tui/ink-components/CcTable.js` — 表格组件
- [ ] 3.3 创建 `tui/ink-components/CcSelectable.js` — 选择列表组件
- [ ] 3.4 创建 `tui/ink-components/CcFuzzyPicker.js` — 模糊搜索选择器
- [ ] 3.5 创建 `tui/ink-components/CcHelpMenu.js` — 帮助菜单覆盖层

**验证**：
```bash
KHY_CC_TUI=1 khy
# 检查：? 键打开帮助菜单
# 检查：折叠组件可展开/折叠
# 检查：表格列对齐正确
```

---

### 步骤 4: 高级功能（Phase 3）

**目标**：实现视图栈、剪贴板、历史等高级功能

- [ ] 4.1 创建 `tui/ink-components/CcViewStack.js` — 视图栈管理
- [ ] 4.2 创建 `tui/utils/ccClipboard.js` — 剪贴板工具（OSC 52）
- [ ] 4.3 创建 `tui/utils/ccHistory.js` — 历史管理（持久化 + 搜索）
- [ ] 4.4 创建 `tui/ink-components/CcMcpStatus.js` — MCP 状态栏指示器
- [ ] 4.5 创建 `tui/ink-components/CcSidebarPanel.js` — 右侧看板容器

**验证**：
```bash
KHY_CC_TUI=1 khy
# 检查：Ctrl+P 打开命令面板
# 检查：Ctrl+R 打开历史搜索
# 检查：复制操作显示字符反馈
# 检查：MCP 状态显示正确
```

---

### 步骤 5: 微交互与反馈（Phase 4）

**目标**：完善复制反馈、滚动指示、Toast 等微交互

- [ ] 5.1 创建 `tui/utils/ccFeedback.js` — 反馈管理器
- [ ] 5.2 创建 `tui/components/CcToast.js` — 瞬态消息组件
- [ ] 5.3 创建 `tui/components/CcScrollIndicators.js` — 滚动指示器
- [ ] 5.4 创建 `tui/components/CcMessageBar.js` — 错误/警告/信息横幅
- [ ] 5.5 修改 `tui/ink-components/CcStatusLine.js` — 集成 Token 警告

**验证**：
```bash
KHY_CC_TUI=1 khy
# 检查：复制显示 "copied N chars"
# 检查：滚动显示 "⋯ (N above/below)"
# 检查：Toast 3-5 秒自动消失
# 检查：Token 80% 黄色 / 95% 红色
```

---

### 步骤 6: 快捷键与执行偏差（Phase 5）

**目标**：实现快捷键系统、Redo/Fork、执行偏差处理

- [ ] 6.1 创建 `tui/utils/ccKeyRegistry.js` — 快捷键注册表
- [ ] 6.2 创建 `tui/utils/ccUndoStack.js` — 操作栈（撤销/重做）
- [ ] 6.3 创建 `tui/utils/ccExecutionMonitor.js` — 执行监控器
- [ ] 6.4 修改 `tui/ink-components/CcPromptInput.js` — 集成快捷键
- [ ] 6.5 修改 `tui/ink-components/App.js` — 集成全局快捷键

**验证**：
```bash
KHY_CC_TUI=1 khy
# 检查：r 重新生成
# 检查：f 分叉
# 检查：z 撤销
# 检查：双击 Ctrl+C 退出
# 检查：模型跑偏可中断
```

---

## 🔧 代码风格约束

```javascript
// ✅ 正确：2 空格缩进、单引号、分号
const x = 1;
const y = 'hello';

// ✅ 正确：camelCase 命名
const isCcMode = true;
function formatModelName() {}

// ✅ 正确：英文注释
// Detect terminal color support
const supportsColor = process.env.COLORTERM === 'truecolor';

// ✅ 正确：面向用户的中文字符串
const message = '正在连接数据库...'; // 用户可见
const label = 'model'; // 内部标识，英文

// ✅ 正确：函数组件 + React.memo
function CcStatusLine({ model, context, cost }) {
  return <Text>{model}</Text>;
}
module.exports = { CcStatusLine: React.memo(CcStatusLine) };

// ✅ 正确：门控模式
function FooterBar() {
  if (process.env.KHY_CC_TUI === '1') {
    return <CcStatusLine />;
  }
  return <LegacyFooterBar />;
}

// ❌ 错误：在组件内判断
function Message({ text }) {
  const color = isCcMode ? '#00D4D4' : '#00BCD4'; // 禁止！
  return <Text color={color}>{text}</Text>;
}
```

---

## 🧪 测试验证

### 功能测试

```bash
# 1. 门控测试
KHY_CC_TUI=1 khy          # 应显示 CC 风格 UI
KHY_CC_TUI=0 khy          # Legacy 模式
khy                       # Legacy 模式（默认）

# 2. 性能测试
time KHY_CC_TUI=1 khy     # 冷启动 < 100ms

# 3. 快捷键测试
KHY_CC_TUI=1 khy
# 按 ? 打开帮助菜单
# 按 Ctrl+P 打开命令面板
# 按 Ctrl+R 打开历史搜索
# 按 r 重新生成
# 按 f 分叉
# 按 z 撤销

# 4. 复制测试
KHY_CC_TUI=1 khy
# 复制内容，检查状态栏显示 "copied N chars"

# 5. 模型跑偏测试
KHY_CC_TUI=1 khy
# 执行一个可能跑偏的任务
# 检查是否可中断和纠正
```

### 兼容性测试

```bash
# OpenAI 协议
OPENAI_API_KEY=sk-xxx KHY_CC_TUI=1 khy
/model gpt-4o

# MCP 状态
KHY_CC_TUI=1 khy
# 检查 MCP 状态显示

# 历史持久化
KHY_CC_TUI=1 khy
# 输入一些命令，退出后重新启动
# 检查历史是否保留
```

---

## 📁 文件组织

```
services/backend/src/cli/tui/
├── AGENTS.md                    ← 工程约束（已存在）
├── app.js                       ← 入口（修改）
├── ink-components/              ← Ink 组件
│   ├── App.js                   ← 根组件（修改）
│   ├── CcStatusLine.js          ← 新建：CC 状态栏
│   ├── CcAssistantMessage.js    ← 新建：CC 助手消息
│   ├── CcToolCard.js            ← 新建：CC 工具卡片
│   ├── CcPromptInput.js         ← 新建：CC 输入框
│   ├── CcPermissionPrompt.js    ← 新建：CC 权限提示
│   ├── CcFuzzyPicker.js         ← 新建：CC 补全菜单
│   ├── CcHelpMenu.js            ← 新建：CC 帮助菜单
│   ├── CcLogo.js                ← 新建：CC Logo
│   ├── CcMcpStatus.js           ← 新建：MCP 状态栏
│   ├── CcMcpPanel.js            ← 新建：MCP 详情面板
│   ├── CcSidebarPanel.js        ← 新建：右侧看板容器
│   ├── CcSidebarContext.js      ← 新建：Context 面板
│   ├── CcSidebarFiles.js        ← 新建：Files 面板
│   ├── CcSidebarTools.js        ← 新建：Tools 面板
│   ├── CcSidebarStats.js        ← 新建：Stats 面板
│   ├── CcSidebarMcp.js          ← 新建：MCP 面板
│   ├── CcViewStack.js           ← 新建：视图栈
│   ├── CcCollapsible.js         ← 新建：折叠组件
│   ├── CcTable.js               ← 新建：表格组件
│   ├── CcSelectable.js          ← 新建：选择组件
│   └── CcMessageBar.js          ← 新建：消息横幅
├── utils/                       ← 工具函数
│   ├── ccMode.js                ← 新建：门控检测
│   ├── ccBrand.js               ← 新建：品牌文本
│   ├── ccFormatters.js          ← 新建：格式化函数
│   ├── ccToolFormat.js          ← 新建：工具参数格式化
│   ├── ccResizeHandler.js       ← 新建：Resize 处理
│   ├── ccRenderStrategy.js      ← 新建：渲染策略
│   ├── ccTimers.js              ← 新建：计时器常量
│   ├── ccLayout.js              ← 新建：布局计算
│   ├── ccContextWindows.js      ← 新建：模型上下文窗口
│   ├── ccPricing.js             ← 新建：模型定价
│   ├── ccClipboard.js           ← 新建：剪贴板工具
│   ├── ccHistory.js             ← 新建：历史管理
│   ├── ccFeedback.js            ← 新建：反馈管理器
│   ├── ccKeyRegistry.js         ← 新建：快捷键注册表
│   ├── ccUndoStack.js           ← 新建：操作栈
│   └── ccExecutionMonitor.js    ← 新建：执行监控器
├── hooks/                       ← React Hooks
│   ├── useMcpStatus.js          ← 新建：MCP 状态桥接
│   └── useSidebarState.js       ← 新建：右侧看板状态
└── theme/                       ← 主题
    ├── ccTheme.js               ← 新建：CC 主题色板
    └── themeRegistry.js         ← 修改：新增 cc 主题
```

---

## ⚠️ 常见陷阱

| 陷阱 | 正确做法 |
|------|----------|
| 修改 Legacy 组件内部实现 | 新增 CC 组件，Legacy 组件保持不变 |
| 在组件内判断 `isCcMode` | 在组件外部条件渲染 |
| 使用 `\x1B[2J` 全屏清除 | 使用 `\x1B[0J` ED0 |
| 直接监听 `stdout.on('resize')` | 使用 `ResizeHandler` 封装 |
| 硬编码颜色值 | 从 `ccTheme.js` 导入 |
| 不清理定时器 | `useEffect` 返回清理函数 |
| 忘记 `React.memo` | 所有纯展示组件使用 memo |

---

## 📊 验收标准

### 功能验收

- [ ] `KHY_CC_TUI=1 khy` 启动后显示 CC 风格 UI
- [ ] Legacy 模式（无门控）行为与修改前逐字节相同
- [ ] 复制操作显示字符/字节数反馈
- [ ] 滚动时显示上下方内容指示器
- [ ] 瞬态消息 3-5 秒自动消失
- [ ] Token 用量 80%/95% 显示警告
- [ ] 工具执行超时显示重试建议
- [ ] 粘贴大文本显示行数反馈
- [ ] 双击 Ctrl+C 退出（首次提示）
- [ ] 快捷键系统工作正常
- [ ] Redo/Fork/Undo 工作正常
- [ ] 模型跑偏可中断和纠正

### 性能验收

- [ ] 冷启动 < 100ms
- [ ] 热启动 < 50ms
- [ ] 渲染帧率 ≥ 30 FPS
- [ ] 输入延迟 < 16ms
- [ ] Resize 无残影
- [ ] 内存 < 50MB

### 兼容性验收

- [ ] OpenAI 模型名格式化正确
- [ ] 上下文窗口计算正确
- [ ] 费用计算正确
- [ ] MCP 状态显示正确
- [ ] 历史持久化正常
- [ ] 剪贴板 OSC 52 工作

---

## 🚀 开始执行

1. **确认已阅读所有设计文档**
2. **按步骤 1-6 顺序实施**
3. **每步完成后运行验证命令**
4. **遇到问题查阅 `AGENTS.md` 红线**
5. **完成后更新总计划文档状态**

---

> **提示词结束**
> 
> 将此提示词保存为 `docs/03_DESIGN_设计/EXECUTION_PROMPT.md`，方便 AI 助手引用。
