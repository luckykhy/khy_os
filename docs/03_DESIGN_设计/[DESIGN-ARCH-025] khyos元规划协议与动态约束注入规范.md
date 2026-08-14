# 《khyos 元规划协议与动态约束注入规范》

> 文档编号：DESIGN-ARCH-025
> 主题：模型自决「执行器选择 + 约束级别」的元规划（Meta-Plan）协议，及其动态约束注入、信任熔断与宪法红线
> 范围：`services/backend` 调度器的**约束注入与执行器**子系统（不触碰核心业务逻辑）
> 关联实现：`src/services/metaplan/*`、`tests/services/metaplan/metaPlanSubsystem.test.js`
> 关联规范：[DESIGN-ARCH-002] CB-SSP（可逆性分层 / 约束格）、[DESIGN-ARCH-024] 元帅双模式任命与约束

---

## 0. 问题陈述

khyos 是「单人 AI 原生 OS」，其 agent 在 JS/Python/混合语言环境中频繁读写代码。此前的执行流存在
两类**僵化逻辑**，损耗灵活性与资源：

1. **系统硬编码指派工具**——`toolCalling.executeTool` 是单一入口，但执行器分发是对
   `descriptor.source` 的硬编码 `switch`（`toolCalling.js:2609-2642`），模型无从根据任务特征
   选择「用 AST 写手还是裸字符串替换」。编辑工具本身（`editFile.js:110-145`）是
   `String.indexOf/slice/split` 的**裸字符串替换，无任何 AST 校验**。
2. **一刀切的约束**——守卫按文件名模式统一施加（`toolGuards.js:358-413`），**无风险分级**；
   `riskGate.assess` 算出了 `stepType` 却只用于审计，未用于分级；`EXECUTION_DISCIPLINE` +
   `HARD_PROHIBITIONS` 被**无条件整段注入**（`generalPurposeAgent.js:34-36`）。

结果是：**低风险操作（改个注释）被冗长安全 Prompt 与潜在重校验拖慢、白烧 Token；高风险操作
（重构异步控制流）却和改注释走同一条裸路径，可能把语法错误直接写进磁盘。**

本规范让**模型在执行前自决**：用哪些执行器、上多重的锁——系统据此**按需配发锁具，绝不提前加锁**。

---

## 1. 设计目标与硬约束

### 1.1 核心诉求（必须满足）

| # | 诉求 | 本方案如何满足 |
|---|------|----------------|
| ① | **极致灵活与极省资源** | 低风险走 `Prompt_Soft`：跳过 AST/沙箱，仅注入一句格式提示，极速执行；高风险走 `Code_Hard`：强制挂载真实 AST 校验，绝不裸奔。锁的轻重与风险严格成比例。 |
| ② | **拒绝偷懒** | 选 `Prompt_Soft` 必须在 `risk_dissent` 给出实质论证；论证缺失/过短由系统**确定性升级**为 `Code_Hard`——模型无法靠跳过论证来省事。 |
| ③ | **闭环自愈** | `Prompt_Soft` 下执行翻车 → 信任熔断把该任务类型强制降级 `Code_Hard`；连续 2 次翻车 → 全会话强制 `Code_Hard`。 |

### 1.2 防呆红线（逐条落到代码，非仅 Prompt）

| # | 红线 | 落点 |
|---|------|------|
| ① | 元规划**必须先于**执行动作输出，严禁「先执行后评估」 | `metaPlanSchema.parseMetaPlan` 解析失败即 `{ok:false}`；`MetaPlanCoordinator.validateExecution` 无票据则拒绝并要求快照+确认 |
| ② | 执行器**必须从注册表挑选**，不可凭空捏造 | `executorRegistry.validateToolchain` 拒绝未注册 id；schema 的 `toolchain.items.enum == registry.executorIds()` |
| ③ | 连续 2 次 `Prompt_Soft` 翻车 → 全会话强制 `Code_Hard` | `trustCircuitBreaker` 连击计数达阈值置 `_sessionLocked` |
| ④ | 宪法级红线**绝不可被元规划覆盖** | `constitutionalRedLines.enforce` 在所有层之后，按动作（非模型自评）匹配，经 `escalate` 单调取严 |
| ⑤ | 只重构**调度引擎/约束注入/执行器层**，不碰核心业务逻辑 | 全部新增代码自成 `src/services/metaplan/`，零侵入既有工具循环 |

---

## 2. 元规划协议（§2 `constraint_strategy` 自决）

模型在任何写入前必须先产出一份元规划 JSON：

```json
{
  "toolchain": ["js_babel_writer"],
  "constraint_strategy": "Prompt_Soft | Code_Hard | System_Block",
  "risk_dissent": "若选 Prompt_Soft，必填的风险论证"
}
```

- `toolchain`：从武器库（§4）挑选的执行器组合，按应用顺序。enum 来自**活注册表**。
- `constraint_strategy`：自决约束级别，严格枚举三档。
- `risk_dissent`：**防偷懒关键**。选 `Prompt_Soft` 必须一句话论证「绝不引发语法崩溃或逻辑污染」。

### 2.1 三级约束阶梯（单调升级格）

```
Prompt_Soft  ⊏  Code_Hard  ⊏  System_Block
   rank 0         rank 1         rank 2
```

`escalate(a,b)` 取更高 rank（最小上界 LUB）。**任何 override 层（熔断、红线）只能加锁，不能减锁**——
这是「强制接管只能加锁」的数学保证（`constraintStrategy.js`）。未知策略按最严 `System_Block` 处理（fail-safe）。

### 2.2 防偷懒升级（`metaPlanSchema.validateMetaPlan`）

若 `declared === Prompt_Soft` 且 `risk_dissent.length < KHY_METAPLAN_MIN_DISSENT`（默认 12 字）：
→ `effective = escalate(Soft, Code_Hard)`，并把原因写入 `escalations[]`。模型「连论证都懒得写」即被夺去快路径。

---

## 3. 动态约束注入引擎（§3 按需配发锁具）

`constraintInjection.resolveInjection(plan)` 把策略翻译为「挂什么锁」，**不提前加锁**：

| 策略 | mountInterceptors | requireSnapshot | requireConfirmation | promptHint | 语义 |
|------|------------------|-----------------|---------------------|-----------|------|
| `Prompt_Soft`  | ❌ | ❌ | ❌ | 一句格式提示 | 跳过 AST/沙箱，极速、最省 Token |
| `Code_Hard`    | ✅ | ❌ | ❌ | — | 挂载执行器代码拦截器，校验不过坚决打回 |
| `System_Block` | ✅ | ✅ | ✅ | — | 系统级挂起，须先备份快照 + 确认才放行；并仍挂代码校验（双保险） |

`runHardValidation(plan, content, ctx)` 对 `Code_Hard/System_Block` 真正跑拦截器；`Prompt_Soft` 直接放行
（`ranValidation:false`）——这正是「低风险绝不被重算力拖慢」。

### 3.1 真实代码拦截器（`codeInterceptors.js`，非桩）

| 校验器 key | 实现 | 适用 |
|-----------|------|------|
| `babel`        | `@babel/parser`（项目已装），失败回退内置 `vm` 编译探测 | JS/TS/JSX |
| `python_ast`   | `spawnSync python3 -c "import sys,ast; ast.parse(sys.stdin.read())"` | Python |
| `vm_or_native` | JS 走 `vm`、Python 走 ast、其它语言退化为括号/引号配平探测 | 跨语言 |
| `null`         | 不校验（裸执行器，风险自担） | 注释/文案 |

**Fail-safe 原则**：解析器缺失或 python3 不可用 → 返回 `{ok:true, skipped:true}`，**降级到「不比今天更差」**，
绝不因工具链缺失而卡死 agent。校验器永不向上抛异常。

---

## 4. 混合语言执行器注册表（§4 武器库）

`executorRegistry.EXECUTORS`（闭集，单一真源）：

| id | 语言边界 | astSafetyNet | validator | 适用 |
|----|---------|-------------|-----------|------|
| `js_babel_writer`      | js/ts/jsx/tsx | ✅ | `babel`        | 重构核心逻辑 |
| `py_ast_replacer`      | python        | ✅ | `python_ast`   | Python，保障缩进/语法 |
| `generic_syntax_writer`| 任意          | ✅ | `vm_or_native` | 跨语言，能力依赖语言 |
| `raw_string_injector`  | 任意          | ❌ | `null`         | 仅正则/字符串替换，无 AST，极快但风险自担（改注释/文案）|

`describeForModel()` 从注册表生成元规划 Prompt 里的菜单——**模型可选项 == 注册表**，杜绝凭空捏造（防呆②）。

---

## 5. 信任熔断与宪法红线（§5 防线兜底）

### 5.1 信任熔断状态机（`trustCircuitBreaker.js`）

- **信任扣分（按任务类型）**：`declared === Prompt_Soft` 且执行 `ok:false` → 该 `taskType` 入
  `_distrustedTypes`，后续同类强制 `Code_Hard`。
- **会话级接管**：连续 `_consecutiveSoftFailures >= 阈值`（默认 2，`KHY_METAPLAN_SESSION_TRIP` 可调）
  → `_sessionLocked=true`，全会话所有操作强制 `Code_Hard`。
- **关键区分**：`Code_Hard/System_Block` 下失败**不算误判**（安全网生效，非信任违约）；`Prompt_Soft`
  下成功**重置连击计数**。仅「裸奔下翻车」才扣信任。

### 5.2 宪法级红线（`constitutionalRedLines.js`，不可覆盖）

按**具体动作**（tool+params/command/path/content）匹配，**无视模型自评**，强制 `System_Block`：

1. **删库**：`DROP/TRUNCATE TABLE`、`drop database`、删除 `*.db|*.sqlite|*.ibd` 等数据文件。
2. **暴露机密**：删除/外泄 `.env`/`*.pem`/`id_rsa`/`secrets`，或把疑似 AWS Key/私钥/凭证写入外发或日志。
3. **删 package.json 核心依赖**：删除/清空 `package.json`，或写入使 `dependencies` 块清空。

红线经 `escalate` 叠加，结果恒为 `{model, 熔断, 红线}` 三者中最严——绝不可被模型放松（防呆④）。

---

## 6. 编排闭环（`MetaPlanCoordinator`，§6）

```
renderMetaPlanPrompt(action)            // 1. 先产出元规划（防呆①）；菜单来自注册表（防呆②）
  → ingestMetaPlan(rawOutput, action)   // 2. 解析→防偷懒升级→熔断地板→宪法红线→解析注入计划
       → validateExecution(ticket,cand) // 3. 跑拦截器；Soft 快放行；Block 报快照/确认要求
            → recordExecutionOutcome     // 4. 喂熔断器，自决失误自动补救（闭环自愈）
```

`ingestMetaPlan` 的 override 叠加顺序：模型自评（含防偷懒升级）→ 熔断地板 → **宪法红线置于最后**，
使其不可覆盖性一目了然。每层只经 `escalate` 取严，单调不可逆。

---

## 7. 验证（§6 同一任务不同风险 → 不同策略）

`tests/services/metaplan/metaPlanSubsystem.test.js`（31 例全绿）关键断言：

- **同一 JS 文件**：改注释（`Prompt_Soft` + 充分 dissent）→ 跳过校验、极速；重构异步控制流
  （`Code_Hard`）→ 真 babel 校验，坏代码 `async function f(){ await (` 被打回，正确代码通过。
- **防呆①**：无元规划 JSON → 拒绝执行。
- **防呆②**：`ghost_writer_9000` 等捏造执行器 → 拒绝。
- **拒绝偷懒**：`Prompt_Soft` + `risk_dissent:"ok"` → 升级 `Code_Hard`。
- **防呆③**：连续 2 次 Soft 翻车 → 全会话 `Code_Hard`。
- **防呆④**：选 `Prompt_Soft` 但 `rm app.sqlite` → 强制 `System_Block` + 要求快照/确认。
- **闭环自愈**：Soft 翻车后，同类型任务下一次自动被熔断器升 `Code_Hard`。

---

## 8. 边界与后续

- 本子系统是**协议与注入层**：提供 `MetaPlanCoordinator` 供调度器在工具执行前调用，但**不强行接管**
  既有 `executeTool`（防呆⑤零侵入）。接入点为后续单独 PR，按 [DESIGN-ARCH-024] 同样的渐进策略。
- `System_Block` 的「备份引擎打快照」当前以 `requireSnapshot/requireConfirmation` 标志暴露契约，
  实际快照可复用 `rollbackService`（接线时绑定）。
- 执行器目前 4 个；新增执行器只需在注册表登记 + 在 `codeInterceptors` 提供 validator，schema/prompt 自动同步。
