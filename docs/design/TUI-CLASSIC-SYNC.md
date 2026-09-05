# TUI 与经典模式同步指南

**日期**：2026-09-05（更新）
**目的**：确保 TUI 模式和经典模式的修复同步，避免一个模式修复了另一个没修复。

---

## 统一 UI 架构（2026-09-05 新增）

### 核心原则
**命令处理器返回结构化响应，UI 适配器根据模式渲染。**

```
命令处理器 → 返回 { type: 'info'|'confirm'|'list'|'form', data: {} }
                    │
                    ▼
            uiFacade.renderResponse()
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
   TUI 适配器              经典适配器
   (Ink/React)            (inquirer)
```

### 新增模块

| 模块 | 路径 | 职责 |
|------|------|------|
| **uiResponse** | `cli/uiResponse.js` | 统一响应协议 |
| **uiFacade** | `cli/uiFacade.js` | 统一入口点 |
| **uiAdapter** | `cli/uiAdapter.js` | 模式分发器 |
| **tui/uiAdapter** | `cli/tui/uiAdapter.js` | TUI 渲染器 |
| **classic/uiAdapter** | `classic/uiAdapter.js` | 经典渲染器 |
| **tui/uiBridge** | `cli/tui/uiBridge.js` | TUI 原生组件桥接 |
| **permissionService** | `cli/services/permissionService.js` | 权限逻辑 |
| **modelSelectService** | `cli/services/modelSelectService.js` | 模型选择逻辑 |
| **bannerDataService** | `cli/bannerDataService.js` | Banner 数据 |

### 使用方式

```js
// 在命令处理器中
const ui = require('../uiFacade');

// 显示信息（两种模式自动适配）
await ui.info('Operation complete');
await ui.success('File saved');
await ui.error('Failed to save', 'Error', 'E001');

// 询问确认
const ok = await ui.confirm('Delete this file?', { danger: true });
if (!ok) return;

// 列表选择
const model = await ui.list('Choose a model', [
  { id: 'claude', label: 'Claude Sonnet', description: 'Recommended' },
  { id: 'gpt', label: 'GPT-4', description: 'Powerful' },
]);

// 表单输入
const values = await ui.form('Login', [
  { name: 'username', label: 'Username', required: true },
  { name: 'password', label: 'Password', type: 'password' },
]);
```

### 已集成的命令处理器

| 处理器 | 文件 | 集成点 |
|--------|------|--------|
| /learn | `handlers/learn.js` | `_askChoice()` 使用 `ui.list()` |
| /plugin | `handlers/plugin-dev.js` | `askChoice()` 使用 `ui.list()` |
| /ide | `handlers/ide.js` | `promptModelSelection()` 使用 `ui.list()` |

```
用户启动 khy
    │
    ├── KHY_FULL_TUI=0 或 非 TTY → 经典模式 (readline + inquirer)
    │
    └── 默认 (TTY + 未 opt-out) → TUI 模式 (Ink + React)
```

决策代码：`replSession.js` `startRepl()` 约 388-642 行

---

## 代码分层与同步规则

### 第 1 层：共享代码（自动同步）

以下代码被 TUI 和经典模式共同使用，修复自动同步：

| 模块 | 路径 | 说明 |
|------|------|------|
| **Gateway** | `services/gateway/` | AI 网关、适配器、熔断器、冷却 |
| **Tools** | `tools/` | 所有工具实现（文件读写、Shell、搜索等） |
| **Services** | `services/` | 业务逻辑（会话、权限、内存、量化等） |
| **Utils** | `utils/` | 工具函数（格式化、路径、错误等） |
| **Permissions** | `permissions/` | 权限规则、bash 安全分类 |
| **Auth** | `services/cliAuthService.js` | 认证、会话管理 |
| **Router** | `cli/router.js` | 命令路由、分派 |
| **Shim** | `services/*/index.js` | domain 重导出（需排除 test） |

**同步规则**：修改共享代码时，无需额外操作，两个模式自动获得修复。

**注意**：shim 文件必须排除 `*.test.js`，否则测试代码会在生产环境执行。

---

### 第 2 层：入口代码（需手动同步）

以下代码有 TUI 和经典两条路径，修复需要手动同步：

| 功能 | TUI 路径 | 经典路径 | 同步要点 |
|------|----------|----------|----------|
| **Banner** | `tui/ink-components/WelcomeBanner.js` | `cli/formatters.js` `printBanner()` + `cli/repl/startupHeader.js` | 显示内容一致（版本、模型、认证、网关） |
| **权限提示** | `tui/ink-components/PermissionsPrompt.js` | `cli/permissionDialog.js` | 权限分类、提示文案、回调逻辑 |
| **模型选择** | `tui/ink-components/ModelPicker.js` | `cli/handlers/gateway.js` (inquirer) | 模型列表、探测、选择逻辑 |
| **登录/注册** | `tui/ink-components/FormFlow.js` | `cli/handlers/` (inquirer) | 表单字段、验证、API 调用 |
| **启动头** | `tui/ink-components/App.js` banner 逻辑 | `cli/repl/startupHeader.js` renderStartupHeader | 显示时机、内容、格式 |

**同步规则**：修改入口代码时，检查另一模式是否需要同步。

---

### 第 3 层：命令处理器（需逐命令同步）

部分命令在 TUI 中有原生实现，经典模式使用 inquirer：

| 命令 | TUI 原生实现 | 经典实现 | 状态 |
|------|-------------|----------|------|
| `/model` | `tui/ink-components/ModelPicker.js` | `cli/handlers/gatewayModelChoices.js` | 需同步 |
| `/login` | `FormFlow.js` | `cli/handlers/login.js` | 需同步 |
| `/register` | `FormFlow.js` | `cli/handlers/register.js` | 需同步 |
| `/passwd` | `FormFlow.js` | `cli/handlers/passwd.js` | 需同步 |
| `/apikey` | `FormFlow.js` (基础) | `cli/handlers/apikey.js` (完整) | 经典更完整 |
| `/forgot` | 不支持 | `cli/handlers/forgot.js` | 仅经典 |
| `/hardware` | `tuiCommandReports.js` | `cli/handlers/hardware.js` | 需同步 |
| `/scan` | `tuiCommandReports.js` | `cli/handlers/scan.js` | 需同步 |
| `/checkpoint` | `tuiCommandReports.js` | `cli/handlers/backup.js` | 需同步 |

**同步规则**：修改命令处理器时，检查另一模式的实现是否需要同步。

---

## 已知同步点（2026-09-04 已修复）

### 1. shim 测试文件加载（已修复）

**问题**：`services/query/index.js` shim 错误加载 `.test.js` 文件
**影响**：两个模式都会执行测试代码，TAP 输出写入 stdout
**修复**：删除 shim 中对 `.test.js` 的导出
**同步状态**：✅ 自动同步（共享代码路径）

### 2. Gateway Pool Maps（已修复）

**问题**：`sensenova`/`stepfun` 在 gateway pool maps 中缺失
**影响**：两个模式都无法路由到这些 provider
**修复**：补齐 `DEFAULT_API_POOL_PROVIDER_ALIASES` 和 `DEFAULT_API_POOL_TO_SERVICE_PROVIDER`
**同步状态**：✅ 自动同步（共享代码路径）

### 3. Banner 重复显示（已修复）

**问题**：TUI 模式中 banner 重复显示两次
**影响**：TUI 模式
**修复**：
- 删除 shim 测试文件导出
- 还原 `railOn` 同步初始化
- banner 移至 `<Static>` 区域
- `staticItems[0]` 作为 banner item
**同步状态**：✅ TUI 已修复

### 4. 熔断器注释错误（已修复）

**问题**：注释说"5次/60s"，代码实际是"3次/30s"
**影响**：两个模式的文档可读性
**修复**：修正注释
**同步状态**：✅ 自动同步（共享代码路径）

---

## 同步检查清单

修改代码时，按以下清单检查：

### 修改共享代码（自动同步）
- [ ] Gateway / Services / Tools / Utils → 无需额外操作
- [ ] Shim 文件 → 确认排除 `*.test.js`
- [ ] 权限规则 → 确认 TUI 和经典使用同一份规则

### 修改入口代码（需手动同步）
- [ ] Banner → 检查 `printBanner()` 和 `WelcomeBanner.js` 内容一致
- [ ] 权限提示 → 检查 `PermissionsPrompt.js` 和 `permissionDialog.js`
- [ ] 模型选择 → 检查 `ModelPicker.js` 和 `gatewayModelChoices.js`
- [ ] 登录/注册 → 检查 `FormFlow.js` 和对应 handler

### 修改命令处理器（需逐命令同步）
- [ ] 确认命令在两种模式下的实现路径
- [ ] 修复需要同时应用到两个路径
- [ ] 测试两种模式下的行为一致

---

## Claude Code 风格 Banner 规范

Banner 应包含以下元素（参考 Claude Code v2.1.215）：

```
<ASCII Art>        Claude Code v2.1.215
                   claude-sonnet-4-20250514 · API Usage Billing
                   @workspace /path/to/project
```

**TUI 实现**：`WelcomeBanner.js`
- 左侧：四叶草 ASCII art（已有）
- 右侧：版本、模型、认证、网关、工作目录

**经典实现**：`formatters.js` `printBanner()` + `startupHeader.js`
- 需要同步显示相同信息

---

## 参考：Claude Code 权限提示

Claude Code 使用简洁的权限提示：

```
┌─────────────────────────────────────────────────┐
│  Do you want to proceed?                        │
│  ● Yes, and don't ask again for X               │
│  ○ Yes                                          │
│  ○ No                                           │
└─────────────────────────────────────────────────┘
```

khy 的权限提示应与此保持一致。

---

## 测试验证

每次同步后，需在两种模式下验证：

```powershell
# TUI 模式
khy

# 经典模式
$env:KHY_FULL_TUI = '0'
khy
```

验证点：
- [ ] Banner 显示正确且不重复
- [ ] 权限提示正常工作
- [ ] 模型选择正常工作
- [ ] 登录/注册流程正常
- [ ] 所有命令在两种模式下行为一致
