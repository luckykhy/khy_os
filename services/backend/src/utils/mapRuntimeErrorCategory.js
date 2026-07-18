'use strict';

/**
 * mapRuntimeErrorCategory.js — 「(errorType, errorText) → 运行时错误粗类」单一真源(纯)。
 *
 * 收敛 2 处 body 逐字节相同的私有 `mapRuntimeCategory(errorType, errorText)`——
 *   gateway/adapters/apiAdapter · gateway/adapters/ollamaAdapter(各自 `../../../utils/mapRuntimeErrorCategory`)。
 *
 * ⚠️ 刻意不并入 gateway/adapters/relayApiAdapter.mapRuntimeCategory——其 transport 正则多一枚
 *   `transport|` 分支(额外匹配 'transport' 文本),行为分叉,属 C 組。
 *
 * 语义:type/text 归一小写;'timeout' 或 text 含 'timeout' → 'stall';
 *   type∈{network,process,cancelled} 或 text 命中传输层正则 → 'transport';否则 → ''。
 *
 * 契约:纯函数(仅 String/正则·正则无 g 标志无 lastIndex 隐患)·不 mutate 入参。
 *   各消费方保留同名本地 `const mapRuntimeCategory = require('../../../utils/mapRuntimeErrorCategory')`
 *   → 调用点逐字节不变。
 */

function mapRuntimeErrorCategory(errorType = '', errorText = '') {
  const normalizedType = String(errorType || '').trim().toLowerCase();
  const normalizedText = String(errorText || '').trim().toLowerCase();
  if (normalizedType === 'timeout' || normalizedText.includes('timeout')) return 'stall';
  if (
    normalizedType === 'network'
    || normalizedType === 'process'
    || normalizedType === 'cancelled'
    || /econn|socket|network|aborted|cancelled|canceled/.test(normalizedText)
  ) {
    return 'transport';
  }
  return '';
}

module.exports = mapRuntimeErrorCategory;
