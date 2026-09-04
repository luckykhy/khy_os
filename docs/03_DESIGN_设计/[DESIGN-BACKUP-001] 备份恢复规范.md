# [DESIGN-BACKUP-001] 备份恢复规范

> 本文档定义 khy-os 项目的备份恢复标准，包括备份策略、恢复流程、数据保留等。

---

## 1. 备份概述

### 1.1 备份原则

1. **完整性**：确保备份数据的完整性
2. **可恢复性**：确保备份可以成功恢复
3. **及时性**：定期执行备份
4. **安全**：备份数据加密存储

### 1.2 备份类型

| 类型 | 说明 | 频率 |
|------|------|------|
| 全量备份 | 完整备份所有数据 | 每日 |
| 增量备份 | 备份变更数据 | 每小时 |
| 差异备份 | 备份自上次全量备份后的变更 | 每 6 小时 |

---

## 2. 备份策略

### 2.1 数据库备份

**SQLite 备份**：
```bash
#!/bin/bash
# backup-sqlite.sh

BACKUP_DIR="/backups/database"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_FILE="./data/production.db"

# 创建备份
sqlite3 "$DB_FILE" ".backup $BACKUP_DIR/db_$TIMESTAMP.db"

# 压缩备份
gzip $BACKUP_DIR/db_$TIMESTAMP.db

# 清理旧备份（保留 30 天）
find $BACKUP_DIR -name "*.db.gz" -mtime +30 -delete
```

**PostgreSQL 备份**：
```bash
#!/bin/bash
# backup-postgres.sh

BACKUP_DIR="/backups/database"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# 全量备份
pg_dump -U khyos -Fc khyos > $BACKUP_DIR/db_$TIMESTAMP.dump

# 压缩备份
gzip $BACKUP_DIR/db_$TIMESTAMP.dump

# 清理旧备份
find $BACKUP_DIR -name "*.dump.gz" -mtime +30 -delete
```

### 2.2 文件备份

```bash
#!/bin/bash
# backup-files.sh

BACKUP_DIR="/backups/files"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
SOURCE_DIRS=(
  "./data"
  "./.khy"
  "./logs"
)

# 创建备份
tar -czf $BACKUP_DIR/files_$TIMESTAMP.tar.gz "${SOURCE_DIRS[@]}"

# 清理旧备份
find $BACKUP_DIR -name "*.tar.gz" -mtime +30 -delete
```

### 2.3 备份时间表

| 备份类型 | 时间 | 保留时间 |
|---------|------|---------|
| 全量备份 | 每天 02:00 | 30 天 |
| 增量备份 | 每小时 | 7 天 |
| 配置文件 | 每天 03:00 | 90 天 |

---

## 3. 恢复策略

### 3.1 恢复目标

| 指标 | 目标 |
|------|------|
| RTO（恢复时间目标） | < 1 小时 |
| RPO（恢复点目标） | < 1 小时 |

### 3.2 数据库恢复

**SQLite 恢复**：
```bash
#!/bin/bash
# restore-sqlite.sh

BACKUP_FILE=$1
DB_FILE="./data/production.db"

# 停止应用
sudo systemctl stop khyos

# 解压备份
gunzip -c $BACKUP_FILE > $DB_FILE

# 启动应用
sudo systemctl start khyos
```

**PostgreSQL 恢复**：
```bash
#!/bin/bash
# restore-postgres.sh

BACKUP_FILE=$1

# 停止应用
sudo systemctl stop khyos

# 恢复数据库
gunzip -c $BACKUP_FILE | psql -U khyos khyos

# 启动应用
sudo systemctl start khyos
```

### 3.3 文件恢复

```bash
#!/bin/bash
# restore-files.sh

BACKUP_FILE=$1

# 解压备份
tar -xzf $BACKUP_FILE -C /
```

---

## 4. 备份验证

### 4.1 验证策略

| 类型 | 频率 | 说明 |
|------|------|------|
| 完整性检查 | 每次备份后 | 验证备份文件完整性 |
| 恢复测试 | 每周 | 测试备份是否可以恢复 |
| 数据一致性 | 每月 | 验证数据一致性 |

### 4.2 验证脚本

```bash
#!/bin/bash
# verify-backup.sh

BACKUP_FILE=$1

# 检查文件是否存在
if [ ! -f "$BACKUP_FILE" ]; then
  echo "ERROR: Backup file not found"
  exit 1
fi

# 检查文件大小
FILE_SIZE=$(stat -f%z "$BACKUP_FILE")
if [ $FILE_SIZE -eq 0 ]; then
  echo "ERROR: Backup file is empty"
  exit 1
fi

# 检查文件完整性（SQLite）
if [[ "$BACKUP_FILE" == *.db.gz ]]; then
  gunzip -t "$BACKUP_FILE"
  if [ $? -ne 0 ]; then
    echo "ERROR: Backup file is corrupted"
    exit 1
  fi
fi

echo "Backup verification passed"
```

---

## 5. 数据保留

### 5.1 保留策略

| 数据类型 | 保留时间 | 说明 |
|---------|---------|------|
| 全量备份 | 30 天 | 每日全量备份 |
| 增量备份 | 7 天 | 每小时增量备份 |
| 配置文件 | 90 天 | 每日备份 |
| 日志文件 | 30 天 | 自动轮转 |

### 5.2 清理策略

```bash
#!/bin/bash
# cleanup-backups.sh

# 清理数据库备份
find /backups/database -name "*.db.gz" -mtime +30 -delete
find /backups/database -name "*.dump.gz" -mtime +30 -delete

# 清理文件备份
find /backups/files -name "*.tar.gz" -mtime +30 -delete

# 清理日志
find /var/log/khyos -name "*.log.*" -mtime +30 -delete
```

---

## 6. 存储策略

### 6.1 存储位置

| 位置 | 说明 | 用途 |
|------|------|------|
| 本地磁盘 | 快速访问 | 近期备份 |
| 远程存储 | 灾难恢复 | 重要备份 |
| 异地存储 | 灾难恢复 | 关键数据 |

### 6.2 加密存储

```bash
#!/bin/bash
# encrypt-backup.sh

BACKUP_FILE=$1
ENCRYPTED_FILE="$BACKUP_FILE.enc"

# 使用 AES-256 加密
openssl enc -aes-256-cbc -salt -in $BACKUP_FILE -out $ENCRYPTED_FILE -pass file:/etc/khyos/backup-key

# 删除未加密文件
rm $BACKUP_FILE
```

---

## 7. 灾难恢复

### 7.1 灾难恢复流程

1. **评估**：评估灾难影响范围
2. **通知**：通知相关人员
3. **恢复**：执行恢复流程
4. **验证**：验证数据完整性
5. **恢复服务**：恢复服务运行

### 7.2 灾难恢复计划

```markdown
# 灾难恢复计划

## 场景：数据库完全损坏

### 恢复步骤
1. 停止应用服务
2. 准备新的数据库服务器
3. 恢复最近的全量备份
4. 恢复增量备份
5. 验证数据完整性
6. 启动应用服务
7. 验证服务运行状态

### 预计恢复时间
- 全量备份恢复：30 分钟
- 增量备份恢复：15 分钟
- 验证和启动：15 分钟
- 总计：1 小时
```

---

## 8. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义备份恢复规范 |

---

*本规范由 khy-os 运维团队维护*