'use strict';

/**
 * existsSyncSafe.js — 「同步探路径存在·fail-soft 返 false」共享 helper。
 *
 * **做 IO(探文件系统)**:同步 fs.existsSync;IO 汇聚隔离在此单点,调用方只接收布尔判定。
 *
 * 收敛 src/services 下 3 处 body 逐字节相同的私有 helper:
 *   `try { return fs.existsSync(p); } catch { return false; }`
 * (projectHygiene/index.safeExists · projectCoherence/resolver._defaultExists ·
 *  gateway/breakCacheState._existsSafe):
 *   探路径是否存在;任何异常(权限/畸形路径)→ 返 false(绝不抛)。
 *
 * **刻意不收敛(不可互委)**:
 *   - 用 fs.accessSync / fs.statSync 判存在的变体(错误语义不同:access 分权限)。
 *   - 探毕再判 isFile()/isDirectory() 的 helper(多一步)。
 *   - 裸 `fs.existsSync(p)`(不 fail-soft·existsSync 本不抛但契约意图不同)——不主动改写内联点。
 *
 * 契约:确定性 fail-soft;catch 吞异常返 false;不 mutate。
 *
 * 各消费方保留同名本地 `const _localName = require('.../existsSyncSafe')` → 调用点逐字节不变。
 */

const fs = require('fs');

function existsSyncSafe(p) {
  try { return fs.existsSync(p); } catch { return false; }
}

module.exports = existsSyncSafe;
