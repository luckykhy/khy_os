'use strict';

/**
 * fenceLangCharset.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 修「流式围栏识别不了带 `#`/`.` 的语言标注」。streamingMarkdown 的
 *   FENCE_OPEN_RE = /^(`{3,})([\w+-]*)\s*$/
 * 语言段只收 `\w`、`+`、`-`,于是 ```` ```c# ````、```` ```f# ````、```` ```asp.net ```` 这类
 * 带 `#` 或 `.` 的合法 info-string 无法匹配整行 → classifyLine 不判它是 fence_open、
 * _enterFence 拿不到语言 → 流式预览里这段代码块**不被当作代码块**(高亮/围栏状态机失灵),
 * 而同仓非流式渲染的 _COMMON_LANGS 早已认得 `c#`/`objective-c` 等。CommonMark 的 info string
 * 除反引号外几乎不限字符,这里只务实地补上最常见的 `#`(c#/f#)与 `.`(点分语言名)。
 *
 * 门控 KHY_FENCE_LANG_CHARSET(默认开,仅 `0/false/off/no` 关):
 *   - 开 → 返回加宽字符集正则 `/^(`{3,})([\w+.#-]*)\s*$/`(语言段额外收 `.` 与 `#`);
 *   - 关 → 逐字节返回历史正则(与今日行为完全一致)。
 *
 * 两处 call-site 都以 `.test()` / `.match()`(非全局)使用,无 lastIndex 串扰;两个实例均为
 * 模块级单例。绝不抛:异常回退历史正则。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 加宽:语言段额外接受 `.`(点分语言名)与 `#`(c#/f#);其余同历史(≥3 反引号、结尾可空白)。
const RE_WIDE = /^(`{3,})([\w+.#-]*)\s*$/;
// 历史正则(逐字节回退基准)。
const RE_LEGACY = /^(`{3,})([\w+-]*)\s*$/;

/**
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function fenceLangCharsetEnabled(env = process.env) {
  const raw = env && env.KHY_FENCE_LANG_CHARSET;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 返回围栏起始行应使用的正则:开门 → 加宽;关门/异常 → 历史。
 * 返回模块级单例;call-site 以 .test()/.match() 非全局方式使用。
 * @param {Record<string,string>} [env]
 * @returns {RegExp}
 */
function fenceOpenRegex(env = process.env) {
  try {
    return fenceLangCharsetEnabled(env) ? RE_WIDE : RE_LEGACY;
  } catch {
    return RE_LEGACY;
  }
}

module.exports = {
  fenceLangCharsetEnabled,
  fenceOpenRegex,
  RE_WIDE,
  RE_LEGACY,
};
