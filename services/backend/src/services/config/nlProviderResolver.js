'use strict';

/**
 * nlProviderResolver — 纯叶子:零 IO、确定性、fail-soft 的自然语言 → 模型供应商配置
 * 意图解析(单一真源)。把「用自然语言增/删/列 API Key、endpoint、URL、AI 模型」这条
 * 需求的**解析面**代码化:本叶子只把中/英自然语言确定性地解析成结构化意图对象,绝不碰
 * 文件系统 / 网络 / 子进程,真正落地写入(密钥池 + 自定义 provider 注册表 + .env 路由)由
 * 调用方薄壳(localBrainService 的 _executeProviderCfg / configureModelProvider 工具)经
 * 既有 SSOT(customProviderRegistrar / customProviderRegistry / apiKeyPool)完成。
 *
 * 契约:零 IO、确定性、绝不抛(任何异常 → null)、env 门控 KHY_NL_PROVIDER 默认开。
 * 零假阳性:解析成立必须同时命中「动作词」(增/删/列)+「领域引用」(供应商/密钥/模型/
 * endpoint),否则返回 null(绝不猜)——故「删除这行代码」「添加一个功能」「列出当前
 * 目录文件」都不会被误判为供应商配置。
 *
 * 安全:本叶子把 apiKey **单独成字段**返回,便于上层一处统一脱敏(maskToken);本叶子
 * 自身不打印、不记录任何 key。门控关(KHY_NL_PROVIDER=off,落 {0,false,off,no})→
 * resolve 返回 null → 薄壳意图永不命中 → Tier A 字节回退到兜底菜单。
 *
 * 全局门控惯例:KHY_* 读法为 `!FALSY.has(v)`,FALSY = {0,false,off,no}。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_NL_PROVIDER 默认开,仅 {0,false,off,no} 关。env 由调用方注入。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_NL_PROVIDER;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

/**
 * 子门控:KHY_NL_PROVIDER_REPLACE 默认开,仅 {0,false,off,no} 关。
 * 仅管「替换密钥」这片新增能力:replace 动词族 + CJK 厂商名抽取 + needsProvider 反问信号。
 * 关 → 三项全部短路,resolve 对替换措辞逐字节回退到既有(add/list/null)行为。
 */
function _replaceEnabled(env = process.env) {
  const raw = env && env.KHY_NL_PROVIDER_REPLACE;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── 动作词(增 / 删 / 列),中英 ────────────────────────────────────────────────
const _ADD_RE = /(添加|新增|增加|配置|设置|接入|注册|加上|加个|加一个|\badd\b|\bconfig(?:ure)?\b|\bregister\b|\bset\s*up\b|\bsetup\b)/i;
// 替换动词族(子门控 KHY_NL_PROVIDER_REPLACE):语义等同 add —— applyBuiltinProviderKey 本就是
// 「写入/替换该厂商密钥」。刻意不含任何 remove 词(替换≠删除),避免与 _REMOVE_RE 冲突。
const _REPLACE_RE = /(替换|换成|换为|更换|改成|改为|改用|换掉|修改|更新|切换|换|\breplace\b|\bswap\b|\bupdate\b|\bchange\b)/i;
const _REMOVE_RE = /(删除|删掉|移除|去掉|注销|卸载|清除|\bremove\b|\bdelete\b|\bunregister\b|\brm\b)/i;
const _LIST_RE = /(列出|列举|查看|显示|展示|看看|看一下|有哪些|\blist\b|\bshow\b)/i;

// ── 领域引用(供应商 / 密钥 / 模型 / endpoint·url)──────────────────────────────
const _DOMAIN_PROVIDER_RE = /(供应商|供应方|厂商|provider|渠道|中转|relay)/i;
const _DOMAIN_KEY_RE = /(api\s*key|apikey|密钥|秘钥|令牌|\bkey\b|\btoken\b)/i;
const _DOMAIN_MODEL_RE = /(模型|\bmodel\b)/i;
const _DOMAIN_ENDPOINT_RE = /(endpoint|端点|base\s*url|接口地址|接口|地址|\burl\b)/i;
const _DOMAIN_ANY_RE = new RegExp(
  [_DOMAIN_PROVIDER_RE, _DOMAIN_KEY_RE, _DOMAIN_MODEL_RE, _DOMAIN_ENDPOINT_RE]
    .map((r) => r.source).join('|'),
  'i',
);

// ── 字段抽取 ─────────────────────────────────────────────────────────────────
// API Key:优先 sk- 前缀的常见形态;否则取「密钥/key/令牌」后紧跟的一段长 token。
const _SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{6,}\b/;
const _KEY_AFTER_RE = /(?:api\s*key|apikey|密钥|秘钥|令牌|\bkey\b|\btoken\b)\s*(?:为|是|=|:|：)?\s*([A-Za-z0-9][A-Za-z0-9_-]{11,})/i;
// Endpoint / URL:第一段 http(s) URL。
// 模型 ID:「模型/model」后紧跟的一段标识符(允许 . : / -)。
const _MODEL_AFTER_RE = /(?:模型|\bmodel\b)\s*(?:为|是|=|:|：|id)?\s*([A-Za-z0-9][A-Za-z0-9._:/-]{1,60})/i;
// 供应商名:显式「供应商/厂商/provider/渠道」后的名字(中英皆可)。
const _PROVIDER_AFTER_RE = /(?:供应商|供应方|厂商|provider|渠道|中转|relay)\s*(?:名(?:为|叫)?|叫做?|为|是|:|：)?\s*([A-Za-z0-9一-龥][A-Za-z0-9._一-龥-]{0,40})/i;
// 供应商名:「给/为 <name> 添加/配置…」里 name 紧跟在 给/为 之后、动作词之前。
const _PROVIDER_GIVE_RE = /(?:给|为)\s*([A-Za-z0-9][A-Za-z0-9._-]{1,40})\s*(?:添加|新增|增加|配置|设置|接入|注册|加)/i;
// 供应商名:「<name> 的? 密钥/key」里 name 在前(仅接受 ASCII 形 vendor 名,避免吞动作词/CJK 短语)。
const _PROVIDER_BEFORE_KEY_RE = /([A-Za-z0-9][A-Za-z0-9._-]{1,40})\s*(?:的)?\s*(?:api\s*key|apikey|密钥|秘钥|\bkey\b)/i;
// remove 目标:删除动作后跟的名字(经显式 供应商/厂商/provider/模型 关键词,或 ASCII token)。
const _REMOVE_TARGET_AFTER_RE = /(?:删除|删掉|移除|去掉|注销|卸载|清除|remove|delete|unregister)\s*(?:这个|那个|掉)?\s*(?:供应商|供应方|厂商|provider|渠道|中转|relay|模型|model)?\s*(?:名(?:为|叫)?|叫做?|为|是|:|：)?\s*([A-Za-z0-9一-龥][A-Za-z0-9._一-龥-]{0,40})/i;

// 确认闸门(同 rm/data_cleanup):仅同句显式确认才真删。
const _CONFIRM_RE = /(确认删除|确定删除|确认|确定|执行删除|真的删|马上删|立即删|立刻删|do\s*it|\bconfirm\b|^yes\b)/i;
// 「连密钥一起删」才同时清除密钥(默认仅摘 provider 元数据 + 路由,保留密钥)。
const _ALSO_KEYS_RE = /(连\s*密钥|含\s*密钥|密钥\s*(?:也|一起)|(?:也|一起)\s*(?:删|清).{0,4}密钥|including\s+keys?|with\s+keys?|drop\s+keys?)/i;

// 抽取出的 provider/target 名字里不允许是这些纯动作/填充词(否则视作没抓到名字)。
const _STOPWORDS = new Set([
  '添加', '新增', '增加', '配置', '设置', '接入', '注册', '删除', '删掉', '移除', '去掉',
  '注销', '卸载', '清除', '列出', '查看', '显示', '一个', '这个', '那个', '我的', '的',
  '供应商', '模型', '密钥', '接口', '地址', '端点',
  'add', 'config', 'configure', 'register', 'remove', 'delete', 'unregister', 'list', 'show',
  'api', 'key', 'apikey', 'token', 'url', 'endpoint', 'model', 'provider',
]);

// nullish-安全字符串规整单一真源 utils/cleanText:null/undefined → 空串,其余 String 后 trim。
const _clean = require('../../utils/cleanText');

const _firstGroup = require('../../utils/firstGroup');

function _extractKey(text) {
  try {
    const sk = text.match(_SK_KEY_RE);
    if (sk) return sk[0];
  } catch { /* ignore */ }
  return _firstGroup(_KEY_AFTER_RE, text);
}

const _extractEndpoint = require('../../utils/extractEndpoint');

function _notStop(name) {
  return name && !_STOPWORDS.has(name) && !_STOPWORDS.has(name.toLowerCase());
}

// 内置厂商 CJK / 常见别名 → findBuiltinProvider 能解析的精确 token(poolKey)。零 IO 常量。
// 只命中**已知厂商串**(绝不分词、绝不吞动作词),把残缺中文名(裸 通义/文心/百度)规整成可落地 token。
// 按别名长度降序匹配(先长后短:通义千问 先于 通义),避免子串误命中。
const _CJK_VENDOR_ALIASES = [
  ['通义千问', 'qwen'], ['通义', 'qwen'], ['千问', 'qwen'],
  ['智谱清言', 'glm'], ['智谱', 'glm'],
  ['豆包', 'doubao'],
  ['百度文心', 'wenxin'], ['文心', 'wenxin'], ['百度', 'wenxin'],
  ['深度求索', 'deepseek'],
  ['中转', 'relay'],
].sort((a, b) => b[0].length - a[0].length);

function _extractCjkVendor(text) {
  const s = String(text == null ? '' : text);
  let best = '';
  let bestIdx = Infinity;
  for (const [alias, poolKey] of _CJK_VENDOR_ALIASES) {
    const idx = s.indexOf(alias);
    // 取文本中最先出现者(更贴近用户语序);同位置时已按长度降序,先到者更长。
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      best = poolKey;
    }
  }
  return best;
}

function _extractProvider(text, allowCjk) {
  const after = _firstGroup(_PROVIDER_AFTER_RE, text);
  if (_notStop(after)) return after;
  const give = _firstGroup(_PROVIDER_GIVE_RE, text);
  if (_notStop(give)) return give;
  const before = _firstGroup(_PROVIDER_BEFORE_KEY_RE, text);
  if (_notStop(before)) return before;
  // 第四级(子门控 KHY_NL_PROVIDER_REPLACE):CJK 厂商别名 → 精确 poolKey。关 → 不追加 → 字节回退。
  if (allowCjk) {
    const cjk = _extractCjkVendor(text);
    if (cjk) return cjk;
  }
  return '';
}

function _extractRemoveTarget(text) {
  const after = _firstGroup(_PROVIDER_AFTER_RE, text);
  if (after && !_STOPWORDS.has(after.toLowerCase()) && !_STOPWORDS.has(after)) return after;
  const t = _firstGroup(_REMOVE_TARGET_AFTER_RE, text);
  if (t && !_STOPWORDS.has(t.toLowerCase()) && !_STOPWORDS.has(t)) return t;
  return '';
}

/**
 * 自然语言 → 供应商配置意图。返回:
 *   { action:'list',   scope:'all' }
 *   { action:'add',    provider, apiKey, model, endpoint }                  (provider+apiKey 必有)
 *   { action:'add',    provider:'', apiKey, model, endpoint, needsProvider:true }
 *                                                                            (替换却没指明供应商→反问让我选)
 *   { action:'remove', target, confirmed, removeKeys }                      (target 必有)
 *   null                                                                     未确定(绝不猜)
 * fail-soft:任何异常 → null。
 */
function resolve(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const t = _clean(text);
    if (!t || t.length > 500) return null;

    // 零假阳性闸门:必须同时命中领域引用(供应商/密钥/模型/endpoint),否则一律不接管。
    if (!_DOMAIN_ANY_RE.test(t)) return null;

    const replaceOn = _replaceEnabled(env); // 子门控:replace 动词族 + CJK 抽取 + needsProvider
    const hasAdd = _ADD_RE.test(t);
    const hasReplace = replaceOn && _REPLACE_RE.test(t);
    const hasRemove = _REMOVE_RE.test(t);
    const hasList = _LIST_RE.test(t);

    // 1) 删除优先(破坏性,判据最严:须抓到具体目标 + 领域引用已满足)。
    if (hasRemove) {
      const target = _extractRemoveTarget(t);
      if (!target) return null; // 抓不到具体目标(如「删除这行代码」)→ 不接管
      return {
        action: 'remove',
        target,
        confirmed: _CONFIRM_RE.test(t),
        removeKeys: _ALSO_KEYS_RE.test(t),
      };
    }

    // 2) 添加 / 配置 / 替换:抓到 provider + apiKey 才接管为 add(替换语义=写入/替换该厂商密钥);
    //    否则不在此返回 null,继续向下落到 list(避免「查看已配置的模型」里子串误吞)。
    if (hasAdd || hasReplace) {
      const apiKey = _extractKey(t);
      const provider = apiKey ? _extractProvider(t, replaceOn) : '';
      if (apiKey && provider) {
        return {
          action: 'add',
          provider,
          apiKey,
          model: _firstGroup(_MODEL_AFTER_RE, t),
          endpoint: _extractEndpoint(t),
        };
      }
      // 替换却没指明供应商(拿到 key、没抽到 provider)→ 反问让用户选(不猜)。仅 replace 触发,
      // 普通 add 无 provider 维持现状(落到 list/null),保证非 replace 路径逐字节不变。
      if (hasReplace && apiKey && !provider) {
        return {
          action: 'add',
          provider: '',
          apiKey,
          model: _firstGroup(_MODEL_AFTER_RE, t),
          endpoint: _extractEndpoint(t),
          needsProvider: true,
        };
      }
    }

    // 3) 列出 / 查看:领域引用已满足即可(只读、零风险)。
    if (hasList) {
      return { action: 'list', scope: 'all' };
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  resolve,
};
