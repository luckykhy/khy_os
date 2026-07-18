'use strict';

/**
 * nlExternalAppImportResolver — 纯叶子:零 IO、确定性、fail-soft 的自然语言 →「**反向使用**外部
 * 软件里的模型」意图解析(单一真源)。这是姊妹叶子 nlExternalAppResolver(把模型**配进** 6 个外部
 * 软件)的**逆向**:本叶子解析「**读**各外部软件已配置的可用模型,把它们**导入/注册进 khy 自己的
 * provider 池**,让 khy 能像用 codex / claude-code 的模型一样选它、调它」。
 *
 * 只解析、绝不碰文件/网络/子进程;真正的发现+注册由调用方薄壳经 appModelImporter 落地。
 *
 * 契约:零 IO、确定性、绝不抛(任何异常 → null)、env 门控 KHY_NL_EXTERNAL_APP_IMPORT 默认开。
 * 零假阳性:解析成立必须同时命中「**app 名引用**(6 个别名)」+「**反向动词**(用/使用/导入/引入/
 * 复用…,**区别于**正向的 配置/添加/删除)」+「**模型领域引用**(模型/model)」,三者缺一律返回
 * null(绝不猜、绝不接管,落到正向 resolver / provider handler)。
 *
 * 与正向 nlExternalAppResolver 的边界(互不接管):
 *   - 正向「给 opencode 配 deepseek 模型」:动词=配置/添加/删除 → 正向接管,本叶子无反向动词 → null。
 *   - 反向「用 opencode 里的模型」:动词=用/使用/导入 → 本叶子接管,正向无 add/remove/list/get → null。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控:KHY_NL_EXTERNAL_APP_IMPORT 默认开,仅 {0,false,off,no} 关。flagRegistry 优先,本地 CANON 回退。 */
function isEnabled(env = process.env) {
  try {
    const reg = require('./flagRegistry');
    if (reg && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_NL_EXTERNAL_APP_IMPORT', env);
    }
  } catch { /* registry unavailable — local CANON fallback */ }
  const raw = env && env.KHY_NL_EXTERNAL_APP_IMPORT;
  const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
  return !_FALSY.has(v);
}

// ── app 名别名 → 规范 app id(与正向 resolver 同表,按长度降序先长后短)─────────────
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
    if (idx !== -1 && idx < bestIdx) { bestIdx = idx; best = appId; }
  }
  return best;
}

// ── 反向动词分两级 ────────────────────────────────────────────────────────────
// 强反向动词:导入/引入/复用/借用/纳入/注册进…——语义上**只能**是"把外部软件的模型拿进 khy",
// 即便句中还带正向词(如「复用 claude code **配置**的模型」里 配置 是定语)也判反向。
const _STRONG_IMPORT_RE = /(导入|引入|复用|借用|拿来用|拿过来用|接过来用|注册进|注册到|纳入|收进来|接入到\s*khy|\bimport\b|\breuse\b)/i;
// 弱反向动词:使用/用——可能是正向「配置 opencode **使用** deepseek」的一部分,故仅当句中**无正向
// 配置动作**时才判反向。「使用/借用/复用/引用」等复合已由强动词或此处覆盖,裸「用」另表补。
const _WEAK_USE_RE = /(使用|用起来|用上|\buse\b)/i;
// 单字「用」作动词(排除「费用/作用/信用/应用/采用」等名词性复合):句首、标点、或常见助动词/介词
// (想/要/能/会/来/去/给/让/把/从/对 + 想要/可以/打算/准备)后的「用 …」。
const _BARE_USE_RE = /(?:^|[\s，。、；;:：给让把从对想要能会来去]|想要|可以|打算|准备)用\s*/;
// 正向配置动作(镜像 nlExternalAppResolver 的 add 动词,但**排除**反向的 注册进/注册到):命中即认为
// 是"把模型配进外部软件"的正向意图,弱反向动词须让位(强反向动词不让位)。
const _FORWARD_ADD_RE = /(添加|新增|增加|配置|设置|接入(?!到\s*khy)|注册(?!进|到)|加上|加个|加一个|\badd\b|\bconfig(?:ure)?\b|\bset\s*up\b|\bsetup\b)/i;

// ── 模型领域引用(必须命中,才认为在谈"模型")──────────────────────────────────────
const _DOMAIN_MODEL_RE = /(模型|\bmodel(?:s)?\b|大模型|\bllm\b)/i;

// ── "所有外部软件"(无 app 名时的整体导入)────────────────────────────────────────
const _ALL_APPS_RE = /(所有|全部|各个|每个|这些).{0,8}(外部(?:软件|应用|程序|工具)|软件|app)/i;

// nullish-安全字符串规整单一真源 utils/cleanText:null/undefined → 空串,其余 String 后 trim。
const _clean = require('../../utils/cleanText');

/**
 * 自然语言 →「反向使用外部软件里的模型」意图(**import-only**;只读的"列出可用"由正向
 * nlExternalAppResolver 的 list 服务,本叶子不重复接管)。返回:
 *   { app, action:'import' }              把该 app 可用模型导入/注册进 khy
 *   { action:'import', all:true }         导入所有外部软件的模型(无 app 名)
 *   null                                  未确定(绝不猜)
 * 判据:强反向动词(导入/复用/引入…)命中即接管;弱反向动词(使用/用)须句中**无正向配置动作**
 * (配置/添加/设置…)才接管,避免抢正向「配置 opencode 使用 deepseek」。fail-soft:任何异常 → null。
 */
function resolve(text, env = process.env) {
  try {
    if (!isEnabled(env)) return null;
    const t = _clean(text);
    if (!t || t.length > 500) return null;

    // 必须在谈"模型"(领域闸门),否则不接管("怎么使用 opencode" 谈的是软件本身)。
    if (!_DOMAIN_MODEL_RE.test(t)) return null;

    const strong = _STRONG_IMPORT_RE.test(t);
    // 弱反向动词仅当**无正向配置动作**时才算(让位正向「配置…使用…」)。
    const weak = (_WEAK_USE_RE.test(t) || _BARE_USE_RE.test(t)) && !_FORWARD_ADD_RE.test(t);
    const hasImport = strong || weak;
    if (!hasImport) return null;

    const app = _extractApp(t);

    // 无 app 名:仅当「所有外部软件 + 导入动词」→ 整体导入;否则不接管(不猜单个 app)。
    if (!app) {
      if (_ALL_APPS_RE.test(t)) return { action: 'import', all: true };
      return null;
    }
    return { app, action: 'import' };
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  resolve,
  _extractApp,
};
