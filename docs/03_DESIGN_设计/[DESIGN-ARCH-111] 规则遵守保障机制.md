# [DESIGN-ARCH-111] 规则遵守保障机制（ruleguard）

<!-- RULES-REGISTRY: TOOLING-004, TOOLING-005, TOOLING-006, TOOLING-007 -->

> **定位**：本文件回答一个问题——khy-os 已制定大量规则，但项目本身不会主动读取和遵守它们，如何补上这个缺口。它**不新增任何规则**，只新增把既有规则接入执行路径的**绑定层**。规则语义真源仍在 `docs/_规范/RULES-REGISTRY.json` 与各自 SSOT 文档；既有 52 个 `scripts/ci/check-*.js` 检查器仍是执行器，本文件不改写它们。
>
> **适用边界**：本文件定义规则从「声明」到「被检查」之间的接线契约、覆盖率口径、违规处置与验证方法。运行时（AI 会话内）的行为护栏不在本文件范围——`services/backend/src/` 下既有 40+ 个 `*Guard.js` / `*Gate.js` 继续独立工作。发生冲突时，已声明为单一真源的原文优先。
>
> **元规则依据**：`[MGMT-STD-008]` §3.2「正文只做指针+摘要，语义真源另存」、§4.6「模板即福利」。

---

## 0. 现状审计矩阵：规则声明 × 执行路径 × 缺口

下表是本次审计实测出的**实施前**事实（2026-09-15）。数字是「改造前基线」，
不是当前值：实施后检查器从 52 个增至 65 个（新增 `check-wiring.js` 等），
零接线检查器从 6 个增至 9 个（其余 3 个由本次登记的豁免清单接管），
规则从 43 条增至 44 条。当前值以 `npm run rules:coverage` 为准。

**覆盖率演进（同为 2026-09-15，同一次会话内的连续阶段）**：
实施前实测 **16/43（37.2%）** 声明了 `enforcement` → 绑定层落地后
**27.3%（as-found，含未声明但实际在跑的）** → 补 5 个规则绑定检查器后
**77.3%（34/44）**。剩余 10 条（9 `manual` + 1 `carrier`）是**刻意保留**的，
不是欠账——见 §8「刻意保留的 manual 清单」，每条都写明了为什么机器判不了。

**这个百分比的边界**：分母只有登记表的 44 条规则。另有 **37 个规则 ID 被检查器
真实执行、但登记表从未收录**（`SEC-001` / `NAM-001` / `UPLOAD-001` …），它们不进
分母也不进待办清单，是最容易被漏掉的一类缺口。§4.5 把它们做成可见输出。
「遵守率」因此有两个数：**登记表内 77.3%**，以及登记表外那一整层此前不可见的规则。

| 环节 | 已有资产 | 实测状态 | 缺口 |
|---|---|---|---|
| 规则存放 | `docs/_规范/RULES-REGISTRY.json` v2.1.0，43 条规则 × 16 必填字段 + 16 条可选 `enforcement`；`docs/` 下 642 篇 `.md`，577 篇带 `[XXX-NNN]` 编号 | 字段完整率 100%（`check-gov-rules.js` GOV-TOOL-006 校验通过） | `enforcement` 是自由文本，混装脚本路径、函数名、finding 锚点、运行时代码、纯数据文件五种形态，无法机器解析出「谁执行我」 |
| 规则→真源可达 | `<!-- RULES-REGISTRY: ID -->` 标记行约定，12 篇 `.md` + 3 个代码文件携带 | 双向可达守卫 `check-rules-registry.js`（TOOLING-007）存在、逻辑正确、已接线（`package.json` 的 `check:rules` + `pr-gate.yml` L109） | 守卫只验「路径存在」，不验「执行器真的在跑这条规则」——`enforcement` 指向一个无人调用的脚本也能通过 |
| 规则→检查器绑定 | 无 | 16/43（37.2%）声明了 `enforcement`；**27 条零执行器**。其中 `PROCESS-002` 实际由 `check-version-sync.js` 执行但未声明，登记簿**低估**了覆盖率 | 无绑定层：新增一条规则需人工改 5 处（登记表、检查器、`qualityGateStages.js` 硬编码、`package.json` 别名、workflow YAML），无一步被校验 |
| 检查器接线 | 52 个 `scripts/ci/check-*.js`；pre-commit、CI、`quality-gate`、`release-gate` 四层入口 | pre-commit 只跑 1 个检查器（`check-commit-message.js`），**占检查器总数的 2%**；CI `pr-gate.yml` 跑 11 个；`qualityGateStages.js` 硬编码 16 个 stage | **6 个检查器零接线**（`check-core-safety`、`check-f2e-spec`、`check-f2e-wiring`、`check-frontend-tokens`、`check-traffic-log`、`security-scan`）；18 个仅 `package.json` 有别名、无 CI 无 hook |
| 运行时执行 | `services/backend/src/` 40+ 个单用途 Guard/Policy/Gate；3 个文件带 `RULES-REGISTRY` 标记 | 存在，但彼此不共享注册表、不共享接口、不共享 finding 格式 | 无运行时读者读 `RULES-REGISTRY.json`；登记表是纯 CI/pre-commit 产物 |
| 编号命名空间 | 无交叉表 | **三套并行 ID**：登记表 ID（`RUNTIME-001`）、`check-gov-rules.js` 仍在发的旧 `GOV-*` ID、标准检查器发的 `DESIGN-*` 文档 ID（`SEC-001`/`FE-004`） | `check-agent-rules.js` **零个** `RUNTIME-` 字面量——它的 finding id 是 kebab-case（`no-hardcoded-endpoint` 等 8 个），登记表 ID 无法从检查器输出反查 |
| 已知缺陷 | — | 无。登记表在 git 中的规范名是 `docs/_规范/RULES-REGISTRY.json`（大写），与 `check-gov-rules.js` / `check-rules-registry.js` 的引用一致；Windows 上 `ls` 显示为小写是文件系统大小写不敏感的呈现，非真缺陷。`ruleguard/lib/registry.js` 保留 `rules-registry.json` / `RULES-REGISTRY.json` 双候选探测，仅用于夹具与重命名 checkout 的健壮性 | — |

**结论**：项目的规则体系缺的不是规则、不是检查器、也不是门，而是**绑定层**。声明、执行器、门禁三套东西各自成熟，但没有任何一环从另一环派生。因此新增规则默认进入「已声明、未执行」状态，且没有任何信号会告知维护者这件事发生了。

---

## 1. 设计目标与非目标

### 目标

1. **门成员资格从登记表派生**，而非在 `qualityGateStages.js` / `package.json` / workflow YAML 里手工硬编码。
2. **覆盖率可见且自身受守卫**：能回答「43 条规则里几条被机器执行、哪几条没有执行器、哪些执行器接了线但没挂到任何门」。
3. **闭环**：把「检查器零接线」与「规则绑定失效」变成被检查的不变量，而不是靠人记得接线。校验登记表的守卫 `check-rules-registry.js` 本身已接线（`pr-gate.yml` L109），本次补的是它未覆盖的下一层——执行器声明之后是否真被门调用。
4. **规则可被查询**：给定一个正在改动的文件路径，能返回该路径适用的规则及其约束/例外。这是让规则「主动」的最直接机制。
5. **违规处置有分级与有迹可循**：不同优先级走不同强度（阻断/棘轮/建议），每次违规落台账，抑制必须留痕。

### 非目标

- 不新增任何规则条款，不改写任何既有检查器的判定逻辑。
- 不实现通用运行时策略引擎。`riskGate.js`、`permissions/rules.js` 等既有运行时护栏保持原样。
- 不追求 100% 覆盖率。27 条零执行器规则中大量是流程约定（`PROCESS-001` 分支纪律、`SOURCING-001` 借鉴流程），机器不可判定，强行写检查器只会产出噪声。目标口径是「**每条规则显式归类为 6 类之一，无第 7 类「未知」**」（见 §2 归类枚举）。

---

## 2. 规则存放（Storage）

保持 `docs/_规范/RULES-REGISTRY.json` 为单一真源，**仅新增 2 个可选字段**，对既有 43 条规则零破坏：

```jsonc
{
  "id": "RUNTIME-001",
  /* ... 既有 16 个字段全部不动 ... */
  "paths": ["services/**", "apps/**", "platform/**", "software/**", "kernel/**", "tools/**", "scripts/**"],
  "gate": "pr"
}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `paths` | `string[]`，可选 | **机器可读**的适用范围 glob。与既有 `scope`（人读散文，如「面向用户的错误消息」）分工：`scope` 给人看，`paths` 给机器匹配。未声明时回退到从 `scope` 中抽取的 `path/**` 形态 token。 |
| `gate` | `"commit"` \| `"pr"` \| `"release"` \| `"manual"` \| `"advisory"`，可选 | 该规则应挂在哪一档门。缺省值由 `priority` 派生：`P0`→`release`，`P1`→`pr`，`P2`/`P3`→`advisory`。 |

### 执行器声明：不扩 `enforcement`，新增 `exec`

既有 `enforcement` 是自由文本且已被 16 条规则使用，直接改语义会破坏 `check-rules-registry.js` 的既有校验（它把 `enforcement` 按 `' / '` 切分并逐段验路径存在）。因此**保留 `enforcement` 作为人读指针**，另加结构化字段：

```jsonc
{
  "enforcement": "scripts/ci/check-agent-rules.js",
  "exec": {
    "script": "scripts/ci/check-agent-rules.js",
    "args": ["--changed"],
    "findings": ["no-hardcoded-endpoint", "no-hardcoded-prod-domain", "no-hardcoded-abs-path"]
  }
}
```

`exec` 三字段：

- `script`：执行器路径（相对仓库根）。
- `args`：调用参数。`--changed` 决定它能否进 pre-commit 快档。
- `findings`：该规则由执行器的哪些 finding id 承载。用于把 kebab-case finding 反查回登记表 ID，**同时解决三套 ID 命名空间的断层**。

`exec` 缺省且 `enforcement` 为空 ⇒ 该规则归类为 `unenforced`；`exec` 存在但 `enforcement` 缺失 ⇒ 归为 `declared-inconsistent`（登记表内部不一致，warn 级）。

### 归类枚举（6 类，无第 7 类「unknown」）

真源是 `registry.js` 的 `classify()` 与 `manifest.js` 的接线提升；下表与代码逐条对应。
分类的意义在于「每条规则都必须落进一个已声明的类别」——不存在 unknown 兜底，
否则登记表里永远可能藏着既没执行器也没被承认的条目。

| 类别 | 判定 | 期望处置 |
|---|---|---|
| `enforced` | `exec.script` 存在，且 `wiring.js` 确认有门引用它 | 正常执行 |
| `declared` | `exec.script` 存在，接线状态未经 `wiring.js` 判定（加载期） | 由 manifest 提升为上两档之一 |
| `declared-uwired` | `exec.script` 存在但无任何门引用它 | warn，提示接线（`check-wiring.js` 升级为 error） |
| `dead-pointer` | `exec.script` 路径在磁盘上不存在 | **红线**，阻断覆盖率检查 |
| `carrier` | 无检查器，但 `exec.carriers` 指向真实存在的运行时代码 | 承认「由代码实现、无静态检查器」，不告警 |
| `manual` | `gate === "manual"` 且无 `exec` | 显式承认人工评审兜底，须写 `exception` 理由 |
| `unenforced` | 无 `exec` 且非 `manual` 且无载体 | info，进入覆盖率待办清单 |

本仓库当前分布：`enforced` 34、`manual` 9、`carrier` 1（共 44 条，无 `dead-pointer`）。
落地前是 `enforced` 27、`manual` 11、`carrier` 4；差值即本轮新增的 5 个规则绑定
检查器（SOURCING-002、SOURCING-004、SECURITY-002、SECURITY-003、SECURITY-004）
与 4 个此前未声明但实际在跑的既有检查器重新绑定。唯一剩下的 `carrier` 是
`PROCESS-003`（验收门禁），见 §8 说明为什么它不适合硬写检查器。

---

## 3. 加载与执行（Loading & Execution）

新增 `scripts/ruleguard/` 作为绑定层，**不改写既有检查器**：

```
scripts/ruleguard/
├── index.js          CLI 入口：run / apply / coverage / manifest 四子命令
├── lib/
│   ├── registry.js   加载 + 解析登记簿（大小写容忍、字段缺省派生、归类）
│   ├── manifest.js   生成 rule → checker → gate 的派生清单
│   ├── run.js        聚合执行器：按门档派生 stage 并逐个 spawn
│   ├── apply.js      按 paths glob 查适用规则（agent-facing 建议）
│   ├── wiring.js     扫描 package.json + workflows + hooks，判定执行器接线状态
│   ├── suppression.js 解析 khy-allow-<RULE-ID>: 抑制注释
│   ├── ledger.js     违规台账（append-only jsonl）
│   ├── baseline.js   基线棘轮（只降不升）
│   └── glob.js       零依赖 glob 匹配（** / * / ?）
```

### 3.1 加载

`registry.js` 解析时做四件事：

1. **大小写容忍**：依次尝试 `rules-registry.json` 与 `RULES-REGISTRY.json`（`fs.existsSync` 探测），命中即读。git 中的规范名是大写，两种守卫本就引用大写形式，此探测仅为夹具与重命名 checkout 的健壮性，不构成对既有行为的修复。
2. **字段缺省派生**：`gate` 缺省按 `priority` 派生；`paths` 缺省从 `scope` 抽取 `**` 形态 token；`exec` 缺省为 `null`。
3. **归类**：按 §2 的 4 类给出每条规则的 `kind`。
4. **容错**：登记表缺失时**不静默跳过**——输出显式的「登记表缺失，规则执行层未挂载」并以非零码退出（这是本次修复的核心语义变化：缺失必须可见）。

### 3.2 执行

`run.js` 从 manifest 派生 stage 列表，按门档过滤：

- `--mode commit`：只跑 `gate === "commit"` 且 `exec.args` 含 `--changed` 的执行器（pre-commit 快档，秒级）。
- `--mode pr`：`commit` ∪ `pr`。
- `--mode release`：全部。

派生规则：**一个执行器只跑一次**，即使它承载多条规则（`check-agent-rules.js` 承载 RUNTIME-001/002/003）。按 `script` 去重，把该脚本承载的所有规则 ID 汇总进它的标签，输出形如：

```
[ruleguard] action=start  target=check-agent-rules.js  rules=RUNTIME-001,RUNTIME-002,RUNTIME-003  gate=pr  progress=1/14
[ruleguard] action=fail   target=check-agent-rules.js  rules=RUNTIME-001,RUNTIME-002,RUNTIME-003  errors=2 warnings=1  durationMs=842
```

输出格式沿用 `RUNTIME-002` 的「动作+目标+进度」要求：`action` 是动作，`target` 是目标，`progress=i/N` 是进度。

**执行器输出解析**：既有检查器并不共用一种输出形态，本仓库实测有两种方言，
`run.js` 都解析：

| 方言 | 形态 | 代表检查器 | 粒度 |
|---|---|---|---|
| A（定位型） | `[ERROR] <id> <file>:<line>` 后接缩进正文 | `check-agent-rules.js`、`check-duplication.js` | 逐行，可做 `khy-allow-` 抑制锚定 |
| B（聚合型） | ` - [error] <描述> (id: <id>)` 后接缩进明细 | `check-repo-layout.js` | 聚合计数，无 file:line |

两种方言都通过 `exec.findings` 把 finding id 反查回登记表规则 ID，台账与覆盖率报告
以**登记表 ID** 为主键。方言 B 没有位置信息，因此**不能**作为抑制锚点（这是显式接受的
限制，而不是伪造行号）；`resolveSuppression` 对无 file 的 finding 直接判 `active`。

未匹配到 `exec.findings` 的 finding 归为「未登记 finding」并单列告警（提示登记表漏登）。
配套守卫：`scripts/tests/ruleguard.test.js` 有一条不变量测试，断言
`repo-layout-baseline.json` 枚举的每一类计数都被某条规则认领——这样检查器新增一类
输出而登记表没跟上的情况会在 CI 显式失败，而不是静默进入 unmapped。

**检查器退出非零但无可解析 finding**：这不能读作「通过」。记为 `checker-failure`
伪 finding 进台账，其**处置强度按该检查器所属规则的 `severity` 决定**：
有规则声明 `blocking` ⇒ 闭合失败（fail closed）；否则仅记录不阻断。
理由：存量盘点类检查器（如 `archDebtScan`，仓库现存 26 个巨石文件、63 处分层倒置
均为已登记技术债，只要有任何债就整体退出 1）若按阻断处理，会让规则遵守门因既有债务
永久亮红——那等于把门关掉。台账与报告仍以 `[REC]` 标签显示，不静默。

**退出码**：存在 `blocking` 级违规 ⇒ exit 1；仅 `advisory` ⇒ exit 0（stderr 打印告警）；用法错误 ⇒ exit 2。与既有 `check-repo-layout.js` 的退出码约定一致。

### 3.3 门档强度映射

| `priority` | 默认 `gate` | 违规处置 |
|---|---|---|
| P0 | `release` | **阻断**（blocking） |
| P1 | `pr` | **阻断**（blocking） |
| P2 | `advisory` | **基线棘轮**：允许存在存量，超基线自动升级为阻断（沿用 `repo-layout-baseline.json` 的只降不升语义） |
| P3 | `advisory` | **仅建议**，不阻断不告警 |

这把登记表里目前纯装饰性的 `priority` 字段变成了有执行语义的字段——这是本次实现的关键收益之一。

**`severity` 覆盖字段**：`priority` 是治理优先级（P0–P3，表示「这条规则有多重要」），
`severity` 是门禁强度（`blocking` / `ratchet` / `advisory`，表示「违反它时门怎么处理」），
两者不总是同向。典型例子 `SOURCING-005`（重复代码，P1）：全仓存量 352 处，若按 P1 派生
`blocking`，门会在第一天就红；正确处置是 `severity: "ratchet"`——允许存量、超基线才阻断。
该字段可选，缺省时按上表从 `priority` 派生；`schemaIssues()` 会校验它只能是
`blocking`/`ratchet`/`advisory` 之一，避免拼写漂移导致静默降级。

---

## 4. 校验与检查环节（Verification Gates）

规则遵守靠四层递进的门，每层职责单一：

| 层 | 触发点 | 跑什么 | 耗时目标 |
|---|---|---|---|
| L1 pre-commit | `git commit` | `ruleguard --mode commit`（仅 `--changed` 执行器）+ 既有 4 项临时文件/大文件/密钥/提交信息检查 | < 10s |
| L2 PR 门 | GitHub Actions `pr-gate.yml` | `ruleguard --mode pr` + 既有合同检查 | < 5min |
| L3 结构门 | 人工 / `npm run rules:gate` | `ruleguard --mode release` | < 10min |
| L4 自守卫 | 随 L2 一起 | `check-gov-rules`（GOV-TOOL-006）+ `check-rules-registry`（TOOLING-007）+ **新增** 反孤儿检查 | 秒级 |

### 4.1 反孤儿检查（本次新增，关闭接线缺口）

新增 `scripts/ci/check-wiring.js`，把「6 个零接线检查器」变成被检查的不变量：

1. 每个 `scripts/ci/check-*.js` / `validate-*.js` 必须被至少一个门引用（`package.json` 脚本、任一 `.github/workflows/*.yml`、`.githooks/*`、或 `ruleguard` 派生清单）；
2. 豁免必须显式：`scripts/ci/wiring-exemptions.json` 登记 `{script, reason, until}`，无理由或无到期日的豁免判 error；
3. 反向检查：`package.json` 里的 `check:*` 别名必须指向真实存在的脚本（防死指针）；
4. `gate: "pr"` 且 `kind === "enforced"` 的规则，其执行器必须出现在 PR 门的引用集合中。

### 4.2 登记簿自守卫（本次修复）

- 把 `check-rules-registry.js` 接进 `package.json`（`check:rules-registry`）与 `pr-gate.yml`，让它自己也被校验；
- 统一 `check-gov-rules.js:39` 与 `check-rules-registry.js:34` 的登记表路径解析为大小写容忍；
- 扩展 `check-rules-registry.js`：新增 `paths` / `gate` / `exec` 三个字段的 schema 校验（类型、枚举、`exec.script` 存在性），以及 `manual` 归类必须写明 `exception` 理由的约束。

### 4.3 覆盖率检查

`npm run rules:coverage` 输出覆盖率报告，并在 `--ci` 下对红线指标判失败：

- 阻断红线：**不允许出现 P0 规则处于 `unenforced` 状态**；
- 阻断红线：**不允许出现 `kind === "enforced"` 但无任何门引用**（接线失效）；
- 软指标（仅提示，不阻断）：P1 覆盖率、P2 覆盖率、`declared-uwired` 数量。

### 4.4 规则绑定检查器（本轮新增 5 个）

此前 44 条规则里，有 5 条是「已声明、载体存在、但无静态检查器」的状态——它们
靠人工评审兜底。本轮各配了一个检查器，全部纳入 `pr` 门：

| 检查器 | 规则 | 强度 | 断言方式 |
|---|---|---|---|
| `check-license-tiers.js` | SOURCING-002 (P0) | 文本 + 结构 | 三档分级（A 宽松 / B 源码可用 / C 版权共有），GPL 家族判 error |
| `check-permission-invariants.js` | SECURITY-004 (P0) | 静态不变量 | 档表冻结、未知档不得落到宽松档、deny 先于 allow、`yolo` 别名显式映射 |
| `check-unbypassable-gate.js` | SECURITY-002 (P0) | **行为断言** | 真跑 `assess`/`isUnbypassableGate`：不可逆必阻断、双通道独立、旁路环境无关 |
| `check-weak-model-guard.js` | SECURITY-003 (P1) | **行为断言** | 真跑 `classifyChangeRisk`/`assessWeakModelChange`：6 类红线全覆盖、裁决矩阵、旁路环境无关 |
| `check-feature-ownership.js` | SOURCING-004 (P1) | 结构断言 | canonical 路径真实存在、domain 无重复、fork 自审批不得通过 |

两个行为断言检查器值得单独说：安全类规则的语义回归（「这条红线还能被绕过吗」）
**用正则抓不出来**——改的是分支条件而不是字符串字面量。所以这两条直接 `require`
载体模块、喂样本、断言返回值，并用 `spawnSync` 在隔离 env 下验证「权限旁路关不掉
护栏」。代价是检查器变重（`check-unbypassable-gate.js` 要起 5 个子进程），换来的是
**它真能发现红线失效**，而不是在文件里 grep 几个关键字就报平安。

对应地，`scripts/tests/check-weak-model-guard.test.js` 用临时 fixture 仓库做负例
（删红线正则、把 `allow: false` 改 `true`、让 `yolo` 关掉护栏、删掉调用点），
每条断言只指向一个坏形态；另有一条真仓库冒烟，防止检查器自己退化成永久红灯。

### 4.5 覆盖率盲区：检查器在执行但登记表未收录的规则

前面 44 条的覆盖率有一个人工制造的边界：**分母只有登记表里的规则**。于是存在
第三种状态——一个检查器稳稳地执行着写在设计文档里的规则（`SEC-001` 安全响应头、
`NAM-001` 命名规范、`UPLOAD-001` 上传校验、`AUD-001` 审计日志五要素 …），门在跑、
规则在生效，但没有任何一处记录「这个门保护的是哪条规则」。它既不进覆盖率分母，
也不进「未挂载执行器」清单，纯粹不可见。

实测这类 ID 有 **37 个，分布在 18 个检查器**（`scripts/ci/check-*.js` 自述的
`<PREFIX>-<NNN>` 形状 token，减去登记表已有 ID）。这是比「9 条 manual」大得多的
一类缺口——不是执行缺失，是**登记缺失**：门在保护的东西没人登记过。

`lib/externalRules.js` 把这件事变成可见输出，`rules:coverage` 现在多一段：

```
覆盖率盲区 — 检查器在执行但登记表未收录的规则（37 个 ID，分布在 18 个检查器）：
  SEC-001        check-security-headers.js
  UPLOAD-001     check-data-lifecycle.js, check-upload-safety.js
  ...
  （已排除 1 个内部编码族：PTX-——形状同形但不是规则）
  → 不计入上面的覆盖率分母；`--ci` 不阻断，需人工裁决是否补登。
```

两个刻意的取舍：

- **排除 `PTX-` 族**。`check-prompt-taxonomy.js` 自述 35 个 `PTX-###`，那是提示词
  分类编号不是规则；不排除会让报告被淹没、真正的信号反而看不见。排除名单显式写在
  `CODE_FAMILIES` 里并有测试锁住，不靠正则侥幸。
- **`--ci` 不阻断**。这些规则是真在生效的，阻断等于惩罚正确的行为。它是 advisory，
  交给维护者决定要不要为这 37 条补登记表条目（每条要填 16 个必填字段 + 生成规则卡，
  不是随手能补的量，且 `constraint` 真源在设计文档里，需逐条核对而非抄一句概括）。

配套 `scripts/tests/externalRules.test.js`（10 条）用临时 fixture 验证切分、聚合、
编码族排除、`scripts/ci` 缺失与不可读文件的健壮性，加一条真仓库冒烟。

#### 4.5.1 盲区的处置结果（2026-09-16）

37 个盲区 ID 逐条核对后，实际分三种：

| 类别 | 数量 | 处置 |
|------|------|------|
| 已是登记表的 `formerly` 别名 | 8 | `ARCH-068`（=`LAYOUT-003`）、`ACP-001/003/004`（=`COMMS-001/003/004`）、`TOOL-004/005/006`（=`TOOLING-004/005/006`）、`STD-008`（=`MGMT-STD-008`）——已登记，只是旧 ID 仍在检查器里自述，**不计**为缺口 |
| 真正缺登记 | 22 | 逐条补登为登记表条目，`constraint` 逐条取自各规则设计文档原文（非概括复述），生成规则卡，`ssot` 文档补 `RULES-REGISTRY` 标记行 |
| 真源是私有仓库 | 其余 | 提案类规则的语义真源在指挥部仓库，本仓不复制其正文 |

补登 22 条后：登记表 44 → 66 条，已执行 34 → 61 条，**覆盖率 77.3% → 92.4%**，
盲区 37 → 17 个 ID（余下 17 个全部是上表第一类的旧 ID 别名与 `ARCH-*` 指针）。

> 注意口径：预期是「绝对覆盖数上升、百分比下降」，实际**百分比也上升了**。原因是这 22 条
> 此前**都已有在跑的检查器**（盲区报告本身就证明它们在跑），补登只是把已存在的执行
> 关系写进登记表——分子分母同增，且分子增量占更大比例。若补登的是没有执行器的规则，
> 百分比才会被稀释。这一点不应当成结论；它是本次补登对象的实际构成。

#### 4.5.2 四份机器可读真源工件

补登之外，本轮为「缺的不是检查器，而是可被断言的对象」这条判断落地了四份结构化工件。
每份都是**字段齐全、可被校验**的 JSON，供检查器直接加载断言，不再靠人工读文档判断。

| 工件 | 存放路径 | 服务的规则 | 消费它的检查项 |
|------|----------|-----------|---------------|
| 记忆记录 schema + 指定读写入口清单 | `docs/_规范/MEMORY-RECORD-SCHEMA.json` | `MEMORY-002`、`MEMORY-003` | `check:memory-schema` |
| 上游来源出处台账 | `docs/_规范/SOURCING-PROVENANCE.json` | `SOURCING-001` | `check:provenance` |
| 提案工件索引（git 提交 ↔ 提案工件映射） | `docs/_规范/PROPOSAL-ARTIFACT-INDEX.json` | `SOURCING-003`、`SOURCING-006` | `check:proposal-index` |
| 规则登记表补登 + 双向标记行 | `docs/_规范/RULES-REGISTRY.json` | 22 条新登记规则 | `check-rules-registry.js`（TOOLING-007/008） |

三份工件此前对应的四条规则（`MEMORY-002/003`、`SOURCING-001/003/006`）在登记表里
`gate` 全是 `manual`、`paths` 全是 `[]`——即完全没有机器守卫。本轮全部改为 `pr` 档并
绑上执行器，`check:structure` 与 PR gate 都已接线。

三份检查器各自的断言口径（避免把「读到了文件」当成「校验通过」）：

- **`check-memory-schema.js`**：五要素必须齐 5 个且每个都带 `key/type/required/constraints`
  四项属性（对应「字段名、类型、取值约束、必填性」）；`recordIntegrity.allFiveRequired`
  必须为 `true`；凭据策略必须有 token 清单与作用字段；`designatedEntries` 每条必须带
  `id/storage/entry`，`implemented=true` 的条目载体文件必须真实存在；实测写入单点
  `services/backend/src/memdir/memdir.js` 是否已登记为入口、已知裸写点行号是否漂移；
  并回读 `[DESIGN-MEM-006]` §2 的 yaml 块，五个字段名任一消失即判 `ssot-field-drifted`。
- **`check-provenance.js`**：`source/localPath/relationship` 三项必须 `required=true`；
  台账 `localPath` 必须真实存在；`relationship` 必须落在 `idea | reference | adapter |
  vendored | fork`（外加本台账为工具链生成产物增设的 `generated`）；`generated` 必须带
  `regenerationCommand`；`vendored/fork` 必须带 `license` 与 `approvedBy`（B-M1 第 1 条、
  B-P3 裁决人不得是唯一实现者）；且 vendored 记录必须同时在 `FEATURE-OWNERSHIP.json`
  出现 `method=vendored`（B-M1 第 6 条），否则判 `vendored-not-cross-registered`。
- **`check-proposal-index.js`**：B-P2 七编号字段必须齐全且 `required=true`
  （模板标题写「六字段」但编号到 7，这个计数不一致必须在工件里显式声明）；
  B-P2.1「先提案、后编码」与 B-L3 追加式决策必须有可断言表述；B-L2 三步必须登记且带
  回滚规则原文；**实测** `[DESIGN-ARCH-105]` 内 7 条 `【借鉴提案 P-NN】` 是否真的填齐
  1-7、标题行号是否漂移、数量是否与索引登记一致；并扫描 `.ai/GOVERNANCE-LEDGER.md`
  是否有日期回退（B-L3 只允许追加）。

测试：`scripts/tests/artifactCheckers.test.js`（18 条），用临时 fixture +
`RULEGUARD_REPO_ROOT` 环境变量把检查器指向夹具仓库，逐条验证「删字段 / 删工件 /
行号漂移 / 关系越界 / 台账日期回退」都有对应报错，避免检查器退化成「只要读到了文件就绿」。


---

## 5. 违规处理（Violation Handling）

### 5.1 分级处置

- **阻断**（P0/P1）：门失败，输出「问题 + 规则 ID + 文件行号 + 修复建议」，格式遵循 `RUNTIME-002` 的 `{问题一句话}：{原因}，{修复建议}` 模板。
- **基线棘轮**（P2）：`scripts/ci/ruleguard-baseline.json` 记录每条规则的允许存量数。存量内的 warning 不阻断；超量自动升为阻断。`--update-baseline` 主动收紧，语义与 `check-repo-layout.js --update-baseline` 一致。
- **建议**（P3）：仅记录，不输出到 stderr。

### 5.2 抑制（有迹可循，非静默豁免）

沿用仓库既有 `khy-allow-unbounded-loop: <理由>` 注释约定，泛化为：

```javascript
// khy-allow-RUNTIME-001: 本文件是端点探测夹具，域名仅作 .endsWith 比较
```

规则：

1. 抑制**必须带理由**，空理由判 error；
2. 抑制**只作用于其所在行的 finding**，不扩散到整个文件；
3. 被抑制的 finding 仍写入台账，`suppressed: true` + `suppressionReason` + `suppressionLine`，供审计与季度复查；
4. 台账中每条 P0/P1 的 suppressed 记录在覆盖率报告里单独列出（「活跃抑制」清单），防止抑制被当作永久豁免累积。

### 5.3 台账

`.khy/ruleguard/violations.jsonl`（append-only，gitignore 外的 `.khy/` 已按项目约定作为运行时数据目录）：

```json
{"ts":"2026-09-15T12:00:00.000Z","gate":"pr","checker":"scripts/ci/check-agent-rules.js","finding":"no-hardcoded-endpoint","rule":"RUNTIME-001","priority":"P1","file":"apps/ai-frontend/src/api/request.js","line":42,"severity":"blocking","suppressed":false,"commit":"d917a35a"}
```

台账是「遵守效果验证」的证据源——它让「规则有没有真被执行、执行了多少次、违规集中在哪」变成可查询的历史数据，而非每次跑完即丢的 stdout。

---

## 6. 如何验证遵守效果（Proving It Works）

五个递进的验证手段，从「机制正确」到「机制生效」：

### 6.1 负例测试（机制能抓到违规）

`scripts/tests/ruleguard.test.js`，用 `KHY_RULES_REGISTRY_ROOT` 环境变量指向临时夹具仓库（沿用 `check-agent-rules.js` / `check-rules-registry.js` 已有的 fixture-root 模式）：

- 夹具里放一个含硬编码端点的文件 ⇒ 断言 `run --mode pr` exit 1 且台账出现 `rule: "RUNTIME-001"`；
- 同文件加 `khy-allow-RUNTIME-001: reason` ⇒ 断言 exit 0 且台账 `suppressed: true`；
- 加**空理由**抑制 ⇒ 断言抑制无效、仍阻断；
- 删除 `exec.findings` 中某个 id ⇒ 断言出现「未登记 finding」告警。

### 6.2 归类与派生 golden 测试

把当前真实登记簿生成的 manifest 摘要（规则数、各 `kind` 计数、各 `gate` 计数、去重后的执行器数）快照进测试断言。任一人改登记簿导致归类漂移会立刻暴露。

### 6.3 自守卫（机制管住了自己）

`check-wiring.js` 断言：所有 52 个检查器要么被门引用、要么在 `wiring-exemptions.json` 中有理由+到期日的豁免。这是**用同一套机制验证机制本身没被绕过**——若 `check-wiring.js` 自己被拔掉接线，它自己就是孤儿，下一次运行会抓到它。

### 6.4 覆盖率基线趋势

`rules:coverage` 输出的指标进 `ruleguard-baseline.json`，只降不升：

- `unenforced` 数只允许减少（新增规则必须同时补 `exec` 或显式 `manual`）；
- `declared-uwired` 数只允许为 0；
- 阻断红线：P0 `unenforced` 必须恒为 0。

### 6.5 端到端接线回归

`test:scripts`（已在 `quality-gate` 的 `scriptTests` stage 内）覆盖 `scripts/tests/**/*.test.js`。因此 ruleguard 的测试**自动经过既有质量门**，不需要额外接线。同时 `pr-gate.yml` 新增 `check:rules-registry` 与 `check:wiring` 两步，使 L4 自守卫在 PR 视野内。

---

## 7. 实施顺序

| 阶段 | 内容 | 交付物 | 可独立验收 |
|---|---|---|---|
| P0 | 度量基线：`rules:coverage` 先只读跑一遍，量化 43 条规则的归类现状 | 覆盖率首份报告 | 是，只读不改 |
| P1 | 绑定层：`registry.js` / `manifest.js` / `run.js` / `wiring.js` / `glob.js` + 大小写修复 + `check:rules-registry` 接线 | ruleguard CLI 可用；TOOLING-007 在 CI 真跑 | 是 |
| P2 | 反孤儿守卫 `check-wiring.js` + 登记簿 schema 扩展校验 + 27 条规则的 `gate`/`exec`/`paths` 补登 | 52 个检查器全部归类，0 个孤儿 | 是 |
| P3 | 处置：台账 / 基线棘轮 / `khy-allow-<RULE-ID>` 抑制 + pre-commit 接入 | 违规留痕；commit 快档生效 | 是 |
| P4 | 验证：负例 + golden + 覆盖率棘轮测试 + 文档双孪生（`.html`） | `test:scripts` 全绿 | 是 |

---

## 8. 风险与已知限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 执行器输出形态漂移 | `run.js` 解析 `[ERROR] <id> <file>:<line>` 文本；某检查器改输出格式会让它的 finding 无法反查 | 未匹配 finding 单列「未登记 finding」告警而非静默丢弃；长期方案是给检查器加 `--json`（本次不改） |
| 剩余 10 条无检查器规则 | 本轮已清掉 5 条（SOURCING-002/004、SECURITY-002/003/004），剩 9 `manual` + 1 `carrier` | 逐条写明了机器判不了的原因（见下表），显式归 `manual` 并写 `exception` 理由，让「为什么没有检查器」成为被审阅的结论而非遗漏 |
| pre-commit 性能 | 现有 pre-commit 已含 4 项检查 | 快档只跑 `--changed` 执行器（去重后约 8 个），目标 < 10s；超时降级为仅输出告警不阻断 |
| 三套 ID 命名空间 | 旧 `GOV-*` 与 `DESIGN-*` 文档 ID 仍被发出 | `exec.findings` 建立登记表 ID ↔ finding id 映射，逐步替代；旧 ID 不在本次改写范围 |
| 覆盖率分母只看登记表 | 覆盖率只统计登记表里的 44 条规则，一个检查器可以稳稳执行着登记表里根本不存在的规则（`SEC-001` / `NAM-001` / `UPLOAD-001` …）而覆盖率报告完全看不见 | 已加 `lib/externalRules.js`，`rules:coverage` 现在报「覆盖率盲区 — 检查器在执行但登记表未收录的规则」（实测 37 个 ID 分布在 18 个检查器，已排除 `PTX-` 内部编码族）。**advisory、`--ci` 不阻断**：这些规则真在生效，缺的是登记不是执行，是否补登属人工裁决 |
| `.khy/` 台账体积 | 每次门运行追加 jsonl | 台账只记违规不记通过；单文件超 1MB 时按日期切分 |
| 规则重叠导致重复计数 | `docs-index-complete` 同时被 LAYOUT-001 与 DOCS-001 认领，同一条违规在报告中出现两次 | 刻意保留：两条规则确实都覆盖文档索引，重复出现让「哪条规则受影响」可见。若要精确去重需在台账层按 `(rule, finding, file, line)` 合并，本次不做 |
| `archDebtScan` 降级为 advisory | 它是存量盘点器，无逐条 finding，`blocking` 会让门因既有债务永久亮红 | 已登记 `severity: "advisory"` 并在登记表 `severityNote` 写明原因；**待办**：让它输出 `[ERROR] god-file <file>:<line>` 后升回 `ratchet` |
| `archDebtScan --changed` 在本机失效 | 它以 `cwd: services/backend` 调 git，而 git 的 `safe.directory` 保护把该目录判为「属主不同」并拒绝操作，改动集取不到 → 诚实失败关闭（未扫描即不假绿） | ruleguard 以仓库根为 cwd spawn 检查器，故**规则遵守门不受影响**；`npm run check:arch-debt:changed` 本身需要 `git config --global --add safe.directory <repo>` 或改为从仓库根调 git，属检查器自身的独立缺陷 |
| 布局基线在本机工作树被改小 | `scripts/ci/repo-layout-baseline.json` 有未提交改动，把 `dangling-task` 86→0、`cross-layer-require` 38→0，使 5 类计数全部「超基线」升为 error | 非本次改动引入。按该文件自身 `_note` 的约定「绝不上调来让 CI 变绿」，此处是**下调**（更严格），属他人未完成的工作树状态，不应由绑定层代改 |
| SECURITY-002 分类器盲区 | `commandRiskClassifier` 把 `python -c "...rmtree('/etc')"`、`python3 -c "os.remove('/etc/passwd')"`、`find / -delete` 三种不可逆形态判为非 destructive，故在 bypass/yolo 下可静默执行 | 已按 warning 登记为 `gate-classifier-gap`（不阻断，避免门永久亮红），**待办**：扩充 `commandRiskClassifier` 的 Python 内联与 `find -delete` 识别后升为 error |
| SECURITY-003 声明与实现口径分歧 | 规则文本写「拒绝」，但唯一调用点 `toolUseLoopCore.js` 只投递提醒文案、从不读 `allow`——编辑已发生，护栏实际只是事后顾问 | 已按 warning 登记为 `guard-declared-deny-unconsumed`（不阻断，因为这是**契约漂移**而非实现缺陷，载体自身的注释明确写的是「事后顾问不硬拦」）。需人工裁决：要么把规则文本改成「提醒并要求强模型复核」，要么在调用点补硬拦截 |

### 刻意保留的 manual / carrier 清单

以下 10 条**没有**检查器，且不会补——写一个只会产出噪声或永久红灯。
这是结论，不是待办：

| 规则 | 为什么机器判不了 |
|---|---|
| PROCESS-001 (P0) 禁止 AI 自动 commit/push | 判的是「谁按下按钮」，不是文件内容。静态扫描与运行时都无从观测意图 |
| PROCESS-101 (P2) 提案按模板起草 | 提案在私有仓库 `khy-os-hq`，不在本仓可校验范围内 |
| PROCESS-003 (P1) 验收门禁 | 载体 `goal.js` / `goalModeService.js` 里**没有**验收门禁列表——`check-gov-rules` 在 `services/backend/src/` 全文零命中。这是纯流程约定，硬写检查器只能去断言一个不存在的实现 |
| SOURCING-001 (P0) 上游源码不得复制 | 需要**来源出处**记录（这个文件是从哪来的），无法从代码树本身反推。属 provenance 问题 |
| SOURCING-003 (P1) 提案先于编码 | 理论可从 git 历史判定，但需要提案工件登记 + 逐提交映射，是一个独立子系统，不是检查器 |
| SOURCING-006 (P1) 架构决策只追加不改写 | 同上：需要跨提交的 ADR diff 历史 |
| MEMORY-001 (P2) session vs persistent 归属 | 判的是「这条信息是否跨会话复用」的意图，无机器可判定信号 |
| MEMORY-002 (P1) 五要素 + 不得写凭据 | 没有机器可读的记忆记录 schema 可断言；写入点分散在 4 个文件，无单一真源 |
| MEMORY-003 (P1) 指定读写入口 | 「被指定的入口」目前没有登记为机器可读清单，需先建约定再谈检查 |
| MEMORY-004 (P1) 生命周期清除 | 判的是跨时间的运行时行为，非静态可判定 |

---

## 9. 与既有规范的关系

- **不替代** `[DESIGN-ARCH-070]` 的十板块索引——本文件只补「绑定层」这一块它明确登记为缺口的位置。
- **不新增规则**：本文件不引入新的 `<DOMAIN>-<NNN>`。它复用的四个规则（`TOOLING-004` 工具登记、`TOOLING-005` 门禁接入、`TOOLING-006` 登记表治理、`TOOLING-007` 双向可达）的语义真源各自不变，本文件只是把它们落到可执行路径上。
- **沿用而非重写**：棘轮语义沿用 `check-repo-layout.js` 的 `--promote` / `--update-baseline`；finding 形态沿用 `check-agent-rules.js` 的 `{severity, rule, file, line, message}`；退出码约定沿用 `0/1/2`；fixture-root 环境变量沿用 `KHY_*_ROOT` 模式。
