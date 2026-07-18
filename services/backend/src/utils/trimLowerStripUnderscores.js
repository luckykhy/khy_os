'use strict';

/**
 * trimLowerStripUnderscores.js — 「trim + lowercase + 仅去下划线」规范化键单一真源(纯)。
 *
 * 收敛 src/services 下 2 处 body 逐字节相同的私有 helper:
 *   `String(name || '').trim().toLowerCase().replace(/_/g, '')`
 * (toolAccessGateway._normalizeToolName · toolRegistryDedup._normalize):
 *   去首尾空白、转小写、删除**全部下划线**;**保留**连字符与内部空白。
 *
 * **刻意不收敛(不可互委)**:
 *   - utils/normalizeToolName(R27)去 `[\s_-]`(连字符/内部空白也删)——`a-b c` → 本 util `a-b c`、
 *     normalizeToolName `abc`,结果不同。
 *   - utils/normalizeAlnumKey(R40)去**全部非字母数字**(连字符/点/unicode 皆删)——更激进。
 *   - utils/trimLowerCase(R29)仅 trim+lowercase,不删下划线。
 *   - toolCalling:2266 是函数作用域内内联箭头 `const _normalize = (name)=>…`(非模块级 helper)、
 *     toolGuards:652 `toolName.toLowerCase().replace(/_/g,'')`(无 String/trim)——不同 body/shape。
 *
 * 契约:纯函数、确定性、不 mutate。`|| ''` 令 falsy → ''。`/_/g` 的 g 是全替所需。
 *
 * 各消费方保留同名本地 `const _localName = require('.../trimLowerStripUnderscores')` → 调用点逐字节不变。
 */

function trimLowerStripUnderscores(name) {
  return String(name || '').trim().toLowerCase().replace(/_/g, '');
}

module.exports = trimLowerStripUnderscores;
