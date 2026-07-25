'use strict';

const path = require('path');
const fs = require('fs');

/**
 * resolveGatewayEnvPaths.js — 「解析网关 .env 写入目标(canonical + 可选 repo 镜像)」共享 helper。
 *
 * ⚠️ 非纯 IO 叶子:读 process.env(KHY_ENV_FILE / KHY_ENV_SYNC_ROOT)+ fs.existsSync 探测。
 *   刻意不标「纯叶子」。
 *
 * 收敛 5 处 body 语义等价的解析器(4 份 body-A 逐字节相同 + config.js 因 __dirname 更深
 *   而带补偿 `../` 但解析到同一对绝对路径)——
 *   services/gatewayEnvFile.resolveEnvPaths(既有 SSOT·经 shorthand 导出·gateway handler 经 _envFile 委托) ·
 *   services/baseSelfCheckService._resolveGatewayEnvPaths · services/configRepairService._resolveEnvPaths ·
 *   routes/aiGatewayAdmin.resolveEnvPathsForGateway · cli/handlers/config._resolveEnvPaths。
 *
 * 语义:canonical = KHY_ENV_FILE(存在则 resolve)否则 `services/backend/.env`;mirror = repo 级
 *   `services/.env`。KHY_ENV_SYNC_ROOT!=='false' 且 mirror≠canonical 且任一已存在 → targets 含 mirror。
 *   本 util 置于 `src/utils`,__dirname 相对深度与原 `src/services`·`src/routes` 消费方一致
 *   (`../../.env`→services/backend/.env·`../../../.env`→services/.env),故 config.js(src/cli/handlers·带额外 `../`)
 *   委托后解析路径逐字节一致。
 *   (forest 布局:__dirname=services/backend/src/utils,`../../.env` 落在 services/backend/.env。)
 *
 * 契约:确定性(给定 env + fs 状态)、不 mutate 入参、返回新对象。
 *   各消费方保留同名本地绑定 `const NAME = require('.../resolveGatewayEnvPaths')`→ 调用点逐字节不变。
 */

function resolveGatewayEnvPaths() {
  const canonicalPath = process.env.KHY_ENV_FILE
    ? path.resolve(process.env.KHY_ENV_FILE)
    : path.resolve(__dirname, '../../.env'); // services/backend/.env (forest layout)
  const mirrorPath = path.resolve(__dirname, '../../../.env'); // services/.env
  const syncMirror = String(process.env.KHY_ENV_SYNC_ROOT || 'true').toLowerCase() !== 'false';

  const targets = [canonicalPath];
  if (syncMirror && mirrorPath !== canonicalPath && (fs.existsSync(mirrorPath) || fs.existsSync(canonicalPath))) {
    targets.push(mirrorPath);
  }
  return { canonicalPath, targets };
}

module.exports = resolveGatewayEnvPaths;
