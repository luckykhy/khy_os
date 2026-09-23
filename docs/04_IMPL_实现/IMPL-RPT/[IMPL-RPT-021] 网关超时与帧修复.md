<!-- 文档分类: IMPL-RPT-021 | 阶段: 实现 | 原路径: docs/指南/网关超时与帧修复.md -->
# 网关超时优化与 REPL 输入框边框修复

> 修复日期：2026-05-19
> 涉及模块：`backend/src/cli/handlers/gateway.js` · `backend/src/services/gateway/aiGateway.js` · `backend/src/cli/repl.js`

---

## 问题 1：`/gateway` 命令卡住

### 现象

执行 `/gateway` 或 `/gateway status` 时，在打印出“正在检测各通道连通性...”之后会阻塞 30-45 秒，期间没有任何可见进度。

### 根因

`handleGatewayStatus()` 通过 `gateway.testAdapter()` 并行测试所有已启用的适配器，但会逐个顺序 await 每个结果，且没有全局截止时间。每个适配器的测试包含三个阶段，每个阶段都有各自的超时：

1. **`init()` 检测** — 每个适配器默认 15s
2. **`testAdapter()` 步骤 1（连通性）** — 默认 10s
3. **`testAdapter()` 步骤 2（模型列表）** — 默认 10s
4. **`testAdapter()` 步骤 3（生成探测）** — 因适配器而异：12-30s

虽然各适配器是并行测试的，但整体的实际耗时由**最慢的适配器**决定。当代理连接失败（12s 超时 + 15s 退避）叠加在上面时，最坏情况下的延迟会超过 45s。

### 修复方案

#### A. 全局超时包装（`gateway.js`）

新增 `GATEWAY_STATUS_TIMEOUT_MS`（默认 20s，可通过环境变量配置）。每个适配器结果都用 `Promise.race` 与一个截止计时器竞争 await。在时限内完成的适配器显示正常结果；未完成的则得到 `{ connectivity: { success: false, error: 'global timeout' } }`。

```js
const GLOBAL_TEST_TIMEOUT_MS = parseInt(
  process.env.GATEWAY_STATUS_TIMEOUT_MS || '20000', 10
) || 20000;

const globalDeadline = Date.now() + GLOBAL_TEST_TIMEOUT_MS;
for (const [key, promise] of Object.entries(testPromises)) {
  const remaining = globalDeadline - Date.now();
  if (remaining <= 0) {
    testResults[key] = { connectivity: { success: false, latencyMs: 0, error: 'global timeout' } };
    continue;
  }
  testResults[key] = await Promise.race([
    promise,
    new Promise(resolve => setTimeout(() => resolve(
      { connectivity: { success: false, latencyMs: 0, error: 'global timeout' } }
    ), remaining)),
  ]);
}
```

#### B. 单步超时缩减（`aiGateway.js`）

| 阶段 | 旧默认值 | 新默认值 | 环境变量覆盖 |
|---|---|---|---|
| `init()` 适配器检测 | 15 000 ms | **8 000 ms** | `GATEWAY_INIT_TIMEOUT_MS` |
| `testAdapter` 连通性 / 模型列表 | 10 000 ms | **6 000 ms** | `GATEWAY_TEST_TIMEOUT_MS` |
| Codex 生成探测 | 12 000 ms | **8 000 ms** | `GATEWAY_CODEX_TIMEOUT_MS` |
| LocalLLM 生成探测 | 30 000 ms | **12 000 ms** | `GATEWAY_LOCAL_LLM_PROBE_TIMEOUT_MS` |
| Claude CLI 生成探测 | 15 000 ms | **10 000 ms** | `GATEWAY_CLAUDE_PROBE_TIMEOUT_MS` |
| IDE（Cursor/Windsurf）探测 | 15 000 ms | **10 000 ms** | `GATEWAY_IDE_PROBE_TIMEOUT_MS` |
| Relay API 探测 | 15 000 ms | **10 000 ms** | `GATEWAY_RELAY_API_PROBE_TIMEOUT_MS` |

所有取值仍可通过对应的环境变量覆盖。

### 结果

最坏情况的实际耗时从约 45s 降低到 20s 的硬上限（全局超时），典型情况在 8-12s 内完成。

---

## 问题 2：REPL 输入框边框在首次提示后消失

### 现象

REPL 的 `❯` 输入提示符在首次出现时（欢迎屏之后）上下各有一条橙色的 `─` 分隔线。在执行任意命令（如 `/model`、AI 对话）之后，提示符重新出现时边框消失了。

### 根因 — 两个问题

#### 问题 A：底部装饰依赖按键输入

底部分隔线 + 状态栏只由被猴子补丁（monkey-patch）的 `rl._refreshLine()` 绘制。Node.js 的 `readline.prompt()` **不会**调用 `_refreshLine()` —— 它只在后续按键时触发。因此底部装饰在用户键入第一个字符之前是不可见的。

首个提示符看起来有边框，是因为欢迎屏的方框（`╭╮╰╯`）在视觉上紧邻 —— 用户把欢迎方框的底边和提示符框架的顶部分隔线混为一谈了。

#### 问题 B：顶部分隔线被滚动到屏幕外

`renderInputPromptFrame()` 依次写入：`[git branch]\n` → `rule\n` → `_origPrompt()`。

当光标接近可见区域底部时，每个 `\n` 都可能触发终端滚动。在一段较长的 AI 响应之后，光标通常位于终端的最后一行。写入 `rule + '\n'` 会使终端滚动，随后 `_origPrompt()` 写入提示符 —— 但此时滚动已经把分隔线那一行推到了可见视口之上。用户根本看不到它。

### 修复方案（`repl.js` — `renderInputPromptFrame`）

#### A. 立即绘制底部装饰

在 `_origPrompt()` 之后，该函数现在会立即使用与 `_refreshLine` 猴子补丁相同的 ANSI 转义逻辑写入底部分隔线 + 状态栏。这样就消除了对按键输入的依赖。

```js
// After _origPrompt(...args):
if (_promptFooterEnabled && _frameRendered && process.stdout.isTTY && _cachedBottomRule) {
  // Move cursor down past prompt, draw bottom rule + footer,
  // then move cursor back to the prompt position.
  let out = '';
  // ... (ANSI cursor movement + draw + return)
  process.stdout.write(out);
}
```

#### B. 绘制前预留终端行

在写入顶部分隔线之前，该函数会通过打印空行再把光标上移的方式预先分配终端空间。这会强制终端在分隔线绘制*之前*完成滚动，从而确保分隔线保持在可见区域内。

```js
if (_promptFooterEnabled && process.stdout.isTTY) {
  // Reserve: status bar + top rule + prompt + gap + bottom rule + footer
  const reserveRows = 4 + _inputFooterGapRows;
  process.stdout.write('\n'.repeat(reserveRows) + `\x1b[${reserveRows}A`);
}
```

修复后的顺序：
1. 写入 `reserveRows` 个空 `\n` —— 终端在需要时滚动
2. 把光标上移 `reserveRows` 行
3. 写入 git 分支 + 顶部分隔线 + `\n`
4. `_origPrompt()` 渲染 `❯ `
5. 立即在提示符下方绘制底部分隔线 + 状态栏
6. 把光标移回提示符位置

现在无论光标位置或终端填充程度如何，顶部分隔线和底部装饰都会在提示符出现的瞬间可见。

### 结果

橙色的 `─` 边框（上 + 下）和 `(shift+tab to cycle) ... ctx` 状态栏现在在每一个提示周期都会立即可见，而不再只是首次出现时可见。

---

## 变更文件

| 文件 | 变更 |
|---|---|
| `backend/src/cli/handlers/gateway.js` | 在适配器测试外层加入 20s 全局超时包装 |
| `backend/src/services/gateway/aiGateway.js` | 缩减 7 个默认超时值 |
| `backend/src/cli/repl.js` | 在 `renderInputPromptFrame()` 中预留行 + 立即绘制底部装饰 |
