'use strict';

/**
 * 兼容入口。验收标准1的权威场景是 sessions.db 截断一半后走 recover，
 * 具体断言由 verify-db-health.js 执行，不再用删除 -shm 的温和场景替代。
 */
const { spawnSync } = require('child_process');
const path = require('path');

const result = spawnSync(process.execPath, [path.join(__dirname, 'verify-db-health.js')], {
  stdio: 'inherit',
});

if (result.error) {
  console.error(result.error.message);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
