'use strict';

/**
 * protocolArbitration.js — 多协议冲突仲裁(纯叶子:零 IO、确定性、绝不抛、可单测)。
 *
 * 背景(goal 第 1、15 项「协议冲突无仲裁机制」):directiveComposer 已能在 ≥2 套 protocol 同时
 * 命中时插入「协调头」,但协调头把所有协议一律当作「互补、并非互斥」,靠一句自然语言让模型自行
 * 取舍。对**真正互斥**的协议对——典型:数学解题要求分步详解 vs 懒人方法论要求最短输出,在
 * 「输出详略」这条轴上正相反——这不够:没有确定性仲裁,模型可能两头讨好或随机弃一。用户要的是
 * 「冲突时自动取最高优先级并显式声明弃用了哪个」。
 *
 * 本叶子提供**声明式互斥矩阵 + 确定性仲裁**:登记确证互斥的协议对(附优先胜者 + 冲突轴 + 理由);
 * 当一对里两者本回合同时生效 → 判定败者应被抑制(从注入中移除),并产出一条显式仲裁说明。
 * directiveComposer 消费本仲裁结果:移除败者的 directive,并把仲裁说明作为一段注入,让模型明确
 * 知道「哪个协议被弃用、为什么」。
 *
 * 保守原则(与 flagRegistry 种子集同调):矩阵**只登记确证互斥的对**,绝不臆造冲突——错误的
 * 互斥会静默抑制本应生效的协议 = 静默行为变更,违背铁律。宁可漏登记(退化为今日协调头软取舍),
 * 不可错登记。
 *
 * 契约:门控 KHY_PROTOCOL_ARBITRATION(默认开,仅 0/false/off/no 关)。关 → arbitrate 返回
 * 空抑制(no-op),directiveComposer 逐字节回退到今日「全协议 + 协调头」。绝不抛。
 *
 * @module services/protocolArbitration
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

// ── 声明式互斥矩阵(种子集:仅确证互斥的协议对)──────────────────────────────
// 字段:
//   keys    [协议A, 协议B](DIRECTIVE_REGISTRY 的 protocol key)。
//   winner  冲突时保留者(优先级更高);另一者被抑制。
//   axis    冲突所在的语义轴(人话,用于仲裁说明)。
//   reason  为什么按此优先级取舍(人话,注入给模型;必须精确、不过度抑制——写清败者原则在别处
//           仍适用,只是不得用它压制胜者的核心要求)。
const MUTEX_PAIRS = Object.freeze([
  Object.freeze({
    keys: Object.freeze(['mathSolve', 'laziness']),
    winner: 'mathSolve',
    axis: '输出详略 / 长度',
    reason:
      '数学解题协议要求分步展示完整推导与回代自检,懒人方法论要求最短输出——两者在「输出详略」'
      + '轴上正相反。正确性与可验证性优先于最小化:本回合采用分步解题,不套用懒人「最短输出」约束。'
      + '(懒人原则仍适用于最终交付的代码量 / 不过度工程,但不得用它压缩或省略解题推导。)',
  }),
]);

/**
 * 门控判定。优先 flagRegistry(集中优先级 + dogfood),不可用回退本地 CANON。默认开。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || process.env || {};
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_PROTOCOL_ARBITRATION', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_PROTOCOL_ARBITRATION;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 纯仲裁:给定本回合生效的 protocol key 集合,返回应抑制的 key + 仲裁记录。
 * 不看门控(门控由 arbitrate 施加),便于单测直接断言矩阵语义。绝不抛。
 *
 * @param {string[]} activeProtocolKeys  本回合生效的 protocol key(去空;相对顺序无关)
 * @returns {{suppressed:Set<string>, arbitrations:Array<{winner:string, loser:string, axis:string, reason:string}>}}
 */
function resolveArbitration(activeProtocolKeys = []) {
  const active = new Set(
    (Array.isArray(activeProtocolKeys) ? activeProtocolKeys : [])
      .map((k) => String(k || '').trim())
      .filter(Boolean)
  );
  const suppressed = new Set();
  const arbitrations = [];
  for (const pair of MUTEX_PAIRS) {
    const a = pair.keys[0];
    const b = pair.keys[1];
    if (!active.has(a) || !active.has(b)) continue;   // 需两者同时生效
    // 胜者可能已被更高优先的另一对抑制;若胜者已被抑制,本对不再抑制败者(避免连锁误抑)。
    if (suppressed.has(pair.winner)) continue;
    const loser = pair.winner === a ? b : a;
    if (suppressed.has(loser)) continue;              // 已被抑制,不重复记
    suppressed.add(loser);
    arbitrations.push({ winner: pair.winner, loser, axis: pair.axis, reason: pair.reason });
  }
  return { suppressed, arbitrations };
}

/**
 * 门控化仲裁:门控关 → 空抑制(no-op)。绝不抛。
 * @param {string[]} activeProtocolKeys
 * @param {object} [env]
 * @returns {{suppressed:Set<string>, arbitrations:Array}}
 */
function arbitrate(activeProtocolKeys = [], env) {
  try {
    if (!isEnabled(env)) return { suppressed: new Set(), arbitrations: [] };
    return resolveArbitration(activeProtocolKeys);
  } catch {
    return { suppressed: new Set(), arbitrations: [] };
  }
}

/**
 * 构建仲裁说明块:显式告诉模型哪个协议因冲突被弃用、为什么。确定性模板,只消费矩阵内文案 +
 * 调用方注入的 label 映射(来自 DIRECTIVE_REGISTRY SSOT),绝不回显用户输入。
 * @param {Array<{winner:string, loser:string, axis:string, reason:string}>} arbitrations
 * @param {object} [labels]  key → label 映射;缺失回退 key 本身
 * @returns {string}  空数组 → 空串
 */
function buildArbitrationNotice(arbitrations = [], labels = {}) {
  const items = (Array.isArray(arbitrations) ? arbitrations : []).filter(Boolean);
  if (items.length === 0) return '';
  const nameOf = (k) => String((labels && labels[k]) || k);
  const lines = [];
  lines.push('## 协议冲突仲裁 —— 下列协议因互斥已被弃用,本回合勿再套用');
  items.forEach((it, i) => {
    lines.push(`${i + 1}. 冲突轴「${it.axis}」:采用「${nameOf(it.winner)}」,弃用「${nameOf(it.loser)}」。`);
    lines.push(`   理由:${it.reason}`);
  });
  lines.push('');
  lines.push('被弃用的协议本回合不生效;其余生效协议见下,按其要求执行。');
  return lines.join('\n');
}

module.exports = {
  MUTEX_PAIRS,
  isEnabled,
  resolveArbitration,
  arbitrate,
  buildArbitrationNotice,
};
