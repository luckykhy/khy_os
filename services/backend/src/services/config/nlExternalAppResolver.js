'use strict';

/**
 * nlExternalAppResolver — 纯叶子:零 IO、确定性、fail-soft 的自然语言 →「给外部软件配模型」
 * 意图解析(单一真源)。姊妹叶子 nlProviderResolver 管的是 **khy 自身**的模型供应商;本叶子
 * 管的是把模型配进 **6 个外部软件**:DeepSeek-Reasonix / DeepSeek-TUI / opencode / openclaw /
 * coze-studio / claude-code。只解析、绝不碰文件/网络/子进程;真正读写各 app 配置文件由调用方
 * 薄壳经 externalApps/*Adapter 落地。
 *
 * 契约:零 IO、确定性、绝不抛(任何异常 → null)、env 门控 KHY_NL_EXTERNAL_APP 默认开。
 * 零假阳性:解析成立必须同时命中「**app 名引用**」(opencode/openclaw/reasonix/…)+「动作词」
 * (增/删/列/查)+「领域引用」(模型/供应商/密钥/endpoint),缺一律返回 null(绝不猜)。
 * 故「删除这行代码」「配置一下环境」「opencode 怎么用」都不会被误判。
 *
 * 全局门控惯例:KHY_* 读法 `!FALSY.has(v)`,FALSY = {0,false,off,no}。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_NL_EXTERNAL_APP 默认开,仅 {0,false,off,no} 关。 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_NL_EXTERNAL_APP;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── app 名别名 → 规范 app id ─────────────────────────────────────────────────
// 按别名长度降序匹配(先长后短),避免子串误命中(如 "claude code" 先于 "claude")。
// 只命中**已知 app 名串**,绝不分词、绝不吞动作词。
const _APP_ALIASES = [
  ['deepseek-reasonix', 'reasonix'], ['deepseek reasonix', 'reasonix'], ['reasonix', 'reasonix'],
  ['deepseek-tui', 'deepseek-tui'], ['deepseek tui', 'deepseek-tui'], ['ds-tui', 'deepseek-tui'],
  ['deepseek 终端', 'deepseek-tui'],
  ['opencode', 'opencode'], ['open code', 'opencode'],
  ['openclaw', 'openclaw'], ['open claw', 'openclaw'],
  ['coze-studio', 'coze'], ['coze studio', 'coze'], ['coze', 'coze'], ['扣子', 'coze'],
  ['claude-code', 'claude-code'], ['claude code', 'claude-code'], ['claudecode', 'claude-code'],
].sort((a, b) => b[0].length - a[0].length);

/** 从文本抽出被点名的 app(最先出现者)。命中不到 → ''。 */
function _extractApp(text) {
  const s = String(text == null ? '' : text).toLowerCase();
  let best = '';
  let bestIdx = Infinity;
  for (const [alias, appId] of _APP_ALIASES) {
    const idx = s.indexOf(alias);
    if (idx !== -1 && idx < bestIdx) {
      bestIdx = idx;
      best = appId;
    }
  }
  return best;
}

// ── 动作词(增 / 删 / 列 / 查)中英 ─────────────────────────────────────────────
const _ADD_RE = /(添加|新增|增加|配置|设置|接入|注册|加上|加个|加一个|换成|改成|更新|\badd\b|\bconfig(?:ure)?\b|\bregister\b|\bset\s*up\b|\bsetup\b|\bupdate\b)/i;
const _REMOVE_RE = /(删除|删掉|移除|去掉|注销|卸载|清除|\bremove\b|\bdelete\b|\bunregister\b|\brm\b)/i;
const _LIST_RE = /(列出|列举|查看|显示|展示|看看|看一下|有哪些|\blist\b|\bshow\b)/i;
const _GET_RE = /(详情|详细|信息|查询|查一下|\bget\b|\bdetail|\binfo\b)/i;

// ── 领域引用(模型 / 供应商 / 密钥 / endpoint)─────────────────────────────────
const _DOMAIN_MODEL_RE = /(模型|\bmodel\b)/i;
const _DOMAIN_PROVIDER_RE = /(供应商|供应方|厂商|provider|渠道)/i;
const _DOMAIN_KEY_RE = /(api\s*key|apikey|密钥|秘钥|令牌|\bkey\b|\btoken\b)/i;
const _DOMAIN_ENDPOINT_RE = /(endpoint|端点|base\s*url|接口地址|\burl\b)/i;
const _DOMAIN_ANY_RE = new RegExp(
  [_DOMAIN_MODEL_RE, _DOMAIN_PROVIDER_RE, _DOMAIN_KEY_RE, _DOMAIN_ENDPOINT_RE]
    .map((r) => r.source).join('|'),
  'i',
);

// ── 字段抽取(与 nlProviderResolver 同款惯例)─────────────────────────────────
const _SK_KEY_RE = /\bsk-[A-Za-z0-9_-]{6,}\b/;
const _KEY_AFTER_RE = /(?:api\s*key|apikey|密钥|秘钥|令牌|\bkey\b|\btoken\b)\s*(?:为|是|=|:|：)?\s*([A-Za-z0-9][A-Za-z0-9_-]{11,})/i;
const _MODEL_AFTER_RE = /(?:模型|\bmodel\b)\s*(?:为|是|=|:|：|id)?\s*([A-Za-z0-9][A-Za-z0-9._:/-]{1,60})/i;
// provider(厂商)名:显式关键词后,或常见厂商别名。
const _PROVIDER_AFTER_RE = /(?:供应商|供应方|厂商|provider|渠道)\s*(?:名(?:为|叫)?|叫做?|为|是|:|：)?\s*([A-Za-z0-9一-龥][A-Za-z0-9._一-龥-]{0,40})/i;
// 常见厂商别名 → 规范 provider id(用于「给 opencode 配 deepseek 模型」这类无显式"供应商"关键词)。
const _PROVIDER_ALIASES = [
  ['deepseek', 'deepseek'], ['深度求索', 'deepseek'],
  ['openai', 'openai'], ['gpt', 'openai'],
  ['anthropic', 'anthropic'], ['claude', 'anthropic'],
  ['gemini', 'gemini'], ['google', 'gemini'],
  ['grok', 'grok'], ['xai', 'grok'],
  ['moonshot', 'moonshot'], ['kimi', 'moonshot'],
  ['通义千问', 'qwen'], ['通义', 'qwen'], ['qwen', 'qwen'], ['千问', 'qwen'],
  ['智谱', 'glm'], ['glm', 'glm'],
  ['豆包', 'doubao'], ['doubao', 'doubao'], ['ark', 'doubao'],
  ['openrouter', 'openrouter'],
].sort((a, b) => b[0].length - a[0].length);

// remove 目标:删除动作后的名字(可含厂商/模型关键词或裸 token)。
const _REMOVE_TARGET_AFTER_RE = /(?:删除|删掉|移除|去掉|注销|卸载|清除|remove|delete|unregister)\s*(?:这个|那个|掉)?\s*(?:供应商|供应方|厂商|provider|渠道|模型|model)?\s*(?:名(?:为|叫)?|叫做?|为|是|:|：)?\s*([A-Za-z0-9一-龥][A-Za-z0-9._一-龥-]{0,40})/i;

const _CONFIRM_RE = /(确认删除|确定删除|确认|确定|执行删除|真的删|马上删|立即删|立刻删|do\s*it|\bconfirm\b|^yes\b)/i;
const _ALSO_KEYS_RE = /(连\s*密钥|含\s*密钥|密钥\s*(?:也|一起)|(?:也|一起)\s*(?:删|清).{0,4}密钥|including\s+keys?|with\s+keys?|drop\s+keys?)/i;

const _STOPWORDS = new Set([
  '添加', '新增', '增加', '配置', '设置', '接入', '注册', '删除', '删掉', '移除', '去掉',
  '注销', '卸载', '清除', '列出', '查看', '显示', '一个', '这个', '那个', '我的', '的',
  '供应商', '模型', '密钥', '接口', '地址', '端点', '详情', '详细', '信息', '查询',
  'add', 'config', 'configure', 'register', 'remove', 'delete', 'unregister', 'list', 'show',
  'api', 'key', 'apikey', 'token', 'url', 'endpoint', 'model', 'provider',
  // app 名本身不能被当作 provider/target 名。
  'opencode', 'openclaw', 'reasonix', 'coze', 'claude', 'deepseek-tui', 'claude-code',
]);

// nullish-安全字符串规整单一真源 utils/cleanText:null/undefined → 空串,其余 String 后 trim。
const _clean = require('../../utils/cleanText');

const _firstGroup = require('../../utils/firstGroup');

function _notStop(name) {
  return name && !_STOPWORDS.has(name) && !_STOPWORDS.has(name.toLowerCase());
}

function _extractKey(text) {
  try {
    const sk = text.match(_SK_KEY_RE);
    if (sk) return sk[0];
  } catch { /* ignore */ }
  return _firstGroup(_KEY_AFTER_RE, text);
}

const _extractEndpoint = require('../../utils/extractEndpoint');

/** provider:先显式关键词后取名,再落厂商别名表。 */
function _extractProvider(text) {
  const after = _firstGroup(_PROVIDER_AFTER_RE, text);
  if (_notStop(after)) return after.toLowerCase();
  // 回退厂商别名扫描前,先抹去被点名的 app 名(deepseek-tui / claude-code /
  // deepseek-reasonix 等):否则 app 名内嵌的厂商别名(deepseek-tui⊃deepseek、
  // claude-code⊃claude、deepseek-reasonix⊃deepseek)会早于用户真正指定的 provider
  // 命中。_STOPWORDS 已收录这些 app 名正是为杜绝此串扰,但 `_notStop` 守卫此前只作用于
  // 上面的显式关键词路径,从不覆盖这条别名回退——app 名越靠前(通常在句首)误命中越必然。
  // 按 _APP_ALIASES 长度降序抹除(长别名先行,避免 deepseek-reasonix 残留 reasonix)。
  let low = String(text).toLowerCase();
  for (const [alias] of _APP_ALIASES) {
    if (low.indexOf(alias) !== -1) low = low.split(alias).join(' ');
  }
  let best = '';
  let bestIdx = Infinity;
  for (const [alias, id] of _PROVIDER_ALIASES) {
    const idx = low.indexOf(alias);
    if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = id; }
  }
  return best;
}

function _extractRemoveTarget(text) {
  const t = _firstGroup(_REMOVE_TARGET_AFTER_RE, text);
  if (_notStop(t)) return t.toLowerCase();
  // 回退:厂商别名(「删掉 opencode 里的 deepseek」)。
  return _extractProvider(text);
}

/**
 * 自然语言 →「给外部软件配模型」意图。返回:
 *   { app, action:'list' }
 *   { app, action:'get',    target }
 *   { app, action:'add',    provider, apiKey, model, endpoint }   (至少 provider 或 model 有一)
 *   { app, action:'remove', target, confirmed, removeKeys }       (target 必有)
 *   null                                                          未确定(绝不猜)
 * fail-soft:任何异常 → null。
 */
function resolve(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const t = _clean(text);
    if (!t || t.length > 500) return null;

    // 零假阳性闸门①:必须点名 6 个 app 之一,否则一律不接管(交给 nlProviderResolver 等)。
    const app = _extractApp(t);
    if (!app) return null;

    // 零假阳性闸门②:必须命中领域引用(模型/供应商/密钥/endpoint)。
    if (!_DOMAIN_ANY_RE.test(t)) return null;

    const hasAdd = _ADD_RE.test(t);
    const hasRemove = _REMOVE_RE.test(t);
    const hasList = _LIST_RE.test(t);
    const hasGet = _GET_RE.test(t);

    // 1) 删除优先(破坏性,判据最严:须抓到具体目标)。
    if (hasRemove) {
      const target = _extractRemoveTarget(t);
      if (!target) return null;
      return {
        app,
        action: 'remove',
        target,
        confirmed: _CONFIRM_RE.test(t),
        removeKeys: _ALSO_KEYS_RE.test(t),
      };
    }

    // 2) 添加 / 配置:抓到 provider 或 model 至少其一才接管为 add。
    if (hasAdd) {
      const provider = _extractProvider(t);
      const model = _firstGroup(_MODEL_AFTER_RE, t);
      const apiKey = _extractKey(t);
      if (provider || model) {
        return {
          app,
          action: 'add',
          provider,
          apiKey,
          model,
          endpoint: _extractEndpoint(t),
        };
      }
    }

    // 3) 列出 / 查看(只读)。
    if (hasList) {
      return { app, action: 'list' };
    }

    // 4) 查详情(只读):须点到具体 provider/model 目标。
    if (hasGet) {
      const target = _extractProvider(t) || _firstGroup(_MODEL_AFTER_RE, t);
      if (target) return { app, action: 'get', target };
    }

    return null;
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  resolve,
  _extractApp,
  _extractProvider,
};
