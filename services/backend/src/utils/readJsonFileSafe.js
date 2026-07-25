'use strict';

/**
 * readJsonFileSafe.js — 「同步读 JSON 文件·fail-soft 返 null」共享 helper。
 *
 * **做 IO(读文件系统)**:同步 fs.readFileSync;IO 汇聚隔离在此单点,调用方只接收已解析数据。
 *
 * 收敛 src/services 下 3 处 body 语义相同的私有 helper:
 *   `try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { return null; }`
 * (deliveryGate._loadJson · cliAnythingGenerator._readJSON · cliAnythingService._readJSON):
 *   读 UTF-8 文件并 JSON.parse;文件缺失/权限/畸形 JSON 任一失败 → 返 null(绝不抛)。
 *
 * **刻意不收敛(不可互委)**:
 *   - 返 `{}` / `[]` / 其它默认值的变体(默认值分叉)。
 *   - 读毕带 schema 校验或字段挑拣的 helper(多一步)。
 *   - 用 'utf8'(无连字符)以外编码或非同步读(fs.promises)的变体。
 *
 * 契约:确定性 fail-soft;catch 吞一切读取/解析异常返 null;不 mutate;不缓存。
 *
 * 各消费方保留同名本地 `const _localName = require('.../readJsonFileSafe')` → 调用点逐字节不变。
 */

const fs = require('fs');

function readJsonFileSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = readJsonFileSafe;
