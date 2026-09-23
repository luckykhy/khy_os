# [DESIGN-ARCH-139] 网关零尝试(NO_ATTEMPT)与钉选残留第 6 次复发修复方案

> **状态**：提案（未实施）
> **范围**：`services/backend/src/services/gateway/`（`aiGatewayGenerateMethod.js`、`cliFailureEnvelope.js`、`aiGatewayGenerateHelpers.js`）+ 本机态 `services/backend/.env` 的钉选生命周期
> **上游依赖**：无外部依赖（本仓自有缺陷修复）
> **调研指针**：[DESIGN-ARCH-136]（零尝试被误报为钉选抑制的修复 —— 本提案是其后续：NO_ATTEMPT 落地后抓到的第一起真实零尝试）、[DESIGN-ARCH-114]（RUNTIME-005 通道诊断口径）
> **模板合规**：按 [DESIGN-ARCH-124] 体例；非借鉴类改动，B-P1 豁免（见 §2）

---

## 0. 一句话结论

用户实测报出 `[NO_ATTEMPT]`（本轮未尝试任何通道）。证据链显示这是**两个缺陷叠加**：

| # | 病灶 | 位置 | 性质 |
|---|------|------|------|
| ① | **钉选残留第 6 次复发**：`GATEWAY_PREFERRED_ADAPTER=claude` + `GATEWAY_PREFERRED_STRICT=true`，而文件内 4 段「已改为 auto」的修复注释与值背离 | `services/backend/.env:51-52`（注释 `:12-50`） | 本机态配置，**改值不改机制 = 必复发**（已复发 6 次：codex→windsurf→windsurf→api→api→claude） |
| ② | **strict 静默跳过不留痕**：strict 钉选下非首选通道被 `continue` 跳过，既不写 attempts 记录也不输出状态 ⇒ 一旦首选通道路径未产生记录，整轮就是零尝试，`NO_ATTEMPT` 的 hint（「注册表为空或全部未就绪」）沦为二选一猜测 | `aiGatewayGenerateMethod.js:3875`（strict 跳过）、`:3881`（disabled 跳过）——对照：不可用跳过 `:4043`、冷却跳过 `:4090`、人工中转跳过 `:3934` **都留痕** | 代码缺陷（观测面缺口） |
| ③ | **失败建议文案在诱导复发**：报错时建议「khy gateway config 调整首选模型通道」——用户照做就写入新钉选，钉到一个本机不可用的通道后再次硬失败 | `aiGatewayGenerateHelpers.js:925` | 代码缺陷（文案） |

`NO_ATTEMPT` 信封本身是 [DESIGN-ARCH-136] 刚落地的**诚实改进**（如实报「零尝试」替代旧 NONE 的编造因果），方向正确，本提案不回退它，只补它的观测粒度。

**复发机制链**（这是要修的「机制」，不是某个值）：

```
失败 → 建议文案「khy gateway config 调整首选通道」(:925)
     → 用户钉选某通道（khy provider use / 手改 .env）
     → 被钉通道本机不可用 + STRICT=true 抑制回退
     → 硬失败 → 再报错 → 再建议 …… 循环
解钉只能靠人工，且没有任何健康复查 / 过期 / 背离告警
```

---

## 1. 现状实证（file:line 可复核）

### 1.1 本机态事实（.env，不受 git 跟踪）

| 行 | 内容 | 含义 |
|----|------|------|
| `.env:51` | `GATEWAY_PREFERRED_ADAPTER=claude` | 钉选 claude 通道 |
| `.env:52` | `GATEWAY_PREFERRED_STRICT=true` | 抑制级联回退 |
| `.env:12-50` | 4 段修复注释（09-14 / 09-17×3）全部写明「改为 auto / false」「不要再手改这两个值」 | **注释与值第 4 次背离**；前 5 次复发通道：codex→windsurf→windsurf→api→api |
| `.env:6-7` | `PROXY_PRIMARY_ADAPTER=relay_api` + `PROXY_PRIMARY_STRICT=true` | 第二层钉选（relay 代理链路） |
| `.env:11` | `RELAY_API_KEY=quality-gate-windsurf-access-token-fixture` | 假值；`:49-50` 注释自认 relay_api 必然 401，属 quality-gate 故意 fixture，**不要据此判断全局无通道** |

### 1.2 信封判定链（为什么显示成这样）

| 环节 | 位置 | 行为 |
|------|------|------|
| `attempted` 判定 | `cliFailureEnvelope.js:127-147` | `attempted = (attempts 中 success:false 的 adapterKey 去重数) > 0`；零记录 → `mode:'unresolved', attempted:false` |
| 判码兜底位 | `cliFailureEnvelope.js:308-315` | 无已知 errorType 信号 + `routing.attempted===false` → `NO_ATTEMPT`（136 方案刻意挂在兜底位，防压掉真实认证类信号） |
| hint 猜测文案 | `cliFailureEnvelope.js:195-199` | 「通道注册表为空,或全部通道未启用/未就绪」——**两种候选原因都是猜的**，信封手边其实没有注册表实测数据 |
| 用户贴文吻合度 | `aiGatewayGenerateHelpers.js:890` | 贴文里没有「内部已尝试 N 次」行 = `attempts.length===0` → `_describeInternalAttempts` 返回 `''`，与零尝试完全一致；「处理方法：网络/超时类…」两行来自 `:924-925`（errorType 落 `unknown` 命中 `/unknown/` 分支） |

### 1.3 级联循环的「留痕 vs 静默」对照（`aiGatewayGenerateMethod.js`）

| 跳过/失败路径 | 位置 | 留痕？ | 状态输出？ |
|---|---|---|---|
| strict 钉选下非首选通道 | `:3875-3877` | ❌ 无 push | ❌ 无 emitStatus |
| 通道 disabled | `:3881-3883` | ❌ 无 push | ❌ 无 emitStatus |
| 人工中转自动级联跳过 | `:3921-3943` | ✅ push（`virtualSkip:true`） | ✅ |
| 通道不可用（detect=false） | `:4036-4050` | ✅ push | ✅ |
| 失败冷却 fast-fail 跳过 | `:4088-4098` | ✅ push（`virtualSkip:true`） | ✅ |

⇒ **零尝试只可能来自静默路径**（或级联前异常逃逸）。strict 钉选时所有非首选通道恰好都走在 `:3875` 的静默路径上；首选通道 claude 本机不可用与否沙箱内无法实测（见 §8-1），但无论哪条子路径，观测缺口都真实存在。

### 1.4 现有自动解钉的局限（`:2539-2552`）

`_maybeRelaxEnvPinnedUnavailable` 已存在，但有三个边界使它兜不住本案例：

1. **只放宽当次请求**：`strictPreferredOnly = false` 是局部变量，不写回 `.env` —— 下次请求、下个进程照样钉回；
2. **只对「env 钉选」生效**（`:2543` 排除 `userPinnedAdapter` 与显式 `options.preferredAdapter`）—— 若用户经 `khy provider use` 显式钉选，永远不会自动解；
3. **触发条件窄**：只在被钉通道 `unavailable` 或「处于失败冷却」两个分支被调用（`:4054`、`:4102`），其它零尝试子路径不经过它。

### 1.5 环境硬限制（本会话实测）

本沙箱跑 `khy gateway status` 被安全策略拦截：各 IDE 适配器（kiro/cursor/trae/windsurf 等）在 Windows 上探活会 spawn `reg.exe` 查注册表，`reg.exe` 在沙箱程序黑名单。⇒ **claude 通道本机实际 available 值待用户侧确认**（§8-1）。

---

## 2. 借鉴提案（B-P2 七字段）

**不适用。** 依据：[SOURCING-001] §3 B-P1 —— 本提案是对已登记能力域（`aiGateway` 路由级联 / `cliFailureEnvelope` 诊断信封）的**行为修正与观测增强**，无任何外部借鉴对象。七字段无「借鉴对象」可填，为合规起见逐项声明：字段 1-7 均不适用（不引入任何上游代码/结构/结论）。

---

## 3. 目标形态（组件级契约）

### D1（一期）跳过留痕 —— strict/disabled 跳过各写一条 virtualSkip 记录

- `:3875` strict 跳过 → `allAttempts.push({ provider, adapterKey, success:false, error:'skipped: strict pin suppresses fallback', statusCode:0, errorType:'strict_skipped', virtualSkip:true })`
- `:3881` disabled 跳过 → 同型，`errorType:'disabled_by_config'`
- **安全性依据**：`_pickPrimaryCause` 优先取非 virtualSkip 记录（`cliFailureEnvelope.js:81`），不会污染真实失败归因；健康度统计过滤 virtualSkip（`aiGatewayGenerateMethod.js:6262`），不会毒化熔断。与 `:3934`/`:4090` 的既有留痕完全同型。
- 效果：今后再也不可能出现「零尝试」被静默生产出来；`NO_ATTEMPT` 只剩「级联前异常逃逸」一种真实来源。

### D2（一期）零尝试事实化 —— hint 用实数替代猜想

- generate 末端（`:6399` 终局结果）在 `allAttempts` 全为 virtualSkip 或为空时，附 routing 元数据：`{ registered: N, enabledCount: M, strictPinned: preferredAdapter||'' }`（三个数手边都有：`this._adapters.length`、enabled 过滤、preferredAdapter）。
- `cliFailureEnvelope.js` NO_ATTEMPT hint 改为读实测：「通道注册表 N 条、enabled M 条、strict 钉选 X」—— 不再输出「为空或未就绪」的二选一猜测。

### D3（二期）钉选租约 —— 机制修复核心

- env 钉选（非显式 options 钉选）的被钉通道连续 **2 次**判 `unavailable` / `not registered` → **自动把 `.env` 的两个值复位**（`GATEWAY_PREFERRED_ADAPTER` 删行或置 auto、`GATEWAY_PREFERRED_STRICT=false`），并：
  - `emitStatus` 披露「钉选通道 X 不可用，已自动解钉并写回 .env」（RUNTIME-002 状态透明）；
  - 在 .env 对应位置追加一行带日期的自动解钉注释（编辑式写入，**保留原有注释**，杜绝新的「注释与值背离」）。
- 显式用户钉选（`khy provider use`）首次仍走 `_maybeRelaxEnvPinnedUnavailable` 的当次放宽 + 披露；连续不可用达到租约阈值后同样自动解钉 —— 但解钉必须披露，且在 `khy provider status` 里可见「上次自动解钉记录」。
- 落点建议：新叶子模块 `gateway/envPinLease.js`（纯逻辑：给定连续失败序列与阈值，输出「解钉/续租」决策，可单测），写入动作在 generate 侧执行。

### D4（三期）建议文案去诱导

- `aiGatewayGenerateHelpers.js:925` 改为：「可切换其他通道：khy gateway model 选择模型（不钉通道）；如确需固定通道，用 khy provider use <key>（固定后该通道不可用将抑制回退）」。
- `cliFailureEnvelope.js:198` NO_ATTEMPT hint 的第三条同步改写（当前写法「清空或设为 auto」本身没错，保留，但补一句指向 D3 的自动解钉行为）。

### D5（三期，可选）.env 注释-值对账提示

- `.env` 载入路径上：若 `GATEWAY_PREFERRED_ADAPTER` 值 ≠ auto 且文件注释含「已改 auto」字样 → 打一条 warning 日志。低成本、防第 7 次背离。实现放叶子（读文本 → 布尔），载入侧消费。

---

## 4. 实施分期（每期独立可回滚）

| 期 | 内容 | 回滚方式 | CI 风险 |
|----|------|----------|---------|
| 一期 | D1 + D2（纯观测：只增记录与披露，不改路由决策） | 撤掉两处 push 与元数据字段即可 | 低：新测试用 `require('node:test')` 放 `tests/gateway/`（CI 全量 glob 会扫到，**必须落地即绿**；勿往 jest 风格文件追加用例，另建文件） |
| 二期 | D3 钉选租约（改 .env 的唯一新增写入方） | 删调用点 + 不再写回即可；已有 `_maybeRelax` 当次放宽兜底 | 中：涉及 .env 写入，需验证保留注释的编辑式写法 |
| 三期 | D4 + D5（文案与提示） | 纯文案回退 | 零 |

顺序理由：一期先落，让「零尝试」这个观测盲区先消失 —— 二期租约的触发计数依赖留痕数据；若先做租约，等于在看不见的地方装自动刹车。

---

## 5. 诚实边界（刻意不纳入）

| 不做 | 原因 |
|------|------|
| 不动 `PROXY_PRIMARY_ADAPTER=relay_api` 那层 | 它是 relay 代理服务器的独立链路配置；fixture 假 key 是 quality-gate 故意放的（`.env:49-50` 自证）。动它会把两个问题搅在一起。已在本提案登记其与本 bug 的耦合风险 |
| 不废除 `GATEWAY_PREFERRED_ADAPTER` 钉选机制 | 有真实用户价值（单通道稳定优先、成本可控）。修的是「钉选没有生命周期」，不是「不许钉选」 |
| 不把 NO_ATTEMPT 提到判码最高优先级 | [DESIGN-ARCH-136] 已论证：会把「零记录但 errorType 明说认证失败」压成「未尝试」，用新误报换旧误报 |
| 不在本仓加「.env 内容守卫」进 CI | `.env` 不受 git 跟踪，CI 扫不到；D5 的运行时提示是唯一可行位置 |
| 不顺带修 `_resolveActiveChannelKey` / 通道生命周期其它环节 | 超出本缺陷范围，另行立项 |

---

## 6. 反模式（这条路别走）

| ❌ 别做 | 为什么 |
|---|---|
| **只把 .env 改回 auto 就收工** | 这正是前 5 次「修复」的全部内容 —— 第 6 次已经发生。改值不改机制 = 必复发 |
| 把「跳过」改成「失败」来凑记录 | strict 跳过如果记成真实失败（非 virtualSkip）会毒化熔断与健康度统计，把路由问题变成可用性问题。必须用 `virtualSkip:true` 同型留痕 |
| 让自动解钉静默执行 | 用户钉选是有意的配置意愿，无声吞掉违反 RUNTIME-002（状态透明）。解钉必须 emitStatus + 留痕 + 可查 |
| 在 `:3875` 只加一行 emitStatus 就当修完 | 状态行转瞬即逝、不可存留；失败信封才是可交付的观测面。留痕必须进 `attempts` |
| 为「诊断更准」重写 `_resolveCode` 的优先级表 | 136 方案刚定的兜底位语义经过对齐验证；本提案只在兜底位的**hint 内容**上做增量，不动判码顺序 |
| 用进程重启来「清除钉选」 | env 是从 .env 文件读的，重启读回同样的值 —— 治标都不算 |

---

## 7. 验收方式

```bash
# 单测（新增文件用 node:test，落地即绿）
node --test services/backend/tests/gateway/<新测试文件>.test.js
# 既有信封套件零回归（jest 风格 —— 本机无 jest，走影子跑纪律，见提案技能 §8.2）
node --test services/backend/tests/gateway/cliFailureEnvelope.test.js   # 预期仍 exit=1(jest 全局缺失)，以影子跑 27 条为准

# 复现验收（一期落地后）
#   GATEWAY_PREFERRED_ADAPTER=claude + STRICT=true 且 claude 不可用时：
#   期望信封不再显示 [NO_ATTEMPT]，而是显示带 virtualSkip 明细的真实跳过记录
#   + hint 给出「注册表 N 条 / enabled M 条 / strict 钉 claude」实数
# 二期落地后：同场景连续第 2 次请求 → .env 自动复位 + 状态行披露

khy gateway status   # 人工复核通道健康（本沙箱无法代跑）
```

关联门禁：改的是既有登记文件，无新执行器 ⇒ 无需动 RULES-REGISTRY；`npm run check:wiring` 确认无孤儿。属 S1 诊断增强，不设阻断门（PROCESS-008 PP-3）。

---

## 8. 待核实项

| # | 事项 | 阻断什么 | 状态 |
|---|------|----------|------|
| 1 | claude 通道本机 detect 实际值（available / 未安装 / 无凭据） | 不阻断设计；决定用户侧立即处置的紧迫度 | ⚠ 沙箱 reg.exe 黑名单无法代跑，需用户执行 `khy gateway status` |
| 2 | 零尝试的精确子路径（strict 静默跳过后首选通道异常逃逸 vs 其它） | 不阻断一期（D1 落地后自然可观测） | 开放 |
| 3 | `khy provider use` 写入 .env 的具体 writer 位置与编码处理 | 阻断二期 D3 的写回实现 | 本提案引用了 `.env:32` 注释，未逐行核 writer 源码 |
| 4 | .env 编辑式写回对中文注释的编码安全（UTF-8 无 BOM） | 阻断二期 | 开放（参考软著交付包踩过的 PowerShell 编码坑，走 Node fs 写） |

---

## 9. 变更日志

- 2026-09-23 初稿：实测确诊第 6 次钉选残留复发（claude+strict）与零尝试观测缺口；NO_ATTEMPT 诊断链核对（与 [DESIGN-ARCH-136] 衔接）；提出跳过留痕 / 零尝试事实化 / 钉选租约 / 建议文案去诱导四项机制修复。
