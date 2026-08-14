/**
 * 添加平仓相关字段到 trades 表
 * @pattern Command
 */
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'khy_quant',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres'
});

async function migrate() {
  const client = await pool.connect();
  
  try {
    console.log('========================================');
    console.log('开始执行数据库迁移...');
    console.log('========================================\n');

    // 开始事务
    await client.query('BEGIN');

    // 添加 is_closed 字段
    console.log('1. 添加 is_closed 字段...');
    await client.query(`
      ALTER TABLE trades 
      ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT FALSE
    `);
    console.log('   ✅ is_closed 字段添加成功\n');

    // 添加 closed_at 字段
    console.log('2. 添加 closed_at 字段...');
    await client.query(`
      ALTER TABLE trades 
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMP
    `);
    console.log('   ✅ closed_at 字段添加成功\n');

    // 添加 closed_quantity 字段
    console.log('3. 添加 closed_quantity 字段...');
    await client.query(`
      ALTER TABLE trades 
      ADD COLUMN IF NOT EXISTS closed_quantity DECIMAL(15, 4)
    `);
    console.log('   ✅ closed_quantity 字段添加成功\n');

    // 添加 related_trade_id 字段
    console.log('4. 添加 related_trade_id 字段...');
    await client.query(`
      ALTER TABLE trades 
      ADD COLUMN IF NOT EXISTS related_trade_id INTEGER
    `);
    console.log('   ✅ related_trade_id 字段添加成功\n');

    // 添加 profit 字段
    console.log('5. 添加 profit 字段...');
    await client.query(`
      ALTER TABLE trades 
      ADD COLUMN IF NOT EXISTS profit DECIMAL(15, 2)
    `);
    console.log('   ✅ profit 字段添加成功\n');

    // 创建索引
    console.log('6. 创建索引...');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_is_closed 
      ON trades(is_closed)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_trades_related_trade_id 
      ON trades(related_trade_id)
    `);
    console.log('   ✅ 索引创建成功\n');

    // 提交事务
    await client.query('COMMIT');

    console.log('========================================');
    console.log('✅ 数据库迁移执行成功！');
    console.log('========================================');
    console.log('\n所有平仓相关字段已添加到 trades 表');
    console.log('现在可以重启后端服务使用平仓功能了\n');

  } catch (error) {
    // 回滚事务
    await client.query('ROLLBACK');
    
    console.error('\n========================================');
    console.error('❌ 数据库迁移执行失败！');
    console.error('========================================');
    console.error('错误信息:', error.message);
    console.error('\n请检查：');
    console.error('1. PostgreSQL 服务是否正在运行');
    console.error('2. 数据库连接配置是否正确');
    console.error('3. 数据库用户是否有足够权限\n');
    
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

// 执行迁移
migrate().catch(error => {
  console.error('迁移脚本执行失败:', error);
  process.exit(1);
});
