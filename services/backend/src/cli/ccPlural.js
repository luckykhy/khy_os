'use strict';

/**
 * ccPlural —— CC `src/utils/stringUtils.ts::plural` 逐字节移植 + 门控包装。
 *
 * CC 源:`plural(n, word, pluralWord = word + 's') => n === 1 ? word : pluralWord`
 *   ——CC 用它取代散落的内联 `word${n === 1 ? '' : 's'}` 习语,统一英文计数串的
 *   单复数判定。Khy 多处**用户可见英文计数串**硬编码复数形(`N matches` /
 *   `N lines` / `N files`),`n === 1` 时显「1 matches」「1 lines」「1 files」=语法错。
 *   本叶子把 CC 的 `plural` 移植为单一真源,供这些 call-site 共享。
 *
 * 纯叶子:零 IO、零业务 require、确定性纯函数。仅读 `process.env` 做门控。绝不抛。
 *
 * 门控 `KHY_CC_PLURAL`(默认开):
 *   - 开 → CC `plural`(`n === 1` 单数,否则复数形);
 *   - 关 → 返回**复数形**(本 call-site 族 legacy 一律硬编码复数形,故逐字节回退)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_CC_PLURAL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

// CC 逐字节移植:n === 1 → 单数 `word`;否则 `pluralWord`(默认 `word + 's`)。
// 不强转 n:CC 用严格 `=== 1`,故仅 number `1` 取单数(与 CC 同;字符串 '1' 取复数)。
function plural(n, word, pluralWord) {
  const p = (pluralWord == null) ? `${word}s` : pluralWord;
  return n === 1 ? word : p;
}

// `*Or` 约定:门控开 → CC `plural`;门控关 → 复数形(= 各 call-site 历史硬编码形)逐字节回退。
function pluralOr(n, word, pluralWord, env = process.env) {
  const p = (pluralWord == null) ? `${word}s` : pluralWord;
  if (!isEnabled(env)) return p;
  return plural(n, word, p);
}

module.exports = { isEnabled, plural, pluralOr };
