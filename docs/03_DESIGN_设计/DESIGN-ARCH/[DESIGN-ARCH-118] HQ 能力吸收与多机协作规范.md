# [DESIGN-ARCH-118] HQ 能力吸收与多机协作规范

> **定位**：把 khy-os-hq（指挥部）的能力**吸收进 khy-os 现有机制**，然后废弃 HQ 仓库，
> 同时**保住多机协作**。本文是该方案的规范真源，机器可读数据真源见 §3.1 的落点表。
>
> **两条硬约束（用户已确认）**：① **多机协作是刚需**；② **要丢弃 khy-os-hq 仓库**。
>
> **本文不新增门禁规则**，因此不携带 `<!-- RULES-REGISTRY -->` 标记。
> 它登记的是**一处能力迁移与会话协议收口**：把此前散在另一个仓库的提示词/状态/检查，
> 收敛进 khy-os 自己的 `.ai/` 与 CLI。
>
> **依据**：入库状态目录先例 `git ls-files .ai`；目录层级与例外门槛 `[DESIGN-LAY-005]`
> §1.3/§1.4 与 §1.5；AI 指令文件标准 `[DESIGN-DOC-002]`（`DOCS-003`）；
> 分支与推送纪律 `CLAUDE.md` §一 R1（`PROCESS-001`，P0）；规则接线三步 `[DESIGN-ARCH-111]`。

---

## 一、为什么不是「搬家」，而是「吸收」

前一版调研已否决「把 HQ 目录搬进 khy-os」，理由有二（均实测）：

| # | 搬家方案的死因 | 实测证据 |
|---|---|---|
| D1 | HQ 的 7 个脚本靠**向上四级推算 `PORTABLE_ROOT`** 来定位 khy-os | `hq_common.py:26-29`：`PORTABLE_ROOT = dirname(dirname(dirname(SCRIPT_DIR)))`；`find_khyos()` 取 `<PORTABLE_ROOT>/khy-os`。HQ 嵌进 khy-os 后推出 `khy-os/Projects`，探测 `khy-os/Projects/khy-os` **不存在** |
| D2 | `hq_check.py` 会**递归自扫整个宿主仓库** | `iter_files()` 只跳 `{.git,node_modules,__pycache__,logs}`；嵌套后扫描量 35 → **3985** 文件，对 khy-os 的 **407 个含盘符引用文件**逐一报 ERROR → 门禁永久红 |

**但用户要的不是「搬家」，是「废弃这个仓库」。** 两者的解法完全不同 ——
**只迁移数据与知识，不迁移脚本**，D1 与 D2 **同时消失**（脚本不迁移即不在 khy-os 内运行）。

> **判据**：HQ 的价值 = **提示词库 + 任务/Bug 状态 + 机械检查**。
> 这三样都可以是 khy-os 内的数据与命令，**不必是另一个仓库**。

---

## 二、khy-os 已有的承接件（实测，无需新造）

| HQ 的能力 | khy-os 现有对应物 | 实测结论 |
|---|---|---|
| 入库的状态目录 | `.ai/` **已入库**（`git ls-files .ai` = 4 个 `.md`，含 `.html` 孪生件） | ✅ **已有先例**，不必新发明 |
| 多机同步通道 | khy-os 自带 3 个远端（`origin` / `gitee` / `khy-mirror`） | ✅ 通道现成；HQ 的 `sync.py` 双仓编排是**多余的一层** |
| 任务服务层 | `taskControlService` / `taskClosure` / `taskScheduler` / `taskDecomposer` / `planModeService` / `goalModeService` / `todoStorePath` 等约 30 个模块 | ✅ 任务基础设施已相当完备 |
| 机械检查 | `scripts/ci/` **61 个检查器** + `ruleguard` 门禁 + `check-wiring` | ✅ 足以吸收 HQ 的自检 |
| CLI 命令 | `src/cli/handlers/` **152 个自注册 handler** | ✅ 加命令是常规操作（自注册，无需改路由） |

> **注意区分**：`.khy/`、`.khyos/`、`.khyquant/` 均被 gitignore（**本机态，不入库**）——
> HQ 的状态数据**必须放 `.ai/`**，放上述目录会导致多机不同步。

---

## 三、方案

### 3.1 落点表

| HQ 原物 | khy-os 新落点 | 说明 |
|---|---|---|
| `_meta/ROADMAP.md` | `.ai/hq/ROADMAP.md` | 路线图（人读） |
| `_meta/PROGRESS.json` | `.ai/hq/PROGRESS.json` | 任务状态真源（机读） |
| `_meta/bugs.json` | `.ai/hq/BUGS.json` | Bug 状态机（机读） |
| `_meta/MODELS.json` | `.ai/hq/MODELS.json` | 模型能力档案 |
| `_meta/CONTEXT.md` | `.ai/hq/CONTEXT.md` | 架构速查 + 工程红线 |
| `prompts/**`（19 个） | `.ai/hq/prompts/**` | 自包含提示词 |
| `scripts/next.py` / `new_bug.py` / `update_status.py` | `khy hq ...`（新增 CLI handler） | 见 §3.2 |
| `scripts/hq_check.py`（7 组检查） | **拆解吸收**（见 §3.3） | 不新增检查器 |
| `scripts/sync.py` / `check_sync.py` | **删除** | khy-os 自身 git 通道已足够 |
| `AGENTS.md` / `CLAUDE.md` / `README.md` | **不迁移** | 与 khy-os 根文件同名会冲突（`check-repo-layout.js` 根文档白名单）；内容按需并入 khy-os 的 `AGENTS.md` 指针节 |

> **为什么放 `.ai/` 而不是根级 `prompts/`**：根级新增目录会被
> `scripts/ci/check-repo-layout.js` 判「未登记目录」（`LAYERS ∪ CROSSCUTTING` 之外即报错），
> 需走 `[DESIGN-LAY-005]` §1.4 的例外登记门槛；而**点目录被显式排除在层级体系外**
> （`check-repo-layout.js` 过滤 `name.startsWith('.')`）→ 放 `.ai/` 下**免登记例外**。

### 3.2 命令面（替代 HQ 的 7 个脚本）

| HQ 原命令 | 新命令 |
|---|---|
| `next.py --status` | `khy hq status` |
| `next.py` | `khy hq next` |
| `next.py --bug X --copy` | `khy hq next --bug X [--copy]` |
| `next.py --verify X` | `khy hq verify X` |
| `new_bug.py` | `khy hq bug new "标题" --severity P1 --domain cli` |
| `update_status.py bug` | `khy hq bug set <ID> <状态>` |
| `update_status.py task` | `khy hq task set <ID> <状态>` |

状态机（**非法迁移必须当场拒绝**，与 HQ 原行为一致）：

```
Bug :  open → in_progress → pending_verify → closed
        └→ wontfix ┘        └→ in_progress（验证打回）
Task:  todo → doing → review → done
                └────────┘（review 可打回 doing）
优先级：按 [PROCESS-102] 五档瀑布（G0 验收债 → G1 open Bug → G2 P0/P1 → G3 P2/P3 → G4 停问），
真源 docs/10_规范/其它规范/PROCESS-102-下一步最该做什么决策标准.md；同档并列禁止按登记顺序任取
```

### 3.3 机械检查的去处（**不新建第 62 个检查器**）

| HQ 检查 | 处置 | 理由 |
|---|---|---|
| `portability` | **删除** | HQ 自身铁律；khy-os 对应 `RUNTIME-001`，已有守卫 `check-agent-rules.js` |
| `autopull_task` | **删除** | 计划任务方案变更（§3.4） |
| `sync_readonly` | **删除** | `sync.py` 已删 |
| `merge_flow` | **删除** | 属 khy-os 侧 git 操作，走 `PROCESS-001` |
| `meta`（JSON↔MD 一致性） | **降级为命令写入路径校验** | 在 `khy hq` 写入时强制，不单独立门 |
| `prompts`（提示词质量） | **降级为 `check:agent-docs` 场景** | 提示词属 AI 指令文件，已有标准 |
| `drivability`（双入口同步） | **同上** | 同上 |

> **纪律依据**：新检查器一旦落 `scripts/ci/`，`check-wiring.js` 就要求它**必须有门引用**，
> 否则 error。HQ 这些检查大半是**自有流程的自检**，搬进 CI 属职责错配。
> **能落在命令写入路径上的约束，就不要升级成仓库级门禁。**

### 3.4 多机协作（这是刚需，不是可选项）

**HQ 的 `sync.py` 是一层多余的编排** —— 它存在的唯一理由是「HQ 与 khy-os 是两个仓库，
要协调两者的 pull/push 顺序」。**吸收后这层失去存在理由**：

| 原来（两仓） | 现在（单仓） |
|---|---|
| 先 pull HQ、再 pull khy-os | **只需 pull 一个仓库** |
| `--clean-only` 要求**两仓都干净** | 单仓判定即可 |
| 收工：`hq_check` 全绿 → commit HQ →（可选）push khy-os | 收工：`npm run check:structure` 绿 → commit → push |

**新会话协议**（六步，写入 `.ai/hq/CONTEXT.md` 与 `AGENTS.md` 指针节）：

```bash
# ⓪ 开工
git pull --ff-only                    # 只拉一个仓库
khy hq status                         # 看局面（含模型路由建议）

# ① 领取任务
khy hq next                           # 自动选最高优先级 → 渲染自包含提示词

# ② 执行（在本仓库内），③ 回填
khy hq task set T-002 done --note "..."
khy hq bug set BUG-001 pending_verify --root-cause "..." --fix "..."

# ④ 收工门禁
npm run check:structure

# ⑤ 推送
git add -A && git commit -m "..." && git push
```

> **顺带根除一个隐患**：此前 `tools/deepseek-eyes` 作为**嵌套 git link** 导致
> worktree 永久脏，进而使双机 autopull 的 `--clean-only` **永不触发**、任务闭环永不关闭
> （见 `khy-os/.gitignore` 内该段的原文记录）。**改单仓判定后，这个故障模式从结构上不可能再发生。**

**autopull 计划任务**改为单仓版：在 khy-os 仓库内
`git fetch --quiet` → 判定方向 → `--ff-only` 拉取 → 推送**已提交**内容。
**不再需要 `--clean-only` 的「两仓都干净」双条件。**

### 3.5 数据迁移与双轨期

| 步骤 | 动作 | 校验 | 状态 |
|---|---|---|---|
| 1 | `_meta/*` → `.ai/hq/`（5 个文件） | JSON 可解析；任务/Bug 计数与源一致（**23 任务 / 8 Bug**） | ✅ 已完成 |
| 2 | `prompts/**` → `.ai/hq/prompts/`（19 个） | 文件数一致；`{{XX}}` 占位符完整 | ✅ 已完成 |
| 3 | 写 `khy hq` 命令 | 状态机非法迁移被拒；`status` 输出与原 `next.py --status` 等价 | ✅ 已完成 |
| 4 | 验证双机流程跑通 | 两台机器 `khy hq status` 一致 | ⚠️ **跳过**（当时只有一台机器，见 §3.6） |
| 5 | **归档废弃 HQ**（先 `git clone --mirror`） | 镜像校验通过；本机工作副本删除 | ✅ 已完成 |

### 3.6 步骤 4 跳过与直接归档的决策记录（2026-09-17）

> **这是一次有意的风险接受，不是遗漏。**

原计划要求「两台机器 `khy hq status` 一致」才算迁移完成，用途是**在废弃旧流程之前，
先证明新流程真的能在多机环境下跑通**。当时用户只有一台机器，决定直接归档。

**跳过步骤 4 的实际风险**：单仓 + 租约流程**未经真实双机验证**。
已做的替代验证（单机内）覆盖了机制本身，但**覆盖不到机器间差异**：

| 已验证（单机） | 未验证（需真双机） |
|---|---|
| 租约领取 / 被拒 / 释放 | 两台机器时钟不同步时的租约判定 |
| `sameMachine()` 大小写不敏感 | 不同机器 `hostname` 是否真的互不相同 |
| 状态机全部非法迁移被拒 | 两台机器同时写同一 JSON 的冲突行为 |
| `autopull.js` push 目标正确解析为 `khy-mirror` | 第二台机器的远端配置是否同为 `khy-mirror` |

**因此归档采取了可逆路线**：

1. **保留 GitHub 远端** —— `github.com/luckykhy/khy-os-hq` 未删除，随时可克隆回来；
2. **打完整镜像 + bundle** —— `D:/Portable/BuildArtifacts/hq-archive-2026-09-17/`
   （57 commit 全部在，`git bundle verify` 通过，**离线也能完整恢复**）；
3. **写归档说明 `RESTORE.md`** —— 三种恢复方式（镜像 / bundle / 远端）逐条给出。

⇒ **风险被降级为「可回退」**：即使双机验证失败，也能从镜像恢复旧流程，不会卡死。

**后续若上第二台机器**：应优先补做步骤 4 的验证。若验证暴露问题，
从镜像恢复 HQ 的代价是 ~1 分钟（`git clone` 裸镜像）。

**另一处遗留提醒**：HQ 远端未删，若某台旧机器上仍挂着 `khy-hq-autopull`
计划任务，它仍可能向旧远端推送。**建议在旧机器上禁用该计划任务**。

#### 步骤 1–3 执行记录（2026-09-17）

| 交付件 | 路径 | 实测 |
|---|---|---|
| 纯逻辑叶子 | `services/backend/src/cli/hqStore.js` | 路径/JSON/状态机/租约/渲染/校验，零外部依赖 |
| 命令面 | `services/backend/src/cli/handlers/hq.js` | 10 个子命令 + `hq BUG-001` / `hq T-002` 便捷写法 |
| 测试 | `services/backend/tests/cli/hqStore.test.js` | 68 个用例全绿（与 `aliases.test.js` 合计 81） |
| 别名让位 | `services/backend/src/cli/aliases.js` | 移除 `hq → quote`；行情改用 `hangqing`/`行情`/`price`/`p` |
| 提示词单仓化 | `.ai/hq/prompts/**`（19 个） | 54 处旧 Python 脚本引用清零；占位符集合逐字一致 |
| 上下文文档 | `.ai/hq/CONTEXT.md` | §八 双仓协议 → 单仓六步协议；§九 autopull 单仓化 |
| 自动同步 | `.khyos/autopull.js` | 四纪律：只推已提交 / 不 force / 快进优先 / 永不抛 |

**数据完整性**：`.ai/hq/{BUGS,PROGRESS,MODELS}.json` + `ROADMAP.md` 与 HQ 源
`cmp` 逐字节 `SAME`。

**已知缺口（本步骤内修复）**：
* 原 `bug set --note` 写法不可用（继承自 HQ 的既存缺口：`state` 是必填位置参数，
  而状态机正确拒绝同状态自环 / 终态改写）。已补 `khy hq bug note` / `khy hq task note`，
  只写 `notes`（bug 另支持 `--root-cause` / `--fix`），不碰 `status`，故无需过状态机。
* `autopull.js` 原先硬编码 `git push origin`，但本仓 `main` 的实际上游是
  `khy-mirror/main`。已改为跟随实际上游远端（`upstreamRef()`），换机/换远端无需改脚本。

**步骤 4 前置**：`autopull.js --status` / `--no-push` / `--dry-run` 三档已复验，
`push` 目标正确解析为 `khy-mirror`。双机一致性验证需在第二台机器上执行
`git pull --ff-only && khy hq status`，比对计数与占用状态。

> ⚠️ **双轨期**：步骤 1–4 完成前，**HQ 仓库保持只读可用**（不再写入）。
> 步骤 5 建议先 mirror 归档，确认新流程跑顺 2 周后再废弃远端。

---

## 四、诚实代价

| 代价 | 量级 | 能否避免 |
|---|---|---|
| 写 `khy hq` 命令（读状态 + 渲染提示词 + 状态机） | 中（~300-500 行，可拆叶子 + 测试） | 否，这是核心 |
| 迁移 5 个数据文件 + 19 个提示词 | 低 | 否 |
| 计划任务重写（单仓 autopull） | 低 | 否 |
| **丢弃 HQ 的 57 个 commit 历史** | **不可逆** | ✅ mirror 归档可缓解 |
| **`drivability` 的「双入口必须同改」机械保障** | 中 | ✅ **已由 `DOCS-003` D9-mirror 补上**（见下） |

> **最大一处损失，已就地补上**：HQ 的 `drivability` 检查强制
> 「`CLAUDE.md` 与 `AGENTS.md` 必须同步修改」，而 khy-os 侧原本**没有等价守卫**。
> 2026-09-17 已在 `DOCS-003`（AI 指令文件标准，守卫 `scripts/ci/check-agent-docs.js`）
> 中新增 **D9-mirror** 检查族接住：
>
> | | HQ `drivability` | khy-os `D9-mirror` |
> |---|---|---|
> | 判据 | 「双入口同改」 | 「声明了孪生面，孪生面必须存在**且反向声明回来**」 |
> | 检查对象 | 硬编码 `CLAUDE.md` / `AGENTS.md` | **只查显式声明** `<!-- MIRROR: X -->` 的文件 |
> | 时机 | 提交时序（需读 git 历史） | **离线可判定的那一半**（不含时序） |
> | 判级 | — | **warning 非 error**（孪生件由生成器批量重写，有真实抖动窗口） |
>
> **能力对比是「等价」而非「超越」**：D9 **不做提交时序判定** —— 那需要读 git 历史，
> 违反本仓「确定性、可离线跑」的守卫纪律，且 rebase / 合并后判定失真（公理 A4：
> 误报比漏报更贵）。**这一半纪律按设计交给人工评审兜底**，不假装已覆盖。
>
> 配套改动（缺一即失效）：`scripts/docs/build_docs_site.js` 必须把 `<!-- MIRROR: X -->`
> **原样透传**为真 HTML 注释（其 `escapeHtml()` 原本无条件转义整行，会让标记变成可见文本
> `&lt;!-- MIRROR: X --&gt;`，机器认不出 → 每对真孪生件都会被永久误报）；并由 `pageTemplate`
> 从源 `.md` basename **派生**反向声明写进 `.html` 的 `<head>`，保证重建后声明不丢。
> 详见 `docs/10_规范/[DESIGN-DOC-002] AI 指令文件标准.md` §9。

---

## 五、验收

```bash
khy hq status                     # 局面总览可读，计数与 HQ 源一致
khy hq next                       # 渲染出非空提示词，占位符已填充
khy hq task set T-XXX doing       # 合法迁移成功
khy hq task set T-XXX done        # doing→done 应被拒（非法迁移）
khy hq verify                     # 结构自检：0 error / 0 warning
npm run check:rules               # 若有规则登记，双向可达
npm run check:structure           # 既有门禁不回归
```

### 实测结果（2026-09-17）

| 验收项 | 结果 |
|---|---|
| `khy hq status` | ✅ 23 任务 / 8 Bug / 占用状态可读 |
| `khy hq next` | ✅ 渲染非空，【工作目录】= 仓库根（非 `.ai/hq`） |
| `khy hq verify` | ✅ 5 项通过：23 任务 / 8 Bug / 13 模板 / 4 模型 / 提示词结构 |
| 状态机非法迁移 | ✅ `todo→done` 拒、`todo→doing` 过、`done→todo` 拒、`open→closed` 拒、`pending_verify→in_progress` 过、`closed→open` 拒、`wontfix→open` 过 |
| 多机租约 | ✅ A 领 T-003 成功 → B 被拒（报占用主机与租约到期）→ A 小写重领放行 → `release` 后 B 可领 |
| `verify` 负向测试 | ✅ 注入 ROADMAP 不同步 + 幽灵行 + 错 `next_id` → 3 条 error，`exitCode=1` |
| `bug new` | ✅ 分配 BUG-009；非法 severity/domain/空标题均被拒 |
| `bug note` | ✅ `notes` 追加且 `status` 不变 |
| 数据逐字节一致 | ✅ 四个文件与 HQ 源 `cmp` 均 `SAME` |

---

*创建于 2026-09-17 · 状态：**全部完成**（步骤 4 经决策跳过，风险已降级为可回退，见 §3.6）*

## 六、归档执行记录（2026-09-17）

| 项 | 结果 |
|---|---|
| HQ 归档前 HEAD | `7be9154`（`hq: T-023 KeyManager P1 实现完成 → review`） |
| commit 数 | **57**（全部已推送，无未推送提交） |
| 工作区状态 | 干净（仅 `_meta/SPLIT-PLAN.md` 未提交删除，内容存于 git 历史） |
| 数据吸收校验 | `PROGRESS.json` / `MODELS.json` 逐字节 `SAME`；`BUGS.json` 唯一差异是**新增**三个租约字段（`claimed_by`/`claimed_at`/`lease_expires`，属既定迁移），8 个 Bug ID 集合完全一致 |
| 归档产物 | `D:/Portable/BuildArtifacts/hq-archive-2026-09-17/`：`khy-os-hq.git`（裸镜像）+ `khy-os-hq-2026-09-17.bundle` + `RESTORE.md` + `SPLIT-PLAN.md` + `FILELIST.txt` + `LAST-COMMITS.txt` |
| 镜像校验 | `rev-list --count HEAD` = **57**；HEAD = `7be9154` 与源一致；`git bundle verify` = **okay**，记录完整历史 |
| 恢复演练 | 从 bundle `git clone` 成功，解出 **57** commit |
| GitHub 远端 | **保留未删**（用户选择可逆路线） |

### 归档连带修掉的两处残留

| 残留 | 问题 | 处置 |
|---|---|---|
| `scripts/sync/sync-status.js` | 硬编码自动探测 `<khy-os 父目录>/khy-os-hq`，归档后**永久指向不存在的路径** | 改为 **opt-in**：只在显式设置 `KHY_OS_HQ_DIR` 时才纳入视图（考古/对照用）。实测：默认只显示 khy-os；指向归档副本时正确显示 `khy-os-hq (archived)` |
| `.ai/hq/`（46 文件） | **既未跟踪也未 gitignore** —— 一旦干净检出，任务/Bug 状态真源全部丢失，**直接摧毁多机协作** | `git add .ai/hq/`（**45 个入库**）。`logs/activity.log` 由既有 `logs/`+`*.log` 规则忽略（瞬态日志非状态真源，正确） |

> ⚠️ `.ai/hq/` 必须入库，这是**方案自身的前提**（§二「注意区分」）：
> `.khy/`/`.khyos/`/`.khyquant/` 都被 gitignore（本机态），
> 所以 HQ 状态**只能**放 `.ai/`，放别处会导致多机不同步。
> 归档前它处于未跟踪状态 = 该前提没被满足，本次一并修正。
>
> 管辖 `.ai/**` 的规则是 **`MEMORY-003`**（指定读写入口，
> 「`.ai/` 走 `khy metadata`」），守卫 `scripts/ci/check-memory-schema.js`。
> 本次改动后该守卫 **0 error / 3 warning**，三条 warning 全部落在
> `services/backend/src/assistant/autoDream.js` 与 `memoryEngine/distiller.js`
> （既有存量，与 `.ai/hq/` 无涉 —— 实测 grep `ai/hq` 命中 **0**）。
