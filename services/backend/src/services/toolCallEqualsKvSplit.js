'use strict';

/**
 * toolCallEqualsKvSplit.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 toolCallParser.parseFunctionArgs 的「`=` 分支无条件 `argsStr.split(',')`」缺陷:该分支
 * 把 `key=value` 参数串按**每一个逗号**切成对,于是值里任意**合法逗号**(`awk -F,`、
 * `cut -d,`、`git log --pretty=format:%h,%s`、含逗号散文/命令)都被当字段分隔符 →
 * 命令/内容在首个逗号处静默截断,尾段落成空值伪参数:
 *   `command=echo a,b,c`            → {command:"echo a", b:"", c:""}(应为 {command:"echo a,b,c"})
 *   `path=/a/b, content=hello,world`→ {path:"/a/b", content:"hello", world:""}(world 是伪参数)
 * parseFunctionArgs 服务 Format 2/2b/5/6/7 五路工具调用解析 → 模型一旦用 `ToolName(key=value)`
 * 方言且值含逗号即命中,导致**执行的命令与模型本意不同**(写错文件 / 跑错 shell),是真实缺陷。
 *
 * 正确语义:逗号只在它**开启下一个 `key=` 对**时才是字段分隔符;值内逗号应原样保留。真实的键
 * 恒是 `[A-Za-z_]\w*` 紧跟 `=`(caller 用 `pair.split('=')` + `key.trim()`),故「逗号后紧跟
 * `<key>=`」是可靠的对边界。本叶子按该前瞻切分,返回**已 trim** 的对字符串数组(caller 逐字节
 * 沿用其 `pair.split('=')` 循环)。
 *
 * 门控 KHY_TOOLCALL_EQ_KV_SPLIT(默认开):关(0/false/off/no)/异常 → 返回 null,调用方逐字节
 * 回退 legacy `argsStr.split(',').map(s => s.trim())`。flagRegistry 优先,失败回退本地 CANON 解析;
 * 绝不抛。
 *
 * 严格化(非扩张):切点是 legacy 全逗号切点的**子集**——每个**真**对边界(逗号后必有 `key=`)
 * 两态都切,mine 仅**少切**那些后随非 `key=` 的值内逗号。故 mine 的正确性 ≥ legacy,绝不比
 * legacy 多切;合法多对 `a=1, b=2` 两态完全一致。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 「逗号后紧跟一个 `<key>=`」的前瞻:key = 可选空白 + 标识符 + 可选空白 + `=`。命中处才是对边界。
const _EQ_PAIR_BOUNDARY = /,(?=\s*[A-Za-z_][\w-]*\s*=)/;

/**
 * 门控 KHY_TOOLCALL_EQ_KV_SPLIT:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function toolCallEqKvSplitEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_TOOLCALL_EQ_KV_SPLIT', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_TOOLCALL_EQ_KV_SPLIT;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 把 `key=value` 参数串切成对(边界锚定,值内逗号保留)。
 *   - 门关 / 异常 / 非字符串 → null(调用方回退 legacy `split(',')`);
 *   - 门开 → 已 trim 的对字符串数组,只在「逗号后紧跟 `<key>=`」处切分。
 * @param {string} argsStr
 * @param {Record<string,string>} [env]
 * @returns {string[]|null}
 */
function splitEqualsKvPairs(argsStr, env = process.env) {
  try {
    if (!toolCallEqKvSplitEnabled(env)) return null;
    if (typeof argsStr !== 'string') return null;
    return argsStr.split(_EQ_PAIR_BOUNDARY).map((s) => s.trim());
  } catch {
    return null;
  }
}

module.exports = {
  toolCallEqKvSplitEnabled,
  splitEqualsKvPairs,
};
