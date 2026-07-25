'use strict';

/**
 * completionKeysLazy — 让 router.getCompletions 的 `allKeys` 惰性构造(纯叶子)。
 *
 * 根因:`router.js::getCompletions(partial)`(readline completer + TUI 前缀回退源)在函数**顶部
 * 无条件**构造 `allKeys = [...COMMANDS, ...aliases().getAllAliasKeys()]`(展开拼接 + `Object.keys
 * (ALIAS_MAP)`),但**斜杠路径**(`parts[0].startsWith('/')`,最常见)在其后立即 early-return,
 * **从不使用 allKeys**——只有非斜杠命令补全(line 5682 `unique = [...new Set(allKeys)]`)才用。
 *
 * 调用频次:此函数不止 Tab 触发——`useCompletions.js:53` 把 `router.getCompletions` 作为
 * `KHY_TUI_SLASH_SUBSTRING` **关**时的**每次按键**前缀回退源。故斜杠输入每键都白白构造一次
 * allKeys(展开 COMMANDS + Object.keys 整张别名表)再丢弃。
 *
 * 修:把 allKeys 的构造**下沉**到斜杠 early-return **之后**(即真正要用它的位置之前)。这是**纯
 * 重排**——输出逐字节不变(allKeys 只喂 `unique`,斜杠分支无关),仅斜杠路径不再无谓构造。
 *
 * 本叶子只提供一个门控 + 一个惰性求值器,便于审计与逐字节回退:
 *   • isEnabled(env):门控 KHY_COMPLETION_KEYS_LAZY 默认开;off/0/false/no 关。
 *   • buildKeys(computeFn):门控开 → 调用方在斜杠 return 之后才 computeFn()(惰性);门控关 →
 *     调用方保持顶部即时构造(逐字节回退今日行为)。叶子只承载门控判定 + 安全求值(绝不抛)。
 *
 * 纯叶子纪律:零 IO、确定性、绝不抛;computeFn 抛 → 返 [](getCompletions 下游对空数组已安全)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_COMPLETION_KEYS_LAZY;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 安全求值 allKeys 构造闭包。绝不抛(异常 → [],下游 new Set([]) 安全)。
 * @param {() => Array} computeFn
 * @returns {Array}
 */
function buildKeys(computeFn) {
  try {
    const out = computeFn();
    return Array.isArray(out) ? out : [];
  } catch {
    return [];
  }
}

module.exports = { isEnabled, buildKeys, OFF_VALUES };
