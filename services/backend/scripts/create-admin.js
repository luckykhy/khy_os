/**
 * @pattern Command, Template Method
 */
﻿// 创建默认管理员账号
// 在数据库初始化后自动运行

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'quant_trading',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'KOHAYU0203'
});

async function createDefaultAdmin() {
  const client = await pool.connect();
  
  try {
    console.log('========================================');
    console.log('  创建默认管理员账号');
    console.log('========================================\n');
    
    // 生成密码哈希
    const adminPasswordHash = await bcrypt.hash('admin123', 10);
    
    // 创建管理员账号（如果不存在）
    const adminResult = await client.query(`
      INSERT INTO users (username, password, email, role, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (username) 
      DO UPDATE SET 
        password = EXCLUDED.password,
        role = EXCLUDED.role,
        email = EXCLUDED.email,
        updated_at = NOW()
      RETURNING id, username, role
    `, ['admin', adminPasswordHash, 'admin@khy-quant.com', 'admin', 'active']);
    
    console.log('✅ 管理员账号已创建/更新');
    console.log(`   用户名: admin`);
    console.log(`   密码: admin123`);
    console.log(`   角色: 管理员`);
    console.log(`   ID: ${adminResult.rows[0].id}\n`);
    
    console.log('========================================');
    console.log('  完成');
    console.log('========================================\n');
    
  } catch (error) {
    console.error('❌ 创建管理员失败:', error.message);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  createDefaultAdmin()
    .then(() => {
      console.log('✅ 默认管理员创建成功！');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ 错误:', error);
      process.exit(1);
    });
}

module.exports = { createDefaultAdmin };
