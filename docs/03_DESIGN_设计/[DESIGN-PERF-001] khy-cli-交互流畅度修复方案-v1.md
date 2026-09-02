# [DESIGN-PERF-001] khy-cli 交互流畅度修复方案 v1

> **状态**: 定稿
> **适用层**: `services/backend`(khy-cli 入口)
> **对位基线**: CommandCode(`command-code@1.38.2`,esbuild minified 单文件)
> **调研日期**: 2026-08-31
> **本文作者准则**: 调研结论有代码证据,方案阶段产物是「可实施计划 + 验收指标」,不是修代码本身。**不动现状代码 / 不动测试 / 不动配置**。

---

## 一、问题陈述

### 1.1 症状

用户感知:**khy CLI 不如 CommandCode 流畅、能干活**。
具体表现:① `khy` 启动到能打字的等待明显长于 `cmd`;② 输入提示词后到模型开始响应("首 token")的等待明显长;③ 长回答末期打字/翻看有可见卡顿。

### 1.2 不做什么

- **不砍功能**:khy 既有能力(quant / bridge / skills / 自愈 / 信任 / 多面板 / 中文叙述层)都是产品决策保留的,不在本期范围。
- **不重写架构**:不重写 AI 网关 / tool 沙箱 / 多面板 TUI / 源码工作流。
- **不改 UI / 视觉**:不做任何 TUI 视觉改动。

---

## 二、调研校正(与初步诊断的差异)

> 这次调研直接读了真实代码,校正了之前凭总结推断的几处结论。**所有校正都有文件路径+行号证据**。

| # | 之前推断 | 实际状态 | 证据 |
|---|---|---|---|
| 1 | "bridgeServer 启动期阻塞 REPL" | **不阻塞,已在 setImmediate** | `services/backend/src/cli/replSession.js:416` `setImmediate(() => require('../bridge/bridgeServer').startBridgeServer())` |
| 2 | "toolUseLoop 启动期被同步 require,阻塞首 paint" | **不阻塞首 paint,已在 setImmediate 预热** | `replSession.js:320-324` `setImmediate(() => { require('../services/toolUseLoop'); })` |
| 3 | "KHY_BRIDGE_AUTOSTART 默认 on" | **默认 off**(`bin/khy.js:70` 在 `KHY_FAST_STARTUP=1` 路径里设 `?? '0'`;实际生产 KHY_FAST_STARTUP=0 未设,但 `replSession.js:405-410` 的判定 `?? ''` 会让 `process.env.KHY_BRIDGE_AUTOSTART` 未设 → 不进入 autostart)|`replSession.js:405-410` `[0,false,no,off].includes(... ?? '')`;当未设 → 不在表里 → `bridgeOptOut=true` → 跳过 |
| 4 | "KHY_SOURCE_HEAL 默认 on,每次启动跑 SHA-256" | **已可关**(`bin/khy.js:71` 同样机制) | 同上 |
| 5 | "App.jsx 要 babel 转译" | **不需要**,inkRuntime 用 `require.extensions['.jsx'] = require.extensions['.js']` 直接当 CJS 加载,所有组件用 `React.createElement` 写 | `src/cli/tui/inkRuntime.js:47-54` |
| 6 | "useTextInput 跑 6+ 分类器" | **没有**,只 require `backslashContinuation` + `Cursor` + `historyPersist` 三个轻叶子 | `src/cli/tui/hooks/useTextInput.js:17-22` |
| 7 | "useQueryBridge 同步 require 全部" | **已基本 lazy**:14 个 try/catch + _keyFindings/_degenerateShellEcho/_rewindControl 全部 try require;`_staticItemsMemo`/`footerStability`/`turnStats` 已用 | `src/cli/tui/hooks/useQueryBridge.js:1-79` |
| 8 | "khyquant 每次启动派生 server.js" | **仅 khyquant 子命令派生**,khy 命令不进 `bin/khy.js:1140-1183` 路径 | `bin/khy.js:1130-1183` 在 `if (parsed.command === 'khyquant')` 块内 |
| 9 | "toolUseLoopCore 13,083 行" | **12,715 行**(实际值) | `Get-Content src/services/toolUseLoopCore.js | Measure-Object -Line` |
| 10 | "replSession.js 14,124 行" | **13,589 行** | `Get-Content src/cli/replSession.js | Measure-Object -Line` |

### 2.1 真正残留的卡点(本次调研的硬结论)

#### 卡点 A · `replSession.js` 顶层 require 风暴(冷启最大单点)

**事实**: `src/cli/replSession.js` 顶层 `const ... = require(...)` 共 **约 50 处**(line 9-210),覆盖:

```
'./toolDisplayPolicy'              'repl/imageIntent'
'./repl/history'                   'repl/imageRecognitionIntent'
'./repl/khySettings'               'repl/terminalTitle'
'./repl/inputClassifiers'          'bulkLines'
'./repl/busyInputClassifiers'      'escapeTimeoutDetector'
'./repl/busyTopicShift'            'featureCapabilityMap'
'./repl/busyInterruptEscalation'   'lineBuffer'
'./repl/statusLabels'              'repl/atPicker'
'./repl/streamRender'              'repl/errorReporting'
'./repl/toolOutputRender'          'repl/footerLayout'
'./repl/startup'                   'repl/slashCommandFilter'
'./repl/tasksCommand'(通过 _handleTasksCommand lazy) 'statusMessageFormatter'
'streamingMarkdown'                'toolResultVoice'
'renderDedup'(try/Or)              'tryOr'
'simpleTokenEstimate'
... + 'configGuard' / 'safeReadJsonSync' / 'package.json'
```

这些叶子大部分是**渲染管线**(`toolDisplayPolicy` / `streamingMarkdown` / `toolResultVoice` / `featureCapabilityMap` / `lineBuffer` / `statusMessageFormatter` / `bulkLines` / `escapeTimeoutDetector`),**用户在打字阶段不需要它们**——但 `replSession.js` 是 `startRepl` 的宿主,任何进入 REPL 的路径(包括 TUI 路径)都会先 require 它。

**影响**: parse + compile 13,589 行 + 它的 50 个 transitive require 是冷启最大单点贡献。CommandCode 这层是单一 bundle(0.5MB),khy 是裸 CJS 图。

**证据**:

- 文件长度: `services/backend/src/cli/replSession.js` 13,589 行
- 顶层 require 计数: `grep -c "^const.*require" services/backend/src/cli/replSession.js | head -210` = **~50 个本地模块**
- 同类卡点(`App.js`): 顶层 require 30+ React 组件(`WelcomeBanner` / `Transcript` / `StreamingBlock` / `KhyOsView` / `PlanApproval` / `Spinner` / `ProgressBar` / `CompactionProgress` / `CompletionMenu` / `HelpMenu` / `ShellView` / `TranscriptView` / `TaskListPanel` / `TopologyPanel` / `SidebarPanel` 等),5125 行

#### 卡点 B · `toolUseLoopCore.js` 13k 行单文件(首 token 最大单点)

**事实**: `src/services/toolUseLoopCore.js` 12,715 行,`runToolUseLoop`(`toolUseLoopCore.js:2376`)单函数就 ~800 行,串行 10+ 阶段。

**已知结构(用户自述)**: preflight → budget → classify → generate → stream intercept → 重试 → ...
**已知 lazy 触发**: `replSession.js:320-324` 已在 setImmediate 预热 `toolUseLoop`,但**预热在启动期**——用户敲 Enter 那刻仍未必完成(取决于打字速度)。

**影响**: 用户提交 → `useQueryBridge.runQuery()` → 同步 require `toolUseLoop` → 12,715 行 parse → `runToolUseLoop` 入口 → 预热未完成则再次 12,715 行 parse(命中 cache 后零开销,但首次一定冷)。CommandCode 用 Vercel AI SDK `streamText` 直调,**没有自己的 loop**,首 token 是 SDK 自带的 <1s。

**证据**:

- `toolUseLoopCore.js:2376` `async function runToolUseLoop(userMessage, options = {})`
- 文件长度: 12,715 行
- `toolUseLoop.js` 是 facade(13 行),实际干活在 `toolUseLoopCore.js`

#### 卡点 C · `bootstrapInit` 串行 await 阻塞 REPL 入口

**事实**: `bin/khy.js:1370-1374` `await _initPromise`(`bootstrapInit`)。`src/bootstrap/init.js`:
- line 56 `require('dotenv').config(...)` 同步 IO
- line 77 同上,~/.khy/.env 同步 IO
- line 88-91 `expandEnvPlaceholders` 同步正则扫所有 env
- line 96-154 `Promise.allSettled([5 个非关键 init])` **并行**(已优化过)
- line 167-189 `_initDbHealth` 默认 `KHY_DB_HEALTH_DEFER=1` → 后台跑

5 路并行已优化过(`init.js:94-95` 注释自述「并行 -200-500ms」),剩阻塞项就是 dotenv 同步 IO × 2 + ensureProxyCoreEnv/ensureJwtSecret/proxyConfigService.initFromConfig/appRegistry.autoRegisterDev/dynamicFreeModelService.warmUp(并行但其中部分内部有 await)。

**影响**: 进 REPL 前必等 100-400ms 串行 + 5 路并行的 max 时间。CommandCode **没有这层**(用户级 ~/.khy/.env 由 SDK 自己读,跨进程无关)。

**证据**: `bin/khy.js:1368-1375`, `bootstrap/init.js:48-194`

#### 卡点 D · `ensureAuthenticated` 阻塞主路径

**事实**: `bin/khy.js:687+` 是主路径同步 await,fast path 只判 `auth.checkSession()`,slow path 要:
- `require('inquirer')`(`bin/khy.js:702`)—— inquirer 是重依赖
- `require('picocolors')` × 2
- `require('../src/cli/formatters')`
- `require('../src/services/cliAuthService')`
- `await isPortReady(PORT, 400)`(`bin/khy.js:714`)—— TCP 探测
- 失败再走 inquirer 提问 / 邮箱验证码 / 凭据生成

**影响**: 已登录用户进 REPL 必须多付一次 `isPortReady` 的 0-400ms + auth 模块图的冷加载。CommandCode 没有本地 server,认证是云端 SDK 直调,**没有这层**。

**证据**: `bin/khy.js:687-700`、`bin/khy.js:1130-1138`

#### 卡点 E · `workspaceTrust` 等待同步 inquirer(仅未信任目录)

**事实**: `replSession.js:450-467` `await promptOutputGuard.runExclusive(() => trustGate.ensureWorkspaceTrust(...))`。如果 `services/workspaceTrust.js` 已记该目录为 trusted,fast path 直接返回 `{ trusted:true }`;未信任才弹 inquirer。

**影响**: 已 trust 用户 0ms;新目录每次进 1 次 inquirer,阻塞 <500ms。这是 fail-open 设计(`trustGate.js:19-22`),不是 bug,但首次新项目会感知。

**证据**: `replSession.js:450-467`, `trustGate.js:64-79`(持久存储 `dataHome/trusted-folders.json`)

#### 卡点 F · StreamingBlock O(n²) 实时归一(长回答末期掉帧)

**事实**: `src/cli/tui/ink-components/StreamingBlock.js:58-65` 注释自承:「re-normalizes EVERY text segment of the whole accumulated timeline on every frame (~25fps). All but the single growing segment are frozen → O(n²)/turn of pure waste」。
**已知 mitigation**: `streamNormCache`(`StreamingBlock.js:66`)是 content-keyed memo,frozen segment 命中 cache,只 growing segment 重算 → O(n²)→O(n)/turn。

**影响**: 5000 字长回答末期,即便有 memo,`toolEntryRows` / `liveHeightClamp` / `liveRegionBudget` 仍要扫所有工具行。CommandCode 没有"工具 tier 矩阵"和"liveHeightClamp"概念,直接 stream text → ink 渲染。

**证据**: `StreamingBlock.js:36-73`、`toolEntryRows.js`(顶层 require 进 hot path)

#### 卡点 G · 既有 4 道叙述层每次提交都触发 React 重渲染

**事实**(`flagRegistry.js` + 各 voice 叶子):
- `KHY_FIRST_RESPONSE_ACK`(`flagRegistry.js:1974`)默认 on,延迟 1200ms 出占位句
- `KHY_TURN_ACK`(`flagRegistry.js:1956`)默认 on,首个工具派发前出
- `KHY_TOOL_PREFACE_NATURAL_VOICE`(`flagRegistry.js:1931`)默认 on,每工具前
- `KHY_TOOL_PREFACE_DEDUP`(`flagRegistry.js:1825`)默认 on,连续同类工具去重

**已知上下文**(来自每个 voice 叶子的注释): 这是用户**历史 /goal 反馈要的功能**——「当我向 Khy 输入提示词时,khy 要及时回应」(2026-07-12)、「khy 收到输入后...在代码级先甩一句确定性短句回应,再继续干活」(2026-07-05)。

**影响**: 每提交一次:1 个 React setState(firstResponseAck timer arm) → 1 个 setState(turnAck 命中) → 多个 setState(toolPreface 每工具前) → 每个触发 StreamingBlock re-render。**主观"丝滑感"被这些 setState 拖慢**。

**关键判断**:**这是用户要求的功能,不能关掉**。优化方向是减少 setState 而非取消触发(详见方案 D)。

---

## 三、修复方案(3 阶段,4 周)

> 三个阶段为同一流水线:每一步为下一步铺路。每步都有**显式 env 回退**,源码路径 100% 不动。

### 阶段 B · 启用 `KHY_FAST_STARTUP` 作为正式默认(0.5 天)

**目标**: 把已经存在的 `bin/khy.js:69-73` `KHY_FAST_STARTUP=1` 机制**翻成默认**——它已经会关 `KHY_BRIDGE_AUTOSTART` + `KHY_SOURCE_HEAL` + `KHY_TASK_CLEANUP`。今天默认是 0(关),改成"不显式设 = 等同 1"。

**改动点**:
- `services/backend/bin/khy.js:69` 把 `if (process.env.KHY_FAST_STARTUP === '1')` 改成 `if (process.env.KHY_FAST_STARTUP !== '0')`(默认走 fast 路径,显式 `KHY_FAST_STARTUP=0` 走 legacy)
- `services/backend/bin/khy.js:70-73` 行为不变(默认关这三项副作用)

**不动**:
- 4 道叙述层(KHY_FIRST_RESPONSE_ACK / KHY_TURN_ACK / KHY_TOOL_PREFACE_*):用户历史反馈要的功能,本期不砍
- workspaceTrust:fail-open 设计保留
- `bootstrapInit` 串行 await:留给阶段 C 单独处理

**风险**: 极低。env var 翻 default,显式 `=0` 老用户一行恢复。CHANGELOG 明示。

**预期收益**:
- 启动砍掉 bridgeServer setImmediate(虽不阻塞,但减 CPU 抖动 ~0.4s)
- 启动砍掉 sourceHealService SHA-256 比对(冷时 ~50-200ms,稳态 ~1ms)
- 启动砍掉 taskCleanupService 清理(后台跑但抢 CPU)
- 净:**主观启动快 200-600ms**(取决于机器 + git 状态)

**回退**: `KHY_FAST_STARTUP=0 khy`

### 阶段 A · Bundle 启动 CLI(对位 CommandCode)(5-7 天)

**目标**: 复用现有 `services/backend/esbuild.config.js`(已就位但未启用,产出 `dist/khy.cjs/mjs/cli.cjs`),新增 **CLI 专用 minified mjs bundle**,首启从 2-3s → 500ms,后续启 600-1200ms → 250ms。

**改动点**:

1. `services/backend/esbuild.config.js` 在 `configs[]` 末尾追加:

```js
{
  ...sharedOptions,
  entryPoints: ['bin/khy.js'],
  outfile: 'dist/cli.mjs',
  format: 'esm',
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,   // ← esbuild.config.js:81 现状 false → true
  minifySyntax: true,
  banner: { js: `#!/usr/bin/env node\n${banner}` },
  // critical externals:bundle 内 ESM 动态 import('ink') 会丢 — 必须把 ink 留 external
  external: [...externalDeps, 'ink', 'react', 'better-sqlite3', 'bindings'],
  define: {
    ...sharedOptions.define,
    'process.env.KHY_BUNDLED_CLI': '"true"',
  },
}
```

2. **JSX 不需要单独配置**(实测 `inkRuntime.js:47-54` 已用 `require.extensions['.jsx'] = require.extensions['.js']`,组件全 `React.createElement`),esbuild 不需要 babel。但 esbuild 默认把 `.jsx` 当 JS 处理——校验一下 esbuild v0.25 默认 loader,可能要显式 `loader: { '.jsx': 'js' }`。

3. `services/backend/bin/khy.js` 顶部(line 50 前)插入 bundle 检测:

```js
// Fast path: prefer the minified bundle when present (production-like install).
// KHY_NO_BUNDLE=1 forces the source path (used by test:backend + dev workflows).
const _BUNDLE_PATH = path.join(__dirname, '..', 'dist', 'cli.mjs');
if (!process.env.KHY_NO_BUNDLE && fs.existsSync(_BUNDLE_PATH)) {
  // eslint-disable-next-line no-undef
  import(url.pathToFileURL(_BUNDLE_PATH).href).then(() => {}).catch((e) => {
    process.stderr.write(`cli.mjs load failed: ${e.message}; falling back to source.\n`);
  });
}
```

注: 上面是**示意代码结构**,实际插入位置需读 `bin/khy.js:1-100` 后决定——切勿在读之前改。

4. `package.json` 加 `portable:build:cli-bundle` 任务入口,产出命令独立于现有 `portable:build:*`,不替换原任务。

**风险**:

| 风险 | 缓解 |
|---|---|
| `require.cache` 访问点断裂 | bundle 内无 require.cache 概念,审计 `sourceHealService` / `toolLoopDetector` / sqlite init 路径,改成模块级单例 |
| ESM 内 `__dirname` / `__filename` 是 undefined | 逐文件 audit,改 `import.meta.url` + `fileURLToPath` |
| ink 走 `import('ink')` 动态 ESM 桥 | esbuild 不会模拟动态 ESM,必须 external `ink`/`react`;bundle 里这段保留原 import 语法 |
| better-sqlite3 native | 已走 external,preinstall 链接保留 |
| `moduleSelfHeal` hook Module._resolveFilename | bundle 后 hook 失效,在 `KHY_BUNDLED_CLI=true` 时 skip |
| `windowsSpawnHardening` hook child_process | bundle 后 hook 仍生效(走 require.cache 的 patch)——但 spawn 函数本身在 child_process,改 hook 装入点 |

**不动**:
- 既有 esbuild.config.js 的 3 个现有产物(`khy.cjs/mjs/cli.cjs`):保留,新加 CLI bundle 不动它们
- 源码路径 100%: `KHY_NO_BUNDLE=1` 走 `bin/khy.js` 原始代码,所有 `test:backend` 跑源码路径

**预期收益**:
- 冷启: 2-3s → **500ms**(对位 cmdc 300ms)
- 热启: 600-1200ms → **250ms**(对位 cmdc 150ms)
- bundle 大小目标: <8MB(cmb ~5MB)

**回退**: `KHY_NO_BUNDLE=1 khy`,或删除 `dist/cli.mjs`

### 阶段 C · `replSession.js` 顶层 require 瘦身(3-5 天)

**目标**: `replSession.js:9-210` 的 50 个顶层 require 中,**30+ 是渲染管线叶子**(用户打字阶段不需要),改成**调用时才 require 的 lazy getter**。

**改动点**:

1. `src/cli/replSession.js:9-210` 拆分两段:

   - **保留顶层**(真的启动期就要的):
     - `safeReadJsonSync` / `foldOutput` / `KHY_SETTINGS_FILE` / `HISTORY_FILE` / `inputClassifiers` / `featureCapabilityMap` / `lineBuffer` / `backslashContinuation`
     - 这些是 UI 装饰、REPL 协议层,启动期就要评估
   - **移到 lazy getter**(`function _lazyToolDisplay() { return _toolDisplay ??= require('./toolDisplayPolicy'); }` 模式):
     - `toolDisplayPolicy` / `streamingMarkdown` / `toolResultVoice` / `statusMessageFormatter` / `bulkLines` / `escapeTimeoutDetector` / `toolOutputRender` / `streamRender` / `errorReporting` / `footerLayout` / `slashCommandFilter` / `startup` / `atPicker` / `imageIntent` / `imageRecognitionIntent` / `terminalTitle` / `renderDedup` / `taskMindMap` / `taskCleanupService` / `sessionChecklistResetService` / `sourceHealService` / `workspaceGitInit` / `geolocationService` / `gitContextService` / `intentAssuranceDebugSnapshot` / `PASTED_CONTENT_BLOCK_RE` / `summarizeQueuedInputForDisplay` / `phaseActionLabel` / `extractPlanStepsFromText` 等

2. 同步瘦身 `App.js:11-60` 的 30+ 顶层 require(模式相同)

3. 既有 `_tryOr`(`replSession.js:94`)和 `vimInput()`(`replSession.js:56`)的 lazy getter 模式已经成熟,**铺开即可**。

**风险**:

| 风险 | 缓解 |
|---|---|
| 顺序依赖:`flagRegistry` import 时注册 self,某些叶子 import 时副作用不可逆 | 跑 `test:backend` 验证;`grep -l "onRequire\|module.exports =" src/cli/repl/*.js` 审副作用 |
| `permissionDialog` 通过 `require('./ui/permissionDialog')` 在 `replSession.js:15` self-register 到 permissionPromptPort | lazy 后要在 `startRepl` 第一行显式 `permissionDialog.register()`,不动语义 |

**预期收益**:
- 不走 bundle 的源码路径:首启 -30-50%,从 2-3s → 1-1.5s
- 走 bundle 的路径:收益已被阶段 A 覆盖,本阶段主要是兜底

**回退**: 单文件 revert;`flagRegistry.js` 仍有所有门控,无需新加 env

### 阶段 D · 首 token 解耦(7-10 天,与阶段 A 并行)

**目标**: 用户 `Enter` → 100ms 内 UI 进入 streaming 态(显示占位 spinner) → 1s 内首字符出现。CommandCode 同体感 <1s。

**改动点**:

1. `useQueryBridge.runQuery()`(`hooks/useQueryBridge.js`)首屏行为:
   - 把 `toolUseLoop` / `toolUseLoopCore` 的 require 改**异步**:`await import(...)`(CJS 不可用 dynamic import,改 `require(...)` 包一层 `Promise.resolve()`)
   - 首 render 时立刻显示"提交中"占位

2. `runToolUseLoop`(`toolUseLoopCore.js:2376`)两段式:
   - **emit preamble 立即返回**(已有部分 streaming 状态可显示):`resolveStream({ type: 'placeholder' })`
   - 后台跑 preflight → budget → classify → generate
   - 首个 chunk 到达时无缝接管(已有 onChunk 链路)

3. `useTextInput` 已有良好结构,本阶段**不做分类器瘦身**(实测只有 3 个轻 require,不卡)。

4. `firstResponseAckVoice` / `turnAckVoice` / `toolPrefaceVoice` 不动 default,但**优化 emit 链路**:
   - 现在的实现是 `setState` → React re-render StreamingBlock
   - 改成 `setState` → 标记"已 ack" → 下次 streaming commit 时一次性 render,避免连续 setState 触发多次 render

5. `prefetch 窗口`(`replSession.js:308-339` 已有的 setImmediate 预热)升级:
   - 启动期:setImmediate 预热已有
   - **打字期**: `useTextInput` 检测到 `length >= 3 && 距上次按键 <500ms` 时,**在后台预热**(不阻塞 React)
   - 检测 `setImmediate 队列里已存在 prewarm` → 跳过

**风险**:

| 风险 | 缓解 |
|---|---|
| 占位 UI 闪烁 | 浅灰"…"行 + key={placeholderId} 强制 React 不复用 |
| 预热抢 CPU,反而拖慢打字 | typing-time prefetch 限流,不在启动期抢 |
| `runToolUseLoop` 两段式破坏现有 10+ 阶段的 invariant | 阶段内不重排,只在入口加 preamble emit;后续阶段保持原序 |

**不动**:
- `toolUseLoopCore.js` 10+ 阶段顺序(那是业务逻辑)
- 4 道叙述层 default(`firstResponseAckVoice` 等)
- ack voice 的语义 / 文案

**预期收益**:
- 首 token 时间: 2-5s → **<1.5s**(对位 cmdc <1s)
- 按键延迟: p95 30-50ms → <30ms(实测 `useTextInput` 已无重分类器,主要是 React commit)

**回退**: `KHY_NO_PREFETCH=1`(新增 env,在 `replSession.js` 打字期 prefetch 处判定)走纯 lazy

---

## 四、阶段产物汇总

| 阶段 | 周 | 改动文件数 | 新增文件 | 关键文件 | 风险 |
|---|---|---|---|---|---|
| **B** | 0.5 天 | 1 | 0 | `bin/khy.js:69-73` | 极低 |
| **A** | 5-7 天 | 2 | 1 (`dist/cli.mjs` 产物) | `esbuild.config.js` 新增 1 个 config;`bin/khy.js` 顶部插 3 行 | 中(ESM 桥 + native) |
| **C** | 3-5 天 | 2 | 0 | `src/cli/replSession.js` + `src/cli/tui/ink-components/App.js` 拆分顶层 require | 中(顺序依赖 audit) |
| **D** | 7-10 天 | 3-4 | 0-1 | `useQueryBridge.js` / `toolUseLoopCore.js` 入口 / `useTextInput.js` 打字期 prefetch | 中(React commit / 占位闪烁) |

合计 **4 周**拿到 **3 个数据维度**全面对位 cmdc。

---

## 五、验收指标

### 5.1 性能指标

| 指标 | 现值(基线) | 阶段 B 后 | 阶段 A 后 | 阶段 D 后 | cmdc 对位 |
|---|---|---|---|---|---|
| 冷启 p50 | 2-3s | ~2-2.5s | **<500ms** | <500ms | ~300ms |
| 热启 p50 | 600-1200ms | ~500-1000ms | **<250ms** | <250ms | ~150ms |
| 首屏 → 可输入 | ~800ms+ | ~600ms | **<600ms** | <600ms | ~400ms |
| 首 token p50 | 2-5s | 2-5s | 2-5s | **<1.5s** | <1s |
| 按键延迟 p95 | 30-50ms | 30-50ms | 30-50ms | **<30ms** | <20ms |

### 5.2 质量指标

- `npm run test:backend` 全过(走 `KHY_NO_BUNDLE=1`)
- `npm run check:structure` 全过(不破坏 layer 约束)
- `npm run check:agent-rules` 全过(不动 agent rules)
- bundle 文件大小 <8MB
- 长回答末期(>3000 字)帧率 ≥30fps(用 ink dev mode 实测)

### 5.3 行为指标

- 用户显式 `KHY_FAST_STARTUP=0` → 完全等价于改动前的行为(字节级)
- 用户显式 `KHY_NO_BUNDLE=1` → 完全等价于改动前的行为(走源码)
- 4 道叙述层 default 不动(用户历史 /goal 反馈要的功能)
- bridgeServer / sourceHeal / taskCleanup 默认 off(走 `KHY_FAST_STARTUP=1`),但显式 env 可恢复

---

## 六、不做什么(明确范围外)

- **不重写 AI 网关**(10 个 adapter 是产品价值)
- **不砍 tool 沙箱**(8 道闸门对安全和审计有价值)
- **不重写 toolUseLoopCore 的 10+ 阶段顺序**(业务逻辑)
- **不关 ack voice 4 道**(用户历史 /goal 要的功能)
- **不做 TUI 视觉改动**(用户没抱怨视觉)
- **不做 streaming 增量重写**(StreamingBlock 已 O(n²)→O(n) 经 streamNormCache 优化;边际收益低于 bundle)

---

## 七、未来扩展(本期不做)

1. **streaming 增量 RLE renderer**(O(n) → O(Δ)): 边际收益低于 bundle,留给 V2
2. **App.js 拆包**(从 5125 行 → ~200 行 App + 多个 component 文件): 与阶段 C 同步做收益更大,但需更大改动,留 V2
3. **WebView UI 替代 Ink**(对位 Aider / Cursor): 架构级改动,本期范围外
4. **prefetch 升级到 service worker**: 跨进程加速,留 V2

---

## 八、附:已存在的可用基础设施

调研发现 khy 已有相当一部分基础设施,本方案只是**翻开关 + 接通**:

| 已有基建 | 位置 | 用途 |
|---|---|---|
| `KHY_FAST_STARTUP=1` | `bin/khy.js:69-73` | 已会关 bridge/sourceHeal/taskCleanup;本方案只翻 default |
| `enableCompileCache()` | `bin/khy.js:53` | V8 bytecode 缓存已开,后续启动自动受益 |
| `windowsSpawnHardening` | `bin/khy.js:60` | win32 spawn 已默认 hide=true,黑框/慢启动已治 |
| `KHY_DB_HEALTH_DEFER=1` 默认 | `bootstrap/init.js:164` | DB health 检查已后台跑,不阻塞 |
| `moduleSelfHeal` | `bin/khy.js:66` | Module._resolveFilename hook 已装,require 路径错自愈 |
| `Promise.allSettled` 5 路并行 | `bootstrap/init.js:96-154` | init 5 个非关键步骤已并行 -200-500ms |
| `streamNormCache` | `StreamingBlock.js:66` | 长回答 O(n²)→O(n) 已治,只剩边际成本 |
| `scrollbackPreserve` | `tui/app.js:102-119` | 三层:剥 3J / win32 ED2→ED0 / 全屏帧整段转录重发抑制(`KHY_SUPPRESS_STATIC_REPRINT`,ink.js:327 冗余 fullStaticOutput 剥离,「启动后历史重复几次」根治) |
| `perfEntryReaper` | `tui/app.js:35-37` | React dev mode performance.measure 累积已清 |
| `dynamicFreeModelService.warmUp()` | `bootstrap/init.js:148-152` | 免费模型表已后台预热 |
| `prewarmGitContext` | `replSession.js:308-314` | git context 已后台预热 |
| `prewarm(['claude','codex','aider'])` | `replSession.js:298-301` | CLI availability 已后台预热 |
| `setImmediate(()=>require('toolUseLoop'))` | `replSession.js:320-324` | toolUseLoop 12k 行预热已有(阶段 D 升级为打字期 prefetch) |
| `setImmediate(()=>require('bridgeServer'))` | `replSession.js:416-434` | bridgeServer 已在后台启动,不阻塞 REPL |
| `setImmediate(()=>require('sourceHealService'))` | `replSession.js:571-588` | sourceHeal 已后台跑,稳态 ~1ms |
| `flagRegistry.js` 1500+ env 门 | `services/flagRegistry.js` | 单一真源,所有 default 翻动都经它,加 env var 1 行 |

**结论**: khy 没有"功能缺失",是**默认值不够激进** + **顶层 require 不够窄** + **首次提交路径没有占位流**。本次方案是把这三件事修掉,**不动架构**。

---

## 九、变更记录

| 版本 | 日期 | 作者 | 变更 |
|---|---|---|---|
| v1 | 2026-08-31 | 调研产出 | 初稿,基于代码调研校正 + 4 周 3 阶段方案 |