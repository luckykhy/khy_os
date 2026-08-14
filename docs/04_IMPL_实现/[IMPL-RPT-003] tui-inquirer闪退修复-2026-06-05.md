<!-- 文档分类: IMPL-RPT-003 | 阶段: 实现 | 原路径: docs/修复记录/tui-inquirer闪退修复-2026-06-05.md -->
# TUI inquirer 闪退修复 + 默认解禁 (2026-06-05)

## 概述

修复了一类导致 **Ink TUI 整个进程闪退回 bash** 的 bug：任何在 TUI 内通过
`route()` 触发 `inquirer` / readline 交互的命令（最初表现为 `/model`），都会
和 Ink 抢占 stdin raw mode，在 inquirer 释放时让 Ink 的 `waitUntilExit()`
resolve，从而结束整个 app。

本次在 [HOTFIX_MODEL_SELECTION.md](%5BIMPL-RPT-022%5D%20HOTFIX_MODEL_SELECTION.md) 解决 `/model`
单点的基础上，**系统性消除整类闪退**，并把 Ink TUI 从 `KHY_FULL_TUI=1` 灰度
**改为默认开启**（`KHY_FULL_TUI=0` 显式回退经典 REPL）。

---

## 一、根因

- Ink 在应用挂载时独占 stdin 的 raw mode。
- 经典 REPL 的大量交互命令在 `router.js` 的 `route()` switch 内（或其 handler 中）
  直接 `require('inquirer')` 并 `inquirer.prompt(...)`。
- 在 TUI 里，App.js 的 `runRouted()` 对所有 `/` 命令调用 `route()`。一旦命中
  inquirer 分支，inquirer 与 Ink 同时操作同一个 stdin/raw mode，inquirer 退出时
  Ink 误判应用结束 → 进程退回 shell。
- 个别 handler（如 `_askChoice`）把 inquirer 包了 `try/catch`，但闪退发生在
  进程层（Ink 退出），catch 根本来不及生效。

**结论**：在 TUI 内绝不能让 inquirer 进入 `route()`。每个交互命令要么端口为原生
Ink overlay，要么在 `runRouted()` 入口拦截。

---

## 二、修复架构

三层处理：

1. **原生 overlay（彻底端口）** — 用自管 `useInput` 的 Ink 组件替代 inquirer：
   - `/model` → `ModelPicker.js`（既有）
   - `/login` `/register` `/passwd` → 新增 `FormFlow.js`
   - `/apikey`（`gateway config`）常用路径 → `FormFlow.js`（添加厂商 Key + 网络代理）
2. **子命令级兜底守卫（暂未端口）** — `tuiUnsupportedReason(parsed)` 命中时推送
   提示「该命令暂需经典模式：请用 `KHY_FULL_TUI=0 khy` 运行」，而不是放行 inquirer。
3. **默认门控** — `repl.js startRepl` 默认进 TUI，`KHY_FULL_TUI=0` 回退。

### 关键约束：overlay 必须原地渲染

`/login` / `/model` 等原生 overlay 在 `runRouted()` 中**早于** `setInputActive(false)`
返回，因此 live 区不被卸载，overlay 直接挂在原 UI 里。App 顶层 `useInput` 在
`modelPicker` / `formFlow` 存在时 `return` 让出输入，由 overlay 自己的 `useInput`
独占，避免双重处理。

---

## 三、文件改动

### 新增 `backend/src/cli/tui/ink-components/FormFlow.js`

可复用的顺序字段表单 overlay：

- 字段类型：`input` / `password`（`*` 掩码）/ `select`（↑↓ + 数字键）。
- 逐字段 `validate(value, answersSoFar) => true | errorMsg`，校验失败原地报错不前进。
- 已答字段在上方回显（密码掩码、select 显示选项名）。
- `onResolve(answers | null)`：完成回传 `{ [name]: value }`，Esc 取消回传 `null`。
- 自带 `useInput`，与 `QuestionPrompt` / `ModelPicker` 同款自管输入模式。

### `backend/src/cli/tui/ink-components/App.js`

- 引入 `FormFlow`，新增 `formFlow` 状态。
- `askForm(spec)`：返回 Promise，让命令处理器像 `await inquirer.prompt` 一样
  `await` 表单结果。`resolveFormFlow(answers)` 触发该 Promise 并卸载 overlay。
- `runAuthForm(command)`：用 FormFlow 收集输入后**直调 `cliAuthService`**
  （`login` / `register` / `changePassword`），与经典 REPL 同一服务，仅输入采集层不同。
- `runRouted()`：在释放输入前
  - 拦截 `login` / `register` / `passwd` → `runAuthForm`；
  - 调用 `tuiUnsupportedReason(parsed)`，命中则推送经典模式提示并返回。
- 顶层 `useInput`：`if (formFlow) return;` 让出输入给 overlay。
- 模块级 `tuiUnsupportedReason(parsed)` + `_learnNeedsClassic()` 守卫函数。

### `backend/src/cli/repl.js`

门控由 opt-in 改为 default-on：

```javascript
const tuiOptOut = process.env.KHY_FULL_TUI === '0' || options.fullTui === false;
const tuiRequested = !tuiOptOut && (options.fullTui || process.stdout.isTTY);
if (tuiRequested && process.stdout.isTTY) { /* startInkApp */ }
```

---

## 四、命令覆盖

### 已原生化（TUI 内正常工作）

| 命令 | 实现 |
|---|---|
| `/model`（`gateway model`） | `ModelPicker` |
| `/login` | `FormFlow` + `cliAuthService.login` |
| `/register` | `FormFlow` + `cliAuthService.register` |
| `/passwd` | `FormFlow` + `cliAuthService.changePassword` |
| `/apikey` 添加 Key（`gateway config` → provider-keys 常用路径） | `FormFlow` + `gateway.getProviderKeyChoices` / `applyProviderKey` |
| `/apikey` 网络代理（`gateway config` → proxy 常用路径） | `FormFlow` + `gateway.getProxyConfigInfo` / `applyProxyAction` |

### 兜底守卫（提示经典模式，不闪退）

`tuiUnsupportedReason` 精确到子命令，安全变体（`/pool` 状态、`/publish check`、
`/docs maintainer` 等）照常运行：

| 命中条件 | 提示标签 |
|---|---|
| `forgot` | 找回密码 |
| `init` | 项目初始化向导 |
| `cloud login` / `cloud register` | 云端账号登录/注册 |
| `plugin gateway delete` | 插件网关删除确认 |
| `app uninstall` | 应用卸载确认 |
| `docs claude` | Claude 文档交互 |
| `pool import\|add\|delete` | 账号池交互配置 |
| `publish pypi\|testpypi\|origin-code\|origin\|self-pypi` | 发布上传确认 |
| `ai owner` | AI Owner 密钥输入 |
| `learn`（仅 `_learnNeedsClassic()`，即无可用模型的离线交互） | 离线课程交互 |

### 确认不受影响（不在 TUI 路径）

`menu.js`（numbered 菜单，`case 'menu'` 仅 `return 'menu'` 哨兵，TUI 不启动）、
`handlers/settings.js`、`handlers/cloud.js`、`riskConfirm.js`（`src/` 内零调用方）、
`router.js` `default:` 模糊匹配（`!isTui` 守卫）、`handlers/review.js`（`/review`
是 flag 命令走 `handleFlag`，不进 `route()`）。

---

## 五、验证

- `node --check`：`FormFlow.js` / `App.js` / `repl.js` 全过。
- 运行期 `require`：`App.js`、`FormFlow.js` 正常加载。
- 依赖核对：`cliAuthService`（checkSession/login/isRegistered/register/changePassword）、
  `aiGateway.getStatus`、gateway 三个 model 函数导出均存在。

手测路径：
- `khy` 直接进入新 TUI；
- `/login` 弹出原生表单，输入后由 `cliAuthService` 处理；
- `/apikey` 给出经典模式提示而非闪退；
- `KHY_FULL_TUI=0 khy` 回退经典 readline REPL。

---

## 六、待完成

- **`/apikey`（`handleGatewayConfig`）高级子菜单**：常用路径（添加厂商 Key、网络代理
  检测/HTTP/关闭）已端口为 `FormFlow` overlay；其余高级配置（ollama / relay-api /
  routing-policy / key-strategy / 订阅管理 / 自定义 provider 等多层子树）入口选择
  「其他高级配置」时给出经典模式提示，后续按需渐进迁移。
- 其余低频命令（`/init`、`/forgot`、`/pool import` 等）可按需用 `FormFlow` 渐进迁移。

新增交互命令到 TUI 的规则：简单字段表单复用 `FormFlow`，选择类复用 `ModelPicker` /
`QuestionPrompt`；无法即时端口的命令**必须**加进 `tuiUnsupportedReason` 守卫，
严禁让 inquirer 进入 `route()`。
