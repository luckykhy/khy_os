'use strict';

/**
 * nlModelSwitchResolver — 纯叶子:零 IO、确定性、fail-soft 的自然语言 → 模型切换
 * 意图解析(单一真源)。把「在对话框里用自然语言说『切换模型到 <厂商> [模型]』」这条
 * 需求的**解析面**代码化:本叶子只把中/英自然语言确定性地解析成 `{vendor, model}`,绝不碰
 * 文件系统 / 网络 / 子进程;真正的「列出该厂商可用模型 + 打开选择器 + 应用切换」由调用方
 * 薄壳(handlers/gateway 的 buildVendorModelChoices / handleModelSwitchByVendor、TUI App.js
 * 的 openModelPickerForVendor)经既有 SSOT(buildGatewayModelChoices / applyGatewayModelSelection)
 * 完成。
 *
 * 契约:零 IO、确定性、绝不抛(任何异常 → null / [])、env 门控 KHY_NL_MODEL_SWITCH 默认开。
 * 零假阳性:resolve 成立必须**同时**命中(a)切换动作词 +(b)模型域引用(模型/model)+
 * (c)一个**已知厂商**(经内嵌别名表解析出 poolKey),否则返回 null(绝不猜)——故「切换到
 * 深色主题」「用 markdown 输出」「换一个说法」都不会被误判为模型切换。
 *
 * 与 nlProviderResolver 的分工:后者解析**供应商配置**(增删列 API Key/endpoint),接管前提是
 * 抓到 apiKey;「切换模型到 deepseek」无 apiKey → 后者返回 null,两叶子互不 require、各自独立门控。
 *
 * 全局门控惯例:KHY_* 读法为 `!FALSY.has(v)`,FALSY = {0,false,off,no}(空串/未设 = 开)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_NL_MODEL_SWITCH 默认开,仅 {0,false,off,no} 关。env 由调用方注入。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_NL_MODEL_SWITCH;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 切换动作词(中英)────────────────────────────────────────────────────────
// 刻意收窄到「切换/更换/使用」语义;不含 add/remove/list,避免与供应商配置(nlProvider)重叠。
const _SWITCH_RE = /(切换|切到|换成|换为|改用|改成|改为|换到|换用|用一下|使用|\bswitch\b|\bchange\b|\buse\b|\bswitch\s*to\b)/i;

// ── 模型域引用(必须出现,收窄误判)──────────────────────────────────────────
const _MODEL_DOMAIN_RE = /(模型|\bmodel\b)/i;

// 模型 ID:「模型/model」后紧跟的一段标识符(允许 . : / -),或句中直接出现的具体模型 ID。
// 分隔词含中文语气助词(到/至/成)与英文 to,覆盖「切换模型到 deepseek-reasoner」这类语序。
const _MODEL_AFTER_RE = /(?:模型|\bmodel\b)\s*(?:为|是|=|:|：|id|to|到|至|成)?\s*([A-Za-z][A-Za-z0-9._:/-]{1,60})/i;

// 内置厂商 CJK / 常见别名 → poolKey(与 nlProviderResolver 的 _CJK_VENDOR_ALIASES 同值;零 IO 常量)。
// 加上 ASCII 直名(deepseek/openai/...),便于英文/直接写 poolKey 的输入。按别名长度降序匹配
// (先长后短:通义千问 先于 通义;deepseek 先于 无冲突短名),避免子串误命中。
const _VENDOR_ALIASES = [
  ['通义千问', 'qwen'], ['通义', 'qwen'], ['千问', 'qwen'],
  ['智谱清言', 'glm'], ['智谱', 'glm'],
  ['豆包', 'doubao'],
  ['百度文心', 'wenxin'], ['文心', 'wenxin'], ['百度', 'wenxin'],
  ['深度求索', 'deepseek'],
  ['中转', 'relay'],
  // ASCII 直名 / 常见品牌串 → poolKey。
  ['deepseek', 'deepseek'],
  ['qwen', 'qwen'], ['tongyi', 'qwen'],
  ['glm', 'glm'], ['zhipu', 'glm'], ['chatglm', 'glm'],
  ['doubao', 'doubao'],
  ['wenxin', 'wenxin'], ['ernie', 'wenxin'],
  ['openai', 'openai'], ['gpt', 'openai'],
  ['anthropic', 'anthropic'], ['claude', 'anthropic'],
  ['trae', 'trae'],
  ['relay', 'relay'],
].sort((a, b) => b[0].length - a[0].length);

/** 在文本中抽取**最先出现**的已知厂商别名 → poolKey;无 → ''。零 IO。 */
function _extractVendor(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  let best = '';
  let bestIdx = Infinity;
  for (const [alias, poolKey] of _VENDOR_ALIASES) {
    const idx = s.indexOf(alias.toLowerCase());
    // 取最先出现者(更贴近用户语序);同位置时已按长度降序,先到者更长(更精确)。
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      best = poolKey;
    }
  }
  return best;
}

function _firstGroup(re, text) {
  try {
    const m = String(text).match(re);
    return m && m[1] ? String(m[1]).trim() : '';
  } catch {
    return '';
  }
}

/**
 * 自然语言 → 模型切换意图。返回:
 *   { vendor, model }   (vendor 必有;model 为具体模型 ID 或 '')
 *   null                (未确定,绝不猜)
 * fail-soft:任何异常 → null。
 *
 * @param {string} text
 * @param {object} [env]
 * @returns {{vendor:string, model:string}|null}
 */
function resolve(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const t = String(text == null ? '' : text).trim();
    if (!t || t.length > 500) return null;

    // 三重同现闸门:切换动作词 + 模型域词 + 已知厂商,缺一不接管。
    if (!_SWITCH_RE.test(t)) return null;
    if (!_MODEL_DOMAIN_RE.test(t)) return null;
    const vendor = _extractVendor(t);
    if (!vendor) return null;

    // 具体模型 ID:优先「模型/model 后的标识符」;否则不强求(留 '' → 交给选择器)。
    // 仅当抽出的 model 串本身就带厂商特征(含 '-' 的多段标识符)才当作模型提示,避免把
    // 裸厂商名(deepseek)误当模型 ID。
    let model = _firstGroup(_MODEL_AFTER_RE, t);
    if (model && !/[-:/.]/.test(model)) {
      // 单段无分隔符(如 deepseek / gpt)更可能是厂商名而非具体模型 → 不作模型提示。
      model = '';
    }
    return { vendor, model };
  } catch {
    return null;
  }
}

/** vendor 的已知别名 token 集合(小写),用于宽松匹配 model/adapter 命名。零 IO。 */
function _vendorTokens(vendor) {
  const v = String(vendor == null ? '' : vendor).trim().toLowerCase();
  if (!v) return [];
  const tokens = new Set([v]);
  for (const [alias, poolKey] of _VENDOR_ALIASES) {
    if (poolKey === v) tokens.add(String(alias).toLowerCase());
  }
  // 仅保留 ASCII token(用于匹配 model/adapter 命名;CJK 别名不会出现在 model id 里)。
  return Array.from(tokens).filter((x) => /^[a-z0-9_-]+$/.test(x));
}

/**
 * 过滤 buildGatewayModelChoices 的 modelChoices,只保留属于 vendor 的项。**纯**函数:
 * 给定 choices 数组即可判定,不做任何 IO。判定:c.value.adapter === vendor,或 c.value.model /
 * c.value.adapter 命名包含 vendor 的任一已知 ASCII token。这样官方 deepseek 适配器、Trae 的
 * deepseek-v3、中转站里的 deepseek 模型都会被纳入(每条 = 一个供应商/官方)。
 *
 * @param {Array} choices  [{ name, value:{adapter, model}, disabled }]
 * @param {string} vendor  poolKey(如 'deepseek')
 * @param {string} [modelHint]  具体模型 ID 提示(有则精确匹配优先排序,不改集合)
 * @returns {Array} 过滤后的 choices(原对象引用,不复制)
 */
function filterModelChoices(choices, vendor, modelHint) {
  try {
    if (!Array.isArray(choices) || choices.length === 0) return [];
    const tokens = _vendorTokens(vendor);
    if (tokens.length === 0) return [];
    const matched = choices.filter((c) => {
      if (!c || !c.value) return false;
      const adapter = String(c.value.adapter == null ? '' : c.value.adapter).toLowerCase();
      const model = String(c.value.model == null ? '' : c.value.model).toLowerCase();
      if (adapter === String(vendor).toLowerCase()) return true;
      return tokens.some((tk) => adapter.includes(tk) || model.includes(tk));
    });
    const hint = String(modelHint == null ? '' : modelHint).trim().toLowerCase();
    if (!hint) return matched;
    // 精确匹配的排前(不剔除其它,便于同名不同供应商仍可选)。
    return matched.slice().sort((a, b) => {
      const am = String(a.value.model == null ? '' : a.value.model).toLowerCase() === hint ? 0 : 1;
      const bm = String(b.value.model == null ? '' : b.value.model).toLowerCase() === hint ? 0 : 1;
      return am - bm;
    });
  } catch {
    return [];
  }
}

/**
 * 唯一命中直接切换判定:仅当 modelHint 非空、且过滤后的项里**精确匹配** model 恰好一条(且可选)
 * → 返回该条 c.value(供调用方直接 applyGatewayModelSelection);否则返回 null(交给选择器)。
 *
 * @param {Array} filtered  filterModelChoices 的结果
 * @param {string} modelHint
 * @returns {{adapter:string, model:string}|null}
 */
function resolveDirectPick(filtered, modelHint) {
  try {
    const hint = String(modelHint == null ? '' : modelHint).trim().toLowerCase();
    if (!hint || !Array.isArray(filtered)) return null;
    const exact = filtered.filter((c) =>
      c && c.value && !c.disabled
      && String(c.value.model == null ? '' : c.value.model).toLowerCase() === hint);
    return exact.length === 1 ? exact[0].value : null;
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  resolve,
  filterModelChoices,
  resolveDirectPick,
};
