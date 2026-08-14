/**
 * @pattern Command, Template Method
 */
// 创建默认管理员账号
// 在数据库初始化后自动运行

const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const credGen = require('../src/services/credentialGenerator');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'quant_trading',
  user: process.env.DB_USER || 'postgres',
  // No hardcoded fallback — DB password must come from the environment.
  password: process.env.DB_PASSWORD || '',
});

async function createDefaultAdmin() {
  const client = await pool.connect();

  try {
    console.log('========================================');
    console.log('  创建默认管理员账号');
    console.log('========================================\n');

    // Credentials from the unified generator (OS-user derived username +
    // machine-derived password persisted under .khy/credentials/).
    const creds = credGen.loadOrCreateDefaultAdminCredentials();
    const adminPasswordHash = await bcrypt.hash(creds.password, 10);

    // Create the admin account only when absent — never overwrite an
    // existing account's password or fields.
    const adminResult = await client.query(
      `
      INSERT INTO users (username, password, email, role, status, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
      ON CONFLICT (username) DO NOTHING
      RETURNING id, username, role
    `,
      [creds.username, adminPasswordHash, 'admin@khy-quant.com', 'admin', 'active']
    );

    if (adminResult.rows.length > 0) {
      console.log(`✅ 已生成初始管理员 ${creds.username}，ID: ${adminResult.rows[0].id}`);
      if (creds.fromEnv) {
        console.log('   密码来自环境变量，未写入凭据文件\n');
      } else {
        console.log(
          `   密码已保存至 ${creds.filePath || '(写入失败，请设置 KHY_ADMIN_PASSWORD 后重跑)'}\n`
        );
      }
    } else {
      console.log(`ℹ️ 管理员账号已存在（用户名: ${creds.username}），未修改密码与任何字段`);
      console.log(`   如需查看初始密码，请打开 ${credGen.getDefaultAdminCredentialsPath()}\n`);
    }

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
