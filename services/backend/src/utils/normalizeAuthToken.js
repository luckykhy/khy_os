'use strict';

/**
 * normalizeAuthToken.js — 「khy- 前缀鉴权令牌归一化」单一真源(纯·安全口径)。
 *
 * 收敛 3 处 body 逐字节相同的 normalizeAuthToken——
 *   services/cursor2apiIntegrationService · services/gateway/proxyServer(经 shorthand 导出) ·
 *   ai-backend/services/aiAssetCustomerService(经 shorthand 导出·跨根委托)。
 *
 * 语义:trim 入参;空→ allowEmpty ? '' : null。剥前缀——`khy-` 剥 4 位、`khy`(无连字符)
 *   剥 3 位再剥前导 `-`/`_`、否则整串为后缀;后缀 trim 后为空→ allowEmpty ? '' : null;
 *   否则统一重建为 `khy-<suffix>`。=> 各种大小写/前缀写法归一到规范 `khy-…` 形态。
 *
 * 安全:统一令牌规范化口径防各处分叉出不一致的前缀处理(鉴权比对错配风险)。
 *   allowEmpty=false 用于「必须有 token」场景(空返 null 便于上游拒绝)。
 *
 * 契约:纯函数、确定性、不 mutate 入参。正则皆函数内字面量(无 g 标志·无 lastIndex 复用)。
 *   各消费方保留同名 `const normalizeAuthToken = require('.../normalizeAuthToken')`→ 调用点逐字节不变。
 */

function normalizeAuthToken(raw, { allowEmpty = true } = {}) {
  const token = String(raw || '').trim();
  if (!token) return allowEmpty ? '' : null;

  let suffix = '';
  if (/^khy-/i.test(token)) {
    suffix = token.slice(4);
  } else if (/^khy/i.test(token)) {
    suffix = token.slice(3).replace(/^[-_]+/, '');
  } else {
    suffix = token;
  }
  suffix = String(suffix || '').trim();
  if (!suffix) return allowEmpty ? '' : null;
  return `khy-${suffix}`;
}

module.exports = normalizeAuthToken;
