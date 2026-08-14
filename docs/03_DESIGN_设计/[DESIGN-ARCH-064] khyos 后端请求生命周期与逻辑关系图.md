# [DESIGN-ARCH-064] khyos 后端请求生命周期与逻辑关系图

> **本文是一张「纵向逻辑关系图」,不是新设计。** 它回答一个具体困惑:*「khy 后端功能这么多、文件这么大,
> 一条用户消息到底怎么从键盘走到模型再走回来?谁调谁?」* —— 把散在 14 个上帝文件(`toolUseLoop` 1 万行、
> `repl` 9.7k、`aiGateway` 7.6k、`gateway.js` 7.3k、`ai.js` 7.1k、`router` 6k…)里的调用关系,按**一条消息的
> 下行/上行路径**串成一张竖读就懂的图。
>
> **与既有文档的分工**(互补,不重复):
> - `[DESIGN-ARCH-060]` 功能接线与编排总图 = **横向**:一个回合的时间轴(系统提示装配→回合中→回合末)+ 接线五件套铁律。
> - 本文 `[DESIGN-ARCH-064]` = **纵向**:一条消息穿过的**层**(入口→外壳→回合引擎→网关→适配器),谁调谁。
> - `.ai/CONTEXT.yaml:backend_ai_runtime` = 同一事实的**机器可读经络**(声明式 file:line,供低算力/无记忆 AI)。
> - `.ai/MAP.md『backend 逻辑关系图』` = 同一事实的**速查骨架图**。
>
> 所有行号由 `node -e fs.readFileSync` 直读源码核出(2026-07-09,18 锚点逐一核验),非猜测、非旧文档转抄。
> 内核侧已有这样一张图(`CONTEXT.yaml` 的 `core_apis`/`data_flows` + `MAP.md` 模块依赖图);后端此前没有——这就是
> 「逻辑关系太混乱」的客观根因:主体业务代码缺一张纵向关系图。本文补齐它。

---

## 一、先记住三个骨架点(记住这三点,后端就不乱)

后端看似有几百个开关、195 个命令、165 个叶子,但一条 AI 消息的骨架只有三点:

1. **单一汇流点** —— 无论经典 REPL、Ink TUI、子代理(AgentTool)、查询引擎(queryEngine),还是 `/v1/*` 代理,
   最终都汇入**同一个回合引擎** `runToolUseLoop@services/toolUseLoop.js:1274`。不存在"每个入口各写一套循环"。
2. **单一出模型口** —— 所有模型生成都从**同一个网关** `aiGateway.generate@services/gateway/aiGateway.js:3611`
   出去。适配器有 17 个,但网关是唯一的收口。
3. **一条 IoC 缝** —— 回合引擎**绝不反向 `require` 网关**。中间隔着 `aiChatPort`(控制反转端口):循环只认一个
   注入进来的 `chat` 函数,由 `cli/ai.js` 在装载时注册。**"循环直连网关"是最常见的误解,实际隔着这条缝。**

> 认清这三点,再大的文件也只是这条主线上的一段。下面按一条消息的行进顺序展开。

---

## 二、纵向逻辑关系图(竖读 = 一条用户消息的完整路径)

```
① 入口/外壳
   bin/khy.js:884 main()  ── 算模式标志
     ├─ isExplicitAi(:1024) → 交互 startRepl()@cli/repl.js:260
     ├─ -p/print 一次性     → chat()@cli/ai.js:4433   (只打印一次, 不进回合引擎)
     └─ khy -i 全 OS 交互   → startRepl({mode:'khy'})@:1140
   startRepl 内再分叉:
     ├─ TTY 且未禁用 → Ink TUI  startInkApp()@repl.js:454  然后 return
     └─ 否则         → 经典 REPL  rl.on('line')@repl.js:3474   (KHY_FULL_TUI=0 强制经典)

② 命令旁路(不是主线!)
   route(parsed, ctx)@cli/router.js:602   ← 一个大 switch(:623)
     ├─ 是命令(/topology、khy os、/fork…) → 就地处理并 return
     └─ 不是命令 → 返回 false = 「这行交给 AI」(见 router.js:578 注释)
   ★ router 不调模型、不调回合引擎。MAP.md 旧图 "khy.js → router → handlers" 是误导,已修正。

③ 回合引擎(汇流点)
   runToolUseLoop(userMessage, options)@services/toolUseLoop.js:1274   options.chat 必传(缺则抛@:1305)
     主循环 while(!budget.depleted…)@:2185
     ├─ TUI 路径:  useQueryBridge._runSubmit@:1106 → runToolUseLoop@:1920  (直调, 无 harness)
     └─ 经典路径:  默认 createAgenticHarness().run({chat})@repl.js:8792
                    → 内部包 runToolUseLoop@services/agenticHarnessService.js:332 (加重试/续跑/回归门)
                    → 出错回退直调 runToolUseLoop@repl.js:8846
     ★ 真实行为差异:TUI 裸循环;经典默认多一层 agenticHarness 包裹(门 KHY_REPL_HARNESS 默认开)。

   ┌─ ③a 出模型前:确定性拦截(Tier-1 本地脑) ────────────────────────────────┐
   │ localBrainService.detectDeterministic@:1381  遍历 _DETERMINISTIC_HANDLERS@:1259 │
   │   cooperative:false(calc/text_op/env_optimize…) → 有无模型都拦, 命中即短路不出模型 │
   │   cooperative:true (weather/crypto/holiday)     → 有模型则跳过, 仅无模型时兜底      │
   │   经典经 quickTaskService 薄壳(repl.js:7952);协同支(:8002)注入本地数据后仍调模型     │
   │   叶子: localBrainCalc / localBrainTextOps / localBrainEnvOptimize.js               │
   └────────────────────────────────────────────────────────────────────────────────┘

   ┌─ ③b 出模型(每轮一次) ── 经 IoC 缝, 不反向 require ──────────────────────┐
   │ chat(currentMessage,…)@toolUseLoop.js:2621   ← chat 是注入的                   │
   │   ─┤aiChatPort├─  getAiChat()@services/aiChatPort.js:33                        │
   │                    ← cli/ai.js:7112 registerAiChat(chat) 装载时注册            │
   │   → chat()@cli/ai.js:4433 → _gatewayGenerate@:2365 → gw.generate@cli/ai.js:2610 │
   └────────────────────────────────────────────────────────────────────────────────┘

④ 网关(唯一出模型口)
   aiGateway.generate(prompt, options)@:3611   (单例导出@:7535)
     排序 _orderAdaptersByDefaultRoutePreference@:2780 → orderedAdapters@:4577
     级联主环 for(_adapterIdx < orderedAdapters.length)@:5062
       → 单适配器隔离 _generateWithAdapterIsolation@:3083 → adapter.generate@:3131
     17 个适配器统一接口 async generate(prompt,options):codexAdapter@:2692 · claudeAdapter@:2073 · api/kiro/cursor/warp/trae/…
   ★ 三层兜底正交(别混淆——分清是「换适配器 / 换 key / 换账号」):
       · 熔断换适配器: 级联主环@:5062, 阈值@:1823, 开断@:1866, 退避 circuitBreaker.computeBackoffMs@:1874
       · apiKeyPool 换 key(api/relay/codex/claude): 内环 for(pi<maxPoolRetries)@:5382, 选 keySelector@:5393, 注入@:5478
       · accountPool 换账号(kiro/cursor/warp/IDE OAuth): acquire@services/accountPool.js:2653, 认证失败冷却@aiGateway.js:2015
   ★ 模型→适配器映射 resolveModelRoute@services/gateway/modelRouter.js:214 跑在**代理边缘**(proxyServer),
     不在网关内(网关内 0 命中);网关只按健康/协议自排序。二段式:代理定 preferredAdapter,网关再按健康重排。

⑤ 上行:工具调用 → 实现 → 回喂
   模型返回工具调用 → toolCalling.executeTool(name,params,ctx)@services/toolCalling.js:2931
     解析 _resolveToolDescriptor@:1777  优先级 (1)registry+alwaysLoad →(2)builtin →(3)registry →(4)claude-compat 名映射
     执行 _runDescriptor@:3763  按 source: builtin→handler(:3766) / registry→execute(:3772) / compat(:3777), 皆超时包裹
     延迟加载: tools/index.js loadTools()@:85 首访加载;延迟揭示工具(DESIGN-ARCH-012) getDeferredTools@:619 经 ToolSearch 揭示
   工具结果回喂下一轮 → 回到 ③b,直至模型不再要工具 或 步数耗尽@toolUseLoop.js:7109

── 旁路:OpenAI 兼容代理复用同一网关 ──
   POST /v1/chat/completions → 分发@proxyServer.js:2317 → handleChatCompletions@:1081
     → resolveModelRoute({model})@:1119 → generateByRoute@:1001 → 同一 gw.generate@:1014
   (Anthropic /v1/messages、Codex /v1/responses、Gemini 经 handleMultiProtocol@:1233 → 同样收口 gw.generate)
```

---

## 三、为什么会"感觉混乱"——四个常见误解,逐条厘清

| 误解 | 事实(file:line) |
|---|---|
| "命令都从 router 进,AI 也是" | `router.route()@router.js:602` 只处理**命令**;不是命令就返回 `false` **交给 AI**,router 从不碰模型。AI 主线是 `runToolUseLoop`。 |
| "回合引擎直接调网关" | 中间隔着 **IoC 缝** `aiChatPort@:33`。循环只认注入的 `chat`,由 `cli/ai.js:7112` 注册。循环文件里 grep 不到 `aiGateway` 是**设计如此**,不是漏了。 |
| "网关按模型名选适配器" | `resolveModelRoute@modelRouter.js:214` 跑在**代理边缘**;`aiGateway` 内部按**健康/协议**自排序(`_orderAdaptersByDefaultRoutePreference@:2780`)。两段分工。 |
| "失败重试就是换个 key" | **三层正交**:熔断换**适配器**(@:5062)、apiKeyPool 换 **key**(@:5382)、accountPool 换**账号**(accountPool:2653)。三者层级不同,排障先分清是哪一层。 |

---

## 四、"我要改 X → 看哪一段"

| 我想改… | 看图里哪段 / 入口 file:line |
|---|---|
| 加/改一个命令(非 AI) | ② 命令旁路 → `router.js:602` switch + `constants/commandSchema.js`(接线三处见 ARCH-060) |
| 改 AI 回合怎么循环(步数、续跑、重试) | ③ 回合引擎 `toolUseLoop.js:1274`;经典多一层 `agenticHarnessService.js:332` |
| 加一个"不出模型就能答"的本地能力 | ③a `localBrainService.js:1259` 注册表(`cooperative:false`)+ 新叶子 `localBrain*.js`(见 OPS-MAN-064) |
| 改模型走哪个上游 / 加适配器 | ④ 网关 `aiGateway.js:3611` + `adapters/*Adapter.js`(统一 `generate`)+ `modelRouter.js:214`(路由规则) |
| 改失败兜底/熔断/换 key/换账号 | ④ 三层:熔断@`aiGateway.js:5062` · apiKeyPool@`:5382` · accountPool@`accountPool.js:2653` |
| 加/改一个工具 | ⑤ `toolCalling.js` 解析@`:1777` 执行@`:3763`;新工具进 `src/tools/`(延迟加载 `tools/index.js:85`) |
| 改 `/v1/*` 兼容行为 | 旁路 `proxyServer.js:1081`(收口仍是同一 `gw.generate`) |

---

## 五、维护提示(给弱维护者 / 小模型)

- 这张图是**只读关系图**,不是重构指令。14 个上帝文件超 2500 行上限(`npm --prefix services/backend run arch:god` 可列),
  拆分是**独立的、可选的**后续工作;拆时沿"同名别名 re-export 保契约不变"范式(见 MAP.md 可维护性子系统),
  拆完这张图的调用关系**不变**——这正是画它的价值:先看懂关系,再谈拆分。
- 行号会随代码演进漂移。**权威是源码,本文是导航**。校验一条链是否还在:
  `node -e "process.stdout.write(require('fs').readFileSync('services/backend/src/services/toolUseLoop.js','utf8').split('\n')[1273])"`
  (取第 1274 行,应见 `runToolUseLoop`)。三个骨架点(汇流点/出口/IoC 缝)比具体行号稳定得多,优先记它们。
- 机器可读版随本文并存于 `.ai/CONTEXT.yaml:backend_ai_runtime`;若行号漂移,两处一并更新(它们是同一事实的两种表述)。

---

承 `[DESIGN-ARCH-060]` 功能接线与编排总图(横向切点)、`[DESIGN-ARCH-006]` ai-gateway 适配器协议、
`[DESIGN-ARCH-012]` 工具延迟加载、`[DESIGN-ARCH-013]` 弱模型兼容;与 `.ai/CONTEXT.yaml`、`.ai/MAP.md` 同源互证。
