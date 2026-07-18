'use strict';

/**
 * ensureDirSync.js — 「存在性守护式建目录」单一真源。
 *
 * 收敛 src/ 下 4 处逐字节相同的私有 `_ensureDir(dir)`
 * (services/cronScheduler · cliAnythingGenerator · extensions/extensionManager ·
 *  workspace/checkpointService):
 *   `if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });`。
 *   目录不存在 → 递归创建;已存在 → 不动。
 *
 * 契约:幂等(重复调用无副作用增量)、不 mutate 入参、recursive 建全路径。
 * **读/写文件系统(fs.existsSync/fs.mkdirSync)——非纯叶子**;IO 边界隔离在此单一函数内。
 *
 * C組(不并入,行为不同,勿动):
 *   - 零参读模块常量的 `_ensureDir()`(cliAuthService KHY_DIR / khyAnythingProxy PROXY_DIR /
 *     ownerControlService·auditLog·permissionStore·permissions/rules 的 path.dirname(常量))
 *     ——各读不同模块级常量,无法参数化。
 *   - `_ensureDir(dirPath)` 多行花括号变体(sessionTraceSummary / traceAuditService / skillCuratorService)。
 *   - skillPackageService 无 existsSync 守卫(无条件 mkdir)。
 *   - utils/storageRoots(双参 fsImpl 注入)、utils/dataHome(try-catch 吞错、无 existsSync)。
 *
 * 各消费方保留同名本地 `const _ensureDir = require('../utils/ensureDirSync')` → 调用点逐字节不变。
 */

const fs = require('fs');

function ensureDirSync(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

module.exports = ensureDirSync;
