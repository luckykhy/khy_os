# [DESIGN-GIT-004] 提交时机规范

<!-- RULES-REGISTRY: PROCESS-009 -->

> 版本: 1.1.0 · 状态: 生效 · 负责人: khy · 创建日期: 2026-09-19
> 规则 ID: `PROCESS-009`（登记见 `docs/10_规范/registry/RULES-REGISTRY.json`）
> 关联: [DESIGN-GIT-001] Git 工作流规范 · [DESIGN-GIT-002] Commit Message 规范 ·
> [DESIGN-GIT-003] Git 自动化治理规范 · [DESIGN-PROCESS-002] 新机制落地四阶段流程 ·
> [DESIGN-ARCH-111] 规则遵守保障机制 · [DESIGN-ARCH-113] AI 修改三模态反馈契约
> 守卫: `scripts/ci/check-commit-timing.js`（别名 `check:commit-timing`）
> 落地阶段: **S1 观察者**（`FEATURE-OWNERSHIP.json` → `commit-timing-contract`）

---

## 0. 一句话

把「提交」从**要记住的动作**变成**有判据的结论**：

> 一个工作单元做完了、自证过了、能独立回滚 —— 就提交。
> 判据不满足就别提交，**并且说清缺哪一条**。

---

## 1. 现状：一个被漏掉的空白

### 1.1 已成对存在的两半

本仓的 Git 治理是**成对**的 —— 格式与内容都有规范，且都有守卫：

| 维度 | 真源 | 守卫 | 状态 |
|---|---|---|---|
| 提交**格式** | `[DESIGN-GIT-001]` §2 / `[DESIGN-GIT-002]` | `scripts/ci/check-commit-message.js`（pre-commit 第 5 项） | ✅ 已接线 |
| 提交**内容** | `[DESIGN-GIT-003]` §4 | pre-commit 第 1–3 项（tmp / 大文件 / 密钥） | ✅ 已接线 |
| 提交**时机** | —— **无** —— | —— **无** —— | ❌ **空白** |

实测（2026-09-19）：全仓检索「什么时候该提交 / 提交时机 / commit timing / 何时提交」，
在 `docs/` 与 `scripts/` 下**只命中 3 处**，且全部是无关的巧合
（`RULES-REGISTRY.json:2744` 是 `PROCESS-006` 的 `grants` 里「何时提交升阶评审」；
两张 `PROCESS-006` 规则卡是同一句的镜像）。**没有任何一份文档回答「什么时候该提交」。**

### 1.2 后果：判据缺失被转嫁给人

现状下的实际行为链路：

```
AI 改完代码
   │
   ├─ 改完就提交 ──→ 半成品入库：跑不通的中间态、探针文件、调试残留一起进去
   │                 （pre-commit 只查 tmp-*/大文件/密钥/格式，**不查"这是不是一个完整的单元"**）
   │
   └─ 不确定就不提交 ──→ 工作区持续膨胀到 3000~4000 项未提交
                        （实测：`git status --porcelain | wc -l` = 4002）
                        下次会话无法区分「本次改了什么」与「上一轮遗留什么」
                        回归时无从二分定位
```

两条路都坏，而「该走哪条」的判断**被完整地留给了人**：

- 对**维护者**：需要同时记住当前任务边界、验证状态、爆炸半径 —— 这是持续的认知税。
- 对 **AI**：没有任何判据可依据，于是**要么过度提交、要么永不提交** —— 两者都是默认行为，
  且都不会被任何既有守卫报出来。这是典型的「机制缺失伪装成个人习惯问题」。

> 一句话：**`[DESIGN-GIT-003]` 管「提交要长什么样」，但没人管「该不该提交」。**

### 1.3 既有件为什么接不住

| 既有件 | 它管什么 | 为什么不管时机 |
|---|---|---|
| `scripts/ci/check-change-safety.js` | 爆炸半径、删除/新增/敏感路径 | 它**度量**改动，但只在改完之后说；不判「能不能提交」 |
| `scripts/ci/check-agent-feedback.js` | 三模态存证（复现 / 五问 / 回滚） | 它管**改动过程中**的资格，不判「这个单元做完了没有」 |
| `.githooks/pre-commit` | tmp / 大文件 / 密钥 / ruleguard / 格式 | 全是**否决型**检查：只拦坏的，不确认好的 |
| `.githooks/post-commit` | 推镜像 | 提交**之后**的动作 |
| `[DESIGN-GIT-001]` §5.2 | 发布流程的「7 步」 | 管**发版**节奏，粒度是 release 不是 commit |

⇒ **没有一条既有件给出「现在可以提交了」的正向判据。** 本节即为补这个空白。

---

## 2. 设计公理

四条不可让渡：

1. **提交是单元边界，不是时间边界。**
   判据是「一个工作单元完成了」，**不是**「过了 30 分钟」或「改了 5 个文件」。
   这与 `[DESIGN-PROCESS-002]` PP-2「毕业以样本量计、不以时间计」同源 ——
   时间不产生新信息，**完成度才是真变量**。

2. **没跑过的不算做完（证据优于声称）。**
   沿用 `[DESIGN-ARCH-113]` 公理 1：**不接受 AI 转述**，只认客观证据。
   「我改好了」不是判据；「这条命令跑过、退出码 0」才是。

3. **不可独立回滚的不许单独提交。**
   沿用 `[DESIGN-ARCH-113]` 公理 4（回滚优于承诺）。判据对 AI 与对人**同构**：
   一个提交必须能被单独 `git revert` 而仓库仍可用。

4. **判据给不出唯一答案时，默认不提交并说明缺哪一条。**
   宁可少提交，不可错提交 —— 错提交会把半成品固化成历史。
   **AI 必须输出「为什么现在提交 / 为什么还不提交」的一句话**，不允许静默。

---

## 3. 五个判据（全部满足才提交）

> 评级：**R** = 必须（Required），**S** = 建议（Suggested，缺失只记录不阻断）。

| # | 判据 | 级 | 可自动判的判据（守卫 finding） |
|---|---|---|---|
| **T1** | **单元闭合** —— 只有一个逻辑意图。能用一个 `<type>(<scope>): <描述>` 说完，不需要「顺便」。 | R | `unit-multi-intent`（改动集跨 ≥3 个顶层板块） |
| **T2** | **可运行** —— 语法/类型/构建至少过一遍（能跑的就跑，跑不了的说清为什么）。 | R | `unit-unverified`（新增/修改代码文件但无验证证据） |
| **T3** | **仓库自洽** —— ruleguard commit 档通过，且**没有把别人的未提交改动卷进来**。 | R | `unit-not-self-consistent` / `unit-sweeps-foreign-changes` |
| **T4** | **无游离产物** —— 无 `tmp-*` / `*.tmp` / 探针 / 调试残留 / 本机态文件。 | R | `unit-stray-artifacts` |
| **T5** | **可回滚** —— 该提交能单独 revert。涉及删除/迁移时须有可执行回滚路径。 | S | `unit-not-rollbackable` |

### 3.1 T1 单元闭合 —— 「一个逻辑意图」怎么判

**不接受自我声称**（AI 说「这是一个单元」不算）。两个客观信号：

- **顶层板块跨度**：`git diff --name-only` 的路径第一个目录名去重计数。
  `services/` + `apps/` + `docs/` 三板块同现 ⇒ 大概率是三个意图。
  > ⚠ 例外（不算多意图）：① 一次**文档 + 其代码**同步（如规则文档 + 执行器，**本就是 SOURCING-006
  > 要求的同一批**）；② 一次**测试 + 被测代码**；③ 机械性重命名/格式化。
  > 故 `unit-multi-intent` 的强度是 **warning**，由人/模型结合意图字符串判定，不自动升 error。
- **`<scope>` 可写性**：若写 `[DESIGN-GIT-002]` §2.3 的 scope 时需要填 3 个，说明这不是一个单元。

### 3.2 T2 可运行 —— 「验证证据」的定义

验证证据 = **本工作单元内**跑过的、退出码为 0 的记录。落点与 `[DESIGN-ARCH-113]` §6 存证同源：

```
.khy/feedback/<task-id>/verify.txt      # 验证命令 + 原始输出（不许转述）
```

**判据不要求「全量测试通过」** —— 那对单机单用户过重，且会让 AI 为了过关而撒谎
（`[DESIGN-ARCH-113]` §5 的强度梯度正是为防这个）。判据只要求：
**改了可执行代码 ⇒ 至少有一条与之相关的验证记录**。

> ⚠ 为什么这条是 R 而不是 S：`[DESIGN-ARCH-113]` 的实测教训是
> 「事前就用 error 会逼 AI 谎报」。所以 **T2 在 S1 阶段是 warning**（本规范如实登记），
> 待样本攒够后按 PP-2 升档。**本规范不假装它现在是强制的。**

### 3.3 T3 仓库自洽 —— 本仓特有的高风险判据

这一条针对本仓**多智能体并发写**的现实：

- ⚠ **工作区长期有 3000~4000 项未提交**（实测 4002）。`git add .` / `git commit -a`
  会把**并发方的未提交改动一起卷进你的提交** —— 而 `git log` 看起来完全正常。
- 判据：提交的暂存集里，若含 **mtime 早于本会话开工时间**且**不属于本单元意图**的文件 ⇒
  `unit-sweeps-foreign-changes`（warning）。
- **正确做法**：显式 `git add <具体路径>`，**禁止** `git add -A` / `git add .` / `git commit -a`。

### 3.4 T5 可回滚 —— 与 `RUNTIME-009` 的分工

`RUNTIME-009`（删除先报部位）管的是**删除动作本身**的资格（要 `scrub-plan.md` + `rollback.txt`）。
T5 管的是**这个提交能不能被单独撤销**。两者不重复：

| | `RUNTIME-009` | T5（本规范） |
|---|---|---|
| 问的问题 | 「你**该不该删**？」 | 「这个提交**能不能单独撤**？」 |
| 触发 | 有 `D` 状态文件 | 任何提交 |
| 存证 | `scrub-plan.md` / `rollback.txt` | 无需新存证，用 git 语义判 |

---

## 4. 与「不问就提交」的边界（安全护栏）

**AI 主动提交的授权边界**（这是本规范最重要的约束，`PROCESS-009` 的 `constraint`）：

| 情形 | 行为 |
|---|---|
| T1–T4 全绿，无删除，板块跨度 ≤2 | ✅ **AI 直接提交**，并在回复里报「提交了什么 / 为什么够格」 |
| 含 `D` 状态文件（删除） | ⛔ **先问**（转 `RUNTIME-009`：先出 `scrub-plan.md` + `rollback.txt`） |
| 板块跨度 ≥3 或暂存 >20 个文件 | ⛔ **先问**（复用 `check-change-safety.js` 的 `ERROR_CHANGED_FILE_COUNT = 20`） |
| 触及敏感路径（`.github/`、`secrets`、`deploy/`、`package.json` 的发布字段） | ⛔ **先问** |
| T2 未满足（没跑过验证） | ⛔ **不提交**，先跑；跑不了就说清为什么 |
| 任何一条 R 判据不满足 | ⛔ **不提交**，输出缺失项 |

> **一条底线**：AI **绝不**为了让判据变绿而编造验证记录。
> 这与 `[DESIGN-ARCH-113]` §3.2 的反形式主义条款同源 ——
> `confidence: low` 不扣分，**装作确定才扣分**。

---

## 5. 强度梯度（依 `PROCESS-006` / `[DESIGN-PROCESS-002]`）

**新拦截型机制必须先过 S1 观测阶段（PP-1）**，禁止直接进 S3 门禁。

| 阶段 | 行为 | 本规范当前落点 |
|---|---|---|
| **S1** 观察者 | 只记录，不拦截、不提示 | ← **当前在这里**（`STAGE='S1'`，全部 finding 为 warning，恒 exit 0） |
| S2 顾问 | 记录 + 提示，仍不拦截 | 待 ≥200 条样本 |
| S3 门禁 | 拦截，可豁免（T1–T4 升 error） | 待 S2 毕业（≥50 提示且误报 <10%） |

**强度按阶段派生，不是写死的 `warning`** —— `severityFor(criterion)`（`check-commit-timing.js`）：
S1/S2 阶段 R 判据为 warning，S3 起升 error；T5（S 判据）永远只记录。

> ⚠ 这一条是本规范落地时的**实测订正**。初版把所有 finding 写死 `SEV_WARNING`，
> 结果是 S1 与 S3 跑出**完全相同**的输出与退出码 ⇒ 升到 S3 后机制**仍然不拦截**，
> 而所有守卫全绿（登记表说 S3、源码常量也是 S3、漂移比对也过）。
> 这正是「登记了门禁但不生效」，且**表现恰好伪装成 S1 的预期行为**。
> **校验方式**（写进 §8 验证表）：对**同一改动集**分别用 S1 与 S3 常量跑，
> `Summary` 的 error 数与退出码**必须不同**；相同即为此 bug。

**阶段权威在执行器源码**（`scripts/ci/check-commit-timing.js` 的 `STAGE` 常量），
登记表只是镜像；`check-rollout-stage.js` 会比对此二者，**漂移即报错**。

**门档表达**（避开 `gate='advisory'` 死规则陷阱）：
`gate: "commit"`（会跑）+ `severity: "advisory"`（只记录）—— 与 `LAYOUT-002` /
`RUNTIME-007`~`009` / `PROCESS-008` 同构。

---

## 6. 防呆铁律（不可绕过）

1. **禁止** `git add -A` / `git add .` / `git commit -a` —— 本仓并发方未提交改动会被卷入。
   → warning `unit-sweeps-foreign-changes`
2. **禁止**在没有验证证据的情况下提交可执行代码改动。→ warning `unit-unverified`
3. **禁止**把多个逻辑意图塞进一个提交。→ warning `unit-multi-intent`
4. **禁止**提交含 `tmp-*` / `*.tmp` / 探针脚本的暂存集。→ warning `unit-stray-artifacts`
5. **禁止**在 T2 未满足时**声称**「已提交并验证」。→ 反形式主义条款，人工评审兜底
6. **禁止**绕过本判据直接进 S3 —— 必须按 PP-1 走完 S1/S2 观察期。
   → 由 `PROCESS-008` / `check-rollout-stage.js` 兜底

---

## 7. B-L2 三步接线（依 `SOURCING-006`，一次提交只做一步）

| 步 | 内容 | 状态 |
|---|---|---|
| **1 标记** | 本规范文档 + `scripts/ci/check-commit-timing.js`（恒 exit 0）+ `package.json` 别名 + `RULES-REGISTRY.json` 补 `PROCESS-009` + `FEATURE-OWNERSHIP.json` 登记 S1 + 规则卡 | **已完成** |
| **2 迁移** | 升 S2：接提示通道（照 `[DESIGN-ARCH-113]` 的 `PrePrompt` 注入器同构），仍不拦截 | 待样本 |
| **3 收口** | 升 S3：`STAGE='S3'`，T1–T4 真拦截 | 待毕业 |

> ⚠ 步骤 2/3 **不新造通道** —— 复用既有的 `agentFeedbackService` 文件 store
> （`.khy/feedback/` 与提示通道 `pending.json` 同源）。
> **不新造第二套提示机制**（`[MGMT-STD-008]` §2.2「重叠即违规」）。

### 7.1 执行面（判据的「用起来」一侧，与阶段迁移解耦）

⚠ **判据光有守卫是不够的**：守卫只回答「这次提交**合不合**判据」，
不回答「**现在该不该**提交」。判据若不落到 AI 的实际决策路径上，
就只是文档里的一段话 —— 这正是 §1.2「判据缺失被转嫁给人」的原地复发。

故本规则同时落地**执行面**，与守卫**分工明确**：

| 件 | 位置 | 角色 |
|---|---|---|
| **纯叶子** | `services/backend/src/cli/commitTiming.js` | 判据 T1–T5 的**可复用纯函数**（零 IO·绝不抛·env 门控 `KHY_COMMIT_TIMING`）。三结论 `commit-now` / `ask-first` / `do-not-commit` |
| **人用命令** | `services/backend/src/cli/handlers/commit.js` → `khy commit` | 采 git 数据 → 交叶子判定 → 渲染。**默认只判断**，真提交要显式 `--yes` |
| **AI 用工具** | `services/backend/src/tools/gitCommit.js`（新增 `checkTiming` 参数） | AI 真正用来提交的工具。`enforce` 下判据不满足**直接拒绝**；`warn`（默认）下提交但回传判断 |

> **为什么执行面与阶段迁移解耦**：阶段（S1→S4）管的是**守卫的拦截强度**；
> 执行面管的是**判据有没有被用**。二者正交 —— 执行面在 S1 就能生效，
> 且它**不引入新的拦截通道**（`khy commit` 是人主动敲的，`gitCommit` 是 AI 主动调的），
> 故不违反 `PROCESS-006` 的 PP-3「S1/S2 必须旁路记录禁止阻断」。
>
> **关键改动**：`gitCommit` 工具的原描述是「**Use it only when the user asks to commit**」
> —— 这是「AI 不知道什么时候该提交」的**机制根源**。现改为给出到点判据
> （`PROCESS-009` 的三条：单意图 / 已验证 / 无外来改动），并新增 `checkTiming` 参数。

执行面实测（`services/backend/tests/`，42 个用例全绿）：

```
commitTiming.test.js        34 passed   —— 判据 / 三结论 / -z 解析 / verify 时间锚 / 真 git commit
gitCommitTiming.test.js      8 passed   —— enforce 拒绝 / warn 回传 / off 回退 / fail-soft
```

---

## 8. 验证

| 项 | 方式 | 判据 |
|---|---|---|
| 判定确定性 | 纯函数，同输入同输出 | 场景矩阵可复现 |
| 不误伤 | 干净单元（单板块 + 有验证）应 0 finding | 见 §9 场景 1 / 6 |
| 反例命中 | 每个反例报出预期 finding | 见 §9 |
| 只记录不拦截 | S1 阶段恒 `exit 0` | `echo $?` = 0 |
| **阶段真生效** | **同一改动集**分别用 S1/S3 常量跑，`Summary` 的 error 数**必须不同** | S1 → `0 error(s)`；S3 → `1 error(s)` 且 `exit=1` |
| 零外部依赖 | 只 `require` `fs` / `path` / `child_process` | 无 `node_modules` 依赖 |
| 离线可跑 | 不联网、不调模型 | 全程本地 |
| 真被调用 | `rules:gate:commit` 里有 `action=start` | 防「空接线」 |

**实测输出**（2026-09-19）：

```
S1 场景矩阵                         S3 对照（同一批场景）
clean-unit            0e / 0w       clean-unit            0e / 0w
unit-multi-intent     0e / 1w       unit-multi-intent     1e / 0w
unit-unverified       0e / 1w       unit-unverified       1e / 0w
unit-stray-artifacts  0e / 1w       unit-stray-artifacts  1e / 0w
sweeps-foreign        0e / 1w       sweeps-foreign        1e / 0w
docs-only             0e / 0w       docs-only             0e / 0w
```

退出码：`S1 unit-unverified → exit=0`；`S3 unit-unverified → exit=1`。
⇒ 阶段常量**真的控制行为**，不是装饰。

---

## 9. 反例清单（每条 → 预期 finding）

| # | 行为 | 预期判定（S1 阶段均为 warning，恒 exit 0） |
|---|---|---|
| 1 | 单板块改动 + 有验证记录 | **0 finding**（证明不是无脑拦） |
| 2 | 一次 commit 同时改 `services/` `apps/` `docs/` | `unit-multi-intent` |
| 3 | 改了 `services/backend/src/*.js` 但无任何验证记录 | `unit-unverified` |
| 4 | 暂存集含 `tmp-probe.js` | `unit-stray-artifacts` |
| 5 | `git add .` 后提交（含 mtime 早于本会话的文件） | `unit-sweeps-foreign-changes` |
| 6 | 只改 `docs/*.md`（文档单元） | **0 finding**（文档不要求运行验证） |
| 7 | 删除文件但不带回滚路径 | 转 `RUNTIME-009`（本规范不重复报） |

---

## 10. 复现方式

```bash
NODE="D:/WorkBuddyData-Intl/.workbuddy-ai/binaries/node/versions/22.22.2-2/node.exe"

# 语法自检
$NODE --check scripts/ci/check-commit-timing.js

# 单场景
$NODE scripts/ci/check-commit-timing.js --scenario=unit-multi-intent

# 自定义改动集
$NODE scripts/ci/check-commit-timing.js --files="M:services/backend/src/a.js,M:apps/ai-frontend/src/b.js"

# 真实待提交集（= 暂存区；未 add 任何东西时为 0 项）
$NODE scripts/ci/check-commit-timing.js --changed

# ⚠ 工作区全量视角（本仓常有数千项，读数会偏大）—— 仅供体检，不是判据口径
$NODE scripts/ci/check-commit-timing.js --worktree

# 自动化测试（23 用例，含「阶段真生效」与「不误伤」对照）
$NODE --test scripts/tests/check-commit-timing.test.js

# 接线实证（必须看到 action=start）
npm run rules:gate:commit 2>&1 | grep commit-timing
```

可用场景：`clean-unit` `unit-multi-intent` `unit-unverified` `unit-stray-artifacts`
`sweeps-foreign` `docs-only`

> ⚠ **测试的临时副本落 `scripts/.ct-timing-tmp/`，不是 `scripts/ci/`**。
> `scripts/ci/*.js` 是 `check-wiring.js` 的扫描范围 —— 副本放那里会让并发运行的守卫
> 看到「零接线检查器」而报 error（间歇性、极难归因）。
> **写任何守卫测试时先问：这个临时文件会不会被别的守卫扫到？**

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0.0 | 2026-09-19 | 首版。补 `[DESIGN-GIT-001]`/`[003]` 之外的「提交时机」空白。五判据 T1–T5；依 `PROCESS-006` PP-1 定为 S1 观察者（`gate=commit` + `severity=advisory`，恒 exit 0）。 |
| 1.1.0 | 2026-09-19 | 补 §7.1 **执行面**：纯叶子 `cli/commitTiming.js` + 人用命令 `khy commit` + AI 工具 `gitCommit.checkTiming`。修正 `gitCommit` 工具描述中「只在用户要求时提交」的机制根源。42 个执行面用例全绿。 |

---

*本规范由 khy-os 平台团队维护*
