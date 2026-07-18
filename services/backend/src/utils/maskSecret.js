'use strict';

/**
 * maskSecret.js — 「脱敏展示密钥/令牌片段」单一真源(纯)。
 *
 * 收敛 4 处 body 逐字节相同的私有 helper:
 *   text=String(value||'').trim(); 空→''; len<=8→`前2****`; 否则→`前4...后2`。
 *   (ai-backend/routes/aiGatewayAdmin.maskSecret · backend/cli/handlers/config._maskSecret ·
 *    backend/routes/aiGatewayAdmin.maskSecret · backend/.../modelConfig.resource._maskKey)。
 *
 * **安全意义**:统一脱敏口径,防各处分叉出「露太多字符」的弱脱敏(如只 `${value.slice(0,-4)}`)。
 *   本 util **绝不返回完整密钥**——空串、`前2****`、或 `前4...后2` 三态之一。
 *
 * **刻意不收敛(不可互委)**:
 *   - 阈值不同(len<=10、露后4)或分隔符不同(`***`/`…`)的变体。
 *   - 全星号定长掩码(`********`)不透露首尾的变体。
 *
 * 契约:纯函数、确定性、不 mutate。`|| ''` 令 falsy(含 undefined 零参)→ 返 ''。
 *
 * 各消费方保留同名本地 `const NAME = require('.../maskSecret')`→ 调用点逐字节不变。
 */

function maskSecret(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length <= 8) return `${text.slice(0, 2)}****`;
  return `${text.slice(0, 4)}...${text.slice(-2)}`;
}

module.exports = maskSecret;
