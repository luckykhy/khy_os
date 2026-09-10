# AGENTS.md — CC TUI 复刻工程约束

> **定位**：CC 模式 TUI 复刻工程的**单一约束真源**。实施本目录下任何工作时，必须遵守本文档的全部条款。
> **适用范围**：`services/backend/src/cli/tui/` 下所有 Ink 组件、CC 模式相关工具函数、以及 `KHY_CC_TUI=1` 门控的代码路径。
> **冲突解决**：当本文件与 `[DESIGN-ARCH-081]` 冲突时，以 `[DESIGN-ARCH-081]` 为准；当与根目录 `AGENTS.md` 冲突时，以本文件为准（CC 模式特殊规则覆盖通用规则）。

---

## 0. 红线（绝对禁止）

以下规则**无条件禁止**，无任何例外。违反任何一条 = 代码必须被拒绝或重写。

### 0.1 零破坏原则

```
❌ 禁止修改 Legacy 模式（KHY_CC_TUI 未设置）下的任何代码路径
❌ 禁止删除或重命名现有组件/函数（除非显式标记为废弃）
❌ 禁止改变现有 public API 的签名或行为
❌ 禁止引入新的全局副作用

✅ 所有 CC 模式代码必须通过 KHY_CC_TUI=1 门控
✅ 门控关闭时，行为必须与修改前逐字节相同
✅ 新增文件优先于修改现有文件
```

### 0.2 渲染安全

```
❌ 禁止使用 \x1B[n;mr（DECSTBM 滚动区）—— 会杀死滚动历史
❌ 禁止在 resize 时使用 \x1B[2J（全屏清除）—— 会擦除滚动历史
❌ 禁止同步阻塞事件循环超过 16ms
❌ 禁止在渲染路径中执行 IO 操作（文件读写、网络请求）
❌ 禁止在组件 render 函数中创建新对象/数组（破坏 memo）

✅ 使用 \x1B[0J（ED0）清除光标到末尾
✅ 使用保存/恢复光标 + 绝对定位进行局部更新
✅ IO 操作必须异步化（Promise / setTimeout）
✅ render 函数中使用 useMemo / useCallback 稳定引用
```

### 0.3 性能底线

```
❌ 禁止冷启动超过 100ms
❌ 禁止单次渲染超过 16ms（60fps 底线）
❌ 禁止内存泄漏（未清理的定时器、事件监听）
❌ 禁止无防抖的 resize 处理
❌ 禁止无虚拟化的大列表渲染（> 100 条消息）

✅ 启动时间 < 100ms（冷启动），< 50ms（热启动）
✅ 单次渲染 < 16ms
✅ 组件卸载时清理所有定时器和监听器
✅ resize 防抖 50ms
✅ 消息列表虚拟化（仅渲染可见区域）
```

### 0.4 品牌与合规

```
❌ 禁止在 CC 模式 UI 中出现 "Claude Code" 或 "Claude" 品牌文本
❌ 禁止在 CC 模式 UI 中出现 Anthropic 版权信息
❌ 禁止修改 platform/khy_platform/__init__.py 中的 __version__

✅ 品牌文本使用 "Khy"（定义在 ccBrand.js）
✅ 版本信息从 package.json 动态读取
✅ 品牌替换通过 ccBrand.js 集中管理
```

### 0.5 opencode 自动读取

```
❌ 禁止阻塞 TUI 渲染等待 opencode 配置加载
❌ 禁止覆盖 khy 已有的 MCP 服务器配置
❌ 禁止因 opencode 配置错误导致启动失败

✅ 异步探测 opencode 配置（后台执行）
✅ 低优先级合并（不覆盖已有配置）
✅ fail-soft（配置错误时跳过，不影响启动）
✅ 通过 KHY_MCP_ECODE_AUTO_LOAD=0 可禁用
```

### 0.6 输入框约束

```
❌ 禁止在 CC 模式下使用边框包裹输入框
❌ 禁止光标闪烁间隔超过 530ms
❌ 禁止输入延迟超过 16ms
❌ 禁止覆盖模式下无视觉区分

✅ 无边框设计（对齐 Claude Code）
✅ 光标样式随模式变化（INSERT/NORMAL/SHELL/VOICE）
✅ 多行输入支持（Shift+Enter）
✅ 高度窗口化（超过 maxRows 时显示省略标记）
✅ 占位符使用灰色 #6B7280
```

### 0.7 表格与折叠约束

```
❌ 禁止边框嵌套深度 > 1 层
❌ 禁止状态信号 > 2 个/状态
❌ 禁止始终显示的标记（如每行都有 ▸）
❌ 禁止颜色超过 4 种

✅ 表头粗体 + 下划线分隔
✅ 列对齐：文本左、数字右、状态中
✅ 截断用 …，悬停/选中显示完整
✅ 折叠：▸ 折叠 / ▾ 展开
✅ 空状态显示友好提示 + 操作建议
✅ 响应式：窄终端隐藏次要列
```

### 0.8 注意力与选择约束

```
❌ 禁止焦点指示器模糊或缺失
❌ 禁止选中项与未选中项无区分
❌ 禁止模态对话框焦点逃逸
❌ 禁止危险操作默认聚焦

✅ 焦点：边框颜色变化（最强信号）
✅ 选中：反显背景 + ▸ 前缀
✅ 模态：焦点陷阱，Tab 不跳出
✅ 权限：默认安全选项，危险操作红色
✅ 鼠标：增强键盘，Shift 绕过
```

### 0.9 子视图与滚动约束

```
❌ 禁止子视图影响主对话滚动
❌ 禁止视图切换丢失位置状态
❌ 禁止复制操作影响选择状态
❌ 禁止历史搜索干扰当前输入

✅ 视图栈：Esc 返回上一层
✅ 滚动独立：浏览/选择/复制模式分离
✅ 复制：OSC 52 + 系统命令 fallback
✅ 历史：持久化到磁盘，支持搜索
✅ Resume：完成后显示摘要，Enter 继续
```

### 0.10 微交互与反馈约束

```
❌ 禁止复制操作无反馈
❌ 禁止滚动无边界指示
❌ 禁止错误消息无修复建议
❌ 禁止瞬态消息永久显示

✅ 复制：显示字符/字节数（copied N chars）
✅ 滚动：显示上下方内容指示（⋯ N above/below）
✅ Toast：3-5 秒自动消失
✅ Token：80% 黄色 / 95% 红色警告
✅ 工具超时：显示超时 + 重试建议
✅ 双击退出：首次提示，二次退出
```

### 0.11 快捷键与执行偏差约束

```
❌ 禁止破坏性操作无撤销
❌ 禁止模型跑偏无检测
❌ 禁止快捷键冲突无提示
❌ 禁止偏差无恢复建议

✅ 快捷键：集中注册，上下文感知
✅ Redo：r 重新生成，R 编辑后重做
✅ Fork：f 创建新分支
✅ Undo：z 撤销，Z 重做
✅ 偏差检测：循环检测 + 超时检测
✅ 检查点：失败后自动回滚
✅ 用户引导：可注入指导纠正模型
```

---

## 1. 门控策略

### 1.1 主开关

```javascript
// 唯一合法的门控检测方式
const isCcMode = process.env.KHY_CC_TUI === '1';
```

### 1.2 子功能门控

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `KHY_CC_TUI` | `0` | 主开关 |
| `KHY_CC_LOGO` | 跟随主开关 | Logo 样式 |
| `KHY_CC_STATUS_BAR` | 跟随主开关 | 状态栏样式 |
| `KHY_CC_MSG_STYLE` | 跟随主开关 | 消息渲染样式 |
| `KHY_CC_TOOL_STYLE` | 跟随主开关 | 工具卡片样式 |
| `KHY_CC_PERMISSION` | 跟随主开关 | 权限提示样式 |
| `KHY_CC_COMPLETION` | 跟随主开关 | 补全菜单样式 |
| `KHY_CC_COLORS` | 跟随主开关 | 主题色 |
| `KHY_CC_SIDEBAR` | 跟随主开关 | 右侧看板 |
| `KHY_CC_HELP` | 跟随主开关 | 帮助菜单 |

### 1.3 门控实现模式

```javascript
// ✅ 正确：条件渲染
function FooterBar() {
  if (isCcMode) {
    return <CcStatusLine />;
  }
  return <LegacyFooterBar />;
}

// ✅ 正确：提前返回
function StatusLine() {
  if (!isCcMode) return <LegacyStatusLine />;
  // CC 模式逻辑...
}

// ❌ 错误：在组件内部判断
function Message({ text }) {
  const color = isCcMode ? '#00D4D4' : '#00BCD4'; // 禁止！
  return <Text color={color}>{text}</Text>;
}
```

---

## 2. 渲染约束

### 2.1 布局规则

| 规则 | 值 | 说明 |
|------|-----|------|
| 状态栏高度 | **绝对 1 行** | 不能随内容变化 |
| 输入框最小高度 | **绝对 1 行** | 至少显示一行 |
| 输入框最大高度 | `min(10, rows * 0.3)` | 相对终端高度 |
| 右侧看板宽度 | `min(30, cols * 0.25)` | 相对终端宽度 |
| 主内容区宽度 | `cols - sidebarWidth` | 填充剩余 |
| 消息区高度 | `rows - 1 - inputHeight` | 减去状态栏和输入框 |
| 工具参数缩进 | **绝对 2 空格** | 固定缩进 |
| 边框字符 | **绝对精确** | `─│┌┐└┘├┤┬┴┼` |

### 2.2 颜色规则

```javascript
// ✅ 正确：从主题导入
const { CC_COLORS } = require('../theme/ccTheme');
<Text color={CC_COLORS.toolName}>Read</Text>

// ❌ 错误：硬编码颜色
<Text color="#00D4D4">Read</Text> // 禁止！

// ✅ 正确：使用 ANSI 缓存
const ansi = CC_COLORS.ansi;
process.stdout.write(`${ansi.toolBold}Read${ansi.reset}`);
```

### 2.3 渲染策略

| 内容类型 | 组件 | 策略 |
|----------|------|------|
| 已提交消息 | `<Static>` | memoize，仅 ID 变化时更新 |
| 流式输出 | `<StreamingBlock>` | 16ms 批量，增量 diff |
| 工具卡片 | `<CcToolCard>` | memoize，仅状态/结果变化时更新 |
| 状态栏 | `<CcStatusLine>` | 1秒间隔，memoize |
| 输入框 | `<CcPromptInput>` | 16ms 防抖，光标定位 |
| 右侧看板 | `<CcSidebarPanel>` | 按需渲染，面板切换时更新 |

### 2.4 Resize 处理

```javascript
// ✅ 正确：使用 ResizeHandler
const handler = new ResizeHandler({ debounceMs: 50 });
handler.on('resize', ({ cols, rows }) => {
  setDimensions({ cols, rows });
});
handler.start();

// ✅ 正确：组件卸载时清理
useEffect(() => {
  const handler = new ResizeHandler();
  handler.start();
  return () => handler.stop();
}, []);

// ❌ 错误：直接监听 stdout resize
process.stdout.on('resize', () => { ... }); // 禁止！
```

---

## 3. 计时器约束

### 3.1 计时器常量

```javascript
// 唯一合法的计时器常量来源
const { TIMING } = require('../utils/ccTimers');

// ✅ 正确
setInterval(updateStatusBar, TIMING.statusBar.interval);

// ❌ 错误：硬编码计时器
setInterval(updateStatusBar, 1000); // 禁止！
```

### 3.2 计时器清理

```javascript
// ✅ 正确：useEffect 返回清理函数
useEffect(() => {
  const timer = setInterval(fn, TIMING.statusBar.interval);
  return () => clearInterval(timer);
}, []);

// ✅ 正确：组件卸载时清理
useEffect(() => {
  const handler = new ResizeHandler();
  handler.start();
  return () => handler.stop();
}, []);

// ❌ 错误：不清理定时器
useEffect(() => {
  setInterval(fn, 1000);
}, []); // 禁止！
```

### 3.3 计时器优先级

| 计时器 | 间隔 | 优先级 | 说明 |
|--------|------|--------|------|
| 流式批量 | 16ms | 高 | 60fps，不可丢帧 |
| Spinner | 80ms | 中 | 12.5fps，终端足够 |
| 状态栏 | 1000ms | 低 | 1fps，不阻塞渲染 |
| MCP 轮询 | 5000ms | 低 | 0.2fps，后台运行 |
| Resize 防抖 | 50ms | 中 | 避免频繁重绘 |

---

## 4. 启动速度约束

### 4.1 启动阶段

```
阶段 1 (< 50ms): 核心渲染
  ├─ 加载 Ink 运行时（必须同步）
  ├─ 检测终端能力（必须同步）
  ├─ 初始化主题（必须同步）
  └─ 渲染欢迎界面（必须同步）

阶段 2 (异步，不阻塞交互):
  ├─ 连接 AI 网关
  ├─ 加载 MCP 配置
  ├─ 检查更新
  └─ 预热缓存

阶段 3 (< 100ms): 交互就绪
  ├─ 启用输入
  ├─ 启动状态栏轮询
  └─ 完成启动
```

### 4.2 延迟加载规则

```javascript
// ✅ 正确：非关键模块延迟加载
const CcHelpMenu = React.lazy(() => import('./CcHelpMenu'));

// ✅ 正确：条件加载
function showHelp() {
  if (!helpModule) {
    helpModule = require('./CcHelpMenu');
  }
  return helpModule;
}

// ❌ 错误：启动时加载所有模块
const CcHelpMenu = require('./CcHelpMenu'); // 禁止！
const CcSidebarPanel = require('./CcSidebarPanel'); // 禁止！
```

---

## 5. 文件组织约束

### 5.1 目录结构

```
tui/
├── AGENTS.md                    ← 本文件（工程约束）
├── app.js                       ← 入口（启动流程优化）
├── ink-components/              ← Ink 组件
│   ├── App.js                   ← 根组件（集成 resize + 渲染策略）
│   ├── CcStatusLine.js          ← CC 状态栏
│   ├── CcAssistantMessage.js    ← CC 助手消息
│   ├── CcToolCard.js            ← CC 工具卡片
│   ├── CcPromptInput.js         ← CC 输入框
│   ├── CcPermissionPrompt.js    ← CC 权限提示
│   ├── CcFuzzyPicker.js         ← CC 补全菜单
│   ├── CcHelpMenu.js            ← CC 帮助菜单
│   ├── CcLogo.js                ← CC Logo
│   ├── CcMcpStatus.js           ← MCP 状态栏
│   ├── CcMcpPanel.js            ← MCP 详情面板
│   ├── CcSidebarPanel.js        ← 右侧看板容器
│   ├── CcSidebarContext.js      ← Context 面板
│   ├── CcSidebarFiles.js        ← Files 面板
│   ├── CcSidebarTools.js        ← Tools 面板
│   ├── CcSidebarStats.js        ← Stats 面板
│   └── CcSidebarMcp.js          ← MCP 面板
├── utils/                       ← 工具函数
│   ├── ccMode.js                ← 门控检测
│   ├── ccBrand.js               ← 品牌文本
│   ├── ccFormatters.js          ← 格式化函数
│   ├── ccToolFormat.js          ← 工具参数格式化
│   ├── ccResizeHandler.js       ← Resize 处理
│   ├── ccRenderStrategy.js      ← 渲染策略
│   ├── ccTimers.js              ← 计时器常量
│   ├── ccLayout.js              ← 布局计算
│   ├── ccContextWindows.js      ← 模型上下文窗口
│   └── ccPricing.js             ← 模型定价
├── hooks/                       ← React Hooks
│   ├── useMcpStatus.js          ← MCP 状态桥接
│   └── useSidebarState.js       ← 右侧看板状态
└── theme/                       ← 主题
    ├── ccTheme.js               ← CC 主题色板
    └── themeRegistry.js         ← 主题注册
```

### 5.2 文件命名规则

| 类型 | 前缀 | 示例 |
|------|------|------|
| CC 模式专用组件 | `Cc` | `CcStatusLine.js` |
| CC 模式专用工具 | `cc` | `ccFormatters.js` |
| CC 模式专用 Hook | `use` + 功能 | `useMcpStatus.js` |
| Legacy 组件 | 无前缀 | `FooterBar.js` |

### 5.3 禁止事项

```
❌ 禁止在 tui/ 目录外创建 CC 模式相关文件
❌ 禁止在 tui/ 目录内创建非 CC 模式的无关文件
❌ 禁止修改 Legacy 组件的内部实现
❌ 禁止在 CC 组件中直接引用 Legacy 组件
```

---

## 6. 代码风格约束

### 6.1 通用规则

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
```

### 6.2 组件规则

```javascript
// ✅ 正确：函数组件 + React.memo
function CcStatusLine({ model, context, cost }) {
  return <Text>{model}</Text>;
}
module.exports = { CcStatusLine: React.memo(CcStatusLine) };

// ✅ 正确：props 解构
function CcToolCard({ name, params, status, result }) {
  // ...
}

// ❌ 错误：类组件
class CcStatusLine extends React.Component { // 禁止！
  render() { return <Text />; }
}
```

### 6.3 错误处理

```javascript
// ✅ 正确：try/catch + fail-soft
async function loadMcpServers() {
  try {
    return await getMcpServers();
  } catch {
    return []; // 失败返回空数组，不阻塞渲染
  }
}

// ✅ 正确：错误边界
function ErrorBoundary({ children }) {
  const [error, setError] = useState(null);
  if (error) {
    return <Text color="#F87171">渲染错误: {error.message}</Text>;
  }
  return children;
}

// ❌ 错误：抛出异常
function loadConfig() {
  if (!config) throw new Error('Config not found'); // 禁止！
}
```

---

## 7. 测试约束

### 7.1 必须测试的场景

| 场景 | 测试内容 |
|------|----------|
| 门控开关 | `KHY_CC_TUI=1` 和未设置时行为正确 |
| Resize | 放大/缩小无残影，布局正确 |
| 流式输出 | 60fps 无卡顿 |
| 工具调用 | 状态变化正确渲染 |
| MCP 状态 | 连接/断开/失败状态正确 |
| 启动速度 | 冷启动 < 100ms |
| 内存泄漏 | 定时器/监听器正确清理 |

### 7.2 性能测试

```javascript
// ✅ 正确：测量渲染时间
const start = performance.now();
render(<App />);
const duration = performance.now() - start;
assert(duration < 100, `启动时间 ${duration}ms 超过 100ms 底线`);

// ✅ 正确：测量内存使用
const before = process.memoryUsage().heapUsed;
// ... 执行操作
const after = process.memoryUsage().heapUsed;
const delta = after - before;
assert(delta < 50 * 1024 * 1024, `内存增长 ${delta} 超过 50MB 底线`);
```

---

## 8. 验收清单

### 8.1 Phase 1 验收

- [ ] `KHY_CC_TUI=1 khy` 启动后显示 Khy 品牌 Logo
- [ ] 用户消息无背景框，纯文本显示
- [ ] 工具调用使用 🔧 + 粗体青色
- [ ] 状态栏单行，格式正确
- [ ] 冷启动 < 100ms
- [ ] Resize 无残影
- [ ] Legacy 模式行为不变

### 8.2 Phase 2 验收

- [ ] 状态栏格式：Model │ Context │ Cost
- [ ] MCP 状态显示正确
- [ ] 右侧看板 ≥ 120 列时自动显示
- [ ] 看板面板切换正常
- [ ] 渲染帧率 ≥ 30 FPS

### 8.3 Phase 3 验收

- [ ] 助手消息 ● 前缀
- [ ] 工具调用独立卡片（无过程组）
- [ ] 工具结果块边框正确
- [ ] 思考折叠块可展开/折叠

### 8.4 最终验收

- [ ] 所有门控开关正常
- [ ] 帮助菜单覆盖层正常
- [ ] 斜杠命令菜单正常
- [ ] OpenAI 模型名格式化正确
- [ ] 启动速度 < 100ms
- [ ] 渲染无残影
- [ ] 内存 < 50MB
- [ ] Legacy 模式零破坏

---

## 9. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-09-09 | 初始版本，定义 CC TUI 复刻工程约束 |
