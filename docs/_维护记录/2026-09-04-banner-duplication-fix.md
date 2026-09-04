# Banner 重复显示问题——根因分析、修复与 TUI 渲染架构说明

**日期**：2026-09-04
**影响范围**：khy TUI 启动界面
**严重度**：高（核心功能不可用）
**修复耗时**：~4 小时调试 + 修复

---

## 问题现象

khy 启动后，欢迎界面（banner + ASCII art + 输入框 + 状态栏）完整显示两次，上下堆叠。
每次重启都复现，与终端类型无关（Windows PowerShell / Windows Terminal 均可复现）。

最终状态：banner 消失或位置错误（对话显示在 banner 上方）。

---

## khyos TUI 渲染架构

### 核心组件：Ink (React for CLI)

khyos 使用 [Ink](https://github.com/vadimdemedes/ink) 框架渲染终端 UI。Ink 将 React 组件树转换为 ANSI 转义序列输出到 stdout。

### 三大渲染区域

```
┌─────────────────────────────────────────┐
│  <Static> 区域（已提交，不可变）          │
│  ┌─────────────────────────────────────┐ │
│  │ Banner（欢迎信息 + ASCII art）       │ │ ← 区域①
│  ├─────────────────────────────────────┤ │
│  │ MessageBlock（对话消息 1）           │ │ ← 区域②
│  │ MessageBlock（对话消息 2）           │ │
│  │ ...                                 │ │
│  └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│  Live Region（实时更新）                 │
│  ┌─────────────────────────────────────┐ │
│  │ StreamingBlock（流式输出）           │ │
│  │ PromptFrame（输入框）                │ │
│  │ FooterBar（状态栏）                  │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

#### 1. `<Static>` 区域
- **特性**：已提交的内容不可变，Ink 只渲染新增项
- **内容**：banner + 历史对话消息
- **位置**：终端顶部
- **数据源**：`query.staticItems`（由 `staticItemsMemo.buildStaticItems()` 构建）

#### 2. Live Region
- **特性**：每次 re-render 实时更新
- **内容**：流式输出、输入框、状态栏
- **位置**：终端底部
- **数据源**：React state（`streaming`、`status`、`inputActive` 等）

#### 3. 右侧任务栏（可选）
- **特性**：绝对坐标定位，独立于 Ink 布局
- **内容**：任务列表、计划面板
- **门控**：`KHY_SIDEBAR_RAIL` 环境变量

### 渲染流程

```
用户启动 khy
    │
    ▼
startInkApp() → 加载 Ink、创建 Proxy stdout、挂载 App 组件
    │
    ▼
App 组件首次渲染
    │
    ├── sidebarRail.enable() → 同步初始化（useState 初始化器）
    │
    ├── buildStaticItems(messages) → 构建 staticItems 数组
    │   └── items[0] = { kind: 'banner' }  ← Banner 作为第一个 item
    │   └── items[1..n] = { kind: 'message', msg: ... }
    │
    ├── _bannerElementRef = h(MemoWelcomeBanner, ...) ← 创建 banner 元素
    │
    └── render() 输出到 stdout
        │
        ├── <Static> 渲染 banner + 历史消息 → 提交到 scrollback
        │
        └── Live Region 渲染输入框 + 状态栏 → 实时更新
```

### 关键文件

| 文件 | 职责 |
|------|------|
| `cli/tui/app.js` | TUI 入口：加载 Ink、创建 Proxy stdout、挂载 App |
| `cli/tui/ink-components/App.js` | 主组件：布局、banner 创建、live region |
| `cli/tui/ink-components/WelcomeBanner.js` | Banner 组件：ASCII art + 版本信息 |
| `cli/tui/staticItemsMemo.js` | 构建 staticItems 数组（banner + 消息） |
| `cli/tui/hooks/useQueryBridge.js` | 数据桥接：messages → staticItems |
| `cli/tui/scrollbackPreserve.js` | 滚动缓冲保护：4 层防御 |
| `cli/tui/runtime/sidebarRail.js` | 右侧任务栏渲染 |

---

## 根因链（4 层叠加）

### 第 1 层：shim 错误加载测试文件（触发源）

**文件**：`services/backend/src/services/query/index.js`

**问题**：domain 分层重构后，自动生成的 shim 脚本遍历目录时未排除 `.test.js` 文件：

```js
// 第 11 行（已删除）
exports.responseDebounce.test = require('../domain/query/query/responseDebounce.test.js');
```

**因果链**：
1. `responseDebounce.test.js` 顶部 `require('node:test')` 注册测试钩子
2. `require()` 时所有顶层 `test()` 立即执行，TAP 输出写入 stdout
3. stdout 输出出现在 Ink TUI 渲染之后 → 终端滚动
4. Ink 的 `log-update` 检测到行数变化 → 触发全屏重绘
5. 全屏重绘把 banner 重新 emit 到 scrollback → 重复

**修复**：
```diff
 exports.responseDebounce = require('../domain/query/query/responseDebounce.js');
-exports.responseDebounce.test = require('../domain/query/query/responseDebounce.test.js');
 exports.seamlessResume = require('../domain/query/query/seamlessResume.js');
```

---

### 第 2 层：`sidebarRail.enable()` 异步化（放大器）

**文件**：`cli/tui/ink-components/App.js`

**问题**：本地改动把 `sidebarRail.enable()` 从 `useState` 同步初始化移到了 `useEffect` 异步执行：

```js
// v1.1.12（正确）：
const [railOn, setRailOn] = React.useState(() => {
  try { return sidebarRail.enable(process.stdout); }
  catch { return false; }
});

// 本地改动（错误）：
const [railOn, setRailOn] = React.useState(false);
React.useEffect(() => {
  let on = false;
  try { on = sidebarRail.enable(process.stdout); } catch { on = false; }
  if (on) { setRailOn(true); }
  return () => { try { sidebarRail.disable(); } catch {} };
}, []);
```

**因果链**：
1. **第一帧**：`useEffect` 未执行 → `railOn = false`
2. `_bannerInLiveRef.current = _sidebarOn`（依赖 `railOn`）→ `_bannerInLive = false`
3. banner 被提交到 `<Static>`（committed，不可变）
4. **第二帧**：`useEffect` 执行 → `setRailOn(true)` → 触发 re-render
5. `_bannerInLive` 变为 `true` → banner 在 live region 重新创建
6. `<Static>` 中的旧 banner 不可移除 → **两份 banner 同时存在**

**修复**：还原为 `useState(() => sidebarRail.enable())` 同步初始化。

---

### 第 3 层：banner 创建条件过严（修复后暴露）

**文件**：`cli/tui/ink-components/App.js`

**问题**：修复前两层后，banner 完全消失。原因是 `_showStartupBanner` 条件：

```js
const _showStartupBanner = query.messages.length === 0;
if (_bannerElementRef.current === null) {
  if (_showStartupBanner) {  // ← 有历史消息时为 false
    _bannerElementRef.current = h(MemoWelcomeBanner, ...);
  }
}
```

**因果链**：
1. 用户有持久化会话（`sessions.db` 中有消息）
2. `query.messages.length > 0` → `_showStartupBanner = false`
3. banner 不创建 → `_liveBannerElement = null` → 无 banner

**修复**：移除 `_showStartupBanner` 条件，banner 始终创建。

---

### 第 4 层：banner 位置错误（布局问题）

**文件**：`cli/tui/ink-components/App.js` + `cli/tui/staticItemsMemo.js`

**问题**：banner 在 live region 中渲染（底部），对话消息在 `<Static>` 中渲染（顶部），导致对话显示在 banner 上方。

**因果链**：
1. `_liveBannerElement` 在 live region 中渲染 → 位于终端底部
2. 对话消息在 `<Static>` 中渲染 → 位于终端顶部
3. 用户看到：对话在上，banner 在下 → 顺序错误

**修复**：
1. `staticItemsMemo.js`：banner 作为第一个 item（`kind: 'banner'`）添加到 `staticItems`
2. `App.js`：`<Static>` 渲染器检测 `kind: 'banner'` 并渲染 banner
3. `App.js`：从 live region 中移除 banner

```js
// staticItemsMemo.js
function buildStaticItems(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const items = new Array(msgs.length + 1);
  items[0] = { kind: 'banner', key: 'banner' };  // ← Banner 作为第一个 item
  for (let i = 0; i < msgs.length; i++) {
    items[i + 1] = { kind: 'message', key: `m${i}`, msg: msgs[i] };
  }
  return items;
}

// App.js — <Static> 渲染器
h(Static, { items: query.staticItems }, (item) => {
  if (item.kind === 'banner') {
    return _liveBannerElement;  // ← 渲染 banner
  }
  return h(Transcript.MessageBlock, { key: item.key, msg: item.msg, expanded });
});

// App.js — live region 中移除 banner
// (删除 _liveBannerElement 的引用)
```

---

## 最终修复后的布局

```
┌─────────────────────────────────────────┐
│  <Static> 区域                          │
│  ┌─────────────────────────────────────┐ │
│  │ Banner（欢迎信息 + ASCII art）       │ │ ← 始终在顶部
│  ├─────────────────────────────────────┤ │
│  │ MessageBlock（对话消息 1）           │ │
│  │ MessageBlock（对话消息 2）           │ │
│  │ ...                                 │ │
│  └─────────────────────────────────────┘ │
├─────────────────────────────────────────┤
│  Live Region                            │
│  ┌─────────────────────────────────────┐ │
│  │ StreamingBlock（流式输出）           │ │
│  │ PromptFrame（输入框）                │ │
│  │ FooterBar（状态栏）                  │ │
│  └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
```

---

## 调试方法论

### 1. 排除法（缩小范围）
设置环境变量禁用 scrollbackPreserve 的 Layer 3/4，确认问题不在 scrollbackPreserve：
```powershell
$env:KHY_SUPPRESS_STATIC_REPRINT = '0'
$env:KHY_FULLSCREEN_TAILCUT = '0'
```

### 2. 二分法（定位变更）
对比 v1.1.12 与 HEAD 的 diff，聚焦 TUI 相关文件：
```powershell
git diff v1.1.12..HEAD -- "services/backend/src/cli/tui/" --stat
git diff v1.1.12..HEAD -- "services/backend/src/cli/tui/ink-components/App.js"
```

### 3. 溯源法（追踪输出）
从 TAP 输出文本反向追踪到加载源：
```powershell
findstr /S /N "前缀残留" services\backend\src\*.js
# → responseDebounce.test.js
# → 检查谁 require 了它 → shim 文件
```

### 4. 对照法（v1.1.12 基准）
关键代码模式必须与 v1.1.12 一致：
- `railOn` 初始化：`useState(() => enable())` 同步
- banner 在 `<Static>` 中渲染（不在 live region）
- `staticItems[0]` 是 banner

---

## 涉及文件

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `services/query/index.js` | 删除行 | 移除 `.test.js` 文件的导出 |
| `cli/tui/ink-components/App.js` | 还原 + 重构 | 还原 `railOn` 同步初始化 + banner 移至 `<Static>` |
| `cli/tui/staticItemsMemo.js` | 添加逻辑 | banner 作为第一个 item 添加到 `staticItems` |

---

## 防御措施

1. **shim 生成脚本**：排除 `*.test.js` 文件，避免测试代码混入生产路径
2. **useState 初始化器**：有副作用的初始化（如 `enable()` 写 ANSI 到 stdout）必须在 `useState` 同步执行，不能移到 `useEffect`
3. **banner 生命周期**：banner 应在 `<Static>` 中渲染（顶部），不在 live region（底部）
4. **staticItems 结构**：`staticItems[0]` 必须是 banner，`kind: 'banner'`

---

## 关键教训

- **shim 自动生成需要排除测试文件**：domain 重构的 shim 生成脚本遍历目录时未过滤 `*.test.js`，导致测试代码在生产环境执行
- **React `useState` vs `useEffect` 的时序差异**：`useState` 初始化器在渲染前同步执行，`useEffect` 在渲染后异步执行——这个时序差异会导致首帧状态不一致
- **层层叠加的 bug**：单独看每一层都不致命，但四层叠加后问题被放大——shim 加载测试文件触发终端滚动，`railOn` 异步化导致 banner 在错误区域渲染，`_showStartupBanner` 条件导致 banner 消失，live region 渲染导致位置错误
- **Ink 渲染区域分离**：`<Static>` 用于不可变内容（顶部），live region 用于实时更新（底部）——banner 必须放在 `<Static>` 中
