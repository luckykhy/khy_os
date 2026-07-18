'use strict';

// 权限回复(human-gate 手打文字)→ 批准/拒绝 的「词识别单一真源」。
//
// 真缺口:两条「用户手打回复 → 批准/拒绝」的判定路径都只认极小 ASCII 词集——
//   - services/toolCalling.js requestPermission 的遗留 switch(只 1/y/yes、2/a/always、3/n/no);
//   - cli/ui/permissionDialog.js resolveChoiceIndex(只比对 choices[].aliases 同一词集),
// 其余一律落 default → deny(安全 fail-closed)。于是用户自然会打的肯定词——中文
// 「是/好/可以/同意/批准/允许/确认」、英文「approve/ok/sure」——被静默拒绝:用户明明
// 批准了却被识别为未批准。本叶子把肯定/否定词识别收敛成 SSOT,两条 call-site 共用。
//
// 纯叶子契约:零 IO、确定性、fail-soft、门控感知。门控 KHY_PERMISSION_REPLY_TOKENS 默认开;
// 关 → classify 恒返回 null → call-site 落回今日 ASCII-only + default-deny 行为(逐字节回退)。
//
// 安全纪律:
//   - 不认 → null(交回 call-site,维持既有 default-deny,绝不放宽闸门);
//   - **否定优先**——含否定标记(不/否/拒绝/cancel…)即判 deny,使「不允许」「不批准」「不确认」
//     不会因含「允许/批准/确认」子串而误判为 allow;模糊永不误判为 allow;
//   - allow-always 须在 allow 之前判(「总是允许」含「允许」)。

const _FALSY = new Set(['0', 'false', 'off', 'no']);

function permissionReplyEnabled(env = process.env) {
  const flag = String((env && env.KHY_PERMISSION_REPLY_TOKENS) || '').trim().toLowerCase();
  return !_FALSY.has(flag);
}

// 归一:NFKC 顺带把全角 ASCII(１/Ｙ 等)折半角,零依赖;再 trim + lowercase。
function _normalize(input) {
  return String(input == null ? '' : input).normalize('NFKC').trim().toLowerCase();
}

// ── 词集 ──────────────────────────────────────────────────────────────
// CJK 子串(回复短、无歧义,用 includes);英文歧义短词(y/n/a)用整串相等避免误吞词内字母。

// 否定:优先级最高。英文既有整串集 + 少量明确否定子串(no 不入子串以免误吞 now/none)。
const _NEG_CJK = ['不', '否', '别', '拒', '取消', '算了', '放弃', '停'];
const _NEG_EXACT = new Set(['no', 'n', 'nope', 'cancel', 'deny', 'stop', 'reject', 'abort', 'false', '0']);
const _NEG_SUBSTR = ['cancel', 'deny', 'stop', 'reject', 'abort'];

// allow-always:须在 allow 之前(「总是允许」含「允许」)。
const _ALWAYS_CJK = ['信任', '总是', '一直', '永久', '始终', '永远'];
const _ALWAYS_EXACT = new Set(['always', 'trust', 'a']);

// allow。
const _ALLOW_CJK = ['是', '好', '可以', '行', '同意', '批准', '允许', '确认', '对', '嗯', '要', '继续', '执行', '通过', '准'];
const _ALLOW_EXACT = new Set(['y', 'yes', 'ok', 'okay', 'sure', 'yep', 'yeah', 'approve', 'approved', 'allow', 'proceed', 'continue', 'go', 'true', '1']);

function _hasCjk(text, list) {
  for (const tok of list) if (text.indexOf(tok) !== -1) return true;
  return false;
}
function _hasSubstr(text, list) {
  for (const tok of list) if (text.indexOf(tok) !== -1) return true;
  return false;
}

/**
 * Classify a free-typed permission reply into a canonical decision.
 * @param {string} input  raw user reply
 * @param {object} [env]  defaults to process.env
 * @returns {'allow'|'allow-always'|'deny'|null}  null = unrecognized (caller keeps default-deny)
 */
function classifyPermissionReply(input, env = process.env) {
  if (!permissionReplyEnabled(env)) return null;
  const t = _normalize(input);
  if (!t) return null; // 空串语义留给 call-site(逐字节不变)

  // 1) 否定优先
  if (_hasCjk(t, _NEG_CJK) || _NEG_EXACT.has(t) || _hasSubstr(t, _NEG_SUBSTR)) return 'deny';

  // 2) allow-always(在 allow 之前)
  if (_hasCjk(t, _ALWAYS_CJK) || _ALWAYS_EXACT.has(t)) return 'allow-always';

  // 3) allow
  if (_hasCjk(t, _ALLOW_CJK) || _ALLOW_EXACT.has(t)) return 'allow';

  // 4) 不认 → null(fail-closed,call-site default-deny)
  return null;
}

module.exports = {
  permissionReplyEnabled,
  classifyPermissionReply,
};
