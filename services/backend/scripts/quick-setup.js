/**
 * Quick setup script - Create default admin credentials for CLI auto-login
 * This is a simplified version that only creates the admin account
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

async function quickSetup() {
  console.log('🔧 Khy-OS Quick Setup - Creating Default Admin');
  console.log('');

  try {
    // Initialize database
    const db = require('../src/config/database');
    await db.initDatabase();
    console.log('✓ Database connected');

    // Load models
    require('../src/models');

    // Generate and create default admin
    const { ensureDefaultAdmin } = require('../src/services/credentialGenerator');
    const result = await ensureDefaultAdmin();

    if (result.created || result.existed) {
      console.log('');
      console.log('✓ 默认管理员账号已就绪');
      console.log('');
      console.log('用户名:', result.username);
      console.log('凭据文件:', result.credentialsPath);
      console.log('');
      console.log('现在可以使用 khy 命令自动登录了！');
      console.log('');
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ 设置失败:', error.message);
    process.exit(1);
  }
}

quickSetup();
