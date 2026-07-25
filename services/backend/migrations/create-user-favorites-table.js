/**
 * @pattern Command
 */
const { Sequelize } = require('sequelize');
require('dotenv').config();

// 数据库配置
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'quant_trading',
  username: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  dialect: 'postgres',
  logging: console.log
};

console.log('数据库配置：');
console.log(`DB_TYPE: ${process.env.DB_TYPE || 'postgres'}`);
console.log(`DB_HOST: ${dbConfig.host}`);
console.log(`DB_PORT: ${dbConfig.port}`);
console.log(`DB_NAME: ${dbConfig.database}`);
console.log(`DB_USER: ${dbConfig.username}`);
console.log(`DB_PASSWORD 是否设置: ${!!dbConfig.password}`);

async function createUserFavoritesTable() {
  const sequelize = new Sequelize(dbConfig);

  try {
    // 测试连接
    await sequelize.authenticate();
    console.log('✅ 数据库连接成功');

    console.log('\n🔧 开始创建 user_favorites 表...\n');

    // 检查表是否已存在
    const [results] = await sequelize.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'user_favorites'
      );
    `);

    if (results[0].exists) {
      console.log('ℹ️  user_favorites 表已存在，跳过创建');
      await sequelize.close();
      return;
    }

    // 创建 user_favorites 表
    await sequelize.query(`
      CREATE TABLE user_favorites (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol VARCHAR(20) NOT NULL,
        name VARCHAR(100),
        type VARCHAR(20),
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, symbol)
      );
    `);
    console.log('✅ user_favorites 表创建成功');

    // 创建索引
    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_user_favorites_user_id ON user_favorites(user_id);
    `);
    console.log('✅ user_id 索引创建成功');

    await sequelize.query(`
      CREATE INDEX IF NOT EXISTS idx_user_favorites_symbol ON user_favorites(symbol);
    `);
    console.log('✅ symbol 索引创建成功');

    // 显示结果
    const [countResult] = await sequelize.query('SELECT COUNT(*) AS count FROM user_favorites');
    console.log(`\n✅ user_favorites 表创建完成！当前记录数: ${countResult[0].count}`);

    await sequelize.close();
    console.log('\n🎉 数据库迁移执行成功！');
  } catch (error) {
    console.error('❌ 数据库迁移失败:', error);
    await sequelize.close();
    process.exit(1);
  }
}

// 执行迁移
createUserFavoritesTable();
