'use strict';

/**
 * safeStatSync.js — 「fail-soft 同步 stat」单一真源。
 *
 * 收敛 src/ 下 3 处逐字节相同的私有 `_safeStat(filePath = '')`
 * (services/documentSnippetService · ocrSnippetService · mediaTranscriptionService):
 *   `try { return fs.statSync(filePath); } catch { return null; }`。
 *   成功 → fs.Stats;任何异常(不存在/权限/EACCES 等)→ null。
 *
 * 契约:确定性映射(同路径同结果)、不 mutate、异常绝不外抛(fail-soft 返 null)。
 * **读文件系统(fs.statSync)——非纯叶子**;IO 边界隔离在此单一函数内。
 *
 * 各消费方保留同名本地 `const _safeStat = require('../utils/safeStatSync')` → 调用点逐字节不变。
 */

const fs = require('fs');

function safeStatSync(filePath = '') {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

module.exports = safeStatSync;
