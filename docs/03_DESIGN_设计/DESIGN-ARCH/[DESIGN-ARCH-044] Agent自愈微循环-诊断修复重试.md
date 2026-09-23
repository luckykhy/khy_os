# DESIGN-ARCH-044 · Agent 自愈微循环：诊断-修复-重试（先救后报）

> 状态：已实现（services/backend）
> 关联代码：`services/backend/src/services/selfHeal/`、复用 `services/resilience/`
> 关联测试：`tests/services/selfHeal/selfHeal.test.js`（26 用例绿）
> 关联规范：[DESIGN-ARCH-028] 零静默失败（E0x 错误码来源）、[DESIGN-ARCH-027] 依赖自愈（安装委派）
> 上游依赖：`services/resilience/`（降级树 + 预算 + 死循环 + 残料兜底，本规范复用其右半）

## 1. 问题陈述

Agent 遇错有两种坏味道：

1. **不救就报**：工具一失败就 `throw` / `return 失败`，从不尝试归因与自动修复。
2. **死循环重试**：`while/retry` 不改变任何状态地原地重发，或把原始 `Error.message`
   原样塞回模型让其"再试一次"。

目标：错误必须**先精准归因 + 尝试自动修复**，修复失败方可降级或报错。
彻底杜绝上述两种坏味道。

## 2. 自调查结论（左/右两半）

自调查发现 `services/resilience/` 已实现流程图**右半**——降级熔断树
（`MAX_FALLBACK_DEPTH=3`）、调用级死循环检测、预算闸门、强制残料兜底。
缺的是**左半**——「诊断→修复→重试」的自愈微循环。

因此 `selfHeal/` **只补左半**，并把微循环作为 `ctx.repair` 钩子注入 resilience 的
`BudgetAwareExecutor`，零侵入复用右半。三道硬上限天然落到结构上：

- 「微循环 ≤ 1 次」：每个 Plan 只被 `repair()` 调用一次（`MicroLoopExecutor.MAX_LOOP=1`）。
- 「每 Plan 重试 ≤ 1 次」：resilience `MAX_RETRY_PER_PLAN=1`。
- 「降级树深度 ≤ 3」：resilience `MAX_FALLBACK_DEPTH=3`。

## 3. 流程

```
工具失败 → 诊断(ErrorDiagnostician)
  ├─ 可本地/受控修复？(fixable)
  │     ├─ 否(L2/无命中/degrade-direct) ───────────────┐
  │     └─ 是 → 处方死循环熔断？                         │
  │              ├─ 是(同处方再现) ─────────────────────┤
  │              └─ 否 → (L1 询问获批) → 执行受控修复     │
  │                       ├─ 成功 → 原 Plan 重试(≤1) → 通过→继续
  │                       └─ 失败 ───────────────────────┤
  │                                                       ▼
  └────────────────────────────────→ 降级熔断树(resilience，深度≤3)
                                          ├─ 某 Plan 成功 → 继续
                                          └─ 穷尽仍失败 → 强制兜底报告
```

## 4. 诊断字典（单一真源，六行核心病因）

| 错误签名 | 病因 | 处方动作（仅展示） | 级别 | 需确认 | fixKind |
|---|---|---|---|---|---|
| `ModuleNotFoundError: x` / `Cannot find module 'x'` | 依赖缺失 | 安装依赖 x（委派注册表） | L1 | 是 | install-dependency |
| `ECONNREFUSED 127.0.0.1:9222` | 端口占用/服务未起 | `lsof -i:9222` 只读探测 | L1 | 是 | probe-port |
| `Cannot read properties of null` | 格式错/参数缺失 | 按 Schema 注入缺省值 | L0 | 否 | inject-defaults |
| `403 Forbidden` | 权限/认证 | 切 WebFetch/搜索（自动降级） | L0 | 否 | degrade-direct |
| `Command not found: python` | 运行时缺失 | 固定候选 python3/node 切换 | L1 | 是 | switch-runtime |
| `EROFS: read-only file system` | 写只读 | 改写目标至 /tmp | L0 | 否 | retarget-path |

外加 L2 红线（危险命令/网络越权）→ `refuse`，**优先命中**，绝不进微循环。

## 5. 修复分级

- **L0 自愈**：参数补全 / 路径修正 / 格式纠错——代码级硬修复，零风险，不问用户，`auto=true`。
- **L1 交互**：装依赖 / 切运行时——必问用户获批，`auto=false`。
- **L2 拒绝**：系统核心配置 / 危险命令 / 网络越权——不修，直接降级树。

## 6. 强制兜底报告（Goal3 形状，严格对齐）

```json
{
  "status": "failed",
  "intent": "fetch-web-content",
  "diagnosis": { "error_code": "E05", "cause": "依赖缺失（Node 模块/Python 包未安装）",
                 "reason": "missing-dependency", "risk": "L1",
                 "prescription": "安装依赖 puppeteer（委派 dependency 注册表，命令来自受控表）。",
                 "detail": "…(脱敏)…" },
  "attempted_fixes": [ { "action": "安装依赖 puppeteer…", "result": "failed:network-unreachable", "auto": false } ],
  "salvage_data": "…(降级树各 Plan 抢救到的残料)…",
  "next_action_suggestion": "手动安装依赖 puppeteer… 或改用不依赖它的来源后重试。"
}
```

## 7. 架构

```
selfHeal/diagnosisDictionary.js  六行病因表（单一真源）；处方=展示串，命令不出此门
selfHeal/errorDiagnostician.js   ErrorDiagnostician：failsafe.classify(E0x) + resilience.classifyFailure(reason) + 字典(处方)
selfHeal/deadLoopDetector.js     PrescriptionDeadLoopDetector：处方级熔断（与 resilience 调用级互补）
selfHeal/fixActions.js           受控修复出口：按 fixKind 分派写死逻辑；install 委派 dependency 注册表
selfHeal/microLoopExecutor.js    MicroLoopExecutor：MAX_LOOP=1；repair() 钩子 + runOnce() 独立微循环
selfHeal/fallbackTree.js         FallbackTreeWithHeal：微循环(repair) 注入 resilience 协调器 + 兜底形状转换
selfHeal/index.js                门面；types.d.ts TS 契约
```

## 8. 防呆（硬约束）

- **①微循环上限硬编码 1 次**：`MicroLoopExecutor.MAX_LOOP=1`（不可配置）；resilience 每 Plan 仅调
  `repair()` 一次 + `MAX_RETRY_PER_PLAN=1` 双重保证。
- **②处方只来自字典**：所有安装/执行命令经 `FixActions`，来自 dependency 注册表 / 固定候选集；
  诊断只透出受控标识（依赖名/命令名/路径/端口），**禁止**模型自由生成命令（防注入）。
- **③L2 禁入微循环**：诊断 `fixable=false`（含 `risk=L2` / `refuse` / `degrade-direct`）直接降级，
  连处方都不开。
- **④降级树深度硬上限 3 层**：复用 resilience `MAX_FALLBACK_DEPTH=3`；穷尽仍失败立即触发兜底报告。
- **⑤处方级死循环熔断**：同一条处方（`fixKind:受控标识`，与工具无关）重复开具 → 判无效，
  中断微循环走降级。

## 9. 接入（零侵入）

```js
const { FallbackTreeWithHeal } = require('.../selfHeal');
const { makeToolRunner } = require('.../resilience');
const heal = new FallbackTreeWithHeal({
  runner: makeToolRunner(executeTool),         // 复用全局唯一工具漏斗
  confirm: async ({ diagnosis }) => askUser(diagnosis.action),  // L1 获批
  onDegrade: (text) => injectSystemTurn(text),
});
const out = await heal.run('fetch-web-content', { url, query, control });
// out.status==='ok' ? out.result : out（Goal3 兜底报告）
```

不改 `executeTool` 一行；不外科手术改写 toolUseLoop。

## 10. 验收（26 用例绿，零网络/零真实安装/零真实 FS）

- 诊断字典六行各归正确病因/级别/fixKind + 受控标识抽取；L2 优先；未命中返回 null（不臆造）。
- 诊断器：依赖缺失校正 E05、L2 fixable=false、403 degrade-direct。
- 处方级熔断：同处方第二次 dead=true；签名与工具无关。
- FixActions：retarget→/tmp、switch-runtime 固定候选、probe-only 不算修复、install 委派注入桩。
- 微循环：L0 自愈重试通过（恰一次）、L1 未获批降级、L2 不进循环（attempted 为空、不重试）、
  同处方熔断。
- 全链：Puppeteer 缺失→批准安装→安装失败→降级 WebFetch→403→WebSearch→强制兜底报告（E05/
  attempted_fixes 记安装失败/三 Plan 全走/兜底字段齐全）；自愈成功路径不降级。
- 防呆②：未知错误无处方，兜底不臆造命令。④降级硬上限 3 被复用。

全量 node:test 回归 623/623 绿，零回归。
