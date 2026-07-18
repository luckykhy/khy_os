'use strict';

/**
 * normalizeAlnumKey.js — 「小写 + 去除全部非字母数字字符」规范化键单一真源(纯)。
 *
 * 收敛 src/services 下 6 处 body 语义相同的私有工具名规范化 helper:
 *   `String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '')`  (A·带 `+`)
 *   `String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '')`   (B·无 `+`)
 * (A:toolCalling._toolKey · toolTierCatalog._normalize · toolCatalog/toolContract._toolKey;
 *  B:toolCallParser.normalizeToolKey · toolUseLoopCore._normalizeToolKey · structuredResults/turnEnvelope._normTool)
 * 用途:把工具/标识名折成「仅 a-z0-9」的规范键,用于大小写/标点无关的匹配与去重。
 *
 * **A、B 两正则变体在此合流(可证等价)**:替换串为**空**时,`[^a-z0-9]+`(整段连续非字母数字
 *   一次匹配)与 `[^a-z0-9]`(逐字符匹配)对**任意**输入产出**逐字节相同**结果——`+` 只影响匹配
 *   次数不影响删除结果(已用 5000+ 随机串 + 边界样本 fuzz 证零差异)。故二者委托同一真源无行为变化。
 *
 * **刻意不收敛(不可互委)**:
 *   - utils/normalizeToolName(R27)去的是 `[\s_-]`(仅空白/下划线/连字符)——保留点/斜杠/unicode,
 *     与本 util 去「全部非字母数字」结果不同(`a.b/c` → 本 util 得 `abc`,normalizeToolName 得 `a.b/c`)。
 *   - toolLoopDetector:294 `String(name)`(无 `|| ''`)——null→'null' 而非 ''(C 組)。
 *   - 替换为 `'-'` 的 slug 变体(agenticHarnessService/gatewayProviderKeyPool/…·另含去首尾连字符)——不同 body。
 *   - toolCalling:1258 内联 `(normalizedName||toolName||'')`、claudeCompat:15 `_cleanName(name)` 前缀——不同表达式。
 *
 * 契约:纯函数、确定性、不 mutate。`|| ''` 令 falsy(''/0/false/null/undefined)→ ''。
 *   `/…/g` 的 g 是 replace 全替所需,无 lastIndex 隐患。
 *
 * 各消费方保留同名本地 `const _localName = require('.../normalizeAlnumKey')` → 调用点逐字节不变。
 */

function normalizeAlnumKey(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

module.exports = normalizeAlnumKey;
