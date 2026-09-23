# GitHub 调研 — 版本同步与治理检查板块 — 2026-09-15

> 每日板块轮转调研（索引 6/12）：khy-os 版本同步与治理检查板块（`scripts/ci/check-version-sync.js`、`check-gov-rules.js`、`check-agent-rules.js`、`scripts/ruleguard/`）对标 GitHub 开源 monorepo 版本治理 / 合规工具链，寻找可借鉴点。

## 调研对象

khy-os 版本治理板块现状（三脚本 + 一套绑定层）：

| 组件 | 位置 | 机制 |
|---|---|---|
| 版本同步 | `scripts/ci/check-version-sync.js` | 三条轨道九真源组内字符串一致性校验（主包 4 源 / ai-backend 2 源 / 浏览器 UI 3 源） |
| 治理总纲入口 | `scripts/ci/check-gov-rules.js` | 十大板块入口连通性 + `check:*` 脚本指向 + PR gate 接线 + 规则登记表 schema 校验（13 字段、ID 唯一、三元性质、权力-约束配对） |
| 智能体规则 | `scripts/ci/check-agent-rules.js` | 静态扫描硬编码端点 / 含糊状态 / 硬超时 / ANSI 滚动区 / 无界死循环 |
| 规则绑定层 | `scripts/ruleguard/`（`registry`/`wiring`/`coverage`/`baseline`/`ledger`/`manifest`） | 门成员资格从 `RULES-REGISTRY.json` 派生；覆盖率报告 + 棘轮基线 + 违规台账 + 抑制 |

**短板（4 条）**：

1. **版本只查字符串相等，不查 semver 合法性**：`check-version-sync.js` 校验九真源组内一致，但不校验版本号本身是否合法 semver——写 `1.0`、`v1.0`、`abc`、`1.0..0` 都能通过一致性检查，等到 `publish-dual.sh` 同步或 `npm publish` 才在下游炸。
2. **治理检查无单命令状态聚合**：`check-version-sync` / `check-gov-rules` / `rules:coverage` / `check-wiring` 各说各话，没有一个命令能同时看到「版本三轨道是否绿 + 规则覆盖率 + 门接线是否齐 + 台账抑制条数」。
3. **规则检查器非纯函数、无 fixture 根回归**：`check-gov-rules.js` 已支持 `KHY_GOV_RULES_ROOT` fixture 根，但 `check-version-sync.js` 只认 `process.cwd()`，且整套无「给检查器喂合成语料 + 断言结果」的回归约定。
4. **台账缺机器可读聚合 / SARIF 方言**：`ruleguard` 已有 `violations.jsonl` 台账与抑制，但没有按规则/文件聚合的机器可读视图，也没有 SARIF 导出给下游 CI 标准化断言。

## 对标项目

| 项目 | Star（2026-09-15） | 技术栈 | 相关度 | 链接 |
|---|---|---|---|---|
| Changesets | ~12.4k | TypeScript/Node | 高：`status` 单命令聚合 + 陈旧分支（过期抑制）检测 | https://github.com/changesets/changesets |
| Lerna | ~36.1k | TS/JS | 高：独立/锁定双模式 = 版本轨道建模 | https://github.com/lerna/lerna |
| semantic-release | ~24.0k | JS/Node 插件架构 | 高：semver 硬校验 + commit 日志派生版本 | https://github.com/semantic-release/semantic-release |
| Checkov | ~9.0k | Python | 高：抑制即数据 + SARIF 机器可读输出 | https://github.com/bridgecrewio/checkov |
| OPA/Rego | ~12.2k | Go | 中：规则与执行器解耦 + `opa test` fixture 根 | https://github.com/open-policy-agent/opa |
| Nx | ~29.3k | TS + Rust | 中：affected-only 增量门 + 版本插件化 | https://github.com/nrwl/nx |
| Renovate | ~22.5k | TS | 中：跨工具聚合记分卡 + 趋势 | https://github.com/renovatebot/renovate |

**关键发现**：khy-os 的规则绑定层（登记表驱动门 + 棘轮基线 + jsonl 台账 + 抑制）在「规则遵守」层面已领先多数开源项目；缺口集中在**版本语义校验（semver）、单命令状态聚合、SARIF/台账聚合报告**三点，且前三项均为 P0、改动限于 1–2 个脚本、集成成本低。

## 值得借鉴的点

### 1. 版本 semver 合法性校验（semantic-release 模式）— P0

**对方怎么做**：semantic-release `plugin-analyze-commits` 读 conventional-commit 推导 next semver，`prepare` 阶段写 CHANGELOG，版本号本身即合规产物；Lerna 的 `version` 命令对每个包跑 semver 校验。

**khy-os 现状差在哪**：`check-version-sync.js` 对九真源只 `text.match(regex)` 取字符串再比相等，从不校验取到的值是否合法 semver。

**改哪些文件**：`scripts/ci/check-version-sync.js`（加 `isSemver` 校验，非合法 semver 直接失败并点名文件）。

### 2. 统一治理状态视图：单命令聚合（Changesets `status` / Renovate 记分卡）— P0

**对方怎么做**：Changesets `changeset status` 一次输出「哪些包有 pending、版本将如何 bump」；Renovate 单命令聚合跨工具状态 + 可合并信心数据。

**khy-os 现状差在哪**：`check-version-sync` / `rules:coverage` / `check-gov-rules` / `check-wiring` 各跑各的，无人值守任务（10 分钟 autopull）需要逐条手动拼。

**改哪些文件**：新增 `scripts/ci/check-gov-status.js`（纯读，零写）：聚合版本三轨道 + 规则覆盖率 + 台账抑制 + 治理接线，输出人类表格 + `--json`。

### 3. 纯函数检查器 + fixture 根回归（OPA `opa test`）— P0

**对方怎么做**：OPA `opa test` 用 fixture 语料回归策略；`KHY_GOV_RULES_ROOT` 是 khy-os 已有雏形。

**khy-os 现状差在哪**：`check-version-sync.js` 只认 `process.cwd()`，无 fixture 根、无「喂合成语料 + 断言结果」约定，改守卫逻辑时无法离线验证不误伤。

**改哪些文件**：`scripts/ci/check-version-sync.js`（加 `KHY_VERSION_SYNC_ROOT` fixture 根，纯函数化可测）。

### 4. 台账聚合 + SARIF 导出（Checkov）— P1

**对方怎么做**：Checkov 抑制即数据（行内 + `--suppress-check` 均记录出报告）；SARIF 一种格式打通 GitHub code scanning。

**khy-os 现状差在哪**：`ruleguard` 台账有 jsonl + 抑制，但无按规则/文件聚合的机器可读报告，也无 SARIF 方言。

**改哪些文件**：`scripts/ruleguard/lib/ledger.js` + `index.js`（加聚合 + SARIF 导出，P1 留后续）。

### 5. 记分卡趋势字段（Renovate/Backstage）— P1

**对方怎么做**：Backstage 记分卡 health/compliance 字段化；Renovate 跨工具趋势。

**khy-os 现状差在哪**：`rules:coverage` 只报点值，无「上期对比 + 升降箭头」。

**改哪些文件**：`scripts/ruleguard/lib/coverage.js`（加趋势字段，P1 留后续）。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | 版本 semver 合法性校验（check-version-sync 加 isSemver，非合法即失败点名） | P0 | 半小时 |
| 2 | 统一治理状态视图 check-gov-status.js（版本+覆盖率+台账+接线，表格/--json，纯读） | P0 | 半天 |
| 3 | 纯函数化 check-version-sync（KHY_VERSION_SYNC_ROOT fixture 根） | P0 | 1 小时 |
| 4 | 台账聚合 + SARIF 导出 | P1 | 半天 |
| 5 | 记分卡趋势字段 | P1 | 2 小时 |

## 参考链接

- https://github.com/changesets/changesets — `changeset status` 单命令聚合、陈旧分支检测
- https://github.com/lerna/lerna — independent/locked 双模式、changelog 驱动 bump
- https://github.com/semantic-release/semantic-release — semver 硬校验 + commit 派生版本
- https://github.com/bridgecrewio/checkov — 抑制即数据 + SARIF 输出
- https://github.com/open-policy-agent/opa — `opa test` fixture 根 + 纯函数策略
- https://github.com/nrwl/nx — affected-only 增量门 + 版本插件化
- https://github.com/renovatebot/renovate — 跨工具记分卡 + 趋势

## 落地记录

### 已实现条目（3 条 P0）

**P0-1 版本 semver 合法性校验（semantic-release 模式）** — ✅ 已实现
- `scripts/ci/check-version-sync.js`：新增 `isSemver(v)`（严格 `X.Y[.Z]`，零运行时依赖）；组内字符串相等检查**之前**先校验九真源取到的值是否合法 semver，非合法值（`abc`/`v1.0`/`1.0..`/`bad-x.y`）直接失败并**逐文件点名** offending 值。
- 实测：`1.2.0`=合法、`v1.2`/`abc`/`1.2..`=拒绝；合成 fixture 把 `pyproject.toml` 改成 `bad-x.y` 后 `exit 1` 并打印 `pyproject.toml: "bad-x.y"`。

**P0-2 统一治理状态视图 `check-gov-status.js`（Changesets `status` / Renovate 记分卡）** — ✅ 已实现
- 新增 `scripts/ci/check-gov-status.js`（纯读、零写、零子进程 fan-out）：一次性聚合
  1. **版本三轨道**（复用 `check-version-sync` 的 `runMain`/`isSemver`，quiet 模式不重复印刷）
  2. **规则覆盖率**（`ruleguard/lib/coverage.buildCoverage`：total/enforced 比率、byPriority、阻断红线、死指针、未挂载执行器）
  3. **抑制台账**（`ruleguard/lib/ledger.activeSuppressions`）
  4. **治理接线**（GOV-TOOL-005：`check:gov-rules` 脚本指向、`check:structure` 调用、PR gate 执行、治理总纲存在）
- 输出人类表格 + `--json`；退出码只在命中阻断红线（版本不匹配 / 非 semver / P0 未执行 / 死指针 / 接线缺口）时为 1，软指标（覆盖率、抑制数）只报不阻。
- 供 10 分钟计划任务（autopull）或人工「仓库健康吗」一瞥使用。

**P0-3 纯函数化 + fixture 根（OPA `opa test` 约定）** — ✅ 已实现
- `check-version-sync.js` 重构为纯函数 `runMain(repoRoot, opts)` + `makeReaders(repoRoot, opts)`：文件解析相对 `repoRoot` 而非 `process.cwd()`；新增 `KHY_VERSION_SYNC_ROOT` env 可指向合成树。
- `runMain` 新增 `{ quiet }` 选项（聚合视图调用时静默逐组成功行，避免双重打印）。
- 实测：`KHY_VERSION_SYNC_ROOT=<合成目录>` 指向全一致的九源 fixture → `exit 0`；改一处为 `bad-x.y` → `exit 1`。守卫逻辑可离线回归、不误伤。

### 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `scripts/ci/check-version-sync.js` | 改 | 加 `isSemver` 校验（九源逐一验证）；纯函数化 `runMain(repoRoot, {quiet})`；`makeReaders` 相对 root + quiet 选项；`KHY_VERSION_SYNC_ROOT` fixture 根；导出 `{ runMain, isSemver, makeReaders }` |
| `scripts/ci/check-gov-status.js` | 新增 | 统一只读治理状态视图：版本三轨道 + 规则覆盖率 + 抑制台账 + 治理接线，表格 / `--json`，复用 ruleguard 与 version-sync 既有纯函数 |

### 检查结果

- `node -e "require('./scripts/ci/check-version-sync.js')"` + `require('./scripts/ci/check-gov-status.js')`：✅ 均加载成功
- `node scripts/ci/check-version-sync.js`（活仓库）：✅ 三轨道 1.1.15 / 1.6.5 / 0.1.0，全绿
- `node scripts/ci/check-gov-status.js`（活仓库）：✅ 绿灯，覆盖率 34/44（77.3%），红线全过，接线齐全，无活跃抑制
- 合成 fixture 回归：一致树 `exit 0`、非 semver 值 `exit 1` 并点名 ✅
- `node scripts/ci/check-agent-rules.js`（两文件）：✅ 零违规

### 未实现项（标「待人工决策」，P1）

- **P1 台账聚合 + SARIF 导出**（Checkov 模式）：`ruleguard/lib/ledger.js` 已有 jsonl + 抑制，但无按规则/文件聚合的机器可读报告、无 SARIF 方言给下游 CI 标准化断言——建议给 `ruleguard` 加 `sarif` 子命令
- **P1 记分卡趋势字段**（Renovate/Backstage）：`ruleguard/lib/coverage.js` 只报点值，无「上期对比 + 升降箭头」；`rules:baseline` 棘轮已有基线，缺趋势视图
- **P2 changelog 驱动版本派生**（Lerna / semantic-release）：九真源手工同步的长期替代方向，已发布轨道不宜直接切，留作演进项
- **check-gov-status 未接线进 package.json / PR gate**：本次只新增脚本，未改 `package.json` 脚本表与 `.github/workflows/pr-gate.yml`（避免「新增 npm run 入口」越线）；若需进门，补 `check:gov-status` 脚本 + PR gate 一步即可，留人工点头
