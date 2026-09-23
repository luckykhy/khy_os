'use strict';

/**
 * claimNegation.js — 否定守卫纯叶子（从 claimReconciler.js 行为保真抽出）。
 *
 * claimReconciler 的「动作族关键词只匹动词、无视紧邻否定」缺陷修复核心：判定声称前，
 * 若动词紧邻否定（未/没有/无需/不/别 … / not/never/without …），即认定这是「没做该动作」
 * 的陈述，跳过不计为声称。门控 KHY_CLAIM_NEGATION_GUARD（默认开）；关 → _firstUnnegatedMatch
 * 退化为原 re.exec 首匹配，逐字节回退。
 *
 * 本叶子只依赖 process.env + 自身正则/函数，不引用 claimReconciler 的任何符号（无 back-edge、
 * 不成环）；claimReconciler 重新 require 并再导出 _isNegatedClaim / _isNegationGuardEnabled，
 * 公共面与抽取前逐字节一致。见 DESIGN-ARCH-047 PHASE 4 / flagRegistry 门注释。
 */

// ── 否定守卫(KHY_CLAIM_NEGATION_GUARD·默认开)─────────────────────────────────
const _NEG_OFF = new Set(['0', 'false', 'off', 'no']);
function _isNegationGuardEnabled(env) {
  try {
    const v = (env || process.env || {}).KHY_CLAIM_NEGATION_GUARD;
    return !(v !== undefined && _NEG_OFF.has(String(v).trim().toLowerCase()));
  } catch {
    return true;
  }
}

// 动词紧邻的单字否定(未/没/无/無/毋/勿/别/不);多字否定词在稍宽窗口内(没有/无需/尚未…);
// 英文否定在动词前 ~16 字符内(the file was not modified / never / without …)。
const _NEG_ADJ_RE = /(未|没|无|無|毋|勿|别|不)$/;
const _NEG_NEAR_RE = /(没有|无需|无须|无法|尚未|从未|并未|毫无|未曾|未能)/;
const _NEG_EN_RE =
  /\b(no|not|never|without|nothing|none|isn't|wasn't|weren't|didn't|don't|doesn't|won't|can't|cannot|couldn't|shouldn't)\b/i;

/** 该声称匹配处的动词是否被紧邻否定(是 → 非声称,应跳过)。 */
function _isNegatedClaim(text, idx) {
  try {
    if (typeof text !== 'string' || !(idx >= 0)) {
      return false;
    }
    const adj = text.slice(Math.max(0, idx - 1), idx); // 紧贴动词的 1 个字
    if (_NEG_ADJ_RE.test(adj)) {
      return true;
    } // 未修改 / 没删除 / 不部署
    const near = text.slice(Math.max(0, idx - 4), idx); // 稍宽窗口的多字否定
    if (_NEG_NEAR_RE.test(near)) {
      return true;
    } // 没有修改 / 无需修改 / 尚未提交
    const en = text.slice(Math.max(0, idx - 16), idx); // 英文否定在动词前若干词
    if (_NEG_EN_RE.test(en)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 找该族第一处**非否定**声称。门控关时退化为原 `re.exec(text)` 首匹配(逐字节回退)。
 * 用全局克隆迭代,绝不改动 CLAIM_FAMILIES 里被冻结的原正则状态。
 */
function _firstUnnegatedMatch(re, text, negOn) {
  if (!negOn) {
    return re.exec(text);
  }
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let m;
  while ((m = g.exec(text)) !== null) {
    if (m.index === g.lastIndex) {
      g.lastIndex += 1;
    } // 防零宽匹配死循环
    if (!_isNegatedClaim(text, m.index)) {
      return m;
    }
  }
  return null;
}

module.exports = {
  _isNegationGuardEnabled,
  _isNegatedClaim,
  _firstUnnegatedMatch,
};
