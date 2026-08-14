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
| audit/sessions/ | `~/.khy/audit/sessions/*.jsonl` | 每会话一个文件 | **7 天自动清除** |
| audit/summaries/ | `~/.khy/audit/summaries/*` | 每会话两个文件 | **上限 50 个文件** |
| audit/exports/ | `~/.khy/audit/exports/*` | 导出时产生 | **上限 10 个文件** |
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

```
启动 → 3 秒后首次全量清理（19 个目标）
     → 之后每 2 小时自动巡检
     → 进程退出时停止定时器
```

入口: `bootstrap/prefetch.js` → `cleanupService.runCleanup({ trigger: 'startup' })` → `startPeriodicCleanup()`

手动触发: CLI 中执行 `khy cleanup` 或 `khy settings` 中查看存储报告。

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
