<!-- 文档分类: OPS-MAN-176 | 阶段: 运维 | 原路径: 新建（备份恢复子系统落地） -->
# 数据备份与恢复

> `khy backup` 是 Khy-OS 的统一数据备份/恢复入口。本文讲清四件事：**备份集里有什么、没有什么、为什么**；**怎么恢复、恢复前会挡你什么**；**保留策略的确切语义**；以及 **SQLite 为什么绝不允许直接复制 `.db` 文件**。
>
> 实现依据（每条结论都可回到代码）：
> - 资产规则单一真源（纯叶子，零 IO）：`services/backend/src/services/backup/backupAssetPlan.js`
> - SQLite 热备唯一出口：`services/backend/src/services/backup/sqliteHotCopy.js`
> - 清单格式与保留策略：`services/backend/src/services/backup/backupManifest.js`
> - 备份/恢复执行：`services/backend/src/services/backup/backupService.js`、`restoreService.js`
> - 默认值与阈值（F5：不许散落硬编码）：`services/backend/src/constants/serviceDefaults.js` 的 `BACKUP`
> - CLI 层：`services/backend/src/cli/handlers/backup.js`
> - 演练测试：`services/backend/tests/backupRestoreDrill.test.js`（备份 → 破坏 → 恢复 → 校验）

---

## 一、五分钟上手

```bash
khy backup                    # 创建备份（core 级，默认子命令）
khy backup list               # 列出所有备份
khy backup status             # 概览：备份根、数据家目录、待热备的库、最近一份的年龄
khy backup verify             # 校验最近一份（逐项比对字节数与 sha256）
khy backup restore --dry-run  # 预演恢复：只检查，不改任何文件
khy daemon stop               # 恢复前必须先停守护进程
khy backup restore            # 真正恢复最近一份
khy backup prune              # 按保留策略清理
```

中文直达（`cli/aliases.js`）：`khy 备份` / `数据备份`、`备份列表`、`备份状态`、`备份检查` / `校验备份`、`恢复数据` / `数据恢复` / `还原数据`、`清理备份` / `备份清理`。

**⚠️ `khy restore` 不是数据恢复。** 顶层 `khy restore` / `khy restore-source`（中文 `还原` / `完整还原` / `还原项目`）恢复的是**加密源码包**，归 `cli/handlers/publish.js`，早于本子系统存在。数据恢复只有一条路：`khy backup restore`。这个命名不是偏好，是既有命令占位的结果。

---

## 二、备份集长什么样

备份根默认 `<数据家目录>/backups`（`KHY_BACKUP_ROOT` 或 `--root` 可覆盖）。每份备份是一个目录，目录名即 id：

```
<备份根>/20260816T081500Z-a1b2c3/     ← id = UTC 时间戳 + 6 位随机后缀
├── manifest.json                    ← 清单：每一项的来源、目标、字节数、sha256
├── .complete                        ← 完成标记。没有它 = 写到一半，恢复时直接拒绝
├── db/
│   ├── user-khy-quant.db            ← VACUUM INTO 产出的一致性快照（前缀 = 家目录角色）
│   ├── project-taskboard.db
│   └── postgres.dump                ← 仅 DB_MODE=postgres 时存在（pg_dump 产物）
├── home-user/                       ← ~/.khy 下收录的 JSON/JSONL 状态文件，保持原相对路径
├── home-project/                    ← <appRoot>/.khy
└── home-app/                        ← 传统 ~/.khyquant（仅当它确实已建立）
```

**id 里的时间戳是权威的**。保留策略按 id 解析出的创建时刻算天数，**不看文件 mtime** —— 拷贝/搬迁会改 mtime，而 id 里的时间是「这份备份被创建」的事实（`backupManifest.parseBackupId`）。副作用之一：id 的字典序 = 时间序，`ls` 出来就是有序的。

**目录权限 0700、文件 0600**（`BACKUP.DIR_MODE` / `FILE_MODE`）。备份集包含 `khy-quant.db` 的 `api_keys` / `auth_sessions` 表和各消息通道的 token；按表裁剪会破坏引用完整性，所以**不裁**，改用文件权限兜底，并在 `manifest.containsSecrets` 里显式标记。**不要把备份集放进版本库或公共存储。**

---

## 三、备份什么、不备份什么

判定标准只有一条：**「状态」= 权威且不可重建，丢了要人重配或永久损失；「缓存/派生物」= 能由状态或环境重新算出来。只备份状态。**

### 3.1 三条最关键的判定

| 资产 | 备不备 | 为什么 |
|---|---|---|
| `khyquant/data/khy-quant.db`（Sequelize 主库，41 张表） | **备** | 用户/交易/策略/回测/密钥，权威状态。只能走热备原语。 |
| `taskboard.db` | **备** | `coordinator/taskBoard.js` 头部记载它已从 JSON 迁到 SQLite，**没有 JSON 源可回放**，是权威状态。 |
| `sessions.db`（含 `-wal`/`-shm`） | **不备** | 它只是会话 JSON 的 FTS5 **搜索索引副本**，`sessionSearchIndex.reindexAll()` 能从 `sessionPersistence` 的会话 JSON 全量重建。现场实测 `sessions.db-wal`（1.2 MB）比库本体（1.1 MB）还大 —— 直接拷贝必然得到不一致副本，正是 F1 明令禁止的行为。恢复收尾时按 `manifest.restoreHints` 重建索引。 |

### 3.2 为什么用「排除清单」而不是「收录清单」

数据家目录会随功能增长长出新目录。若用收录白名单，**新增的状态目录会静默漏备**，而漏备直到用户需要恢复的那一刻才暴露。用排除黑名单，最坏情况只是多备一个小的未知目录。代价完全不对称，所以：**默认收录，已确证的缓存/派生物逐条排除并写明理由**（`EXCLUDED_DIR_REASONS` / `EXCLUDED_FILE_REASONS` / `EXCLUDED_FILE_PATTERNS`）。

排除的典型条目（每条都带理由，`khy backup` 输出里会汇总排除项数）：

- **缓存/运行期目录**：`logs`、`cache`、`tmp`/`.tmp`、`gateway`、`node_modules`、`clipboard-img2file`、`backups`（防递归）
- **派生物文件**：`integrity_manifest.json`（安装完整性清单，可重生成）、`hw_probe_cache.json`、`version_cache.json`、`node_check.json`、`last_verified_model.json`、`bootstrap_version.json`、`ai_manage_runtime.json`（守护进程端口，重启即变）
- **进程/运行期**：`daemon.pid`、`*.pid`、`*.lock`、`*.log`、`.tmp-*`、`.restore-tmp-*`
- **幽灵 `*.json` 目录**：`.khy/` 下存在几个名字带 `.json` 的**空目录**（`custom_providers.json/`、`search_engines.json/`），是 `getDataDir()` / `getAppDataDir()` 被传入完整文件名后 mkdir 出来的产物。它们不是状态，整棵剪掉。**这是一个已发现但未修复的上游 bug**，见第八节。

### 3.3 分级：core（默认）与 full

`core` 收权威且体积可控的东西；`full` 额外收「体积大但不可重建的历史流水」：`audit`（实测 10 MB / 1300+ 文件）、`receipts`、`events`、`telemetry`、`training`、`cognitive_snapshots`、`audit.jsonl`。

```bash
khy backup --tier full     # 或 khy backup full
```

**分级不能成为绕过 F1 的后门**：`.db`/`.sqlite`/`-wal`/`-shm`/`-journal` 在 **core 和 full 两级都**被文件遍历排除，理由固定为 `sqlite:hot-copy-only`。测试 `backupAssetPlan.test.js` 对两级分别断言这一点。

---

## 四、域边界：备份**不**负责的三件事

备份集刻意不去覆盖别的子系统的领地。搞混会导致「恢复」把另一件事弄坏：

| 不收 | 归谁 | 为什么不能混 |
|---|---|---|
| `.install-ledger.jsonl` | `khy uninstall` 的安装副作用台账 | 它记录的是**这一次安装**在系统里留下了什么。把 A 次安装的台账恢复进 B 次安装，卸载就会去删不属于自己的东西。 |
| `~/.khyos/vault` | `khy vault`（独立机密域） | 默认 `BACKUP.INCLUDE_VAULT = false`。vault 有自己的加密与解锁模型，混进一份 0600 的普通备份集会降低它的保护等级。 |
| 源码 / 已装副本完整性 | `khy restore`（加密源码包）、`integrity_manifest.json` | 那是「程序」不是「数据」。完整性清单是派生物，恢复后**主动丢弃**并让它重新生成，而不是把旧清单盖回去。 |

---

## 五、F1：SQLite 只能热备，绝不复制正在写入的 `.db`

这是整个子系统最硬的一条约束，**且已经机器化，不靠人自觉**：

1. **规则层**：任何 `.db`/`.sqlite`/`-wal`/`-shm`/`-journal` 都被 `backupAssetPlan.classifyFile` 排除，理由 `sqlite:hot-copy-only`。规则本身不允许它们进文件遍历。
2. **执行层**：SQLite 进备份集的**唯一出口**是 `sqliteHotCopy.hotCopySqlite()`，实现为 `VACUUM INTO` —— WAL 兼容，产出的是一个**一致性快照**，不带 `-wal`/`-shm` 边车。
3. **静态守卫**：`tests/backupNoRawDbCopy.test.js` 扫描 `services/backup/*.js` 与 `cli/handlers/backup.js`，禁止除 `sqliteHotCopy.js` 之外的任何文件打开数据库连接、执行 `VACUUM`，或把 `copyFileSync`/`createReadStream`/`renameSync` 用在和 `.db`/`sqlite`/`-wal` 相关的路径上。想绕过 F1 必须先改掉这个测试 —— 那就是一次显式的、能被 review 看见的决定。

**为什么不用 better-sqlite3 的 `.backup()` API**：本仓的 SQLite 走双驱动适配器（`config/sqlite-adapter.js`），当前生效的驱动是 **node:sqlite**（better-sqlite3 只是回退），它**没有** `.backup()` 方法。`VACUUM INTO` 是唯一对两个驱动都可用、且 WAL 兼容的热备原语。

演练测试里有一条专门证明这件事的用例：备份进行中由**另一个进程**持续写入，已提交但仍在 WAL 里的行照样出现在快照中 —— 而裸拷 `.db` 会丢掉它们。

**PostgreSQL**：`DB_MODE=postgres` 时走 `pg_dump`（`KHY_PG_DUMP_BIN` 指定二进制，默认 `pg_dump`；空闲超时 `KHY_BACKUP_PG_DUMP_IDLE_TIMEOUT_MS`，默认 120 s，用 `spawnWithIdleTimeout` 而非硬杀）。恢复端**不自动 `pg_restore`** —— 它需要先 drop/create 数据库对象，破坏性远超「放回文件」，还要凭据与停机窗口。备份集里有 dump，恢复时把命令原样打印给人执行（`manualSteps`）。

---

## 六、恢复：顺序本身就是安全机制

`khy backup restore [<id>]`（缺省 `--latest`）。执行顺序刻意如此，每一步都是一道闸：

1. **先校验**。缺 `.complete` → **直接拒绝**，`--force` 也不放行（那是一份写到一半的备份）。逐项 sha256 不符 → 拒绝，除非显式 `--force`。用一份坏备份覆盖现有数据 = 两份都没了。
2. **守护进程存活 → 拒绝**。它持有 SQLite 连接与内存态，换掉库文件会得到「进程内旧状态 + 盘上新状态」的分裂。请自己 `khy daemon stop`；**恢复流程绝不代为 kill**（AGENTS 规则 3：不硬杀进程）。
3. **先给现状拍一份回退备份**，再动手。恢复本身可能选错 id；没有这一步就没有回头路。输出里会给出这份回退备份的 id。`--skip-pre-backup` 可跳过，**不可撤销，不建议**。
4. **家目录一致性检查**。manifest 记录了备份时数据家目录的绝对路径。路径变了（换机、换用户、portable 迁移）**默认拒绝**，需要 `--remap` 明确表示「就恢复到当前家目录」。
5. **逐项落盘**走 `.restore-tmp-<pid>` + rename；SQLite 走 `restoreSqliteInPlace`，**连带删除旧的 `-wal`/`-shm`/`-journal`** —— 否则旧 WAL 会重放，污染刚换上的库。
6. **收尾按 `manifest.restoreHints`**：丢弃 `integrity_manifest.json`（派生物，让它重新生成）、重建 `sessions.db` 的 FTS5 索引（会话 JSON 才是主副本）。
7. 完成后如果之前跑着守护进程，`khy daemon start` 重新拉起以加载新数据。

**恢复是叠加，不是镜像同步。** 「备份集里没有、现状里有」的文件**不会被删除**。core 级本就刻意少收，删除现有文件的语义太危险，需要另一个显式命令来表达。

**先预演**：`khy backup restore --dry-run` 走完全部校验与规划，一个文件都不动。养成先 dry-run 的习惯。

---

## 七、保留策略（唯一会删用户备份的地方）

语义**明确定义，无歧义**（`BACKUP` 注释 + `backupManifest.planRetention`）：

> 一份备份被删，当且仅当**同时**满足「按时间倒序排在 `KEEP_COUNT` 之外」**且**「早于 `KEEP_DAYS`」。**最新一份永不删除**（即使 `keepCount: 0`）。缺 `.complete` 的残破备份不受这两条保护，优先清理，且**不占用份数配额**。

"且"是刻意的：只超份数不超天数 → 一份都不删（可能是你今天连备了 20 次）；只超天数不超份数 → 一份都不删（可能是你半年只备了 3 次）。任何一条单独成立都不足以删除用户数据。

```bash
khy backup prune --dry-run                     # 先看会删哪些、理由是什么
khy backup prune --keep-count 30 --keep-days 90
```

## 八、配置项一览（F5：默认值只在 `serviceDefaults.js` 的 `BACKUP`）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `KHY_BACKUP` | 开 | 总闸（`flagRegistry`，default-on）。关掉后命令仍可被发现，但**明确拒绝执行**并告知 —— 绝不静默空跑。 |
| `KHY_BACKUP_ROOT` | `<数据家目录>/backups` | 备份根。`--root` 可临时覆盖。 |
| `KHY_BACKUP_TIER` | `core` | 默认分级。`--tier` 覆盖。 |
| `KHY_BACKUP_KEEP_COUNT` | `10` | 保留份数。 |
| `KHY_BACKUP_KEEP_DAYS` | `30` | 保留天数。 |
| `KHY_BACKUP_MIN_FREE_BYTES` | `512 MB` | 起备前的最小可用空间。宁可拒绝开始，也不要写一半把盘撑爆。 |
| `KHY_PG_DUMP_BIN` | `pg_dump` | PostgreSQL 分支的二进制。 |
| `KHY_BACKUP_PG_DUMP_IDLE_TIMEOUT_MS` | `120000` | `pg_dump` 空闲超时（idle，非硬超时）。 |

命令行选项见 `khy backup help`：`--tier`、`--note`、`--root`、`--allow-partial`、`--dry-run`/`-n`、`--remap`、`--force`、`--skip-pre-backup`、`--skip-reindex`、`--keep-count`、`--keep-days`、`--quiet`/`-q`。

---

## 九、已知问题：幽灵 `*.json` 目录

`.khy/` 下会出现名字带 `.json` 的**空目录**：

- `custom_providers.json/` — `cli/handlers/health.js` 调 `getDataDir('custom_providers.json')`
- `search_engines.json/` — `services/webSearchService.js`、`services/webToolsService.js` 调 `getAppDataDir('search_engines.json')`

`getDataDir()` / `getAppDataDir()` 会 **mkdir 传入的完整拼接路径**，所以传文件名进去就得到一个同名目录。真正的文件由别处正常写在旁边（`custom_providers.json` 文件与 `custom_providers.json/` 目录可以同时存在）。

**备份侧已经绕开**：`backupAssetPlan.isPhantomJsonDir` 把这类**目录**整棵剪掉，同名**文件**照常收录。但上游调用点仍在制造它们 —— **这是待修的 bug，不属于备份子系统的职责**，修它要改那三个调用点的 `getDataDir` 用法（本次未改，避免把两件事混进一个变更）。

---

## 十、JSON 原子写（与备份同源的一条加固）

备份能救「盘上文件坏了」，但救不了「文件被写坏的那一刻」。裸 `fs.writeFileSync` 写到一半断电/被 kill，留下的是一个**截断的 JSON**，下次启动读到畸形内容，状态直接归零 —— 而这时最近一份备份可能已经是几天前的了。

所以 `utils/atomicWriteJson.js` 是「原子写 JSON」的单一真源：同目录临时文件 + 可选 fsync + `rename`。原子性来自 `rename`（POSIX 与 Windows 的 ReplaceFile 语义都是原子替换），读者永远看到「旧的完整内容」或「新的完整内容」，不存在中间态；fsync 只决定断电后能否保住**新**内容，因此可经 `KHY_ATOMIC_FSYNC` 门控关闭而不破坏原子性。同时导出 `atomicWriteText`：原子性属于「写文件」这件事，JSON 只是最常见的载荷。

**第一批已迁移的调用点**（全部只换写入原语，**盘上字节与文件权限一字不改**）：

`services/permissionStore.js`、`tokenUsageService.js`、`proxyConfigService.js`、`toolCallingPermissions.js`、`growthService.js`（5 处）、`apiKeyPool.js`、`customProviderRegistry.js`、`mcp/mcpConfigStore.js`、`messaging/msgConfigStore.js`、`meshStore.js`、`evoEngine/evoLedger.js`、`sessionPersistence.js`、`trajectoryProvenance/traceChain.js`。

迁移期有三个坑，都已在 `tests/atomicWriteMigration.test.js` 里钉住：

1. **权限**：`atomicWriteJson` 默认 `0o600`，而 `fs.writeFileSync` 默认 `0o666`（实际权限由 umask 定，通常 0644）。直接替换会**静默收紧**权限 —— 若有人把 `KHY_DATA_HOME` 指向多用户共享目录，另一个用户会读不到文件，而写入方一切正常、毫无报错。所以迁移点一律**显式传 `mode: 0o666`**；本来就是凭据文件的（`msg.json`、会话快照）保持既有的 `0o600`。「换写入原语」和「改权限」是两件事，必须分批做。
2. **字节**：legacy 迁移（`apiKeyPool` / `customProviderRegistry` 把旧文件搬到新路径）必须**逐字节**搬运 —— 重新序列化会改变缩进与键序，那就不再是「搬运」而是「改写用户数据」，故走 `atomicWriteText`。`mcp.json` 原本以换行结尾（project 作用域的 `.khy/mcp.json` 常被提交进仓库），故用 `trailingNewline: true` 保住那个换行。
3. **失败可见**：`atomicWriteJson` 返回 `false` 而**不抛**。原先靠 `writeFileSync` 抛异常让上层感知失败的调用点（`mcpConfigStore` / `msgConfigStore` / `evoLedger` / `traceChain` / `sessionPersistence._writeAtomic`）必须把 `false` 变回异常；`meshStore` 必须变回 `{ok:false, error}`。漏掉这一步 = 静默丢数据，比不迁移更糟。

未迁移的其余裸写点（`goalStore` / `vaultStore` / `learningProfile` / `dataHome._writePointer` 等）留待后续批次；改 `dataHome` 会牵动路径解析的启动顺序，单独成批。

---

## 十一、验证方式

```bash
cd services/backend
node --test tests/backupRestoreDrill.test.js      # 备份 → 破坏 → 恢复 → 校验（含跨进程并发写入的热备）
node --test tests/backupNoRawDbCopy.test.js       # F1 静态守卫
node --test tests/backupAssetPlan.test.js         # 资产规则（分级 / 排除 / 幽灵目录）
node --test tests/backupManifest.test.js          # 清单格式 + 保留策略
node --test tests/sqliteHotCopy.test.js           # VACUUM INTO 与 restoreSqliteInPlace
node --test tests/atomicWriteJson.test.js         # 原子写原语
node --test tests/atomicWriteMigration.test.js    # 迁移批次的字节/权限/失败语义回归
```

演练测试是 F3「恢复必须可演练」的落点：它真的建库、真的备份、真的删数据、真的恢复、再逐项校验 —— 不是 mock。

---

## 十二、已冻结的立法决定（2026-08-16）

本子系统的设计决定经用户**逐项审阅后整体冻结**。记在这里的目的不是留档好看，而是：**下次有人想改其中任何一条，先要知道它当初为什么这么定，以及改它会踩到什么。** 每条都带「代价」而非只带「理由」——只写理由的记录会让后来人以为这是唯一选择。

| # | 冻结的决定 | 为什么 / 放弃了什么 |
|---|---|---|
| 1 | 数据恢复入口是 `khy backup restore`，**不抢占顶层 `khy restore`** | 顶层 `khy restore` / `restore-source`（中文 `还原`）早于本子系统存在，语义是「恢复加密源码包」，归 `cli/handlers/publish.js`。抢占它会静默改变既有行为，断掉依赖它的脚本与肌肉记忆。代价：数据恢复要多打一个词。**这不是偏好，是既有命令占位的结果。** |
| 2 | 默认分级 `core`；`full` 必须显式指定 | `full` 额外收 `audit`（实测 10 MB / 1300+ 文件）等历史流水。默认给「小而权威」，让 `khy backup` 随手可跑。代价：不看文档的人不会自动备到历史流水。 |
| 3 | 备份集**不加密**，改用目录 0700 / 文件 0600 + `manifest.containsSecrets` 显式标记 | 备份集含 `api_keys` / `auth_sessions` 表与各消息通道 token；按表裁剪会破坏引用完整性，故不裁。加密会引入「口令丢了备份就废了」这个新的**单点失效**，且恢复流程要多一道解密闸。放弃的是静态保护强度，换来的是恢复路径不增加失败模式。**推论：备份集绝不能进版本库或公共存储。** |
| 4 | 用**排除清单**（黑名单）而非收录清单（白名单） | 数据家目录会随功能增长长出新目录。白名单会让新增状态目录**静默漏备**，而漏备直到用户需要恢复那一刻才暴露；黑名单最坏只是多备一个小的未知目录。**代价完全不对称**，所以选黑名单，并要求每条排除都写明理由。 |
| 5 | `sessions.db`（含 `-wal`/`-shm`）**不进备份集** | 它只是会话 JSON 的 FTS5 索引副本，`sessionSearchIndex.reindexAll()` 可全量重建；且现场实测 `sessions.db-wal`（1.2 MB）比库本体（1.1 MB）还大 —— 裸拷必然得到不一致副本，正是 F1 禁止的行为。恢复收尾按 `manifest.restoreHints` 重建索引。 |
| 6 | SQLite 热备用 `VACUUM INTO`，**不用** better-sqlite3 的 `.backup()` | 本仓 SQLite 走双驱动适配器，**当前生效的驱动是 node:sqlite，它没有 `.backup()`**（better-sqlite3 只是回退）。`VACUUM INTO` 是唯一对两个驱动都可用且 WAL 兼容的原语。F1 已机器化成三层（规则层排除 / 执行层唯一出口 / `backupNoRawDbCopy.test.js` 静态守卫），见第五节。 |
| 7 | 恢复前**强制**给现状拍一份回退备份；守护进程存活则**直接拒绝**，且绝不代为 kill | 恢复本身可能选错 id，没有回退备份就没有回头路。不硬杀进程遵 AGENTS 规则 3。`--skip-pre-backup` 保留但标注「不可撤销，不建议」。 |
| 8 | 恢复是**叠加**，不是镜像同步：「备份集里没有、现状里有」的文件**不删除** | core 级本就刻意少收，若做镜像同步，一次 core 恢复会删掉大量没被收录的现存文件。删除语义太危险，需要另一个显式命令来表达。 |
| 9 | 保留策略 = 超份数 **AND** 超天数；最新一份**永不删除** | 任何一条单独成立都不足以删用户数据（今天连备 20 次 / 半年只备 3 次）。残破备份（缺 `.complete`）不受这两条保护，优先清理且不占份数配额。 |
| 10 | PostgreSQL **只备不自动恢复**，把 `pg_restore` 命令原样打印给人执行 | `pg_restore` 要先 drop/create 数据库对象，破坏性远超「放回文件」，还需凭据与停机窗口。备份集里有 dump，决定权留给人。 |
| 11 | 原子写迁移点一律**显式传 `mode: 0o666`**，保持权限不变而非收紧到 0600 | `atomicWriteJson` 默认 0600，`fs.writeFileSync` 默认 0666（实际由 umask 定）。直接替换会**静默收紧**权限：若有人把 `KHY_DATA_HOME` 指向多用户共享目录，另一个用户会读不到文件，而写入方一切正常、毫无报错。「换写入原语」和「改权限」是两件事，必须分批。 |
| 12 | 第一批只迁 13 个调用点；`dataHome._writePointer` 单独成批 | 见第十节的清单。改 `dataHome` 会牵动路径解析的启动顺序，混进这一批会让「原子写迁移」和「启动顺序变更」两类风险无法分别回滚。 |

**已知缺陷，刻意未在本次修复**：第九节的幽灵 `*.json` 目录（`health.js` / `webSearchService.js` / `webToolsService.js` 三个 `getDataDir` 调用点）。备份侧已绕开，但制造它们的上游仍在。

**工具链遗留问题（与本子系统无关，但会误导后来人）**：`services/backend` 的 `npm run test:node` 脚本 glob 为 `tests/**/*.test.js`，覆盖了约 636 个**只能在 jest 下运行**的套件，必然报 `global.describe is not a function`（在本子系统之前的提交上即可复现）。**该脚本在本仓不可能变绿**，请勿把它的失败当成回归；本子系统的验证方式见第十一节。
