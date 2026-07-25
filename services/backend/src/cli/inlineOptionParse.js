'use strict';

/**
 * inlineOptionParse.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「router 丢掉 `--key=value` 里的 value」。router.js 的选项解析只认空格分隔的
 * `--key value` 形式:对 `--out=report.md` 取 `key = rest[i].slice(2)` = 字面 `"out=report.md"`,
 * 后一个 token 不是它的值 → 落入 `options[key] = true` 分支,于是 `options` 里出现一个名叫
 * `"out=report.md"`、值为 `true` 的畸形键,真正的值 `report.md` 被丢掉。GNU/POSIX 长选项、
 * 以及本仓帮助文案里出现的 `--scope=user`、`--url=…` 等写法都用等号形式 → 静默失效。
 *
 * 本叶子只做一件事:判断「去掉前导 `--` 后的 rawKey」是否是等号内联形式,若是则按**第一个**
 * 等号切成 `{ key, value }`(value 可为空串,如 `--out=`),并告知 call-site 不要再消费下一个 token。
 *   - 开门(KHY_INLINE_OPTION_PARSE 默认开)且 rawKey 含「位置 >0 的等号」→ inline:true;
 *   - 关门(0/false/off/no)/无等号/等号在位置 0(`--=x` 畸形)→ inline:false,call-site 逐字节
 *     回退历史空格分隔逻辑(key=整个 rawKey)。
 *
 * 只按**第一个**等号切:`--filter=a=b` → key='filter'、value='a=b'(值里允许再含等号,符合直觉)。
 * 绝不抛:任何异常回退 inline:false + key=原 rawKey。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_INLINE_OPTION_PARSE;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 解析「已去前导 `--` 的」长选项 token。
 * @param {string} rawKey  例如 'out=report.md' / 'verbose' / 'filter=a=b'
 * @param {Record<string,string>} [env]
 * @returns {{inline: boolean, key: string, value?: string}}
 *   inline=true 时附带 value,且 call-site 不应消费下一个 token;
 *   inline=false 时只带 key(=原 rawKey),call-site 沿用历史空格分隔逻辑。
 */
function parseInlineOption(rawKey, env = process.env) {
  try {
    const key = String(rawKey == null ? '' : rawKey);
    if (!isEnabled(env)) return { inline: false, key };
    const eq = key.indexOf('=');
    // 等号必须在位置 >0(`--=x`、`--` 之类畸形交回历史分支处理)。
    if (eq <= 0) return { inline: false, key };
    return { inline: true, key: key.slice(0, eq), value: key.slice(eq + 1) };
  } catch {
    return { inline: false, key: String(rawKey == null ? '' : rawKey) };
  }
}

module.exports = { isEnabled, parseInlineOption };
