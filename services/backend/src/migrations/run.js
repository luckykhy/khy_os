#!/usr/bin/env node

async function main() {
  try {
    const { runMigrations, getCurrentVersion } = require('../bootstrap/migrations');
    const before = getCurrentVersion();
    const result = await runMigrations();
    const after = getCurrentVersion();

    console.log(`当前版本: ${before} -> ${after}`);
    console.log(`已执行: ${result.ran.length ? result.ran.join(', ') : '无'}`);
    console.log(`已跳过: ${result.skipped.length ? result.skipped.join(', ') : '无'}`);
    process.exit(0);
  } catch (error) {
    console.error('迁移执行失败:', error.message);
    process.exit(1);
  }
}

main();
