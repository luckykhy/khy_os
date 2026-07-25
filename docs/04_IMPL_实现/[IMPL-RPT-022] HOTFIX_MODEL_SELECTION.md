<!-- 文档分类: IMPL-RPT-022 | 阶段: 实现 | 原路径: docs/维护者/HOTFIX_MODEL_SELECTION.md -->
# /model 命令修复说明 (2026-06-04)

## 问题描述
1. **输入 `/model` 后整个 khy 进程直接退出回到 bash**（核心问题，二次定位）
2. 用户在选择界面取消时无提示
3. Claude Opus 4.8 模型缺失，无法在模型列表中选择

## 核心修复：/model 导致进程退出（最终真因 = 确诊）

**症状**：在 AI 会话中输入 `/model`，khy 直接退回 shell。

**真因**：`backend/src/cli/repl.js` 的 `startRepl` 发生未提交回归，把
TUI 门控 `if (KHY_FULL_TUI === '1' && stdout.isTTY)` 改成了无条件
`if (stdout.isTTY)`，导致真实终端默认进入 **Ink TUI**。Ink 独占 stdin
raw mode，而 Ink 里 `/model` 仍走 `handleGatewaySelectModel` →
`promptWithReplGuard` → `inquirer.prompt`。inquirer 抢 stdin 并在释放时
让 Ink 退出整个 app（`waitUntilExit()` resolve）→ 进程结束回 bash。

**诊断关键**：用 `node-pty` 真实 PTY 驱动 khy 抓到调用栈
`startRepl → startInkApp`，确认运行的是 Ink 而非经典 readline。我此前所有
改动都打在经典 readline 路径（非 TTY 分支），运行时根本不走。

**修复**：恢复 `KHY_FULL_TUI=1` 灰度门控（对齐 commit e53012c
"TUI 降级为灰度"：默认经典 REPL，Ink 仅 opt-in）。
```javascript
const tuiRequested = process.env.KHY_FULL_TUI === '1' || options.fullTui;
if (tuiRequested && process.stdout.isTTY) { /* startInkApp */ }
// 默认 fall through → 经典 readline REPL（/model 正常工作）
```

**验证**：PTY 实测 `/model` 触发通道探测（"检测各通道连通性..."），
进程存活不退出。经典 REPL 的 `/model` 已被老版 `bundled.zip` 证明正常。

**遗留待办**：若将来默认启用 Ink，必须先把 `/model` 等 inquirer 交互移植
为原生 Ink 组件（参考 `QuestionPrompt.js`），否则 Ink 下必崩。

## 次要修复（保留，无害加固）

### 修复 1: 添加取消提示
**文件**: `backend/src/cli/handlers/gateway.js:3730`
```javascript
if (!selectedValue) {
  printInfo('已取消模型选择');  // 新增提示
  return;
}
```

### 修复 2: 添加 Claude Opus 4.8/4.7
**文件**: `backend/src/services/gateway/adapters/claudeAdapter.js:99`
```javascript
const KNOWN_MODELS = [
  { id: 'claude-opus-4-8', name: 'Claude Opus 4.8', ... },  // 新增
  { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', ... },  // 新增
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', ... },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', ... },
  { id: 'claude-haiku-4-5-latest', name: 'Claude Haiku 4.5', ... },
];
```

## 应用修复

### 当前状态检测
检测到 **5 个旧 khy 进程**仍在运行，它们加载的是修改前的代码：
```bash
$ ps aux | grep khy
kodehu03  319270  ... 12:33 (203分钟运行时长)
kodehu03  540289  ... 17:16 (200分钟运行时长)
kodehu03  545126  ... 17:21 (93分钟运行时长)
kodehu03  859871  ... 21:32 (37分钟运行时长)
kodehu03  869439  ... 21:40 (33分钟运行时长)
```

### 解决方案：重启 KHY 进程

#### 方法 1: 优雅重启（推荐）
在每个运行 khy 的终端窗口中：
1. 按 `Ctrl+C` 中断当前会话
2. 重新运行 `khy` 命令

#### 方法 2: 强制终止所有进程
```bash
# 终止所有 khy 进程
pkill -f "node.*khy.js"

# 或者逐个终止
kill 319270 540289 545126 859871 869439

# 然后重新启动 khy
khy
```

#### 方法 3: 仅重启当前终端的会话
如果你只想修复当前终端：
1. 记下当前会话的对话历史（如果需要）
2. `Ctrl+C` 退出
3. 重新运行 `khy`

## 验证修复

重启后验证：
```bash
# 1. 测试 /model 命令
/model

# 2. 应该看到：
#    - Claude Opus 4.8 出现在列表中
#    - 按 Esc 时显示"已取消模型选择"而不是静默退出

# 3. 测试选择 Claude Opus 4.8
/model
# 选择 "Claude Opus 4.8"
# 应该成功切换
```

## 技术细节

### 为什么需要重启？
Node.js 进程启动时会将所有代码加载到内存中：
- **代码缓存**: 修改磁盘上的 `.js` 文件不会影响已运行的进程
- **模块系统**: `require()` 只在首次加载时读取文件，之后使用缓存
- **热重载限制**: KHY 不支持热重载（HMR），必须重启进程

### 相关文件
- `backend/src/cli/handlers/gateway.js` - /model 命令逻辑
- `backend/src/services/gateway/adapters/claudeAdapter.js` - Claude 模型定义
- `backend/src/services/gateway/aiGateway.js` - 网关核心

## 后续建议

为防止类似问题，建议：
1. **定期重启**: 开发环境下修改代码后立即重启
2. **版本检查**: 添加 `/version` 命令显示当前运行的代码版本
3. **热重载**: 考虑未来添加配置文件热重载功能（仅限配置，不包括代码）

---
修复完成时间: 2026-06-04 22:30
修复者: Claude Opus 4.8
