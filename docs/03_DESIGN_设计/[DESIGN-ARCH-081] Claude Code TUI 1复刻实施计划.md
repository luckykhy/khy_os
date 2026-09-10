# [DESIGN-ARCH-081] Claude Code TUI 1:1 复刻实施计划（Khy 品牌版）

> **定位**：定义 khy-os TUI 复刻 Claude Code 官方 TUI 的 1:1 视觉与交互实施方案，品牌替换为 Khy，全面支持 OpenAI 协议。
> **适用边界**：覆盖 `services/backend/src/cli/tui/` 全部 Ink 组件；不替代 `[DESIGN-ARCH-079]`（TUI 界面设计规范）——冲突时以本规范为准（CC 复刻模式优先）。
> **核心原则**：
> 1. **零破坏**：所有变更通过 `KHY_CC_TUI=1` 环境变量门控，默认关闭，现有行为零改动
> 2. **渐进式**：分 6 个 Phase 实施，每个 Phase 可独立验证、独立回滚
> 3. **1:1 视觉还原**：颜色、间距、边框、字体、动画全部对齐 Claude Code 官方实现
> 4. **品牌替换**：所有 Claude Code 品牌元素替换为 Khy（Logo、标题、提示文本）
> 5. **OpenAI 协议支持**：状态栏、模型选择器、格式化函数全面兼容 OpenAI 模型名
> 6. **保留 khy 特色功能**：中文优先、过程组、计划模式、语音输入等 khy 独有功能在 CC 模式下仍可访问

---

## 0. 术语表

| 术语 | 含义 |
|------|------|
| **CC 模式** | `KHY_CC_TUI=1` 激活的 Claude Code 复刻模式 |
| **Legacy 模式** | `KHY_CC_TUI` 未设置时的默认 khy-os TUI |
| **CC Orange** | Claude Code 品牌色 `#D77757` |
| **CC Blue** | Claude Code 次要色 `#5769F7` |
| **BLACK_CIRCLE** | `●` (U+25CF) — CC 助手消息前缀 |
| **WHITE_CIRCLE** | `○` (U+25CB) — CC 工具执行中指示器 |
| **CHECK_MARK** | `✓` (U+2713) — CC 工具完成指示器 |
| **CROSS_MARK** | `✗` (U+2717) — CC 工具失败指示器 |
| **DIAMOND** | `◆` (U+25C6) — CC 权限/模式指示器 |
| **ELBOW** | `⎿` (U+23FF) — CC 工具结果缩进引导符 |
| **BOX_DRAWING** | `│` (U+2502) — CC 状态栏分隔符 |

---

## 1. 性能优化与渲染策略

### 1.1 核心性能指标

| 指标 | 目标值 | 测量方式 |
|------|--------|----------|
| **冷启动时间** | < 100ms | 从命令执行到首帧渲染 |
| **热启动时间** | < 50ms | 从命令执行到首帧渲染（有缓存） |
| **帧率** | ≥ 30 FPS | 流式输出时的渲染帧率 |
| **输入延迟** | < 16ms | 按键到屏幕响应 |
| **调整大小** | 无残影 | 终端放大/缩小无残留 |
| **内存占用** | < 50MB | CC 模式运行时内存 |

### 1.2 调整大小无残影（Resize Without Ghosting）

**问题描述**：终端窗口大小变化时，旧内容残留在新边界外，形成"鬼影"。

**解决方案**：

```javascript
// tui/utils/ccResizeHandler.js

'use strict';

/**
 * 终端 resize 处理器 —— 确保无残影
 * 
 * 策略：
 * 1. 监听 resize 事件（防抖 50ms）
 * 2. 清除整个终端（使用 ED0 而非 ED2，保留滚动历史）
 * 3. 重新计算布局
 * 4. 增量更新（仅重绘变化区域）
 */

const { EventEmitter } = require('events');

class ResizeHandler extends EventEmitter {
  constructor(options = {}) {
    super();
    this._debounceMs = options.debounceMs || 50;
    this._pending = null;
    this._lastCols = process.stdout.columns;
    this._lastRows = process.stdout.rows;
  }

  start() {
    process.stdout.on('resize', this._onResize);
  }

  stop() {
    process.stdout.removeListener('resize', this._onResize);
    if (this._pending) {
      clearTimeout(this._pending);
      this._pending = null;
    }
  }

  _onResize = () => {
    if (this._pending) clearTimeout(this._pending);
    this._pending = setTimeout(() => {
      this._pending = null;
      const cols = process.stdout.columns;
      const rows = process.stdout.rows;
      if (cols !== this._lastCols || rows !== this._lastRows) {
        this._lastCols = cols;
        this._lastRows = rows;
        this.emit('resize', { cols, rows });
      }
    }, this._debounceMs);
  };
}

module.exports = { ResizeHandler };
```

**关键规则**：

| 规则 | 说明 |
|------|------|
| **使用 ED0 而非 ED2** | `\x1B[0J` 清除光标到末尾，保留滚动历史 |
| **避免 `\x1B[2J`** | 全屏清除会擦除滚动历史 |
| **防抖 50ms** | 避免频繁 resize 导致闪烁 |
| **增量更新** | 仅重绘变化区域，不重绘整个屏幕 |
| **绝对定位重绘** | 使用 `\x1B[{row};{col}H` 定位光标后重绘 |

### 1.3 绝对值 vs 相对值设置

#### 1.3.1 绝对禁止（必须使用绝对值）

| 设置项 | 绝对值 | 原因 |
|--------|--------|------|
| **边框字符** | `─│┌┐└┘├┤┬┴┼` | 必须精确对齐，不能有偏差 |
| **工具缩进** | 2 字符 | JSON 参数缩进必须固定 |
| **状态栏高度** | 1 行 | 单行状态栏，不能随内容变化 |
| **输入框最小高度** | 1 行 | 至少显示一行输入 |
| **分割线宽度** | 1 字符 | 垂直/水平分割线 |
| **Tab 缩进** | 2 空格 | 标签页内容缩进 |

#### 1.3.2 相对值（根据终端尺寸计算）

| 设置项 | 计算方式 | 说明 |
|--------|----------|------|
| **右侧看板宽度** | `min(30, cols * 0.25)` | 固定 30 列或终端宽度的 25% |
| **主内容区宽度** | `cols - sidebarWidth` | 终端宽度减去看板宽度 |
| **消息区域高度** | `rows - statusBarHeight - inputHeight` | 总行数减去状态栏和输入框 |
| **输入框最大高度** | `min(10, rows * 0.3)` | 最多 10 行或终端高度的 30% |
| **补全菜单最大高度** | `min(15, rows * 0.4)` | 最多 15 行或终端高度的 40% |
| **帮助菜单宽度** | `min(80, cols * 0.8)` | 最多 80 列或终端宽度的 80% |

#### 1.3.3 混合值（绝对值 + 相对值）

| 设置项 | 计算方式 | 说明 |
|--------|----------|------|
| **状态栏分隔符** | ` │ ` (固定 3 字符) | 两侧空格 + 竖线 |
| **工具名宽度** | `max(10, min(20, cols * 0.15))` | 10-20 字符之间 |
| **消息内边距** | `max(1, cols * 0.02)` | 至少 1 字符 |

### 1.4 渲染速度优化

#### 1.4.1 渲染策略

```javascript
// tui/utils/ccRenderStrategy.js

'use strict';

/**
 * CC 模式渲染策略
 * 
 * 核心原则：
 * 1. 静态内容使用 <Static> 组件（不重新渲染）
 * 2. 流式内容使用增量更新（仅更新变化部分）
 * 3. 批量更新（合并多次状态更新为一次渲染）
 * 4. 虚拟化（仅渲染可见区域）
 */

const RENDER_STRATEGY = {
  // 静态内容（已提交的消息）
  static: {
    component: 'Static',
    memoize: true,
    shouldUpdate: (prev, next) => prev.id !== next.id,
  },

  // 流式内容（正在输出的消息）
  streaming: {
    component: 'StreamingBlock',
    batchInterval: 16,    // 60fps 批量更新
    maxChunkSize: 1024,
    useDiff: true,
  },

  // 工具调用卡片
  toolCard: {
    component: 'CcToolCard',
    memoize: true,
    shouldUpdate: (prev, next) => 
      prev.status !== next.status || prev.result !== next.result,
  },

  // 状态栏
  statusBar: {
    component: 'CcStatusLine',
    updateInterval: 1000, // 每秒更新
    memoize: true,
  },

  // 输入框
  input: {
    component: 'CcPromptInput',
    debounce: 16,
    useCaret: true,
  },
};

module.exports = { RENDER_STRATEGY };
```

#### 1.4.2 性能优化清单

| 优化项 | 方法 | 效果 |
|--------|------|------|
| **React.memo** | 所有纯展示组件使用 memo | 减少 50%+ 重绘 |
| **useMemo** | 复杂计算结果缓存 | 避免重复计算 |
| **批量更新** | 合并多次 setState | 减少渲染次数 |
| **虚拟化** | 仅渲染可见消息 | 支持 1000+ 消息不卡顿 |
| **增量 diff** | 仅更新变化字符 | 流式输出更平滑 |
| **懒加载** | 大结果延迟加载 | 减少首帧时间 |
| **ANSI 缓存** | 缓存颜色转义序列 | 减少字符串拼接 |

### 1.5 计时与实时画面

#### 1.5.1 计时器规范

```javascript
// tui/utils/ccTimers.js

'use strict';

/**
 * CC 模式计时器管理
 */

const TIMING = {
  // 流式输出
  streaming: {
    batchInterval: 16,      // 60fps 批量更新
    chunkSize: 512,         // 每批处理的字符数
    flushThreshold: 1024,   // 超过此值立即刷新
  },

  // 状态栏更新
  statusBar: {
    interval: 1000,         // 每秒更新一次
    priority: 'low',
  },

  // Spinner 动画
  spinner: {
    interval: 80,           // 12.5fps
    frames: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
  },

  // MCP 状态轮询
  mcp: {
    interval: 5000,         // 每 5 秒轮询
    timeout: 2000,
  },

  // 输入防抖
  input: {
    debounce: 16,
  },

  // Resize 防抖
  resize: {
    debounce: 50,
  },

  // 思考块折叠/展开
  thinking: {
    animationDuration: 200,
  },
};

module.exports = { TIMING };
```

#### 1.5.2 实时画面渲染流程

```
用户输入 → 16ms防抖 → 状态更新 → 批量渲染（16ms间隔）
                ↓
         流式输出 → 512字符/批 → 增量diff → 局部更新
                ↓
         工具调用 → 状态变更 → 仅更新工具卡片
                ↓
         状态栏 → 1秒间隔 → 仅更新状态栏行
```

### 1.6 启动速度优化

#### 1.6.1 冷启动优化

| 优化项 | 方法 | 效果 |
|--------|------|------|
| **延迟加载** | 非关键模块按需加载 | 减少首屏 JS 解析时间 |
| **代码分割** | 按路由/功能拆分 chunk | 减少初始加载体积 |
| **预编译** | 模板/正则预编译 | 减少运行时编译 |
| **缓存** | 缓存终端能力检测 | 避免重复检测 |
| **并行初始化** | 非依赖模块并行加载 | 缩短初始化时间 |

#### 1.6.2 启动流程优化

```
阶段 1: 核心渲染（< 50ms）
  ├─ 加载 Ink 运行时
  ├─ 检测终端能力
  ├─ 初始化主题
  └─ 渲染欢迎界面

阶段 2: 后台初始化（异步）
  ├─ 连接 AI 网关
  ├─ 加载 MCP 配置
  ├─ 检查更新
  └─ 预热缓存

阶段 3: 交互就绪（< 100ms）
  ├─ 启用输入
  ├─ 启动状态栏轮询
  └─ 完成启动
```

### 1.7 实施文件（性能优化）

| 文件 | 变更 |
|------|------|
| `tui/utils/ccResizeHandler.js` | **新建** —— 终端 resize 无残影处理 |
| `tui/utils/ccRenderStrategy.js` | **新建** —— 渲染策略配置 |
| `tui/utils/ccTimers.js` | **新建** —— 计时器常量管理 |
| `tui/utils/ccLayout.js` | **新建** —— 布局计算（绝对值+相对值混合） |
| `tui/ink-components/App.js` | 集成 resize 处理器 + 渲染策略 |
| `tui/app.js` | 启动流程优化（延迟加载 + 并行初始化） |

---

## 2. 启动时自动读取 opencode 配置

### 2.1 需求定位

khy-os 启动时，自动检测当前项目目录或用户主目录中的 opencode 配置，将其 MCP servers 自动加载到 khy-os 的 MCP 运行时中。实现"目录启动即复用"的无缝体验。

### 2.2 opencode 配置文件位置

| 优先级 | 路径 | 类型 | 说明 |
|--------|------|------|------|
| 1 | `<project>/.opencode/config.json` | 项目级 | 当前工作目录下的配置 |
| 2 | `<project>/opencode.json` | 项目级(备用) | 平铺式配置 |
| 3 | `~/.config/opencode/config.json` | 全局级 | 用户主配置 |
| 4 | `~/.opencode/config.json` | 全局级(备用) | 备用路径 |

### 2.3 opencode 配置格式(推测)

```jsonc
// ~/.config/opencode/config.json 或 .opencode/config.json
{
  "model": "claude-sonnet-4",
  "mcp": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_xxx" }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]
    }
  }
}
```

**关键差异**：opencode 使用 `mcp` 键(而非 `mcpServers`)，这是与 Claude Code / Cursor 的主要区别。

### 2.4 启动时自动读取流程

```
khy 启动
  │
  ├─ 阶段 1: 核心渲染(< 50ms)
  │   └─ 不阻塞，异步探测 opencode 配置
  │
  ├─ 阶段 2: 异步探测(后台)
  │   ├─ 1. 检查项目目录 .opencode/config.json
  │   ├─ 2. 检查项目目录 opencode.json
  │   ├─ 3. 检查 ~/.config/opencode/config.json
  │   └─ 4. 检查 ~/.opencode/config.json
  │
  ├─ 阶段 3: 配置解析
  │   ├─ JSON5 容错解析(允许注释 + 尾逗号)
  │   ├─ 提取 `mcp` 键
  │   └─ 标准化为 khy MCP server 格式
  │
  └─ 阶段 4: 自动连接
      ├─ 合并到 khy MCP 运行时(低优先级，不覆盖已有)
      ├─ 启动 MCP servers
      └─ 状态栏显示连接状态
```

### 2.5 实施文件

| 文件 | 变更 |
|------|------|
| `services/mcp/oeMcpBridge.js` | **新建** — opencode MCP 配置桥接 |
| `services/mcp/mcpEcosystemRegistry.js` | 新增 opencode 生态条目 |
| `services/mcp/index.js` | 集成 opencode 配置加载 |
| `tui/utils/ccMcpAutoLoad.js` | **新建** — 启动时自动加载逻辑 |

### 2.6 门控

| 环境变量 | 默认 | 说明 |
|----------|------|------|
| `KHY_MCP_ECODE_BRIDGE` | `1`(开) | opencode 桥接总开关 |
| `KHY_MCP_ECODE_AUTO_LOAD` | `1`(开) | 启动时自动加载 |

### 2.7 探测实现

```javascript
// tui/utils/ccMcpAutoLoad.js

'use strict';

/**
 * 启动时自动探测并加载 opencode MCP 配置
 * 异步执行，不阻塞 TUI 渲染
 */

const fs = require('fs');
const path = require('path');
const { oeMcpConfigSources, parseConfig, extractMcpServers } = require('../../services/mcp/oeMcpBridge');

/**
 * 探测 opencode 配置(异步)
 * @returns {Promise<{servers: object, sources: string[]}>}
 */
async function probeOpencodeConfig() {
  const sources = oeMcpConfigSources({
    homedir: require('os').homedir(),
    env: process.env,
  });

  const servers = {};
  const loadedSources = [];

  for (const { path: filePath, kind } of sources) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const text = fs.readFileSync(filePath, 'utf8');
      const parsed = parseConfig(text);
      if (!parsed) continue;
      const mcpServers = extractMcpServers(parsed);
      if (Object.keys(mcpServers).length > 0) {
        Object.assign(servers, mcpServers);
        loadedSources.push(`${kind}:${filePath}`);
      }
    } catch {
      // fail-soft: 单个源失败不影响其他源
    }
  }

  return { servers, sources: loadedSources };
}

/**
 * 自动加载 opencode MCP 到 khy 运行时
 * @param {object} mcpRuntime - khy MCP 运行时实例
 */
async function autoLoad(mcpRuntime) {
  if (process.env.KHY_MCP_ECODE_AUTO_LOAD === '0') return;

  try {
    const { servers, sources } = await probeOpencodeConfig();
    if (Object.keys(servers).length === 0) return;

    // 低优先级合并(不覆盖 khy 已有配置)
    for (const [name, config] of Object.entries(servers)) {
      if (!mcpRuntime.hasServer(name)) {
        mcpRuntime.addServer(name, { ...config, _opencodeBridge: true });
      }
    }

    return { count: Object.keys(servers).length, sources };
  } catch {
    return { count: 0, sources: [] };
  }
}

module.exports = { probeOpencodeConfig, autoLoad };
```

### 2.8 验收标准

| 场景 | 预期 |
|------|------|
| 项目目录有 `.opencode/config.json` | 自动加载其中的 MCP servers |
| 项目目录有 `opencode.json` | 自动加载(备用路径) |
| 无项目配置但有全局配置 | 加载全局配置 |
| 配置格式错误 | fail-soft，跳过错误源，不影响启动 |
| `KHY_MCP_ECODE_AUTO_LOAD=0` | 不加载，行为与修改前相同 |
| 加载成功 | 状态栏显示 `MCP •N Connected` |

---

## 3. 品牌替换规范

### 1.1 品牌元素映射

| Claude Code 元素 | Khy 替换 | 类型 | 出现位置 |
|-------------------|----------|------|----------|
| `Claude Code` 标题 | `Khy` | 文本 | Logo、欢迎横幅、状态栏 |
| `✳ Claude Code` Logo | `✳ Khy` | 文本+动画 | 欢迎区、REPL 顶部 |
| `AnimatedClawd` 动画 | `AnimatedKhy` | 组件 | Logo 区域 |
| `Claude` 模型前缀 | 保留原始模型名 | 文本 | 状态栏、模型选择器 |
| `claude-opus-4.6` 等 | `gpt-4o` / `claude-...` | 模型ID | 全部模型相关UI |
| `Powered by Claude` | `Powered by Khy` | 文本 | 关于/欢迎页 |
| `Claude Code vX.Y.Z` | `Khy vX.Y.Z` | 文本 | 版本信息 |
| Anthropic 橙色 `#D77757` | Khy 橙色 `#D77757` | 颜色 | 主题色板（保持不变） |

### 1.2 品牌替换实现

```javascript
// tui/utils/ccBrand.js

/**
 * 品牌文本集中管理 —— CC 模式下所有面向用户的品牌文本
 * 修改品牌只需改此文件
 */
export const BRAND = {
  name: 'Khy',
  fullName: 'Khy',
  version: '1.0.0', // 从 package.json 动态读取
  logo: '✳',         // 动画星号字符
  tagline: 'AI-powered coding assistant',
  
  // UI 文本
  welcomeTitle: 'Welcome to Khy',
  welcomeSubtitle: 'AI-powered coding assistant',
  inputPlaceholder: 'Send a message...',
  statusBarModelPrefix: '', // 不显示 "Claude" 前缀
  
  // 版权/关于
  poweredBy: 'Powered by Khy',
  versionTemplate: (v) => `Khy v${v}`,
};

/**
 * 替换文本中的 Claude Code 品牌为 Khy
 */
export function replaceBrand(text) {
  if (!text) return text;
  return text
    .replace(/Claude Code/g, BRAND.fullName)
    .replace(/Claude/g, BRAND.name)
    .replace(/claude-code/g, 'khy');
}
```

### 1.3 需要替换品牌的位置

| 文件 | 当前文本 | 替换后 |
|------|----------|--------|
| `WelcomeBanner.js` | `🍀 khy-os` + 功能列表 | `✳ Khy` + 动画星号 |
| `CcLogo.js` (新建) | `✳ Claude Code` | `✳ Khy` |
| `PromptFrame.js` | `Type your message...` | `Send a message...` |
| `FooterBar.js` | 版本信息 | `Khy vX.Y.Z` |
| `ModelPicker.js` | 模型列表标题 | `Select Model` |
| `CcStatusLine.js` (新建) | 模型名显示 | 见 OpenAI 格式化 |

### 1.4 不替换的内容

以下内容**不属于品牌**，属于 UX 交互模式，保留原文：

| 内容 | 原因 |
|------|------|
| `Do you want to proceed?` | CC 标准权限提示文本 |
| `Yes, proceed` / `No, reject` | 标准选项文本 |
| `Esc to cancel · Tab to amend` | 标准操作提示 |
| `Always allow` | 权限选项 |
| `Context 45%` | 状态栏格式 |
| `Reading…` / `Running…` | 工具进度文本 |

---

## 2. OpenAI 协议支持规范

### 2.1 现状

khy-os AI 网关已**完整支持 OpenAI 协议**：

| 能力 | 状态 | 说明 |
|------|------|------|
| API Wire 协议 | ✅ | `apiAdapter.js` 实现完整 OpenAI Messages API |
| 模型自动路由 | ✅ | `gpt-*`, `o1-*`, `o3-*`, `o4-*` 自动路由到 OpenAI 适配器 |
| API Key 配置 | ✅ | `OPENAI_API_KEY` env / `khy gateway config` 交互式 |
| 自定义端点 | ✅ | `OPENAI_API_ENDPOINT` 支持自托管/镜像 |
| 动态模型发现 | ✅ | `/v1/models` 自动探测可用模型 |
| SSE 流式传输 | ✅ | `_openaiSseStream.js` 完整实现 |
| Tool/Function Calling | ✅ | OpenAI function call 格式完整支持 |
| Key 轮换 + 故障转移 | ✅ | `apiKeyPool` 多 key 自动切换 |
| Vision 多模态 | ✅ | 图片输入自动路由到视觉模型 |

### 2.2 模型名格式化（CC 模式状态栏）

CC 模式状态栏需要友好显示 OpenAI 模型名：

| 模型 ID | 状态栏显示 | 规则 |
|---------|-----------|------|
| `gpt-4o` | `GPT-4o` | `gpt-` → `GPT-` + 版本号 |
| `gpt-4o-mini` | `GPT-4o mini` | 最后一词小写 |
| `gpt-4-turbo` | `GPT-4 Turbo` | `turbo` → `Turbo` |
| `gpt-3.5-turbo` | `GPT-3.5 Turbo` | 同上 |
| `o1-preview` | `o1 Preview` | `o1-` → `o1 ` |
| `o1-mini` | `o1 mini` | 小写 |
| `o3-mini` | `o3 mini` | 小写 |
| `claude-opus-4-6` | `Opus 4.6` | 原有 Claude 格式化保留 |
| `claude-sonnet-4` | `Sonnet 4` | 同上 |
| `claude-haiku-4-5` | `Haiku 4.5` | 同上 |

### 2.3 模型名格式化实现

```javascript
// tui/utils/ccFormatters.js

/**
 * 格式化模型名 —— 支持 Claude 和 OpenAI 双家族
 * 
 * Claude 模型:
 *   "claude-opus-4-6" → "Opus 4.6"
 *   "claude-sonnet-4" → "Sonnet 4"
 *   "claude-haiku-4-5" → "Haiku 4.5"
 * 
 * OpenAI 模型:
 *   "gpt-4o" → "GPT-4o"
 *   "gpt-4o-mini" → "GPT-4o mini"
 *   "gpt-4-turbo" → "GPT-4 Turbo"
 *   "o1-preview" → "o1 Preview"
 *   "o1-mini" → "o1 mini"
 *   "o3-mini" → "o3 mini"
 * 
 * 其他模型: 返回原始 slug
 */
export function formatModelName(modelId) {
  if (!modelId) return 'Unknown';
  
  // Claude 模型
  const claudeMatch = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/i.exec(modelId);
  if (claudeMatch) {
    const [, family, major, minor] = claudeMatch;
    const familyName = capitalize(family);
    const version = minor ? `${major}.${minor}` : major;
    return `${familyName} ${version}`;
  }
  
  // OpenAI GPT 模型
  const gptMatch = /^gpt-(\d+)(?:[-.](\d+))?(-(?:turbo|mini|preview))?/i.exec(modelId);
  if (gptMatch) {
    const [, major, minor, suffix] = gptMatch;
    const base = `GPT-${major}${minor ? '.' + minor : ''}`;
    if (suffix) {
      const suffixName = capitalize(suffix.slice(1)); // 去掉前导 '-'
      return `${base} ${suffixName}`;
    }
    return base;
  }
  
  // OpenAI o 系列推理模型
  const oMatch = /^(o[1-9])-(mini|preview|pro)/i.exec(modelId);
  if (oMatch) {
    const [, family, variant] = oMatch;
    return `${family} ${capitalize(variant)}`;
  }
  
  // 未知模型：返回原始 slug
  return modelId;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

### 2.4 OpenAI 模型上下文窗口

CC 模式状态栏的 Context 百分比需要正确计算不同模型的上下文窗口：

```javascript
// tui/utils/ccContextWindows.js

/**
 * 模型上下文窗口大小（tokens）
 * 用于状态栏 Context 百分比计算
 */
export const MODEL_CONTEXT_WINDOWS = {
  // OpenAI
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-3.5-turbo': 16_384,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  'o3-mini': 200_000,
  
  // Anthropic
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-haiku-4-5': 200_000,
  
  // 默认值
  'default': 128_000,
};

/**
 * 获取模型的上下文窗口大小
 */
export function getContextWindow(modelId) {
  if (!modelId) return MODEL_CONTEXT_WINDOWS.default;
  
  // 精确匹配
  if (MODEL_CONTEXT_WINDOWS[modelId]) {
    return MODEL_CONTEXT_WINDOWS[modelId];
  }
  
  // 前缀匹配
  if (modelId.startsWith('gpt-4o')) return 128_000;
  if (modelId.startsWith('gpt-4')) return 8_192;
  if (modelId.startsWith('gpt-3.5')) return 16_384;
  if (modelId.startsWith('o1-')) return 128_000;
  if (modelId.startsWith('o3-')) return 200_000;
  if (modelId.startsWith('claude-')) return 200_000;
  
  return MODEL_CONTEXT_WINDOWS.default;
}
```

### 2.5 OpenAI 费用计算

CC 模式状态栏的费用显示需要支持 OpenAI 定价：

```javascript
// tui/utils/ccPricing.js

/**
 * OpenAI 模型定价（USD per 1M tokens）
 */
export const OPENAI_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  'gpt-4-turbo': { input: 10.00, output: 30.00, cachedInput: 2.50 },
  'o1-preview': { input: 15.00, output: 60.00, cachedInput: 7.50 },
  'o1-mini': { input: 3.00, output: 12.00, cachedInput: 1.50 },
  'o3-mini': { input: 1.10, output: 4.40, cachedInput: 0.55 },
};

/**
 * 计算 OpenAI 模型调用费用
 */
export function calculateCost(modelId, inputTokens, outputTokens, cachedTokens = 0) {
  const pricing = OPENAI_PRICING[modelId] || OPENAI_PRICING['gpt-4o'];
  const inputCost = ((inputTokens - cachedTokens) * pricing.input) / 1_000_000;
  const cachedCost = (cachedTokens * pricing.cachedInput) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  return inputCost + cachedCost + outputCost;
}
```

### 2.6 实施文件（OpenAI 支持）

| 文件 | 变更 |
|------|------|
| `tui/utils/ccFormatters.js` | 扩展 `formatModelName()` 支持 OpenAI 模型族 |
| `tui/utils/ccContextWindows.js` | **新建** —— 模型上下文窗口常量 + 查询函数 |
| `tui/utils/ccPricing.js` | **新建** —— OpenAI 模型定价 + 费用计算 |
| `tui/ink-components/CcStatusLine.js` | 使用新的格式化函数和上下文窗口 |
| `tui/ink-components/ModelPicker.js` | 模型选择器显示友好名称（Claude + OpenAI） |

---

## 3. MCP 状态显示规范

### 3.1 MCP 在 CC 模式 TUI 中的位置

CC 模式下，MCP 服务器连接状态显示在**状态栏右侧**（与 Claude Code 一致）：

```
┌────────────────────────────────────────────────────────────────────┐
│ ✳ Khy                                                              │
├────────────────────────────────────────────────────────────────────┤
│                                                                    │
│ Messages...                                                        │
│                                                                    │
├────────────────────────────────────────────────────────────────────┤
│ GPT-4o │ Context 45% │ $0.42  │  MCP •deepseek-eyes Connected     │  ← MCP 状态
├────────────────────────────────────────────────────────────────────┤
│ > Send a message...                                                │
└────────────────────────────────────────────────────────────────────┘
```

### 3.2 MCP 状态指示器

| 状态 | 图标 | 颜色 | 示例 |
|------|------|------|------|
| Connected | `•` (实心圆) | 绿色 `#2EA043` | `•deepseek-eyes Connected` |
| Connecting | `◦` (空心圆) | 黄色 `#D29922` | `◦deepseek-eyes Connecting...` |
| Failed | `✗` (叉号) | 红色 `#F85149` | `✗deepseek-eyes Failed` |
| Disabled | `○` (圆圈) | 灰色 `#6E7681` | `○deepseek-eyes Disabled` |
| Reconnecting | `◐` (半圆) | 黄色 `#D29922` | `◐deepseek-eyes Reconnecting (2/5)` |

### 3.3 MCP 状态栏格式

**单服务器（简洁模式）**：
```
MCP •deepseek-eyes Connected
```

**多服务器（紧凑模式）**：
```
MCP •deepseek-eyes •github ✗slack Connected
```

**多服务器展开（宽终端）**：
```
MCP •deepseek-eyes Connected •github Connected ✗slack Failed
```

### 3.4 MCP 详情面板

按 `/mcp` 或 `Ctrl+M` 打开 MCP 服务器列表面板：

```
┌─────────────────────────────────────────────────────┐
│ MCP Servers                              Ctrl+M close│
├─────────────────────────────────────────────────────┤
│ • deepseek-eyes    Connected    stdio   5 tools     │
│ • github           Connected    sse     12 tools    │
│ ✗ slack            Failed       http    --          │
│   └─ Error: Connection timeout                      │
│ ◦ postgres         Connecting   stdio   --          │
│ ○ brave-search     Disabled     http    --          │
├─────────────────────────────────────────────────────┤
│ ↑/↓ navigate · Enter reconnect · d disable · e edit │
└─────────────────────────────────────────────────────┘
```

### 3.5 MCP 实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/CcMcpStatus.js` | **新建** —— 状态栏 MCP 状态指示器 |
| `tui/ink-components/CcMcpPanel.js` | **新建** —— MCP 服务器列表面板 |
| `tui/ink-components/CcStatusLine.js` | 集成 MCP 状态显示 |
| `tui/hooks/useMcpStatus.js` | **新建** —— MCP 连接状态桥接 |

### 3.6 MCP 后端对接

khy-os 已有完整的 MCP 基础设施：

| 模块 | 用途 |
|------|------|
| `mcpServerStatus.js` | 纯函数解析连接状态 → `{state, detail}` |
| `mcpEcosystemRegistry.js` | 跨生态 MCP server 发现 |
| `mcpServer.js` | MCP 服务器连接管理 |
| `ccMcpBridge.js` | Claude Code MCP 配置桥接 |

CC 模式 TUI 只需对接 `mcpServerStatus.js` 的 `resolveMcpServerState()` 获取状态。

---

## 4. 差距分析（Current khy-os vs Claude Code）

### 3.1 视觉差异矩阵

| 维度 | 当前 khy-os | Claude Code 目标 | 差距等级 |
|------|-------------|-----------------|----------|
| **配色方案** | 青色accent + 奶油色用户框 + 多色状态栏 | 橙色品牌色 + 暖色终端背景 + 极简状态栏 | 🔴 高 |
| **用户消息** | 奶油色背景框 + `❯ ` 标记 | 无背景框，纯文本，无标记 | 🔴 高 |
| **助手消息** | 时间线渲染 + 过程组折叠 | `●` 前缀 + StreamingMarkdown | 🔴 高 |
| **工具调用** | `◆/✓/✗` + 过程组语义标题 | `◆/✓/✗` + 工具名 + 参数摘要 | 🟡 中 |
| **状态栏** | 2行（权限+徽章，模型+上下文+内存） | 1行（模型│上下文│会话│周│费用） | 🔴 高 |
| **权限提示** | 内联选择列表 | "Do you want to proceed?" + Select 组件 | 🟡 中 |
| **补全菜单** | 圆角边框下拉 | 全屏模糊搜索 FuzzyPicker | 🟡 中 |
| **Spinner** | 盲文帧 `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` | 终端原生 Spinner + AgentProgressLine | 🟢 低 |
| **Diff 渲染** | 统一 diff + 行号 | 统一 diff + 行号 + 可折叠 | 🟢 低 |
| **Logo/Header** | 3色像素艺术苜蓿 | LogoV2 + AnimatedAsterisk + AnimatedClawd | 🟡 中 |
| **输入框** | 边框 + 多行 + 光标 | ShimmeredInput + ModeIndicator + VoiceIndicator | 🟡 中 |
| **欢迎横幅** | 像素艺术 + 功能列表 | Logo + StatusNotices | 🟡 中 |

### 3.2 交互差异矩阵

| 交互 | 当前 khy-os | Claude Code 目标 | 差距等级 |
|------|-------------|-----------------|----------|
| **Ctrl+O** | 展开/折叠思考 | 切换 transcript 模式（完整历史视图） | 🟡 中 |
| **Ctrl+R** | 历史搜索覆盖层 | 历史搜索（reverse-i-search 风格） | 🟢 低 |
| **Ctrl+C** | 取消/退出 | 取消当前操作 / 双击退出 | 🟢 低 |
| **Tab** | 补全切换 | 权限提示中切换反馈输入模式 | 🟡 中 |
| **↑/↓** | 历史导航 | 历史导航 + 列表导航 | 🟢 低 |
| **Enter** | 提交 | 提交 / 确认选择 | 🟢 低 |
| **Esc** | 关闭覆盖层 | 取消当前操作 / 关闭覆盖层 | 🟢 低 |

### 3.3 架构差异

| 方面 | 当前 khy-os | Claude Code | 处理策略 |
|------|-------------|-------------|----------|
| **状态管理** | React hooks + useQueryBridge (4181行) | AppState Context + Zustand | 保留 khy 实现，仅改 UI 层 |
| **消息流** | 时间线交织（文本↔工具） | 消息列表 + 流式占位符 | 保留 khy 实现，仅改渲染 |
| **工具执行** | 过程组合并 + 语义标签 | 独立工具卡片 + 展开/折叠 | CC 模式下禁用过程组合并 |
| **滚动** | 4层防阶梯 + Static/Live 分区 | VirtualMessageList 虚拟滚动 | 保留 khy 实现，仅改样式 |

---

## 4. 环境变量门控策略

### 4.1 主开关

```bash
# 激活 CC 复刻模式
KHY_CC_TUI=1 khy

# 默认行为（Legacy 模式）
khy
```

### 4.2 子功能门控

| 环境变量 | 默认值 | 说明 |
|----------|--------|------|
| `KHY_CC_TUI` | `0` | 主开关：激活 CC 复刻模式 |
| `KHY_CC_LOGO` | `跟随主开关` | 显示 CC 风格 Logo（关闭可保留 khy 像素艺术） |
| `KHY_CC_STATUS_BAR` | `跟随主开关` | CC 风格单行状态栏 |
| `KHY_CC_MSG_STYLE` | `跟随主开关` | CC 风格消息渲染（● 前缀，无背景框） |
| `KHY_CC_TOOL_STYLE` | `跟随主开关` | CC 风格工具卡片（禁用过程组合并） |
| `KHY_CC_PERMISSION` | `跟随主开关` | CC 风格权限提示 |
| `KHY_CC_COMPLETION` | `跟随主开关` | CC 风格 FuzzyPicker 补全 |
| `KHY_CC_COLORS` | `跟随主开关` | CC 橙色主题色 |

### 4.3 门控实现模式

```javascript
// tui/utils/ccMode.js
export function isCcMode() {
  return process.env.KHY_CC_TUI === '1';
}

export function ccFeature(subFeature) {
  const main = process.env.KHY_CC_TUI === '1';
  if (!main) return false;
  const specific = process.env[`KHY_CC_${subFeature.toUpperCase()}`];
  return specific !== '0'; // 默认跟随主开关，除非显式关闭
}
```

---

## 5. Phase 1: 配色与主题系统

### 5.1 目标

将 khy-os TUI 的配色方案从「青色多色」迁移到「橙色品牌色」对齐 Claude Code，并实现最大化模式下的右侧看板。

### 5.1.1 右侧看板（Right Sidebar Panel）

CC 模式下当终端宽度 ≥ 120 列时，自动启用**右侧看板**（类似 opencode 的侧栏），显示上下文信息：

```
┌─────────────────────────────────────────────┬──────────┐
│ ✳ Khy                                       │ 📋 Context│
├─────────────────────────────────────────────┼──────────┤
│                                             │          │
│ ● 分析结果文本...                            │ 📁 Files  │
│                                             │ ├─src/   │
│ ◆ Read(src/index.js)                        │ │ ├─index │
│    ⎿ 1 │ import React from 'react'          │ │ └─utils │
│    ⎿ 2 │ ...                                │ ├─pkg/   │
│                                             │ └─tests/ │
│ 请帮我分析这个文件                            │          │
│                                             │ 🔧 Tools  │
│                                             │ ├─Read ✓ │
│                                             │ ├─Write  │
│                                             │ ├─Bash   │
│                                             │ └─Grep   │
│                                             │          │
│                                             │ 📊 Stats  │
│                                             │ ├─Tokens  │
│                                             │ │ 24k/128k│
│                                             │ ├─Cost    │
│                                             │ │ $0.42   │
│                                             │ └─MCP •3  │
├─────────────────────────────────────────────┼──────────┤
│ GPT-4o │ Context 45% │ $0.42 │ MCP •3      │ 宽度: 30 │
└─────────────────────────────────────────────┴──────────┘
```

### 5.1.2 右侧看板设计规范

| 元素 | 规范 |
|------|------|
| **触发条件** | 终端宽度 ≥ 120 列时自动显示 |
| **宽度** | 固定 30 列（可通过 `KHY_CC_SIDEBAR_WIDTH` 调整） |
| **分割线** | 紫蓝色 `#5769F7` 垂直线 |
| **背景** | 深色终端背景（与主区一致） |
| **内容区** | 多个可折叠面板（Context、Files、Tools、Stats） |
| **标签页** | 图标 + 文字标题，当前面板高亮 |
| **折叠/展开** | 点击面板标题或按 `Ctrl+B` 切换 |

### 5.1.3 右侧看板面板内容

| 面板 | 图标 | 内容 |
|------|------|------|
| **Context** | 📋 | 当前对话上下文摘要、最近文件、引用 |
| **Files** | 📁 | 当前工作目录文件树（可浏览） |
| **Tools** | 🔧 | 可用工具列表及状态 |
| **Stats** | 📊 | Token 使用量、费用、MCP 连接数 |
| **MCP** | 🔌 | MCP 服务器列表及连接状态 |
| **Plan** | 📝 | 当前目标/计划进度（如有） |

### 5.1.4 右侧看板标签页导航

```
┌──────────────────────────┐
│ 📋 │ 📁 │ 🔧 │ 📊 │ 🔌 │  ← 图标标签页
├──────────────────────────┤
│                          │
│   当前选中面板的内容       │
│                          │
└──────────────────────────┘
```

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+B` | 切换右侧看板显示/隐藏 |
| `Tab` | 在面板标签页间切换 |
| `↑/↓` | 在面板内容中导航 |
| `Enter` | 选中/打开当前项 |
| `Esc` | 关闭面板内交互 |

### 5.1.5 右侧看板实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/CcSidebarPanel.js` | **新建** — 右侧看板容器（标签页+面板管理） |
| `tui/ink-components/CcSidebarContext.js` | **新建** — Context 面板（对话上下文摘要） |
| `tui/ink-components/CcSidebarFiles.js` | **新建** — Files 面板（文件树浏览） |
| `tui/ink-components/CcSidebarTools.js` | **新建** — Tools 面板（工具列表状态） |
| `tui/ink-components/CcSidebarStats.js` | **新建** — Stats 面板（Token/费用/MCP） |
| `tui/ink-components/CcSidebarMcp.js` | **新建** — MCP 面板（服务器连接状态） |
| `tui/hooks/useSidebarState.js` | **新建** — 右侧看板状态管理 |
| `tui/ink-components/App.js` | 集成右侧看板布局（≥120列时显示） |

### 5.2.6 CC 主题色板

> **参考来源**：`D:\Portable\Docs\design\claude-code-tui\color-style-spec.md`

```javascript
// tui/theme/ccTheme.js

/**
 * CC 主题色板 —— 基于 Claude Code 官方实现
 * 
 * 核心设计原则：
 * 1. 完全继承终端颜色主题，不强制覆盖
 * 2. 工具标识使用青色系（#00D4D4 暗色 / #008B8B 亮色）
 * 3. 语义颜色：绿=成功、红=错误、黄=警告、灰=系统
 * 4. 粗体用于工具名称和斜杠命令
 */
export const CC_COLORS = {
  // 工具标识色（核心品牌色 —— 青色系）
  toolName: '#00D4D4',       // 暗色终端：亮青色（工具名称）
  toolNameLight: '#008B8B',  // 亮色终端：深青色
  toolBorder: '#00D4D4',     // 工具调用边框/下划线
  
  // 语义状态色（暗色终端）
  success: '#4ADE80',        // 亮绿色 — 完成/成功 ✓
  successLight: '#228B22',   // 深绿色 — 亮色终端
  error: '#F87171',          // 亮红色 — 错误/失败 ✗
  errorLight: '#DC3545',     // 深红色 — 亮色终端
  warning: '#FBBF24',        // 亮黄色 — 警告/进行中 ⏳
  warningLight: '#E6A817',   // 深黄色 — 亮色终端
  info: '#58A6FF',           // 蓝色 — 信息/链接
  
  // 中性色（暗色终端）
  text: undefined,           // 终端默认前景色（不覆盖）
  textSecondary: '#A0A0A0',  // 次要文字
  dim: 'dim',                // Ink dim 修饰符
  dimColor: '#6B7280',       // 灰色 — 系统消息/标签
  border: '#374151',         // 分割线/边框
  background: undefined,     // 终端默认背景（不覆盖）
  
  // 亮色终端覆盖
  lightText: '#1A1A1A',      // 主文字
  lightTextSecondary: '#666666', // 次要文字
  lightBgSecondary: '#F5F5F5',   // 次要背景
  lightBgToolResult: '#F0F0F0', // 工具结果块背景
  lightBgThinking: '#F9F9F9',   // 思考折叠块背景
  lightBgError: '#FFF0F0',      // 错误块背景
  lightBorder: '#E0E0E0',       // 边框
  
  // 特殊组件色
  inactive: '#555555',       // 非活跃态
  highlight: '#1F6FEB',      // 高亮背景
  selectedBg: '#1F6FEB20',   // 选中项背景（带透明度）
  link: '#00D4D4',           // 超链接（下划线）
  
  // ANSI 码参考
  ansi: {
    toolBold: '\x1B[1;36m',    // 粗体 + 青色
    success: '\x1B[32m',       // 绿色
    error: '\x1B[31m',         // 红色
    warning: '\x1B[33m',       // 黄色
    system: '\x1B[90m',        // 亮黑色（灰色）
    bold: '\x1B[1m',           // 粗体
    italic: '\x1B[3m',         // 斜体
    underline: '\x1B[4m',      // 下划线
    reset: '\x1B[0m',          // 重置
  },
};
```

### 5.2.7 用户消息配色变更

**当前**：
```
bg: #F0EAD6 (cream/moccasin)
text: #1A1A1A (near-black)
marker: green bold "> "
```

**目标 (CC 模式)**：
```
bg: 无背景框
text: 终端默认前景色
marker: 无标记
```

### 5.2.8 实施文件

| 文件 | 变更 |
|------|------|
| `tui/theme/ccTheme.js` | **新建** — CC 主题色板 |
| `tui/theme/themeRegistry.js` | 新增 `cc` 主题注册 |
| `tui/ink-components/MessageBlock.js` | 条件渲染：CC 模式下用户消息无背景框 |
| `tui/ink-components/WelcomeBanner.js` | CC 模式下使用 CcLogo（Khy 品牌） |
| `tui/ink-components/FooterBar.js` | CC 模式下使用橙色 accent |
| `tui/ink-components/Spinner.js` | CC 模式下使用橙色帧 |
| `tui/ink-components/CompletionMenu.js` | CC 模式下使用橙色高亮 |
| `tui/ink-components/CcMcpStatus.js` | **新建** — MCP 状态指示器 |
| `tui/ink-components/CcSidebarPanel.js` | **新建** — 右侧看板容器 |
| `tui/ink-components/CcSidebarContext.js` | **新建** — Context 面板 |
| `tui/ink-components/CcSidebarFiles.js` | **新建** — Files 面板 |
| `tui/ink-components/CcSidebarTools.js` | **新建** — Tools 面板 |
| `tui/ink-components/CcSidebarStats.js` | **新建** — Stats 面板 |
| `tui/ink-components/CcSidebarMcp.js` | **新建** — MCP 面板 |
| `tui/hooks/useSidebarState.js` | **新建** — 右侧看板状态管理 |

### 5.2.9 验证方法

```bash
# 启动 CC 模式，验证配色
KHY_CC_TUI=1 khy

# 验证要点：
# 1. 用户消息无奶油色背景框
# 2. 状态栏分隔符为橙色
# 3. Spinner 为橙色
# 4. 补全菜单高亮为橙色
# 5. Legacy 模式配色不变（默认行为）
```

---

## 6. Phase 2: 布局结构迁移

### 6.1 目标

将 khy-os 的 2 行 FooterBar 迁移为 Claude Code 的 1 行 BuiltinStatusLine，并调整整体布局间距。

### 6.2 CC 目标布局

> **参考来源**：`D:\Portable\Docs\design\claude-code-tui\visual-mockup.md` (场景 1-3)

```
╭────────────────────────────────────────────────────────────────╮
│  Khy                                                           │  ← 品牌 Logo
│  AI-powered coding assistant                                  │
╰────────────────────────────────────────────────────────────────╯
│                                                                │
│  > 读取 CLAUDE.md 的内容                                        │  ← 用户消息（无背景框）
│                                                                │
│  🔧 Read                                          ← 粗体+青色  │  ← 工具调用
│    file_path: "D:\\Portable\\CLAUDE.md"                        │
│                                                                │
│  ┌─ Read 结果 ──────────────────────────────────────────────┐  │  ← 工具结果块
│  │ # CLAUDE.md — Portable 便携环境 AI 操作手册              │  │
│  │ ...（文件内容）                                          │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  这是一个包含 Portable 环境完整规则的文档...                      │  ← 助手回复
│                                                                │
│  > /cost                                                       │
│                                                                │
│  Token 使用量：                                                 │
│    输入: 45,678 tokens                                         │
│    输出: 1,234 tokens                                          │
│    本次会话费用: $0.XX                                          │
│                                                                │
├────────────────────────────────────────────────────────────────┤
│ Sonnet 4 │ Context 45% (50k/200k) │ $0.42 │ MCP •3 Connected  │  ← 状态栏
├────────────────────────────────────────────────────────────────┤
│ > _                                                            │  ← 输入框
└────────────────────────────────────────────────────────────────┘
```

### 6.3 状态栏迁移

**当前 (khy-os Legacy)**：
```
Line 1: ■ 询问权限 (shift+tab 切换)  ◆ 本地模式  ◎ /goal 进行中 (5m)
Line 2: [claude-opus-4.8 · 高强度]  mem 256MB · pid 1234  45% ctx (24k/200k)
```

**目标 (CC 模式)**：
```
Opus 4.6 │ Context 45% (50k/1M) │ Session 23% 2h15m │ Weekly 5% 3d12h │ $0.42
```

### 6.4 状态栏格式规范

| 字段 | 格式 | 示例 | 条件 |
|------|------|------|------|
| 模型名 | 前两词 | `Opus 4.6` | 始终显示 |
| 上下文 | `Context {percent}% ({used}/{total})` | `Context 45% (50k/1M)` | 始终显示 |
| 会话限额 | `Session {percent}% {countdown}` | `Session 23% 2h15m` | 有限额时 |
| 周限额 | `Weekly {percent}% {countdown}` | `Weekly 5% 3d12h` | 有限额时 |
| 费用 | `${amount}` | `$0.42` | > 0 时 |

**分隔符**：` │ ` (U+2502 + 两侧空格)，颜色 `dimColor`

**窄终端 (< 60 列)**：
- 省略 token 计数和倒计时
- 仅保留百分比

### 6.5 实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/CcStatusLine.js` | **新建** — CC 风格单行状态栏（含 MCP 状态） |
| `tui/ink-components/FooterBar.js` | 条件渲染：CC 模式下委托给 CcStatusLine |
| `tui/ink-components/App.js` | 调整布局：CC 模式下状态栏高度从 2 行改为 1 行 |
| `tui/utils/ccFormatters.js` | **新建** — CC 格式化的纯函数（模型名截断、上下文百分比、倒计时格式化） |
| `tui/ink-components/CcMcpStatus.js` | **新建** — MCP 状态指示器（对接 mcpServerStatus.js） |

### 6.6 验证方法

```bash
# 验证状态栏格式
KHY_CC_TUI=1 khy

# 验证要点：
# 1. 状态栏为单行
# 2. 格式：Model │ Context │ Session │ Cost
# 3. 分隔符为 │ (U+2502)
# 4. 窄终端自动简化
# 5. Legacy 模式仍为 2 行
```

---

## 7. Phase 3: 消息显示格式

### 7.1 目标

将 khy-os 的消息渲染从「时间线+过程组」迁移为 Claude Code 的「● 前缀 + 独立工具卡片」风格。

### 7.2 用户消息格式

**当前 (khy-os Legacy)**：
```
> 请帮我分析这个文件
```
（奶油色背景框 + 绿色 `>` 标记）

**目标 (CC 模式)**：
```
请帮我分析这个文件
```
（纯文本，无背景框，无标记）

### 7.3 助手消息格式

**当前 (khy-os Legacy)**：
```
● 助手
  [思考内容，默认折叠]
  
  分析结果文本...
  
  ▸ 读取 · server.js · 3 个步骤 ✓2 ✗1
```

**目标 (CC 模式)**：
```
● 分析结果文本...

◆ Read(src/index.js)
   ⎿ 1 │ import React from 'react'
   ⎿ 2 │ import { View } from 'ink'
```

### 7.4 流式消息格式

**当前 (khy-os Legacy)**：
```
● 助手 (流式输出中...)
  [流式文本，逐字符显示]
```

**目标 (CC 模式)**：
```
● [流式文本，逐字符显示，前缀 ● 在 marginTop=1 的行]
```

### 7.5 工具调用格式

> **参考来源**：`D:\Portable\Docs\design\claude-code-tui\visual-mockup.md` + `interaction-spec.md`

**当前 (khy-os Legacy)**：
```
▸ 读取 · server.js · 3 个步骤 ✓2 ✗1
  ◆ Read(src/index.js)
     ⎿ [结果]
  ✓ Edit(src/index.js)
     ⎿ [diff]
```

**目标 (CC 模式)**：
```
🔧 Read                                          ← 粗体 + 青色 #00D4D4
  file_path: "D:\\Portable\\CLAUDE.md"           ← 缩进 2 空格

┌─ Read 结果 ──────────────────────────────────────────────────┐
│ # CLAUDE.md — Portable 便携环境 AI 操作手册                   │
│ ...（文件内容）                                               │
└──────────────────────────────────────────────────────────────┘

🔧 Bash
  command: "find src/ -type f -name '*.ts' | head -20"
  ⏳ 执行中...                                                ← spinner 动画

┌─ Bash 结果 ──────────────────────────────────────────────────┐
│ src/index.ts                                                  │
│ src/utils.ts                                                  │
└──────────────────────────────────────────────────────────────┘

  找到了 3 个 TypeScript 文件。让我读取...                       ← 继续输出
```

**工具调用状态指示**：
```
🔧 Read               ← 调用时（青色，粗体）
  ⏳ 执行中...         ← 执行中（黄色 spinner）
  ✓ 完成              ← 成功（绿色勾号）
  ✗ 失败              ← 失败（红色叉号）
```

### 7.6 关键变更

1. **禁用过程组合并**：CC 模式下每个工具调用独立渲染，不合并为「过程组」
2. **移除语义标签**：不再显示「读取 · server.js · 3 个步骤」这种中文语义标题
3. **工具名样式**：`🔧` emoji + 工具名，**粗体 + 青色 `#00D4D4`**
4. **参数展示**：缩进 2 空格，JSON 格式展示
5. **结果块样式**：使用 `┌─` / `└─` 边框包裹，灰色背景
6. **状态指示器**：执行中=黄色 `⏳`，完成=绿色 `✓`，失败=红色 `✗`
7. **思考折叠块**：使用 `▸` 折叠箭头，可展开/折叠

### 7.7 实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/MessageBlock.js` | CC 模式下用户消息无背景框 |
| `tui/ink-components/CcAssistantMessage.js` | **新建** — CC 风格助手消息（● 前缀） |
| `tui/ink-components/CcToolCard.js` | **新建** — CC 风格工具卡片（独立，无过程组） |
| `tui/ink-components/StreamingBlock.js` | CC 模式下使用 ● 前缀 + marginTop=1 |
| `tui/ink-components/ToolLines.js` | CC 模式下禁用过程组合并 |
| `tui/utils/ccToolFormat.js` | **新建** — 工具参数摘要格式化 |

### 7.8 验证方法

```bash
# 验证消息格式
KHY_CC_TUI=1 khy

# 验证要点：
# 1. 用户消息无背景框
# 2. 助手消息以 ● 开头
# 3. 工具调用独立显示（无过程组）
# 4. 工具格式：◆/✓/✗ name(args)
# 5. 结果使用 ⎿ 缩进
# 6. Legacy 模式仍为过程组
```

---

## 8. Phase 4: 输入框与交互

### 8.1 目标

将 khy-os 的 PromptFrame 输入框迁移为 Claude Code 的 PromptInput + PromptInputFooter 风格。

### 8.2 输入框格式

**当前 (khy-os Legacy)**：
```
─────────────────────────────────────────
│ > Type your message...               │
─────────────────────────────────────────
```
（上下边框 + 多行 + 光标）

**目标 (CC 模式)**：
```
> Type your message...
```
（无边框，简洁输入，底部状态栏已包含上下文信息）

### 8.3 输入框 Footer

**当前 (khy-os Legacy)**：
```
[输入框]
Line 1: 权限模式 + 徽章
Line 2: 模型 + 上下文 + 内存
```

**目标 (CC 模式)**：
```
Opus 4.6 │ Context 45% │ $0.42       ← 状态栏（Phase 2 已实现）
> Type your message...                ← 输入框
Tab 补全 │ Esc 取消                    ← 提示行（可选）
```

### 8.4 权限提示格式

**当前 (khy-os Legacy)**：
```
? 是否允许执行此操作? (Y/n)
```

**目标 (CC 模式)**：
```
Do you want to proceed?
❯ Yes, proceed
  No, reject
  Always allow

Esc to cancel · Tab to amend
```

### 8.5 实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/PromptFrame.js` | CC 模式下简化为无边框输入 |
| `tui/ink-components/CcPromptInput.js` | **新建** — CC 风格输入框 |
| `tui/ink-components/CcPermissionPrompt.js` | **新建** — CC 风格权限提示 |
| `tui/ink-components/PermissionPrompt.js` | 条件渲染：CC 模式下委托给 CcPermissionPrompt |

### 8.6 验证方法

```bash
# 验证输入框
KHY_CC_TUI=1 khy

# 验证要点：
# 1. 输入框无上下边框
# 2. 权限提示为 "Do you want to proceed?" 格式
# 3. 选项可键盘导航
# 4. Tab 切换反馈输入模式
# 5. Legacy 模式仍为边框输入框
```

---

## 9. Phase 5: 补全菜单与覆盖层

### 9.1 目标

将 khy-os 的 CompletionMenu 迁移为 Claude Code 的 FuzzyPicker 风格，并实现 CC 风格的帮助菜单覆盖层。

### 9.1.1 CC 帮助菜单覆盖层（Help Menu Overlay）

CC 模式下按 `?` 或 `/help` 打开帮助菜单，采用**覆盖层（Overlay）** 风格：

```
┌──────────────────────────────────────────────────────────────────┐
│ > /branch                                                        │  ← 历史消息区（上半部分）
│ └ main                                                           │
│ > /btw                                                           │
│ └ hello                                                          │
├──────────────────────────────────────────────────────────────────┤  ← 紫蓝色分割线
│ Help │ General │ Commands │ Custom commands          [?] close  │  ← 标签页导航
├──────────────────────────────────────────────────────────────────┤
│ General                                    │                     │
│                                            │                     │
│  Ctrl+C          Cancel/Exit               │  Ctrl+L   Clear     │
│  Ctrl+D          Exit REPL                 │  Ctrl+R   History   │
│  Ctrl+O          Transcript mode           │  Ctrl+T   Tasks     │
│  ↑/↓             History nav               │  Tab      Complete  │
│                                            │                     │
│ Khy v1.0.0  ·  khyquant.top               │  MCP •3 Connected   │
│                                            │                     │
├──────────────────────────────────────────────────────────────────┤
│ Esc close  ·  ↑↓ navigate tabs  ·  Enter select                  │  ← 底部操作提示
└──────────────────────────────────────────────────────────────────┘
```

### 9.1.2 帮助菜单设计规范

| 元素 | 规范 |
|------|------|
| **背景** | 深色终端背景（与 TUI 一致） |
| **分割线** | 紫蓝色 `#5769F7` 水平线，分隔历史区与菜单区 |
| **标签页** | 顶部横向排列，当前标签高亮（橙色 `#D77757` 下划线） |
| **快捷键网格** | 2-3 列网格布局，左列=快捷键，右列=功能描述 |
| **底部状态栏** | 版本信息 + MCP 连接状态 + 操作提示 |
| **关闭方式** | `Esc` 键 或 `?` 键 或 `q` 键 |

### 9.1.3 帮助菜单标签页内容

| 标签页 | 内容 |
|--------|------|
| **Help** | 欢迎信息、快速入门、文档链接 |
| **General** | 通用快捷键（Ctrl+C/D/O/L/R/T、↑/↓、Tab） |
| **Commands** | 斜杠命令列表（/login、/model、/compact、/mcp 等） |
| **Custom commands** | 用户自定义命令和技能列表 |

### 9.1.4 帮助菜单快捷键网格样式

```
┌─────────────────────────────────────────────────────────────┐
│ General                                                      │
│                                                              │
│  Ctrl+C          Cancel/Exit        Ctrl+L   Clear           │
│  Ctrl+D          Exit REPL          Ctrl+R   History search  │
│  Ctrl+O          Transcript mode    Ctrl+T   Tasks           │
│  ↑/↓             History nav        Tab      Complete        │
│  Shift+Tab       Cycle mode         ?        Help            │
│                                                              │
├─────────────────────────────────────────────────────────────┤
│ Commands                                                     │
│                                                              │
│  /login          Configure provider /model    Switch model    │
│  /compact        Compress context  /clear     Clear chat     │
│  /mcp            MCP servers        /goal      Set goal      │
│  /config         Configuration     /status    Gateway status │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### 9.2.5 斜杠命令菜单格式

> **参考来源**：`D:\Portable\Docs\design\claude-code-tui\visual-mockup.md` (场景 5)

**当前 (khy-os Legacy)**：
```
┌─────────────────────────────┐
│ /help     显示帮助信息       │
│ /config   配置管理          │  ← 圆角边框下拉
│ /model    模型切换          │
└─────────────────────────────┘
```

**目标 (CC 模式)**：
```
  > /help         查看帮助信息                               ← 选中 │
    /clear        清除对话历史                                    │
    /compact      压缩对话历史                                    │
    /cost         查看 token 用量                                 │
    /init         初始化 CLAUDE.md                                │
    /memory       管理记忆文件                                    │
    /model        切换模型                                        │
    /permissions  权限设置                                        │
    /status       查看会话状态                                    │
    /vim          切换 Vim 模式                                  │
    /mcp          MCP 服务器管理                                  │
    /agents       Agent 管理                                      │
    /hooks        Hooks 管理                                      │
                                                                │
  ↑↓ 导航  Enter 执行  Esc 取消                                  │
```

**斜杠命令完整列表**：

| 命令 | 别名 | 功能 | 确认 |
|------|------|------|------|
| `/clear` | — | 清除对话历史 | 否 |
| `/compact` | — | 压缩对话历史（节省 token） | 否 |
| `/cost` | — | 查看 token 使用量和费用估算 | 否 |
| `/status` | — | 查看会话状态和统计 | 否 |
| `/init` | — | 初始化/更新项目的 CLAUDE.md | 否 |
| `/memory` | — | 管理记忆文件 | 否 |
| `/model` | — | 切换 AI 模型 | 否 |
| `/permissions` | — | 查看/修改权限设置 | 是 |
| `/vim` | — | 切换 Vim 编辑模式 | 否 |
| `/mcp` | — | MCP 服务器管理 | 否 |
| `/agents` | — | Agent 管理 | 否 |
| `/hooks` | — | Hooks 管理 | 否 |

**交互方式**：
- `↑` `↓` 导航
- `Enter` 执行
- `Esc` 取消
- 实时过滤（输入字符 narrowing 列表）

### 9.2.6 模型选择器

**当前 (khy-os Legacy)**：
```
[ModelPicker 覆盖层 - 列表风格]
```

**目标 (CC 模式)**：
```
┌─────────────────────────────────────────────┐
│ > claude                                    │  ← 搜索输入
├─────────────────────────────────────────────┤
│ claude-opus-4.6      高性能模型              │
│ claude-sonnet-4      均衡模型               │  ← 模糊匹配
│ claude-haiku-4-5     快速模型               │
└─────────────────────────────────────────────┘
```

### 9.2.7 实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/CcFuzzyPicker.js` | **新建** — CC 风格模糊搜索选择器 |
| `tui/ink-components/CcHelpMenu.js` | **新建** — CC 风格帮助菜单覆盖层 |
| `tui/ink-components/CompletionMenu.js` | CC 模式下委托给 CcFuzzyPicker |
| `tui/ink-components/ModelPicker.js` | CC 模式下使用 FuzzyPicker 风格 |
| `tui/hooks/useCompletions.js` | CC 模式下使用模糊匹配排序 |

### 9.2.8 验证方法

```bash
# 验证补全菜单
KHY_CC_TUI=1 khy
# 输入 / 触发补全

# 验证要点：
# 1. 补全菜单为全屏覆盖风格
# 2. 顶部有搜索输入框
# 3. 模糊匹配排序
# 4. 选中项高亮为橙色
# 5. Legacy 模式仍为下拉菜单
```

---

## 10. Phase 6: 动画与微交互

### 10.1 目标

将 khy-os 的 Spinner 和加载动画迁移为 Claude Code 的风格。

### 10.2 Spinner 格式

**当前 (khy-os Legacy)**：
```
⠋ 加载中...     ← 盲文帧 + 黄色
```

**目标 (CC 模式)**：
```
⠋ 加载中...     ← 盲文帧 + 橙色（颜色变化，帧序列不变）
```

### 10.3 Logo 动画

**当前 (khy-os Legacy)**：
```
🍀 khy-os     ← 静态像素艺术苜蓿
```

**目标 (CC 模式)**：
```
✳ Khy          ← 动画星号 + Khy 品牌名
```

### 10.4 工具进度

**当前 (khy-os Legacy)**：
```
▸ 读取 · server.js · 3 个步骤 ✓2 ✗1
```

**目标 (CC 模式)**：
```
● Reading src/index.js...     ← 现在进行时 + 工具名 + 目标
```

### 10.5 实施文件

| 文件 | 变更 |
|------|------|
| `tui/ink-components/Spinner.js` | CC 模式下使用橙色帧 |
| `tui/ink-components/CcLogo.js` | **新建** — CC 风格动画 Logo |
| `tui/ink-components/WelcomeBanner.js` | CC 模式下使用 CcLogo |
| `tui/ink-components/StreamingBlock.js` | CC 模式下工具进度使用现在进行时 |

### 10.6 验证方法

```bash
# 验证动画
KHY_CC_TUI=1 khy

# 验证要点：
# 1. Spinner 为橙色
# 2. Logo 为动画星号
# 3. 工具进度为现在进行时
# 4. Legacy 模式动画不变
```

---

## 11. 文件变更清单

### 11.1 新建文件

| 文件路径 | 用途 | Phase |
|----------|------|-------|
| `tui/utils/ccMode.js` | CC 模式检测工具函数 | Phase 1 |
| `tui/utils/ccBrand.js` | **品牌替换集中管理**（Khy 文本映射） | Phase 1 |
| `tui/utils/ccResizeHandler.js` | **新建** —— 终端 resize 无残影处理 | Phase 1 |
| `tui/utils/ccRenderStrategy.js` | **新建** —— 渲染策略配置 | Phase 1 |
| `tui/utils/ccTimers.js` | **新建** —— 计时器常量管理 | Phase 1 |
| `tui/utils/ccLayout.js` | **新建** —— 布局计算（绝对值+相对值混合） | Phase 1 |
| `tui/theme/ccTheme.js` | CC 主题色板 | Phase 1 |
| `tui/utils/ccFormatters.js` | CC 格式化纯函数（**含 OpenAI 模型名**） | Phase 2 |
| `tui/utils/ccContextWindows.js` | **新建** — 模型上下文窗口（Claude + OpenAI） | Phase 2 |
| `tui/utils/ccPricing.js` | **新建** — OpenAI 模型定价 + 费用计算 | Phase 2 |
| `tui/ink-components/CcStatusLine.js` | CC 风格单行状态栏（**含 OpenAI + MCP 支持**） | Phase 2 |
| `tui/ink-components/CcMcpStatus.js` | **新建** — MCP 状态栏指示器 | Phase 2 |
| `tui/ink-components/CcMcpPanel.js` | **新建** — MCP 服务器列表面板 | Phase 2 |
| `tui/hooks/useMcpStatus.js` | **新建** — MCP 连接状态桥接 | Phase 2 |
| `tui/ink-components/CcAssistantMessage.js` | CC 风格助手消息 | Phase 3 |
| `tui/ink-components/CcToolCard.js` | CC 风格工具卡片 | Phase 3 |
| `tui/utils/ccToolFormat.js` | 工具参数摘要格式化 | Phase 3 |
| `tui/ink-components/CcPromptInput.js` | CC 风格输入框 | Phase 4 |
| `tui/ink-components/CcPermissionPrompt.js` | CC 风格权限提示 | Phase 4 |
| `tui/ink-components/CcFuzzyPicker.js` | CC 风格模糊搜索选择器 | Phase 5 |
| `tui/ink-components/CcHelpMenu.js` | **新建** — CC 风格帮助菜单覆盖层（标签页+快捷键网格） | Phase 5 |
| `tui/ink-components/CcSidebarPanel.js` | **新建** — 右侧看板容器（标签页+面板管理） | Phase 1 |
| `tui/ink-components/CcSidebarContext.js` | **新建** — Context 面板（对话上下文摘要） | Phase 1 |
| `tui/ink-components/CcSidebarFiles.js` | **新建** — Files 面板（文件树浏览） | Phase 1 |
| `tui/ink-components/CcSidebarTools.js` | **新建** — Tools 面板（工具列表状态） | Phase 1 |
| `tui/ink-components/CcSidebarStats.js` | **新建** — Stats 面板（Token/费用/MCP） | Phase 1 |
| `tui/ink-components/CcSidebarMcp.js` | **新建** — MCP 面板（服务器连接状态） | Phase 1 |
| `tui/hooks/useSidebarState.js` | **新建** — 右侧看板状态管理 | Phase 1 |
| `tui/ink-components/CcLogo.js` | CC 风格动画 Logo（**Khy 品牌版**） | Phase 6 |

### 11.2 修改文件

| 文件路径 | 变更内容 | Phase |
|----------|----------|-------|
| `tui/ink-components/App.js` | 条件渲染：CC 模式下使用新组件 | All |
| `tui/ink-components/FooterBar.js` | 条件渲染：CC 模式下委托给 CcStatusLine | Phase 2 |
| `tui/ink-components/MessageBlock.js` | 条件渲染：CC 模式下用户消息无背景框 | Phase 3 |
| `tui/ink-components/StreamingBlock.js` | 条件渲染：CC 模式下 ● 前缀 + 工具进度 | Phase 3, 6 |
| `tui/ink-components/ToolLines.js` | 条件渲染：CC 模式下禁用过程组合并 | Phase 3 |
| `tui/ink-components/PromptFrame.js` | 条件渲染：CC 模式下简化输入框 | Phase 4 |
| `tui/ink-components/PermissionPrompt.js` | 条件渲染：CC 模式下委托给 CcPermissionPrompt | Phase 4 |
| `tui/ink-components/CompletionMenu.js` | 条件渲染：CC 模式下委托给 CcFuzzyPicker | Phase 5 |
| `tui/ink-components/ModelPicker.js` | 条件渲染：CC 模式下使用 FuzzyPicker 风格 + OpenAI 友好名称 | Phase 5 |
| `tui/ink-components/Spinner.js` | 条件渲染：CC 模式下使用橙色 | Phase 6 |
| `tui/ink-components/WelcomeBanner.js` | 条件渲染：CC 模式下使用 CcLogo（Khy 品牌） | Phase 6 |
| `tui/hooks/useCompletions.js` | 条件渲染：CC 模式下模糊匹配排序 | Phase 5 |
| `tui/theme/themeRegistry.js` | 新增 `cc` 主题注册 | Phase 1 |
| `tui/utils/ccFormatters.js` | 扩展：OpenAI 模型名格式化 + 上下文窗口查询 | Phase 2 |

### 11.3 零修改文件（仅通过条件渲染适配）

以下文件**不需要直接修改**，通过上层组件的条件渲染自动适配：

- `tui/ink-components/SidebarPanel.js`
- `tui/ink-components/TaskListPanel.js`
- `tui/ink-components/Transcript.js`
- `tui/ink-components/Viewport.js`
- `tui/vim/*`（Vim 引擎完全保留）
- `tui/hooks/useQueryBridge.js`（核心查询桥接完全保留）
- `tui/hooks/useTextInput.js`
- `tui/hooks/useVimInput.js`
- `tui/runtime/*`（运行时系统完全保留）

---

## 12. 实施路线图

### 12.1 时间线

```
Phase 1 (配色)     ████████░░░░░░░░░░░░  第 1 周
Phase 2 (布局)     ░░░░████████░░░░░░░░  第 2 周
Phase 3 (消息)     ░░░░░░░░████████░░░░  第 3 周
Phase 4 (输入)     ░░░░░░░░░░░░████████  第 4 周
Phase 5 (补全)     ░░░░░░░░░░░░░░░░████  第 5 周
Phase 6 (动画)     ░░░░░░░░░░░░░░░░░░██  第 6 周
```

### 12.2 依赖关系

```
Phase 1 (配色) ─┬─→ Phase 2 (布局) ─→ Phase 3 (消息) ─→ Phase 4 (输入)
                │                                        │
                └────────────────────────────────────────┘
                │
                └─→ Phase 6 (动画) ←── Phase 5 (补全)
```

- Phase 1 是基础，所有后续 Phase 依赖它
- Phase 2, 3, 4 串行依赖（布局 → 消息 → 输入）
- Phase 5, 6 可并行，依赖 Phase 1

### 12.3 验证里程碑

| Phase | 验证命令 | 通过标准 |
|-------|----------|----------|
| Phase 1 | `KHY_CC_TUI=1 khy` + 目视检查 | 用户消息无背景框，accent 为橙色 |
| Phase 2 | `KHY_CC_TUI=1 khy` + 目视检查 | 状态栏为单行，格式对齐 CC |
| Phase 3 | `KHY_CC_TUI=1 khy` + 发送消息 | 助手消息 ● 前缀，工具独立卡片 |
| Phase 4 | `KHY_CC_TUI=1 khy` + 触发权限 | 输入框无边框，权限提示对齐 CC |
| Phase 5 | `KHY_CC_TUI=1 khy` + `/` 补全 | 补全菜单为全屏 FuzzyPicker |
| Phase 6 | `KHY_CC_TUI=1 khy` + 观察动画 | Spinner 橙色，Logo 动画 |

### 12.4 回滚策略

每个 Phase 独立回滚：

```bash
# 完全回滚到 Legacy 模式
unset KHY_CC_TUI
khy

# 部分回滚（保留 CC 模式但关闭特定子功能）
KHY_CC_TUI=1 KHY_CC_STATUS_BAR=0 khy  # 保留 Legacy 状态栏
KHY_CC_TUI=1 KHY_CC_TOOL_STYLE=0 khy  # 保留过程组
```

---

## 13. 风险与缓解

### 13.1 风险矩阵

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| Ink 渲染性能下降 | 中 | 高 | 保留 khy 的 4 层防阶梯系统，CC 模式复用 |
| 用户习惯阻力 | 高 | 中 | 默认关闭，显式 opt-in |
| 过程组功能丢失反馈 | 中 | 低 | `KHY_CC_TOOL_STYLE=0` 可恢复 |
| 中文语境下的英文 UI | 高 | 低 | CC 模式下保留中文消息内容 |
| 状态栏信息密度降低 | 中 | 中 | 窄终端自动简化，宽终端完整显示 |
| Vim 模式兼容性 | 低 | 高 | Vim 引擎完全保留，仅改 UI 层 |

### 13.2 兼容性保证

1. **Legacy 模式零改动**：`KHY_CC_TUI` 未设置时，所有代码路径不变
2. **数据格式兼容**：消息历史、会话数据、配置文件格式不变
3. **API 兼容**：AI gateway、工具系统、服务层完全不变
4. **快捷键兼容**：CC 模式下保留 khy 核心快捷键（Ctrl+C/D/L/R 等）

---

## 14. 设计对齐检查清单

### 14.1 视觉对齐

- [ ] 配色方案：橙色品牌色 `#D77757`
- [ ] 用户消息：无背景框，纯文本
- [ ] 助手消息：`●` 前缀 + StreamingMarkdown
- [ ] 工具卡片：`◆/✓/✗` + 工具名 + 参数摘要
- [ ] 工具结果：`⎿` 缩进引导符
- [ ] 状态栏：单行，`│` 分隔符
- [ ] 输入框：无边框，简洁
- [ ] 权限提示："Do you want to proceed?" 格式
- [ ] 补全菜单：全屏 FuzzyPicker
- [ ] Spinner：橙色盲文帧
- [ ] Logo：动画星号 + "Khy" 品牌名

### 14.2 品牌替换

- [ ] Logo 文本：`✳ Khy`（非 `✳ Claude Code`）
- [ ] 欢迎横幅标题：`Welcome to Khy`
- [ ] 版本信息：`Khy vX.Y.Z`
- [ ] Powered by 文本：`Powered by Khy`
- [ ] 输入框占位符：`Send a message...`
- [ ] 无 "Claude" 品牌残留（搜索 `Claude Code` / `Claude` / `claude-code`）

### 14.3 OpenAI 协议支持

- [ ] 状态栏模型名：`gpt-4o` → `GPT-4o`
- [ ] 状态栏模型名：`gpt-4o-mini` → `GPT-4o mini`
- [ ] 状态栏模型名：`o1-preview` → `o1 Preview`
- [ ] 状态栏模型名：`o1-mini` → `o1 mini`
- [ ] 状态栏模型名：`o3-mini` → `o3 mini`
- [ ] 上下文窗口：OpenAI 模型使用正确的 token 上限
- [ ] 费用计算：OpenAI 模型使用正确的 USD 定价
- [ ] 模型选择器：OpenAI 模型显示友好名称
- [ ] API Key 配置：`OPENAI_API_KEY` / `khy gateway config` 可用
- [ ] 自定义端点：`OPENAI_API_ENDPOINT` 支持自托管

### 14.4 右侧看板（最大化模式）

- [ ] 终端宽度 ≥ 120 列时自动显示右侧看板
- [ ] 看板宽度：30 列（可通过 `KHY_CC_SIDEBAR_WIDTH` 调整）
- [ ] 分割线：紫蓝色 `#5769F7` 垂直线
- [ ] 5 个面板：📋 Context / 📁 Files / 🔧 Tools / 📊 Stats / 🔌 MCP
- [ ] 标签页导航：图标 + 高亮当前面板
- [ ] `Ctrl+B` 切换看板显示/隐藏
- [ ] `←→` 切换面板
- [ ] Stats 面板：Token 进度条 + 费用 + MCP 连接数
- [ ] Files 面板：当前目录文件树
- [ ] MCP 面板：服务器连接状态列表

### 14.5 帮助菜单覆盖层

- [ ] `?` 键打开帮助菜单覆盖层
- [ ] 标签页导航：Help / General / Commands / Custom commands
- [ ] 当前标签高亮（橙色下划线）
- [ ] 快捷键网格：2-3 列布局
- [ ] 底部状态栏：版本 + MCP 状态 + 操作提示
- [ ] `Esc` / `q` / `?` 关闭菜单
- [ ] `←→` 切换标签页
- [ ] 分割线颜色：紫蓝色 `#5769F7`

### 14.6 交互对齐

- [ ] Tab：权限提示中切换反馈输入
- [ ] ↑/↓：历史导航 + 列表导航
- [ ] Ctrl+O：切换 transcript 模式
- [ ] Ctrl+R：历史搜索
- [ ] Esc：取消/关闭覆盖层
- [ ] Enter：提交/确认

### 14.7 MCP 状态显示

- [ ] 状态栏右侧显示 MCP 连接状态
- [ ] 状态图标：• Connected / ◦ Connecting / ✗ Failed / ○ Disabled
- [ ] 颜色：绿色=已连接 / 黄色=连接中 / 红色=失败 / 灰色=禁用
- [ ] 服务器名称显示（如 `•deepseek-eyes`）
- [ ] 多服务器紧凑显示（如 `•deepseek-eyes •github ✗slack`）
- [ ] `/mcp` 命令打开详情面板
- [ ] 面板显示：名称、状态、类型、工具数、错误信息
- [ ] 键盘导航：↑/↓ 选择、Enter 重连、d 禁用

### 14.8 功能保留

- [ ] 中文消息内容
- [ ] Vim 模式
- [ ] 语音输入（Win+H）
- [ ] 计划模式（/plan）
- [ ] 过程组（可通过 `KHY_CC_TOOL_STYLE=0` 恢复）
- [ ] 会话管理
- [ ] 多适配器网关
- [ ] 内存/上下文跟踪

---

## 15. 与现有规范的关系

### 15.1 引用规范

| 规范 | 关系 |
|------|------|
| `[DESIGN-ARCH-079]` TUI 界面设计规范 | 本规范在 CC 模式下覆盖 079 的部分条款 |
| `[DESIGN-ARCH-078]` CLI-TUI 桌面互联方案 | 兼容，CC 模式不影响桌面端互联 |
| `[DESIGN-ARCH-016]` AI Agent 显示规范 | 兼容，CC 模式仅改变 UI 渲染 |
| `[DESIGN-ARCH-063]` 对照 Claude Code 架构 | 本规范是 063 的 UI 层实施细化 |
| `[DESIGN-ARCH-070]` 治理总纲 | 本规范遵循 070 的 MOD/TOOL 规则 |

### 15.2 设计素材参考

本规范参考了以下 Claude Code TUI 设计素材（位于 `D:\Portable\Docs\design\claude-code-tui\`）：

| 文件 | 内容 | 用途 |
|------|------|------|
| `README.md` | 完整设计描述（布局、消息类型、颜色方案、输入交互） | 整体设计参考 |
| `visual-mockup.md` | 8 个场景的 ASCII mockup | 可视化原型参考 |
| `color-style-spec.md` | 色彩系统 + 样式规范（亮色/暗色主题、ANSI 码） | 颜色系统实施参考 |
| `interaction-spec.md` | 交互规范 + 快捷键 + 工作流 | 交互设计实施参考 |
| `INDEX.md` | 素材索引 + 快速参考 | 素材导航 |

### 15.3 冲突解决

当本规范与 `[DESIGN-ARCH-079]` 冲突时：
- **CC 模式激活时**：以本规范为准
- **Legacy 模式时**：以 `[DESIGN-ARCH-079]` 为准

---

## 16. 附录

### 16.1 CC 主题色板完整参考

```javascript
// tui/theme/ccTheme.js
export const CC_THEME = {
  name: 'claude-code',
  colors: {
    // 品牌色
    primary: '#D77757',
    primaryLight: '#E89878',
    primaryDark: '#B85E3F',
    secondary: '#5769F7',
    secondaryLight: '#7B8AF8',
    
    // 状态色
    success: '#2EA043',
    error: '#F85149',
    warning: '#D29922',
    info: '#58A6FF',
    
    // 中性色
    dimColor: '#6E7681',
    border: '#30363D',
    inactive: '#484F58',
    
    // 工具状态
    toolPending: '#D29922',    // 黄色
    toolSuccess: '#2EA043',    // 绿色
    toolError: '#F85149',      // 红色
    
    // 消息角色
    userMessage: undefined,    // 终端默认
    assistantMessage: undefined, // 终端默认
    toolMessage: '#D77757',    // 橙色
    
    // 状态栏
    statusBarDim: '#6E7681',
    statusBarText: undefined,  // 终端默认
    statusBarAccent: '#D77757', // 橙色
  },
  spacing: {
    messageGap: 1,             // marginTop between messages
    streamingGap: 1,           // marginTop before streaming text
    inputPaddingX: 2,          // horizontal padding in input area
    statusBarPaddingX: 1,      // horizontal padding in status bar
  },
  borders: {
    useBorder: false,          // CC mode: no border on input
    borderColor: '#30363D',
    focusBorderColor: '#D77757',
  },
  animation: {
    spinnerFrames: '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏',
    spinnerColor: '#D77757',
    logoAnimation: true,
  },
};
```

### 16.2 状态栏格式化函数

```javascript
// tui/utils/ccFormatters.js

/**
 * 格式化模型名：取前两词
 * "claude-opus-4-6" → "Opus 4.6"
 */
export function formatModelName(modelId) {
  if (!modelId) return 'Unknown';
  const parts = modelId.split('-');
  if (parts.length >= 2) {
    return `${capitalize(parts[1])} ${parts[2] || ''}`.trim();
  }
  return modelId;
}

/**
 * 格式化上下文使用量
 * { used: 50000, total: 1000000 } → "Context 45% (50k/1M)"
 */
export function formatContext(usage) {
  if (!usage) return '';
  const { used, total } = usage;
  const percent = total > 0 ? Math.round((used / total) * 100) : 0;
  return `Context ${percent}% (${formatTokens(used)}/${formatTokens(total)})`;
}

/**
 * 格式化 token 数量
 * 50000 → "50k", 1000000 → "1M"
 */
export function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(0)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

/**
 * 格式化倒计时
 * 8100 → "2h15m", 273600 → "3d12h"
 */
export function formatCountdown(seconds) {
  if (seconds <= 0) return '0m';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d${h}h`;
  if (h > 0) return `${h}h${m}m`;
  return `${m}m`;
}

/**
 * 格式化费用
 * 0.4231 → "$0.42"
 */
export function formatCost(amount) {
  if (!amount || amount <= 0) return '';
  return `$${amount.toFixed(2)}`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

### 16.3 工具参数摘要格式化

```javascript
// tui/utils/ccToolFormat.js

/**
 * 格式化工具调用为 CC 风格摘要
 * { name: 'Read', input: { file_path: '/src/index.js' } }
 * → "Read(/src/index.js)"
 */
export function formatToolSummary(name, input) {
  switch (name) {
    case 'Read':
      return `Read(${truncatePath(input.file_path)})`;
    case 'Write':
      return `Write(${truncatePath(input.file_path)})`;
    case 'Edit':
      return `Edit(${truncatePath(input.file_path)})`;
    case 'Bash':
      return `Bash(${truncateCommand(input.command)})`;
    case 'Grep':
      return `Grep(${truncateString(input.pattern)})`;
    case 'Glob':
      return `Glob(${input.pattern || '*'})`;
    default:
      return name;
  }
}

function truncatePath(path, maxLen = 40) {
  if (!path) return '';
  if (path.length <= maxLen) return path;
  const parts = path.split('/');
  if (parts.length > 2) {
    return `/${parts[1]}/.../${parts[parts.length - 1]}`;
  }
  return path.substring(0, maxLen - 3) + '...';
}

function truncateCommand(cmd, maxLen = 40) {
  if (!cmd) return '';
  if (cmd.length <= maxLen) return cmd;
  return cmd.substring(0, maxLen - 3) + '...';
}

function truncateString(s, maxLen = 30) {
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.substring(0, maxLen - 3) + '...';
}
```

### 16.4 品牌替换参考实现

```javascript
// tui/utils/ccBrand.js

/**
 * ============================================================
 * 品牌文本集中管理 —— CC 复刻模式下所有面向用户的品牌文本
 * 修改品牌只需改此文件，无需搜索替换整个代码库
 * ============================================================
 */

export const BRAND = {
  // 品牌标识
  name: 'Khy',
  fullName: 'Khy',
  logo: '✳',                    // 动画星号字符（与 CC 视觉一致）
  tagline: 'AI-powered coding assistant',
  
  // UI 文本
  welcomeTitle: 'Welcome to Khy',
  welcomeSubtitle: 'AI-powered coding assistant',
  inputPlaceholder: 'Send a message...',
  inputPlaceholderShell: '! Run a command...',
  
  // 版权/关于
  poweredBy: 'Powered by Khy',
  versionTemplate: (v) => `Khy v${v}`,
  
  // 状态栏（不显示品牌前缀）
  statusBarModelPrefix: '',
};

/**
 * 替换文本中的 Claude Code 品牌为 Khy
 * 用于处理第三方内容或遗留文本
 */
export function replaceBrand(text) {
  if (!text || typeof text !== 'string') return text;
  return text
    .replace(/Claude Code/g, BRAND.fullName)
    .replace(/Anthropic/g, BRAND.name)
    .replace(/claude-code/g, 'khy')
    .replace(/claude code/gi, 'khy');
}

/**
 * 获取 Logo 显示文本（带颜色）
 */
export function getLogoText(animated = true) {
  return animated ? `${BRAND.logo} ${BRAND.name}` : BRAND.name;
}
```

### 16.5 OpenAI 模型名格式化参考实现

```javascript
// tui/utils/ccFormatters.js —— 模型名格式化（双家族支持）

/**
 * 格式化模型名 —— 支持 Claude 和 OpenAI 双家族
 * 
 * Claude 模型:
 *   "claude-opus-4-6" → "Opus 4.6"
 *   "claude-sonnet-4" → "Sonnet 4"
 *   "claude-haiku-4-5" → "Haiku 4.5"
 * 
 * OpenAI 模型:
 *   "gpt-4o" → "GPT-4o"
 *   "gpt-4o-mini" → "GPT-4o mini"
 *   "gpt-4-turbo" → "GPT-4 Turbo"
 *   "gpt-3.5-turbo" → "GPT-3.5 Turbo"
 *   "o1-preview" → "o1 Preview"
 *   "o1-mini" → "o1 mini"
 *   "o3-mini" → "o3 mini"
 * 
 * 其他模型: 返回原始 slug（不破坏未知模型）
 */
export function formatModelName(modelId) {
  if (!modelId) return 'Unknown';
  
  // Claude 模型家族
  const claudeMatch = /^claude-(opus|sonnet|haiku)-(\d+)(?:[-.](\d+))?/i.exec(modelId);
  if (claudeMatch) {
    const [, family, major, minor] = claudeMatch;
    const familyName = capitalize(family);
    const version = minor ? `${major}.${minor}` : major;
    return `${familyName} ${version}`;
  }
  
  // OpenAI GPT 模型家族
  const gptMatch = /^gpt-(\d+)(?:[-.](\d+))?(-(?:turbo|mini|preview|nano))?/i.exec(modelId);
  if (gptMatch) {
    const [, major, minor, suffix] = gptMatch;
    const base = `GPT-${major}${minor ? '.' + minor : ''}`;
    if (suffix) {
      const suffixName = capitalize(suffix.slice(1)); // 去掉前导 '-'
      return `${base} ${suffixName}`;
    }
    return base;
  }
  
  // OpenAI o 系列推理模型
  const oMatch = /^(o[1-9](?:\.\d+)?)-(mini|preview|pro)/i.exec(modelId);
  if (oMatch) {
    const [, family, variant] = oMatch;
    return `${family} ${capitalize(variant)}`;
  }
  
  // 未知模型：返回原始 slug（不破坏）
  return modelId;
}

function capitalize(s) {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}
```

### 16.6 OpenAI 模型上下文窗口参考

```javascript
// tui/utils/ccContextWindows.js

/**
 * 模型上下文窗口大小（tokens）
 * 用于状态栏 Context 百分比计算
 * 来源：各模型官方文档（2026-09 更新）
 */
export const MODEL_CONTEXT_WINDOWS = {
  // OpenAI 家族
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'gpt-4o-2024-08-06': 128_000,
  'gpt-4-turbo': 128_000,
  'gpt-4': 8_192,
  'gpt-4-32k': 32_768,
  'gpt-3.5-turbo': 16_384,
  'gpt-3.5-turbo-16k': 16_384,
  'o1-preview': 128_000,
  'o1-mini': 128_000,
  'o1': 200_000,
  'o3-mini': 200_000,
  'o3': 200_000,
  'o4-mini': 200_000,
  
  // Anthropic 家族
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-haiku-4-5': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
  
  // 默认值（未知模型）
  'default': 128_000,
};

/**
 * 获取模型的上下文窗口大小
 * @param {string} modelId - 模型 ID（如 "gpt-4o", "claude-opus-4-6"）
 * @returns {number} 上下文窗口大小（tokens）
 */
export function getContextWindow(modelId) {
  if (!modelId) return MODEL_CONTEXT_WINDOWS.default;
  
  // 精确匹配
  if (MODEL_CONTEXT_WINDOWS[modelId]) {
    return MODEL_CONTEXT_WINDOWS[modelId];
  }
  
  // 前缀匹配（处理变体如 gpt-4o-2024-08-06）
  if (modelId.startsWith('gpt-4o')) return 128_000;
  if (modelId.startsWith('gpt-4-turbo')) return 128_000;
  if (modelId.startsWith('gpt-4')) return 8_192;
  if (modelId.startsWith('gpt-3.5')) return 16_384;
  if (modelId.startsWith('o1-')) return 128_000;
  if (modelId.startsWith('o3-')) return 200_000;
  if (modelId.startsWith('o4-')) return 200_000;
  if (modelId.startsWith('o1')) return 128_000;
  if (modelId.startsWith('claude-')) return 200_000;
  
  return MODEL_CONTEXT_WINDOWS.default;
}
```

### 16.7 OpenAI 模型定价参考

```javascript
// tui/utils/ccPricing.js

/**
 * OpenAI 模型定价（USD per 1M tokens）
 * 来源：OpenAI 官方定价（2026-09）
 */
export const OPENAI_PRICING = {
  'gpt-4o': { input: 2.50, output: 10.00, cachedInput: 1.25 },
  'gpt-4o-mini': { input: 0.15, output: 0.60, cachedInput: 0.075 },
  'gpt-4-turbo': { input: 10.00, output: 30.00, cachedInput: 2.50 },
  'gpt-4': { input: 30.00, output: 60.00, cachedInput: 15.00 },
  'gpt-3.5-turbo': { input: 0.50, output: 1.50, cachedInput: 0.25 },
  'o1-preview': { input: 15.00, output: 60.00, cachedInput: 7.50 },
  'o1-mini': { input: 3.00, output: 12.00, cachedInput: 1.50 },
  'o3-mini': { input: 1.10, output: 4.40, cachedInput: 0.55 },
};

/**
 * Anthropic 模型定价（USD per 1M tokens）
 */
export const ANTHROPIC_PRICING = {
  'claude-opus-4-6': { input: 15.00, output: 75.00, cachedInput: 1.50 },
  'claude-sonnet-4': { input: 3.00, output: 15.00, cachedInput: 0.30 },
  'claude-haiku-4-5': { input: 1.00, output: 5.00, cachedInput: 0.10 },
};

/**
 * 统一费用计算
 */
export function calculateCost(modelId, inputTokens, outputTokens, cachedTokens = 0) {
  const pricing = OPENAI_PRICING[modelId] 
    || ANTHROPIC_PRICING[modelId]
    || OPENAI_PRICING['gpt-4o']; // 默认回退
  
  const inputCost = ((inputTokens - cachedTokens) * pricing.input) / 1_000_000;
  const cachedCost = (cachedTokens * pricing.cachedInput) / 1_000_000;
  const outputCost = (outputTokens * pricing.output) / 1_000_000;
  return inputCost + cachedCost + outputCost;
}
```

### 16.8 OpenAI 配置快速参考

```bash
# ============================================================
# OpenAI 协议配置指南（CC 模式下使用 OpenAI 模型）
# ============================================================

# 方式 1：环境变量（推荐用于 CI/脚本）
export OPENAI_API_KEY="sk-xxx"
export OPENAI_API_ENDPOINT="https://api.openai.com/v1"  # 可选，支持自托管镜像
KHY_CC_TUI=1 khy

# 方式 2：交互式配置
khy
# 在 REPL 中输入: /login
# 选择 "Anthropic Compatible" → 填写 Base URL 和 API Key
# Base URL: https://api.openai.com/v1
# API Key: sk-xxx

# 方式 3：khy gateway config
khy gateway config
# 选择 provider: OpenAI
# 输入 API Key

# 验证 OpenAI 连接
khy gateway status
# 应显示 openai pool 状态为 connected

# 切换模型（使用 OpenAI 模型）
/model gpt-4o
/model gpt-4o-mini
/model o1-mini
/model o3-mini

# CC 模式下使用 OpenAI 模型
KHY_CC_TUI=1 /model gpt-4o khy
```

### 16.9 MCP 状态栏组件参考实现

```javascript
// tui/ink-components/CcMcpStatus.js

'use strict';

const React = require('react');
const { Text, Box } = require('ink');
const { useMcpStatus } = require('../hooks/useMcpStatus');

/**
 * MCP 状态栏指示器 —— CC 模式专用
 * 显示格式: MCP •server1 Connected •server2 ✗server3 Failed
 */
function CcMcpStatus({ maxServers = 3 }) {
  const { servers, connectedCount, totalCount } = useMcpStatus();

  if (totalCount === 0) {
    return null; // 无 MCP 服务器时不显示
  }

  // 按状态排序：connected > connecting > failed > disabled
  const sorted = [...servers].sort((a, b) => {
    const order = { connected: 0, connecting: 1, reconnecting: 2, failed: 3, disabled: 4 };
    return (order[a.state] || 9) - (order[b.state] || 9);
  });

  // 限制显示数量，超出显示 +N
  const visible = sorted.slice(0, maxServers);
  const remaining = sorted.length - visible.length;

  return (
    <Box marginLeft={1}>
      <Text color="#6E7681">MCP </Text>
      {visible.map((server, i) => (
        <Box key={server.name} marginLeft={i > 0 ? 1 : 0}>
          <Text color={getStatusColor(server.state)}>
            {getStatusIcon(server.state)}
            {truncateName(server.name, 12)}
          </Text>
          {i < visible.length - 1 && <Text color="#6E7681"> </Text>}
        </Box>
      ))}
      {remaining > 0 && (
        <Text color="#6E7681"> +{remaining}</Text>
      )}
    </Box>
  );
}

function getStatusIcon(state) {
  switch (state) {
    case 'connected': return '•';
    case 'connecting': return '◦';
    case 'reconnecting': return '◐';
    case 'failed': return '✗';
    case 'disabled': return '○';
    default: return '?';
  }
}

function getStatusColor(state) {
  switch (state) {
    case 'connected': return '#2EA043';   // 绿色
    case 'connecting': return '#D29922';  // 黄色
    case 'reconnecting': return '#D29922'; // 黄色
    case 'failed': return '#F85149';      // 红色
    case 'disabled': return '#6E7681';    // 灰色
    default: return '#6E7681';
  }
}

function truncateName(name, maxLen) {
  if (name.length <= maxLen) return name;
  return name.slice(0, maxLen - 1) + '…';
}

module.exports = { CcMcpStatus };
```

### 16.10 MCP 状态桥接 Hook 参考实现

```javascript
// tui/hooks/useMcpStatus.js

'use strict';

const { useState, useEffect } = require('react');
const { getMcpServers } = require('../../services/mcp/index');

/**
 * MCP 连接状态桥接 Hook
 * 轮询 MCP 服务器状态，供 CcMcpStatus 组件使用
 */
function useMcpStatus(pollInterval = 5000) {
  const [servers, setServers] = useState([]);
  const [connectedCount, setConnectedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  useEffect(() => {
    let mounted = true;

    async function poll() {
      try {
        const status = await getMcpServers();
        if (!mounted) return;

        const serverList = Object.entries(status).map(([name, info]) => ({
          name,
          state: info.state || 'disabled',
          type: info.type || 'unknown',
          tools: info.tools || 0,
          error: info.error || null,
        }));

        setServers(serverList);
        setConnectedCount(serverList.filter(s => s.state === 'connected').length);
        setTotalCount(serverList.length);
      } catch {
        // fail-soft: 不阻塞 TUI 渲染
      }
    }

    poll();
    const timer = setInterval(poll, pollInterval);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [pollInterval]);

  return { servers, connectedCount, totalCount };
}

module.exports = { useMcpStatus };
```

### 16.11 帮助菜单覆盖层参考实现

```javascript
// tui/ink-components/CcHelpMenu.js

'use strict';

const React = require('react');
const { Text, Box, useInput } = require('ink');
const { BRAND } = require('../utils/ccBrand');
const { useMcpStatus } = require('../hooks/useMcpStatus');

/**
 * CC 风格帮助菜单覆盖层
 * 按 ? 或 /help 打开，Esc 关闭
 * 
 * 布局：
 *   ┌─────────────────────────────────────────────┐
 *   │ Help │ General │ Commands │ Custom commands  │  ← 标签页
 *   ├─────────────────────────────────────────────┤
 *   │ 快捷键网格 / 命令列表 / 自定义命令            │  ← 内容区
 *   ├─────────────────────────────────────────────┤
 *   │ Esc close · ↑↓ tabs · Enter select          │  ← 底部提示
 *   └─────────────────────────────────────────────┘
 */

const TABS = ['Help', 'General', 'Commands', 'Custom commands'];

function CcHelpMenu({ onClose }) {
  const [activeTab, setActiveTab] = useState(0);
  const { connectedCount, totalCount } = useMcpStatus();

  useInput((input, key) => {
    if (key.escape || input === 'q' || input === '?') {
      onClose();
    }
    if (key.leftArrow) {
      setActiveTab(t => (t - 1 + TABS.length) % TABS.length);
    }
    if (key.rightArrow) {
      setActiveTab(t => (t + 1) % TABS.length);
    }
  });

  return (
    <Box flexDirection="column" width="100%">
      {/* 标签页导航 */}
      <Box borderStyle="single" borderColor="#5769F7" paddingX={1}>
        {TABS.map((tab, i) => (
          <Box key={tab} marginX={1}>
            <Text
              color={i === activeTab ? '#D77757' : '#6E7681'}
              bold={i === activeTab}
            >
              {tab}
              {i === activeTab && <Text color="#D77757"> ▔</Text>}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 内容区 */}
      <Box flexDirection="column" paddingX={2} paddingY={1} flexGrow={1}>
        {activeTab === 0 && <HelpTab />}
        {activeTab === 1 && <GeneralTab />}
        {activeTab === 2 && <CommandsTab />}
        {activeTab === 3 && <CustomCommandsTab />}
      </Box>

      {/* 底部状态栏 */}
      <Box justifyContent="space-between" paddingX={2}>
        <Text color="#6E7681">
          {BRAND.versionTemplate(BRAND.version)}
        </Text>
        <Text color="#6E7681">
          MCP {connectedCount > 0 ? `•${connectedCount} Connected` : '—'}
        </Text>
        <Text color="#D77757">
          Esc close · ←→ tabs
        </Text>
      </Box>
    </Box>
  );
}

function GeneralTab() {
  const shortcuts = [
    ['Ctrl+C', 'Cancel/Exit', 'Ctrl+L', 'Clear'],
    ['Ctrl+D', 'Exit REPL', 'Ctrl+R', 'History search'],
    ['Ctrl+O', 'Transcript mode', 'Ctrl+T', 'Tasks'],
    ['↑/↓', 'History nav', 'Tab', 'Complete'],
    ['Shift+Tab', 'Cycle mode', '?', 'Help'],
  ];

  return (
    <Box flexDirection="column">
      {shortcuts.map(([k1, d1, k2, d2], i) => (
        <Box key={i} marginBottom={1}>
          <Box width={20}>
            <Text color="#5769F7">{k1}</Text>
          </Box>
          <Box width={25}>
            <Text color="#E0E0E0">{d1}</Text>
          </Box>
          <Box width={20}>
            <Text color="#5769F7">{k2}</Text>
          </Box>
          <Text color="#E0E0E0">{d2}</Text>
        </Box>
      ))}
    </Box>
  );
}

function CommandsTab() {
  const commands = [
    ['/login', 'Configure provider', '/model', 'Switch model'],
    ['/compact', 'Compress context', '/clear', 'Clear chat'],
    ['/mcp', 'MCP servers', '/goal', 'Set goal'],
    ['/config', 'Configuration', '/status', 'Gateway status'],
    ['/doctor', 'System health', '/update', 'Update check'],
  ];

  return (
    <Box flexDirection="column">
      {commands.map(([c1, d1, c2, d2], i) => (
        <Box key={i} marginBottom={1}>
          <Box width={18}>
            <Text color="#D77757">{c1}</Text>
          </Box>
          <Box width={25}>
            <Text color="#E0E0E0">{d1}</Text>
          </Box>
          <Box width={18}>
            <Text color="#D77757">{c2}</Text>
          </Box>
          <Text color="#E0E0E0">{d2}</Text>
        </Box>
      ))}
    </Box>
  );
}

function HelpTab() {
  return (
    <Box flexDirection="column">
      <Text color="#E0E0E0" bold>Welcome to {BRAND.fullName}!</Text>
      <Text color="#6E7681" marginTop={1}>
        {BRAND.tagline}
      </Text>
      <Text color="#6E7681" marginTop={1}>
        Press <Text color="#5769F7">?</Text> to toggle this help menu.
      </Text>
      <Text color="#6E7681" marginTop={1}>
        Use <Text color="#5769F7">←→</Text> to switch tabs.
      </Text>
      <Box marginTop={2}>
        <Text color="#D77757">Quick start:</Text>
      </Box>
      <Text color="#6E7681" marginTop={1}>
        1. Run <Text color="#5769F7">/login</Text> to configure your AI provider
      </Text>
      <Text color="#6E7681">
        2. Type a message and press <Text color="#5769F7">Enter</Text>
      </Text>
      <Text color="#6E7681">
        3. Use <Text color="#5769F7">/model</Text> to switch models
      </Text>
    </Box>
  );
}

function CustomCommandsTab() {
  // TODO: 从 commandRegistry 动态加载
  return (
    <Box flexDirection="column">
      <Text color="#6E7681">No custom commands installed.</Text>
      <Text color="#6E7681" marginTop={1}>
        Install skills to add custom commands.
      </Text>
    </Box>
  );
}

module.exports = { CcHelpMenu };
```

### 16.12 右侧看板容器参考实现

```javascript
// tui/ink-components/CcSidebarPanel.js

'use strict';

const React = { useState } = require('react');
const { Box, Text, useInput } = require('ink');
const { CcSidebarContext } = require('./CcSidebarContext');
const { CcSidebarFiles } = require('./CcSidebarFiles');
const { CcSidebarTools } = require('./CcSidebarTools');
const { CcSidebarStats } = require('./CcSidebarStats');
const { CcSidebarMcp } = require('./CcSidebarMcp');

/**
 * CC 风格右侧看板容器
 * 当终端宽度 ≥ 120 列时自动显示
 * 
 * 布局：
 *   ┌──────────────────────────┐
 *   │ 📋 │ 📁 │ 🔧 │ 📊 │ 🔌 │  ← 图标标签页
 *   ├──────────────────────────┤
 *   │                          │
 *   │   当前选中面板的内容      │
 *   │                          │
 *   └──────────────────────────┘
 */

const PANELS = [
  { id: 'context', icon: '📋', label: 'Context', Component: CcSidebarContext },
  { id: 'files', icon: '📁', label: 'Files', Component: CcSidebarFiles },
  { id: 'tools', icon: '🔧', label: 'Tools', Component: CcSidebarTools },
  { id: 'stats', icon: '📊', label: 'Stats', Component: CcSidebarStats },
  { id: 'mcp', icon: '🔌', label: 'MCP', Component: CcSidebarMcp },
];

function CcSidebarPanel({ width = 30, onClose }) {
  const [activePanel, setActivePanel] = useState(0);

  useInput((input, key) => {
    if (key.leftArrow) {
      setActivePanel(p => (p - 1 + PANELS.length) % PANELS.length);
    }
    if (key.rightArrow) {
      setActivePanel(p => (p + 1) % PANELS.length);
    }
  });

  const { Component } = PANELS[activePanel];

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="single"
      borderColor="#5769F7"
    >
      {/* 标签页导航 */}
      <Box paddingX={1}>
        {PANELS.map((panel, i) => (
          <Box key={panel.id} marginX={1}>
            <Text
              color={i === activePanel ? '#D77757' : '#6E7681'}
              bold={i === activePanel}
            >
              {panel.icon}
            </Text>
          </Box>
        ))}
      </Box>

      {/* 内容区 */}
      <Box flexDirection="column" paddingX={1} flexGrow={1}>
        <Component />
      </Box>
    </Box>
  );
}

module.exports = { CcSidebarPanel };
```

### 16.13 右侧看板状态面板参考实现

```javascript
// tui/ink-components/CcSidebarStats.js

'use strict';

const React = require('react');
const { Box, Text } = require('ink');

/**
 * Stats 面板 —— 显示 Token 使用量、费用、MCP 连接数
 */
function CcSidebarStats({ context, cost, mcpConnected, mcpTotal }) {
  const tokens = context?.used || 0;
  const total = context?.total || 128000;
  const percent = Math.round((tokens / total) * 100);

  return (
    <Box flexDirection="column">
      <Text color="#6E7681" bold>Tokens</Text>
      <Box marginTop={1}>
        <Text color="#E0E0E0">  {formatTokens(tokens)} / {formatTokens(total)}</Text>
      </Box>
      <Box>
        <Text color={percent > 80 ? '#F85149' : '#D77757'}>
          {'█'.repeat(Math.floor(percent / 5))}{'░'.repeat(20 - Math.floor(percent / 5))} {percent}%
        </Text>
      </Box>

      <Box marginTop={2}>
        <Text color="#6E7681" bold>Cost</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="#2EA043">  ${cost?.toFixed(2) || '0.00'}</Text>
      </Box>

      <Box marginTop={2}>
        <Text color="#6E7681" bold>MCP</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={mcpConnected > 0 ? '#2EA043' : '#6E7681'}>
          • {mcpConnected}/{mcpTotal} Connected
        </Text>
      </Box>
    </Box>
  );
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

module.exports = { CcSidebarStats };
```

---

> **文档状态**：Draft — 待实施
> **创建日期**：2026-09-09
> **最后更新**：2026-09-09
> **负责人**：待分配
> **变更记录**：
> - 2026-09-09：初始版本，包含品牌替换（Khy）、OpenAI 协议支持、MCP 状态显示规范
> - 2026-09-09：新增帮助菜单覆盖层规范（标签页导航 + 快捷键网格 + 底部状态栏）
> - 2026-09-09：新增右侧看板规范（5 个面板：Context/Files/Stats/Tools/MCP）
> - 2026-09-09：整合 Claude Code TUI 设计素材（`D:\Portable\Docs\design\claude-code-tui\`），更新颜色系统、工具调用格式、思考折叠块、斜杠命令菜单、欢迎界面等规范
> - 2026-09-09：新增性能优化与渲染策略章节（resize 无残影、绝对值/相对值设置、渲染速度优化、计时器规范、启动速度优化）
