# 任务三验收证据 — SQLite 数据库损坏自愈

测试日期: 2026-08-17

## 验收标准 1: truncate 一半后自动 recover — PASSED

**脚本**: `verify-db-health.js`（兼容入口: `verify-criterion-1-wal.js`）

**测试方法**: 创建名为 `sessions.db` 的数据库（`sessions` 100 条、`meta` 20 条），关闭后将主文件截断一半。调用 `dbHealthService.healDatabase()`，要求恢复后 `quick_check` 通过、`sessions` 仍有可读记录，并且统一审计日志严格包含 `recover 模式，恢复 N/M 条记录`。

**2026-08-17 实测关键输出**:

```text
创建测试数据库: ...\sessions.db, 28672 bytes, 120 条记录
损坏数据库: 截断到 14336 bytes
损坏检测: ok=false error=Integrity check error: database disk image is malformed
[warn] WAL checkpoint failed ... database disk image is malformed
[warn] sqlite3 CLI .recover unavailable ... falling back to native salvage
[info] 修复数据库 sessions.db(recover 模式，恢复 31/33 条记录)
✓ 验收标准1: PASSED
  修复后完整性: ok=true
  修复后 sessions 表可读记录: 31
```

本机没有 `sqlite3` CLI，因此测试同时验证了内置原生 salvage：在副本上修复截断文件头、重建 schema、按 rowid 跳过损坏页复制可读行，再用 `quick_check` 验证重建库。`M` 是损坏文件仍可观测的 rowid 边界，不把连续坏页读取错误虚算为多条记录。

## 验收标准 2: 从最近备份恢复 — PASSED

**脚本**: `verify-criterion-2-backup.js`

**测试方法**: 在临时目录创建 50 条记录的 `sessions.db`，将健康副本写入 `checkpoints/sessions.2026-08-17T12-00-00.db`，再用非 SQLite 数据覆盖主库。调用完整恢复级联，要求先失败于 WAL/recover，随后从 checkpoint 恢复，核对审计时间、完整性和记录数。

**2026-08-17 实测关键输出**:

```text
[warn] WAL checkpoint failed ... file is not a database
[warn] .recover failed ... not a SQLite file header
[info] 从备份恢复 sessions.db，备份时间 2026-08-17T12-00-00
恢复后完整性: true; sessions: 50
✓ 验收标准2: PASSED
```

恢复端同时扫描 `.khy/checkpoints`、数据库旁的 `checkpoints` 和正常退出产生的 `db_backup`，按时间从新到旧尝试，并跳过完整性检查失败的候选。

## 验收标准 3: WAL 总体积不超过 3 倍 — PASSED

**脚本**: `verify-criterion-3-wal-size.js`

**测试方法**: 通过应用 SQLite adapter 创建 WAL 数据库，关闭自动 checkpoint，先建立 1.47 MiB 主库基线，再以 2400 次独立更新将 WAL 扩大至 6.40 倍。测试直接调用 `dbHealthService._performPeriodicCheckpoint()`；服务先执行规范要求的 `PASSIVE`，检测比例超过 3 后追加 `TRUNCATE`。

**2026-08-17 实测关键输出**:

```text
WAL file for taskboard.db is 6.4x larger than database; truncating
维护前 WAL/DB: 6.40x
服务结果: {"ok":true,"mode":"wal","checkpoint":[{"busy":0,"log":2400,"checkpointed":2400}],"finalWalSize":0}
维护后 (DB+WAL)/原始 DB: 1.00x
✓ 验收标准3: PASSED
```

## 正常退出热备份与保留策略 — PASSED

**脚本**: `verify-shutdown-backup.js`

**测试方法**: 对 WAL 模式 `sessions.db` 连续模拟 5 次正常退出备份。每次调用生产 `shutdownBackup()` 热拷贝路径，随后检查备份 `quick_check`、40 条记录完整性、恢复端兼容的时间戳命名，以及只保留最新 3 份。

**2026-08-17 实测关键输出**:

```text
备份结果: 5/5 success
保留文件: sessions.2026-08-12T12-00-00.db,
          sessions.2026-08-13T12-00-00.db,
          sessions.2026-08-14T12-00-00.db
完整性与记录数: 通过
✓ 正常退出备份: PASSED
```

## 审计语义

统一审计目标使用 `dbPath || dbName || 'unknown'`，避免成功修复记录因空 target 被丢弃。阶段失败记录为 `result: "failure"`，即使恢复级联继续；只有最终成功步骤写 `result: "success"`。因此审计既能反映完整尝试链，也不会把 warn 级失败误报为成功。
