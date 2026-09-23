# khy-os-hq 合并入 khy-os 可行性调研与实施方案

> **调研日期**：2026-09-17 · **结论**：**不建议按「丢弃 HQ + 直接内嵌」执行**；
> 推荐**方案 C（保留 HQ 为独立仓库，在 khy-os 内只放契约与指针）**，
> 或**方案 B（先以 submodule 引入，验证 3 个月后再决定是否真正并入）**。
> 以下所有判断均基于本机实测，非推测；每条都附可复现证据。

---

## 零、一句话回答

**"可以合，但代价与收益不成比例，且有一条硬技术约束让"直接内嵌"必然踩坑。"**

HQ 不是 khy-os 的附属物，而是**指向 khy-os 的另一个仓库**：
它的 7 个脚本全部靠 **从自身位置向上推算** 来定位 khy-os
（`HQ_ROOT → PROJECTS_DIR → PORTABLE_ROOT → <PORTABLE_ROOT>/khy-os`）。
HQ 一旦被放进 khy-os **内部**，这个推算就会指向 `khy-os/khy-os`（不存在）——
**HQ 的全部脚本在一夜之间集体失效**。

---

## 一、HQ 是什么（实测盘点）

| 维度 | 实测值 |
|---|---|
| 位置 | `D:\Portable\Projects\khy-os-hq`（**与 khy-os 平级**，不在其内部） |
| 文件数 | 35 个（不含 `.git`） |
| 体积 | `_meta/` 合计 **59 KB**（`bugs.json` 21 KB / `PROGRESS.json` 17.5 KB / `CONTEXT.md` 11 KB / `ROADMAP.md` 5.8 KB / `MODELS.json` 3.6 KB） |
| 提示词 | `prompts/` 下 **19 个 `.md`**（13 类模板） |
| 脚本 | 7 个 Python（`hq_common` / `hq_check` / `next` / `new_bug` / `update_status` / `sync` / `check_sync`） |
| 独立历史 | **57 个 commit**（khy-os 是 152 个）；`git cat-file` 实测**无共享对象 → 两仓历史完全独立** |
| 远端 | `origin` = `github.com/luckykhy/khy-os-hq.git`（**私有**） |
| CI | HQ **无 `.github/`**，即**零 CI**；khy-os 的 workflow **也不引用 HQ**（已 grep 确认） |
| 活跃数据 | **23 个任务**（todo 14 / done 5 / review 3 / doing 1）、**8 个 Bug**（pending_verify 7 / in_progress 1） |

**HQ 的真实职责**（源自其 `CLAUDE.md`）：
1. **提示词库** —— 每条自包含（角色+流程+工程红线+验收+验证命令）；
2. **状态真源** —— `bugs.json` 状态机 + `PROGRESS.json` 任务状态；
3. **机械检查** —— `hq_check.py` 七组检查（portability / meta / prompts / drivability / autopull_task / sync_readonly / merge_flow）；
4. **多机同步** —— `sync.py` 双仓 git 编排 + Windows 计划任务 `khy-hq-autopull`（每 10 分钟）。

---

## 二、五条硬约束（决定方案取舍）

### C1 🔴 「路径自推算」是合并的**阻断性**约束

`scripts/hq_common.py:26-29`：

```python
SCRIPT_DIR   = os.path.dirname(os.path.abspath(__file__))
HQ_ROOT      = os.path.dirname(SCRIPT_DIR)
PROJECTS_DIR = os.path.dirname(HQ_ROOT)
PORTABLE_ROOT= os.path.dirname(PROJECTS_DIR)          # ← 关键
...
def find_khyos():
    candidates.append(os.path.join(PORTABLE_ROOT, "khy-os"))   # ← 靠这个找 khy-os
```

**现状**（实测有效）：`HQ_ROOT=D:\Portable\Projects\khy-os-hq` → `PORTABLE_ROOT=D:\Portable`
→ 找到 `D:\Portable\khy-os` ✅

**若把 HQ 放进 khy-os，例如 `khy-os/Projects/hq/`**：
`PORTABLE_ROOT` 变成 `D:\Portable\khy-os\Projects` → 去探测
`D:\Portable\khy-os\Projects\khy-os` → **不存在** ❌

**后果**：`sync.py` 只处理 HQ 自身、`next.py` 渲染的 `{{KHYOS_PATH}}` 变成
「(未找到 khy-os 目录…)」、`khy-os-hq.bat` 报错。**7 个脚本全部要改**，
且这会**同时违反 HQ 自己的第一铁律**（零盘符硬编码 → 只能改探测算法而不能写死路径）。

**唯一可行修法**：把 `find_khyos()` 改为「先向上找含 `package.json` + `pyproject.toml` 的目录」，
但这等于**重写 HQ 的路径地基**，且要重跑 `hq_check.py portability` 全量回归。

### C2 🔴 `hq_check.py` 会把整个 khy-os 当成自己的源码来扫

`iter_files()` 只跳过 `{.git, node_modules, __pycache__, logs}`，**会递归进入同级目录树**。
若 HQ 嵌套在 khy-os 内：

- 扫描量从 **35 个文件** 暴涨到 **3985 个**（`.py/.md/.json/.bat/.ps1`）；
- `check_portability` 会对 khy-os 的 **407 个含盘符引用的文件**逐一报 ERROR
  （实测：`khy.bat`、`platform/khy_platform/*.py`、`scripts/release/*.ps1` 等）；
- **`hq_check.py` 从此永远不可能全绿 → `sync.py` 的收工门禁永久卡死 → 自动同步彻底瘫痪。**

> 这条比 C1 更致命：C1 让脚本「找不到 khy-os」，C2 让门禁「必然红」。
> 两者叠加 = **双机流水线当场死亡**。

### C3 🔴 文件命名正面冲突

HQ 与 khy-os 的**根目录都有** `README.md`、`AGENTS.md`、`CLAUDE.md`（实测均存在）。
若把 HQ 内容摊平或按原样嵌到可被扫描的位置，会与 khy-os 的
`ROOT_DOC_WHITELIST`（`scripts/ci/check-repo-layout.js:124`）及其
`DESIGN-LAY-005` §1.3 根目录白名单**直接冲突**。

### C4 🟠 已有「嵌套仓库导致自动同步瘫痪」的**真实前科**

`khy-os/.gitignore:172-180` 明文记录了完全相同的故障：

> `tools/deepseek-eyes`: originally an **accidental phantom git link** (mode 160000,
> with no `.gitmodules` mapping). A nested repo **can't be checked out on clone**,
> and its local HEAD drifting made `git status` permanently dirty — which in turn
> **kept the dual-machine autopull `--clean-only` gate from ever firing
> (the direct cause of the task loop never closing)**.

**这段就是本次合并的预言**：嵌套仓库 → 工作树永远脏 → `--clean-only` 永不触发 → 流水线死锁。

### C5 🟠 「AI 指令文件」预算与角色冲突

依据已完成的 `DOCS-003`（真源 `docs/10_规范/[DESIGN-DOC-002]`）与实测：
- khy-os 的 `AGENTS.md` 当前 **42,155 字节**，走 **compat 链路**（`constants/prompts.js`
  的 `_findCompatInstructionFiles()`），`readFileSync().trim()` **无预算、不截断**，
  全文注入 `project_instructions`；
- HQ 另有自己的 `AGENTS.md` + `CLAUDE.md`，且 `hq_check.py drivability` **强制要求双入口同步**。
- **若把 HQ 的指令文件合并进 khy-os 的 `AGENTS.md`**：单文件继续膨胀（每会话全量注入，
  成本线性上升），且**两套角色定义**（「khy-os 维护指南」vs「khy-os 指挥部」）在同一文件内打架。
- **若保留两份**：`DESIGN-DOC-002` 的 `DOCS-003` 场景矩阵会面临"根目录多份指令文件"的新形态，
  需额外场景与回归锁 —— 不是不能做，但是**明确的额外工作**。

---

## 三、收益 vs 代价（诚实对账）

### 合并能拿到什么

| 收益 | 实际强度 |
|---|---|
| 少一个仓库要 pull/push | ⚠️ **弱** —— autopull 计划任务已自动化，人工只需「收工清干净」 |
| 提交时版本/任务状态原子一致 | ⚠️ **弱** —— 实际工作中两者天然分属不同节奏（HQ 状态更新频繁、khy-os 代码提交较少） |
| 提示词/状态离代码更近 | ✅ **真收益** —— 冷启动时少一次「换目录」 |
| 少一份 AGENTS/CLAUDE 维护 | ❌ **反向** —— 见 C5，合并后要处理角色冲突，不省反增 |

### 合并必须支付的代价

| 代价 | 量级 |
|---|---|
| 重写 `find_khyos()` 路径地基 + 全量回归 | **中高**（7 脚本 + `portability` 检查） |
| `hq_check.py` 加扫描边界（否则 C2 必然红） | **中**（并需新增"排除宿主仓库"的回归锁） |
| 解决 3 个根文件命名冲突 | **低** |
| 解除 `.git` 嵌套（去掉 HQ 的 `.git`，历史并入 khy-os） | **中高** —— 57 个 commit 的历史合并，且**HQ 远端私有仓库要决定废弃还是保留** |
| 双机同步逻辑重写（从"两仓编排"变成"单仓先行"） | **高** —— `sync.py` 的核心价值就是跨仓门禁，541 行里大半围绕它 |
| 首台/第二台机器的接入流程重写（`AGENTS.md` 自举节 + `prompts/meta/02-新机器接入.md`） | **中** |
| 计划任务 `khy-hq-autopull` 重新定义 | **低** |

> **关键判断**：合并的**技术代价集中在「推倒 HQ 的路径与同步地基」**，
> 而这块地基恰好是 HQ 最稳、最有价值的部分（57 commit 打磨出的双机健壮性）。
> **用高代价换低收益** —— 这就是不建议执行的根本原因。

---

## 四、三个方案

### 方案 A：完全并入（丢弃 HQ 仓库）

把 HQ 内容移入 khy-os（如 `khy-os/hq/`），删除 HQ 的 `.git`，历史并入，废弃私有远端。

- **工作量**：大（C1+C2+C3+C4+C5 全要处理）
- **风险**：**高** —— 触碰双机流水线地基，且 C2 会导致门禁长期红
- **适用**：只有当"单人单机、彻底放弃双机协作"时才合理
- **判定**：❌ **不推荐**

### 方案 B：submodule 引入（保留 HQ 仓库，khy-os 里挂一个引用）

`git submodule add <hq-url> .khyos-hq/`（或 `vendor/hq/`），HQ 仍是独立仓库。

- **收益**：khy-os 检出即含 HQ 指针；版本对应关系被 git 记录
- **风险**：🟠 **正中 C4 前科** —— 嵌套 `.git` 会让 khy-os 的 `git status` 长期显示
  submodule 脏，**同样会卡死 autopull 的 `--clean-only`**
- **额外成本**：khy-os 是全仓 `git add -A` 频繁的工作区，submodule 冲突面大
- **判定**：⚠️ **可试，但必须先验证不触发 C4**（建议先只读共存观察 2 周）

### 方案 C：契约 + 指针（**推荐**）

**HQ 保持独立仓库不动**，只在 khy-os 内建立**双向契约与指针**：

1. 在 khy-os `AGENTS.md` 的自举节补一段「**HQ 契约**」：
   - HQ 的**预期位置**（`<PORTABLE_ROOT>/Projects/khy-os-hq`，或 `KHY_OS_DIR` 式环境变量）；
   - **缺失时的降级行为**（无 HQ 则纯手工模式，khy-os 功能零影响）；
   - **接口冻结**：HQ 通过哪些命令读写 khy-os（`sync.py --push-khyos` 等）。
2. 在 khy-os 新增一条**规则**（`PROCESS-006` 或并入 `PROCESS-004` 的兄弟）：
   - 明确 **HQ ⇄ khy-os 的边界**：HQ 只存指令与状态，**khy-os 代码改动永远发生在 khy-os**；
   - 明确 **哪一侧是版本/状态真源**（避免双写漂移）。
3. 用**守卫**把契约机械固化（而非靠文档自觉）：
   - 一条检查：khy-os 内**不得**出现 `khy-os-hq` 的实体副本（防有人偷偷内嵌）；
   - 一条检查：HQ 存在时 `KHY_OS_DIR` / 相对位置可解析（防探测失效无人察觉）。
4. **可选增强**：给 HQ 增加 `khy-os` 侧的**只读视图命令**（如 `khy hq status`），
   让"在 khy-os 里就能看 HQ 下一步"，**拿走方案 A 唯一的真收益（少换目录）**。

- **工作量**：小（1 篇规范 + 1 个守卫 + 2 处指针）
- **风险**：低 —— 完全不触碰 HQ 的路径与同步地基
- **判定**：✅ **推荐**

---

## 五、推荐执行路径（若采纳方案 C）

| 步骤 | 动作 | 验收 |
|---|---|---|
| 1 | 写规范 `docs/10_规范/[DESIGN-HQ-001] 指挥部契约与边界.md`（含 HQ⇄khy-os 接口、真源分工、降级行为） | 孪生件生成，索引登记 |
| 2 | 登记规则 `PROCESS-006`（HQ 边界）到 `RULES-REGISTRY.json` | `check:rules` 绿 |
| 3 | 写守卫 `scripts/ci/check-hq-contract.js`（防内嵌 + 探测可用性） | `check:wiring` 绿，`pr-gate.yml` 有引用 |
| 4 | khy-os `AGENTS.md` 自举节补 HQ 契约指针 | `check:agent-docs` 0 error |
| 5 | **可选**：`khy hq status` 只读视图 | 真收益落地 |

> **本次只交付调研与方案。** 任何写入动作（规范/规则/守卫）须你点头后再执行，
> 且按 `SOURCING-006`「一次提交只做一步」分批。

---

## 六、需要你决策的三点

1. **是否仍坚持"丢弃 HQ"**？
   实测表明收益弱、代价高，且 C4 有真实前科。若你只是想「少维护一个仓库」，
   方案 C 的只读视图能拿到同样的体感收益，风险低一个数量级。
2. **双机协作还要不要**？
   这是**唯一**能正当化方案 A 的前提。若只剩一台机器在跑，
   `sync.py` 的 541 行跨仓门禁就失去了存在理由，方案 A 的代价会大幅下降。
3. **HQ 的 57 个 commit 历史要不要留**？
   方案 A 必须回答（并入 / 归档 / 丢弃）；方案 C 则**无需回答**（历史原地保留）。

---

## 附：复现命令（供你自行验证结论）

```bash
# C1 路径自推算（读 hq_common.py 的 26-29 行与 find_khyos）
sed -n '26,29p;77,91p' /d/Portable/Projects/khy-os-hq/scripts/hq_common.py

# C2 扫描边界（只跳 4 个目录）
sed -n '26,27p;51,58p' /d/Portable/Projects/khy-os-hq/scripts/hq_check.py

# C3 根文件冲突
ls /d/Portable/Projects/khy-os-hq/*.md; ls /d/Portable/khy-os/{README,AGENTS,CLAUDE}.md

# C4 嵌套仓库前科
sed -n '172,180p' /d/Portable/khy-os/.gitignore

# 历史独立性
git -C /d/Portable/Projects/khy-os-hq rev-list --count HEAD   # 57
git -C /d/Portable/khy-os rev-list --count HEAD               # 152
```
