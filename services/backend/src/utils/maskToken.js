'use strict';

/**
 * maskToken.js — 「脱敏展示令牌片段(空标记 (empty))」单一真源(纯)。
 *
 * 收敛 3 处 body 逐字节相同的私有 helper:
 *   token=String(raw||'').trim(); 空→'(empty)'; len<=10→`前3***`; 否则→`前6***后4`。
 *   (ai-backend/aiAssetCustomerService.maskToken · backend/cli/handlers/gateway.maskTokenValue ·
 *    backend/gateway/proxyServer.maskToken)。
 *
 * **安全意义**:统一令牌脱敏口径,防各处分叉出弱脱敏。绝不返回完整令牌——
 *   三态之一:'(empty)'、`前3***`、`前6***后4`。
 *
 * **与 utils/maskSecret(R54)刻意分开(不可互委)**:maskSecret 空→''、阈值 8、`前2****`/`前4...后2`;
 *   本 util 空→'(empty)'(占位可视)、阈值 10、`前3***`/`前6***后4`——脱敏格式与空值语义各异。
 *
 * 契约:纯函数、确定性、不 mutate。`|| ''` 令 falsy(含 undefined 零参)→ 返 '(empty)'。
 *
 * 各消费方保留同名本地 `const NAME = require('.../maskToken')`→ 调用点逐字节不变。
 */

function maskToken(raw) {
  const token = String(raw || '').trim();
  if (!token) return '(empty)';
  if (token.length <= 10) return `${token.slice(0, 3)}***`;
  return `${token.slice(0, 6)}***${token.slice(-4)}`;
}

module.exports = maskToken;
