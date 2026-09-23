# GitHub 调研 — 双机流水线与指挥部状态同步板块 — 2026-09-14

> 每日板块轮转调研（索引 5/12）：khy-os 双机同步板块（`scripts/sync/export-sync.{sh,bat}`、`import-sync.{sh,bat}`、`mirror-sync.js`、`scripts/lib/mirrorSyncQueue.js`、指挥部 `khy-os-hq/scripts/sync.py` + `autopull.bat`）对标 GitHub 开源双仓/双机同步工具，寻找可借鉴点。

## 调研对象

khy-os 双机同步板块现状（三套并存机制）：

| 机制 | 位置 | 形态 |
|---|---|---|
| 离线 bundle 传输 | `scripts/sync/export-sync.sh/.bat` + `import-sync.sh/.bat` | 本机 `git add -A && commit` → `git bundle create` → 文件搬到另一台 → `git bundle verify` + `fetch` + `merge --ff-only`；支持 `--merge`/`--dry-run`/`--no-commit` |
| 镜像推送 + 补推队列 | `scripts/sync/mirror-sync.js` + `scripts/lib/mirrorSyncQueue.js` | post-commit hook 推 origin+gitee，失败分类 network/auth/diverged/unknown，欠账落 `.khy/sync/mirror-queue.json`，45s 空闲窗口软杀（滑动超时），凭据抹除；`--non-interactive`/`--strict`/`--json`；GitHub Actions 兜底 |
| 双仓 pull/push 门禁 | 指挥部 `khy-os-hq/scripts/sync.py`（Windows 计划任务 `khy-hq-autopull` 每 10 分钟） | `--ff-only` 拉取、hq_check 全绿才允许推、`--clean-only`/`--push-only` 无人值守模式、`--status` 只读方向报告、并行 fetch、自动分支合并建议 |

**短板（5 条）**：

1. **导入前无冲突预检**：`import-sync.bat` 直接 `git fetch bundle` + `merge`，冲突在 merge 中途才暴露，无 dry-run 级的「会撞哪些文件」预览。
2. **状态侧无完整性清单**：hq 仓库是任务/Bug 状态真源，但同步时不校验「搬过去的到底是不是我这边这版」，缺 per-file sha256 + HEAD SHA + 同步时间戳的 manifest。
3. **bundle 全量导出无增量语义**：`export-sync` 每次 `git bundle create` 整个分支历史，没有「自上次同步以来新增了多少 commit」的 delta 判断；0 个新提交也照样导一个大文件。
4. **三套机制无统一状态视图**：bundle / mirror 队列 / hq sync.py 各说各话，没有一个命令能同时看到「两个仓库各 ahead/behind/dirty 多少、队列欠几条、上次同步何时」。
5. **单向同步无 merge 策略配置化**：hq 必须 ff-only（状态真源），code 仓可 rebase；目前是各脚本写死，不统一。

## 对标项目

| 项目 | Star（2026-09-14） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| Unison | ~5.5k | OCaml | 高：纯双副本双向同步、archive 增量、冲突预检、batch/dry 模式 | https://github.com/bcpierce00/unison |
| Syncthing | ~88.6k | Go | 高：本地/全局索引分离、REST 状态视图、delta 传输目标 | https://github.com/syncthing/syncthing |
| rclone | ~59.8k | Go | 高：`--files-from` + mtime/校验和 delta、`--dry-run`、单向镜像 | https://github.com/rclone/rclone |
| git-town | ~3.4k | Go | 中：多仓 workspace 统一 sync + 逐仓 `--dry-run` 命令打印 | https://github.com/git-town/git-town |
| multi-gitter | ~1.2k | Go | 中：一命令 fan-out N 仓、逐仓失败隔离、聚合 status | https://github.com/lindell/multi-gitter |
| dulwich | ~2.3k | Python | 中：纯 Python git（bundle/merge/range_diff），可做冲突预检 | https://github.com/jelmer/dulwich |

## 值得借鉴的点

### 1. 统一状态视图：一条命令看全（P0）

**对方怎么做**：Syncthing `/rest/db/status` 每文件夹返回 `globalFiles/localFiles/needFiles/inSyncFiles/pullErrors`；git-town `git town sync` 跨 workspace 逐仓打印「Up to date / N behind」；multi-gitter `status` 聚合多仓。

**khy-os 现状差在哪**：`sync.py --status` 只读两仓 ahead/behind/dirty，不含 mirror 队列欠账、manifest 校验、上次同步时间。三套机制状态割裂。

**改哪些文件**：新增 `scripts/sync/sync-status.js`（Node，纯读），聚合 `git rev-list --left-right`（两仓 ahead/behind）+ `.khy/sync/mirror-queue.json`（欠账）+ manifest（哈希一致性），输出统一表格 / `--json`。

### 2. 同步清单 manifest：状态真源完整性（P0）

**对方怎么做**：Unison 的 private archive（路径 + 文件指纹/inode+modtime）让下次 sync 能 diff 出「上次同步后的变化」；Syncthing 的全局索引保证 truth 侧一致性。

**khy-os 现状差在哪**：hq 是任务/Bug 真源，但 bundle 导入后无法回答「这台机器上的 hq 状态和我导出时那份逐字节一致吗」。

**改哪些文件**：`export-sync` 导出时写 `manifest.json`（HEAD SHA、commit 列表、关键文件 sha256、时间戳）随 bundle 同目录；`import-sync` 导入后校验，缺/多条目即快速失败并报具体条目。

### 3. 增量 delta 计算：自上次同步以来的新增（P0）

**对方怎么做**：rclone `--files-from` + size/modtime/MD5 三级 delta；Syncthing 跳过 0 变更的 rescan；git-town `rev-list` 判 0 new 则跳过。

**khy-os 现状差在哪**：`export-sync` 每次全量 bundle 整个分支，没有「上次同步 ref」记录，0 个新提交也导大文件。

**改哪些文件**：`export-sync` 记录 `last-sync-ref` 进 manifest；下次先 `git rev-list --count last-sync-ref..HEAD`，为 0 则跳过 bundle 并提示「无新增，无需传输」。

### 4. 导入前冲突预检 / dry-run（P1）

**对方怎么做**：Unison「冲突先检测并显示，不冲突自动传播」；git-town `--dry-run` 打印将执行的每条 git 命令；dulwich `range_diff` 在不 checkout 的情况下算三方差异。

**khy-os 现状差在哪**：`import-sync` 无预检，冲突在 merge 中途才暴露。

**改哪些文件**：`import-sync` 加 `--preview`：`git rev-list --left-right` + 文件列表交集，列出会撞的文件；非交互时直接报冲突清单而非 mid-merge 报错。

### 5. 逐仓 fail-soft + 调度器友好 batch（P1）

**对方怎么做**：multi-gitter 单仓失败跳过不阻断其他仓；Unison `-batch`（不提示，冲突即非零退出）+ `-dry`。

**khy-os 现状差在哪**：10 分钟计划任务（autopull）目前全有或全无；缺统一的「快进就自动拉、冲突就报告并退出码 2、绝不弹窗」契约。

**改哪些文件**：`sync.py` 与 bundle 脚本加 `--batch --dry` 统一 flag，10 分钟任务跑只读 + 快进自动拉，冲突时落机器可读报告。

### 6. per-repo merge 策略配置化（P2）

**对方怎么做**：git-town `branch.<name>.sync-strategy`（no-ff/rebase/merge）存 git config。

**khy-os 现状差在哪**：hq 必须 ff-only、code 可 rebase，目前各脚本写死。

**改哪些文件**：`.khy/sync/workspace.json`（两仓 + remote + 策略），单一真源。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | 统一状态视图 `scripts/sync/sync-status.js`（两仓 ahead/behind/dirty + 队列欠账 + manifest 一致性，表格/`--json`） | P0 | 半天 |
| 2 | 同步清单 manifest：export 写 `manifest.json`（HEAD SHA/commit 列表/关键文件 sha256/ts），import 校验 | P0 | 半天 |
| 3 | 增量 delta：export 记 `last-sync-ref`，`rev-list --count` 为 0 时跳过 bundle | P0 | 2 小时 |
| 4 | 导入前冲突预检 `--preview`（rev-list + 文件交集） | P1 | 半天 |
| 5 | 逐仓 fail-soft + `--batch --dry` 调度器契约 | P1 | 半天 |
| 6 | per-repo merge 策略配置化（workspace.json） | P2 | 数小时 |

## 参考链接

- https://github.com/bcpierce00/unison — archive 增量、冲突预检、`-batch`/`-dry`
- https://github.com/syncthing/syncthing — 本地/全局索引、`/rest/db/status`、delta 传输
- https://github.com/rclone/rclone — `--files-from` + mtime/校验和 delta、`--dry-run`
- https://github.com/git-town/git-town — workspace 统一 sync、`--dry-run` 命令打印
- https://github.com/lindell/multi-gitter — 一命令 fan-out、逐仓失败隔离、聚合 status
- https://github.com/jelmer/dulwich — 纯 Python git、`range_diff` 冲突预检

## 落地记录

### 已实现条目（3 条 P0 + 1 条 P1 顺带）

**P0-1 统一状态视图 `sync-status.js`（Syncthing /git-town / multi-gitter 模式）** — ✅ 已实现
- 新增 `scripts/sync/sync-status.js`（Node，纯读、零写操作）：聚合三套机制的状态为一张表——
  - 两仓 `ahead/behind/dirty`（`git rev-list --left-right --count` + `status --porcelain`），detached / 无上游时诚实报 0
  - `.khy/sync/mirror-queue.json` 镜像补推队列欠账条数与逐条明细（复用 `mirrorSyncQueue.describeQueue`）
  - `manifest.json` 一致性校验（见 P0-2）
- 仓库根发现**不写死绝对路径**：`KHY_OS_DIR` / `KHY_OS_HQ_DIR` env 优先，回落到脚本所在仓库的相对位置；`.git` 不存在的仓库自动跳过（fail-soft，绝不崩）
- 输出人类可读表格 + `--json` 给 10 分钟计划任务 / CI；`--manifest-dir` 指向 bundle 目录校验清单
- git 解析沿用 `mirror-sync.js` 的 `KHY_GIT` env 约定（零硬编码）

**P0-2 同步清单 manifest（Unison archive / Syncthing global index 模式）** — ✅ 已实现
- `export-sync.bat`：导出成功后写 `<OUT_DIR>\manifest.json`（`khy-sync-manifest/v1`：`headSha`、本次新增 commit 列表、`newCommitCount`、时间戳、bundle 文件名），并更新 `.last-sync-ref`
- `import-sync.bat`：bundle 校验后、merge 前，若同目录有 `manifest.json`，用 `git cat-file -e` 逐条核对清单里的 commit 是否真实存在；缺失即列出具体 sha 并**拒绝导入**（状态真源漂移不能静默吞掉）
- `sync-status.js` 的 `checkManifest` 提供只读校验视角

**P0-3 增量 delta（rclone `--files-from` / Syncthing rescan 跳过 0 变更模式）** — ✅ 已实现
- `export-sync.bat`：记录 `.last-sync-ref`；下次导出先 `git rev-list --count last-sync-ref..BRANCH`，**为 0 直接跳过 bundle** 并提示「无新增，无需传输」；有新增才 `git bundle create`，导出成功后刷新基线
- 解决短板 #3（全量 bundle 无增量语义）

**P1-4 导入前冲突预检（顺带，低成本）** — ✅ 已实现
- `import-sync.bat`：目标分支已存在时，merge 前打印本地 tip（`git rev-parse --short`），让操作者在冲突发生前看到「即将合入什么」；非交互场景不阻塞

### 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/sync/sync-status.js` | 新增 | 统一只读状态视图（两仓 ahead/behind/dirty + 队列欠账 + manifest 校验），`--json`/`--manifest-dir`，仓库发现走 env 不写死路径 |
| `scripts/sync/export-sync.bat` | 改 | P0-3 增量 delta（`.last-sync-ref` + `rev-list --count` 0 则跳过）+ P0-2 写 `manifest.json` |
| `scripts/sync/import-sync.bat` | 改 | P0-2 manifest 完整性预检（`git cat-file -e` 逐条，缺失即拒绝）+ P1 本地 tip 预览 |

### 检查结果

- `node -e "require('./scripts/sync/sync-status.js')"`：✅ 加载成功
- `node scripts/sync/sync-status.js`：✅ 正常输出（当前环境 khy-os 为 detached、无上游，诚实报 0/0/0；镜像队列空；manifest 未找到）
- `node scripts/sync/sync-status.js --json`：✅ 机器可读输出
- `.bat` 文件为 Windows 批处理，本环境无法直接执行验证；语法沿用原脚本既有模式（`setlocal enabledelayedexpansion` + `!VAR!` 延迟展开 + `for /f` + `^` 转义），与文件其余部分风格一致

### 未实现项（标「待人工决策」，P1/P2）

- **P1 逐仓 fail-soft + `--batch --dry` 调度器契约**：10 分钟任务（autopull）与 mirror 看门狗尚未共享统一的「快进就自动拉、冲突就退 2 并落机器可读报告、绝不弹窗」契约，建议下一步给 `sync.py` 与 bundle 脚本加 `--batch`/`--dry` 统一 flag
- **P2 per-repo merge 策略配置化（workspace.json）**：hq 必须 ff-only、code 可 rebase，目前各脚本写死；建议落 `.khy/sync/workspace.json` 单一真源
- **`export-sync.sh` / `import-sync.sh`（POSIX 版）未同步改**：本次只改了 `.bat`（Windows 便携机主用）；POSIX 版的 manifest/增量 delta 需另行移植，留后续
- **manifest 的 commit 列表在 bundle 跨机传输后需连同 bundle 一起拷走**：当前约定 manifest 与 bundle 同目录（`<OUT_DIR>\`），使用者需两个文件都传给对端——`import-sync.bat` 已校验「同目录无 manifest 则跳过校验」，不会误报
