# [DESIGN-MIG-001] 数据迁移规范

<!-- RULES-REGISTRY: MIG-001 -->

> **用途**：定义 khy-os 数据库迁移的标准流程，确保结构变更安全、可回滚、可审查。
> DB-001 §5 已有基础迁移概念，本文档补全流程细节。

---

## 1. 原则

1. **每次变更一个迁移**：一个迁移文件只做一件事
2. **可回滚**：每个迁移必须带 `down` 函数
3. **不可逆向破坏**：`down` 可能丢失数据时，禁止自动回滚
4. **代码审查**：迁移文件必须走 PR 审查
5. **生产禁自动**：生产环境不自动执行迁移，必须人工确认

---

## 2. 迁移文件命名

```
{VERSION}_{DESCRIPTION}.js
```

| 规则 | 说明 |
|------|------|
| 版本号 | 时间戳 `YYYYMMDDHHMMSS`（sequelize 要求） |
| 描述 | snake_case，动词开头 |
| 长度 | 文件名 ≤ 80 字符 |

```bash
20260910120000_create_users_table.js
20260910130000_add_email_index_to_users.js
20260910140000_add_role_column_to_users.js
```

---

## 3. 迁移结构

### 3.1 标准模板

```javascript
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // 变更逻辑
    await queryInterface.addColumn('users', 'role', {
      type: Sequelize.STRING(20),
      defaultValue: 'user',
      allowNull: false
    });
  },

  async down(queryInterface, Sequelize) {
    // 回滚逻辑
    await queryInterface.removeColumn('users', 'role');
  }
};
```

### 3.2 必须成对

| up 操作 | down 操作 |
|---------|----------|
| `createTable` | `dropTable` |
| `addColumn` | `removeColumn` |
| `removeColumn` | `addColumn`（带原定义） |
| `addIndex` | `removeIndex` |
| `changeColumn` | `changeColumn`（原定义） |
| `renameColumn` | `renameColumn`（原名称） |
| `bulkInsert` | `bulkDelete`（按条件） |

---

## 4. 安全约束

### 4.1 禁止操作

| 禁止 | 原因 |
|------|------|
| 迁移中删除列 | 可能丢失数据 |
| 迁移中修改列类型 | 可能截断数据 |
| 迁移中大表重命名 | 长时间锁表 |
| 迁移中批量更新（无 WHERE） | 不可回滚 |

### 4.2 大表处理

```javascript
// ❌ 错误 — 一次性更新百万行
await queryInterface.bulkUpdate('orders', { status: 'archived' }, {});

// ✅ 正确 — 分批处理
async function migrateInBatches(queryInterface, batchSize = 1000) {
  let processed = 0;
  while (true) {
    const result = await queryInterface.bulkUpdate('orders', 
      { status: 'archived' },
      { status: 'pending', id: { [Op.lt]: processed + batchSize } }
    );
    if (result.count === 0) break;
    processed += result.count;
    logger.info(`Migrated ${processed} rows`);
    await sleep(100);  // 让出 CPU
  }
}
```

### 4.3 不可逆操作

对于会丢失数据的操作，`down` 改为数据备份：

```javascript
async up(queryInterface, Sequelize) {
  // 先备份
  const rows = await queryInterface.sequelize.query(
    'SELECT * FROM users WHERE role = ?',
    { replacements: ['temp_user'], type: QueryTypes.SELECT }
  );
  await fs.promises.writeFile(
    `migrations/backups/20260910_drop_temp_users.json`,
    JSON.stringify(rows)
  );
  
  // 再删除
  await queryInterface.bulkDelete('users', { role: 'temp_user' });
}

async down(queryInterface, Sequelize) {
  // 从备份恢复
  const rows = JSON.parse(
    await fs.promises.readFile('migrations/backups/20260910_drop_temp_users.json')
  );
  await queryInterface.bulkInsert('users', rows);
}
```

---

## 5. 执行流程

### 5.1 开发环境

```bash
# 执行所有待处理迁移
npx sequelize-cli db:migrate

# 回滚最后一步
npx sequelize-cli db:migrate:undo

# 查看状态
npx sequelize-cli db:migrate:status
```

### 5.2 生产环境

```bash
# 1. 先备份
pg_dump -U khy khy_prod > backup_before_migrate_$(date +%Y%m%d).sql

# 2. 预览变更
npx sequelize-cli db:migrate:status

# 3. 人工确认后执行
npx sequelize-cli db:migrate

# 4. 验证
npx sequelize-cli db:migrate:status
```

### 5.3 CI/CD

生产迁移**必须**：
1. 有 DBA 或资深开发者审批
2. 迁移在低峰期执行
3. 执行前自动备份
4. 失败自动回滚

---

## 6. 迁移审查清单

```markdown
- [ ] 迁移文件命名符合规范（时间戳 + 描述）
- [ ] up 和 down 都实现了
- [ ] down 能正确恢复数据（在测试环境验证过）
- [ ] 不涉及不可逆数据丢失
- [ ] 大表操作使用分批处理
- [ ] 添加了必要的索引
- [ ] 迁移时间预估 < 30 秒（大表除外）
- [ ] 在测试环境验证通过
```

---

## 7. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 1.0.0 | 2026-09-10 | 初始版本，定义数据迁移规范 |

---

*本规范由 khy-os 平台团队维护*
