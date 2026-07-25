'use strict';

/**
 * patchEnvContent.js — 「.env 文件文本补丁(改/增/删 KEY=VALUE 行)」单一真源(纯)。
 *
 * 收敛 5 处 body 逐字节相同的私有 helper——
 *   cli/handlers/config._patchEnvContent · cli/handlers/proxy.patchEnvContent ·
 *   routes/aiGatewayAdmin.patchEnvContent · services/baseSelfCheckService._patchEnvContent ·
 *   services/gatewayEnvFile.patchEnvContent(经 shorthand 导出)。
 *
 * 语义:遍历 envMap 每对——存在 `^KEY=.*$`(m 标志)则整行替换为 `KEY=VALUE`,否则
 *   trimEnd 后追加 `\nKEY=VALUE\n`;再遍历 unsetKeys 删除 `^KEY=.*\n?` 行。
 *
 * 契约:纯函数、确定性、不 mutate 入参(返回新字符串)。正则由 key 现构(每次新实例·无 lastIndex 复用)。
 *   注:key 内含正则元字符会被当模式(pre-existing 行为·逐字节保留不改)。
 *
 * 各消费方保留同名本地 `const NAME = require('.../patchEnvContent')`→ 调用点逐字节不变。
 */

function patchEnvContent(content, envMap = {}, unsetKeys = []) {
  let next = String(content || '');
  for (const [key, value] of Object.entries(envMap)) {
    const regex = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    if (regex.test(next)) next = next.replace(regex, line);
    else next = next.trimEnd() + '\n' + line + '\n';
  }
  for (const key of unsetKeys) {
    const regex = new RegExp(`^${key}=.*\\n?`, 'm');
    next = next.replace(regex, '');
  }
  return next;
}

module.exports = patchEnvContent;
