'use strict';

/**
 * mkdirpSync.js — 「递归建目录(无 existsSync 守卫)」共享 helper。做 IO(写文件系统)。
 *
 * 收敛 4 处 body 逐字节相同的私有 `ensureDir(dirPath)`:
 *   `fs.mkdirSync(dirPath, { recursive: true });`
 *   (services/gateway/customerRegistry · gateway/paymentGatewayService ·
 *    gateway/proxyServer · cursor2apiIntegrationService)。
 *   `recursive:true` 令已存在目录不抛(mkdir -p 语义)→ 无需前置 existsSync 守卫。
 *
 * **与 utils/ensureDirSync(R31)刻意分开(不可互委)**:
 *   ensureDirSync 体为 `if (!fs.existsSync(dir)) fs.mkdirSync(dir,{recursive:true})`——
 *   先探再建;本 util 裸调 mkdirSync(recursive)。二者对「目录已存在」结果相同,
 *   但本 util 少一次 existsSync 系统调用、且不读 existsSync 结果——形态各异,
 *   为逐字节委托保各消费方调用点不变,不强并入 ensureDirSync。
 *
 * **刻意不收敛**:带 mode / 非 recursive / try-catch fail-soft / 返回创建路径的变体。
 *
 * 各消费方保留同名本地 `const ensureDir = require('.../mkdirpSync')`→ 调用点逐字节不变。
 */

const fs = require('fs');

function mkdirpSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

module.exports = mkdirpSync;
