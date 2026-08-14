#!/usr/bin/env node
/**
 * @pattern Flyweight, Visitor
 */

const path = require('path');
const { spawnSync } = require('child_process');

const cliPath = path.join(__dirname, 'bin', 'khyquant.js');
const result = spawnSync(process.execPath, [cliPath, 'doctor'], { stdio: 'inherit' });

if (result.error) {
  console.error('环境检查执行失败:', result.error.message);
  process.exit(1);
}

if (typeof result.status === 'number') {
  process.exit(result.status);
}

process.exit(1);
