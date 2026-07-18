'use strict';

/**
 * directiveRegistryAudit.js — 纯叶子:指令注册表完整性审计(编排层的**编译期收敛机制**)。
 *
 * 背景(khyos 自审报告 #1「系统提示词膨胀 + 多协议冲突·最严重·根因=叠加式协议堆叠、
 * 无编译期冲突检测」):`directiveComposer.DIRECTIVE_REGISTRY` 是所有意图指令的 SSOT
 * (key→{tier,label}),而 `composeDirectives` 对**未注册 key** 静默走 `protocol` 兜底
 * (`meta ? meta.tier : 'protocol'`)。这条兜底是韧性设计(绝不丢指令),但也是**漂移
 * 入口**:ai.js 新加一路指令却忘了登记 → 它被无声当成 protocol、无 tier 语义、协调头
 * 里用裸 key 当 label,协议堆叠越堆越乱且无人察觉——正是报告说的「无收敛机制」。
 *
 * 本叶子把「注册表 vs 实际编排的 key 集合」的一致性变成**可断言的纯函数**:给定注册表
 * 与 ai.js 真正 compose 的 key 列表,返回双向差异——`unregistered`(被 compose 但未登记,
 * 会落进 protocol 兜底)与 `orphaned`(登记了但从不 compose,死条目)。守卫测试据此在
 * CI/提交期锁死不变量:每条被编排的指令都必须显式登记(正确 tier),每条登记都必须真被
 * 编排。于是未来的「加法式协议堆叠」再也不能悄悄漂移进无类型兜底。
 *
 * 契约(纯叶子):零 IO、确定性、绝不抛。无门控——这是**审计原语**(被守卫测试消费),
 * 不改任何运行时行为,故无需逃生阀。异常输入 → 尽力返回结构化空差异,绝不抛。
 */

/**
 * 审计注册表与实际编排 key 的一致性。
 *
 * @param {object} registry   DIRECTIVE_REGISTRY(key → { tier, label })
 * @param {string[]} composedKeys  ai.js 实际传给 composeDirectives 的 key 列表
 * @returns {{
 *   unregistered: string[],   // 被 compose 但注册表没有 → 会落 protocol 兜底(漂移)
 *   orphaned: string[],       // 注册表有但从不 compose → 死条目
 *   duplicates: string[],     // composedKeys 里重复出现的 key(应唯一)
 *   ok: boolean               // 三者皆空 → 一致
 * }}
 */
function auditDirectiveRegistry(registry, composedKeys) {
  const reg = (registry && typeof registry === 'object') ? registry : {};
  const composed = Array.isArray(composedKeys) ? composedKeys.map(k => String(k || '')).filter(Boolean) : [];

  const regKeys = new Set(Object.keys(reg));
  const composedSet = new Set(composed);

  const unregistered = [];
  for (const k of composedSet) {
    if (!regKeys.has(k)) unregistered.push(k);
  }
  const orphaned = [];
  for (const k of regKeys) {
    if (!composedSet.has(k)) orphaned.push(k);
  }
  // 重复检测:同一 key 在 compose 列表里出现 >1 次。
  const seen = new Set();
  const dupSet = new Set();
  for (const k of composed) {
    if (seen.has(k)) dupSet.add(k);
    seen.add(k);
  }
  const duplicates = [...dupSet];

  // 确定性排序,便于断言与阅读。
  unregistered.sort();
  orphaned.sort();
  duplicates.sort();

  return {
    unregistered,
    orphaned,
    duplicates,
    ok: unregistered.length === 0 && orphaned.length === 0 && duplicates.length === 0,
  };
}

/**
 * 校验注册表每条目的 tier 都合法(∈ allowedTiers)、label 非空。
 * @param {object} registry
 * @param {string[]} [allowedTiers=['guard','protocol']]
 * @returns {{ badTier: string[], emptyLabel: string[], ok: boolean }}
 */
function auditRegistryShape(registry, allowedTiers = ['guard', 'protocol']) {
  const reg = (registry && typeof registry === 'object') ? registry : {};
  const allowed = new Set(allowedTiers);
  const badTier = [];
  const emptyLabel = [];
  for (const [k, v] of Object.entries(reg)) {
    if (!v || typeof v !== 'object' || !allowed.has(v.tier)) badTier.push(k);
    if (!v || typeof v !== 'object' || !String(v.label || '').trim()) emptyLabel.push(k);
  }
  badTier.sort();
  emptyLabel.sort();
  return { badTier, emptyLabel, ok: badTier.length === 0 && emptyLabel.length === 0 };
}

/**
 * 从 ai.js(或任意源码文本)的 composeDirectives 调用块里抽取 `{ key: 'xxx' }` 的 key。
 * 纯文本解析,绝不 require ai.js(它是大二进制/含内联字符,require 有副作用)。
 *
 * @param {string} source  源码文本
 * @returns {string[]}  按出现顺序去空的 key 列表(可能含重复,交给 audit 检重)
 */
function extractComposedKeys(source) {
  const s = String(source == null ? '' : source);
  const keys = [];
  // 仅在 composeDirectives( ... ) 的实参块内抽取,避免误吞别处的 `key:`。
  const start = s.indexOf('composeDirectives(');
  if (start < 0) return keys;
  // 粗定界:从 composeDirectives( 到其后第一个 `entries` 数组闭合附近。用括号配平找实参块尾。
  let depth = 0;
  let end = s.length;
  for (let i = start + 'composeDirectives('.length - 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  const block = s.slice(start, end);
  const re = /\bkey:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    keys.push(m[1]);
  }
  return keys;
}

module.exports = {
  auditDirectiveRegistry,
  auditRegistryShape,
  extractComposedKeys,
};
