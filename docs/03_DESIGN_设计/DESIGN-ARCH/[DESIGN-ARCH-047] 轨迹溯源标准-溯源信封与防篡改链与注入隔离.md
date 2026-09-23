# [DESIGN-ARCH-047] 轨迹溯源标准 — 溯源信封、防篡改哈希链与注入隔离

状态：已实现（PHASE 1–5 全闭环；用户需求「经其他 agent 中转时防轨迹投毒 + 人机双可读的轨迹标准」）
依赖前序：
- [DESIGN-ARCH-026] khyos 系统级服务调用审批网关（中转工具调用复用同一权限闸）
- [DESIGN-ARCH-031]/[DESIGN-ARCH-045] 网关日志租界与日志越权阻断（`khy trace` 可见性约束，隔离原文不回显）
- [DESIGN-ARCH-022] 多实例跨进程文件锁（sidecar 链原子写思路）

实现位置：
- `services/backend/src/services/trajectoryProvenance/`（新核子系统，6 纯模块 + barrel）
  - `khyTrace.js`——`_khyTrace` 信封 schema 单一真源（producer/trust/kind 枚举 frozen）
  - `provenanceClassifier.js`——入站 adapter/provider 信号 → producer/trust 分类
  - `traceProjection.js`——规范记录 →(a)内联标签 (b)`khy trace` 回放行（确定性，纯函数）
  - `traceChain.js`——防篡改 sidecar 哈希链（镜像 `evoEngine/evoLedger`）
  - `quarantinePolicy.js`——中转工具调用隔离决策（纯，env 闸 + fail-CLOSED）
  - `claimReconciler.js`——正文动作声称 vs 本地工具日志的确定性核对（无模型，fail-OPEN）
- `services/backend/src/services/sessionPersistence.js`——`appendMessage` 盖 `_khyTrace` + 落 sidecar 链；新增只读 `verifyTraceChain`
- `services/backend/src/services/gateway/adapters/codexAdapter.js`——移除 codex-direct 无条件全局 dangerous mode，改走隔离闸
- `services/backend/src/cli/ai.js`——助手 turn 持久化 seam 串溯源分类 + 正文矛盾核对
- `services/backend/src/cli/tui/hooks/useQueryBridge.js`、`ink-components/ToolLines.js`——透传并渲染 `_khyTrace` 内联标签
- `services/backend/src/cli/handlers/trace.js`（新）+ `router.js` + `constants/commandSchema.js` + `cli/aliases.js`——`khy trace` 命令接线

验收测试（node:test，仿 evoEngine 布局；共 75 例）：
- `tests/services/trajectoryProvenance/p1Labels.test.js`（22 例：信封 schema + 分类矩阵 + 标签快照）
- `tests/services/trajectoryProvenance/p2Chain.test.js`（12 例：append/verify/篡改定位 + appendMessage 端到端落链 + fail-soft）
- `tests/services/trajectoryProvenance/p3Quarantine.test.js`（16 例：env 解析 + decide 矩阵 + 不变式断言 + codexAdapter 结构守卫）
- `tests/services/trajectoryProvenance/p4Reconcile.test.js`（16 例：6 动作族双语 + 壳命令满足 + 失败工具 + 确定性 + fail-open）
- `tests/services/trajectoryProvenance/p5Trace.test.js`（9 例：verifyTraceChain 三态 + 投影确定性 + handler 只读 + 隔离不回显）
- `tests/cli/router.test.js`（+ `trace`/`trace verify`/别名 `轨迹`·`gj`/`轨迹 verify` 解析，47 例全绿）

---

## 1. 威胁模型：经外部 agent 中转的轨迹投毒

KhyOS 可把请求**经任意外部 agent 中转**（codex / claude-code / 任意中转 provider）。外部 agent 回传的内容会流进
KHY 自己的对话轨迹。现状是「半防御」的信任边界（已对代码核实）：

| 面 | 现状 | 风险 |
| --- | --- | --- |
| 工具**结果** | 已被不信任——KHY 一律丢弃外部结果、本地重跑 | ✅ 保留 |
| 工具**调用请求** | 照单全收并直接驱动本地执行 | **调用注入** |
| 助手**正文 + thinking** | 原样存轨迹、原样渲染，无溯源、无核对 | **夹带伪造**（正文写「我已删库 / 测试全过」却从未发生） |
| codex-direct 执行 | 执行前强开全局 dangerous mode 自动批准 | **无人值守执行** |
| JSONL transcript | 无溯源标记、无防篡改 | 本地验证过的 turn 与外部「声称」的 turn 人机皆不可分 |

**目标产出**：一套轨迹溯源标准——每条轨迹条目带 `_khyTrace` 信封（谁产的 / 可信级别 / 是否本地验证），
防篡改哈希链，主动隔离注入调用，确定性正文矛盾核对；同一份结构化记录，机器读 JSONL，人读确定性标签视图 +
`khy trace` 命令。

---

## 2. `_khyTrace` 信封 schema（`khyTrace.js` 单一真源）

```
PRODUCER = { KHY_LOCAL:'khy-local', CODEX:'codex', CLAUDE_CODE:'claude-code', RELAY:'relay' }
TRUST    = { VERIFIED:'verified', CLAIMED:'claimed', QUARANTINED:'quarantined' }
KIND     = { TEXT, THINKING, TOOL_CALL, TOOL_RESULT }
_khyTrace = { v:1, producer, producerId, trust, kind, at, contradictions:[], seal }
```

确定性人读字形（`traceProjection`）：

| trust | 字形 | 含义 |
| --- | --- | --- |
| VERIFIED | `✓ KHY executed` | KHY 本地亲自执行/产生 |
| CLAIMED | `⟳ {producer} claims`（带 id 时 `⟳ relay:up1 claims`） | 外部 agent 声称，未本地验证 |
| QUARANTINED | `⚠ quarantined` | 中转调用被隔离，未执行 |
| 矛盾 | `⚠ unverified claim: "X" (no Delete ran)` | 正文声称的动作无对应本地成功工具 |
| 链 | `✓ chain intact (N entries)` / `⚠ chain broken @ #K — reason` / `chain: unavailable` | 链校验页脚 |

**双向防呆姿态**（§5 红线 1 的具体化）：
- **标注层 fail-SAFE-TO-OURS**：缺 trace ⇒ 默认 `khy-local/verified`，绝不把本地内容误标为外部。
- **执行层 fail-CLOSED**：只有显式 `khy-local` 才视为可信；未知/缺失 producer → 隔离。
  即 `quarantinePolicy._isRelayedForExec(p) === (p !== PRODUCER.KHY_LOCAL)`，与标注层取向相反。

---

## 3. 分阶段（每阶段独立可测可叫停）

### PHASE 1 — 溯源标签（基线，ALWAYS-ON，非侵入）
每条轨迹条目带 `_khyTrace`；机器读 JSONL 字段，人见内联标签。**不改派发行为**。
- 分类：producer ← adapter 身份（原生→KHY_LOCAL；allow-list claude-code/codex/relay）；非 KHY 的正文/thinking→CLAIMED。
- 串接：`appendMessage` 接受 `msg._khyTrace`（显式优先），否则据 role + `_khyProvenance` 提示 `makeTrace` 盖戳写成 JSONL 顶层字段（增量、向后兼容，旧 reader 忽略未知字段）。
- 人读：`useQueryBridge.projectToolResultForView` 仿 `_khyWriteDiff` 透传 `_khyTrace`；`ToolLines.js` 渲字形。

### PHASE 2 — 防篡改哈希链（ALWAYS-ON，fail-soft）
检测 transcript 事后被改/被插；**只告警不阻断**。
- 决策：**镜像 evoLedger 做 sidecar 链**（`<session>.trace-chain.json`），不折进 JSONL 行。理由：JSONL append-only、多消费者，逐行嵌 prevHash 会把每个 reader 耦合进链算、单行损坏污染重建。
- 链记录确定性 hash over `{seq,uuid,prevHash,producer,trust,contentHash,at}`；`contentHash=sha256(内容)` 把消息绑进链而不拷贝正文。`verify()` 定位首坏块；`verifyAgainstEntries()` 交叉核对盘上 JSONL 正文（抓「改正文」「删行」）。
- 另有进程私有 HMAC `seal`（仅活会话内增益，**不参与跨进程 verify**，避免读不出 seal 误报断链）。
- 接线：`appendMessage` 写完 JSONL 行后 `traceChain.append(...)`，**try/catch best-effort——链失败绝不让消息写入失败**。

### PHASE 3 — 隔离注入调用（GATED，安全核心）
中转工具调用请求**必须走常规权限/审批闸**；**杀掉 codex-direct 静默自动批准**，且不破坏合法本地 agent loop。
- 区分中转 vs 本地：旧 `toolCalling._dangerousMode` 进程级、origin-blind = 漏洞根。改用 `_khyTrace.producer`，`!=khy-local` 即「中转」。
- `codexAdapter.js`：**移除** executeTool 循环外那圈无条件 `enableDangerousMode()`；每个中转 functionCall 经 `quarantinePolicy.decide()` 裁决——本地→ALLOW、闸关（逃生口）→ALLOW、已预批准→ALLOW、交互→GATE、非交互且无批准→QUARANTINE（返工具结果 error、标 `trust=QUARANTINED`、发 `⚠ quarantined`，**绝不自动跑**）。
- 闸：env `KHY_TRAJECTORY_QUARANTINE`（默认 **ON**；`=0/false/off/no` 迁移逃生口）。
- 不变式断言：`assertNoAutoDangerous()`——origin=relay 且闸开且将自动开 dangerous ⇒ throw，codex-direct 永不再静默翻全局 dangerous mode。

### PHASE 4 — 正文矛盾核对（ALWAYS-ON，fail-OPEN，无模型调用）
中转正文标 CLAIMED；确定性把动作声称与本地 `toolCallLog` 交叉核对；矛盾发 `⚠ unverified claim`。
- `claimReconciler.js`：版本化**中英双语 动词→工具族** allow-list 词库（delete/write/edit/test/commit/deploy 6 族，纯正则）；每条声称查本地日志是否有同族**成功**工具（认 `success===true` 或 `result.success===true`，含壳命令满足）；缺/失败 → 矛盾 `{claim,expectedTool,found:false}` 写入 `_khyTrace.contradictions`。
- **fail-OPEN**：仅咨询性，任何异常/畸形输入 → 空矛盾，绝不阻断 turn、绝不改模型正文。
- 接线（`ai.js`）：仅当 producer != khy-local 时对中转正文跑，结果注入 `_khyProvenance.contradictions` → `appendMessage` → `_khyTrace.contradictions` → 投影。

### PHASE 5 — 人机双投影 + `khy trace` 命令
一条规范结构化记录（JSONL `_khyTrace` + sidecar 链），两个渲染器。
- (a) 内联（P1/P4 已做）。(b) `khy trace` 只读命令：
  - `khy trace` / `trace show [session]`——回放整条轨迹（字形 + 矛盾标记 + 链状态页脚）
  - `trace list`——列出会话 + 各自链完整性
  - `trace verify [session]`——只跑链校验
- 接线：`commandSchema` 加 `'trace'` 命令 + `trace:['list','show','verify']` 子命令；`router.js case 'trace'`；别名 `'轨迹'`/`gj`（裸别名，router 守卫保 `轨迹 verify` 仍路由 `trace verify`）。
- 路径解析复用 `sessionPersistence.verifyTraceChain`（内部 `_jsonlPath` 单一真源，不向 handler 泄露私有内部）。
- 防呆：纯只读（不改 transcript/链）；未知 session 友好报错不崩；链缺仍渲（`chain: unavailable`）；**遵 gatewayLogLease 可见性——隔离条目只展示标签、不回显原文**（`[内容已隔离，不予回显]`）。

---

## 4. 热路径零回归策略

- **P1 标签 + P2 链 + P4 核对：ALWAYS-ON** 但严格增量 & fail-soft——只附 `_khyTrace`/sidecar，绝不改模型可见内容/派发/阻断写入；热路径控制流不变，新增活全在 `try/catch` best-effort 尾部。
- **P3 隔离：GATED**（`KHY_TRAJECTORY_QUARANTINE`，默认 ON + `=0` 逃生口），因它改**执行**行为；本地 loop 由 origin 检查显式排除 + 专项无回归测试。
- 理由：溯源/证据必须无处不在才可信（可选标签对溯源无意义）；改执行的防御才给 kill switch。

## 5. 全局防呆红线

1. 标签 **fail-SAFE-TO-OURS**（缺 trace⇒khy-local/verified）；执行 **fail-CLOSED**（中转调用未批准即 deny）。
2. 链 & 核对是证据/咨询：断链或矛盾**告警不 brick** 会话。
3. 链无 update/delete；仅原子追加；链写在消息写临界区外。
4. codex-direct 永不再为中转调用自动开全局 dangerous mode（断言守卫）。
5. `_khyTrace` 绝不注入模型可见内容（无 prompt 面泄漏 / 无自投毒）；`khy trace` 不回显隔离原文。
6. 枚举 frozen；未知 producer 归 `relay:<raw>`，热路径永不抛。

## 6. 排序与依赖

P1（schema+标签）→ P2（链，需条目可绑）→ P3（隔离，需 P1 origin 标）→ P4（核对，需 toolCallLog + P1 claimed 正文）→ P5（命令，需全记录）。各阶段独立上线 + 验证；唯 P3 可经 env 叫停/回滚而不丢 P1/P2/P4 价值。

## 7. 端到端验证

- 单测：`node --test services/backend/tests/services/trajectoryProvenance/p{1..5}*.test.js`（75 例全绿）+ `jest router`。
- 防回归：`jest codexAdapter toolUseLoop proxyServer`（62 例绿，1 例 `progressPrefaceDefault` 计时 flaky，隔离重跑绿）。
- 手动 P1/P5：经 relay provider 跑一轮 → `khy trace` 看 producer/trust 字形 + 链 intact。
- 手动 P2：手改一行 JSONL → `khy trace verify` 报 `⚠ chain broken @ #K`。
- 手动 P3：codex-direct piped 跑带 Delete 的中转调用 → quarantined 未执行；`KHY_TRAJECTORY_QUARANTINE=0` 验证逃生口。
- 手动 P4：让中转模型正文谎称「测试全过」而不调 test 工具 → 轨迹与 `khy trace` 标 `⚠ unverified claim`。

## 8. 编号说明

ARCH 号 **047**：核 `docs/03_DESIGN_设计/` 现存最高 046，取最高 +1，避免索引扰动（历史缺号不补）。
