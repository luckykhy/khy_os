#!/usr/bin/env node
/**
 * @pattern Strategy
 */

async function main() {
  try {
    const { sequelize, initDatabase } = require('./src/config/database');
    await initDatabase();
    await sequelize.authenticate();
    console.log(`✓ 数据库连接成功 (${process.env.DB_MODE || sequelize.getDialect()})`);
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    console.error('✗ 数据库连接失败:', error.message);
    process.exit(1);
  }
}

main();
