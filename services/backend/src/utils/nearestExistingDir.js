'use strict';

const path = require('path');
const fs = require('fs');

/**
 * nearestExistingDir.js — 「沿路径向上找最近的已存在目录」共享 helper。
 *
 * ⚠️ 非纯 IO 叶子:fs.existsSync + fs.statSync 探测。刻意不标「纯叶子」。
 *
 * 收敛 2 处 body 逐字节相同的 `nearestExistingDir`——
 *   services/credentialWatcherService · services/apiKeyPoolWatcher
 *   (文件监视器在目标文件尚不存在时,回退监视最近的已存在祖先目录)。
 *
 * 语义:从 dirname(filePath) 起,最多向上 10 层;某层存在且是目录→返回它;
 *   逐层 fs 异常吞掉继续上溯;抵达根(parent===dir)停;全程未命中→null。
 *
 * 契约:确定性(给定 fs 状态)、不 mutate 入参、上限 10 层防无界循环。
 *   各消费方保留同名本地 `const nearestExistingDir = require('.../nearestExistingDir')`→ 调用点逐字节不变。
 */

function nearestExistingDir(filePath) {
  let dir = path.dirname(filePath);
  for (let i = 0; i < 10; i++) {
    try {
      if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch { /* skip */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

module.exports = nearestExistingDir;
