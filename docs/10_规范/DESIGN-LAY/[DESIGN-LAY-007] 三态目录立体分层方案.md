<!-- 文档分类: DESIGN-LAY-007 | 阶段: 设计 | 原路径: 新建 -->
# [DESIGN-LAY-007] 三态目录立体分层方案

<!-- RULES-REGISTRY: LAYOUT-007 -->

> **设计方案 · 全仓「立体感」的单一真源** · 回答三个问题：①一样东西属于**代码态 / 文档态 / 数据态**哪一态；②它在该态的第几层、那一层放**一族**还是**一个**；③找它要下几层、超预算时按哪根轴劈开。
>
> **定位**：本仓已有四篇「放哪」的规范，但**没有一篇**管「层级够不够深、找东西要下几层」。本篇补的就是这一维——它不重排板块归属，而是把三态各自**压平的那一层**立起来。
>
> **触发**：用户 2026-09-18 目标——「khyos 的目录太扁平，缺乏一种空间立体感（方便查找、层级分明）」，并明确选择「三态统一一套分层方案」。
>
> **守卫**：`scripts/ci/check-data-layout.js`（`npm run check:data-layout`，S1 观察者档，恒 exit 0）+ `docs/10_规范/registry/DATA-LOCATIONS.json`。代码态一侧继续由 `[DESIGN-LAY-005]` 的 `check:layout` 与 `[DESIGN-LAY-006]` 的 `check:discoverability` 把门。
>
> **谁该读**：任何要新增顶层目录、新增 `.khy/` 数据落点、或抱怨「找不到东西」的人与 AI。

---

## §0 现状实测（2026-09-18，全部数字可复算）

「扁平」不是审美判断，是可量的：**一个目录的直接条目数**与**定位一次所需下钻的层数**。

| 目标 | 直接条目 | 深度区间 | 复算命令 |
| --- | --- | --- | --- |
| 仓库顶层 | **71**（18 目录 + 53 文件，含点文件；`ls` 口径为 45） | — | `npm run check:data-layout` |
| `.khy/` 运行态数据 | **211**（77 目录 + 134 文件，含隐藏） | **1–5** | 同上 |
| `.khyos/` 底座数据 | **29** | **1–13** ⚠ 过深 | 同上 |
| `docs/` 文档态 | 12 个编号分区 / 1075 | 见 LAY-006 §3.0 | `npm run check:discoverability` |

> ⚠ **「扁平」不是一刀切的病**：同一把尺下，`.khy/` 是「太宽」（211 项铺一层，深度下界=1），`.khyos/` 却同时「太深」（最深 13 段，越过 LAY-006 §2.1 的 ≤6 上界）。所以本方案的双侧约束是 [2, 5]（§1.3），**只做拆分而不设深度上界会把另一头压坏**。

`[DESIGN-LAY-006]` §3.0 早已测出「全仓 3429 个目录，17 个直接条目 > 80」，但**上面这三处一个都不在其规则表里**——因为 LAY-006 §3.0.1 豁免「一切点目录」，而三处根目录本身不是点目录、其**内容**却因数据目录整体豁免而无门可管。这是本篇存在的理由。

**三态各自的病不是同一种病**：

| 态 | 病 | 证据 |
| --- | --- | --- |
| 代码态 | 顶层混入运行残留 | `node_modules/`、`khy_os.egg-info/` 与 `kernel/` 平级；根有 `nul` 垃圾文件 |
| 文档态 | 有广度无深度 | `docs/00_INDEX_*` 是**文件不是目录**；最大分区 500 项只劈成 1 层（`03_DESIGN_设计/10_系统架构`） |
| 数据态 | 三种态挤一个平面 | `.khy/` 同层并存：权威配置（`settings.json`，75 文件引用）、可再生缓存、日志、SQLite 权威库、以及 **66 个下划线诊断转储 + 19 个零引用孤儿**；另有 4 个畸形目录 `ai_gateway_*.json`（目录名带 `.json`，系 `getDataDir()` 误用，登记于 `[OPS-MAN-176]` §7） |

数据态的引用面实测（`node .khy/tmp/ref-scan.js`，扫 3583 个源文件）：`settings.json` 144 处引用、`mcp.json` 47、`security.log` 35、`audit.jsonl` 13、`sessions.db` 15、`api_keys.json` 13；66 个 `_*.txt` 转储**零引用**。**结论：能压平的只有代码引用面收敛到一处的那部分——见 §5 的 `dataHome` 单点收敛。**

**两个「绕表」口径不要混用**（执行器与人工统计各测一件事）：

| 口径 | 数值 | 含义 |
| --- | --- | --- |
| L-3 字面拼接 | **203 / 3070** 源文件 | 在非 `dataHome.js` 处出现 `'.khy'`/`'.khyos'`/`'.khyquant'` 段字面量（含合法的 env 回退与注释，故为**上界**） |
| 完全不 import `dataHome` | **52** 文件 | 从未引用中心解析器，迁移时**必然**要改（这才是硬下界） |

下界 52 是工作量，上界 203 是噪声面；§8 的收敛判据按**下界**判，避免把注释也算成待迁项。

---

## §1 核心模型：三态 × 五轴

### 1.1 三态（顶层一次劈开，对应「分区」）

| 态 | 唯一根 | 该态的「立体」含义 | 真源规范 |
| --- | --- | --- | --- |
| **代码态** | 仓库根 L0–L6 七层 | 依赖方向决定深度 | `[DESIGN-LAY-005]` |
| **文档态** | `docs/` | 编号轴 × 主题轴正交，每页 ≤80 行 | `[MGMT-STD-001]` |
| **数据态** | `.khy/` + `.khyos/` + 仓库根运行残留 | 生命周期分档决定深度，**T档 × 领域轴** 二维 | 本篇 |

三态各只有一个根，**根之下才是空间**。本篇新增的唯一顶层概念是数据态的第 0 层：

```
<repo>/
  ├─ .khy/            ← 数据态·应用层（T0–T3 五档，见 §2.1）
  ├─ .khyos/          ← 数据态·底座层（与 .khy 禁止互写）
  └─ .state/          ← 新增·代码态的运行残留根（吸收根上的 nul 与一切进程副产物）
```

### 1.2 五根寻址轴（任何一次劈分只能用其中一根）

层级分明的本质是：**每一层只回答一个问题**，且这一层所有兄弟回答的是同一个问题。兄弟不同族即视为未分。

| 轴 | 该层回答的问题 | 允许作用在哪一层 |
| --- | --- | --- |
| **A 态** | 这是代码 / 文档 / 数据？ | L0（仓库根） |
| **B 生命周期** | 删了能再生吗？多久烂掉？ | 数据态 L1（T0–T3） |
| **C 归属** | 这是哪一层/哪个包/哪个分区的？ | 代码态 L1–L2、文档态 L2 |
| **D 领域** | 这是哪个业务族的？ | 数据态 L2（8 领域）、代码态 L3+、文档态 L3 |
| **E 时间/分片** | 哪一天？哪一片？ | **只允许叶子层**，且必须带稳定前缀 |

**轴序固定为 A→B→C→D→E，禁止乱序**（如数据态先按日期再按生命周期 = 同一族的记录被日期撕散）。

### 1.3 「立体感」的可测定义

1. **广度预算**：任一目录的直接条目 ≤ 其预算（§3）。
2. **定位深度**：从该态的根到任一**权威**条目，路径段数 ∈ **[2, 5]**。
   - `< 2` ⇒ 该态仍是平面（现状 `.khy/` = 1）。
   - `> 5` ⇒ 违反 LAY-006 §2.1 的「目录深度 ≤ 6」，人眼放弃下钻。
   - 现状反例（过深）：`docs/03_DESIGN_设计/DESIGN-ARCH/[DESIGN-ARCH-125] …卡片…登记.md` = 5 段，已顶格；再往里塞子目录即越界。
3. **兄弟同族**：同一目录内条目必须属于同一家族。
   - 现状反例：`docs/10_规范/DESIGN-LAY/` 内 6 篇规范 md 与 5 个探针 `.js` 同层——**文档目录里放可执行探针**，两族混居。`.js` 归本篇 T4/代码态（见 §4）。

---

## §2 数据态立体结构（本篇主体）

### 2.1 生命周期五档（B 轴，数据态 L1）

| 档 | 目录 | 语义 | 预算 | 允许递归删除 | 备份档 |
| --- | --- | --- | --- | --- | --- |
| **T0 权威** | `T0-authoritative/config/`、`T0-authoritative/state/` | 删了就丢、无法再生（`settings.json`、`mcp.json`、`api_keys.json`、`taskboard.db`、`sessions.db`、`taste`） | 50 | **否** | home-user |
| **T1 领域** | `T1-domains/<领域>/` | 业务数据，8 个领域（§2.2） | 每领域 20 | 仅按各自保留策略 | home-app |
| **T2 可再生** | `T2-regenerable/` | 删了能重建（`cache/`、`learn-cache/`、`break-cache/`、`sessions/` 的 FTS 索引、`hw_probe_cache.json`） | 50 | **是** | 不备份 |
| **T3 留痕** | `T3-archives/` | 只追加、只轮转、永不裁剪（`audit-trajectory/` 契约） | 50 | **否，且禁止压缩** | home-project |
| **T4 瞬态** | `T4-transient/`、`T4-transient/scratch/` | 进程副产物、一次性诊断转储 | 50 | 是，可随时清空 | 不备份 |

> ⚠ **只建 B 轴不建 D 轴 = 伪立体**：把 211 项一股脑塞进 5 个桶，桶内立刻重新变平（最满的桶会到 100+）。因此 **T1 必须同时铺 §2.2 的领域轴**，其余各档条目逼近 50 时同样按 D 轴劈。

### 2.2 领域八族（D 轴，`.khy/T1-domains/` L2）

| 领域 | 收什么（现状目录归位） |
| --- | --- |
| `sessions/` | `conversations/`、`session/`、`turn_checkpoints/`、`checkpoints/` |
| `memory/` | `memory/`、`cognitive_snapshots/`、`taste` |
| `ai/` | `gateway/`、`ai-uploads/`、`models/`、`training/`、`learn-cache/` |
| `agents/` | `agents/`、`agent-workspaces/`、`orchestrator/`、`buddy/`、`arena/` |
| `tools/` | `tools/`、`skills/`、`plugins/`、`generated_tools/`、`worktrees/`、`bin/` |
| `desktop/` | `desktopControl/`、`computerUse/`、`browser/`、`gui-eval/`、`clipboard-img2file/` |
| `telemetry/` | `telemetry/`、`reports/`、`events/`、`receipts/`、`ruleguard/`、`feedback/` |
| `secrets/` | `credentials/`（保持 `0700`/`600` 语义不变，只换父路径） |

未列出的现状目录由执行器 `--report` 输出逐个归位；**归不了族的一律落 `T1-domains/_unsorted/`，并只允许存在到本篇 §7 的 S2 毕业前**（棘轮：`_unsorted` 条目数只降不升）。

### 2.3 底座与应用不互穿

`.khyos/`（`getBaseHome()`）同样铺 B 轴五档，但**领域轴不共享**：底座只有 `goalStore`、`vaultStore`、`tasteService`、`growthDataDir`、`toolCapabilityStore`、`learning*`、`organize.py` 七个写入方，实测 29 项，分 `T0-authoritative/`(5)、`T1-domains/goal|vault|growth|capability/`(4)、`T2-regenerable/`(2)、`T4-transient/tmp/`(18)。

**红线（沿用 `dataHome.js` §生态标准）**：`.khy/` 与 `.khyos/` 之间禁止直读直写，跨域必须走服务接口。本篇不放宽，只是让这条线在**目录名上可见**。

### 2.4 `.khyos/housekeeping/` —— 机制已验证可用，数据侧未接入（G-1）

`[DESIGN-LAY-003]` LAYOUT-004 规定隔离区根为 `.khyos/housekeeping/<日期>/`，且**必须留 manifest 才能原路撤回**。实测复核（2026-09-18）：该根**已存在**，含 `2026-09-17/`、`2026-09-17-doc-plan/`、`2026-09-18/`、`2026-09-18-b10/` 四个批次与 `manifests/`，且**处于 git 跟踪之下**——这正是撤回能力成立的前提。所以缺口**不是**「回收站不存在」，而是**「数据侧从未接入」**：`.khy/` 的 211 项里没有一项进过回收站，66 个诊断转储与 19 个零引用孤儿因此只能继续在 `.khy/` 根上充平面。

本篇不新建第二套回收站，而是**把数据侧接上这条已验证可用的线**：`check-data-layout.js` 在 S2 起把 §0 实测清单里的可再生项搬入 `housekeeping/<日期>/<原相对路径>`，并写 `manifest.jsonl`（原路径、新路径、sha256、时间、任务号）。**接入时的硬约束**：被搬项与 manifest 必须落在 git 跟踪区（`.khyos/housekeeping/`），**不得**落进被整目录排除的 `.khy/` 内，否则撤回能力随跟踪状态静默消失（详见 §6.11）。**首次必须先 dry-run 出清单，人工过目后才执行。**

### 2.5 平面元数据（数据态根的「楼层索引」）

数据态根**只允许 1 个条目**：`00_INDEX_data.md`（由执行器生成，不手写），列出五档 × 八族各自的条目数、最近访问时间、备份档与一句话语义。定位成本从「ls 211 项人眼扫」降到「读 1 个索引 + 下 2 层」。

---

## §3 预算表（取代 LAY-006 §3.0，本表三态统一）

| 层类别 | 目录 | 预算（直接条目） | 超了怎么办 | 守卫 |
| --- | --- | --- | --- | --- |
| 仓库顶层 | `/` | **20**（可寻址项；现 69，另有 2 个已登记安装产物不计数） | 按 A 轴归入三态根；运行残留入 `.state/` | `check:layout` 根白名单 + `check:data-layout` |
| 代码层内 | `kernel/ platform/ services/ apps/ software/ extensions/ tools/` | 40 | 按 D 轴（域）或 LAY-006 前缀家族拆 | `check:discoverability` |
| 文档分区 | `docs/<NN_NAME>/` | 50 | **只能加目录层**，不许改文件名（§6） | `check:discoverability` |
| 文档叶子夹 | `docs/<分区>/<主题>/` | 20 | 再劈一层主题 | 同上 |
| 数据档 | `.khy/T*/`、`.khyos/T*/` | 50 | 按 D 轴劈八族 | `check:data-layout` |
| 数据族 | `.khy/T1-domains/<领域>/` | 20 | 按 E 轴（日期）劈，前缀须稳定 | 同上 |
| 索引 | 任何目录 | 最多 1 个 `00_INDEX_*` | 多于 1 个即报错 | 本篇 |

**计数口径沿用 LAY-006 §3.0.1**：点目录与 `node_modules/`/`vendor/` 不计入——**但 `node_modules/` 在仓库顶层那一层必须计入**，否则「20 项预算」永远被它一项吃掉却无人处理（§4 处理办法见 G-2）。

---

## §4 三态落地细则（增量，不改既有真源）

### 4.1 代码态：只清混居，不动板块归属

顶层 7 个板块（L0–L6）由 LAY-005 定死，本篇**一律不碰**。本篇只做三件减法：

- **G-2 运行残留出根**：`nul`（Windows 重定向误建的空文件）入 `.state/`；`khy_os.egg-info/` 与 `node_modules/` 属安装产物，纳入 `[DESIGN-LAY-004]` 的 `BUILD-OUTPUTS.json` 登记并由 `entries/<producer>/` 承接，而非长期占顶层目录位。
- **G-3 探针出文档目录**：`docs/10_规范/DESIGN-LAY/` 内 5 个 `.js`（`layout-probe.js`、`family-probe.js`、`move-cost.js`、`build-root-demo.js`、`discoverability` 原型）迁 `scripts/ci/`，按 LAY-006 §4 留 re-export 壳后清壳（实测：壳计入预算，迁移 + 留壳 = 父目录 +1，见 LAY-006 §1.3.1）。
- **顶层文件按 A 轴分组**：根 28 文件中，打包清单（`pyproject.toml`、`MANIFEST.in`、`.npmrc`、`.dockerignore`、`.gitignore`、`.gitattributes`、`.editorconfig`、`.portable`）与入口（`khy.sh`、`khy.bat`、`khy-cli.bat`、`install-khy.ps1`）与智能体规则（`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`SECURITY.md`、`CHANGELOG.md`、`README.md`、`.clinerules`、`.windsurfrules`）分三族；**工具按名读取的文件不许动**（`package.json`、`pyproject.toml`、`AGENTS.md`、`CLAUDE.md`、`.gitignore`、`Dockerfile`、`docker-compose.yml`、`fly.staging.toml`、`.env*`）——这是 LAY-006 §6.1「改它们等于改工具契约」的直接适用。它们的立体感靠 `00_INDEX` 提供，不靠搬家。

### 4.2 文档态：加一层「分区目录」，改一个字都不用

`docs/NN_NAME/` 预算 50（现 12 分区，最大 500）。做法：在 176 个**有 ≥2 篇同主题存量**的前缀家族上建 `<分区>/<主题>/` 目录，整族一次移动，**文件名与编号零改动**。`00_INDEX_*` 继续作为**文件**存在，只是内容变为指向子目录。

### 4.3 数据态：见 §2。

---

## §5 过渡期兼容（本篇最硬的约束）

**禁止一次性移动。** 三态的条目定位方分别是 3583 个源文件（含 256 处 `.khy` 字面量、52 个文件完全不 import `dataHome`）、`docs:verify` 编号检查、以及 110 个数据子目录名。因此：

1. **移动即建链接**：老路径留 junction/symlink 指向新路径。Windows 无符号链接权限时用 junction（`mklink /J`），POSIX 用 symlink。链接在 §7 S4 毕业前不得回收。
2. **代码引用改向单点**：一切路径拼接必须经 `utils/dataHome.js` 的 13 个导出（`getDataDir` / `getBaseDataDir` / `getAppDataDir` / `getProjectDataDir` / …）。**先补档、再改档**：在 `dataHome.js` 引入 §5.1 的 `DATA_PATHS` 常量表，`getDataDir(sub)` 一律改为查表。
3. **`dataHome` 不识别新结构时绝不报错**：查不到映射即回退老路径并记 `[data-layout-fallback]`，防迁移半成品导致数据分裂。
4. **那 52 个不 import `dataHome` 的文件是 S1 阶段的主要观测对象**：执行器每次运行报告「绕表直拼 `.khy/...`」的命中数，作为 §7 S2→S3 的样本来源。
5. **递归删除只准走一个咽喉**：`utils/ephemeralTmp.js`。新结构里 T0/T3 档一律拒绝递归删除（实测当前递归删除只散在 `ephemeralTmp.js` 与 6 个 agent adapter，收敛面很小，这是本方案可落地的前提）。

---

## §6 红线与不变量（永不可违反）

1. **git 已跟踪文件不因本方案被删除**（LAY-004）；移动必须是整族一次。
2. **文档编号不透明且永久**：`DESIGN-ARCH-071` 永远叫 071。**禁止按目录树深度重编号**——那会让近 200 份设计文档的所有交叉引用同时失效。深度只体现在路径上。
3. **工具契约文件不可移动**：`AGENTS.md`、`CLAUDE.md`、`CONTRIBUTING.md`、`.github/**`、`.claude/**`、`.env*`、`.gitignore`、`package.json`、`pyproject.toml`、`Dockerfile`、`docker-compose.yml`。
4. **审计通道不压缩不裁剪**：`.khy/audit-trajectory/` 是外部质检通道的契约（`cleanupService.js` 头注明确排除本服务治理），故归 **T3 留痕档**，永久禁止递归删除与 gzip。
5. **凭据权限位不变**：`credentials/`、`api_keys.json` 迁移前后必须保持 `0700`/`0600`；迁移脚本须显式重设（Windows 走 ACL，POSIX 走 chmod），否则移动即降级安全。
6. **`sessions.db` 可再生、`taskboard.db` 不可再生**：前者是 FTS5 派生索引（移动 = 纯文件移动 + reindex），后者无 JSON 源（权威）。两者**不同档**，禁止在备份脚本里同等对待（`[OPS-MAN-176]` 的 home-user/home-app 分档）。
7. **`.khy/` ↔ `.khyos/` 不互写**（`dataHome.js` 生态标准）。
8. **SQLite 的 `-wal`/`-shm` 与主库必须同父目录**：移动库必须整组同移，且移动前必须走 checkpoint，否则 WAL 落在老路径导致静默丢数据。
9. **版本同步轨道不受影响**：本方案不触碰 `pyproject.toml` / 三个 `package.json` 的版本字段（红线 R3 / `PROCESS-002`）。
10. **不引入新的无门规则**：本篇若缺 §7 的执行器，就只是一篇散文。规则 ID `LAYOUT-007` 必须与 `check-data-layout.js` 双向可达（`check:rules`）。
11. **`.khy/` 没有 git 兜底**：实测 `git ls-files .khy` = **0**（`.gitignore:54` 整目录排除），故 §5 的一切 `.khy/` 搬移**不能用 `git mv` / `git checkout` 当回滚手段**——`manifest.jsonl` 的 sha256 是唯一回滚路径。推论（可执行要求）：**manifest 与被搬项必须落在 git 跟踪区**。实测对照：`.khyos/housekeeping/**` 是**已跟踪**的（`.gitignore` 未排除 `.khyos/`），这就是 LAY-004 的撤回能力成立的前提；若把回收站放进 `.khy/` 下，撤回能力会随跟踪状态一起静默消失。**没有 manifest 就不许搬**，dry-run 不产生任何文件移动。
12. **新增根必须同时进分发排除清单**：本篇新增的 `.state/`（以及任何新数据根）若不同时加入 `npm pack` / 便携包的排除，就正好复现 `check-runtime-placement.js` 防的那类事故——`.khy`/`.db` 随 tarball 发出去，泄露用户数据与密钥。守卫顺序：先改排除清单与 `.dockerignore`/`MANIFEST.in`，再建目录。

---

## §7 守卫与落地阶段

### 7.1 登记表 `docs/10_规范/registry/DATA-LOCATIONS.json`

一切「数据落在哪」的**单一真源**：每个逻辑条目一项，字段 `{ id, home(khy|khyos|state), tier, domain, name, kind(file|dir), regenerable, backup(home-user|home-app|home-project|none), delete(recursive|rotate|append-only|never), note }`。

派生关系：§2 五档八族的**目录表**、`dataHome.js` 的 `DATA_PATHS` 查表、执行器的预算常量、`.gitignore` 的数据段——全部从该表生成，**禁止手写第二份**（沿用 LAY-004 的「登记表派生」原则）。

### 7.2 执行器 `scripts/ci/check-data-layout.js`（三条检查）

| 检查 | 判级（S3 后） |
| --- | --- |
| L-1 档位归属：任何 `T*` 子目录名必须出现在登记表，未登记即报错 | error |
| L-2 预算：§3 的「数据档 50 / 数据族 20」，超了**只允许拆、不允许豁免** | error |
| L-3 绕表直拼：非 `dataHome.js` 文件里出现 `.khy` / `.khyos` 段字面量拼接 | warning（P2 棘轮，`scripts/ci/data-layout-baseline.json` 只降不升） |

### 7.3 四阶段（`PROCESS-008`，登记于 `FEATURE-OWNERSHIP.json`）

| 阶段 | 行为 | 毕业条件（样本量，非时间） |
| --- | --- | --- |
| **S1 观察者** | 只出报告：三态预算实测、未登记项、绕表直拼命中、`_unsorted` 计数。**恒 exit 0** | ≥200 次运行且无解释不了的样本 |
| **S2 顾问** | 加提示 + dry-run 移动清单 + 写 `housekeeping/` manifest（不搬权威档） | ≥50 条提示，误报 <10% |
| **S3 门禁** | 阻断新数据落点未登记 / 超预算；旧路径 junction 由执行器建立 | ≥20 次真实拦截，豁免 <20% |
| **S4 主动收敛** | 回收 junction、删壳、按棘轮清 T4 与 `housekeeping/` | 需独立回滚验证后单独评审 |

**每阶段的回退动作（PP-4）**：S1→停进程；S2→删 `housekeeping/` 并按 manifest 原路撤回；S3→`git revert` 登记表条目 + 删链接（老路径仍在）；S4→按 manifest 恢复。

> **本守卫自身也走观察期**（PP-1）：`GUARD_STAGE='S1'`、`severity=advisory`，恒 exit 0。登记表 `stage` 与执行器常量必须一致，漂移报 `rollout-stage-authority-drift`。

---

## §8 完成定义（本方案的成功判据，全部可机判）

1. 三态根的直接条目 ≤ §3 预算：`/` ≤20、`.khy/T*` ≤50、`.khyos/T*` ≤50。
2. 任一权威数据条目的定位深度 ∈ [2, 5]。
3. 三态根各有 1 个 `00_INDEX`，且索引条目数与文件系统实测逐条相等（防文档漂移，仿 LAY-006 §7）。
4. `_unsorted` 与 `housekeeping/` 的条目数连续两个版本下降（棘轮）。
5. 绕表直拼命中数 ≤ 基线的 50%（`dataHome` 收敛验证）。
6. `npm run check:layout`、`check:discoverability`、`check:build-root`、`check:rules`、`docs:verify` 全绿，且 `node_modules`/egg-info 不再占顶层目录位。
7. 全过程零数据丢失：每个被搬条目在 manifest 里有可验证的 sha256 回退项。

---

## §9 明确不做（不做清单）

- 不重排 L0–L6 七板块，不改任何 `require` 方向的允许规则（LAY-005 辖区）。
- 不按目录深度重编号文档（§6.2）。
- 不动任何工具契约文件名与位置（§6.3）。
- 不新建第二套回收站、不新建第二套路径解析器、不给 `.khy` 另起新名。
- 不在 S1 阶段做任何移动，不承诺「一次做完」（§7.3）。
- 不触碰凭据内容与权限语义，不缩减任何保留策略。

---

## §10 裁决记录（2026-09-19，用户对本篇 §10 原四问全部按建议拍板）

四问已由维护者裁决，**均采纳建议方案**。本表同时是「裁决 → 落地点」的映射，任一落地缺失即为文档漂移。

| # | 裁决 | 后果 | 落地点（三处对齐） |
| --- | --- | --- | --- |
| **Q1** | 领域轴取 **8 族**（`sessions/memory/ai/agents/tools/desktop/telemetry/secrets`），`_unsorted` 不计入族数 | T1 预算 = 8 族 × 每族 20；`_unsorted` 只允许存在到 S2 毕业前，条目数走棘轮 | 本篇 §2.2 / `DATA-LOCATIONS.json` → `tiers[T1-domains].children`（8 族 + `_unsorted`）/ 执行器 L-2 `perChildBudget=20` |
| **Q2** | 安装产物**纳入登记但不搬**（搬 `node_modules/` 会破坏 npm 解析） | 顶层 20 项预算改为「**可寻址项 ≤20**」：安装产物登记为 `installArtifact` 并显式豁免计数，但必须在报告中单列可见，不得静默隐藏 | 本篇 §3 与 §4.1 G-2 / `DATA-LOCATIONS.json` → `topLevel.installArtifacts` / 执行器 `scanRepoRoot` 的 `installArtifacts` 字段与 `maxAddressable` |
| **Q3** | 两库**按可再生性分档**：`sessions.db` → T2（FTS5 派生索引，可 reindex 重建）、`taskboard.db` → T0-authoritative/state（无 JSON 源，权威） | 备份脚本区别对待：T2 不备份、T0 走 home-user；SQLite 的 `-wal`/`-shm` 随主库同档（§6.8） | 本篇 §2.1 与 §6.6 / `DATA-LOCATIONS.json` → `seedEntries`（两库各自的 `tier`/`backup`/`regenerable`）/ 执行器 L-1 按登记表判定档位 |
| **Q4** | `T0-`–`T4-` 数字前缀与 `[XXX-YYY-NNN]` 形似，**确认会被误读为可解析 ID** | 执行器与生成的索引必须显式声明「**档位数字前缀不是规则/文档 ID，不可解析引用、不参与编号校验**」；跨文引用一律写档名全称 `T0-authoritative` 而非 `T0` | 本篇 §2.1 与本节 / `DATA-LOCATIONS.json` → `tierPrefixIsNotId: true` / 执行器输出与 `--index` 生成的索引页脚 |

**未变的量**：裁决不放宽任何红线。§6 的 12 条不变量全部保持，其中 Q2 的「不搬」是**尊重** §6.3 工具契约红线（npm 按名解析）而非新增豁免；Q3 的分档是**落实** `[OPS-MAN-176]` 既有的 home-user/home-app 二档，不是另造一套。

> 本节原有两条口径提醒一并保留：仓库顶层直接条目按执行器口径为 **71**（含点文件），`ls` 口径为 45——预算判定一律以执行器输出为准，不手工数。
