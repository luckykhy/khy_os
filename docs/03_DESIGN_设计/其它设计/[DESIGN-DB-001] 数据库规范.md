# [DESIGN-DB-001] 数据库规范

> 本文档定义 khy-os 项目的数据库设计标准，包括命名、迁移、查询等规范。

---

## 1. 数据库概述

### 1.1 支持的数据库

| 数据库 | 用途 | 配置 |
|--------|------|------|
| SQLite | 开发/测试环境 | 默认 |
| PostgreSQL | 生产环境 | 推荐 |

### 1.2 设计原则

1. **一致性**：所有数据库对象使用统一的命名规范
2. **可迁移性**：支持从 SQLite 迁移到 PostgreSQL
3. **版本控制**：所有变更通过迁移脚本管理
4. **安全性**：敏感数据加密存储

---

## 2. 命名规范

### 2.1 表名

**规则**：
- 使用小写字母
- 使用下划线分隔单词
- 使用复数形式

**示例**：
```
users
user_profiles
trading_strategies
order_items
```

### 2.2 列名

**规则**：
- 使用小写字母
- 使用下划线分隔单词
- 避免使用保留字

**示例**：
```
id
username
email
created_at
updated_at
```

### 2.3 索引名

**规则**：
```
idx_{table}_{column}
```

**示例**：
```
idx_users_email
idx_users_username
idx_orders_user_id
```

### 2.4 约束名

**规则**：
```
pk_{table}_{column}     -- 主键
fk_{table}_{column}     -- 外键
uq_{table}_{column}     -- 唯一约束
ck_{table}_{condition}  -- 检查约束
```

**示例**：
```
pk_users_id
fk_orders_user_id
uq_users_email
```

---

## 3. 数据类型

### 3.1 整数类型

| 类型 | 范围 | 用途 |
|------|------|------|
| INTEGER | -2^31 到 2^31-1 | 主键、外键、计数 |
| BIGINT | -2^63 到 2^63-1 | 大数值、时间戳 |

### 3.2 字符串类型

| 类型 | 最大长度 | 用途 |
|------|---------|------|
| VARCHAR(50) | 50 字符 | 用户名、短文本 |
| VARCHAR(255) | 255 字符 | 邮箱、URL |
| TEXT | 无限制 | 长文本、JSON |

### 3.3 日期时间类型

| 类型 | 精度 | 用途 |
|------|------|------|
| TIMESTAMP | 秒 | 创建时间、更新时间 |
| TIMESTAMPTZ | 秒（带时区） | 跨时区时间 |

### 3.4 布尔类型

| 类型 | 值 | 用途 |
|------|-----|------|
| BOOLEAN | true/false | 状态标志 |

### 3.5 JSON 类型

| 类型 | 用途 |
|------|------|
| JSONB | 配置、元数据 |

---

## 4. 表设计规范

### 4.1 必需列

每张表必须包含以下列：

```sql
id          INTEGER PRIMARY KEY AUTOINCREMENT,
created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
```

### 4.2 表定义示例

```sql
CREATE TABLE users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    VARCHAR(50) NOT NULL UNIQUE,
    email       VARCHAR(255) NOT NULL UNIQUE,
    password    VARCHAR(255) NOT NULL,
    role        VARCHAR(20) DEFAULT 'user',
    status      VARCHAR(20) DEFAULT 'active',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_username ON users(username);
```

### 4.3 外键约束

```sql
CREATE TABLE orders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    total       DECIMAL(10, 2) NOT NULL,
    status      VARCHAR(20) DEFAULT 'pending',
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_orders_user_id ON orders(user_id);
```

---

## 5. 迁移规范

### 5.1 迁移文件命名

**格式**：
```
YYYYMMDDHHMMSS_{description}.js
```

**示例**：
```
20260904120000_create_users_table.js
20260904130000_add_email_index.js
20260904140000_add_user_profile_table.js
```

### 5.2 迁移文件结构

```javascript
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('users', {
      id: {
        type: Sequelize.INTEGER,
        primaryKey: true,
        autoIncrement: true
      },
      username: {
        type: Sequelize.STRING(50),
        allowNull: false,
        unique: true
      },
      email: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true
      },
      password: {
        type: Sequelize.STRING(255),
        allowNull: false
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal('CURRENT_TIMESTAMP')
      }
    });

    await queryInterface.addIndex('users', ['email']);
    await queryInterface.addIndex('users', ['username']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('users');
  }
};
```

### 5.3 迁移执行

**执行迁移**：
```bash
npx sequelize-cli db:migrate
```

**回滚迁移**：
```bash
npx sequelize-cli db:migrate:undo
```

**查看迁移状态**：
```bash
npx sequelize-cli db:migrate:status
```

### 5.4 迁移记录表

迁移系统会自动创建 `SequelizeMeta` 表来记录已执行的迁移：

```sql
CREATE TABLE SequelizeMeta (
    name VARCHAR(255) NOT NULL PRIMARY KEY
);
```

---

## 6. 查询规范

### 6.1 基本查询

```javascript
// 查询单条记录
const user = await User.findOne({
  where: { id: 123 }
});

// 查询多条记录
const users = await User.findAll({
  where: { status: 'active' },
  order: [['createdAt', 'DESC']],
  limit: 20,
  offset: 0
});

// 查询特定字段
const users = await User.findAll({
  attributes: ['id', 'username', 'email'],
  where: { status: 'active' }
});
```

### 6.2 关联查询

```javascript
// 一对一关联
const user = await User.findOne({
  where: { id: 123 },
  include: [{
    model: UserProfile,
    as: 'profile'
  }]
});

// 一对多关联
const user = await User.findOne({
  where: { id: 123 },
  include: [{
    model: Order,
    as: 'orders'
  }]
});

// 多对多关联
const strategies = await Strategy.findAll({
  include: [{
    model: Tag,
    through: { attributes: [] }
  }]
});
```

### 6.3 聚合查询

```javascript
// 计数
const count = await User.count({
  where: { status: 'active' }
});

// 求和
const total = await Order.sum('total', {
  where: { userId: 123 }
});

// 平均值
const avg = await Order.avg('total');

// 分组统计
const stats = await Order.findAll({
  attributes: [
    'status',
    [Sequelize.fn('COUNT', Sequelize.col('id')), 'count'],
    [Sequelize.fn('SUM', Sequelize.col('total')), 'total']
  ],
  group: ['status']
});
```

### 6.4 事务处理

```javascript
const transaction = await sequelize.transaction();

try {
  const user = await User.create({
    username: 'john',
    email: 'john@example.com'
  }, { transaction });

  await Order.create({
    userId: user.id,
    total: 100.00
  }, { transaction });

  await transaction.commit();
} catch (error) {
  await transaction.rollback();
  throw error;
}
```

---

## 7. 索引规范

### 7.1 索引类型

| 类型 | 用途 |
|------|------|
| 主键索引 | 唯一标识记录 |
| 唯一索引 | 确保数据唯一性 |
| 普通索引 | 加速查询 |
| 复合索引 | 加速多列查询 |

### 7.2 索引设计原则

1. **主键必须有索引**
2. **外键必须有索引**
3. **频繁查询的列创建索引**
4. **唯一约束的列创建索引**
5. **避免过度索引**（影响写入性能）

### 7.3 复合索引设计

**最左前缀原则**：
```sql
-- 复合索引 (a, b, c)
CREATE INDEX idx_abc ON table_name(a, b, c);

-- 可以使用索引的查询：
SELECT * FROM table_name WHERE a = 1;
SELECT * FROM table_name WHERE a = 1 AND b = 2;
SELECT * FROM table_name WHERE a = 1 AND b = 2 AND c = 3;

-- 无法使用索引的查询：
SELECT * FROM table_name WHERE b = 2;
SELECT * FROM table_name WHERE c = 3;
```

---

## 8. 安全规范

### 8.1 敏感数据加密

```javascript
// 密码加密
const bcrypt = require('bcrypt');
const saltRounds = 10;

const hashPassword = async (password) => {
  return bcrypt.hash(password, saltRounds);
};

const verifyPassword = async (password, hash) => {
  return bcrypt.compare(password, hash);
};
```

### 8.2 SQL 注入防护

```javascript
// ✅ 正确：使用参数化查询
const users = await sequelize.query(
  'SELECT * FROM users WHERE id = :id',
  {
    replacements: { id: userId },
    type: QueryTypes.SELECT
  }
);

// ❌ 错误：字符串拼接
const users = await sequelize.query(
  `SELECT * FROM users WHERE id = ${userId}`
);
```

### 8.3 数据脱敏

```javascript
// toJSON 方法脱敏
User.prototype.toJSON = function() {
  const values = Object.assign({}, this.get());
  delete values.password;
  delete values.securityAnswer;
  return values;
};
```

---

## 9. 备份与恢复

### 9.1 备份策略

| 类型 | 频率 | 保留时间 |
|------|------|---------|
| 全量备份 | 每日 | 30 天 |
| 增量备份 | 每小时 | 7 天 |

### 9.2 SQLite 备份

```bash
# 备份
sqlite3 data.db ".backup backup_$(date +%Y%m%d).db"

# 恢复
sqlite3 data.db < backup_20260904.db
```

### 9.3 PostgreSQL 备份

```bash
# 备份
pg_dump -U username -d dbname > backup_$(date +%Y%m%d).sql

# 恢复
psql -U username -d dbname < backup_20260904.sql
```

---

## 10. 性能优化

### 10.1 查询优化

1. **避免 SELECT ***：只查询需要的字段
2. **使用 LIMIT**：限制返回的记录数
3. **使用索引**：加速查询
4. **避免 N+1 查询**：使用关联查询

### 10.2 连接池配置

```javascript
const sequelize = new Sequelize(database, username, password, {
  host: 'localhost',
  dialect: 'postgres',
  pool: {
    max: 20,
    min: 5,
    acquire: 30000,
    idle: 10000
  }
});
```

### 10.3 慢查询日志

```javascript
const sequelize = new Sequelize(database, username, password, {
  logging: (msg) => {
    if (msg.includes('slow query')) {
      logger.warn(msg);
    }
  }
});
```

---

## 11. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-04 | 初始版本，定义数据库规范 |

---

*本规范由 khy-os 数据库团队维护*