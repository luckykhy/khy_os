# Khy OS 规范落地自查报告

> 日期 2026-09-21｜现场：`D:/Portable/khy-os` 分支 `chore/tui-ux-nightly`，HEAD `e86bbf6d`（工作区 503 项未提交）。
> 口径：以仓库**自己的规范文本**为准绳，逐条对照代码 / 守卫 / 文档的**实际行为**，找「规范说了但没做到」的地方。
> 结论：**规范没有被违反，规范是被架空了**——现有守卫全绿，而 15 条规则永不执行、P0 红线静默失效。
>
> **状态：纯审计产出，未修改任何守卫代码或登记表。** 修复路线图见文末「五、修复优先级与路线图」。

---

**审计日期**：2026-09-21
**审计对象**：`D:\Portable\khy-os`（分支 `chore/tui-ux-nightly`，HEAD `e86bbf6d`）
**审计口径**：以仓库**自己的规范文本**为准绳（`docs/10_规范/`、`AGENTS.md`、`CLAUDE.md`、`RULES-REGISTRY.json`），逐条对照代码 / 守卫 / 文档的**实际行为**，找出「规范说了但没做到」的地方。
**审计方法**：读规范真源 + 跑全部核心守卫 + 写脚本做机械化交叉校验（脚本落 `.khyos/diag/audit-spec-compliance.js`，不入守卫扫描目录）。

---

## 摘要：一个结构性病症

本次自查共确认 **8 类实质缺陷**，涉及 **至少 170 个具体实例**（15 + 1 + 3 + 66 + 2 + 78 + 3 + 2）。它们不是零散的错误，而是**同一个结构性病症的多个切面**：

> **仓库的规范体系存在大量「登记了但不生效」「生效了但没登记」的静默缺口，而专门用来发现这些缺口的元守卫（`rules:coverage`）主动放弃了对最大盲区的阻断权。**

换句话说：**规范没有被违反，规范是被架空了。** 一条规则可以「写在登记表里、出现在规则卡里、在 `check:rules` 和 `check:wiring` 里全绿」，却**永远不会拦住任何一次改动**。

这个病症最危险的特性是**全绿**——现有的 245 个 npm 脚本里，所有相关守卫都返回 exit 0，看不出任何异常。

| 严重度 | 类别 | 实例数 | 含义 |
|--------|------|--------|------|
| **P0 致命** | 2 类 | 16 | 15 条规则登记了但永不执行；1 条 P0 红线静默失效 |
| **P1 严重** | 4 类 | 149 | 3 组指标台账滞后；66 个覆盖盲区；2 处范围漂移；78 条 severity 缺失 |
| **P2 中等** | 2 类 | 5 | 3 条 ssot 路径写错；2 个文档孪生件缺失 |

（P2-2 另有 8 个位于 `_archive_*` 目录的孪生件缺失，**是否豁免待确认**，故未计入。）

---

## 一、P0 级缺陷

### P0-1 ｜ 15 条 `gate=advisory` 规则在任何门档都不会被执行

**规范怎么说**

`AGENTS.md` 与 `RULES-REGISTRY.json` 的 `meta.note` 明确记录过这条教训（2026-09-18 订正）：

> `gateIncluded()` 的 `GATE_ORDER` 中 advisory(=4) > release(=2)，故 gate=advisory 的规则在任何门档都不会被执行（**登记但不生效**）。S1「观察者」用「gate=commit（会跑）+ severity=advisory（只记录不阻断）」表达。

**实际是什么样**

```
scripts/ruleguard/lib/registry.js:42
  GATE_ORDER = { commit: 0, pr: 1, release: 2, manual: 3, advisory: 4 };
scripts/ruleguard/lib/registry.js:66-70
  function gateIncluded(ruleGate, mode) {
    const max = mode === 'pr' ? 1 : mode === 'commit' ? 0 : mode === 'release' ? 2 : -1;
    return GATE_ORDER[ruleGate] <= max;   // advisory(4) <= 2 恒为 false
  }
```

登记表里仍有 **15 条**规则用了 `gate=advisory`：

```
LAYOUT-005, LAYOUT-006, LAYOUT-007, API-004, TOOLING-003,
DOCS-002, IR-001, DR-001, BACKUP-001, NOTIFY-001,
OPS-002, OPS-003, FF-001, PROMPT-001, FE-004
```

**实测证据**（`npm run rules:gate:commit` 输出）：

```
[ruleguard] 模式 commit：执行器 6 个，违规 121 条
```

6 个执行器全部来自 `gate=commit` 的规则。上面 15 条**一个都没出现**。

**为什么这是 P0**

这 15 条不是无关紧要的规则。其中包括：

| 规则 | 一句话 | 后果 |
|------|--------|------|
| `LAYOUT-005` | 产物唯一根 `entries/<producer>` | 构建产物可以随意落在源码树 |
| `LAYOUT-006` | 可发现性 | 新能力/新入口无人检查 |
| `API-004` | 错误信封一致性 | API 错误格式漂移无人拦 |
| `OPS-002/003` | 运维健康与告警 | 运维缺陷无机器判据 |
| `FE-004` | 前端约束 | 前端规范失效 |

**根因**：登记表的 `gate` 字段语义混乱——它既是「**强度档位**」（commit ⊂ pr ⊂ release）又是「**执行方式标签**」（manual / advisory），两套语义塞进一个字段，导致 `advisory` 这个「本该是 severity 的值」被写进了 `gate`。

**解决方案**

采用**方案 A（推荐）：拆字段 + 全量订正**

1. **把 `advisory` 从 `gate` 的合法取值里移除**。门档只保留 `commit | pr | release | manual`。
2. **这 15 条按实际意图重新归类**：
   - 若本意是「要跑，但只记录不拦截」→ 改 `gate='pr'`（或 `commit`）+ `severity='advisory'`。这与 `LAYOUT-002`、`RUNTIME-007/008/009` 的现有正确写法同构。
   - 若本意是「暂不建执行器」→ 改 `gate='manual'`，由 `rules:coverage` 的 `manual` 归类兜底。
3. **加一条机械判据**：`check-gov-rules.js`（GOV-TOOL-006）校验 `gate ∈ {commit,pr,release,manual}`，出现 `advisory` 直接报 error。
4. **加回归测试**：断言「不存在 `gate` 不在合法枚举内的规则」，且断言 `gate=advisory` 已归零。

**验收方式**

```bash
# 1. 测前应能复现：已知 15 条
node -e "const r=require('./docs/10_规范/registry/RULES-REGISTRY.json');
console.log(r.rules.filter(x=>x.gate==='advisory').map(x=>x.id).join(', '))"
# 2. 修后应为空
# 3. 且 rules:gate:commit 的执行器数应从 6 → 覆盖新增的规则
npm run rules:gate:commit 2>&1 | grep '模式 commit'
```

---

### P0-2 ｜ P0 红线「最高优先级的规则必须有机器执行器」被 `kind=manual` 静默绕过

**规范怎么说**

`scripts/ruleguard/lib/coverage.js:24-28` 定义了三条阻断红线，第一条是：

```js
const BLOCKING_CODES = {
  'p0-unenforced': 'P0 规则处于 unenforced 状态：最高优先级的规则必须有机器执行器。',
  ...
};
```

`AGENTS.md` 同步声明：「`npm run rules:coverage` — 覆盖率与红线（**P0 不允许无执行器**、不允许死指针）」。

**实际是什么样**

红线判定条件（`coverage.js:57-60`）：

```js
for (const rule of manifest.rules) {
  if (rule.priority === 'P0' && rule.kind === 'unenforced') {
    redLines.push({ code: 'p0-unenforced', ... });
  }
```

`kind` 来自登记表字段，**`gate` 不参与 `kind` 推导**（`manifest.js:33-36`）。因此 `kind=manual` 的规则**永远不会等于 `unenforced`**。

**实测证据**：

```
PROCESS-001 -> { priority: 'P0', gate: 'manual', kind: 'manual' }
buildCoverage().redLines === []        ← 空的！
buildCoverage().unenforced === []      ← 空的！
```

`PROCESS-001`「分支纪律」是 **P0 + manual + 零执行器**，完全符合「P0 规则没有机器执行器」的字面描述，但红线**没有触发**。

**为什么这是 P0**

这构成了一个**永久的、合法的豁免后门**：任何 P0 规则只要标上 `kind=manual`（或经 `gate=manual` 推导为 manual），就再也无法被 P0 红线拦住。当前已有 1 条 P0 规则（`PROCESS-001`）落在这个后门里，且**没有任何机制提醒这件事**。

更严重的是：`redLines` 为空的输出会打印 `阻断红线：全部通过`——**给人「P0 全部受机器保护」的错觉，而实际有一条 P0 裸奔**。

**解决方案**

采用**方案 B：显式豁免 + 强制登记**

1. **拆分红线判据**：把 `p0-unenforced` 的条件从 `kind === 'unenforced'` 改为「`priority === 'P0'` 且**没有任何执行器**」（即 `!rule.script`），**不论 kind**。
2. **为 manual 型 P0 开一个需要显式登记的豁免通道**：登记表新增 `manualExempt: { reason, owner, dueBy }` 字段。有该字段的 P0 才允许无执行器，否则报红线。
3. **豁免必须带到期日**，由 `check-debt-ledger.js` 的棘轮机制接管（这条守卫已经在管「逾期须留 slipped 痕迹」）。
4. **输出必须区分**「P0 已受保护」与「P0 已豁免（N 条，最近到期 2026-XX-XX）」，禁止用「全部通过」这种掩盖差异的措辞。

**验收方式**

```bash
# 测前：应报 0 条红线（缺陷）
node -e "const {buildCoverage}=require('./scripts/ruleguard/lib/coverage');
const c=buildCoverage(process.cwd());
console.log('redLines:', c.redLines.length, JSON.stringify(c.redLines))"

# 修后：应报 1 条（PROCESS-001），除非补了 manualExempt
# 反向验证：临时把 PROCESS-001 的 manualExempt 删掉，红线必须出现（防空转断言）
```

---

## 二、P1 级缺陷

### P1-1 ｜ 债务台账与实测数据长期不同步：同一指标三个数

**规范怎么说**

债务台账真源 `scripts/ci/debt-ledger.json` 的 `_rules` 自述：

> **QUAL-1 基线必须是实测值，不是估值。** 发现不符时，第一步是把基线改成实测值（即使更宽松）—— 准确的棘轮能拦回归，错误的连恶化都拦不住。
> **QUAL-3 每一类门禁指标都必须有一条台账条目，由守卫从守卫脚本源码解析后强制覆盖。**

**实际是什么样**

`check:layout` 的 `counts`（守卫实测，连跑 3 次稳定）与台账 / 基线的对照：

| 指标 | 守卫实测 | `repo-layout-baseline.json` | `debt-ledger.json` | 一致？ |
|------|---------|---------------------------|-------------------|--------|
| `dangling-task` | **76** | `88` | `measured: 98` | ❌ 三个数互不相同 |
| `cross-layer-require` | **18** | `39` | `measured: 37` | ❌ 三个数互不相同 |
| `unresolved-require` | `0` | `0` | `measured: 0, status: "closed"` | ✅ 三者一致 |

**为什么严重**

1. **两项指标三方不一致，且永远不会报错。** `check-debt-ledger.js` 只对 `status: closed` 的项做「实测必须为 0」的校验；`dangling-task` 与 `cross-layer-require` 台账里都是 `open`，所以**台账里填错了数字也没有任何守卫会发现**——`check:layout` 只拿实测值跟 `baseline` 比，从不读台账。
2. 直接违反 `QUAL-1`：台账的 `measured` 号称是实测值，但 `cross-layer-require` 记 37、实测 18（**高估 106%**）；`dangling-task` 记 98、实测 76（**高估 29%**）。
3. `QUAL-3` 要求「由守卫从守卫脚本源码解析后强制覆盖」，说明**设计上本该自动同步**，但实现没有，靠人手填。
4. 偏差方向说明**台账长期滞后**：数字比实测**偏高**，意味着这些指标过去确实在改善（有人修好了），但**没人回来更新台账**。如果某天指标真的劣化到超过台账值，台账也不会察觉。

**关于 `unresolved-require` 的现场记录（诚实声明）**

本报告初稿曾把 `unresolved-require` 的「台账 0 vs 实测 2」列为最严重的一条。**复核后撤回该结论**：

```
初稿实测（会话早期）：unresolved-require = 2，check:layout 报 error
复核实测（连跑 3 次）：unresolved-require = 0，三者一致
```

根因：这 4 个 `require` 指向的 `services/backend/vendor/shared/` 与 `platform/packages/shared/` 是**由 `preinstall` 钩子（`scripts/install/link-shared-dev.js`）在安装期建立的软链/拷贝**。初稿跑守卫的窗口正落在**这两个目录被重建的瞬间**（目录 mtime 实测为当日 16:21/16:22，与会话同期），于是守卫看不到目标而报「路径不存在」。目录建好后即归零。

⚠ **这是环境瞬时态，不是代码缺陷**——已从缺陷清单剔除。但这次误判本身**有诊断价值**：它暴露了该守卫的结论**依赖于运行前的环境是否就绪**，在 CI（干净克隆 + 完整 `install`）与本地（增量、可能正在重建）上可能给出不同答案。

**解决方案**

**第一步（止血）：让台账的 `measured` 由守卫自动回填，禁止手填**

1. 在 `check-debt-ledger.js` 里实现「从各守卫的 `--json` 输出抽取实测值」的适配层。每个守卫已有结构化输出（如 `check:layout` 的 `counts: {...}`），可直接解析。
2. 台账条目增加 `source: { cmd, jsonPath }` 字段，声明「这个指标的实测值从哪来」。
3. 守卫发现 `measured != 实测` 时报 **error**（不是 warning），文案：「台账值与实测不符——QUAL-1 要求台账是实测值」。**这一条会立刻抓出上面两项不一致。**
4. 把 `status: closed` 的判定改为**派生**（`measured === 0` 才算 closed），禁止手写。

**第二步（对齐存量）**：把 `dangling-task`（76）与 `cross-layer-require`（18）按实测值重填台账与基线。

**第三步（可选）：消除 `unresolved-require` 的环境依赖**——让守卫在报「路径不存在」前先确认「这路径是否由 install 期软链提供」，避免在重建窗口误报。或至少在文案里提示「若为软链目标，请先跑 `npm install`」。

**验收方式**

```bash
# 1. 复现不一致（应看到台账值 != 实测值）
node -e "const l=require('./scripts/ci/debt-ledger.json');
for(const id of ['layout.dangling-task','layout.cross-layer-require']){
  const e=l.entries.find(x=>x.id===id);
  console.log(id, '台账 measured =', e.measured, '| status =', e.status);
}"
npm run check:layout --silent 2>&1 | grep '^counts:'
#   台账: dangling-task=98 / cross-layer-require=37
#   实测: dangling-task=76 / cross-layer-require=18   ← 不一致

# 2. 修后（启用自动回填）：台账值必须等于实测值
# 3. 反向验证（防空转断言）：手工把台账 measured 改成 999，守卫必须报 error
```

---

### P1-2 ｜ 31 个检查器实际在拦人，却在规则体系里「查无此规则」

**规范怎么说**

`AGENTS.md`：「`npm run rules:coverage` — 覆盖率与红线」、`[DESIGN-ARCH-111]` 宣称**门成员资格从 `RULES-REGISTRY.json` 派生**。

**实际是什么样**

`rules:coverage` 自己打印：

```
检查器：76/87 已接线
  未被任何规则登记（31）：check-build-artifacts.js, check-commit-message.js,
  check-debt-ledger.js, check-dependency-size.js, check-file-ratchet.js,
  check-flag-registry.js, check-frontend-size.js, check-gov-status.js,
  check-leaf-contract.js, check-model-hardcoding.js, check-model-list-truth.js,
  check-moonbit-layout.js, check-node-syntax.js, check-pattern-coverage.js,
  check-prompt-taxonomy.js, check-python-syntax.py, check-runtime-placement.js,
  check-skill-evals.js, check-skill-scenarios.js, check-staged-secrets.js,
  check-tui-gates.js, check-workflow-sanity.js, check-zcode-baseline.js,
  conformance-runner.mjs, discoverability-demo.js, export-dimension-health.js,
  export-quality-dashboard.js, generate-pattern-registry.js, print-maintainer-map.js,
  run-python.js, validate-reliability.js
```

**关键**：这不是「死代码」。我抽验了其中 5 个，全部存在且**其中 2 个真在拦人**：

```
存在: scripts/ci/check-staged-secrets.js (148 行)
存在: scripts/ci/check-commit-message.js (76 行)

.githooks/pre-commit:68   # 3. 检查是否有敏感信息（真源：scripts/ci/check-staged-secrets.js）
.githooks/pre-commit:74   if ! node "$ROOT/scripts/ci/check-staged-secrets.js"; then
.githooks/pre-commit:120    node "$ROOT/scripts/ci/check-commit-message.js" "$COMMIT_MSG_FILE"
```

**`check-staged-secrets.js` 是防密钥泄漏的门，真实挂在 pre-commit 上，但规则登记表里没有它对应的规则。**

同时还有**反向盲区**：`rules:coverage` 报告「**35 个规则 ID 在执行但登记表未收录**」（如 `LAY-004`、`GIT-001`~`GIT-004`、`MEM-006`、`SEMVER-002`、`STD-008` 等）。

**根因（这是关键）**

`coverage.js:166-168` 的注释主动放弃了阻断权：

```js
// 覆盖率盲区：检查器在执行、登记表从未收录的规则。advisory——这些规则是真在
// 生效，缺的是登记，不是执行，故 --ci 下也不阻断。
...
lines.push('  → 不计入上面的覆盖率分母；`--ci` 不阻断，需人工裁决是否补登。');
```

而 `coverageCode` 只认 `redLines` 与 `registry.errors`：

```js
function coverageCode(coverage) {
  if (coverage.redLines.length) return 1;
  if (coverage.registry.errors.length) return 1;
  return 0;
}
```

**「需人工裁决」在 `PROCESS-006` 的四阶段框架下等于永久挂着**——没有到期日、没有 owner、没有任何机制会把它们捞回来。这正是仓库自己反复记录的「红着的门等于没有门」的同一个病。

**解决方案**

**分两步，先量化再收紧**

**第一步：把「未登记」纳入 debt-ledger 台账（立即，不改强度）**

`debt-ledger.json` 新增两条指标：
- `coverage.unregistered-checkers` = 31
- `coverage.external-rule-ids` = 35

带入 `owner: platform, dueBy: 2026-11-30`。这样它们**进入棘轮视野**，只降不升，逾期必须留 `slipped` 痕迹。

**第二步：分类处置这 66 个盲区**（逐项，需要 owner 参与）

我建议按三分法（这是我在 `khyos-new-rule-wiring` 里积累的判据）：

| 情形 | 判据 | 处置 |
|------|------|------|
| **真规则，只是漏登记** | 检查器有独立判据、不是某个大规则的实现细节 | 补登进登记表（补 `ssot` / `exec` / `paths`） |
| **某条规则的实现细节** | 它只服务某条已登记规则 | 在 `exec.findings[]` 里声明其 finding code，不单独建规则 |
| **纯工具，非守卫** | 如 `run-python.js`、`print-maintainer-map.js`、`export-*.js` | 从检查器清单里**排除**（加白名单 + 理由），不计入分母 |

后两类占了多数——**合理的做法是把分母修准，而不是硬建 31 条规则**。

**验收方式**

```bash
# 1. 复现
npm run rules:coverage --silent 2>&1 | grep -A2 "未被任何规则登记"
# 2. 修后：未登记数应显著下降，且剩下的都有白名单理由
# 3. 台账必须收录这两个指标
node -e "const l=require('./scripts/ci/debt-ledger.json');
console.log(l.entries.filter(e=>e.id.startsWith('coverage.')).map(e=>e.id))"
```

---

### P1-3 ｜ 守卫自己承认登记表失真，但这条自曝只是 warning

**规范怎么说**

`[DESIGN-ARCH-111]` 要求「门成员资格从登记表派生」，隐含前提是**登记表描述的范围与守卫实际扫描范围一致**。

**实际是什么样**

`npm run check:json-schemas` 的输出里有一行**自我举报**：

```
[json-schema] 注意：COMMS-002 登记的 paths 是 scripts/ci/json-schemas/** 与
services/backend/src/contracts/**，与本执行器实际扫描范围不一致，属待修缺陷。
```

**为什么严重**

1. 守卫**知道**自己与登记表不一致，但只打印一行 `注意`，**不影响 exit code、不进红线、不进台账**。
2. 同类问题在本次自查中至少发现两处，其中一处就在我记忆里记录过：
   > `RUNTIME-001` 扫到 `.github/**` 但其 `paths` 不含 `.github/` ⇒ **范围漂移误报**
3. 更隐蔽的一层（我在项目记忆中记录过）：**域迁移映射表的 `paths[]` 可静默失效**——守卫**只守 `docs[]`**，所以 `paths` 悬空时「该 area 的 verify 永不进建议命令，而守卫全绿」。

`paths` 字段是 `rules:apply -- <文件>` 的输入。它一旦失真，**「我要改这个文件，适用哪些规则」就会给出错误答案**——该报的规则不报，改代码的人据此以为安全。

**解决方案**

1. **把「守卫自曝范围漂移」升级为 finding**，进 `check:json-schemas` 的 error 计数，纳入债务台账（`coverage.paths-drift`）。
2. **建立机械判据**：守卫的 `--json` 输出里增加 `scannedPaths: []` 字段，`check-gov-rules.js` 断言它与登记表 `paths` 的**归一化后集合相等**（或至少 `paths` 非空且被 `scannedPaths` 覆盖）。不等即 error。
3. **修 `COMMS-002` 与 `RUNTIME-001` 两处**：
   - `COMMS-002`：改 `paths` 为守卫实际扫描范围。
   - `RUNTIME-001`：`paths` 补上 `.github/`，或从守卫里排除 `.github/**`——按真实意图选一个。

**验收方式**

```bash
# 1. 复现
npm run check:json-schemas --silent 2>&1 | grep "不一致"
# 2. 修后：该行应消失，且新增的 paths-vs-scannedPaths 断言为绿
# 3. 反向验证：手工把 COMMS-002 的 paths 改错，断言必须变红
```

---

### P1-4 ｜ `severity` 字段 78/87 条为空，规则强度「落默认值」

**规范怎么说**

`[DESIGN-ARCH-111]` 与 `AGENTS.md` 反复强调「**强度写死 `warning` ⇒ `STAGE` 常量变装饰** ⇒ 必须按阶段派生」，并把「同一改动集 S1/S3 的 error 数必须不同」列为**必须写成测试**的验收。

**实际是什么样**

```
登记表 severity 字段分布：{ "(undefined)": 78, "advisory": 8, "ratchet": 1 }
```

**78 条（90%）规则没有声明 `severity`**。上一个数字很关键：`advisory: 8` ——这 8 条正是 `RUNTIME-007/008/009`、`PROCESS-008/009` 等**新机制观察期**的规则，说明**新写的规则会正确带 `severity`，而存量规则大面积没有**。

**为什么严重**

`severity` 缺失时，强度落到**执行器内部默认值**。这与仓库自己记录的教训完全同构：

> ⚠⚠ **强度写死 `warning` ⇒ STAGE 常量变装饰** ⇒ **按阶段派生**（`severityFor()` 单点）；**验收：同一改动集 S1/S3 的 error 数必须不同**

也就是说：**登记表里声明的 `priority`（P0/P1/P2）与实际执行强度之间没有强制绑定**。一条 P1 规则完全可能因为 `severity` 缺失而在执行器里只报 warning。

**解决方案**

1. **`severity` 从「可选」改为「必填」**，`check-gov-rules.js`（GOV-TOOL-006）校验其存在与合法枚举。
2. **建立派生规则**：若规则未显式声明 `severity`，则**按 `priority` 派生**（P0→error，P1→error 或 warning，P2→warning），并把这个派生**写在登记表生成器/加载器里作为单点**（`severityFor()`），而不是留给各执行器自己默认。
3. **回填 78 条**：跑一次 `npm run rules:backfill`（该脚本已存在，用于回填 `nature/grants/benefit`），扩展它同时回填 `severity`。
4. **加回归测试**：断言 (a) 无 `severity` 的规则数为 0；(b) 同一改动集在 S1 与 S3 阶段产出的 error 数不同（防 STAGE 变装饰）。

**验收方式**

```bash
node -e "const r=require('./docs/10_规范/registry/RULES-REGISTRY.json');
console.log('severity 缺失:', r.rules.filter(x=>!x.severity).length)"
# 修后应为 0
```

---

## 三、P2 级缺陷

### P2-1 ｜ 3 条规则的 `ssot` 路径写错（规范文档写错了自己的路径）

**实际是什么样**

```
SECURITY-002 -> services/backend/src/services/riskGate.js isUnbypassableGate   ← 把函数名当路径
SECURITY-004 -> services/backend/src/services/permissionStore.js VALID_PROFILES ← 同上
DOCS-001     -> docs/08_MGMT_项目管理/MGMT-STD/[MGMT-STD-007] 文档规则总纲.md R1-R7/  ← 尾随 "R1-R7/"
```

**注意**：这里只有 3 条是真错。另有 13 条用的是 `CLAUDE.md#锚点` 或 `AGENTS.md#锚点` 形式——**那是有意的「章程内真源」写法**，不是缺陷。

**解决方案**

- 前两条：`ssot` 字段是「语义真源」的路径。写成 `path 函数名` 会被当路径解析失败。应拆成 `ssot: "services/backend/src/services/riskGate.js"` + 新增 `anchor: "isUnbypassableGate"` 字段，或改用 `#` 锚点形式保持一致。
- 第三条：去掉尾随 `R1-R7/`。
- **加机械判据**：`check-gov-rules.js` 断言 `ssot` 里看似路径的片段必须 `fs.existsSync`，或形如 `path#anchor`。

### P2-2 ｜ `docs/` 下 10 个 `.md` 缺 `.html` 孪生件

**规范**：`[DESIGN-DOC-*]` 要求每个 `.md` 必须有 `.html` 孪生件（我在记忆里也记了这条约束）。

**实际是什么样**（10 / 915）

```
docs/03_DESIGN_设计/_archive_已删除孤儿引擎/  ← 8 个（归档目录）
  [DESIGN-ARCH-024] / -033 / -035 / -038 / -039 / -040 / -042 + 00_INDEX
docs/19_资产/00_INDEX_资产-总目录.md          ← 真缺
docs/19_资产/site/00_INDEX_site-总目录.md     ← 真缺
```

**判读**：`_archive_已删除孤儿引擎/` 是**归档目录**，若规范允许归档豁免，则只有 `docs/19_资产/` 的 2 个是真缺陷。**这需要先确认归档是否豁免**，不能直接算 10 个。

**解决方案**

1. 先确认 `[DESIGN-DOC-*]` 是否对 `_archive_*` 目录豁免；若豁免，在守卫里加白名单 + 理由。
2. 补 `docs/19_资产/` 两个孪生件（跑 `npm run docs:build`，注意它有**非零副作用**——会重写全站陈旧孪生件）。
3. 把这些修复脚本化，避免「补了这次，下次又漂移」。

---

## 四、附带发现（值得记录，未单列为缺陷）

| 发现 | 性质 | 建议 |
|------|------|------|
| 根目录 3 个事故残留：`0)`、`nul`、`x[1].toUpperCase()+'` | `check:layout` 已报 error（存量） | 直接删；并查生成它们的脚本（`x[1].toUpperCase()` 是典型的 JS 模板串展开事故） |
| `gui-test-screenshots/` 是未登记顶层目录 | `check:layout` 报 error | 登记进 `[DESIGN-LAY-005]` 或迁入 `entries/` |
| `docs/tui-interaction-optimize/` 缺 `00_INDEX_*` | `check:layout` 报 error | 补索引 |
| `check:agent-feedback` 报 120 条 warning 但全部不阻断（S1 观察期） | 符合 `PROCESS-006` S1 设计 | 正常；但 120 条样本已远超 S1 门槛（≥200 才毕业），应着手 S2 评估 |
| `check:proposal-index` 报「提交 `e86bbf6` 同时触及标记/删除/调用方三类改动（1725 个调用方文件）」 | 违反 `SOURCING-001` B-L2 「每步独立可回滚」 | 该提交已落地，建议在后续拆分类似改动 |
| `check-memory-schema` 报 2 处 `seam-bypass-write`（`autoDream.js:214`、`distiller.js:293` 裸写绕过 `memdir._safeWriteFileSync`） | 违反 `DESIGN-MEM-006 §3` | 改为走 `memdir` seam；同时 `memdir.js` 本身未登记为 `designatedEntries`（守卫已报） |
| `check:provenance` 报 `services/backend/vendor/shared` 状态 `unverified` 且既不在台账也不在 `knownGaps` | 登记缺口 | 补登 |
| `SECURITY-001` 硬编码「改动数 >20 拦截」且无豁免通道 | 我记忆中已记录此坑 | 本次工作区 420 files 已被它拦死（`[BLOCK] ... Threshold: 20`）。而 `PROCESS-009` T5 原文是「>20 时先问人」——**规则说问人，实现只会永久拦截** |

---

## 五、修复优先级与路线图

### 立即做（止血，不改结构）

| 序 | 动作 | 依据 | 预估触点 |
|----|------|------|----------|
| 1 | 删根目录 3 个残留文件 | P2-附 | 1 |
| 2 | 台账 `measured` 改为守卫自动回填 + 不符即 error | P1-1 | 2 |
| 3 | `coverage.unregistered-checkers` / `coverage.external-rule-ids` 进台账 | P1-2 | 2 |
| 4 | `COMMS-002` / `RUNTIME-001` 的 `paths` 订正 | P1-3 | 2 |
| 5 | 台账 `dangling-task`(76) / `cross-layer-require`(18) 按实测重填 | P1-1 | 2 |

### 结构性修（按顺序，每条都要走 `PROCESS-006` 四阶段）

| 序 | 动作 | 依据 | 风险 |
|----|------|------|------|
| 6 | `gate` 枚举去 `advisory` + 15 条重归类 | **P0-1** | 中（改登记表语义，需逐条判断意图） |
| 7 | `p0-unenforced` 红线改为按「有无执行器」判定 + 显式豁免通道 | **P0-2** | 中（会亮出新红灯，需同步补豁免登记） |
| 8 | `severity` 改必填 + 按 `priority` 派生单点 | P1-4 | 中（78 条回填） |
| 9 | 66 个覆盖盲区三分法分类处置 | P1-2 | 大（需 owner 参与逐条裁） |

### 修正体（防复发）

10. 上述每一条都**必须配一个「反向验证」**：把修复点手工改坏，断言必须变红。仓库自己已经吃过「空转断言」的亏（我记忆里记着：「实测关掉守卫时它真变红（防空转断言）」）。

---

## 六、本次自查的方法与边界

**做了什么**

- 读了 4 处规范真源：`RULES-REGISTRY.json`（87 条）、`AGENTS.md`、`CLAUDE.md`、`docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005]`
- 跑了 16 个核心守卫（`check:rules`、`check:wiring`、`rules:coverage`、`rules:manifest`、`rules:gate:commit`、`check:layout`、`check:gov-rules`、`check:debt-ledger`、`check:json-schemas`、`check:agent-docs`、`check:proposal-index`、`check:provenance`、`check:memory-schema`、`check:data-layout`、`check:build-root`）
- 写了机械交叉校验脚本 `.khyos/diag/audit-spec-compliance.js`（9 项检查）
- 直接读了 ruleguard 绑定层源码：`registry.js`（`GATE_ORDER`/`gateIncluded`）、`manifest.js`（`kind` 推导）、`coverage.js`（`BLOCKING_CODES`/`coverageCode`）

**边界与免责**

1. **工作区有 503 项未提交改动**，当前分支 `chore/tui-ux-nightly` 无上游。我已对**所有核心结论**在 HEAD 版本复核（`ruleguard/` 目录零改动；HEAD 版登记表 `gate=advisory` 同为 15 条）。结论**在 HEAD 成立**。
2. 我**没有**修改任何守卫代码或登记表——本报告是纯审计产出。
3. 「66 个覆盖盲区」的**分类处置**需要 owner 逐条裁决，本报告只给出三分法判据，不代替裁决。
4. `P2-2` 的 10 个孪生件缺失中，8 个在 `_archive_*` 目录，**是否豁免需先确认规范**，故未计入缺陷总数。

**口径修正记录**（避免误导）

本报告经**三轮复核**，前两轮各撤回一条结论。完整记录如下，作为方法可信度的凭据：

1. **撤回「24 条 ssot 不可达」→ 3 条**。其余是 `CLAUDE.md#锚点` 这种**有意的「章程内真源」写法**，或我的切分把 `§1` 当成了路径。同时撤回「88 张卡片 vs 87 条规则」——`00_INDEX_规则卡总目录.md` 是索引非卡片，实际卡片正好 87，**不是缺陷**。
2. **撤回「`unresolved-require` 台账 0 vs 实测 2」这条「最严重」结论**。复核后实测为 0、三者一致。根因是**环境瞬时态**：该指标指向的 `vendor/shared` 等目录由 `preinstall` 钩子在安装期建立，初稿跑守卫的窗口正落在重建瞬间。**已从缺陷清单剔除**，替换为稳定的 `dangling-task` / `cross-layer-require` 台账滞后。
3. **修正「4 处」→「2 处」**：守卫文案列的**位置行数**与 `counts` 的**计数值**口径不同。本报告一律以 `counts`（守卫结构化计数）为准。⚠ 这正是仓库自己记录的坑：「`--json` 后仍追加 `Summary:` 行 ⇒ 解析前必须切分」。

**复核动作**：关键数字（15 / 78 / 3 / 10 / 87）全部重跑验证；`check:layout` 的 `counts` 连跑 3 次确认稳定。

---

*报告产出：`.khyos/diag/audit-spec-compliance.js`（可复现脚本）。*
