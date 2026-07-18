# 《khyos 系统级服务调用审批网关规范》

> 文档编号：DESIGN-ARCH-026
> 主题：以「意图声明」为中心的能力隔离 + 三级审批矩阵 + 工作流预审批 + 最小权限与越权熔断，确保模型**永远无法绕过用户授权操作宿主系统核心资源**
> 范围：`services/backend` 的**底层工具调用接口与安全网关层**（不触碰核心业务逻辑 / 提示词 / 模型调用逻辑）
> 关联实现：`src/services/syscallGateway/*`（含 `approvalRouter.js` 的 `cause`、`denialGuidance.js`）、`src/constants/riskOrder.js`（五级风险词汇单一真源）、`src/services/toolCalling.js`（`executeTool` 单一咽喉接管）
> 关联测试：`tests/services/syscallGateway.scenarios.test.js`、`tests/services/denialGuidance.test.js`、`tests/services/riskVocabulary.test.js`
> 关联规范：[DESIGN-ARCH-002] CB-SSP（约束格 / 可逆性分层）、[DESIGN-ARCH-025] 元规划协议与动态约束注入、[OPS-MAN-060] 高危操作为何被拒与如何放行

---

## 0. 问题陈述

khyos 是「单人 AI 原生 OS」，其 agent 通过工具调用直接触达宿主系统：读写文件、起子进程、发网络
请求、改环境变量、装包、监听端口。此前所有工具最终都汇聚到 `toolCalling.executeTool` 这一单一入口，
但其权限判定（`requestPermission`）以**工具名 + 静态风险标签**为粒度，存在三个结构性缺口：

1. **能力未隔离**——模型生成的工具调用可携带任意参数（含 `force:true`、`--yes`），权限层未系统性
   识别「数据层夹带的免审语义」，存在被旁路的攻击面。
2. **风险粒度粗**——同名工具（如 `shell_command`）既能 `ls` 也能 `rm -rf /`，但走同一审批路径；
   破坏性操作可能与无害操作享受同一「记住选择」豁免。
3. **授权易越界 / 易续命**——一次批准可能跨任务、跨会话长期有效，违背最小权限。

本规范引入一道**系统级服务调用审批网关**：模型/执行器**只能声明意图，不能执行动作**；每一次触达
宿主系统的调用都被规约成结构化《意图声明》，由网关按三级矩阵裁决。**fail-closed 是贯穿全层的铁律
——网关自身任何异常都判 DENY，绝不因网关崩溃而放行。**

---

## 1. 危险源自调查清单（原始系统调用面盘点）

对 `services/backend` 工具层与执行器做了一次自调查，归纳出会触达宿主核心资源的原始调用面，并映射到
网关的规约动作（`ACTIONS`）：

| 危险源（原始能力） | 典型载体 | 规约动作 | 默认级别 |
|---|---|---|---|
| 删除 / 截断文件 | `rm`/`rmdir`/`unlink`/`rimraf`/`dd if=`、`deleteFile` 工具 | `DELETE` | **L2** |
| 杀进程 | `kill`/`pkill`/`taskkill` | `KILL` | **L2** |
| 改宿主环境变量 | `export`/`setx`/`set X=`、`process.env` 写 | `ENV` | **L2** |
| 全局装包 | `npm i -g`/`pip install`/`apt install`/`brew install`/`cargo install` | `INSTALL` | **L2** |
| 监听物理端口 | `listen`/`nc -l`/`socat`/`--port` | `LISTEN` | **L2** |
| 执行任意代码 | `executeCode`/`evalCode`/`pyExec` | `EXEC_CODE` | **L2** |
| 写系统级路径 | `writeFile`/`editFile` 指向项目与家目录之外 | `WRITE`+`SYSTEM` | **L2** |
| 写项目 / 家目录内文件 | `writeFile`/`editFile`/`mkdir`/`move` | `WRITE` | **L1** |
| 网络出站 | `fetch`/`webFetch`/`webSearch`/`curl` | `NETWORK` | **L1** |
| 起本地子进程（非红灯命令） | `shell_command`/`bash` 其余命令 | `PROCESS` | **L1** |
| 读系统级路径 | `readFile`/`cat` 指向系统路径 | `READ`+`SYSTEM` | **L1** |
| 项目 / 家目录内只读 | `readFile`/`glob`/`grep`/`stat` | `READ` | **L0** |

> **保守优先原则**：任何无法可靠归类的调用一律落 **L2**（红灯）。宁可多问一次，绝不少拦一次——
> 这是「零隐式提权」的数学下界。

---

## 2. 设计目标与硬约束（防呆①–⑤）

| # | 诉求 | 本方案如何满足 | 落点 |
|---|------|----------------|------|
| ① | **绝不允许硬编码跳过审批** | `detectBypassMarkers` 扫描参数键名（`force`/`yes`/`skipApproval`…）与命令 flag（`--yes`/`-f`/`--force`…），命中即判旁路企图，**一次即熔断 + 拒绝**，零容忍 | `intentSchema.js` / `breachBreaker.reportBypass` |
| ② | **L1 免审授权绝不跨会话** | 会话免审与预审批清单**只活在内存**，绝不写盘；`resetSession`/进程退出即归零 | `permissionCache.js`（无任何 `fs` 引用） |
| ③ | **拦截 L2 时绝不能只按回车确认** | L2 必须**严格键入确认串**（默认 `YES`）；`''`/回车/小写 `yes` 一律不通过（严格全等比对） | `approvalRouter.route` L2 分支 |
| ④ | **网关崩溃不得放行** | 规约 / 分级 / 路由 / 门面任一层异常都落 DENY；接线层 `try/catch` 包裹，网关不可用时回落既有管线（其自身亦 fail-safe），**绝不静默放行** | 全层 `try/catch` + `evaluate` 兜底 |
| ⑤ | **只重构底层接口与安全网关层** | 仅在 `executeTool` 的 `requestPermission` 之前插入网关；**只增加拒绝，不放松既有保护**；不碰提示词 / 模型调用 / 业务逻辑 | `toolCalling.js` 单点接线 |

---

## 3. 能力隔离架构

```
模型 / 执行器
   │  生成工具调用（只能"声明意图"）
   ▼
executeTool (单一咽喉)
   │  ① buildIntent → 结构化《意图声明》(tool/action/scope/resource/risk/...)
   │  ② validateIntent → detectBypassMarkers（防呆①）
   ▼
SyscallGateway.evaluate (单一裁决权威)
   ├─ 熔断优先：已跳闸 → 全拒（连 L0）
   ├─ classify → L0 / L1 / L2
   ├─ approvalRouter.route：
   │     L0 → 自动放行（仅日志）
   │     L1 → 命中清单/免审→放行；否则问一次（once/session/deny）
   │     L2 → 强制挂起，必须键入 YES；非交互→fail-closed
   └─ 裁决
        ├─ deny  → 立即拦截（根本不进入 requestPermission）
        └─ allow → 盖不可伪造 EXEC_APPROVED Symbol 戳
   ▼
requestPermission（既有管线，识别 EXEC_APPROVED 免二次打断）
   ▼
真正执行
```

**核心不变量**：模型无法伪造 `EXEC_APPROVED`（Symbol 不可经 JSON 参数构造）。网关是唯一能盖戳的主体，
因此成为单一裁决权威；同时网关**只能追加拒绝**——allow 时仍交还既有管线，deny 时直接短路，绝不弱化
既有 critical 红线 / permissionStore / 守卫等保护。

---

## 4. 三级审批矩阵

| 级别 | 语义 | 触发条件 | 处置 | 可免审？ |
|---|---|---|---|---|
| **L0 绿灯** | 低风险读取 | 项目/家目录内只读、取系统时间、列非敏感目录 | **自动放行 + 记日志** | 本就无需 |
| **L1 黄灯** | 有限写入 / 网络 | 项目/家目录内写、网络出站、起本地非破坏性子进程、读系统级路径 | **问一次**（仅此次 / 本会话同类免审 / 拒绝） | ✅ 会话内 |
| **L2 红灯** | 毁灭性 / 不可逆 / 系统级 | 删除、杀非 khyos 进程、改宿主环境变量、全局装包、监听端口、执行任意代码、写系统级路径 | **强制挂起，必须键入 `YES`** | ❌ 永不 |

> L2 的「不可免审」是分级层的硬不变量：`isExemptible(L2) === false`，被 `permissionCache`（清单 / 会话免审）
> 与 `approvalRouter`（路由）双重保证——红灯无快捷键。

---

## 5. 工作流预审批（《权限申请清单》）

模型在元规划阶段可一次性提交《权限申请清单》（`[{action, scope}]`），网关用**真实分级器**逐项评估：

- **L2 条目静默拒收**——清单永远无法批准红灯（即便调用方伪造 `level: 'L0'`，分级器以真实语义复算）。
- L0/L1 条目纳入清单后，**清单内同类动作自动放行**，不再逐次打断——解决体验断裂。
- 范围比对刻意粗到「类」（`level:action:scope`）而非具体资源：「允许写项目内文件」覆盖项目内所有写，
  但**绝不溢出**到家目录或系统级。

清单同样**只在内存**，随会话销毁。

---

## 6. 最小权限与越权熔断

### 6.1 最小权限
- 每个 `sessionId` 一套独立 `{ 权限缓存, 熔断器 }`，全程内存。
- 授权（会话免审 + 预审批清单）**仅在单次宏任务 / 会话内有效**；`resetSession` 或进程退出即清零，
  **绝不跨会话 / 跨重启续命**（防呆②）。

### 6.2 越权熔断（`breachBreaker`）
两类越权信号触发跳闸：
1. **旁路注入**（`force:true`/`--yes`…）——**一次即跳闸**，零容忍。
2. **L2 反复硬闯**——同会话被拒 L2 累计达阈值（默认 3）——判定磨穿红线，跳闸。

> **熔断只计「真·硬闯」，不计「环境性拒绝」（重要澄清）。** L2 被拒有两种性质迥异的来源：
> 一是模型**反复硬闯红线**（旁路注入、确认串不匹配、用户主动拒），这才是攻击信号，照常计数；
> 二是**环境从未提供批准通道**——在非交互 / 自主（Goal）/ 管道 / 后台场景下没有弹窗键入 `YES`
> 的通道，网关按 fail-closed **自动拒绝**。后者是**环境限制，模型无过错**。若把两者混为一谈，三个
> 互不相关的合法高危操作在 headless 下撞了三次「环境从没给过的门」，就会把整个会话砖掉（跳闸后
> 连只读 L0 也全拒）。因此网关为每个 DENY 附结构化 `cause`（`approvalRouter.js`），`index.js`
> 仅当 `cause !== 'no-interactive-channel'` 时才计入熔断。此行为经 `KHY_GATEWAY_BREAKER_SMART`
> 门控（默认开；`=off` 逐字节回退「所有 L2 被拒都计数」的历史行为）。**注意：这不放松任何红线**
> ——旁路注入仍一次即熔断，确认串不匹配 / 用户拒仍照常计数并可跳闸，L2 仍必须键入 `YES`。
>
> 环境性拒绝时，网关还会经 `denialGuidance.js`（门控 `KHY_GATEWAY_DENIAL_GUIDANCE`，默认开）
> 向 `reasons[]` 追加**可执行指引**（「为什么被拒 + 三条合规放行途径」），随工具错误转述给用户，
> 而非仅冷冰冰地拒绝。放行途径详见 [OPS-MAN-060]。

跳闸后果：
- 整条流程标记高危；此后**所有调用一律拒绝（连 L0）**——熔断优先于一切。
- **强制终止本会话登记在册的子进程**（killer 可注入，绝不误杀宿主 / khyos 自身；killer 异常不反噬熔断）。
- 熔断**不可在会话内自愈**，只能随会话整体 `reset`——对齐「重启即归零」语义。

---

## 7. TUI / 宿主交互审批契约

网关通过 `makeControlPrompter(onControlRequest)` 适配既有宿主交互通道（Ink TUI / Web）：

- **L1**：弹一次审批，`allow → 仅此次`、`allow-always → 本会话同类免审`、`deny → 拒绝`。
- **L2**：要求宿主回传**用户键入的确认串**（`response.typed`）。既有仅 `allow/deny` 的宿主**取不到该串
  → 视为未确认 → fail-closed 拒绝**（防呆③④）。

> 该契约**不要求修改 TUI 即可安全运行**：未实现键入确认的宿主下，L2 恒拒绝（安全方向）。后续可在 Ink
> PermissionsPrompt 增加 L2 键入确认输入框，回传 `{ typed }` 即接通——属安全网关层的渐进增强，不触业务热区。

---

## 8. 三场景验证

| 场景 | 级别 | 预期 | 测试 |
|---|---|---|---|
| 尝试删除文件 `rm important.txt` | L2 | 仅严格键入 `YES` 放行；回车/空/小写一律拒；非交互 fail-closed | ✅ |
| 尝试全局安装 `npm i -g http-server` | L2 | 强制挂起；交互异常 → fail-closed 拒绝 | ✅ |
| 正常写入 `<project>/src/note.txt` | L1 | 问一次；会话免审后第二次同类不再询问；跨会话重新询问 | ✅ |

附加防呆回归：旁路注入熔断、反复硬闯熔断+清场、清单拒收 L2、L2 永不命中清单、控制通道适配。
**全 27 测试离线确定性通过（零网络 / 零真实文件系统 / 全同步桩）。**

---

## 10. 风险词汇统一与 5→3 映射

用户反馈「风险层级划分不清楚」。根因是仓库并存**多套风险词汇**，而 5 级 → 3 级的映射规则隐式散落
在分级器代码里、从未成文。本节把它显式化。

### 10.1 词汇对照表（各套的用途 / 边界 / 归属）

| 词汇 | 取值 | 用途 | 归属子系统 |
|---|---|---|---|
| `RISK_ORDER` / `RISK_LEVELS`（**单一真源**） | `safe/low/medium/high/critical`（序数 0–4） | 五级风险的**唯一权威定义**（字符串词汇 + 升序序数） | `constants/riskOrder.js`（零依赖叶子） |
| `_baseTool.RISK_LEVELS` | 同上（数组） | 工具静态声明的风险标签校验 | `tools/_baseTool.js`（**直接复用真源**） |
| `toolCalling.RISK_LEVELS` | 同上（对象，附 `label/color/autoApprove`） | 工具风险的展示与自动放行标志 | `services/toolCalling.js`（键集 === 真源，防漂移测试固化） |
| `execApproval.RISK` | `low/medium/high/critical`（**无 safe**） | 命令（shell）风险分级 | `services/execApproval.js`（真源子集，见 §10.3） |
| `syscallGateway.LEVELS` | `L0/L1/L2` | **审批矩阵**的三级裁决口径（本规范 §4） | `services/syscallGateway/*` |
| `capacityFlow.CapacityRiskLevel` | `low/medium/high/critical` | **上下文窗口健康度 / 工具循环状态漂移**分级（容量调度域） | `services/capacityFlow.js` |

> **显式排除**：`capacityFlow.CapacityRiskLevel` 属**容量 / 上下文健康域**，与本网关的**安全审批完全
> 正交**——它只是恰好复用了 low/medium/high/critical 四个词。为消歧，其规范名已从 `RiskLevel` 重命名为
> `CapacityRiskLevel`（保留 `RiskLevel` 向后兼容别名），头部注释显式声明域边界。**读到 `CapacityRiskLevel`
> 时不要与安全风险混淆。**

### 10.2 5 级 → 3 级审批矩阵映射表

安全审批的三级（L0/L1/L2）**不是**五级风险词汇的简单重命名，而是由 **action / scope / 破坏性 / 风险标签**
共同决定。核心映射：

| 五级风险标签 | 叠加条件（action / scope / 破坏性） | → 审批级别 |
|---|---|---|
| `safe` / `low` | 只读（`READ`），项目/家目录内 | **L0 绿灯** |
| `medium` / `high` | 项目/家目录内写（`WRITE`）、网络出站（`NETWORK`）、起本地非破坏性子进程（`PROCESS`）、读系统级路径 | **L1 黄灯** |
| `critical` **或** `isDestructive` **或** 系统级写/删/装/杀/执行代码/监听端口/沙箱逃逸 | 任一命中 | **L2 红灯** |

### 10.3 为何 `critical` 恒 L2，而单纯 `high` 可能只是 L1（关键澄清）

这正是「层级划分不清楚」的根源——**L 级取决于操作的 action + scope + 破坏性，而不只是 risk 标签**：

- **`critical` 恒 L2**：`critical` 语义即「毁灭性 / 不可逆」，无论 scope 如何都落红灯。保守优先原则下，
  任何无法可靠归类的调用也一律落 L2（§1 尾注）。这是「零隐式提权」的数学下界，不可放松。
- **`high` 不必然 L2**：一个标注 `high` 的操作若其 action 是**项目内写**或**网络出站**（scope 受限、
  可逆），仍归 **L1**（问一次即可）；只有当它同时带**破坏性 / 系统级 scope** 时才升到 L2。换言之，
  风险标签是**一个输入**，最终级别由 `resourceClassifier.classify()` 综合 action/scope/破坏性判定。
- **命令无 `safe` 层**（§10.1 中 `execApproval.RISK` 缺 `safe`）：shell 命令天然有副作用，风险自 `low`
  起，`safe` 仅适用于纯只读**工具**。这是**有意**设计而非遗漏（`riskVocabulary.test.js` 固化此断言）。

> **一句话记忆**：*risk 标签回答「这操作有多危险」，L 级回答「要不要拦、怎么拦」；后者综合了前者与
> 「改什么、改哪、可不可逆」。* 破坏性 / 系统级永远压倒一切直达 L2。

### 10.4 防漂移

五级词汇的单一真源是 `constants/riskOrder.js`；各消费者（`_baseTool` / `toolCalling` / `execApproval`）
与真源的一致性由 `tests/services/riskVocabulary.test.js` 固化为回归断言，任一处词汇漂移即测试失败。

---

## 11. 红线与维护（无 AI 也能维护）

- **唯一真源**：动作/作用域枚举在 `intentSchema.js`；级别矩阵在 `resourceClassifier.js`；五级风险词汇在
  `constants/riskOrder.js`；三者改动须同步本规范第 1、4、10 节。
- **总开关**：`KHY_SYSCALL_GATEWAY=off` 显式关闭（回退纯既有管线）；默认开启。相关子门控：
  `KHY_GATEWAY_BREAKER_SMART`（熔断排除环境性拒绝，默认开）、`KHY_GATEWAY_DENIAL_GUIDANCE`
  （拒绝时附可执行指引，默认开）——二者 `=off` 均逐字节回退历史行为。
- **不可弱化项**：保守优先（未知 → L2）、L2 不可免审、fail-closed、授权不落盘、旁路注入零容忍熔断——
  任一被改动即视为破坏安全下界，必须在 PR 显式论证并更新测试。
- **面向操作者**：高危被拒的排查与三条合规放行途径见 [OPS-MAN-060]。
