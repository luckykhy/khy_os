'use strict';

/**
 * stripAnsi.js — 「剥离 SGR ANSI 颜色码」单一真源(纯·裸参形)。
 *
 * 收敛 src/cli 下 5 处逐字节相同的私有/导出 helper body:
 *   `str.replace(/\x1b\[[0-9;]*m/g, '')`
 * (aiRenderer._stripAnsiForSpacing · hudRenderer.stripAnsi · ui/permissionDialog.stripAnsi ·
 *  tui/runtime/textMeasure.stripAnsi[导出] · ui/diffViewer._stripAnsi):
 *   去除 `ESC[…m` 形式的 SGR 颜色/样式序列,保留其余文本。
 *
 * **裸参·不强转(与被收敛五簇逐字节一致)**:直接对入参 `.replace`,
 *   故要求 str 为字符串;传非字符串会抛(与原 5 处行为一致——它们皆假定字符串输入)。
 *
 * **刻意不收敛(coercion 变体·C 組)**:
 *   - aiRenderer:387 `String(text).replace(...)`(强转)
 *   - repl/footerLayout:13 `String(s==null?'':s).replace(...)`(nullish 强转)
 *   - 含额外 .trim()/.slice() 或不同正则(panels/markdownRenderer/replSession/KhyOsView/vimInput)——非同一 body。
 *
 * 契约:纯函数、确定性、不 mutate。`/…/g` 的 g 是 replace 全替所需,无 lastIndex 隐患。
 *
 * 各消费方保留同名本地 `const _localName = require('.../stripAnsi')` → 调用点逐字节不变。
 */

function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

module.exports = stripAnsi;
