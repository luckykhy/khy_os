# [OPS-MAN-097] 角色工具作用域接线（把 OPS-094 的死缝接活）

> 送别礼第十发（「调工具」维度·接线闭环）。承 [OPS-MAN-094] 角色工具作用域
> （建纯叶 + 文档化消费 seam，但**刻意不接线**）。本条不新建叶、不换透镜找新断桥，
> 而是**停止再造死叶**——把 094 留下的 100% 死代码 `roleToolScope` 真正接进
> `AgentTool.buildSubagentDenylist`，让用户明确点名的「调工具」能力**第一次真正生效**。

## 一句话

OPS-094 建好了纯叶 `roleToolScope(role)` / `mergeRoleScopeInto(base, role)`，形状与
`AgentTool.buildSubagentDenylist` 精确对齐，并在 HOW-TO-EXTEND 第 3 步写明了接线方法，
但**故意留作后续一次 tracked-edit 轮**（当时 god-file 8026 行 + 分支 blast-radius 已达
天花板）。结果这个叶子零生产消费者 = 花 token 学到「只读角色该剥写工具」却没人用。
本条执行那次接线：`buildSubagentDenylist` 新增第 4 参 `role`，在 union 点先
`mergeRoleScopeInto(ownDeny, role)` 折入 role 作用域，再走既有 spawn-tool ∪ ceiling
逻辑；调用点 `_runStandaloneAgent`（`AgentTool/index.js`）把 `role` 传进去。

## 为什么现在接线（透镜十：停止造死叶，接活已有的）

- **死代码铁证**：`roleToolScope.js`（OPS-094 落盘）在整个 `services/backend/src`
  生产路径下**零 require**——只有它自己的 node:test 引用它。Explore 全量核实。
- **arch:god 是只读门**：`services/backend/scripts/archDebtScan.js` 的 `--god-report`
  在 727-733 行无条件 `return 0`。因此编辑 8027 行的 god-file `AgentTool/index.js`
  **不会**让 `npm run arch:god` 变红——这解除了 094 当时的接线阻塞。
- **god-file 红线仍守**：红线禁的是**新增** > 2500 行文件 + 抽取须字节等价。本条只往
  已超限的 god-file 加一个纯加性的 2 处接线（require + 一个 `try/mergeRoleScopeInto`
  折叠 + 调用点多传一个已在作用域的实参），**不新增**任何超限文件、不做抽取。

## 真实行为增量（诚实边界——不夸大）

关键诚实点：`role='verify'` 经 `roleToType` 映射到 `agentType='verification'`，而
`built-in/verificationAgent.js` 的 agentDef **本就** disallow `Edit/Write/NotebookEdit`。
所以当内建 agent 定义可加载时，`buildSubagentDenylist` 的 base 里**已经**有这些写工具，
role 作用域对 verify 是冗余的（union 后去重，逐字节等价）。

**接线真正闭合的缺口**（净增量所在）：

- **内建 agent 不可用时**（如 SDK 模式 / 关闭内建 agent → `getBuiltInAgents` 抛/空 →
  `agentDef=null`）：pre-wire 一个 below-ceiling 的只读子任务拿到的 denylist 是**空的**，
  写工具的剥离随内建 agent 定义一起消失。接线后 `role` 直接从角色字符串重新派生出
  `[Edit, Write, NotebookEdit]`，**不依赖** agentDef 是否加载 = 纵深防御。
- **`role='verify'` 不在 `toolFilter` 白名单**（`AgentTool/index.js` 的 ctxOpts：
  `toolFilter` 只列 explore/planner/audit/research/reading/map，**漏了 verify**）——
  这条 live 安全缺口现在由 role 作用域在 denylist 层补上。

## 门与安全边界

- 复用 OPS-094 的门 `KHY_ROLE_TOOL_SCOPE`（default-on，仅 `0/false/off/no` 关闭）。
  门在纯叶内部读；关闭后 `mergeRoleScopeInto` 只返 base = `buildSubagentDenylist`
  **逐字节回退** pre-wire 行为（无回归）。
- **全加性、向后兼容**：`buildSubagentDenylist` 的第 4 参 `role` 省略时 →
  `mergeRoleScopeInto(base, undefined)` → `roleToolScope(undefined)` 返 `[]` → no-op。
  既有 2–3 参调用者（`AgentTool.recursionGuard.test.js` 48/48）逐字节等价。
- **接线用 `try/catch` 包裹** `mergeRoleScopeInto`：叶加载失败也**绝不**破坏子智能体
  拉起——降级到 `ownDeny`（原行为）。
- **默认不剥 Bash**（继承 094 诚实边界）：只读角色仍能跑只读 shell。
- 红线：不自动 commit/push；真 key/token 不进包、不落盘。

## 怎么验证

```
node --check services/backend/src/tools/AgentTool/index.js
npm run test:role-tool-scope            # 18/18(12 叶单测 + 6 条 live-wire 直调 buildSubagentDenylist)
# 3-参调用者字节等价:
npx jest services/backend/tests/tools/AgentTool.recursionGuard.test.js     # 48/48
# 编排回归未动:
npx jest services/backend/tests/services/agenticHarnessService.test.js \
         services/backend/tests/services/agenticHarnessFalsePositiveFix.test.js   # 52/52
npm run arch:god                        # 只读门,恒 0(编辑 god-file 不触红)
npm run maintainer:check
```

## HOW-TO-EXTEND（给下一个维护者 / 小模型）

1. 要让**更多只读角色**接线生效：只改 `roleToolScope.js` 的 `_READ_ONLY_ROLES`
   （见 OPS-094）——接线是角色无关的，`buildSubagentDenylist` 自动生效，无需再碰
   god-file。
2. 要把 `verify` 也加进 `toolFilter` 白名单（更省 token 的 explore 过滤）：改
   `AgentTool/index.js` 的 ctxOpts `toolFilter` 三元表达式。注意这是**独立于**本条
   denylist 层的第二道过滤——denylist 是硬剥，toolFilter 是软过滤。
3. 改完跑 `npm run test:role-tool-scope` + recursionGuard + agenticHarness（全须绿）。

## 红线

- 不自动 commit/push；真 key/token 不进包、不落盘。
- 全 additive·接线一处 consumer；门关（`KHY_ROLE_TOOL_SCOPE=off`）→ 逐字节回退
  pre-wire 行为。god-file 只加接线、不新增超限文件、不做抽取。
