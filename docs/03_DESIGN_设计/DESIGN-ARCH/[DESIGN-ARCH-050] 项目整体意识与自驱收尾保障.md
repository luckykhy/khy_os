# [DESIGN-ARCH-050] 项目整体意识与自驱收尾保障

> 规范号：DESIGN-ARCH-050
> 状态：已实现（services/backend/src/services/projectCoherence/）
> 关联实现：`toolUseLoop.js`（收尾时刻非侵入接线）
> 测试：`tests/services/projectCoherence.test.js`（25 例 node:test 全绿）

## 1. 背景与痛点

Khyos 已能逐个地把文件写对，但缺两块「整体性」基因，导致两类用户可感知的失败：

1. **缺乏项目整体意识。** 文件一个个看都没问题，**聚成项目后**却跑不起来——
   导入指向不存在的模块、`package.json` 入口指空、按名导入了目标模块根本没导出的符号。
   这类断裂只在「装配期」暴露，逐文件审查永远发现不了。

2. **不推不出结果。** 用户不用提示词推它，模型有时只回一句进度前言
   （「让我先看看…」「我来检查一下…」）或空壳就收尾，把**过程**当成**结果**交付。
   根因：既有的「你还没真正交付」类 nudge 全挂在 `_harnessProfile.nudges` 之后，
   对强模型档（T0）默认关闭。

本规范定义一个**确定性、零模型、fail-safe、有界**的子系统 `projectCoherence`，
在 Agent 主循环（`toolUseLoop`）的「模型想收尾」时刻介入，分别封堵这两类失败。

## 2. 设计铁律

- **零依赖、零模型**：纯正则 + Node 内建。所有分析/决策不调模型、不抛错、不死循环。
- **高置信度才拦截**：宁可漏报，不可错误阻塞交付。只有 HIGH 级断裂默认硬拦截。
- **与模型档无关**：两道保障都不看 `_harnessProfile.nudges`，强模型档同样生效。
- **非侵入接线**：主循环只在收尾时刻惰性 `require` 门面、据返回 message 决定是否再推一轮；
  关闭环境开关即完全旁路，核心循环行为不变。
- **有界**：一致性门有轮次上限（默认 2），收尾保障一次性，到顶放行并标注。

## 3. 子系统结构 `services/backend/src/services/projectCoherence/`

### 3.1 importGraph.js — 跨文件依赖/导出解析

把单个源文件坍缩成两份结构化事实：`imports`（向外索取什么）与 `exports`（向外承诺什么）。

- `detectLang(file)` → `'js' | 'py' | null`（按扩展名）。
- `parseFile(file, src)` → `{ lang, imports:[{spec,names,kind}], exports:{names:Set, hasDefault, dynamic} }`。
- 覆盖 ESM（default/named/namespace/副作用/混合/re-export）、CJS（require 解构、module.exports 对象/属性）、
  动态 `import()`、Python `from .mod import ...`。
- **动态导出标记**：`Object.assign(exports,…)`、`export *`、计算键 `exports['x']`、以及**所有 Python 模块**
  一律标 `dynamic:true`，使下游「命名导出检查」对该模块**整体跳过**——从根上杜绝误报。
- fail-safe：解析异常返回保守空图，绝不抛错。

### 3.2 resolver.js — 本地模块解析

回答：某文件里的 `import/require/from` 说明符，在「本会话产物 + 磁盘」并集里指向哪个真实文件？

- `resolveImport(spec, fromFile, lang, io)` → `{ local, resolved, candidates }`。
- **只解析本地说明符**（相对 `./ ../`、绝对项目内、Python 相对包 `.mod`）。
  裸说明符（`react`、`@scope/x`、`node:fs`、Python 绝对包）一律判为 non-local 跳过——
  它们可能来自 node_modules / site-packages，静态无法证伪，强判会变成大规模误报。
- JS：逐一尝试原样 + 扩展名（.js/.mjs/.cjs/.jsx/.ts/.tsx/.json/.node）+ `/index.*`。
- Python：按前导点数定位包目录，尝试 `.py/.pyi/__init__.py`/命名空间包目录。
- `makeIoFromSet(knownFiles, alsoDisk=true)`：用「已知文件集合 + 祖先目录」构造可注入的 `exists/isDir`，
  集合未命中时回落真实磁盘——把会话内刚写的文件稳定视为「已存在」，免受磁盘时序抖动误判。

### 3.3 coherenceAnalyzer.js — 整体一致性分析

把「一批刚写好的文件」当作整体体检，只揪三类断裂：

| kind | 级别 | 含义 |
|---|---|---|
| `unresolved_import` | HIGH | 文件 import 了本地模块，但目标在「产物 + 磁盘」里根本不存在（装配失败头号原因）。 |
| `broken_manifest` | HIGH | `package.json` 的 `main/module/types/bin/exports` 指向不存在的文件。 |
| `missing_export` | MEDIUM | 按名导入 `{ foo }` 但目标模块没导出 foo（**仅当**目标导出面可静态确定、非 dynamic 时才判）。 |

- `analyze({ files, cwd, readFile, knownFiles, maxFiles })` → `{ gaps, analyzed, skipped }`。
- `readFile`/`knownFiles` 可注入，便于纯内存单测；默认走 fs。
- `maxFiles` 默认 400，防大项目扫描爆量。
- 绝不上报低置信度结论（孤儿文件、无入口、风格不一致）。

### 3.4 coherenceGate.js — 决策与注入文案

纯决策，不读文件不调模型：

- `decide({ gaps, codeFileCount, rounds, maxRounds=2, minFiles=2, blockOnMedium=false })`
  → `{ shouldGate, blocking, reason }`，reason ∈ `too_few_files | rounds_exhausted | no_blocking_gaps | incoherent`。
- 单文件改动不触发（`codeFileCount < minFiles`）——「整体意识」只对多文件项目有意义。
- 默认只对 HIGH 硬拦截；MEDIUM 随文案附带提示，是否拦截由 `blockOnMedium` 决定。
- `buildGateMessage(blocking, round, maxRounds, allGaps)` → 中文系统注入：逐条列出断裂、
  要求用工具修复后再收尾，并允许模型在判定为误报（外部依赖提供）时简要说明理由后放行。

### 3.5 deliverableClosure.js — 自驱收尾保障（痛点 2）

**与模型档无关**的兜底：确实干了活却只回进度/空壳时，强制再推一轮要最终结果。

- `looksLikeProgressOnly(text)`：**精确策略**（零误报优先）——只有「空」或「首句是进度腔且全文无任何结论词」
  才算未交付。**不**用长度阈值（CJK 下「已启动: 夸克」只几个字却是完整交付，长度判定会误伤）。
- `CONCLUSION_RE` 与 `toolUseLoop.hasConclusion` 口径对齐，并补齐应用启动类终态动词
  （已启动/已打开/launched/opened…）。
- `shouldForceClosure({ reply, pendingToolCalls, totalToolCalls, used })`：
  `used` 已用过、`pendingToolCalls>0`（还在执行）、`totalToolCalls<=0`（没干活）任一为真即不介入。
- `buildClosureMessage(userMessage)`：命令模型基于已有工具结果直接写出完整最终答复，不许再说过程话。

### 3.6 index.js — 门面（§4 编排）

`evaluateCoherenceGate(opts)` → `{ shouldGate, message, gaps, blocking, reason }`；
`evaluateClosure(opts)` → `{ shouldForce, message }`；
`analyzeProjectCoherence(opts)`、`countCodeFiles(files)`、`SEVERITY`。
全部 try/catch fail-safe，任何异常返回安全默认（不拦截/不强制）。

## 4. 主循环接线（toolUseLoop.js，非侵入）

状态变量（`runToolUseLoop` 内）：`_coherenceGateRounds`、`_coherenceGateExhausted`、`_closureGuardUsed`。

1. **一致性门**（`toolCalls.length === 0 && _allModifiedFiles.size >= 2 && KHY_PROJECT_COHERENCE`，
   位于非编辑证据门之后、精简 nudge 之前）：惰性 require 门面 → `evaluateCoherenceGate` →
   `shouldGate` 时递增轮次、`currentMessage = message; continue;`；到顶置 `_coherenceGateExhausted`。
2. **收尾保障**（`toolCalls.length === 0` 块内，`!concludeNow && !_closureGuardUsed && totalToolCalls > 0 &&
   KHY_DELIVERABLE_CLOSURE`）：`evaluateClosure` → `shouldForce` 时置 `_closureGuardUsed`、
   `currentMessage = message; continue;`。让位给 `concludeNow`（实质长回复不打扰）。
3. **到顶标注**：`_coherenceGateExhausted` 时在最终文本追加人工复核提示。

## 5. 环境开关

| 变量 | 默认 | 含义 |
|---|---|---|
| `KHY_PROJECT_COHERENCE` | on | 项目整体一致性门总开关。 |
| `KHY_PROJECT_COHERENCE_ROUNDS` | 2 | 一致性门轮次上限（1–5）。 |
| `KHY_PROJECT_COHERENCE_MEDIUM` | off | 是否让 MEDIUM（命名导出缺失）也参与硬拦截。 |
| `KHY_DELIVERABLE_CLOSURE` | on | 自驱收尾保障总开关。 |

## 6. 验证

- `tests/services/projectCoherence.test.js`：25 例 node:test，全程内存注入（readFile/knownFiles），
  覆盖 importGraph/resolver/analyzer/gate/closure/façade 及 fail-safe，全绿。
- `toolUseLoop` 既有 jest 套件零回归（含 `appLaunchIntentFilter` 终态确认用例）。
