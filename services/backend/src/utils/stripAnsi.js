'use strict';

/**
 * stripAnsi.js — 「剥离 ANSI/CSI/OSC 控制序列」单一真源(纯·裸参形)。
 *
 * 收敛 src/cli 下 5 处逐字节相同的私有/导出 helper body:
 *   `str.replace(/\x1b\[[0-9;]*m/g, '')`
 * (aiRenderer._stripAnsiForSpacing · hudRenderer.stripAnsi · ui/permissionDialog.stripAnsi ·
 *  tui/runtime/textMeasure.stripAnsi[导出] · ui/diffViewer._stripAnsi):
 *   去除 `ESC[…m` 形式的 SGR 颜色/样式序列,保留其余文本。
 *
 * **[2026-09-22 修复] 旧 body 只认「纯数字/分号参数的 SGR」**,实测漏剥 5/6:
 *   - `ESC[38:2:255:0:0m`(冒号分隔真彩 SGR) → 漏
 *   - `ESC[?25l` / `ESC[?25h`(光标私有模式) → 漏
 *   - `ESC[2J`(清屏) → 漏
 *   - `ESC[2A`(光标上移) → 漏
 * 漏剥的序列会以可见 ASCII 落到屏上(用户可见的 `1m` 即 `ESC[1m` 的残骸),且这些
 * 参数碎片会破坏紧随的 Markdown 下划线强调配对。病灶链路与证据见
 * `.khy/feedback/structured-output-20260922/`。
 *
 * 现 body 委托 `cli/ansiSanitizer.js`(自带完整 CSI/OSC/DCS/ESC 覆盖、零依赖、
 * 永不抛),让「输出卫生」不再依赖 `strip-ansi` 包是否加载成功这一运行时偶然性。
 *
 * **裸参·不强转(与被收敛五簇逐字节一致)**:直接对入参处理,
 *   故要求 str 为字符串;传非字符串会抛(与原 5 处行为一致——它们皆假定字符串输入)。
 *
 * **刻意不收敛(coercion 变体·C 組)**:
 *   - aiRenderer:387 `String(text).replace(...)`(强转)
 *   - repl/footerLayout:13 `String(s==null?'':s).replace(...)`(nullish 强转)
 *   - 含额外 .trim()/.slice() 或不同正则(panels/markdownRenderer/replSession/KhyOsView/vimInput)——非同一 body。
 *
 * 契约:纯函数、确定性、不 mutate。`/…/g` 的 g 是 replace 全替所需,无 lastIndex 隐患。
 *
 * 各消费方保留同名本地 `const _localName = require('stripAnsi.js')` → 调用点逐字节不变。
 */

const { stripAnsiSequences } = require('../cli/ansiSanitizer');

function stripAnsi(str) {
  // 保持「裸参」契约:非字符串照旧抛 TypeError(原 body 为 `str.replace(...)`,
  // 对 null/undefined/数字 抛)。不能用 `String.prototype.replace.call` 兜 —— 那会
  // 把 42 装箱成 "42" 而不抛,破坏被收敛五簇的既定期望(tests/stripAnsi.test.js)。
  if (typeof str !== 'string') {
    // 刻意复刻原点:触发与 `null.replace` 同型的 TypeError。
    return str.replace(/\x1b\[[0-9;]*m/g, '');
  }
  return stripAnsiSequences(str);
}

module.exports = stripAnsi;
