# SPLIT-PLAN.md — replSession / toolUseLoopCore 拆分分批计划（T-017 配套）

> 依据：T-017 验收第 3 条「单文件不高于 800 行（或给出分批计划）」。
> 本文件是拆分作战地图：每个批次独立可验收、可回滚（独立提交）。
> 批次行号为 2026-09-02 基线（replSession 13945 行 / toolUseLoopCore 12732 行时代），
> 实际操作前用 `Select-String '^// ──'` 重新定位横幅，勿信死行号。

---

## 零、已验证的提取模式（批次 1 实证）

**工厂 + 显式依赖注入**（`src/cli/repl/startupHeader.js` 为样板）：

1. 新模块导出 `create<X>(deps)` 工厂；原闭包内层函数体**逐字搬入**（仅 require 相对路径重定基）。
2. 闭包自由变量全部进 deps 袋（依据 = 原文件 `@closuredeps` JSDoc 注解，前人已盘点）。
3. 闭包内可变守卫状态（如 `_startupHeaderRendered`）移入工厂内部；外部有写点时导出 reset 函数保语义。
4. 原文件原位替换为工厂调用；对外 `module.exports` 面（`{ startRepl, setReplSessionDeps, getReplFsm }`）零改动。
5. 相对路径重定基规则：`../services/* → ../../services/*`、`../../assets/* → ../../../assets/*`。

**批次验收协议（每批必跑）**：

```bash
node -e "require('./src/cli/replSession.js')"                     # 模块加载
npx eslint <新文件> --max-warnings 0                              # 新文件必须零告警
npx eslint src/cli/replSession.js | diff - <批次前基线>           # 不新增问题（存量债不在本任务范围）
npx jest --silent --json --outputFile=after.json                  # 全量对比: suites/tests/passed/failed 四数不劣化
node scripts/ci/check-agent-rules.js --changed                    # 工程红线（khy-os 根目录跑）
node services/backend/scripts/archDebtScan.js                     # R2b 必须显示负增长（拆后必变小）
```

已知 flaky 白名单（负载下偶发，单独重跑即绿，不计入回归）：
`tests/bin.machineReadable.test.js`（spawn 类）、concurrency 系（worker 优雅退出告警）。

---

## 一、replSession.js（批次 1 后 13560 行 → 目标 ≤800）

> 结构：模块级已模块化（懒加载+提取模块）；剩余巨石 = `startRepl()` 单闭包
> （~13.1k 行）+ 82 个内层函数。对外调用方仅 `cli/repl.js` 一个。

| 批次 | 提取单元（旧基线行号） | 规模 | 风险 | 依赖要点 |
|------|------------------------|------|------|----------|
| B1 ✅ | 启动视觉簇（852-900, 971-1326）→ `repl/startupHeader.js` | 385 | 低 | @closuredeps 已有；守卫 reset 已导出 |
| B2 ✅(证伪) | @path 提及解析——**实地核查早已上游提取**为 cli/atMentionInject.js 单一真源；banner 间距≠内聚单元，本表行号均需按横幅重定位 | 0 | - | 教训：先盘点再规划 |
| B2' ✅ | 权限栏簇提取 → `repl/permissionBar.js`（_getPermissionModeState + _autoCompactAt + _renderPermissionBar[死代码候选,零调用仅注释提及,原样保全] + _buildPermissionBarText；deps 仅 c/fmt，服务叶子内部重 require 并重定基路径） | -174 | 低 | 转写陷阱：逐字搬运时 truncatePlain 的 n≤1 分支一度写错（三元两侧混淆），靠人工比对原文抓回——**长函数逐字转写必须逐行 diff 原文** |
| B3 ✅ | 剪贴板桥+中继两内联分派分支 → `repl/clipboardCommands.js`（144 行正文搬入，deps 含 print 三件套/fsmFire/setBusy/keepalive 注入；**clipboardRelayAdapter 属巨型 SCC 成员由核心 lazy require 注入**——IoC 铁律再次适用，aiRenderer 等叶子内部重 require） | -85 | 低 | 内联分支形态同 /study：正则匹配留核心、正文整体搬入；busy/FSM 经 setter 保所有权 |
| B4 ✅ | `!` shell 逃逸 → `repl/shellEscape.js`（队列状态完全封装——闭包对外零引用，调用方仅触三函数；formatShellEscapeContext 宿主注入值传递；第二个横幅实为 27 行薄分派分支无需动） | -34 | 低 | 第三次证实：banner 间距≠真实规模（估 1400 实为 79）——**一切批次先实测定界** |
| B5 ◐ | 瞬态原位状态（8812-9722） | ~900 | 中 | 首切片✅：`repl/deferredStatuses.js`（-16，**数组引用传递模式**——缓冲数组留调用方、push/splice 语义跨模块不变）。铺垫批✅：`_transientStatusActive` → `_tstatus.active` 对象化（10 处机械转换零残留，语义等价 jest 集合验证）。余量=_writeTransientStatus/_flushTransientStatus 对 → 现在可直接接收 `_tstatus` 对象提取（B5 二批解锁） |
| B6 | flag 处理器（6074-6765） | ~690 | 中 | 分派表化（现在是内联 else-if） |
| B7 | /study + `#` 快速记忆分派分支（6765-6980） | ~900 | 中 | 需先把内联分支提为命名函数 |
| B8 | slash/at 选择器状态机（1719-2738） | ~1000 | 高 | 状态变量多，先合并成 state 对象再搬 |
| B9 | 状态栏 + 提示框（2976-3793） | ~800 | 高 | renderStatusBar 与全局状态耦合深 |
| B10 | tool-use loop 路径胶水（10129-11258） | ~1100 | 高 | 与 toolUseLoopCore 接口面联动 |
| B11 | 本地模型路径 + 总结构建（11258-12942） | ~1680 | 高 | 与 B10 同批验收 |

> B2/B3 完成后 replSession ≈ 12.7k（R2b 可见负增长）；每批独立提交。

## 二、toolUseLoopCore.js（批次后 12086 行 → 目标 ≤800）

> 结构：79 个顶层函数（小）+ `runToolUseLoop` 单闭包。C1 后再次核实：
> runToolUseLoop 真实边界需 brace-scan 而非 next-decl 距离（后者曾把
> runToolUseLoop 尾部 + parseToolCalls 头部混为一谈，导致 C1 切割越界——
> 已现场修复，教训：**任何切割必须 node --check 立即验证**）。

| 批次 | 提取单元 | 规模 | 风险 | 说明 |
|------|----------|------|------|------|
| C1 ✅ | SSOT 对齐：删除陈旧副本（policy-load 链 174 行 + assess 集群 177 行 + 本地 _parseToolCalls 及孤儿体），call sites 改走 `_toolCallParser`/`_capabilityAssess` SSOT（别名注入） | -646 | 中 | 见下方 C1 备忘 |
| C1.5 ✅ | 死代码清扫：自然语言解析链 7 连环（_parseNaturalToolCalls → _mapNaturalActionToTool → _parseLooseKv/_cleanParams → _buildNaturalToolParams → _parseFunctionArgs → _coerceValue，互为唯一调用方全链死亡） | -300 | 低 | node --check 立即验证纪律生效，一次通过 |
| C2 ✅ | runToolUseLoop 阶段地图（下方） | 0（清单） | 低 | 实测 1808-11082 = 9275 行（next-decl 定界，brace-scan 不可用） |
| C3-P7 ✅ | 工具解析决策链提取 → `toolUseLoop/resolveToolCalls.js`（s20 信号语义 + 5 类面包屑，纯决策零状态变更，deps 袋 9 项） | -66 | 低 | **C3 决策簇样板**：call site `let toolCalls`（循环后段重赋值，勿用 const） |
| C3-P1 ✅ | FSM/阶段观测接线提取 → `toolUseLoop/loopObservability.js`（shadow FSM + onPhase 链式挂接 + fork 包裹器；`_currentIteration` 闭包捕获改 `iterationRef` 对象——**变异捕获模式样板**，钩子 fire 时读 ref 不取快照） | -46 | 中 | 教训：同文本注释多处出现时 findIndex 会命中错误位置——切割脚本断言必须用唯一锚点 |
| C3-P2 ✅ | harness/协议上下文提取 → `toolUseLoop/protocolContext.js`（tier profile + 原生工具能力探测 + 协议缝，返回袋解构保下游零改动） | -74 | 中 | **IoC 铁律新证**：提取模块静态 require gateway/adapter 模块会加入既有巨型 SCC（R3 拦「环缠新成员」）——提取模块必须零 require 纯叶子，lazy requires 留在核心原位经 deps 注入 |
| C3+ | 按阶段拆 runToolUseLoop（同工厂模式） | ~9275 | 高 | 切缝=面包屑簇边界；先做 loopState 状态对象化 |
| C3-P10 ✅ | 静默区（7359-9837=工具执行机械区）补 5 个里程碑面包屑：tool-exec-preflight/start/batching/sequential/done（含 iteration+计数，零内容泄漏） | +5 | 低 | `_loopBreadcrumb` 契约核实：KHY_LOOP_DEBUG 门控 + 写文件非 stdout + fail-soft——关 flag 零开销；静默区从 2478 行零观测变为 5 点可诊断，为后续切削供锚点 |

**C2 · runToolUseLoop 阶段地图（面包屑聚类，行号为 2026-09-02 C1.5 后基线）**

| 阶段 | 行区间（约） | 内容（_loopBreadcrumb 锚点） | C3 拆分优先级 |
|------|--------------|------------------------------|----------------|
| P1 预处理 | 1808-2100 | prompt-structuring(2106)、options 归一化 | 高（状态少） |
| P2 环境/协议 | 2100-2400 | harness-profile(2337)、tool-protocol(2386) | 高 |
| P3 门控 | 2400-3200 | small-model-pipeline(2846)、model-escalation(2904/2922) | 中 |
| P4 迭代预算 | 3200-3700 | posttool-hook-stop(3264)、token-budget-stop(3307)、idle-continuation(3470) | 中 |
| P5 路由分流 | 3700-4100 | procedure-catalog(3786)、external-agent-route(3814)、diagnostic-grounding(3835) | 中 |
| P6 空回退 | 4100-5000 | grace-empty-fallback(4111/4404)、nudge-continue(4725) | 中 |
| P7 工具解析 | 5000-5300 | tool-parse-* 五连(5031-5068)、degenerate-echo(5276) | 高（C1 已对齐 SSOT，状态窄） |
| P8 结果判定 | 5300-7100 | stop-reason-recovery(5608)、ensemble-verify(5723/5821)、audit-fix(6007/6037)、nudge 蜂群(6157-7113)、refusal-repeat-break(6740)、goal-stop-gate(6862) | 低（nudge 蜂群最纠缠） |
| P9 结论带 | 7100-7600 | result-guard(7229)、refusal 归因三连(7326/7377/7399)、length-truncation-final(7425)、conclude(7434)、empty-final-fallback(7506) | 低 |
| P10 交付 | 7600-11082 | 无面包屑静默区 2400+ 行（9984/10258/10612/10678/10933 散点）→ **先补面包屑再拆** | 最低（可观测性先行的活标本） |

**C3 切削规程**：① 先把循环共享可变状态（iteration/totalToolCalls/aiResult/stopReason/…）收敛为 `loopState` 对象显式传递；② 每阶段按面包屑簇边界提取工厂模块（deps 袋=loopState 子集）；③ 无面包屑区（P10）先补 `_loopBreadcrumb` 再拆——可观测性与可拆分性同源。
| C1.5 | 死代码清扫：`_parseNaturalToolCalls`/`_mapNaturalActionToTool`（C1 后仅互相引用，已死）；连同其区间 Top-level 化 | ~120 | 低 | C1 遗留，机械删除 + jest |

**C1 备忘（重要工程发现）**：
1. **导出与运行时分叉 bug**：`module.exports` 早已把 `_parseToolCalls`/`_assessExecutionCapability`/`_loadCapabilityPolicy` 委托给提取模块（外部单测测的是新代码），但循环运行时仍调本地陈旧副本——修复性对齐，非纯重构。
2. **R4 漂移检测盲区**：`scanDriftR4` 只识别 `const X = require(...)` 直绑模式，漏检 `const { X } = require(...)` 解构立面（本次分叉即漏检）。修 R4 = 独立小任务（待登记）。
3. **保留区**：`_enabledNameSetCache` 缓存子系统（经 `setToolUseLoopHelpersDeps` 注入 toolUseLoopHelpers 在用）不得删——C1 曾误划入删除集，靠调用点矩阵核查救回。
4. **jest flaky 白名单（实测）**：`bin.machineReadable.test.js`（spawn 系，负载下随机挂 1-2 项，solo 稳定全绿）、`largeTaskRuntimeStore.concurrency`（多进程计时系）。四数对账以失败**集合**比对为准，solo 重跑仲裁。

## 三、并行会话纪律

- 两文件处于共享脏工作树；**动工前先 `git status` 确认目标文件无新改动**，mtime 距当前 <30 分钟即停手协调。
- R2b 基线以最近一次 `--update-baseline` 为准；批次开始前重扫一次防误报。
- 每批独立 commit（回滚点），commit message 带 `T-017 B<n>` / `T-020 C<n>` 标记。
