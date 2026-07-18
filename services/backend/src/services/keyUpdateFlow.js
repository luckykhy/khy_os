'use strict';

/**
 * keyUpdateFlow —— 纯叶子(pure leaf):API Key 失效→询问→**无模型也能更新**的单一真源。
 *
 * /goal「apikey 失效后需要询问是否帮忙更新,即使没有模型也要能实现,当用户回答 apikey 后帮忙更新」。
 *
 * 分工(承既有基础设施,只补真正缺口):
 *   - **有模型时的邀请**:已由 honestFailureReason.buildKeyConfigInvite 在失败文案末尾追加
 *     「需要我帮你配置 <厂商> 的 API Key 吗」——本叶子不重复该路径。
 *   - **确定性写入链**:已由 nlProviderResolver.resolve → localBrainService._execProviderAdd →
 *     builtinProviderConfig.applyBuiltinProviderKey → apiKeyPool.addKey 落地(全程无需模型)。
 *   - **真缺口(本叶子填)**:
 *       ① 无模型兜底菜单从不邀请用户贴 key;
 *       ② 用户随后直接粘一段**裸 key**(如 `sk-...`,无动词/无厂商)——nlProviderResolver 的
 *          「域名引用 + 动作词」零误报闸门刻意不认它,于是这段裸 key 无法被确定性写入。
 *     本叶子提供:无模型邀请文案 + **裸 key 识别** + **厂商推断决策**,交由既有 _execProviderAdd 写入。
 *
 * 契约(leaf-contract):零 IO(不碰 fs/网络/子进程/process.exit)、确定性(同输入同输出)、
 * 单一真源、env 门控 KHY_KEY_UPDATE_FLOW 默认开(flagRegistry-first + 注册表关时回退本地 _off 判定,
 * 门关 → 逐字节回退:looksLikeBareKey 返 {isKey:false}、邀请返 ''、决策返 needsProvider)、
 * fail-soft 绝不抛。**不接触密钥落盘**——只做识别/文案/决策,真正写入仍走既有权限化链路。
 *
 * @module services/keyUpdateFlow
 */

const flagRegistry = require('./flagRegistry');

/** 关闭词表(对齐仓库既有门控约定)。注册表关时的 OFF-fallback 路径。 */
const _OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * 本流程是否启用。默认开;仅当 KHY_KEY_UPDATE_FLOW 显式置关闭词才禁用。
 * 委托 flagRegistry(注册表开时);注册表关时回退本地 _off 判定 → 逐字节等价。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_KEY_UPDATE_FLOW', env);
    }
    const raw = String((env && env.KHY_KEY_UPDATE_FLOW) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}

/**
 * 「形态推断出的厂商需先确认」子门控是否启用(KHY_KEY_SHAPE_CONFIRM,parent=KHY_KEY_UPDATE_FLOW)。
 * 父门关 → 本门必关(逐字节回退:形态命中仍直接归属,不产 shapeGuess)。默认开;
 * 仅当显式置关闭词才禁用。注册表关时回退本地 _off 判定 → 逐字节等价。
 * @param {object} [env]
 * @returns {boolean}
 */
function _isShapeConfirmEnabled(env = process.env) {
  try {
    if (!isEnabled(env)) return false;                       // parent 关 → 子必关
    if (flagRegistry.isRegistryEnabled(env)) {
      return flagRegistry.isFlagEnabled('KHY_KEY_SHAPE_CONFIRM', env);
    }
    const raw = String((env && env.KHY_KEY_SHAPE_CONFIRM) || '').trim().toLowerCase();
    if (!raw) return true;
    return !_OFF.has(raw);
  } catch { return true; }
}
// 只在**无模型**路径(cooperative:true)介入,风险有界:用户已被邀请「把 key 发我」。
// 判据仍保持严格——避免把普通问句里恰好出现的长串误当成 key。
const _SK_RE = /\bsk-[A-Za-z0-9_-]{6,}\b/;                 // OpenAI/DeepSeek/… 家族显式前缀
const _LONE_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.\-]{22,}[A-Za-z0-9]$/; // ≥24 字符的孤立长串
const _ID_SECRET_RE = /^[A-Za-z0-9]{6,}\.[A-Za-z0-9]{6,}$/;           // 智谱 id.secret 形态

/** 标签词(出现在 key 前后不算「内容」,如「密钥 sk-xxx」)。归一后匹配。 */
const _LABEL_WORDS = new Set([
  'key', 'apikey', 'api', 'token', 'secret', '密钥', '钥匙', '秘钥', '令牌',
  'the', 'my', '这是', '这个', '是', '用', '换成', '更新', '更换', '替换',
]);

/** 归一:lowercase + 去首尾中英文标点(便于标签/厂商比对)。 */
function _norm(tok) {
  return String(tok || '')
    .toLowerCase()
    .replace(/^[\s，。,.;；:：、「」"'`]+|[\s，。,.;；:：、「」"'`]+$/g, '');
}

/** 单个 token 是否长得像一把 key。 */
function _isKeyish(tok) {
  const t = _norm(tok);
  if (!t) return false;
  if (_SK_RE.test(t)) return true;
  if (_ID_SECRET_RE.test(t)) return true;
  if (_LONE_TOKEN_RE.test(t)) return true;
  return false;
}

/**
 * 仅去首尾中英文标点/空白,**保留原始大小写**。
 * 用于抽取 key 值——`_norm` 会 lowercase(供标签/厂商比对),但 API Key 的密钥段
 * 大小写敏感(如智谱 hex32.secret 的 secret 段含大小写混合),lowercase 会写入损坏的 key。
 * @param {string} tok
 * @returns {string}
 */
function _trimEdges(tok) {
  return String(tok || '')
    .replace(/^[\s，。,.;；:：、「」"'`]+|[\s，。,.;；:：、「」"'`]+$/g, '');
}

/** 从一个 keyish token 里剥出干净的 key 值(去尾随标点,**保留大小写**)。 */
function _cleanKey(tok) {
  const m = String(tok || '').match(_SK_RE);
  if (m) return m[0];
  return _trimEdges(tok);
}

/**
 * 判断一条消息是否「就是一把 API Key」(可含少量标签 / 厂商提示词)。
 * 门关 / 坏输入 / 过长 → {isKey:false}。
 * @param {string} text
 * @param {object} [env]
 * @returns {{isKey:boolean, key:string}}
 */
function looksLikeBareKey(text, env = process.env) {
  const NO = { isKey: false, key: '' };
  if (!isEnabled(env)) return NO;
  try {
    const t = String(text || '').trim();
    if (!t || t.length > 240) return NO;

    // sk- 家族:句中任意位置命中即认(允许「glm sk-xxx」「把 key 换成 sk-xxx」)。
    const sk = t.match(_SK_RE);
    if (sk) return { isKey: true, key: sk[0] };

    // 非 sk- 家族:按 token 扫描,恰好一个 keyish token 且其余都是标签/厂商/极短词。
    const tokens = t.split(/\s+/).filter(Boolean);
    const keyish = tokens.filter(_isKeyish);
    if (keyish.length !== 1) return NO;
    const others = tokens.filter((tok) => !_isKeyish(tok));
    const allLabelOrHint = others.every(
      (tok) => _LABEL_WORDS.has(_norm(tok)) || !!extractProviderHint(tok, env)
    );
    const fewShort = others.length <= 3 && others.every((o) => _norm(o).length <= 8);
    if (others.length === 0 || allLabelOrHint || fewShort) {
      return { isKey: true, key: _cleanKey(keyish[0]) };
    }
    return NO;
  } catch { return NO; }
}

// ── 厂商提示词 → 规范别名(findBuiltinProvider 会进一步解析内置别名)────────────────
const _HINTS = [
  [/智谱|zhipu|bigmodel|glm|清言/i, 'glm'],
  [/deepseek|深度求索/i, 'deepseek'],
  [/通义|千问|qwen|dashscope/i, 'qwen'],
  [/kimi|moonshot/i, 'moonshot'],
  [/豆包|doubao/i, 'doubao'],
  [/文心|wenxin|百度/i, 'wenxin'],
  [/openai|gpt-|gpt\b/i, 'openai'],
  [/anthropic|claude/i, 'anthropic'],
  [/agnes/i, 'agnes'],
  [/sensenova|商汤/i, 'sensenova'],
];

/**
 * 从文本里推断厂商别名;识别不到 → ''(不猜)。
 * @param {string} text
 * @param {object} [env]
 * @returns {string}
 */
function extractProviderHint(text, env = process.env) {
  if (!isEnabled(env)) return '';
  try {
    const t = String(text || '');
    if (!t) return '';
    for (const [re, alias] of _HINTS) {
      if (re.test(t)) return alias;
    }
    return '';
  } catch { return ''; }
}

// 智谱(GLM)API Key 的独有形态:`{32 位十六进制 id}.{secret}`(如
// `0123456789abcdef0123456789abcdef.FaKeSeCrEt123`)。khy 其它内置厂商(openai/deepseek/
// qwen/moonshot/sensenova…)均用 `sk-` 前缀,故这条 hex32.secret 形态在内置厂商里**唯一**指向
// 智谱 → 可据形态直接归属 glm,无需用户再点厂商。判据从严(32 位纯 hex 前缀 + 点 + ≥6 位密钥),
// 避免把普通 `a.b` 串误判。
const _ZHIPU_KEY_SHAPE_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{6,}$/i;

/**
 * 仅按 key 的**形态**推断厂商(不看上下文文本)。目前只认智谱 GLM 的 hex32.secret 形态 → 'glm'。
 * 其余形态一律 ''(不猜)。门关 / 坏输入 → ''。
 * @param {string} key
 * @param {object} [env]
 * @returns {string}
 */
function inferProviderFromKeyShape(key, env = process.env) {
  if (!isEnabled(env)) return '';
  try {
    const k = String(key || '').trim();
    if (!k) return '';
    if (_ZHIPU_KEY_SHAPE_RE.test(k)) return 'glm';
    return '';
  } catch { return ''; }
}

/**
 * 决定这把裸 key 归属哪个厂商(纯函数,给定输入即定输出):
 *   - 文本里点了厂商 → 用它(用户已明说,即时归属);
 *   - 否则按 key 形态可辨识(智谱 hex32.secret)→ **不静默拍板**:KHY_KEY_SHAPE_CONFIRM 开时返回
 *     { needsProvider:true, shapeGuess:'glm' } 交反问流带猜测确认(同形态未必真属智谱,用户可能贴的是
 *     别家兼容 key)。子门关 → 逐字节回退旧行为(形态命中直接 { provider:'glm' });
 *   - 否则当前**恰好只有一个**已配置厂商(通常正是那把失效 key 的归属)→ 用它;
 *   - 否则无法确定 → needsProvider(交由 _execProviderAskWhich 反问,不猜)。
 * @param {{hint?:string, key?:string, configuredPoolKeys?:string[]}} input
 * @param {object} [env]
 * @returns {{provider:string}|{needsProvider:true}|{needsProvider:true, shapeGuess:string}}
 */
function decideProvider(input, env = process.env) {
  if (!isEnabled(env)) return { needsProvider: true };
  try {
    const hint = String((input && input.hint) || '').trim();
    if (hint) return { provider: hint };
    // key 形态可辨识(目前唯智谱 GLM)。**不静默归属**——同形态未必真属智谱,先带猜测反问确认。
    const shape = inferProviderFromKeyShape((input && input.key) || '', env);
    if (shape) {
      if (_isShapeConfirmEnabled(env)) return { needsProvider: true, shapeGuess: shape };
      return { provider: shape };                             // 子门关 → 逐字节回退旧行为
    }
    const cfg = Array.isArray(input && input.configuredPoolKeys)
      ? input.configuredPoolKeys.filter(Boolean)
      : [];
    if (cfg.length === 1) return { provider: String(cfg[0]) };
    return { needsProvider: true };
  } catch { return { needsProvider: true }; }
}

/**
 * 无模型路径的确定性邀请文案(与 honestFailureReason.buildKeyConfigInvite 口径一致)。
 * 门关 → ''(逐字节回退:兜底菜单不追加邀请)。
 * @param {{provider?:string}} [opts]
 * @param {object} [env]
 * @returns {string}
 */
function buildKeyUpdateInvite(opts = {}, env = process.env) {
  if (!isEnabled(env)) return '';
  try {
    const provider = String((opts && opts.provider) || '').trim();
    const who = provider ? `${provider} 的 ` : '';
    return `检测到 ${who}API Key 失效或未配置。需要我帮你更新吗?`
      + `把 key 直接发我(如 sk-...),我就地帮你写入更新——无需任何模型即可完成。`;
  } catch { return ''; }
}

/**
 * 形态推断出厂商时的确认文案(交反问流呈现,让用户点头或改厂商)。门关(父或子)→ ''。
 * 全程不含 key 本体——只提厂商猜测。
 * @param {{shapeGuess?:string}} [opts]
 * @param {object} [env]
 * @returns {string}
 */
function buildShapeConfirmInvite(opts = {}, env = process.env) {
  if (!_isShapeConfirmEnabled(env)) return '';
  try {
    const guess = String((opts && opts.shapeGuess) || '').trim();
    if (!guess) return '';
    return `这把 key 的形态看起来像 ${guess} 的 key。确认要归属到 ${guess} 吗?`
      + `是就回「确认 ${guess}」;若其实是别家(如别家兼容 key),回「换成 <厂商名>」。`;
  } catch { return ''; }
}

module.exports = {
  isEnabled,
  looksLikeBareKey,
  extractProviderHint,
  inferProviderFromKeyShape,
  decideProvider,
  buildKeyUpdateInvite,
  buildShapeConfirmInvite,
  _isShapeConfirmEnabled,
  _norm,
  _isKeyish,
};
