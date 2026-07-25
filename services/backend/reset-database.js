#!/usr/bin/env node
/**
 * @pattern Strategy
 */

async function main() {
  const force = process.argv.includes('--force');
  if (!force) {
    console.error('此命令会清空数据库，请使用: npm run reset-db -- --force');
    process.exit(1);
  }

  try {
    const { applyEnvDefaults } = require('./src/config/env');
    applyEnvDefaults();

    const { sequelize, initDatabase } = require('./src/config/database');
    require('./src/models');

    await initDatabase();
    await sequelize.sync({ force: true });
    await sequelize.close();

    console.log(`✓ 数据库已重置 (${process.env.DB_MODE || sequelize.getDialect()})`);
    process.exit(0);
  } catch (error) {
    console.error('✗ 重置数据库失败:', error.message);
    process.exit(1);
  }
}

main();
