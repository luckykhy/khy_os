'use strict';

/**
 * readFileSyncSafe.js — 「同步读文本文件·fail-soft 返 ''」共享 helper。
 *
 * **做 IO(读文件系统)**:同步 fs.readFileSync(utf8);IO 汇聚隔离在此单点,调用方只接收字符串。
 *
 * 收敛 src/services 下 2 处 body 逐字节相同的私有 helper:
 *   `try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }`
 * (contextScope/aiMapIndex._read · metadataHook._readSafe):
 *   读 UTF-8 文本;文件缺失/权限任一失败 → 返 ''(绝不抛)。
 *
 * **刻意不收敛(不可互委)**:
 *   - 失败返 **null** 的变体(projectCoherence/coherenceAnalyzer._defaultRead)——默认值分叉,
 *     '' 与 null 对下游判空/拼接语义不同。
 *   - 用 'utf-8'(带连字符)或非同步(fs.promises)、或读毕 .trim()/JSON.parse 的变体。
 *
 * 契约:确定性 fail-soft;catch 吞异常返 '';不 mutate;不缓存。
 *
 * 各消费方保留同名本地 `const _localName = require('.../readFileSyncSafe')` → 调用点逐字节不变。
 */

const fs = require('fs');

function readFileSyncSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

module.exports = readFileSyncSafe;
