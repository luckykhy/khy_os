'use strict';

/**
 * _modelIdParse.js — 「模型 ID 规范化」单一真源(纯函数原子层·Batch 2)。
 *
 * 核实结论:勘察线索称"parseModelId/模型规范化在 4+ 适配器有重复实例"部分失实 —
 * 适配器目录内仅 claudeAdapter.parseModelId 与 _ideTokenMixin.normalizeModelId 各一份,
 * 且互不等价。真实的重复位于 gateway/cli 层,共两组逐字节相同的副本:
 *
 * 收敛清单 A(trim + 去首尾引号,**保留内部空白**):
 *   - gateway/proxyServer.js:861 `function normalizeModelId(raw)`
 *   - cli/handlers/proxy.js:137  `function normalizeModelId(raw)`
 *   body 逐字节相同:`String(raw || '').trim().replace(/^['"]|['"]$/g, '')`
 *   → 导出为 normalizeModelIdTrimQuotes。
 *
 * 收敛清单 B(trim + 去首尾引号 + **剥除全部空白**):
 *   - gateway/modelDiscovery.js:69            `function normalizeModelId(id)`
 *   - gateway/adapters/_ideTokenMixin.js:136  `function normalizeModelId(id)`
 *   body 逐字节相同:`String(id || '').trim().replace(/^["']|["']$/g, '').replace(/\s+/g, '')`
 *   → 导出为 normalizeModelIdCompact。
 *
 * A 与 B **互不等价**(B 额外剥除内部空白),故并列导出、绝不合并;
 * 各消费方保留同名本地绑定(`const normalizeModelId = require('./_modelIdParse').xxx;`)
 * → 调用点逐字节不变。
 *
 * 刻意不收敛(变体登记):
 *   - adapters/claudeAdapter.js:647 `parseModelId(rawId)`:解析 `model::mode` 后缀
 *     (bridge/direct 路由语义),全仓唯一实例,无重复 → 不收敛。
 *   - 正则字符类书写差异(A 组 /['"]/  vs B 组 /["']/)仅是字符集内部顺序,
 *     匹配语义相同,不构成第三种变体。
 *
 * 契约:纯函数、确定性、不 mutate、非字符串输入经 String() 强转、null/undefined → ''。
 */

// Variant A — trim + strip a single leading/trailing quote pair, keep inner spaces
function normalizeModelIdTrimQuotes(raw) {
  return String(raw || '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
}

// Variant B — trim + strip leading/trailing quotes + remove ALL whitespace
function normalizeModelIdCompact(id) {
  return String(id || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\s+/g, '');
}

module.exports = {
  normalizeModelIdTrimQuotes,
  normalizeModelIdCompact,
};
