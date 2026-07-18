'use strict';

/**
 * toolCallColonKvAnchor.js — 纯叶子(零 IO、确定性、绝不抛、可单测)。
 *
 * 修 toolCallParser.parseFunctionArgs 的「冒号 KV 正则不锚定字段边界 → 吞掉真参数」缺陷:
 * 该函数解析函数式工具调用参数 `toolName(...)` 时,**先无条件**用
 *   /(\w+)\s*:\s*(?:"..."|'...'|[^,)]+)/g
 * 扫全串找 `word:` 冒号 KV 对,命中即返回、丢弃模型真正用的 `key=value` 形。可这个正则
 * 会把**值里任意位置**的 `word:` 也当成 KV 键:
 *   `curl https://example.com`      → {https:"//example.com"}   (应 {command:"curl https://example.com"})
 *   `git commit -m "fix: bug"`      → {fix:"bug\""}             (应 {command:"..."})
 *   `date +%H:%M`                   → {H:"%M"}                  (应 {command:"date +%H:%M"})
 *   `command=curl https://x.com`    → {https:"//x.com"}         (真 command= 被丢)
 *   `path=/a/b, content=hello:world`→ {hello:"world"}           (真 path=/content= 被丢)
 * 于是工具带着垃圾参数执行、或 command 键彻底丢失 —— 是 parseToolCalls 各 Format(2/2b/5/6/7)
 * 的核心解析洞,URL / 带引号 commit 消息 / 时间等含冒号的输入都中招。
 *
 * 根因:真正的冒号 KV 对里,键**总在字段边界**——串首或逗号之后;而自由 shell 文本里的
 * `https:` / `+%H:` / `"fix:` 前面是空格/百分号/引号,不在边界。本叶子给出**字段边界锚定**的
 * 冒号 KV 正则:`(?:^|,)\s*` 前缀,捕获组编号与 legacy 完全一致(非捕获 `(?:...)`),
 * 故调用方原有解析循环一字不改即可套用。
 *
 * 门控 KHY_TOOLCALL_COLON_KV_ANCHOR(默认开):关(0/false/off/no)/异常 → 返回 null,
 * 调用方逐字节回退到 legacy 未锚定正则(旧行为原样),从而门关时逐字节等于历史行为。
 * flagRegistry 优先,失败回退本地 CANON 解析;绝不抛。
 *
 * 严格化(收紧误命中):门开只让「键不在字段边界」的伪 KV 对**不再命中**(转而落到
 * `key=value` 分支或 command 兜底,即模型的真实意图);合法的 `a: x, b: y` 冒号 KV 全保留。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控 KHY_TOOLCALL_COLON_KV_ANCHOR:默认开;0/false/off/no → 关。异常回退关门(false)。
 * @param {Record<string,string>} [env]
 * @returns {boolean}
 */
function colonKvAnchorEnabled(env = process.env) {
  try {
    const e = env || {};
    try {
      const reg = require('./flagRegistry');
      if (reg && typeof reg.isRegistryEnabled === 'function'
        && typeof reg.isFlagEnabled === 'function'
        && reg.isRegistryEnabled(e)) {
        return reg.isFlagEnabled('KHY_TOOLCALL_COLON_KV_ANCHOR', e);
      }
    } catch { /* fall through to local parse */ }
    const raw = e.KHY_TOOLCALL_COLON_KV_ANCHOR;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 返回**字段边界锚定**的冒号 KV 正则(全新 RegExp 实例,含 `g` flag,lastIndex=0):
 *   - 门关 / 异常 → null(调用方回退 legacy 未锚定正则);
 *   - 门开 → /(?:^|,)\s*(\w+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^,)]+))/g
 * 捕获组:1=键,2=双引号值,3=单引号值,4=裸值(与 legacy 一致)。每次调用返回新实例,
 * 避免共享 lastIndex 状态。
 * @param {Record<string,string>} [env]
 * @returns {RegExp|null}
 */
function anchoredColonKvRegex(env = process.env) {
  try {
    if (!colonKvAnchorEnabled(env)) return null;
    return /(?:^|,)\s*(\w+)\s*:\s*(?:"([^"]*?)"|'([^']*?)'|([^,)]+))/g;
  } catch {
    return null;
  }
}

module.exports = {
  colonKvAnchorEnabled,
  anchoredColonKvRegex,
};
