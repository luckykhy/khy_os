'use strict';

/**
 * normalizeCompatibility.js — 「上游兼容协议标签归一化」单一真源(纯)。
 *
 * 收敛 3 处 body 逐字节相同的私有 helper:
 *   trim+lowercase 后:空→'openai';openai/-compatible/_compatible→'openai';
 *   anthropic 系→'anthropic';unknown/auto/detect→'unknown';其它→''。
 *   (ai-backend/routes/aiGatewayAdmin.normalizeCompatibility ·
 *    backend/cli/handlers/config._normalizeCompatibility ·
 *    backend/routes/aiGatewayAdmin.normalizeCompatibility)。
 *   注:'openai'/'anthropic' 为**协议兼容族标签**非模型名(不触 model-hardcoding)。
 *
 * **刻意不收敛(不可互委)**:
 *   - 默认返回非 'openai'、或新增 gemini/ollama 等分支的变体。
 *   - 未知输入抛错而非返 '' 的变体。
 *
 * 契约:纯函数、确定性、不 mutate。空输入默认 'openai',无法识别返 ''(调用方可据此回退)。
 *
 * 各消费方保留同名本地 `const NAME = require('.../normalizeCompatibility')`→ 调用点逐字节不变。
 */

function normalizeCompatibility(raw = '') {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return 'openai';
  if (value === 'openai' || value === 'openai-compatible' || value === 'openai_compatible') return 'openai';
  if (value === 'anthropic' || value === 'anthropic-compatible' || value === 'anthropic_compatible') return 'anthropic';
  if (value === 'unknown' || value === 'auto' || value === 'detect') return 'unknown';
  return '';
}

module.exports = normalizeCompatibility;
