#!/usr/bin/env node
/**
 * @pattern Template Method
 */
/**
 * 跨平台 Python 执行器。
 * Windows 上 python3 命令不存在，用 python 或 py -3 替代。
 */
const { execSync } = require('child_process');
const { searchExecutable } = require('../../services/backend/src/tools/platformUtils');

const isWin = process.platform === 'win32';
const candidates = isWin ? ['python', 'py', 'python3'] : ['python3', 'python'];
let pythonCmd = null;

for (const cmd of candidates) {
  if (searchExecutable(cmd)) {
    pythonCmd = cmd;
    break;
  }
}

if (!pythonCmd) {
  console.error('Python not found. Install Python 3 and ensure it is in PATH.');
  process.exit(1);
}

const args = process.argv.slice(2).join(' ');
try {
  execSync(`${pythonCmd} ${args}`, { stdio: 'inherit' });
} catch (err) {
  process.exit(err.status || 1);
}
