# [DESIGN-ARCH-136] 零尝试失败被误报为「钉选抑制」的修复方案

> 状态：**待评审**（提案，未落地）
> 范围：`cliFailureEnvelope.js`（诊断码与路由披露）+ `aiChatCore.js`（回退重试的结果覆盖策略）+ `khy gateway status`（钉选残留告警）
> 上游依赖：`[DESIGN-ARCH-114] CLI 错误标准化规范`（信封契约）、`RUNTIME-005`、`RUNTIME-002`（状态透明）
> 调研指针：本方案由 2026-09-23 TUI 实机截图触发，取证全部为 file:line 可复核
> 模板合规：按 `[DESIGN-ARCH-124]` 体例；B-P2 依 `[SOURCING-001]` §3 B-P1 **据实声明不适用**（见 §2）

---

## 0. 一句话结论

**TUI 首屏那句「本次请求未能完成 `[NONE]` / 路由: 钉选 strict(GATEWAY_PREFERRED_ADAPTER=api),本轮不回退」是两处缺陷叠加的产物：**

| # | 病灶 | 位置 | 症状 |
|---|---|---|---|
| **A** | 「**一条失败记录都没有**」被翻译成「**钉选抑制了回退**」 | `cliFailureEnvelope.js:112-122` | 首屏披露了一个**根本没发生**的因果 |
| **B** | 「零证据」没有专项码，落进 `NONE` 兜底（文案零信息） | `cliFailureEnvelope.js:256-259` | 用户拿不到任何可执行诊断 |
| **C** | 回退重试的失败结果**无条件覆盖**首次结果 | `aiChatCore.js:3125-3128` | 把原本更具体的诊断**换成更差的** |
| **D** | `.env` 钉选残留可手改，注释承诺 4 次、值改 0 次 | `services/backend/.env:51-52` | 同一 bug 第 **5** 次复发 |

**A/B 是"说错话"，C 是"把对的话换成错的话"，D 是"为什么总有话说错的机会"。四者独立可修、独立可回滚。**

---

## 1. 现状实证

### 1.1 现象精确复现（探针，非推测）

用 9 组 `result` 形状直接喂 `buildCliFailureEnvelope`，逐条比对截图首屏 4 行：

| 输入形状 | code | cause | routing | 与截图 |
|---|---|---|---|---|
| 无 `attempts` 字段 + `errorType:'unknown'` | `NONE` | `null` | `pinned-strict` | **逐字节一致** |
| 无 `attempts` 字段 + `errorType:'process'` | `NONE` | `null` | `pinned-strict` | **逐字节一致** |
| `attempts: []` + `unknown` | `NONE` | `null` | `pinned-strict` | **逐字节一致** |
| 记录**缺 `success` 字段** + `process` | `NONE` | `null` | `pinned-strict` | **逐字节一致** |
| 记录含 `success:false` + `process` | `NONE` | **有值** | `pinned-strict` | 多一行「通道: …」→ 排除 |
| 全 virtualSkip | `NONE` | 有值 | `preferred-with-fallback` | 路由行不符 → 排除 |
| 无 attempts + `cancelled` | `CANCELLED` | `null` | `pinned-strict` | 标题不符 → 排除 |
| 无 attempts + 无 preferredAdapter | `NONE` | `null` | `auto` | 缺路由行 → 排除 |

**判据收敛为一句话**：`attempts` 中**没有一条**带 `success === false` ⇒ 三处判据**同时**失效 ⇒ `[NONE]` + 误报"钉选 strict"。

### 1.2 三处判据同源，且都用严格相等

| 位置 | 表达式 | 失效后 |
|---|---|---|
| `cliFailureEnvelope.js:66` | `a.success === false` | `cause = null` ⇒ **首屏无「通道: …」行**（截图确实没有） |
| `cliFailureEnvelope.js:112-118` | 同上 + `keys.size === 0` | `pinned-strict` / `fallbackSuppressed: true` |
| `aiGatewayGenerateHelpers.js:893,895` | 同上，两处 `return ''` | 无「内部已尝试 N 次请求」（截图确实没有） |

`_resolveCode`（`:216-262`）的 15 个分支**没有一个**处理 `cause === null`；`allAttempts` 为空时 `errorType` 被硬赋 `'unknown'`（`aiGatewayGenerateMethod.js:6408-6409`），不匹配任何已知类型 ⇒ 落 `:259` 的 `return 'NONE'`。

### 1.3 触发链（四步，每步 file:line）

**第 1 步 — 配置残留**

`services/backend/.env:51-52`（**本机实测值**）：
```
GATEWAY_PREFERRED_ADAPTER=api
GATEWAY_PREFERRED_STRICT=true
```
- 该文件 **不受 git 跟踪**（`git ls-files --error-unmatch` → `pathspec ... did not match`）⇒ 纯本机态
- 文件 34-50 行注释**已记录本 bug 前 4 次复发**：`codex → windsurf → windsurf → api`，并写着「这次值终于与注释一致」——**但值仍是 `api` + `true`**
- 注释自陈根因：「根因始终是『只改注释、不改值』」

**第 2 步 — 被钉通道不可用，触发 strict 专项失败**

`aiGatewayGenerateMethod.js:4033-4083`：`!entry.available` ⇒ `:4056` 输出
```
已选择模型通道不可用: api。
```
该文案是 `aiContextFlow.js:39-45` `_isStrictPreferredFailure` 的**唯一判据**：
```js
return /已选择模型通道(请求失败|不可用)/.test(msg);
```
⇒ 判定为"strict 首选失败"，`:4064` 返回（`errorType:'unavailable'`，`attempts` 至少 1 条）。

**第 3 步 — 自动放宽并重试**

`aiChatCore.js:3105-3128`：
- `:3120` 用 `{ ...chatOpts, strictPreferred: false }` **再调一次** generate
- `:3125-3128` **无条件覆盖**：`if (retryPass && retryPass.result) { result = retryPass.result; }`
- 注释自述意图：*Always surface the retry outcome (success or failure)* —— 意图正确，**实现是"用更差的信息替换更好的信息"**

**第 4 步 — 第二轮产出的结果里没有 `success:false` 记录**

⇒ §1.2 三处判据同时失效 ⇒ `[NONE]` + 误报钉选。

### 1.4 归因：这不是并行会话改动引入的

| 检查 | 结果 |
|---|---|
| `git show HEAD:…cliFailureEnvelope.js` vs 工作区 | **逐字节一致**（12023 bytes） |
| `git status --porcelain`（信封 / 测试 / .env） | 无未提交改动 |
| `assets` 基线 | 信封源码**未被我或他人改动过** |

---

## 2. 【借鉴提案】

**据实声明：不适用。**

依 `[SOURCING-001]` §3 **B-P1**：对**已登记能力域的行为修正**（bugfix / 文案调整）不需要提案，判定依据是该能力域已在注册表中存在且有 `canonical` 路径。
- 能力域：`cliFailureEnvelope.js`（已存在，`KHY_CLI_FAILURE_ENVELOPE` 已在 `flagRegistry.js:1103` 登记，`mode:'default-on'`）
- 上游规范：`[DESIGN-ARCH-114] CLI 错误标准化规范`（本方案是对它的**补章**，非新增并行规范）

B-P2 七字段只约束**借鉴外部**（其第 1 字段即"项目名 + 版本/commit"）。本方案未借鉴任何外部实现，故逐字段**据实填"不适用"**，不为"看起来合规"硬塞一个上游。

| # | 字段 | 值 |
|---|---|---|
| 1 | 借鉴对象 | 不适用（无外部上游） |
| 2 | 借鉴内容 | 不适用 |
| 3 | 解决的问题 | 不适用（问题为本仓自有，见 §1） |
| 4 | 许可证与代码性质 | 不适用 |
| 5 | 借鉴方式 | 不适用 |
| 6 | 落点与现有实现对比 | 落点 = 既有文件 `cliFailureEnvelope.js` / `aiChatCore.js`，属**扩展既有 canonical**，非新增并行实现 |
| 7 | 验收方式 | 见 §7 |

---

## 3. 目标形态

### 3.1 第 1 期 — 信封：让「零证据」成为一个可说出口的事实

**(a) `_resolveRouting`（`:104-126`）**：`keys.size === 0` 时**不得**置 `pinned: true`

```js
// 旧：const suppressed = keys.size === 0 || (keys.size === 1 && keys.has(preferred));
// 新：零尝试 ≠ 回退被抑制。一次都没试过就说"本轮不回退"，是编造因果。
if (keys.size === 0) {
  return { ...fallback, preferred, mode: 'unresolved', fallbackSuppressed: false,
           pinned: false, attempted: false };
}
const suppressed = keys.size === 1 && keys.has(preferred);
```

新增字段 `attempted: boolean`（`false` = 一条失败记录都没有）。**保留 `fallback` 模板的其余字面值不变**，使"有记录"路径逐字节不变。

**(b) `_resolveCode`（`:216-262`）**：新增**最高优先级**分支

```js
// 必须置于 ① 钉选分支之前 —— "零尝试"是事实，"钉选"是解释；
// 有事实时不能用解释覆盖事实（这是契约②的同一条精神，但方向相反）。
if (!primaryCause) {
  return 'NO_ATTEMPT';
}
```

**(c) 新增 `TITLES` / `HINTS` 条目**

```js
TITLES.NO_ATTEMPT = '本次请求未能完成 —— 本轮未尝试任何通道';
HINTS.NO_ATTEMPT = [
  '通道级联未被进入：通道注册表为空，或全部通道未启用',
  '运行 `khy gateway status` 查看各通道是否已注册/启用',
  '若 `.env` 里有 GATEWAY_PREFERRED_ADAPTER 钉选，清空或设为 auto',
];
```

**(d) `renderCliFailureEnvelope`（`:346-367`）**：**无须改动**
`pinned-strict` 行的输出条件已是 `mode === 'pinned-strict'`；`unresolved` 自动不再输出该行。**但必须补一条断言钉住它**（否则未来有人改宽条件，bug 静默复活）。

### 3.2 第 2 期 — 调用方：诊断质量不得降级

`aiChatCore.js:3103-3129` 改为"**披露必留、诊断择优**"：

```js
if (retryPass && retryPass.result) {
  const first = buildCliFailureEnvelope({ result, env: process.env });
  const retry = buildCliFailureEnvelope({ result: retryPass.result, env: process.env });
  if (_diagnosticRank(retry) >= _diagnosticRank(first)) {
    result = retryPass.result;                     // 更好或同等 → 照旧覆盖
  } else {
    result = { ...result, content: `${result.content}\n\n（已自动放宽钉选并重试，仍未成功）` };
  }
  firstPass = retryPass;                           // 保持"回退已尝试"的披露
}
```

`_diagnosticRank(env)`：`cause !== null` 记 1 分，`cause === null` 记 0 分；同分时按码的具体性（`CHANNEL_ABSENT_PINNED` > `NONE`）。**放纯叶子**（可在 `cliFailureEnvelope.js` 内导出，零 IO、确定性、绝不抛），**不塞进 `aiChatCore`** —— 那里测不到。

> ⚠️ `buildCliFailureEnvelope` 在 `aiChatCore:3284` 才被 require（失败分支内）。第 2 期需把 require 提到重试判定处，或复用 `_env0`。落地时按 §8 待核实项核。

### 3.3 第 3 期 — 根因：钉选残留不再静默

> ⚠️ **实施期就地订正（2026-09-23）**：本节初稿写的是「**新增**一段钉选健康检查」。
> 实测该检测**早已存在两处** —— `baseSelfCheckService.js:517-545`（判 `error`，明说「所有 AI 调用将硬失败」，并带 autoRepair 改写 env）与
> `handlers/gateway.js:542-584` 的 `_resolvePreferredAdapterIssue` + `gatewayStatusView.js:492-500`（已渲染）。
> 按「不新建并行真源」的纪律，第 3 期改为 **补强既有告警**：把 `STRICT` 这个**放大器**披露出来
> （原先 `gateway status` 全文不提 STRICT，与 selfcheck 的判级轻重不一），并补上解钉路径。
> **完整落地清单、偏离与验收见 §9。**

`.env:47-48` 自己给了答案 —— *「要固定某通道请用 `khy provider use <key>`，不要再手改本文件的这两个值」* —— **但没有任何机制阻止手改**，于是复发 5 次。

提案：`khy gateway status` 增加一段**钉选健康检查**输出（当 `GATEWAY_PREFERRED_ADAPTER` 非 auto **且**该通道 `available === false` 时）：

```
⚠ 钉选残留：GATEWAY_PREFERRED_ADAPTER=api 但该通道当前不可用
   这会让每次请求都失败在首选通道上（若 STRICT=true 还会抑制回退）
   处置：khy provider use <key>  或  把 GATEWAY_PREFERRED_ADAPTER 设为 auto
```

> ⚠️ **不新增 env 开关** —— `check-tui-gates.js:32` 的 `MAX_GATES = 220` 是**只降不升**的棘轮。本项并入既有 `khy gateway status` 输出即可，零新门。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 改动 | 回滚 | 依赖 |
|---|---|---|---|
| **第 1 期** | `cliFailureEnvelope.js`：`_resolveRouting` 增 `unresolved`/`attempted`；`_resolveCode` 增 `NO_ATTEMPT`；新增 2 条 `TITLES`/`HINTS` | 单文件 revert | 无 |
| **第 2 期** | `aiChatCore.js:3103-3129` 覆盖策略 + 叶子 `_diagnosticRank` | 单处 revert | 第 1 期（需 `attempted` 字段） |
| **第 3 期** | `khy gateway status` 增钉选健康检查 | 单处 revert | 无 |
| **第 0 期**<br>（用户侧，即刻） | 把 `.env:51-52` 改为 `auto` / `false` | 改回 | 无 —— **但见 §6 反模式第 2 条：这不解决复发** |

---

## 5. 诚实边界（刻意不纳入）

1. **不修「证据为何缺失」的那个具体环节。** 这需要运行时证据（见 §8）。本方案的目标是**让证据缺失本身可诊断** —— 而不是猜哪一环丢了、再打一个补丁。**这是刻意的**：只要信封仍会把"零证据"翻译成"钉选抑制"，同类缺陷下次换个入口再来一遍，症状还是一模一样。
2. **不改级联 / 不改重试 / 不改路由决策。** 第 1 期只动**诊断的措辞与码**，对"请求成功还是失败"的判定**零影响**。
3. **不改 `.env` 的值。** 那是用户本机配置，由用户决定（第 0 期给了建议但不代改）。且该文件不入库，改了也修不到别的机器。
4. **不动 `aiContextFlow.js:374-378` 的合成。** 它丢 `attempts` 是事实，但它丢 `preferredAdapter` 也一致 ⇒ **单靠它解释不了截图**（截图有"钉选 strict"行 ⇒ 必带 `preferredAdapter`）。既然前提不成立，就不拿它当嫌疑人。
5. **不把 jest 风格的 `cliFailureEnvelope.test.js` 改成 `node:test`。** 它当前在 `node --test` 下红（§8），但那是独立的一条既有问题，混进本方案会让 diff 失去可归因性。

---

## 6. 反模式（这条路别走）

| ❌ | 为什么 |
|---|---|
| 继续用 `keys.size === 0`「保守取真」当 `pinned: true` | **把「未知」伪装成「已知」**，这就是本 bug 的成因本身。「零尝试」与「试了被拦」，是**两个不同的事实** |
| 只把 `.env` 改回 `auto` / `false` 就收工 | 已复发 **5** 次，文件里 4 段注释就是尸体。**改值不解决「下次还能改回去」** |
| 删掉 `aiChatCore:3120` 的回退重试 | 回退本身有价值（api 死了切别的通道）。该死的是**用差结果覆盖好结果** |
| 把 `errorType='unknown'` 渲染成「未知错误」 | 应报「零尝试」—— 那是**可确定的事实**，不是未知 |
| 在 `.env` 注释里再写一句「别再改」 | 前 4 次就是这么处理的 |
| 把新码挂到 `CHANNEL_EXHAUSTED` 上 | 那个码会 `showPromoPanel = true`（`:308`）⇒ 12 行推广清单抢占首屏，正是 `[DESIGN-ARCH-114]` §2.2 红线 R-GW-1 要禁的 |
| 为第 3 期新增 `KHY_*` 开关 | 撞 `check-tui-gates.js` 门预算棘轮（220，只降不升），且把一个 bugfix 从 B-P1 豁免变成非豁免 |

---

## 7. 验收方式

### 7.1 新增测试（**必须用 `require('node:test')`**）

新建 `services/backend/tests/gateway/cliFailureEnvelopeZeroAttempt.test.js`：

| 用例 | 断言 |
|---|---|
| Z-01 无 `attempts` 字段 | `code === 'NO_ATTEMPT'`；`cause === null` |
| Z-02 `attempts: []` | 同上 |
| Z-03 记录缺 `success` 字段 | 同上 |
| Z-04 有 `success:false` 记录 | `code !== 'NO_ATTEMPT'`（对照组，防误伤） |
| Z-05 全 virtualSkip | `code !== 'NO_ATTEMPT'`（对照组） |
| Z-06 **渲染不含钉选行** | `renderCliFailureEnvelope(e)` **不匹配** `/路由: 钉选 strict/`（**这是本 bug 的直接药，必须钉住**） |
| Z-07 `routing.attempted === false` 且 `pinned === false` | 字段级 |
| Z-08 有记录时 `mode` 仍为 `pinned-strict` | **回归**：确保旧行为逐字节不变 |

**为什么必须 `node:test`**：
- `jest.config.js:25-40` 按 `require('node:test')` 标记**自动发现并加入 `testPathIgnorePatterns`** ⇒ jest 套件不会重复跑、不会因两套 runner 冲突而红
- `package.json:59` `test:node = node --test tests/**/*.test.js` ⇒ 该文件**进 CI** ⇒ **落地即须绿**
- ⚠️ **不要往既有的 `cliFailureEnvelope.test.js` 里加** —— 它是 jest 风格（HEAD 即如此），在 `node --test` 下报 `describe is not defined`（§8）

### 7.2 反向复现（人工，一条操作）

`.env` 保持 `api` + `true` 且 `api` 通道不可用 → TUI 输入任意消息 →

- **修前**：`[NONE]` + `路由: 钉选 strict(GATEWAY_PREFERRED_ADAPTER=api),本轮不回退`
- **修后**：`[NO_ATTEMPT]` + **无**路由行 + hint 指向"通道注册表为空或全部未启用"

### 7.3 关联门禁

```bash
node scripts/ci/check-leaf-contract.js services/backend/src/services/gateway/cliFailureEnvelope.js
node scripts/ci/check-tui-gates.js          # 比改动前后 counts 零漂移（新增 0 个 KHY_* token）
npm run check:changed
```

> `cliFailureEnvelope.js` 是纯叶子（零 IO、确定性、绝不抛）；改动后须过叶子契约门。
> **`check-tui-gates.js` 不带参数会报 "No target files found"**（要 `--changed` 或显式路径），别误判成 PASS。

---

## 8. 待核实项

### ★ 优先（阻断"确证"，不阻断修复）

**T-1：`attempts` 里那条该有的 `success:false` 记录，具体在哪一环丢失或形状不符？**

已逐条排除：
- `allAttempts` 在 `:2036` 建空后**只增不减**（全文件无重赋值），首次 push 在 `:3699`
- `:2036–3699` 之间**没有任何 `return`**（`:2017`/`:2030` 是应用启动/桌面拦截且在其之前）
- 仅有两处「不 push 的 continue」：`:3872`（strict 跳过非首选）、`:3878`（`!entry.enabled`）。但 `_adapters` 是 `aiGateway.js:2161` 的**静态表，16 条全部 `enabled: true`**
- `:4033`「通道不可用」分支**会 push**（`:4040`）⇒ 不在嫌疑名单
- `_reorderAdaptersByModelProtocolHint`（`aiGatewayRoutingMethods.js:742-747`）只重排不筛选，**不会致空**
- `_maybePromoteProcessFailoverAdapters`（`:816-833`）对非 process-sensitive 的 `api` 直接 `return list`

**确定入口（形状污染）**：`:4580` `allAttempts.push(...result.attempts)` —— 子调用的 attempts **原样并入、不校验形状**。若子调用记录缺 `success` 字段，会污染主链判据。

**确证手段**（任选其一，均为只读）：
1. 在 `:6408` 前临时打印 `allAttempts.length` 与 `allAttempts.map(a => !!a.success)` → 一次复现即知是"空数组"还是"缺字段"
2. 查 `traceAudit` 的 `llm.response` 事件（`aiGatewayClient.js:146-169` 已记录 `attempts` 字段）落盘的日志
3. 跑 `KHY_DEBUG_TOOLS=1` 复现，看 `[DEBUG-ADAPTER] cascade: key=… available=…` 序列是否为空

### 其它

- **T-2**：`services/backend/tests/gateway/cliFailureEnvelope.test.js` 在 `node --test` 下**当前即红**（实测 `exit=1`、`# fail 1`、`ReferenceError: describe is not defined`），且 HEAD 版本就是 jest 风格 ⇒ **既有红，非本次引入**。但 `deploy-staging.yml:97-99` 明写 `test:node` 经 shell 展开跑 **1288** 个文件 ⇒ 这条红在 CI 里**也应该可见**。**建议单独核一次**（可能新近引入，也可能是 glob 行为差异）。这是 `[DESIGN-ARCH-135]` 记过的同型陷阱第二例。
- **T-3**：`aiChatCore.js:3120` 的 require 时序 —— `buildCliFailureEnvelope` 目前在 `:3283`（失败分支内）才被 require，第 2 期需提前到重试判定处（`:3105`）。落地前确认无循环依赖。
- **T-4**：第 3 期落点时确认 `khy gateway status` 的可用通道判定与 `:4030` `entry.adapter.detect()` 同源（避免又造一个平行真源）。

---

## 9. 实施记录

**落地日期**：2026-09-23 · **状态**：第 1 / 2 / 3 期均已落地并验证

### 9.1 落地清单

| 文件 | 改动 | 期 |
|---|---|---|
| `services/backend/src/services/gateway/cliFailureEnvelope.js` | `_resolveRouting` 增 `attempted` 字段与 `unresolved` 模式（零尝试时 `pinned:false`）；「零尝试」的计算提前到 preferred 判定之前；`_resolveCode` 兜底位新增 `NO_ATTEMPT`；新增 `TITLES.NO_ATTEMPT` / `HINTS.NO_ATTEMPT`；新增并导出 `_diagnosticRank` | 1 |
| `services/backend/src/cli/aiChatCore.js`（回退重试分支） | 改为「披露必留、诊断择优」：用 `_diagnosticRank` 比较首次与重试的诊断，仅当重试更差时保留首次并追加「已自动放宽钉选并重试一轮」 | 2 |
| `services/backend/src/cli/handlers/gateway.js`（`_resolvePreferredAdapterIssue`） | 增 `strict` 字段（判据与 `aiGatewayGenerateMethod.strictPreferredByEnv`、`baseSelfCheckService.strictPinned` 同源），`invalid` / `unavailable` 两个 branch 均回传 | 3 |
| `services/backend/src/cli/handlers/gatewayStatusView.js`（`preferredIssue` 渲染） | 两类 issue 均披露 strict 后果（「每次 AI 调用都会硬失败」）+ 补解钉路径（清空/设 auto、`GATEWAY_PREFERRED_STRICT=false` 这条中间路、`khy doctor`） | 3 |
| `services/backend/tests/gateway/cliFailureEnvelopeZeroAttempt.test.js` | **新增** 15 条（`node:test`） | 1+2 |
| `services/backend/tests/gateway/preferredAdapterIssueStrict.test.js` | **新增** 3 条（`node:test`，源码级守卫） | 3 |
| `services/backend/tests/gateway/cliFailureEnvelope.test.js` | **更新 1 条断言**：`NONE` → `NO_ATTEMPT`（原因见 9.2-5） | 1 |

### 9.2 与方案的偏离（逐条给原因）

1. **`NO_ATTEMPT` 挂在「兜底位」，而非方案 §3.1(b) 写的「最高优先级」** —— 照初稿实现会**用新误报换旧误报**：本文件已有一批**不依赖 `primaryCause`** 的分支（auth / rate_limit / server_error / network / timeout / model_not_found / context_length / unavailable），它们只看顶层 `errorType`。若把 `NO_ATTEMPT` 提到最前，「零记录但 `errorType` 明说是认证失败」会被压成「未尝试任何通道」。**正解**：零记录 + 有已知类型信号 → 照实报该类型；零记录 + 无任何信号 → 才报 `NO_ATTEMPT`。已由 **Z-07** 钉住。
2. **「零尝试」的计算必须早于 preferred 判定** —— 方案未提。实施时 **Z-08** 暴露：`!preferred` 早退会直接返回 `fallback`（`attempted` 默认 `true`），等于在另一条分支上把同一个事实丢掉。已改为先算 `keys`、再判 `preferred`。
3. **`_diagnosticRank` 只分档、不在码之间排具体性** —— 方案 §3.2 写「按『码的具体性』序」。实施时判定**无依据**：没有客观标准说「401 比 unavailable 更具体」。落地为四档（有 cause = 100 / `NO_ATTEMPT` = 2 / 其它无 cause = 1 / `NONE` = 0），**同档不触发保留**（维持旧的覆盖行为 = 最小惊讶）。**Z-13** 把这个边界写成了断言，函数注释里也说明了「只分档」。
4. **第 3 期从「新增检测」改为「补强既有告警」** —— 见 §3.3 订正块。
5. **`cliFailureEnvelope.test.js` 有 1 条断言必须更新** —— 它把**归档行为**写成了规范：「无 attempts 且无信号 → NONE」。该文件在 `node --test` 下本就红（§8 T-2），但在 CI 的 **jest** 路径（`npm test`）下是绿的 ⇒ 不改会让 CI 变红。只改断言值并加一行说明，**没有**把它重写成 `node:test`（§5 明确不混两套 runner）。
6. **未推荐 `khy provider use`** —— 初稿引用了 `.env:32` 的说法，但实测该命令只有 `cmdc` 分支有「写 `GATEWAY_PREFERRED_ADAPTER`」的直接证据（`provider.js:243`），通用分支未验证 ⇒ **不把未验证的命令写进用户可见建议**。

### 9.3 验收实测

| 项 | 命令 | 结果 |
|---|---|---|
| 语法 | `node --check` × 7 文件（4 源 + 3 测试） | **7/7 exit=0** |
| 新用例 | `node --test tests/gateway/cliFailureEnvelopeZeroAttempt.test.js tests/gateway/preferredAdapterIssueStrict.test.js` | **18/18 绿**（Z-01..Z-13b 共 15 + P-01..P-03 共 3） |
| 既有套件零回归 | 影子复刻 `cliFailureEnvelope.test.js` 的 **27 条断言**逐条跑（本机未装 jest，见 §8 T-5） | **27/27 绿**（含更新后的那条） |
| 叶子契约 | `node scripts/ci/check-leaf-contract.js …/cliFailureEnvelope.js` | **PASS**（仍零 IO / 确定性 / 不读 `process.env`） |
| 门预算棘轮 | `node scripts/ci/check-tui-gates.js --changed` | **226 unique（限 220）—— 与改动前基线一致，零漂移**；既有红，非本次引入 |
| 本 bug 直证 | 探针逐形状枚举（8 组） | 零尝试 4 组 → `[NO_ATTEMPT]` 且**渲染不含「路由: 钉选 strict」行**；对照组（有记录）行为逐字节不变 |

### 9.4 明确不做

- **不改 `services/backend/.env` 的值** —— 用户本机配置，且不入库（改了也修不到别的机器）。第 0 期只给建议。
- **不修「证据为何缺失」的具体环节**（§8 T-1 仍未确证）。本方案的目标是让**证据缺失本身可诊断**。
- **不给第 3 期加行为级测试** —— `_resolvePreferredAdapterIssue` **未导出**（经 `setGatewayStatusViewDeps` 以 DI 注入 `gatewayStatusView`；实测 `exports 命中 = false`），其宿主 `gateway.js` 顶层携带大量 DI 装配。为不扩大导出面（牵动 API 契约门），退化为**源码级守卫**，并在此如实登记该限制。
- **`check:file-ratchet` 未在本地跑** —— 需 `GIT_BASE_REF`，本地 3 分钟未完成（既有已知限制）。新增代码零 `console` / 零 `debugger` / 零 `TODO`，函数与嵌套均在 `maxFuncLines 300` / `maxNesting 6` 之内。

### 9.5 ★ 实施中发现的下一个真问题（✅ 已于同日第二轮落地，见 §9.6）

**告警已经报出，用户还是踩了坑。**

证据：2026-09-23 **08:16** 的每日规范巡检已报
「env-gateway-pin **2 error**（两个 `.env` 硬钉 `api` + `STRICT=true`，AI 通道全灭风险，历史上 3 次复发）」，
而用户 **10:29** 仍在 TUI 撞上同一个错误。

即 `baseSelfCheckService` 的检测**判得对、判得重（error）、还带 autoRepair** —— 但它只活在
**用户主动跑** `khy doctor` / selfcheck 的路径上。**TUI / REPL 启动时不做这次检查。**

⇒ 真正该修的是**启动路径**（网关初始化或 TUI 启动时做一次廉价检查并直接告警），
而不是继续加强告警文案。这超出本方案范围（涉及启动路径改动，风险面更大），**留待拍板**。

### 9.6 §9.5 的落地（同日第二轮）：启动路径接入钉选自检

**动手前又推翻了一次 §9.5 的前提**（本方案第三次自我订正）：取证发现启动自检**并非没接** ——
`replSession.js:1086` 早就在跑 `autoStartFromEnv()`。真正的断点有两个：

| 路径 | 实况 |
|---|---|
| **TUI** | `startRepl:672` 的 `await startInkApp` 是早返回 ⇒ `:1086` 的自检**从未执行**。与 `:655-670` clipboard bridge 注释自认的 *"the TUI path never reached it"* 同一形态的坑 |
| **经典 REPL** | 自检跑了，但 `runOnce` 结果**只写日志文件**（`start()` 里 `.catch(() => {})` 丢弃返回值），界面零呈现 |

**落地**（3 源文件 + 1 新测试，判据/文案 100% 复用，零新增 env）：

| 文件 | 改动 |
|---|---|
| `baseSelfCheckService.js` | 导出轻量单检 `checkGatewayPreferredOnce(opts)` —— 只包 `_checkGatewayPreferred`，判据/文案/autoRepair 语义 100% 复用，双层 fail-soft 绝不向启动路径抛 |
| `replSession.js` | 新增 `_kickoffGatewayPinStartupCheck({toTui})`（fire-and-forget，绝不 await / 绝不抛）；**TUI 分叉之前**调 `{toTui:true}`、经典 REPL 自检块后调 `{toTui:false}` |
| 呈现（既有机制，零新代码路径） | TUI → `notificationPort.emitNotification`（**挂载前进缓冲、挂载时 seed 回放** —— `App.js:1704-1760` 既有机制，时序天然安全；error 级窄屏还会 inline 打一次）；经典 REPL → `formatters.printError/printWarn` |
| `tests/cli/gatewayPinStartupCheck.test.js` | **新增 8 条**（`node:test`） |

**验收**：新用例 **8/8 绿** —— 三条核心断言全中：G-05（启动触发点位于 `startInkApp` 之前）、
G-02（`api`+`true` + 通道不可用 → **error** 级「strict 禁止回退」）、G-03（解钉路径
`GATEWAY_PREFERRED_ADAPTER=auto` 对用户可见）；门预算 **226/220 零漂移**；`node --check` 3/3。
另 G-04 钉住「非 strict 判 warning」不被改变、G-08 钉住「健康通道零误报」。

**测试安全红线**：凡「未注册」场景的用例一律显式传 `{ autoRepairPreferred: false }` ——
autoRepair 会**真写 `.env`**（`_writeGatewayEnvPatch`），测试绝不能触发；`unavailable` 场景
（G-02）走真实默认路径（该分支本身只报不修）。

**风险评估**：
- **非阻断硬保证**：调用点 fire-and-forget（G-06 源码钉住）；检查自身有 `SERVICE_HEALTH_TIMEOUT_MS` 超时保护 + 双层 try/catch —— 预检任何失败都只少一条提示，不影响启动。
- **双跑冗余**：经典 REPL 现在会跑两次网关钉选（新预检 + `runOnce` 内置）。判定幂等只读；autoRepair 仅在「未注册」场景触发且写幂等 —— 可接受，不为去重加状态。
- **TUI 呈现零自绘**：完全走既有通知端口（`notificationPort` 与 `App.js` 渲染端一行未改），无 ink 布局风险；`emitNotification` 本身 fail-soft（无 renderer / 抛错都只返回 false）。

---

## 10. 变更日志

| 日期 | 变更 |
|---|---|
| 2026-09-23 | 初稿。由 TUI 实机截图触发；9 组形状枚举定位判据；四步触发链 file:line 取证；归因确认非并行会话引入 |
| 2026-09-23 | 第 1/2/3 期落地并验证（§9）。`NO_ATTEMPT` 落在兜底位（偏离见 §9.2-1）；第 3 期改为补强既有告警；发现「告警已报出但未拦住」为下一个真问题（§9.5） |
| 2026-09-23 | §9.5 落地（§9.6）：启动自检**早已接线**但 TUI 走不到、经典 REPL 看不见 —— 导出 `checkGatewayPreferredOnce` 轻量单检 + `replSession` 双路径非阻断预检（TUI 走通知端口缓冲/回放）；新用例 8/8、门预算 226/220 零漂移 |
