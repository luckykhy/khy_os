'use strict';

/**
 * functionTagToolCall.js — `<function=NAME>…</function>` 工具调用方言的零 IO 提取单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;只读入参与注入的 env,绝不触文件/网络/时钟。
 *
 * 背后的逻辑:部分开放模型(以及一些云端模型在文本通道里)用 `<function=NAME>BODY</function>` 方言
 * 发起工具调用 —— BODY 多为 JSON 参数,也可能是 `key: value` / `key=value` 键值或裸串。khy 既有的两条
 * 解析路径(`toolCallParser.js::parseToolCalls` 与 `toolUseLoop.js::_parseToolCalls`)各支持 7~8 种格式,
 * 却**都不认**这个方言:结果这类调用先被 `cli/toolCallNoise.js` 当作展示噪声**剥掉**,却从未被任何解析器
 * 解析、执行 —— 模型自以为"调了工具",khy 实际什么都没做(静默失败,且屏幕看不出端倪)。这是
 * goal「怎么确保工具的准确调用」最关键的一个洞。
 *
 * 本叶子把"从文本里提取 `<function=…>` 调用"收敛为**唯一真源**,供两条解析路径共用。它只负责
 * **定位与切分**(name + 原始 argsText + 命中位置 index),把参数解析(`parseFunctionArgs`)与
 * 工具名归一化(`normalizeToolCall`)、伪调用围栏检测(`_isFakeToolCall`)、去重一律留给各 call-site
 * 既有逻辑 —— 既不重复实现,也让两处行为与其它格式完全一致。
 *
 * 诚实边界:
 *   - 只匹配**闭合**的 `<function=NAME>…</function>`。未闭合的截断尾巴(`<function=foo>{…` 无闭标签)
 *     刻意不纳入(与 toolCallNoise 的 display 层正交,且截断恢复属另一类启发式,留待后续)。
 *   - NAME 不含 '>' 与空白:形如 `<function=foo bar=baz>` 这种带属性的脏标签不匹配(保守:宁可漏,
 *     不误把畸形标签当调用)。
 *   - 与 `cli/toolCallNoise.js`(展示层剥噪声)正交:两者都默认开 → 调用被**执行**,屏幕同时**保持干净**。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/** 门控读取(KHY_FUNCTION_TAG_TOOLCALL 默认开;关 → extractFunctionTags 恒 []=字节回退)。 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_FUNCTION_TAG_TOOLCALL;
  return !OFF_VALUES.includes(String(raw == null ? '' : raw).trim().toLowerCase());
}

// `<function=NAME>BODY</function>`:NAME = `[^>\s]+`(不含 '>' 与空白);BODY 非贪婪跨行;
// 闭标签容忍 `</function >` 的尾随空白。大小写不敏感。每次调用用全新字面量,无 lastIndex 状态污染。
function _matchAll(text) {
  return text.matchAll(/<function\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/function\s*>/gi);
}

/**
 * 从文本提取所有形如 `<function=NAME>BODY</function>` 的调用。
 * @param {string} text 待扫描文本
 * @param {object} [env] 注入的环境(叶子不读 process.env;由 call-site 注入)
 * @returns {Array<{name:string, argsText:string, index:number}>}
 *          门控关 / 空或非字符串输入 / 无匹配 → [];argsText 已 trim。
 */
function extractFunctionTags(text, env) {
  if (!isEnabled(env)) return [];
  if (!text || typeof text !== 'string') return [];
  // Fast-path bail (case-insensitive — the dialect tag may be upper/mixed case).
  if (!/<function/i.test(text)) return [];
  const out = [];
  for (const m of _matchAll(text)) {
    const name = String(m[1] == null ? '' : m[1]).trim();
    if (!name) continue;
    out.push({
      name,
      argsText: String(m[2] == null ? '' : m[2]).trim(),
      index: typeof m.index === 'number' ? m.index : 0,
    });
  }
  return out;
}

// `<parameter=NAME>VALUE</parameter>` 子标签:harmony / open-model 文本通道最常见的
// **嵌套** 方言 —— BODY 不是 JSON / `key=value`,而是一串 parameter 子标签,例如
//   <function=Search><parameter=pattern>**/skills/**</parameter></function>
// 既有 _parseFunctionArgs 不认它:`split('=')` 会把 `<parameter=pattern>` 当成 key,
// 把整段标签当成裸值 → 参数名/值全错 → `Invalid tool parameters`(可复现的真实缺陷,
// 见 goal 2026-07-11 transcript:`Search(<parameter=pattern> **/skills/** …)`)。此处把
// 它收敛为唯一真源,让 call-site 在落回 _parseFunctionArgs 前先试这个方言。
// NAME = `[^>\s]+`(与 function 标签同规:不含 '>' 与空白);VALUE 非贪婪跨行、已 trim。
function _matchParameterTags(argsText) {
  return argsText.matchAll(/<parameter\s*=\s*([^>\s]+)\s*>([\s\S]*?)<\/parameter\s*>/gi);
}

/**
 * 若 argsText 由 `<parameter=NAME>VALUE</parameter>` 子标签构成,解成 {NAME: VALUE}。
 * @param {string} argsText `<function=…>` 的 BODY(已 trim)
 * @returns {object|null} 至少解出一个 parameter → 键值对象;无该方言 / 空 / 非字符串 → null
 *          (返回 null 而非 {} 让 call-site 明确落回既有 _parseFunctionArgs,不吞掉其它方言)
 */
function parseParameterTags(argsText) {
  if (!argsText || typeof argsText !== 'string') return null;
  if (!/<parameter/i.test(argsText)) return null;
  const params = {};
  let found = false;
  for (const m of _matchParameterTags(argsText)) {
    const key = String(m[1] == null ? '' : m[1]).trim();
    if (!key) continue;
    // VALUE 保持原样字符串(只 trim 外围空白)—— 参数类型强制留给 call-site 的
    // normalizeToolCall / 工具 schema,与其它方言一致,叶子不擅自 coerce。
    params[key] = String(m[2] == null ? '' : m[2]).trim();
    found = true;
  }
  return found ? params : null;
}

module.exports = {
  isEnabled,
  extractFunctionTags,
  parseParameterTags,
  OFF_VALUES,
};
