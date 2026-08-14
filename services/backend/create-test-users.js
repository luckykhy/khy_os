#!/usr/bin/env node
/**
 * @pattern Strategy
 */

const path = require('path');
const { spawnSync } = require('child_process');

const seedPath = path.join(__dirname, 'scripts', 'seed.js');
const result = spawnSync(process.execPath, [seedPath], { stdio: 'inherit' });

if (result.error) {
  console.error('创建测试用户失败:', result.error.message);
  process.exit(1);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
