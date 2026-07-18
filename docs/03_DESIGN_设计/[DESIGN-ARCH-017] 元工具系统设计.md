<!-- 文档分类: DESIGN-ARCH-017 | 阶段: 设计 | 原路径: docs/03_DESIGN_设计/[DESIGN-ARCH-017] 元工具系统设计.md（新建） -->
# khyos 元工具系统设计（Meta-Tool / Tool-Forging）

> 版本 v1.0（2026-06-12）。本文定义 khyos 生态底座的**元工具系统**：当现有工具
> 无法满足任务需求时，由 Agent 经 LLM **动态生成**一个新工具，经**静态安全扫描 +
> 沙箱冒烟测试**后**自动注册**进工具系统，供后续步骤即时调用。
>
> 关键词 **必须 / 严禁 / 应 / 可** 按 RFC 2119 语义。本系统是**可选能力**，默认关闭，
> 仅当运营者显式设置 `KHY_ENABLE_META_TOOL=1` 时启用（与 `executeCode` 同样的
> 「知情启用」纪律）。

---

## 0. 目标与非目标

**目标**
- **动态性**：按任务需求即时铸造工具，而非固定工具集。
- **安全性**：生成工具经多层验证（静态扫描 + 沙箱测试 + 运行期强隔离）才可注册/调用。
- **透明性**：用户以自然语言感知「正在创建工具…/已创建工具 X」，不暴露内部细节
  （遵循 [DESIGN-ARCH-016] AI Agent 显示规范）。
- **兼容性**：仅通过工具注册表**公开 API**（`register` / `defineTool`）接入，
  零侵入现有调度循环与业务逻辑。

**非目标**
- 不生成可访问文件系统 / 进程 / 网络 / 子进程的工具（这类需求应走既有受控工具，
  如 `editFile` / `shellCommand` / `webSearch`，而非新铸）。生成工具是**纯计算**单元。
- 不替代 MCP / 内置工具；元工具只补「现有工具集恰好缺一块纯逻辑」的空隙。

---

## 1. 架构总览

```
┌────────────────────────── Agent 调度循环 (toolUseLoop, 不改) ──────────────────────────┐
│  模型判断「无现成工具可用」→ 调用元工具 createTool({purpose, name?, input_hint?})       │
└───────────────────────────────────────────┬───────────────────────────────────────────┘
                                            │ (普通工具调用，零核心改动)
                          ┌─────────────────▼──────────────────┐
                          │  tools/CreateToolTool (agent 可调用) │  ← 自动发现注册
                          │  · opt-in 门禁 (KHY_ENABLE_META_TOOL) │
                          │  · 默认 LLM = cli/ai.chat (可注入)    │
                          └─────────────────┬──────────────────┘
                                            │ delegate
                  ┌─────────────────────────▼─────────────────────────┐
                  │           services/metaToolEngine (引擎)            │
                  │  ① guard：预算/复杂度/去重/递归防护                 │
                  │  ② generate：LLM → JSON {name,desc,schema,code}     │
                  │  ③ staticSafetyScan：危险 API 黑名单（白盒拒绝）    │
                  │  ④ sandboxTest：sandboxedExec 冒烟（require/process │
                  │     /global 全封）                                  │
                  │  ⑤ register：defineTool（运行期再次 sandboxedExec   │
                  │     强隔离）→ toolRegistry.register                 │
                  │  ⑥ persist：~/.khy/generated_tools/<name>.json      │
                  └─────────────────────────┬─────────────────────────┘
                                            │ register() — 公开 API
                          ┌─────────────────▼──────────────────┐
                          │  tools/index.js 注册表 (不改)        │
                          │  新工具与内置工具同走 execute/权限路径│
                          └────────────────────────────────────┘
```

**核心不变量**：生成工具的 `execute` **必须**把代码体放进 `toolSandbox.sandboxedExec`
运行——即便注册后，运行期也跑在 `require/process/global/setTimeout` 全部被封的 vm
上下文里。因此一个生成工具在**任何**时刻都**不可能**触达宿主文件系统/进程/网络。
这是「安全性」的物理保证，而非仅靠生成期审查。

---

## 2. 触发机制（任务①）

分两级，优先低侵入：

1. **模型驱动（主，推荐）**：`createTool` 作为普通工具暴露给模型。其 `description`
   明确告知「**仅当**现有工具都不匹配、且需求是一段可纯计算完成的逻辑时」才调用。
   模型在 ReAct 思考中自行判定「工具匹配失败 / 需求超出现有能力」→ 调用之。
   这是最自然、零核心改动的触发：把判断权交给已在循环里的模型。
2. **程序化触发点（次，可选，预留）**：引擎导出 `shouldForge(unknownToolName, ctx)`
   辅助函数，未来可由「未知工具名」路径调用以建议铸造。**当前不接入**调度循环，
   以遵守「不碰核心业务逻辑」；接入点以 `# TODO: [MetaTool-Trigger-Unresolved]`
   标注（见引擎导出），由后续按需启用。

**严禁**在待机/无任务时主动铸造工具（零噪音，遵循 DESIGN-ARCH-016 §4）。

---

## 3. 生成逻辑（任务②）

`generateToolDefinition({ purpose, name?, inputHint? }, { llm })`：

- LLM 提示词**强约束**输出**单个 JSON 对象**：
  `{ name, description, category, risk, inputSchema, code }`
  - `name`：`^[a-zA-Z][a-zA-Z0-9_]{2,39}$`，**严禁**与现有工具同名（防覆盖）。
  - `inputSchema`：`{ <param>: { type, required?, description?, enum? } }`，参数数 ≤ 8。
  - `code`：**纯 JavaScript 函数体**，签名约定 `(params) => <return>`，**严禁**
    `require` / `process` / `import` / 网络 / 文件系统 / `eval` / `Function`。
    仅允许纯计算（数学、字符串、数组、JSON、正则）。
  - `risk`：强制规约为 `safe`（运行期沙箱隔离，无副作用）。
- 解析用 `gateway/safeJsonParse.extractFirstJson`（容错截取首个 JSON，非贪婪）。
- 结构校验失败 → 不重试无限次：**最多** `KHY_META_TOOL_MAX_RETRIES`（默认 1）次重生。

> LLM 由调用方**注入**（DI）。`CreateToolTool` 默认提供 `cli/ai.chat`，测试注入
> 假 LLM。引擎**不**硬依赖任何具体模型/网关，保证可测与解耦。

---

## 4. 安全审查（任务②/防呆）

四道闸，任一不过即**拒绝注册**：

| 闸 | 机制 | 拒绝条件 |
|---|---|---|
| G1 复杂度 | 代码长度 ≤ `KHY_META_TOOL_MAX_CODE`（默认 4000 字符）；参数 ≤ 8 | 超限 |
| G2 静态扫描 | 危险标识黑名单（`require`、`process`、`child_process`、`fs`、`eval`、`Function(`、`globalThis`、`import(`、`__proto__`、`constructor.constructor`、`fetch`、`http`、`net`、`dns`、`while(true)` 无界循环等） | 命中任一 |
| G3 沙箱冒烟 | 把 `code` 包成函数，在 `toolSandbox.sandboxedExec`（vm，`require/process/global/setTimeout` 全封，超时 ≤ 2s）里以样例输入跑一次 | 语法错误 / 加载即抛 / 超时 |
| G4 运行期隔离 | 注册后的 `execute` **始终**经 `sandboxedExec` 运行（非仅测试期） | —（这是保证，不是检查） |

> G2 是**白盒拒绝**（黑名单命中即拒），G3 是**动态确认**（能在受限 vm 里加载运行），
> G4 是**运行期物理隔离**（即便绕过 G2/G3 也无能力可用）。三者叠加 = 纵深防御。
> 若宿主装有 `semgrep`，**可**额外调用 `tools/securityScan` 加扫；缺失则静默跳过，
> **严禁**因缺可选依赖而报错。

---

## 5. 注册与集成（任务③）

- 通过 `defineTool({ name, description, category:'custom', risk:'safe', inputSchema,
  execute })` 构造，`execute` 内部 `sandboxedExec(wrappedCode, { timeoutMs })`。
- 调 `toolRegistry.register(tool)`（**公开 API**，写入 `_tools` Map）→ 同会话即可被
  模型发现与调用，与内置工具同走 `execute` / 权限 / 结果归一路径。**零核心改动**。
- 持久化到 `~/.khy/generated_tools/<name>.json`（定义 + 元数据）。引擎导出
  `loadPersistedGeneratedTools()`，由 `CreateToolTool` 首次加载时调用以恢复历史工具；
  **不**自动写入核心启动流程（避免侵入）。

---

## 6. 用户体验 / 透明性（任务④）

遵循 [DESIGN-ARCH-016]：
- **进度**（开发者层，结构化，经 `diagnostics`/`agentDevLog`，对用户不可见）：
  `phase: tool, action: meta.forge, detail: <purpose 摘要>`。
- **结果**（用户层，自然语言，工具 `content` 返回）：
  - 成功：`🛠️ 已为你新建工具「X」：<一句话用途>。已通过安全扫描与沙箱测试，现在可直接使用。`
  - 拒绝：`未能新建该工具（<人话原因，如“涉及受限操作”>）。已改用现有能力继续。`
- **严禁**向用户回显生成的源码、JSON、堆栈、内部字段。

---

## 7. 防呆（任务③防呆规则）

| 风险 | 对策 |
|---|---|
| 无限生成 / 循环铸造 | 每会话铸造数上限 `KHY_META_TOOL_MAX_PER_SESSION`（默认 5），超限拒绝并提示 |
| 重复生成同一工具 | 按 `name` 与 `purpose` 归一指纹去重：已存在→直接复用，不重铸 |
| 递归（工具造工具） | 生成工具**严禁**调用 `createTool`（G2 黑名单含工具名）；且沙箱无注册表句柄 |
| 复杂度爆炸 | G1 代码/参数上限 |
| 误启用 | 默认关闭，`KHY_ENABLE_META_TOOL=1` 显式开启 |
| 破坏既有工具 | `name` 与现有工具同名即拒（不覆盖内置/MCP/已生成） |

---

## 8. 边界（只改元工具相关模块）

- **新增**：`services/backend/src/services/metaToolEngine.js`、
  `services/backend/src/tools/CreateToolTool/index.js`、对应测试。
- **复用（不改）**：`tools/index.js`（`register`/`defineTool`）、
  `services/toolSandbox.js`（`sandboxedExec`）、`gateway/safeJsonParse.js`、`cli/ai.js`。
- **零改动**：`toolUseLoop.js` 调度循环、任何业务算法与 Prompt。
- 不确定/未就绪的接入点以 `# TODO: [MetaTool-*-Unresolved]` 标注并优雅降级，
  **严禁**盲调不存在的接口。

---

## 9. 落地检查清单

- [ ] 默认关闭，`KHY_ENABLE_META_TOOL=1` 才启用（§0）
- [ ] LLM 可注入，引擎不硬依赖具体网关（§3）
- [ ] 生成 JSON 经 `extractFirstJson` 容错解析，重试有上限（§3）
- [ ] G1 复杂度 / G2 静态扫描 / G3 沙箱冒烟 全过才注册（§4）
- [ ] 运行期 `execute` 始终经 `sandboxedExec`（§4 G4）
- [ ] 经公开 `register`/`defineTool` 注册，零核心改动（§5）
- [ ] 同名拒绝、purpose 去重、会话铸造数上限、递归防护（§7）
- [ ] 用户层自然语言、无内部字段；开发者层结构化（§6 / DESIGN-ARCH-016）
- [ ] 失败一律降级为人话 + 不抛崩 Agent（§6）
- [ ] 仅新增元工具模块，未碰调度循环与业务逻辑（§8）
