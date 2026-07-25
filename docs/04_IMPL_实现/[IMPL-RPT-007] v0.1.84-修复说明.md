<!-- 文档分类: IMPL-RPT-007 | 阶段: 实现 | 原路径: docs/修复记录/v0.1.84-修复说明.md -->
# v0.1.84 缺陷修复

> ⚠️ **已归档 / 被取代**：本文档涉及的自研 TUI 运行时（`liteRepl.js`、`keypressParser.js`、`tuiShell.js` 等）已于 2026-06-05 全面迁移至官方 Ink 运行时（`backend/src/cli/tui/ink-components/`）。本文仅作历史修复记录保留，最新 TUI 行为请参阅 [tui-inquirer闪退修复-2026-06-05.md](%5BIMPL-RPT-003%5D%20tui-inquirer闪退修复-2026-06-05.md)。

发布日期：2026-06-02

---

## 1. Windows Terminal 文本选中失效

**现象**：Windows 上安装 khy 后，无法用鼠标选中、复制终端内的任何文本。

**根因**：`keypressParser.js` 在 Windows Terminal (`WT_SESSION`) 上启用了 `\x1b[?1002h` (button-event tracking) + `\x1b[?1006h` (SGR mouse mode)。虽然代码注释声称只用 `?1002h`（不用 `?1000h`）就能保留原生选中，但实际上 **Windows Terminal 下 `?1002h` 同样会捕获拖拽事件**，导致无法框选文本。

**修复** (`backend/src/cli/tui/runtime/keypressParser.js`):

```javascript
// Before: Windows 现代终端也启用鼠标报告
const hasModernWinTerm = isWin && (process.env.WT_SESSION || ...);
if (!isWin || hasModernWinTerm) {
  this._stdout.write('\x1b[?1002h\x1b[?1006h');
}

// After: Windows 上完全不启用鼠标报告
if (!isWin) {
  this._stdout.write('\x1b[?1002h\x1b[?1006h');
}
```

**权衡**：Windows 上不再有 SGR 鼠标滚轮事件。滚轮滚动由 Windows Terminal 自动翻译为方向键序列（`\x1b[A`/`\x1b[B`），在 busy 状态下等效于 viewport 滚动，空闲状态为历史导航——行为合理无功能损失。

---

## 2. 移动端桥接消息重复

**现象**：手机端发一条消息，聊天记录里显示两条相同的用户消息。

**根因**：消息在两个位置各被渲染一次：
1. `doSend()` 发送时立即调用 `addUserMsg(text)` 显示在本地
2. 后端 `tuiShell.js` 收到消息后广播 `{ type: 'turn_start', input: text }` 给所有客户端，手机端的 `turn_start` handler 又调用了 `addUserMsg(msg.input)`

**修复** (`backend/src/bridge/mobilePage.js`):

```javascript
// 发送时记录最近发出的文本
var _lastSentText = null;
function doSend(){
  _lastSentText = text;
  wsSend({type:'input', text: text});
  addUserMsg(text);  // 本地立即显示
  ...
}

// 收到 turn_start 时去重
case 'turn_start':
  if(msg.input && msg.input !== _lastSentText) addUserMsg(msg.input);
  _lastSentText = null;  // 重置，确保重连回放时仍能显示
  ...
```

**设计说明**：使用文本匹配而非 clientId 排除，因为 `broadcastOutput` 不支持 excludeClient，且此方案零改动服务端。重连回放场景中 `_lastSentText` 已被清空，历史消息仍能正确回显。

---

## 3. 思考/停滞状态污染 `/model` 菜单

**现象**：在 AI 思考/请求过程中打开 `/model` 选择菜单，后台的 spinner（"Thinking... (35s)"）和 stall 检测消息（"after 25000ms without meaningful model progress..."）持续输出到 stdout，破坏 inquirer 选择列表的显示。

**根因**：两套 inquirer 保护机制互不感知：
- `liteRepl.js` 的 `inqPrompt()` wrapper 设置 module-level `_inquirerActive`
- `gateway.js` 的 `promptWithReplGuard()` 设置 `global.__KHY_INQUIRER_ACTIVE__`
- Spinner `_render()` 依赖 `isInteractiveInputActive()` guard，但该 guard 只检查"busy 且用户在打字"
- `emitRuntimeStatus()` 和 `tracker.start()` 完全没有 inquirer 状态检查

**修复** (`backend/src/cli/liteRepl.js`, 三处修改):

### 3a. 交互守卫增加 inquirer 检查

```javascript
// Before: 只在用户打字时抑制 spinner
renderer.setInteractiveGuard(() => (
  _busy && (rl.line.length > 0 || Date.now() < _busyTypingUntil)
));

// After: inquirer 活跃时也抑制
renderer.setInteractiveGuard(() => (
  _inquirerActive || global.__KHY_INQUIRER_ACTIVE__
  || (_busy && (rl.line.length > 0 || Date.now() < _busyTypingUntil))
));
```

**效果**：`DynamicSpinner._render()` 和 `startSparkle()` 的 setInterval 回调在 inquirer 活跃期间短路返回，不写任何 stdout 内容。

### 3b. emitRuntimeStatus 增加守卫

```javascript
const emitRuntimeStatus = (text = '') => {
  if (_inquirerActive || global.__KHY_INQUIRER_ACTIVE__) return;
  ...
};
```

**效果**：codexAdapter 的 stall 超时消息、适配器状态回传等通过 `onChunk({ type: 'status' })` 产生的 console.log 输出在菜单期间被静默丢弃。

### 3c. tracker.start 与适配器事件处理器增加守卫

```javascript
// status chunk handler
if (raw && !_inquirerActive && !global.__KHY_INQUIRER_ACTIVE__)
  tracker.start(...);

// adapter status event
_adapterStatusHandler = (text) => {
  if (!_inquirerActive && !global.__KHY_INQUIRER_ACTIVE__) emitRuntimeStatus(text);
};
```

---

## 修改的文件

| 文件 | 改动 |
|------|------|
| `backend/src/cli/tui/runtime/keypressParser.js` | Windows 不启用鼠标报告 |
| `backend/src/bridge/mobilePage.js` | turn_start 去重 + _lastSentText 标记 |
| `backend/src/cli/liteRepl.js` | interactiveGuard/emitRuntimeStatus/tracker/adapter handler 增加 inquirer 检查 |

## 测试说明

- Windows: 验证文本选中、Ctrl+C 复制、右键粘贴均正常
- 手机: 验证发送消息只显示一次，断线重连后历史消息正常回放
- `/model` 菜单: 在 AI 请求进行中打开，确认无任何 stall/spinner 输出干扰选择列表
