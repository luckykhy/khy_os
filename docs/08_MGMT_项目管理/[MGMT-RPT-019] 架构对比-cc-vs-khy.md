<!-- 文档分类: MGMT-RPT-019 | 阶段: 项目管理 | 原路径: docs/架构/架构对比-cc-vs-khy.md -->
# Claude Code vs KHY OS：架构深度对比

> 生成日期：2026-06-04 | CC 源码：Claude-Code-main（最新开源版本）| KHY：v0.1.98

> ⚠️ **勘误（2026-07-08 核出，本文成文于 v0.1.98，其后 khy 已迭代，以下以当前源码为准）**：
> 1. **TUI 已切官方 `ink` 包**，经 CJS 桥接层 `src/cli/tui/inkRuntime.js` 加载；旧的**自研 Flux store /
>    VirtualScreen 已移除**（下表「UI 框架」一行的 khy 侧描述已过期）。
> 2. **queryEngine 的 V2 状态机已删除**（`queryEngine.js:14-21`）；当前是 legacy loop + 可选 agentic
>    harness 双路，底层统一委托 `toolUseLoop.js`。`KHY_QUERY_ENGINE_V2` 已废弃无效。
> 3. **全仓仅一个 `KHY_DEFER_TOOLS` defer 门**（`tools/index.js:38`），不存在复数 defer 门族。
> 4. **后台任务已落地**：`khy tasks run`（每任务一个分离子进程 `scripts/task-runner.js`，关掉 REPL 也存活），
>    见 `backgroundTaskSpec.js`/`backgroundTaskLauncher.js`。
> 5. **执行治理守卫是 7 个** `scripts/check-*.js`（leaf-contract / agent-rules / change-safety /
>    flag-registry / lifecycle-policy / model-hardcoding / tool-contract），不止「三守卫」。
> 6. **工具面按角色裁剪** `toolProfile` 的 profile 为 `minimal/coding/analysis/verification`；"Explore" 是
>    **Agent 角色名**（映射到 minimal profile），非独立 profile。
>
> 想看按当前源码组织的架构导览，见 **[`[DESIGN-ARCH-063]` 对照《Claude Code 架构》一书读懂 Khy-OS](../03_DESIGN_设计/%5BDESIGN-ARCH-063%5D%20对照《Claude%20Code%20架构》一书读懂%20Khy-OS.md)**。本文保留作历史对比快照。

---

## 1. 顶层架构对比

| 维度 | Claude Code | KHY OS |
|------|------------|--------|
| 语言 | TypeScript（Bun 运行时）| JavaScript（Node.js）|
| 范式 | 单供应商单体应用 | 多供应商平台 |
| AI 后端 | 仅 Anthropic API | 14+ 适配器级联（Claude/Codex/Cursor/Kiro/Trae/Windsurf/Ollama/Relay...）|
| UI 框架 | 魔改版 Ink（终端 React）| 自研 Flux store + VirtualScreen / InlineRenderer |
| 工具系统 | 静态类型注册表（Zod schema）| 自动发现注册表（约定式加载）|
| Agent 模型 | 单父进程 + 派生子 agent | 层次化：cliAgentRunner（多角色）+ workerAgent（进程级）+ subAgentOrchestrator |
| 入口 | 单二进制（`claude`）| 双二进制（`khy` 轻量 / `khyquant` 全栈）|
| 扩展模型 | MCP + Skills + Hooks + Plugins（DXT）| MCP + CLI 插件 + handler 模块 |
| 配置系统 | 分层 Zod 校验（MDM/remote/managed/enterprise/project/user）| Dotenv + settings.json（user/project 两级）|
| 状态管理 | 全局可变单例（`bootstrap/state.ts`）+ React state | Flux store（replStore）+ 模块级单例 |

---

## 2. 入口与启动

### Claude Code
```
cli.tsx (快速路径: --version/--dump)
  -> init() [memoized，一次性：env、proxy、telemetry、repo 检测]
    -> main.tsx [commander 解析]
      -> launchRepl() | headless QueryEngine
```
- **冷启动策略**：快速路径在重型 import 之前退出；MDM/keychain 预取在 import 阶段并行启动。
- **进程模型**：单进程、单会话。

### KHY OS
```
bin/khy.js [双二进制路由: khy vs khyquant]
  -> bootstrap/init.js [dotenv, env, proxy, CA, shutdown]
    -> bootstrap/setup.js [DB, migrations — khy 模式跳过]
      -> cli/repl.js -> tui/tuiShell.js | 传统 readline
```
- **冷启动策略**：fire-and-forget `_initPromise`；全局懒加载 `require()`。
- **进程模型**：单进程，但支持 daemon 模式、bridge 服务器（移动协作）和 worker 进程（coordinator）。

### 关键差异
- CC 使用 Bun 打包器 tree-shaking + `feature()` 门控做死代码消除；KHY 依赖运行时 `require()` 懒加载。
- CC 无数据库依赖；KHY（khyquant 模式）需要 DB 迁移。
- KHY 有双重身份入口（平台 OS vs 量化应用）；CC 纯粹是 AI 编码助手。

---

## 3. Agent 循环（核心差异点）

### Claude Code：异步生成器循环
```typescript
// 简化版: query.ts
async function* query(messages, options): AsyncGenerator<StreamEvent | Message, Terminal> {
  while (true) {
    const response = await callAPI(messages);
    yield* streamResponse(response);

    const toolUses = extractToolUses(response);
    if (toolUses.length === 0) return { type: 'end_turn' };

    const results = await runTools(toolUses); // 只读工具并行，写入工具串行
    messages.push(...results);
  }
}
```
- **单一执行路径**（一个 API 供应商，一种循环形态）。
- **工具并发**：分为并发安全（只读，最多 10 并行）和非安全（串行）。
- **恢复策略**：max_output_tokens 升级、413 时响应式压缩。
- **流式输出**：异步生成器 yield 事件 — 消费者（UI 或 SDK）按自身节奏拉取。

### KHY OS：多路径状态机
```javascript
// 简化版: queryEngine.js (V2 路径)
class QueryEngine {
  async *run(prompt) {
    let state = 'NEXT_TURN';
    while (state !== 'DONE') {
      switch (state) {
        case 'NEXT_TURN': state = await this._executeTurn(); break;
        case 'COMPACT_RETRY': state = await this._compact(); break;
        case 'MAX_OUTPUT_RECOVERY': state = await this._escalateTokens(); break;
        case 'MODEL_FALLBACK': state = await this._fallbackModel(); break;
      }
      yield* this._drainEvents();
    }
  }
}
```
- **三条执行路径**逐级回退：V2 状态机 -> harness 托管 -> 传统循环。
- **丰富启发式**：验证 nudge（3+ 次文件写入未测试时提醒）、循环检测（`ToolLoopDetector`）、交付完整性关键词覆盖、529 模型降级。
- **模型降级**：连续 3 次 529 时通过 gateway 级联到更便宜的模型。
- **流式输出**：同为异步生成器，额外加了 `StreamingChunker`（平滑/追赶双档）做 TUI 帧率管理。

### 对比分析
| 方面 | CC | KHY |
|------|----|----|
| 鲁棒性 | 高（单路径，充分测试）| 更高（多回退、模型级联）|
| 复杂度 | 中等（核心循环 ~2K LoC）| 高（含所有路径 ~5K LoC）|
| 供应商锁定 | 仅 Anthropic | 供应商无关 |
| 自我修正 | 压缩 + 重试 | 压缩 + 重试 + 模型降级 + 循环检测 + nudge |
| 工具解析 | 结构化（原生 API tool_use 块）| 双模：结构化（API）+ XML 提取（传统模型）|

---

## 4. 工具系统

### Claude Code
```typescript
interface Tool<Input, Output, Progress> {
  name: string;
  inputSchema: ZodType<Input>;
  call(args: Input, context: ToolUseContext): Promise<ToolResult<Output>>;
  isReadOnly(input: Input): boolean;
  isConcurrencySafe(input: Input): boolean;
  interruptBehavior(): 'cancel' | 'block';
  isEnabled(): boolean;
}
```
- **注册方式**：`tools.ts` 中静态导入，feature 门控。
- **约 30 个工具**：Bash、FileRead/Write/Edit、Glob、Grep、Agent、WebFetch/Search、MCP、Cron、Todo、Notebook、Plan、Worktree、Task、Team、Skill、LSP、Config 等。
- **Schema**：Zod 做校验，JSON Schema 做 API 定义。
- **并发控制**：显式 `isConcurrencySafe()` 分类。

### KHY OS
```javascript
// 约定式加载
// 1. 子目录: tools/FileReadTool/index.js (class BaseTool)
// 2. 扁平文件: tools/shellCommand.js (defineTool() 格式)
// 3. MCP 桥接: 从连接的服务器自动导入

const registry = new Map(); // name -> { execute, definition, profile }
```
- **注册方式**：启动时扫描 `src/tools/` 自动发现。
- **50+ 工具**：CC 全部等价物 + PowerShell、REPL、PDF、OCR、多终端、剪贴板图片、代理工具。
- **Schema**：纯 JSON Schema 对象（无 Zod）。
- **Profile**：`toolProfile.js` 提供按能力过滤（coding/minimal/verification/explorer），每种 agent 角色看到不同工具子集。
- **平台工具**：`platformUtils.js`（28K）处理 Windows/Linux/macOS 跨平台差异。

### 关键差异
- CC 工具**端到端静态类型**（input -> output -> progress）；KHY 使用运行时鸭子类型。
- KHY 有**工具 Profile** — 不同 agent 看到不同工具子集（CC 对所有 agent 暴露全部工具）。
- KHY 有**延迟工具加载**（`KHY_DEFER_TOOLS`）— 根据上下文动态揭示工具。
- CC 的工具执行上下文（`ToolUseContext`）是类型化的包；KHY 传递松散的 options 对象。

---

## 5. TUI / 渲染系统

> ⚠️ **本节已过期**：本节描述的 "KHY OS：自研 Flux Store + 双渲染器"（`tuiShell.js` / `store/replStore.js` / `components/*` 等）已于 2026-06-05 被官方 Ink 运行时（`backend/src/cli/tui/ink-components/`）取代，相关自研文件已删除。本节仅作历史架构对比保留，最新 TUI 实现请参阅 [../修复记录/tui-inquirer闪退修复-2026-06-05.md](../04_IMPL_实现/%5BIMPL-RPT-003%5D%20tui-inquirer闪退修复-2026-06-05.md)。

### Claude Code：魔改 Ink（React）
```
ink.tsx (定制 Ink 运行时, 246K)
  -> reconciler.ts (react-reconciler)
    -> render-node-to-output.ts -> screen.ts -> terminal

hooks/useReplBridge.tsx (113K) — 将 query 循环桥接到 React 状态
```
- 完整 React 组件模型：hooks、refs、state、effects。
- 通过 react-reconciler 做虚拟 DOM diff。
- 丰富的终端特性：虚拟滚动、选择、搜索、双向文本、vim 模式。
- **代价**：运行时体积大（Ink + React 超过 300K），心智模型复杂。

### KHY OS：自研 Flux Store + 双渲染器
```
tuiShell.js (99K, 主循环 + 快捷键)
  -> store/replStore.js (Flux/Redux 模式)
    -> AppShell.js (布局管理器)
      -> VirtualScreen (全屏模式: 双缓冲 + 行级 diff)
      -> InlineRenderer (默认: 静态/动态分离, 单次 stdout.write)
```
- 无 React 依赖 — 命令式渲染 + 脏行追踪。
- **两种渲染模式**：
  - **内联**（默认）：保留原生滚动/选择；已提交块自然滚动，动态区域（提示符）原地重绘。
  - **全屏**（可选）：备用屏幕 + 绝对光标定位。
- **StreamingChunker**：平滑/追赶双档自适应缓冲，管理流式文本帧率。
- **代价**：运行时开销低，但手动状态管理复杂。

### 对比分析
| 方面 | CC（Ink/React）| KHY（自研）|
|------|---------------|-------------|
| 开发体验 | 高（JSX、hooks、组合）| 中等（命令式、手动布局）|
| 运行时体积 | 重（~300K+ 打包后）| 轻（总共 ~120K）|
| 终端兼容性 | 良好（Ink 处理大部分）| 优秀（自定义转义码处理、Windows 兼容）|
| 可扩展性 | 基于组件（容易）| 手动（较难）|
| 滚动/选择 | 自定义虚拟滚动（捕获鼠标）| 原生（内联模式）或自定义（全屏）|
| 帧率 | React reconciler 决定 | 显式帧率上限（流式 120fps，空闲 30fps）|

---

## 6. 权限系统

### Claude Code
```
分层解析：
1. 设置规则 (always-allow / always-deny / always-ask) — 按 MDM/enterprise/project/user 分级
2. 权限模式 (default / auto / bypass)
3. 分类器 (auto 模式下对 bash 命令的推测性安全分析)
4. 交互式 UI 提示 (default 模式)
5. Swarm 委派 (worker 继承父级权限)
```
- 权限是**逐工具、逐输入**的（如只允许 `BashTool` 执行 `npm test`）。
- `yolo-classifier-prompts/` — 基于 LLM 的命令安全分类。
- YOLO 模式（bypass）等同于 KHY 的 bypass。

### KHY OS
```
多层防护：
1. cliAuthService (会话认证: 用户名/密码)
2. authGuard.js (API 密钥校验、速率限制)
3. shellSafetyValidator (命令风险分析: safe/moderate/dangerous)
4. execApproval (交互式权限提示)
5. hookSystem ToolGuards (执行前 hook 可阻断)
6. securityGuardService (AI 处理前的输入消毒)
7. ssrfGuard (URL 校验)
```
- KHY 有**用户认证**（登录/注册/会话）— CC 无（信任本地用户）。
- KHY 的 shell 安全是规则驱动（正则匹配）；CC 使用 LLM 分类。
- KHY 有 SSRF 防护；CC 依赖操作系统级沙箱。

### 关键差异
- CC 的权限模型是**声明式**（设置文件中的规则）；KHY 是**过程式**（校验器函数）。
- CC 支持**企业 MDM 强制执行**；KHY 无 MDM 概念。
- KHY 增加了**认证**（多用户能力）；CC 按设计就是单用户。

---

## 7. 上下文 / 记忆管理

### Claude Code
```
策略（按激进程度排序）：
1. Micro-compact：裁剪最旧消息
2. Auto-compact：摘要 + 替换较旧消息（阈值触发）
3. Session memory compact：压缩时将持久事实提取到 CLAUDE.md
4. Reactive compact：413 错误时压缩并重试
5. Snip：用户手动局部裁剪上下文

记忆持久化：
- CLAUDE.md 文件（project/user 两级）
- 会话记忆自动提取
- 记忆命令 (/memory add/list/remove)
```

### KHY OS
```
策略：
1. contextPruner：token 预算感知的消息修剪
2. compact/sessionMemoryCompact：用结构化摘要完整替换
3. compact/microCompact：增量裁剪最旧消息
4. query/compactPipeline：查询循环中的多阶段渐进压缩
5. Reactive：上下文溢出 (413) 时触发管线

记忆持久化：
- sessionRecapService（后台提取）
- contextCompressor（激进摘要）
- 无等价的 CLAUDE.md 自动记忆系统（依赖 .claude/ 下的外部 MEMORY.md）
```

### 关键差异
- CC 的**会话记忆提取**紧密集成 — 压缩时主动将有用事实保存到磁盘。KHY 的 `sessionRecapService` 是后台进程，集成度较低。
- CC 有 **Snip**（用户手动删除上下文块）；KHY 没有。
- CC 的记忆是**结构化**的（frontmatter + 类型化文件）；KHY 使用扁平 markdown。
- CC 有**团队记忆同步**；KHY 无团队概念。

---

## 8. 多 Agent 架构

### Claude Code
```
层次结构：
1. 主 REPL（父 agent）
2. AgentTool（派生子 agent，fork 上下文，独立工具集）
3. Swarm/Team（TeamCreateTool, InProcessTeammateTask）
   - 队友共享 TaskBoard
   - SendMessage 做 agent 间通信
   - Coordinator 模式（父管理子）

隔离：进程内（共享内存，独立消息历史）
最大深度：可配置，通常 2-3 层
```

### KHY OS
```
层次结构（3 套独立系统）：
1. cliAgentRunner — 多角色分解：
   - 按关键词匹配任务到 20+ 角色模板
   - 最多 3 个并行 agent（200ms 交错启动）
   - 通过最终 AI 调用合成结果

2. coordinator/workerAgent — 进程级隔离：
   - Worker 有结构化输出契约（SUMMARY/CHANGES/EVIDENCE/RISKS/BLOCKERS）
   - 最大深度 3，最多 3 个并发子进程，5 分钟超时
   - Watchdog 资源守卫
   - IPC 协议通信

3. subAgentOrchestrator — 会话 fork：
   - 继承父上下文 + 权限
   - 基于作用域的工具访问
   - 工作区物化（可创建隔离工作目录）

隔离：进程级（workerAgent）或进程内（cliAgentRunner、subAgentOrchestrator）
```

### 关键差异
- CC 的 agent 系统是**统一的**（一个 AgentTool + 一个 Team 系统）；KHY 有**三套独立**编排系统（角色、进程、会话）。
- KHY 的 `workerAgent` 有**结构化输出契约**（强制响应格式）；CC 子 agent 返回自由文本。
- KHY 支持**进程级隔离** + IPC；CC 始终在进程内。
- CC 的 team 系统支持 **agent 间点对点消息**；KHY 严格父子关系。
- KHY 的 `cliAgentRunner` 做**基于关键词的任务分解**（领域角色如"基本面分析师"、"技术分析师"）；CC 的 AgentTool 让 AI 自主决定分解方式。

---

## 9. 网关 / 供应商抽象

### Claude Code
- **单一供应商**：仅 Anthropic API。
- 无适配器层 — 直接使用 SDK（`@anthropic-ai/sdk`）。
- 重试逻辑内置于 SDK。
- 无模型降级（始终使用配置的 Claude 模型）。

### KHY OS
```
aiGateway.js (232K) — 中心路由单例
  -> 14+ 适配器 (每个 40-110K):
     IDE: claude, codex, cursor, kiro, trae, windsurf, warp, vscode
     API: api, ollama, localLLM, relayApi, cursor2api
     Relay: webRelay, clipboardRelay

核心特性：
- 按优先级排序的级联 + 健康追踪
- 适配器故障自动切换
- 速率限制（按 key + Redis 支持）
- 能力感知路由（modelRouter）
- API 密钥轮换（keySelector）
- 指纹模拟（逐适配器）
- 流格式归一化（Anthropic SSE / OpenAI SSE / raw）
- 协议管线 (_protocolPipeline.js)：统一请求/响应变换
```

### 分析
这是**最大的架构分歧**。CC 故意做单一供应商（Anthropic 同时控制模型和工具）。KHY 是**模型无关平台**，可通过任何供应商路由，包括搭载 IDE 订阅（Cursor、Windsurf、Kiro、Trae）或本地模型（Ollama）。

---

## 10. 扩展 / 插件系统

### Claude Code
```
4 种扩展机制：
1. MCP 服务器（工具 + 资源 + 提示词，来自外部进程）
2. Skills（从 .claude/skills/ 或内置加载的提示词模板文件）
3. Hooks（生命周期事件触发的 shell/HTTP/agent 脚本）
4. Plugins（DXT 包 — 早期阶段，打包的扩展）

配置：settings.json（作用域：MDM > enterprise > project > user）
```

### KHY OS
```
3 种扩展机制：
1. MCP 服务器（兼容 CC 的 mcpServers schema）
2. CLI 插件（cli/plugins.js — 从 ~/.khy/plugins/ 加载的命令扩展）
3. Handler 模块（src/cli/handlers/ — 按领域组织的命令族）

无等价物：
- CC 的 Skills 系统（提示词模板）
- CC 的 Hooks 系统（生命周期事件）
- CC 的 DXT 包
```

### 关键差异
- CC 有**更丰富的扩展模型**（4 种机制 vs 3 种）。
- CC 的 **Hooks** 尤其强大 — 在生命周期事件（工具执行前后、压缩、会话开始/结束）上执行任意 shell 命令。KHY 有 `hookSystem` 但仅内部使用（ToolGuards），不对用户开放配置。
- CC 的 **Skills** 允许用户编写可复用提示词；KHY 无等价物。
- KHY 的 **handler 模块** 体积巨大（gateway.js: 212K、proxy.js: 118K）— 它们包含完整的子应用逻辑，不仅仅是路由。

---

## 11. 代码规模对比

| 指标 | Claude Code | KHY OS |
|------|------------|--------|
| 源码体积 (src/) | ~2.1 MB TypeScript | ~4.8 MB JavaScript |
| 最大文件 | ink.tsx (246K) | aiGateway.js (232K) |
| 工具数量 | ~30 | ~50+ |
| 适配器数量 | 1（Anthropic SDK）| 14+ |
| 测试框架 | （开源版未包含）| Jest（~50 个测试文件）|
| 核心依赖 | Bun + React + react-reconciler + Zod + commander | Node.js + chalk + readline + axios |

---

## 12. 架构优势与取舍

### Claude Code 优势
1. **端到端类型安全** — Zod schema + TypeScript + 类型化工具接口，防止运行时错误。
2. **React 组件模型** — 可组合 UI，Web 开发者熟悉。
3. **企业级配置** — MDM、远程托管设置、分层覆盖。
4. **干净的单供应商路径** — 无适配器复杂度，针对一个模型深度优化。
5. **成熟的扩展生态** — Skills + Hooks + MCP + DXT 提供多种集成点。

### Claude Code 取舍
1. **供应商锁定** — 无法使用非 Anthropic 模型。
2. **运行时重** — React + Ink 增加 ~300K+ 开销。
3. **Bun 依赖** — 可移植性不如 Node.js。
4. **无多用户** — 信任本地 OS 用户，无认证层。

### KHY OS 优势
1. **供应商无关** — 适配任何 AI 供应商，包括免费 IDE 订阅。
2. **高韧性** — 多重回退（模型级联、适配器故障转移、执行路径回退）。
3. **轻量运行时** — 无 React 依赖，冷启动快。
4. **进程级 agent 隔离** — 更安全的多 agent 执行。
5. **跨平台专注** — 完善的 Windows 兼容层。
6. **多用户能力** — 认证系统支持多用户。

### KHY OS 取舍
1. **无类型安全** — 纯 JavaScript 无类型；可能出现运行时错误。
2. **高复杂度** — 三套 agent 系统、三条执行路径、14 个适配器。
3. **大文件** — 多个文件超过 100K（维护负担）。
4. **扩展模型较弱** — 无面向终端用户的 hooks/skills。
5. **测试缺口** — 测试存在但覆盖率低于 CC 内部套件。

---

## 13. 功能矩阵

| 功能 | CC | KHY | 备注 |
|------|:--:|:---:|------|
| 结构化 tool_use（原生 API）| Yes | Yes | KHY 还支持非 Anthropic 模型的 XML 回退 |
| 自动压缩 | Yes | Yes | 策略相似 |
| 会话记忆提取 | Yes | 部分 | KHY 的是后台方式，集成度较低 |
| 响应式压缩（413 重试）| Yes | Yes | |
| 过载时模型降级 | No | Yes | KHY 在 529 时级联到更便宜模型 |
| 循环检测 | No | Yes | KHY 的 ToolLoopDetector |
| 验证 Nudge | No | Yes | 3+ 次文件写入后提醒测试 |
| Team/Swarm agents | Yes | 部分 | KHY 有进程 worker 但无点对点消息 |
| IDE 适配器搭载 | No | Yes | 复用 Cursor/Windsurf/Kiro/Trae 订阅 |
| MCP 支持 | Yes | Yes | 兼容 schema |
| Skills（提示词模板）| Yes | No | |
| 用户可配置 Hooks | Yes | No | KHY hooks 仅内部使用 |
| DXT 插件 | Yes | No | |
| MDM/企业配置 | Yes | No | |
| 用户认证 | No | Yes | |
| SSRF 防护 | No | Yes | |
| 剪贴板图片分析 | 部分 | Yes | KHY 有专用服务 |
| Bridge（移动协作）| No | Yes | 手机/平板通过 bridgeServer 接入 |
| Daemon 模式 | No | Yes | 后台进程 |
| 多终端后端 | No | Yes | |
| 量化交易模块 | No | Yes | khyquant 领域 |
| Worktree 隔离 | Yes | Yes | |
| Plan 模式 | Yes | Yes | |
| Cron 调度 | Yes | Yes | |

---

## 14. 趋同建议

### KHY 应从 CC 吸收的：
1. **用户可配置 Hooks** — 允许 `.khy/hooks.json` 定义生命周期事件触发器。
2. **Skills 系统** — 从 `.khy/skills/` 加载的提示词模板。
3. **类型化工具接口** — 即使在 JS 中，也强制 input/output schema 校验。
4. **分层设置优先级** — 形式化 MDM > enterprise > project > user 覆盖链。
5. **Snip 命令** — 手动裁剪上下文块。

### CC 可从 KHY 借鉴的：
1. **供应商抽象** — 适配器级联实现模型无关。
2. **模型降级** — 过载时自动降级。
3. **循环检测** — 防止无限工具循环。
4. **进程级 agent 隔离** — 更安全的子 agent 执行。
5. **内联渲染模式** — 保留原生终端滚动/选择（CC 的 Ink 全量捕获）。

---

## 15. 结论

Claude Code 和 KHY OS 代表了两种根本不同的哲学：

- **CC** 是**垂直整合产品** — 一个模型、一个供应商、一个用途（AI 编码助手）。每个架构决策都为这个狭窄用例优化。类型安全、React UI 和干净的抽象边界体现了 Anthropic 的工程纪律。

- **KHY** 是**水平平台** — 多模型、多供应商、多用途（编码 + 交易 + 协作 + 守护进程）。适配器级联、多 agent 层次和双二进制入口体现了"瑞士军刀"哲学。代价是复杂度。

两者都是生产级系统。CC 更**精致、可维护**；KHY 更**能力强、韧性高**。KHY 的理想演进方向是吸收 CC 的人机工程学模式（hooks、skills、类型化工具），同时保持自身独有优势（供应商无关、高韧性、平台灵活性）。
