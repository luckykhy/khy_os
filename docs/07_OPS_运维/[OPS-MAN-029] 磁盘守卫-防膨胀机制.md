<!-- 文档分类: OPS-MAN-029 | 阶段: 运维 | 原路径: docs/指南/磁盘守卫-防膨胀机制.md -->
# 磁盘守卫 — 防膨胀机制

> 日期: 2026-06-02
> 状态: 已实施
> 关联文件: `backend/src/services/cleanupService.js`, `backend/src/services/workspace/checkpointService.js`

## 背景

v0.1.82 之前，KHY 存在多处无限制追加日志和归档的问题。典型案例：`checkpointService` 对非 git 目录执行 `tar-full` 备份，曾将整个 home 目录打包，单次产生 **99 GB** 数据导致磁盘爆满。

审计发现 **14 个无限增长源头**，已在 cleanupService 中统一覆盖。

---

## 防护机制总览

| 数据源 | 磁盘路径 | 增长方式 | 防护措施 |
|---|---|---|---|
| trace-events.jsonl | `~/.khy/audit/trace-events.jsonl` | 每次 API 调用追加 | **10 MB 轮转** + gzip 归档 |
| audit/sessions/ | `~/.khy/audit/sessions/*.jsonl` | 每会话一个文件 | **7 天先归档再删原件** + 归档总量 200 MB 封顶 |
| audit/summaries/ | `~/.khy/audit/summaries/*` | 每会话两个文件 | **上限 50 个文件**（可配） |
| audit/exports/ | `~/.khy/audit/exports/*` | 导出时产生 | **上限 10 个文件**（可配） |
| security.log | `~/.khyquant/security.log` | 安全事件追加 | **5 MB 轮转** + 2 份 gzip |
| scan.log | `~/.khyquant/scan.log` | 每次扫描追加 | **5 MB 轮转** |
| skill-ledger/audit.jsonl | `~/.khyquant/skill-ledger/audit.jsonl` | 技能认证事件 | **5 MB 轮转** |
| telemetry audit.log | `~/.khy/audit.log` | 遥测审计事件 | **5 MB 轮转** |
| interaction_records.jsonl | `~/.khyquant/training/interaction_records.jsonl` | 训练数据记录 | **10,000 行 / 50 MB** |
| interaction_quarantine.jsonl | `~/.khy/training/interaction_quarantine.jsonl` | 隔离记录 | **5,000 行 / 20 MB** |
| 每日记忆日志 | `~/.khy/memory/logs/YYYY/MM/*.md` | 每天一个文件 | **90 天自动清除** |
| 会话文件 | `~/.khy/sessions/*.jsonl` | 每会话一个文件 | **7 天自动清除** |
| 任务输出 | `~/.khy/tmp/tasks/*.output` | 每任务一个文件 | **24 小时自动清除** |
| checkpoint 归档 | `~/.khyquant/checkpoints/` | 保存检查点时 | **10 个/项目, 单文件 200 MB, 总量 500 MB** |

### checkpoint 三重防护

1. **禁止打包 home 目录** — 非 git 项目不再 tar 整个 `~/`
2. **扩大排除列表** — `node_modules`, `.git`, `__pycache__`, `.venv`, `dist`, `build`, `.next`, `.cache`, `.khyquant`, `.claude`, `*.tar.gz`, `*.zip`, `*.iso` 等
3. **体积硬上限** — 单个 tar 超过 200 MB 自动删除，每个项目最多 10 个 checkpoint，全局总量不超过 500 MB

---

## 执行机制

完整模式（`khyquant`）:

```
启动 → 3 秒后首次全量清理（19 个目标）
     → 之后每 2 小时自动巡检
     → 跑完做一次体积自检（只提示，不删）
     → 进程退出时停止定时器
```

轻量模式（`khy`，也就是 `pip install khy-os` 之后最常走的那个入口）:

```
启动 → 3.5 秒后滚动 .khy/logs 与 .khy/audit 各一次
     → 做一次体积自检（只提示，不删）
     → 不起周期定时器
```

两条路径都由 `services/serviceLifecyclePolicy.js` 这张冻结表声明，`bootstrap/prefetch.js`
按表调度。轻量模式刻意只做这两件有界的事：`bin/khy.js` 以 `khy` 名调用时会把
`KHY_RUNTIME_MODE` 设成 `khy`，走的是轻量分支，而 `cleanupService` 那条策略条目是
`khyquant` 模式独有的——**在补上 `runtimeFootprintNotice` 之前，最主流的分发入口上
日志与审计的滚动从来没有跑过**，`.khy` 只增不减。

入口: `bootstrap/prefetch.js` → `cleanupService.runCleanup({ trigger: 'startup' })` → `startPeriodicCleanup()`（完整模式）
或 `cleanRuntimeLogs()` + `cleanTraceAudit()` + `assessRuntimeFootprint()`（轻量模式）

手动触发: CLI 中执行 `khy cleanup` 或 `khy settings` 中查看存储报告。分级删除用
`khy clean --runtime --dry-run`（先看清单，确认后才真删）。

---

## 保留期与上限（可配置）

默认值逐字节等于此前写死在 `cleanupService.js` 里的常量，所以不设任何环境变量时行为与旧版一致。

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `KHY_AUDIT_KEEP_DAYS` | `7` | `audit/sessions/` 分片的保留天数 |
| `KHY_AUDIT_MAX_TOTAL_MB` | `200` | `audit/archive/` 归档总量上限，超了从最旧的归档开始删 |
| `KHY_AUDIT_MAX_SUMMARY_FILES` | `50` | `audit/summaries/` 文件数上限 |
| `KHY_AUDIT_MAX_EXPORT_FILES` | `10` | `audit/exports/` 文件数上限 |
| `KHY_AUDIT_EVENTS_MAX_SIZE_BYTES` | `10485760` | `trace-events.jsonl` 的轮转阈值 |
| `KHY_AUDIT_ARCHIVE` | 开 | 设 `0` 退回旧行为：过期分片直接删，不留归档 |
| `KHY_LOG_KEEP_DAYS` | `7` | `.khy/logs` 的保留天数 |
| `KHY_LOG_MAX_FILES` / `KHY_LOG_MAX_SIZE_BYTES` | 见 `serviceDefaults.js` | 日志归档的数量与总量上限 |
| `KHY_FOOTPRINT_NOTICE_MB` | `500` | 体积自检的提示阈值 |
| `KHY_FOOTPRINT_NOTICE` | 开 | 设 `0` 只算不提示 |
| `KHY_LIFECYCLE_RUNTIMEFOOTPRINTNOTICE` | 开 | 设 `off` 整条关掉（轻量模式的滚动 + 自检） |

真源在 `services/backend/src/constants/serviceDefaults.js` 的 `AUDIT` / `LOGS` / `RUNTIME_FOOTPRINT` 三张冻结表。

---

## 归档怎么取回

过期的 `audit/sessions/*.jsonl` 不是直接删，而是**整批**折成一份
`audit/archive/sessions-<日期>.jsonl.gz` 之后才删原件。按批而不是逐文件是刻意的：
这个目录真正贵的成本在文件数（实测 2,483 个分片才 14.8 MB，每个文件一次 stat 一个 inode），
逐文件 gz 只换字节不换文件数。

取回内容：

```bash
node -e "process.stdout.write(require('zlib').gunzipSync(require('fs').readFileSync(process.argv[1])))" ~/.khy/audit/archive/sessions-2026-08-16.jsonl.gz > out.jsonl
```

每一行都带一个 `_source` 字段指回它原本所属的分片文件名，非 JSON 的坏行包成
`{"_source": "...", "_raw": "原始文本"}`，不静默丢弃。

归档写不出去（磁盘满、目录只读、`archive` 位置被普通文件占位）时**不删原件**——宁可
留着占地方，也不能让证据在没有副本的情况下消失。

**唯一不可逆的一档**是被 `KHY_AUDIT_MAX_TOTAL_MB` 封顶删掉的旧归档，删了就取不回来。
所以它的默认值给到 200 MB，而实测 `audit` 整个目录只有 14.8 MB——正常使用下永远碰不到这条线。

---

## 启动体积自检（只报不删）

`.khy/` 超过 `KHY_FOOTPRINT_NOTICE_MB` 时，启动时打一行提示，形如：

```
ℹ 已统计 <数据家目录>\.khy：占用 74.2 MB，超过提示阈值 50.0 MB（最大三项: checkpoints 49.7 MB、
  audit 10.6 MB、logs 3.1 MB）。可运行 khy clean --runtime --dry-run 查看可回收的 15.3 MB；
  会话存档与工作区快照不在其中，不会被清掉。
```

**它不会删任何东西**，执行权留给用户。理由是不对称的：`.khy` 下躺着
`checkpoints/`（未提交改动的 git diff 补丁与 tar.gz）、`sessions/`（对话存档）、
`credentials/`、`api_keys.json`——自动清理一旦判错就是不可逆的损失，而多占几百 MB 是可逆的。

提示里报的「可回收」只统计 `khy clean --runtime` 白名单里那几个目录
（`logs` / `audit` / `tmp` / `cache` / `break-cache` / `change-watch`），
必须与那条命令实际会删的一致，否则用户跑完发现数字对不上，下一次就不信这个提示了。

以下两处**故意不在任何自动删除或「清全部」档位里**，只能显式点名：

- `.khy/checkpoints` —— 工作区快照，里面是未提交的代码改动，删掉即永久丢失（需 `khy clean --checkpoints`）。
- `.khy/audit-trajectory` —— 外部质检要逐行解析的审计记录，契约规定任何情况下都不压缩、不裁剪、不摘要，本文所有轮转策略都不适用于它。

---

## 旧版数据清理

### Linux / macOS

```bash
# 查看占用
du -sh ~/.khyquant/checkpoints/ ~/.khy/audit/

# 清理检查点
rm -rf ~/.khyquant/checkpoints/

# 清理全部旧审计数据
rm -rf ~/.khy/audit/sessions/ ~/.khy/audit/summaries/ ~/.khy/audit/exports/
truncate -s 0 ~/.khy/audit/trace-events.jsonl
```

### Windows (PowerShell)

```powershell
# 查看 .khyquant 各子目录占用
Get-ChildItem "$env:USERPROFILE\.khyquant" -Directory |
  ForEach-Object {
    $size = (Get-ChildItem $_.FullName -Recurse -ErrorAction SilentlyContinue |
             Measure-Object -Property Length -Sum).Sum
    "{0,10:N1} MB  {1}" -f ($size/1MB), $_.Name
  }

# 查看检查点占用
Get-ChildItem "$env:USERPROFILE\.khyquant\checkpoints" -Recurse |
  Measure-Object -Property Length -Sum |
  ForEach-Object { "{0:N2} GB" -f ($_.Sum / 1GB) }

# 删除全部检查点
Remove-Item "$env:USERPROFILE\.khyquant\checkpoints" -Recurse -Force

# 删除旧审计数据
Remove-Item "$env:USERPROFILE\.khy\audit\sessions" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.khy\audit\summaries" -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item "$env:USERPROFILE\.khy\audit\exports" -Recurse -Force -ErrorAction SilentlyContinue
Set-Content "$env:USERPROFILE\.khy\audit\trace-events.jsonl" ""
```

### 判断是否需要清理

如果以下任一情况出现，建议手动清理：

- `~/.khyquant/checkpoints/` 超过 500 MB
- `~/.khy/audit/` 超过 50 MB
- 磁盘使用率超过 80%

升级到包含此修复的版本后，系统会在启动时自动执行清理，后续无需手动干预。

---

## 开发注意事项

新增任何写磁盘的功能时，必须回答以下问题：

1. **是追加还是覆写？** 追加模式必须设轮转上限
2. **文件是否会累积？** 多文件模式必须设 TTL 或数量上限
3. **最坏情况多大？** 计算 `单次写入量 × 最大频率 × 无人干预天数`
4. **清理谁负责？** 写入 cleanupService 的 `runCleanup()` 流程中

违反以上规则的 PR 应被拒绝。
