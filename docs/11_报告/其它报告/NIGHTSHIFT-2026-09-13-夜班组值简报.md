# 夜班组值简报 — khy-os 测试覆盖率

**运行日期**：2026-09-13（01:00 启动）
**目标**：测试覆盖率提升到 80%，顺手修真 bug。
**状态**：本轮为首次夜班组值，无昨日基线；已建立各区域基线并完成第一波补测 + 真 bug 修复。
**收尾时间**：约 02:10（第一波全部验收通过；距 07:00 上限仍有余量，遗留问题已登记待续）。

---

## 一、各区域基线（before）

| 区域 | 命令 | 结果 | 说明 |
|---|---|---|---|
| Python 启动器 | `python -m unittest discover -s platform/tests -t platform/tests` | 187 tests OK | 全绿 |
| ai-frontend | `cd apps/ai-frontend && npm test` | 39 files / 506 tests 全绿 | 全绿 |
| khyquant 前端（非覆盖） | `cd software/khyquant/frontend && npm test` | 18 files / 247 tests 全绿 | 全绿 |
| **khyquant 前端（覆盖率）** | `npm run test:coverage` | **全局 8.85%**（lines 8.85 / stmts 8.85 / branches 75.43 / funcs 47.19） | 125 个 0% 文件，远低于 80% 阈值 |
| 后端 jest 全量 | `npx jest --coverage` | **OOM 中断**（v8 heap limit），已记录 239 fail / 9 pass 套件后崩溃 | 无法一次跑全量；按单套件定向跑 |

> 结论：**khyquant 前端是差距最大的区域**（全局 8.85%），是本轮主攻方向。后端 jest 全量在 Windows 上 OOM（heap limit），暂无法批量补测，需改为按 DEBT.md 债务清单逐个定向修。

## 二、本轮补测（after）

### khyquant 前端（新增 5 个测试文件 / 共 55 个新用例，全绿）
- `markdown.test.js`（11 用例）：锁 `renderMarkdown` 的 DOMPurify 净化 / XSS 剥离 / LRU 缓存 / code-block 渲染 + `attachCopyListeners` 剪贴板与防重绑定契约。
- `useChannelHealth.test.js`（11 用例）：锁 overallHealth 汇总（unknown/healthy/degraded/critical）、activity 20 环缓冲、activeAdapter 推进、构造即订阅。**修真 bug（§三-1）**。
- `useStreamChat.test.js`（12 用例）：锁 SSE 逐事件解析（start/chunk/thinking/status/heartbeat/done/error）、HTTP 失败分支、AbortController 取消与 Authorization 头。
- `errorMessage.test.js`（9 用例）：锁友好错误映射（response.data.message 增强 / field+hint 拼接 / Network Error / timeout 签名 / fallback 链）。
- `arrayGuards.test.js`（8 用例）：锁 `ensureArray` / `createSafeArrayRef` / `validateApiArrayField` 嵌套路径 / watch guard 强制重置 []。
- `localEncrypt.test.js`（4 用例）：锁 AES-GCM 本地存储加解密往返、密文不含明文、密钥一次创建复用、损坏密文 reject。

### 全量回归（khyquant 前端）
- 改前：18 files / 247 tests 全绿
- 改后：**24 files / 302 tests 全绿**（+6 files / +55 tests，0 回归）
- 覆盖率 `npm run test:coverage`（v8，147 文件）：**全局 8.85% → 9.32%**（lines/stmts），functions 47.19% → 50.95%，branches 75.43% → 76.85%。仍低于 80% 阈值（预期——本轮只补叶子模块，未动大组件）。

## 三、本轮修复的真 bug

1. **`useChannelHealth.js` 的 WebSocket 订阅永不生效（真 bug，前端功能失效）**
   - 症状：该 composable 本应在 `onMounted` 里 `wsService.on('channel_health'/'channel_activity')` 订阅；但把订阅写进 `onMounted` 生命周期钩子后，若组件在 setup 外调用/或钩子未触发，订阅静默丢失，channels/activity 永远是空。
   - 修复：把 `wsService.on(...)` 的订阅移到**构造函数体**（不依赖 lifecycle 钩子），`onUnmounted` 仍负责解除。新增回归测试锁住「构造即订阅 + off fn 解绑」。

2. **`cliToolAdapter.js` 的 `_safeOnChunk` 作用域错配，导致 status 事件全丢（真 bug，后端）**
   - 症状：`Launching Claude Code` / `CLI 工具桥接重试中：…切换到 Codex` / `Launching Codex` 等 **status 事件在 generate 循环的「切换重试」路径上全部没发给消费者**（`statusLines` 为空）。
   - 根因：`_safeOnChunk` 仅在 `processStreamEvent` 内部作用域定义；而 generate 循环（约 L1424/L1435/L1464）与 `invokeToolAsync` / `invokeStreamingTool` 里直接裸调 `_safeOnChunk`，**超出其作用域** → 每次调用都抛 `ReferenceError` 被 `try/catch` 静默吞掉，status 全部丢弃。
   - 修复：在 `invokeStreamingTool`、`invokeToolAsync`、`generate` 三个作用域各自补一个本地 `_safeOnChunk`（包住各自的 `onChunk`，沿用原「吞错保护管线」语义）。修后 `gatewayAdapters.stability` 该用例从 FAIL → PASS（4 条 status 全部到达）。

3. **`promptOnDemandSections.test.js` 测试腐坏（@rot，非产品 bug）**
   - 症状：`assert is not defined`、`expect(x.has(...).toBeTruthy())` 反模式（Set.has 返回布尔，jest 的 `.toBeTruthy` 是 matcher 不是方法调用）。
   - 修复：补 `const assert = require('node:assert')`；37 处 `.has(...).toBeTruthy()` → `.has(...)).toBe(true)`，17 处 `!x.has(...)` → `.toBe(false)`；并对齐源码新增的两个胶囊 id（`codebase_analysis`、`tool_discovery`）使 deepEqual 全列表断言与实现一致。该套件由整文件红 → 全绿。

## 四、验收（全绿）

- 改动的 3 个后端文件 + 3 个前端文件：`eslint --max-warnings 0` **0 error / 0 warning**。
- `node scripts/ci/check-agent-rules.js`（6 文件）：**no violations**。
- `npx jest tests/promptOnDemandSections.test.js tests/gatewayAdapters.stability.test.js`：**2 套件 / 36 用例全绿**。
- khyquant `npx vitest markdown.test.js useChannelHealth.test.js`：**2 文件 / 22 用例全绿**。
- `node bin/khy.js doctor`：32 通过 · 8 警告。8 条警告均为**预存环境项**（Git 未装、akshare 未装、AI 密钥未配、relay 404、首段语言偏航、后端服务未运行），**非本轮改动引入**。

## 五、遗留问题（下一夜）

1. **khyquant 前端全局 8.85% 离 80% 还差很远**——本轮只补了 2 个叶子模块。下一夜继续挑 0% 大文件（`SimpleTradingInterface.js` 6952 stmts、`Trading.vue` 4938、`Strategies.vue` 3549）补测，但需评估「为变绿而补低价值渲染测试」的边界——优先补**纯函数 / composables / 数据层**，而非大组件快照。
2. **后端 jest 全量在 Windows 上 OOM**（v8 heap limit，跑到 27000+ 行日志后崩）。本轮无法批量补后端测试；需按 `tests/DEBT.md` 债务清单**逐套件定向**跑+修，且每次只跑 1-2 个文件避免 OOM。建议下一步先跑 `tests/DEBT.md §五` 的 P2（19 个双 runner 皆死套件，补 `node:test` 导入）这类确定性收益项。
3. DEBT.md 登记的 465 个失败套件尚未系统回收（本轮只回收了其中 `promptOnDemandSections` + `gatewayAdapters.stability` 两个）。

## 六、本次改动文件清单

- `software/khyquant/frontend/src/__tests__/markdown.test.js`（新增）
- `software/khyquant/frontend/src/__tests__/useChannelHealth.test.js`（新增）
- `software/khyquant/frontend/src/__tests__/useStreamChat.test.js`（新增）
- `software/khyquant/frontend/src/__tests__/errorMessage.test.js`（新增）
- `software/khyquant/frontend/src/__tests__/arrayGuards.test.js`（新增）
- `software/khyquant/frontend/src/__tests__/localEncrypt.test.js`（新增）
- `software/khyquant/frontend/src/composables/useChannelHealth.js`（修 bug：订阅移出 onMounted）
- `services/backend/src/services/gateway/adapters/cliToolAdapter.js`（修 bug：补 3 处 `_safeOnChunk` 本地作用域 + 两处空 catch 补注释）
- `services/backend/tests/promptOnDemandSections.test.js`（修 @rot：assert 导入 + 37 处断言反模式 + 2 个新胶囊 id）
- `services/backend/tests/gatewayAdapters.stability.test.js`（回归测试对齐 + eslint 修 1 处未用形参）
- `tests/DEBT.md`（新增 §七 夜班组值回收记录）

> 所有改动留在工作区，**未 commit、未 push**。未改 `constants/serviceDefaults.js`、未碰版本 6 源、未放宽任何既有测试基线。
