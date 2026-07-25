<!-- 文档分类: IMPL-RPT-005 | 阶段: 实现 | 原路径: docs/修复记录/tui-权限授权掉cooked模式修复-2026-06-09.md -->
# TUI 交互式工具授权污染终端修复（终端掉回 cooked 模式）

修复日期：2026-06-09 · 分支：restructure/full-forest

---

## 概述

在 KHY ink TUI 中，当 AI 需要交互式批准工具调用（写文件、执行命令等）时，
终端会"卡死"并掉回 **cooked 模式**：

- ↑ 上键不再回溯历史，而是回显 `^[[A`
- 回车不再提交，而是插入换行符
- 普通字符被终端自身回显到**输入框下方**，变成原始行编辑

本质是 ink 失去了 `process.stdin` 的 **raw 模式所有权**。本次将所有交互式授权
统一改道 ink 原生授权通道 `onControlRequest`（→ `PermissionsPrompt` 覆盖层），
彻底不再触碰 raw 模式；无 host 通道时（经典 REPL / 子代理 / CI）字节级保持现状。

---

## 一、现象

用户连发三条反馈，均指向同一现象：

1. "我上键的历史回溯消失了" —— 截图显示输入区出现 `^[[A^[[A^[[A^[[A^[[A`，
   同时可见 AI 工具调用（writeFile×2 + shell_command(ls ~/Desktop/)）与
   "ask permissions (shift+tab to cycle)"。
2. "我发现刚在 khy 卡死时，回车键盘，也变成了换行符。"
3. "我发现在一些情况下，我的输入放到了输入框之下，变成文本编辑。"

`^[[A`（↑ 的转义序列被原样回显）+ 回车变换行 + 字符回显到帧外，三者合起来是
**终端从 raw 模式掉回 cooked 模式**的教科书级特征。

---

## 二、根因

ink 通过 `useInput` 持有 raw 模式。但经典权限 UI
`services/backend/src/cli/ui/permissionDialog.js` 中的 `promptChoiceMenu`
（被 `formatPermissionDialog` / `formatBatchPermissionDialog` 调用）直接对共享
`process.stdin` 执行 `setRawMode(false)` + readline。当 AI 工具需要**交互式授权**时，
这段经典 UI 在 ink 会话中运行，把终端切到 cooked 模式 → 键盘泄漏到 ink 帧之外。

触发路径有二（同一根因）：

| # | 路径 | 入口 | 经典弹窗 |
|---|------|------|----------|
| 1 | 批量预检 | `toolUseLoop.js` → `runPreflight` | `formatBatchPermissionDialog`（首轮 ≥2 工具时，正是截图的 writeFile×2 + shell_command） |
| 2 | 单工具授权 | `toolCalling.js` → `requestPermission` | `formatPermissionDialog`（ask 模式下任一非自动放行工具） |

ink 原生授权通道 `onControlRequest`（→ `PermissionsPrompt` 覆盖层，**不碰 raw 模式**）
**已经**透传到 `executeTool` 的 traceContext，但 `requestPermission` 与 `runPreflight`
**没有去用它**，而是落到了经典 raw-mode 弹窗。

### 关键事实：ink 权限解析值是原语，不是对象

ink bridge 对非 AskUserQuestion 的 `can_use_tool` 请求渲染 `PermissionsPrompt`，
用户按 y/n/a 后 `resolveControl(true | false | 'always')` 解决该 Promise。
因此权限 `onControlRequest` 的解析值是**原语** `true` / `'always'` / `false`，
**不是** `{behavior}` 对象。`toolUseLoop._readControlDecision` 只认对象、对原语返回
`'deny'`，故新分支**必须自行**映射原语，不能复用它。

---

## 三、修复架构

只在存在 host 通道时改道；否则字节级走旧路径。

```
executeTool(traceContext.onControlRequest)
        │
        ├─ runPreflight(toolCalls, { onControlRequest })
        │       └─ onControlRequest 存在 → return 空集（逐个授权交给 per-tool）
        │       └─ 否则 → formatBatchPermissionDialog（经典，不变）
        │
        └─ requestPermission(key, params, onControlRequest)
                └─ 所有既有提前返回（permStore allow/deny、preflight 命中、
                │   safe/low 自动放行、dangerousMode、isApproved、critical 红线）保持不动
                └─ onControlRequest 存在 → 构造 can_use_tool 请求 → ink PermissionsPrompt
                │       _decisionFromControl(原语) → allow / allow-always / deny
                │       复用落库（approveTool + permStore.approve/deny）→ return，绝不碰 raw 模式
                └─ 否则 → formatPermissionDialog（经典，不变）
```

---

## 四、文件改动

### `services/backend/src/services/toolCalling.js`

- 新增纯函数 `_decisionFromControl(resp)`：把 ink 原语映射为决策，并对将来可能的
  对象形状（`{behavior}`、`control_response` 包裹）做容错。

  ```js
  // true → allow；'always' / 'allow-always' → allow-always；其余 → deny
  ```

- `requestPermission(toolName, params, onControlRequest = null)`：在**全部既有提前返回
  之后**、调用 `formatPermissionDialog` **之前**，新增分支：

  ```js
  if (typeof onControlRequest === 'function') {
    let ctrlResp = null;
    try {
      ctrlResp = await onControlRequest({
        requestId: `perm_${Date.now()}_${...}`,
        request: { subtype: 'can_use_tool', tool_name: toolName, input: params },
      });
    } catch { ctrlResp = null; }
    const decision = _decisionFromControl(ctrlResp);
    // 镜像经典弹窗的落库，使后续调用短路
    if (decision === 'allow-always') { approveTool(permissionKey, true); permStore.approve(key, 'forever'); }
    else if (decision === 'allow')   { permStore.approve(key, 'once'); }
    else                             { permStore.deny(key, 'session'); }
    return decision; // 绝不触碰 raw 模式
  }
  ```

- `executeTool` 调用点：把 `traceContext.onControlRequest` 传入 `requestPermission`。

### `services/backend/src/services/preflightPermission.js`

- `runPreflight(toolCalls, options)` 顶部新增 ink 守卫：

  ```js
  // Ink/host 通道存在 → 改用 per-tool 交互式授权，绝不跑经典 raw-mode 批量弹窗
  if (typeof options.onControlRequest === 'function') {
    return { approved, denied }; // 空集
  }
  ```

### `services/backend/src/services/toolUseLoop.js`

- 预检调用点：`runPreflight(toolCalls)` → `runPreflight(toolCalls, { onControlRequest })`
  （`onControlRequest` 已在该作用域内）。

---

## 五、零回归保证

- `onControlRequest` 缺省时（经典 REPL、子代理、CI、WS fire-and-forget），
  所有路径与今日**字节一致**。
- 新分支纯增量，仅在存在 host 通道时激活；所有既有自动放行 / 拒绝 / 红线提前返回
  都先于新分支执行。
- 不改 `permissionStore` 决策语义，不改经典 `permissionDialog.js`
  （仅"在 ink 下不再被调用"）。

---

## 六、验证

测试文件：`services/backend/tests/toolCalling.permissionControlChannel.test.js`（5/5 绿）

| 用例 | 断言 |
|------|------|
| onControlRequest 返回 `true` | 决策 `allow`，请求形状 `can_use_tool`，`permStore.approve(once)`，**未调用 `stdin.setRawMode`** |
| 返回 `'always'` | 决策 `allow-always`，`permStore.approve(forever)`，未调用 setRawMode |
| 返回 `false` | 决策 `deny`，`permStore.deny(session)`，未调用 setRawMode |
| 无通道 | 回落经典 `formatPermissionDialog`（路径不变） |
| `runPreflight` 带 onControlRequest | 返回空集，**绝不**打开批量弹窗 |

相邻回归套件：`toolUseLoop.intentGate / verificationGate / harnessProfile /
deliveryConclusion / guardrails / structuredContext` + `toolCalling.openAppAlias`，全绿。

### 测试陷阱（已踩坑记录）

1. **`os.homedir()` 在 macOS 忽略 `process.env.HOME`**（走 getpwuid）。
   `PERMISSIONS_FILE = ~/.khyquant/tool_permissions.json` 在模块加载期由
   `os.homedir()` 解析，故重定向 HOME 无效；必须
   `jest.doMock('os', () => ({ ...jest.requireActual('os'), homedir: () => tmpHome }))`，
   否则 `approveTool` 的持久化会污染真实文件并跨测试泄漏（`isApproved` 提前短路成
   `allow`，导致 false 用例错误返回 allow）。
2. **rtk hook 对 jest 报 `Exec format error`**，须直跑 hoisted 二进制：
   `cd services/backend && node ../../node_modules/jest/bin/jest.js <file> --runInBand --rootDir .`。

### 端到端（需人工确认）

在 ink TUI（ask 模式）让模型一次发 ≥2 个写 / 执行工具，确认：
弹出 ink 的 `PermissionsPrompt`（y/n/a）；授权前后 ↑ 历史回溯、回车提交、普通输入
全部正常；终端不再掉 cooked、无 `^[[A` 泄漏。

---

## 七、备注（同族潜在缺陷，本次范围外）

- `toolUseLoop._readControlDecision`（exec-approval 路径）同样只认对象、对 ink 原语返回
  `deny`，属同族缺陷。本次先用独立的 `_decisionFromControl` 规避；如需一并修复，可让
  `_readControlDecision` 也接受原语 `true` / `'always'`，但那会改动 exec-approval 行为，
  应单列评估。
- 预存在失败 `tests/toolCalling.shellForkClassify.test.js`：forest 重构后
  `shell_command` 已移出 `BUILTIN_TOOLS`（HEAD 同样 0 命中），与本次修复无关。
