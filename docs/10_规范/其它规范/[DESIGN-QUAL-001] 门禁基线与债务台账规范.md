# [DESIGN-QUAL-001] 门禁基线与债务台账规范

> **状态**：生效中
> **解决的问题**：两个门禁都**长期为红或形同虚设**，于是被全体忽略 ——
> ① `code-standards` 的基线数字**不是测出来的**（`functionLines` 与 `nestingDepth`
> 都写 10800，最大容忍 12000，而实测分别是 2145 与 8707，容忍度是实际的 5.6 倍与 1.4 倍）；
> ② `check-repo-layout` 存量 5 类违规（合计 148 处）而 baseline 全为 `0`，门永远红。
> 红着的门等于没有门。
> **强制手段**：`npm run check:debt-ledger`（`scripts/ci/check-debt-ledger.js`）
> **真源数据**：`scripts/ci/debt-ledger.json`
> **相关文档**：`[DESIGN-COMP-001]` 代码复杂度规范、`[DESIGN-LAY-005]` 仓库层级板块规范、
> `[DESIGN-GOV-001]` 治理总纲

---

## 1. 两种失效模式（先诊断，再开方）

| 模式 | 现象 | 本质 | 现存实例 |
|------|------|------|----------|
| **A 基线膨胀** | 基线数字远大于真实水平，门只能拦「翻倍」级别恶化 | 基线是**手写估值**而非**实测** | `code-standards.baseline.json` |
| **B 基线与实测脱节** | 基线设为 `0`（意图=零容忍），但实测长年为 N>0，门恒红 | 有意图、**无清偿计划**，红被习惯化 | `repo-layout-baseline.json` |

**两者的共同根因**：基线文件里只有数字，**没有责任人、没有期限、没有分期目标**。
没有这些，数字要么被随手写大（模式 A），要么被长期无视（模式 B）。

---

## 2. 三条原则

### QUAL-1 —— 基线必须是**实测值**，不是估值

任何 `*.baseline.json` 里的 `current` / `measured` 必须可由一条命令复现。
**发现基线数字与实际不符时，第一步是把基线改成实测值**（即使实测值更宽松），
因为一个**准确**的棘轮仍然能拦住回归，而一个**错误**的棘轮连恶化都拦不住。

> **注意这是收紧而非放宽**：`code-standards` 的 `functionLines` 从 `12000` 改成 `2145`
> 是把容忍度**降低 5.6 倍**。禁止把这一步误解为「放宽标准」。

### QUAL-2 —— 基线只降不升；上升必须走台账

`--update-baseline` 只允许**下调**。任何上调都必须：
1. 在 `scripts/ci/debt-ledger.json` 中新增/更新对应条目；
2. 条目标明 `owner` / `dueBy` / `plan`；
3. 在 PR 描述里给出「为什么不能在新代码里直接满足标准」的理由。

### QUAL-3 —— 每一类债务都必须有责任人、期限与分期目标

债务台账（`scripts/ci/debt-ledger.json`）是**唯一的债务登记处**。
**每一类门禁指标都必须有一条台账条目** —— 由守卫强制（见 §4），
这样「新增一类可豁免指标」这个动作本身就自动携带了责任人与期限，
不可能悄悄新增一个没人管的指标。

---

## 3. 收敛策略

### 3.1 通用分期法：存量冻结 + 增量归零

对**无法短期归零**的存量指标（如 352 个超 500 行的文件、2145 个超 50 行的函数）：

| 动作 | 做法 |
|------|------|
| **存量冻结** | 基线设为**实测值**，只降不升（QUAL-1） |
| **增量归零** | 新增/修改的文件必须直接满足标准 —— 参照 `pr-gate.yml` 既有先例：「Lint added files (blocking, zero tolerance)」正是这个模式 |
| **分期下调** | 每清理一批，把基线调低到新实测；台账 `target` 记录下一站 |
| **禁止新债** | 修订后的文件若使该文件指标恶化（如本就 400 行的文件涨到 700 行），按新增违规处理 |

这个模式的价值：**存量不被妖魔化，增量被彻底堵死**。库容不再增长，则总债务单调下降。

### 3.2 逐指标处置表（实测于 2026-09-15）

#### A. `check-repo-layout`（模式 B：基线 0，实测 148）

| 指标 | 实测 | 风险 | 处置 |
|------|------|------|------|
| `unresolved-require` | **21** | **P1 — 每一处都是潜伏崩溃**（惰性 require 只在跑到那条命令时才炸） | **第一批修完**。80% 是同一类 `../` 深度算错，机械可修 |
| `cross-layer-require` | **37** | P2 — 违反分层依赖方向 | 第二批：改为 workspace 包名引用 |
| `dangling-task` | **89** | P2 — **文档漂移**（实测这些 `npm run` 目标只出现在文档里，从未定义） | 第三批：逐条三分（改名对齐 / 实现 / 删除引用） |
| `extension-id-hardcode` | **1** | P2 | 随手修 |
| `docs-index-complete` | **0** | — | ✅ 本次已归零 |
| `extension-contract` / `extension-path-drift` | **0** | — | ✅ 已归零 |

**`unresolved-require` 的 21 处分组**（实测清单）：

| 组 | 位置 | 数量 | 特征 |
|----|------|------|------|
| G1 | `services/backend/src/cli/tui/ink-components/App.js` | 10 | 指向 `src/services/{conversation,session,redpass,workspace}/*` —— 这些**目录不存在**，属搬迁后路径未跟改 |
| G2 | `services/backend/src/services/domain/**` | 4 | 写成 `src/services/package.json` —— 应为 `services/backend/package.json`，**`../` 多算一级** |
| G3 | `services/backend/src/services/domain/**` | 2 | 写成 `services/backend/src/services/domain/tools/AgentTool` —— 应为 `src/tools/AgentTool`，**目录层级搞错** |
| G4 | `services/backend/src/services/domain/maintenance/selfRepair/primitives.js` | 2 | 写成 `services/backend/scripts/lib/*` —— 应为**仓库根** `scripts/lib/*` |
| G5 | `cli/handlers/provider.js` / `cli/replSession.js` | 3 | 单点错算，逐个核对 |

**G2 是最高性价比的靶子**：4 处同一错误模式，改完即消 4 处，且模式清晰到可写守卫防复发。

#### B. `code-standards`（模式 A：基线是估值）

| 指标 | 基线声称 | **实测** | 偏差 | 处置 |
|------|----------|----------|------|------|
| `fileLines`（>500 行文件数） | 512 | **352** | 高估 1.45× | 改为 352；存量冻结 + 增量归零 |
| `functionLines`（>50 行函数数） | 10800 | **2145** | **高估 5.0×** | 改为 2145；存量冻结 + 增量归零 |
| `nestingDepth`（嵌套 >4） | 10800 | **8707** | 高估 1.24× | **先修计量**（见下）再定目标 |
| `consoleLog`（非测试文件 `console.*`） | 4592 | **4584** | 基本准确 | 改为 4584；分批改结构化 logger，目标 0 |
| `namingViolations` | 4 | **4** | ✅ 准确 | 直接修掉 4 处 → 归零 |

**`functionLines === nestingDepth === 10800` 是决定性证据**：两个独立指标的
`current` 与 `max` **四个数字完全相同**，而实测分别为 2145 与 8707。
这只能是「一个数字被填进了两个字段」，即基线从未被测量。
`code-standards.baseline.json` 自己的注释还写着「Counted together with function lines」，
但守卫的 `metricMap` 把它们当**两个独立阈值**比对 —— 口径与实现不一致。

**`nestingDepth` 的计量本身也不可靠**：它用行缩进估算嵌套
（`Math.floor(indent / 2) + 1 > 4`），而不是真实块嵌套。这使得
**4 空格缩进的文件会系统性误报**，8707 这个数字的可信度存疑。
处置：**先修计量，再定目标** —— 一个测错的指标，清偿它没有意义。

---

## 4. 债务台账

### 4.1 条目结构

```json
{
  "id": "layout.unresolved-require",
  "guard": "scripts/ci/check-repo-layout.js",
  "metric": "unresolved-require",
  "measured": 21,
  "measuredAt": "2026-09-15",
  "target": 0,
  "risk": "P1",
  "owner": "platform",
  "dueBy": "2026-09-30",
  "status": "open",
  "note": "每一处都是潜伏崩溃……",
  "plan": "G2 先修（4 处同模式）→ G1 → G3/G4 → G5"
}
```

| 字段 | 含义 |
|------|------|
| `status` | `open`（在期限内）/ `slipped`（逾期，需 `slippedReason` + 新 `dueBy`）/ `closed`（已归零） |
| `target` | 下一站目标。**必须严格小于 `measured`**（`measured` 为 0 时可为 0） |
| `dueBy` | ISO 日期。逾期且未标记 `slipped` → 守卫报错 |
| `measuredAt` | 测量日期。超过 90 天未更新 → 守卫警告（防止台账变成化石） |

### 4.2 守卫校验项

| 检查 | 严重度 |
|------|--------|
| 条目字段完整、类型正确 | error |
| `target < measured`（或二者同为 0） | error |
| `dueBy` 合法且未逾期（`slipped` 需理由 + 新日期） | error |
| `id` 唯一、`guard` 指向的文件存在 | error |
| **覆盖完整性**：每个门禁指标都必须在台账里有一条 | error |
| `measuredAt` 超过 90 天 | warning |
| `slipped` 条目数（每次滑动都会在输出里点名） | warning |

**覆盖完整性**是这套机制的关键：守卫会**从守卫脚本源码里**解析出
`check-repo-layout.js` 的 `BASELINE_IDS` 集合、以及
`code-standards.baseline.json` 的 `baselines` 键集合，断言二者都被台账覆盖。
于是「新增一类可豁免指标」这个动作**自动携带责任人与期限**。

---

## 5. 收敛后的门禁语义

| 门禁 | 收敛前 | 收敛后 |
|------|--------|--------|
| `check:layout` | 恒红（基线 0 vs 实测 148）→ 被忽略 | 实测 0 或台账全部在期限内 → 红=真信号 |
| `check:code-standards` | 容忍度 5.6×，只能拦翻倍 | 基线=实测，任何一处新增即红 |
| `check:debt-ledger` | 不存在 | 逾期/未覆盖/目标倒退 → 红 |

**判定「门禁健康」的标准**（写进发布门）：

1. 全部门禁 exit 0；
2. 台账无 `slipped` 条目；
3. 无 `measuredAt` 超过 90 天的条目。

---

## 6. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-15 | 首版：两种失效模式诊断、三条原则、存量冻结+增量归零分期法、逐指标处置表（含实测数据与 21 处清单分组）、债务台账结构与守卫校验项 |
