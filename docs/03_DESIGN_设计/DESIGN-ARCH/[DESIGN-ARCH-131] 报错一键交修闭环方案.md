# [DESIGN-ARCH-131] 报错一键交修闭环方案

> 状态：设计提案（未落地）
> 落点：`docs/03_DESIGN_设计/DESIGN-ARCH/`
> 关联：`[DESIGN-ARCH-113]`（三模态反馈契约）、`[DESIGN-ARCH-087]`（CC 模式微交互与反馈设计）、
> `[DESIGN-PROCESS-002]`（新机制落地四阶段）、`[DESIGN-ARCH-111]`（规则遵守保障机制）

## 0. 一句话

把「端上一条结构化错误」变成「一份可执行的修复工单」，由用户一键交办给 agent，
agent 按 `[DESIGN-ARCH-113]` 的 FIX 模态受约束地修，**修复结果用「同一命令输出对比」自证**，
失败则带着新证据进入下一轮，直到错误被判定解决或用户叫停。

---

## 1. 现状证据（引真实文件与常量）

### 1.1 已有的一半：错误「被结构化」了，但没地方去

| 环节 | 真源 | 实况 |
|---|---|---|
| 错误码字典 | `services/backend/src/services/domain/security/failsafe/errorCodes.js` | E01–E08 单一真源，每码带 `reason / suggestion / retryable / resumable / continueHint / sensitive / requiredFields`；`FALLBACK_CODE = 'E04'` |
| 强制兜底注入 | `.../failsafe/streamInjector.js`（264 行） | `StreamFailSafeInjector`，`finalized` 幂等闸门；`_inject()` 在 `:117` |
| 前端归一 | `apps/ai-frontend/src/views/aiChatEventUtils.js:401` | `structuredErrorEvent(payload)` → `{type,text,code,category,reason,suggestion,retryable,sensitive,requestId}` |
| 挂到消息 | `apps/ai-frontend/src/views/AIChat.vue:2233` | `applyStructuredError()` → `msg.error = {code,category,why,how,retryable,sensitive,requestId,_trace,_traceLoading,_traceOpen}` |
| 错误卡片 | `apps/ai-frontend/src/views/AIChat.vue:485–560` | `⚠ {{category}} [{{code}}]` + **为什么** + **我可以怎么办** + 两个按钮 |
| 追溯接口 | `GET /api/ai-gateway/monitor/attribution?requestId=…` | 路由在 `services/backend/src/services/aiManagementGatewayAdmin.js:2049` |

**关键事实：错误卡片只有两个动作。**

```html
<el-button v-if="msg.error.retryable" @click="regenerate(msg)">重试</el-button>
<el-button v-if="msg.error.requestId && !msg.error.sensitive" @click="toggleTrace(msg)">技术详情 / 追溯</el-button>
```

而 `regenerate(msg)`（`AIChat.vue:2224`）的语义是 **"把同一条用户提问原样重发"**：

```js
const text = userMsg.content || '';
msg.content = ''; msg.steps = []; msg.model = ''; msg.error = null;
await runAssistantTurn(text, msg, attachmentIds);
```

⇒ **重试 = 空手再试一次，错误信息本身不进上下文。** 这正是本方案要补的空白。

### 1.2 已有的另一半：三模态契约在了，但没有生产者

`scripts/ci/check-agent-feedback.js`（629 行）实现了完整契约：`detectMode()` 纯函数（`:122`）、
`EVIDENCE` 存证清单（`:162`）、`auditFiveQuestions()` 反形式主义（`:185`）、
`docsBackedTokens()` 文档背书写护（`:245`）、`customerSpeech()` 客户回话文案（`:293`）。

登记状态（现查真源）：

| 规则 | 优先级 | gate | severity | 执行器 |
|---|---|---|---|---|
| `RUNTIME-007` 修复先复现 | P1 | commit | **advisory** | `scripts/ci/check-agent-feedback.js` |
| `RUNTIME-008` 新增先提问 | P2 | commit | advisory | 同上 |
| `RUNTIME-009` 删除先报部位 | P1 | commit | advisory | 同上 |

⇒ 三条都处于 **S1 观察期**（`gate:commit` + `severity:advisory`，符合 `[DESIGN-ARCH-111]` 的
「只记录不拦截」正确表达）。

### 1.3 ★ 最关键的一条实证：存证目录「零生产写入」

契约要求把证据留在 `.khy/feedback/<task-id>/`：

```js
const EVIDENCE = {
  FIX: [
    { file: 'complaint.md',       label: '主诉（条件 + 现象）' },
    { file: 'repro-before.txt',   label: '复现原始输出（体温单）' },
    { file: 'differential.md',    label: '≥2 候选病因 + 可证伪预测' },
    { file: 'repro-after.txt',    label: '改后同一命令输出（复诊）' },
  ], ...
};
```

但 §5.8 四问核验的结果是：

```bash
# ① 字段在真源吗 → 在（EVIDENCE 常量）
# ② 写入函数在吗 → 只有 checker 内部自测才写（:435 fs.writeFileSync，在 scenario 分支内）
git grep -n "khy/feedback\|evidenceDir" -- 'services/**' 'scripts/**' | grep -v "/tests/"
# → 生产侧命中 0 处 createEvidence/writeEvidence；checker 侧全部是 readEvidence()
```

| 证据 | 结论 |
|---|---|
| `readEvidence(dir, file)`（`:173`） | ✅ 只读 |
| `fs.writeFileSync`（`:435`） | ⚠ 仅在 `--scenario=` 自测分支内 |
| 生产调用点（服务/CLI/routes 调它写存证） | ❌ **0 处** |

⇒ **契约把「写存证」的责任完全留给 AI 的自觉，没有任何机器通道帮它落盘。**
结果是：`fix-without-repro` 这条 error 判据在真实运行时**永远命不中**——因为没人写，也没人查。
（这正是 `[DESIGN-ARCH-113]` 自己都点出的「存证靠自觉」的漏洞。）

### 1.4 端侧能力缺口（TUI 侧）

```bash
git grep -n "errorCode\|error_code\|E0[1-8]" -- 'services/backend/src/cli/tui/**' | grep -v ".html"
# → 空
```

TUI 侧只有自由文本 `push('error', tuiErrorOf(err, {action, target}))`（`ink-components/App.js` 多处），
**没有** E01–E08 结构化呈现，也没有「交修」入口。

---

## 2. 设计公理（不可让渡）

**A1 · 交修不是外发。**
「一键交修」= 把错误**交给本会话的 agent**，不是上传到任何远端服务。
沿用 `/feedback` 既有红线：`cli/handlers/feedback.js` **绝不假装已提交、绝不静默外发**。
任何新增网络写入必须由用户显式点击「上传」并展示目标地址。

**A2 · 错误进上下文必须是「证据」而非「转述」。**
喂给 agent 的必须是**原始输出 + 可复现命令**，不是错误文案的摘要。
依据：`[DESIGN-ARCH-113]` FIX 模态第 2 条「我要看到它，不要你的转述」。

**A3 · 修好了没有，不由 AI 自称。**
验收判据只能是**客观产物**：同一命令的前后输出对比（`repro-before.txt` vs `repro-after.txt`）。
依据：本仓既有纪律「判定/分级不接受 AI 自称」。

**A4 · 强度梯度：事前 advisory、事中 warning、事末 error。**
过早阻断会逼 AI 谎报「已复现/已确认」（`[DESIGN-ARCH-113]` §5）。
本方案新增判据一律从 S1 起步。

**A5 · 单轮交修有界，续修要用户点头。**
不许出现「agent 自旋 N 轮烧 token」。每轮结束必须给用户一个可读判定 + 一个明确选择。

---

## 3. 与既有机制的边界（不重复造）

| 既有件 | 它管什么 | 本方案做什么 | 边界 |
|---|---|---|---|
| `failsafe/errorCodes.js` | **错误分类学**：把异常归到 E01–E08 | **消费**它，不改它 | 若发现缺码，走独立提案扩真源 |
| `failsafe/streamInjector.js` | **保证错误一定送达端上** | 复用，不改 | — |
| `AI管理网关 /monitor/attribution` | 单请求**分阶段时间线**下钻 | 复用为「**技术证据**」来源 | 只读，不写 |
| `[DESIGN-ARCH-113]` 三模态契约 | **改动过程**中约束 AI 行为 | **复用**其 FIX 模态，补上**生产者** | 不重复定义模态与判据 |
| `cli/handlers/feedback.js` `/feedback` | 收集环境信息 → **本地草稿** → 指向上游 | 复用其**采集/脱敏**逻辑 | 交修 ≠ 上报；两者不互相替代 |
| `routes/feedback.js` | SaaS 工单 CRUD（admin） | **无关** | 明确排除，避免误接线 |
| `traceAuditService` | 全链路审计与保留策略 | 复用为证据来源 | 遵守其脱敏与角色可见性 |

**一句话边界**：既有机制解决「错误**是什么**」与「改动**该守什么规矩**」；
本方案解决「错误**怎么变成一次受约束的修复任务**」以及「修完**怎么自证**」。

---

## 4. 整体流程（五环节）

```text
[1] 端上捕获        错误发生 → StreamFailSafeInjector 注入结构化事件
        │            （已有，零改动）
        ▼
[2] 反馈入口        错误卡片新增「交给 AI 修」按钮
        │            输入：msg.error（含 requestId / code / why / how）
        ▼
[3] 交修单构造      RepairTicket 组装：环境 + 错误归因 + 技术证据 + 复现命令
        │            输出：结构化 ticket（内存对象 + 可选落盘）
        ▼
[4] Agent 修复      ticket 作为用户消息注入本会话；FIX 模态契约生效
        │            产出：repro-before.txt / differential.md / 最小改动
        ▼
[5] 迭代与验证      同一命令前后对比 → 判定 → 未过则带新证据续修
                     │
                     └─ 有界：默认 1 轮，续修需用户确认
```

**与既有链路的咬合点**：第 4 步的约束由 `agentFeedbackService` 的 `PrePrompt` 注入器提供
（`hookSystem.js:57` 注册，`builtin:AgentFeedbackInjector`，priority 30），
它已是「文本进入 AI 上下文的唯一注入点」的既有实现，**本方案不新开注入通道**。

---

## 5. 各环节的输入 / 输出

### 5.1 环节 [2] 反馈入口

| 项 | 内容 |
|---|---|
| **输入** | `msg.error = {code, category, why, how, retryable, sensitive, requestId}` |
| **输出** | `click → openRepairDialog(msg)`；或 `sensitive === true` 时**不提供**该按钮 |
| **显示条件** | `msg.error.code` 存在 **且** `!msg.error.sensitive` |
| **按钮文案** | 「交给 AI 修」（与「重试」并列，语义必须可区分） |

**为什么 `sensitive` 要挡**：E02（安全审查）/ E07（权限拦截）的 `sensitive = true`，
其 `detail` 与 `fields` 按 `errorCodes.js` 头部约定**不得泄露命中的具体安全策略**。
把这类错误喂给 agent 会绕开这条脱敏边界。

**与「重试」的区别（必须让用户看懂）**：

| 按钮 | 语义 | 错误信息去向 |
|---|---|---|
| 重试 | 原样再发一次 | ❌ 不进上下文 |
| **交给 AI 修** | **带着错误证据请 agent 排查修复** | ✅ 作为证据进上下文 |

### 5.2 环节 [3] 交修单（RepairTicket）

**输入**：`msg.error` + 会话上下文 + 环境信息
**输出**：`RepairTicket` 对象（§6 定义）

组装动作分三步：

1. **拉技术证据**：`GET /api/ai-gateway/monitor/attribution?requestId=<id>`
   → `{ok, summary, timeline, delivery.brokenStage}`
2. **采集环境**：复用 `cli/feedbackDoc.js` 的既有采集口径
   （`buildFeedbackDoc({version, platform})`，所有随环境变化的输入由薄壳注入以保证确定性）
3. **推导复现命令**：从 `brokenStage` 反推「重放哪一步」——
   - `before_tool_call` ⇒ 重放模型请求（工具未调用）
   - `tool_execution` ⇒ 重放**那一次工具调用**（最有价值：命令级可复现）
   - `after_tool_result` ⇒ 重放工具 + 结果注入
   - `final_conclusion` / `delivery_event_missing` ⇒ 重放整轮

### 5.3 环节 [4] Agent 修复

**输入**：RepairTicket 渲染成的一段用户消息
**输出**：按 FIX 模态契约产出的四件存证

存证落点（**建议**）：`.khy/feedback/<ticket-id>/`，与 `check-agent-feedback.js:429` 的
`argValue('--evidence', ...)` 默认口径一致。

⚠ **落地前提**：该目录在 `.khy/` 下，而 `.khy/` 被 gitignore（本机态）。
这不影响本方案（修复是**本会话内的动作**，不需要跨机同步），但**必须在文档里讲明**：
存证不随仓库分发。

### 5.4 环节 [5] 迭代与验证

**输入**：`repro-before.txt`（改前）+ `repro-after.txt`（改后）
**输出**：三值判定 `fixed | not-fixed | inconclusive`

| 判定 | 判据（机器可判） | 后续动作 |
|---|---|---|
| `fixed` | 两文件内容**不同** 且 改后输出**不含**原始错误签名 | 展示对比，闭环结束 |
| `not-fixed` | 两文件内容**相同**，或改后仍含相同错误签名 | 带新证据进下一轮（需用户确认） |
| `inconclusive` | 缺少任一文件，或复现命令本身无法执行 | **不改判为成功**，明示「无法判定」 |

**错误签名如何取**（关键实现细节）：
取 `error_code` + `reason` 的字面量（二者都是**固定可枚举**的，见 `errorCodes.js` 头部约定），
**不用** `detail`（动态、可能含时间戳/路径 ⇒ 假阴性）。

---

## 6. 错误信息的传递格式与内容

### 6.1 线上格式（沿用既有，零改动）

后端 → 前端的错误事件字段**已经定好**，本方案不扩：

```js
{ type:'error', error_code, reason, detail, suggestion,
  retryable, resumable, continueHint, sensitive, requestId, partial, fallback }
```

### 6.2 §5.5 契约可行性实证（逐字段回真源核对）

初稿曾想直接复用前端 `msg.error` 当交修单。**逐字段核对后发现有 3 处不成立**：

| 初稿写的字段 | 真源实况 | 处置 |
|---|---|---|
| `msg.error.detail` | 前端 `applyStructuredError` **未接收** `detail`（只取 `reason` 作 `why`） | **降级**：从 attribution 的 timeline 取原始错误对象 |
| `msg.error.requestId` | ✅ 存在（`structuredErrorEvent` 归一，`AIChat.vue:2240`） | 保留，作为拉证据的支点 |
| `msg.error.retryable` | ✅ 存在 | 保留（用于决定是否同时显示「重试」） |
| `msg.error.resumable / continueHint` | 后端**有**，但 `structuredErrorEvent` **未透传** | **需扩前端归一**（见 §7 步 1） |
| `msg.error.code / category / why / how` | ✅ 存在 | 保留 |

⇒ **结论**：`requestId` 是本方案**唯一真正的支点字段**，且**已存在**。
`resumable` / `continueHint` 需补透传（这是一处**新增**，不是现状）。

### 6.3 RepairTicket 结构（本方案新增，`snake_case` 沿用真源）

```js
{
  ticket_id: 'rt-<requestId 后 8 位>',
  created_at: '<ISO8601>',
  source: { kind: 'structured_error', request_id, error_code, category,
            reason, suggestion, retryable, resumable, continue_hint, sensitive },
  env:    { khy_version, platform },                    // 复用 feedbackDoc 口径
  trace:  { broken_stage, timeline: [...], ok },         // 复用 attribution 端点
  repro:  { command, expected_signature, stage },        // 机器推导
  evidence_dir: '.khy/feedback/<ticket_id>',             // 与既有默认口径一致
  attempt: 1,
  prior_attempts: []                                     // 每轮追加 {attempt, verdict, signature_after}
}
```

**命名纪律**（§5.5 配套）：一律 `snake_case`，**不在契约层做驼峰转换**——
转换层就是第二套字段名，违反「一处真源」。

### 6.4 注入文本（渲染后，进 AI 上下文的那段话）

按 `[DESIGN-ARCH-113]` FIX 模态，`check-agent-feedback.js:293` 的 `customerSpeech()` 已有权威文案。
本方案**复用**它的五条，不改写：

```text
【客户 · 患者】你还没量体温。
  1. 先复述主诉：谁、在什么条件下、出现了什么现象 —— 不许直接说病因。
  2. 跑复现命令，把**原始输出**存成 repro-before.txt。我要看到它，不要你的转述。
  3. 列 ≥2 个候选病因，每个给一条可证伪预测：`若 <病因>，则 <命令> 应输出 <期望>`。
  4. 只改能证伪病因的那一处。顺手重构 = 我要重新做一遍全套检查。
  5. 复诊：跑同一条复现命令，把改后输出存成 repro-after.txt。
```

**前置的实际错误证据**（这是本方案的新增部分，附在五条之前）：

```text
[错误] E04 工具执行崩溃（requestId=…）
  reason: 工具内部抛出未捕获异常
  断点阶段: tool_execution
  复现命令: <repro.command>
  技术证据: <trace.timeline 的可读摘要>
```

**为什么顺序是「证据在前、契约在后」**：契约是**稳定规则**，证据是**本次具体问题**。
AI 读长文本时后段更易被引用；把稳定的行为契约放在最后，保证它不被具体证据淹没。

---

## 7. 落地路径（B-L2 三步，一次提交只做一步）

> 依据本 Skill §4：四件事必须**成对**做；`gate:advisory` 是陷阱，须用 `gate:commit` + `severity:advisory`。

### 步骤 1「标记」——只加能力，不加判据（零守卫影响）

| # | 动作 | 文件 | 说明 |
|---|---|---|---|
| 1.1 | 前端透传 `resumable` / `continueHint` / `detail` | `aiChatEventUtils.js:401` + `AIChat.vue:2233` | 纯增量字段 |
| 1.2 | 错误卡片加「交给 AI 修」按钮 | `AIChat.vue:485–560` | 与「重试」并列 |
| 1.3 | 新增 `repairTicketService`（构造 ticket） | `services/backend/src/services/` | 纯函数优先，便于单测 |
| 1.4 | 新增 `POST /api/ai-gateway/repair/ticket` | 挂 `aiManagementGatewayAdmin.js` 路由表 | 只回 ticket，不触发修复 |

**验收**：手工构造一个错误 → 点按钮 → 拿到 ticket JSON（含 `trace.broken_stage`）。
**必须实测**：不新增任何规则时，`check:wiring` / `check:gov-rules` **不应因本步变红**。

### 步骤 2「迁移」——接上 agent，补生产者

| # | 动作 | 说明 |
|---|---|---|
| 2.1 | 交修单渲染成用户消息并 `runAssistantTurn` | 复用既有轮次入口，**不新开通道** |
| 2.2 | ★ **补存证写入通道** | 让 agent 能真的写出 `.khy/feedback/<id>/repro-before.txt` |
| 2.3 | 端到端验证 | 见 §8 |

**2.2 是本方案的核心补齐**（对应 §1.3 的实证缺口）。
两个候选实现方向（**需人裁决，见 §10**）：
- **(a) 工具通道**：给 agent 一个 `WriteEvidence` 工具，显式写存证；
- **(b) 钩子通道**：在 `PostToolUse` 观测到复现命令执行后自动落盘。

### 步骤 3「收口」——接判据与验证

| # | 动作 | 说明 |
|---|---|---|
| 3.1 | 三值判定实现 | `fixed / not-fixed / inconclusive`，纯函数 |
| 3.2 | 前端展示前后对比 | 复用既有 `chat-error-trace` 样式族 |
| 3.3 | 续修确认 | 默认 1 轮；续修需用户点「继续修」 |
| 3.4 | 新增规则（S1 起步） | `gate:'commit'` + `severity:'advisory'` |

**3.4 的接线四件**（缺一即红）：

1. `package.json` 加 `check:*` 别名
2. `docs/10_规范/registry/RULES-REGISTRY.json` 补条目（含 `nature`/`grants`/`benefit` 三元；
   `domain` 十域封闭枚举内选；同步 `meta.ruleCount` 与 `rules.length`）
3. `<!-- RULES-REGISTRY: ID -->` 标记行（放在 `ssot` 首个目标文件第 3 行）
4. `npm run docs:rules-cards` 重生成

**必做的阶段实证**（否则是空接线）：

```bash
npm run rules:gate:commit 2>&1 | grep "<执行器名>"
# 必须看到 action=start ... mode=commit rules=<finding ids>
```

---

## 8. 迭代与验证机制（详细）

### 8.1 一轮的生命周期

```text
ticket 注入
   │
   ├─ agent 复现 → 写 repro-before.txt
   ├─ agent 列候选病因 → 写 differential.md
   ├─ agent 改最小一处
   └─ agent 复跑同命令 → 写 repro-after.txt
        │
        ▼
   判定（纯函数，不发生在 agent 脑内）
        │
   ┌────┴────┬────────────┐
   ▼         ▼            ▼
 fixed   not-fixed   inconclusive
   │         │            │
 展示对比   追加一轮     明示无法判定
 闭环      （需确认）    （不算成功）
```

### 8.2 判定为什么不能由 AI 做（A3 的落地）

AI 说「已修复」是**自称**，不是证据。判定必须：

1. 由**确定性纯函数**执行，输入只有两个文件内容 + `expected_signature`；
2. **不接受** AI 的任何文字断言；
3. 缺文件时返回 `inconclusive`，**绝不默认 succceed**。

伪代码（双向判据，防 §5.7 空转断言）：

```js
function judgeFix(beforeText, afterText, signature) {
  if (beforeText == null || afterText == null) return 'inconclusive';
  if (beforeText === afterText) return 'not-fixed';       // 应拦
  if (afterText.includes(signature)) return 'not-fixed';  // 应拦
  return 'fixed';                                          // 应放行
}
// 双向对照必须有：
//   非法输入（缺文件）→ inconclusive
//   合法输入（真变了且不含签名）→ fixed
// 只测「应拦」的话，把函数改成恒返 'not-fixed' 也能全绿。
```

### 8.3 反例清单（每条 → 预期判定）

| # | 反例 | 预期 |
|---|---|---|
| 1 | agent 只写 `repro-after.txt`，不改代码 | `not-fixed`（两文件相同） |
| 2 | agent 改了代码但没跑复现命令 | `inconclusive`（缺 after） |
| 3 | agent 顺手重构，错误确实消失 | `fixed`，但 `fix-blast-radius` 判据同时报 warning |
| 4 | 错误是 E01（模型静默空响应） | **不应交修**——模型侧问题，非代码缺陷；入口需按码分级 |
| 5 | 错误是 E02 / E07（`sensitive`） | **入口不出现**（§5.1） |
| 6 | 用户连点 3 次「交给 AI 修」 | 第二次起应被「已有进行中 ticket」挡住 |
| 7 | 复现命令本身需要交互输入 | `inconclusive`，且提示用户命令不可自动化 |

⚠ **反例 4 是设计上的一个重要分流**：`E01/E02/E03/E06` 属**模型/网络/安全**侧，
交修毫无意义（改了代码也不会好）。**只有 E04/E05/E08 是代码侧可修的**。
入口应按 `error_code` 分级，不能一视同仁。

### 8.4 `error_code` → 是否可交修（映射表）

| 码 | 类别 | 可交修 | 理由 |
|---|---|---|---|
| E01 | 模型静默空响应 | ❌ | 模型侧；引导「重试 / 换通道」 |
| E02 | 模型强制中断 | ❌（且 `sensitive`） | 安全策略，不得绕 |
| E03 | 上下文溢出 | ❌ | 需压缩上下文，非代码缺陷 |
| **E04** | **工具执行崩溃** | ✅ | **代码/工具可修，首选场景** |
| **E05** | **依赖缺失阻断** | ✅ | 装依赖 / 修 require 路径 |
| E06 | 网络熔断 | ❌ | 网络侧 |
| E07 | 权限拦截 | ❌（且 `sensitive`） | 安全策略，不得绕 |
| E08 | 格式校验失败 | ✅ | 契约/校验器可修 |

⇒ **可实现交修的只有 3/8**。这条必须写进文档，否则会被误当成「万能修错按钮」。

---

## 9. 用户端反馈交互设计

### 9.1 错误卡片（改造后）

```text
┌────────────────────────────────────────────────────┐
│ ⚠ 工具执行崩溃  [E04]                               │
│                                                     │
│ 为什么        工具内部抛出未捕获异常                  │
│ 我可以怎么办   请检查该工具的依赖与参数…              │
│                                                     │
│ [交给 AI 修]  [重试]  [技术详情 / 追溯]              │
└────────────────────────────────────────────────────┘
```

**按钮显示规则**（可机器判定，无歧义）：

| 按钮 | 显示条件 |
|---|---|
| 交给 AI 修 | `REPAIRABLE.has(code) && !sensitive` |
| 重试 | `retryable === true`（既有逻辑不变） |
| 技术详情 / 追溯 | `requestId && !sensitive`（既有逻辑不变） |

### 9.2 交修确认（防误触，且必须告知边界）

点「交给 AI 修」后先弹一个**非阻塞**确认条：

```text
将向当前会话的 AI 提交一份修复工单：

  错误      E04 工具执行崩溃
  会话      <session_id 前 8 位>
  证据      技术时间线（3 个阶段）+ 复现命令
  落盘      .khy/feedback/<ticket_id>/

  ▸ 仅提交给本会话的 AI，不会上传到任何服务器
  ▸ 修复过程会修改仓库文件，你随时可以叫停
                                    [取消]  [提交]
```

最后两行**不可省略**——它们同时守住 A1（不外发）与用户的知情权。

### 9.3 修复中（过程可见）

复用既有 thinking-log 通道（`addThinkingLog`），不新开 UI 组件：

```text
▸ 步骤 1/3：已提交修复工单 rt-xxxxxxxx
▸ 步骤 2/3：AI 正在复现（repro-before.txt）
▸ 步骤 3/3：最小改动 + 复诊（repro-after.txt）
```

### 9.4 修复完成后（对比卡片）

```text
┌────────────────────────────────────────────────────┐
│ ✓ 已修复  E04 工具执行崩溃                          │
│                                                     │
│ 复现命令    node scripts/ci/check-agent-feedback.js │
│                                                     │
│ 改前        Error: Cannot find module '...'         │
│ 改后        Summary: 0 error(s), 0 warning(s).      │
│                                                     │
│ 改动        2 个文件（未触及测试）                   │
│ [查看完整对比]  [还原这次修复]                       │
└────────────────────────────────────────────────────┘
```

**「还原这次修复」是必须的**（A5 的对偶）：给了 agent 改仓库的权力，就必须给用户一键退回的权力。
依据：`[DESIGN-ARCH-113]` DELETE 模态第 4 条「没有回滚路径我不躺下」——同一精神适用于 FIX。

### 9.5 未修复（带证据进下一轮）

```text
┌────────────────────────────────────────────────────┐
│ ✗ 未修复  E04 工具执行崩溃（第 1 轮）               │
│                                                     │
│ 改后输出仍包含相同错误签名                           │
│ ▸ 已追加诊断：repro-after.txt 与改前逐字相同         │
│                                                     │
│ [继续修（第 2 轮）]  [查看分析]  [停在这里]          │
└────────────────────────────────────────────────────┘
```

**默认不自动续轮**，必须用户点（A5）。

### 9.6 TUI 侧（同构，但降级呈现）

TUI 目前无结构化错误（§1.4）。建议**最小改造**：

- 错误行后追加一行提示：`按 F 交给 AI 修（E04）`；
- 无 `requestId` 或 `sensitive` 时不显示该提示；
- 不引入弹窗，用既有 `pushNotice` 通道。

---

## 10. 未决问题（需人裁决，不代为决定）

| # | 问题 | 选项 | 影响 |
|---|---|---|---|
| **Q1** | 存证写入通道走**工具**还是**钩子**？ | (a) `WriteEvidence` 工具 / (b) `PostToolUse` 自动落盘 | 决定 §7 步 2.2 的实现形态；钩子更省 AI 注意力但更难判「哪次执行是复现」 |
| **Q2** | 交修单**落盘还是仅内存**？ | 落盘可跨会话，但 `.khy/` 是本机态、不随仓库分发 | 若要求跨机，需改落 `.ai/`（受 `MEMORY-003` 管辖），代价高得多 |
| **Q3** | 是否把「交修」纳入 `RUNTIME-007` 的**存证生产者**，还是新立规则？ | 复用 vs 新规则 | 复用会扩大既有规则的 scope；新规则要付 §7 步 3.4 的四件接线成本 |
| **Q4** | 「还原这次修复」用 git 还是文件快照？ | 本仓工作区长期有上千未提交文件，`git` 基线不可靠 | **建议文件快照**，但需人确认 |
| **Q5** | 前端 `resumable`/`continueHint` 透传是否算破坏性改动？ | 纯增量字段 | 需确认无既有消费者依赖「字段不存在」 |
| **Q6** | E08 是否真可交修？ | E08 多为上游契约不匹配 | 可能是「改错方」而非「改调用方」 |

---

## 11. 验证与复现方式

```bash
# 0) 现状复核（证明 §1 的每条实证仍成立）
git grep -n "CMD_HOOK_ALLOWED_FIELDS" -A 12 -- 'services/backend/src/services/domain/extensions/hooks/hookRunner.js'
git grep -n "PrePrompt" -- 'services/backend/src/services/domain/extensions/hooks/hookSystem.js'
git grep -n "structuredErrorEvent" -- 'apps/ai-frontend/src/views/aiChatEventUtils.js'

# 1) ★ 存证零生产写入的复核（本方案的核心立论）
git grep -n "khy/feedback\|evidenceDir" -- 'services/**' 'scripts/**' | grep -v "/tests/"

# 2) 端侧结构化能力缺口
git grep -n "errorCode\|error_code\|E0[1-8]" -- 'services/backend/src/cli/tui/**' | grep -v ".html"

# 3) 三模态契约当前阶段
node -e "const j=require('./docs/10_规范/registry/RULES-REGISTRY.json');for(const r of j.rules){if(/^RUNTIME-00[789]\$/.test(r.id))console.log(r.id,r.gate,r.severity,(r.exec||{}).script)}"

# 4) 契约自测（既有入口，确认判据可用）
node scripts/ci/check-agent-feedback.js --scenario=fix-no-repro
node scripts/ci/check-agent-feedback.js --scenario=fix-with-repro
```

### 交付前自检

```bash
node scripts/docs/build_docs_site.js     # 生成 .html 孪生件（非零副作用，见 §12）
node scripts/docs/verify_docs_site.js    # 期望「全部通过」
node scripts/ci/check-repo-layout.js     # 逐条确认没点到自己
```

---

## 12. 交付说明（必须向用户点明）

1. **本文档为设计提案，未落地任何代码。** §7 的三步是待执行计划。
2. `node scripts/docs/build_docs_site.js` **不是零副作用**：它会重写全站陈旧 `.html` 孪生件
   （历史实测 232 个），属预期且有益的修复（顺手修好指向已改名资产的断链）。
3. **本方案不新建注入通道**：`additionalContext` 已是 `PrePrompt` 的既有白名单字段
   （`hookRunner.js:31`），本方案只**消费**这个既有通道。
4. **本方案不新增网络外发**：所有证据留在本机（`.khy/feedback/` 与 `audit/`）。
5. **可实现交修的错误只有 E04/E05/E08 三种**（§8.4），不是「万能修错按钮」。

---

## 附录 A：一句话记住三个按钮

| 按钮 | 一句话 |
|---|---|
| 重试 | **空手再试一次**（错误不进上下文） |
| 交给 AI 修 | **带着体温单去看病**（证据进上下文 + 契约约束 + 前后对比自证） |
| 技术详情 / 追溯 | **调病历**（分阶段时间线，只读不改） |
