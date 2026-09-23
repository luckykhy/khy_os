'use strict';

/**
 * modelListTruth — 纯叶子(零 IO / 确定性 / 绝不抛):模型列表「存在性真值」的单一真源。
 *
 * 背景(用户反馈,逐字):
 *   「前端TUI与后端实际模型列表经常不一致:tui 会莫名跳转到不存在的模型(如 gpt-5.3 code review、
 *    claude sonnet3.5)并触发报错,且模型列表中频繁出现大量真实不存在的模型。」
 *
 * 定性的根因不是「前端有一份列表、后端有另一份」,而是**一条记录的存在性结论从未被收敛过**:
 *   适配器的 listModels() 是「候选池」而不是「真值表」—— 它把三类来源扁平地混成一个数组:
 *     · remote          上游 /models 亲口返回的 id —— 唯一**可证实**来源
 *     · builtin / local  静态硬编码目录 + 本机 IDE storage.json 正则扫描拾取 —— 猜测,可能不存在
 *     · hint / static    RELAY_API_MODELS 等 env 逗号串(用户手打 / 扫描回写)—— 同样未经证实
 *   下游(选择器 / 自动路由)只看到一个扁平数组,于是把猜测当事实展示:选中即 model_not_found。
 *
 * 本叶子的律 —— **上游权威覆盖律(upstream authority)**:
 *   一旦某适配器产出 ≥1 条 remote 记录,该 remote 集合即为该适配器**唯一权威**:
 *     除「上游 id 的结构性变体」(复合路由 `id::mode`,或 `_baseModelId` 命中上游集)外,
 *     builtin / local / hint / static 等未经证实来源一律剔除。
 *   若无任何 remote 记录(上游不可达,或该适配器本就没有列表接口),则**一条都不剔除** ——
 *     不知道就承认不知道:不臆造,也不滥杀;但这些记录会被打上 `unverified: true`,由 UI 显式标注。
 *
 * 另加两条与来源无关的**恒定律**:
 *   · 形态律:不符 `[A-Za-z0-9._:/-]` / 含空白或 CJK / 超长(>96)/ URL 形状 → 非法 ID,剔除。
 *     本仓 `modelDiscovery` 与 `_ideTokenMixin` 会把 IDE storage.json 里任意字符串正则扫描成
 *     「模型 ID」(`claude sonnet 3.5` 这类句子片段就是这么进来的)—— 形态律是它们的第一道闸。
 *   · 实测律:探活(modelCuration,TTL 内)已判 `failed` → 剔除。实测失败是对「存在」的反证。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(不碰 fs / 网络 / 子进程 / 时钟 / 随机;探活状态由调用方以回调注入)。
 *   - 确定性:同输入恒同输出(纯正则 + 集合运算,不 mutate 入参)。
 *   - 绝不抛:任何异常路径原样返回入参(零剔除),绝不吞掉调用方的模型列表。
 *   - env 门控 KHY_MODEL_LIST_TRUTH 默认开,仅 {0,false,off,no} 关;关 → isEnabled false,
 *     调用方走原路径(逐字节回退)。
 *   - 模型 ID 规范化复用 sibling `_modelIdParse`(normalizeModelIdCompact),不另写一份。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/** 门控 KHY_MODEL_LIST_TRUTH 是否启用。flagRegistry 优先(集中真源),失败再退本地 CANON 解析。绝不抛。 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_MODEL_LIST_TRUTH', env || process.env);
  } catch {
    /* fall through to local */
  }
  try {
    const raw = (env || process.env).KHY_MODEL_LIST_TRUTH;
    const v = String(raw === undefined || raw === null ? 'true' : raw)
      .trim()
      .toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

const normalizeId = require('./_modelIdParse').normalizeModelIdCompact;

// ── 来源分级 ────────────────────────────────────────────────────────────
// 刻意只把「确定是猜测」的四类列入 UNTRUSTED:欠拦安全(漏标的来源按可信处理,不会误杀),
// 过拦危险(把真实列表清空)。新增静态目录时**必须**打 'builtin' 标记才能被本律覆盖。
const UNTRUSTED_SOURCES = new Set(['builtin', 'local', 'hint', 'static', 'preset', 'guess', 'fallback']);

/** 权威来源:上游亲口返回。命中即触发上游权威覆盖律。 */
const AUTHORITATIVE_SOURCES = new Set(['remote', 'remote+local']);

/** 读一条记录的来源标记(兼容 discoverySource / source 两个字段)。零 IO。 */
function sourceOf(model) {
  return String((model && (model.discoverySource || model.source)) || '')
    .trim()
    .toLowerCase();
}

/** 该来源是否为「未经证实」(静态目录 / 本机扫描 / env 逗号串)。 */
function isUntrustedSource(src) {
  return UNTRUSTED_SOURCES.has(String(src || '').trim().toLowerCase());
}

/** 该来源是否为上游权威(可证实)。 */
function isAuthoritativeSource(src) {
  return AUTHORITATIVE_SOURCES.has(String(src || '').trim().toLowerCase());
}

// ── 形态律 ──────────────────────────────────────────────────────────────
// 合法模型 ID:字母数字起头,体内只允许 [A-Za-z0-9._:/-],长度 3..96(与 isLikelyModelId 同界)。
const ID_SHAPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,95}$/;
// 句子/文案特征:空白、CJK、引号、括号、反斜杠、@、问号 —— 都不是模型 ID 会长出来的东西。
const ID_NOISE_RE = /[\s\u3000-\u303f\u4e00-\u9fff\uff00-\uffef"'`()（）【】\\@?!,;*+=<>|[\]{}#%$^&]/;
// URL / 路径形状。
const ID_URL_LIKE_RE = /https?:|^www\.|\.\.|\/{2,}/i;

/**
 * 形态律判定:该 id 是否是一个**可能真实存在**的模型标识符。
 *
 * 注意顺序 —— **先看原始串,再做规范化**:本仓的规范化(normalizeModelIdCompact)会把内部
 * 空白**剥掉**,而「原始串含空白」本身就是最硬的证据:真实模型 ID 从不含空白。若先规范化再判定,
 * `claude sonnet3.5` 会被洗成 `claudesonnet3.5` 从而蒙混过关 —— 这正是本仓 modelDiscovery /
 * _ideTokenMixin 把 IDE storage.json 里的散文片段当模型 ID 拾取的机理。
 *
 * 绝不抛(非字符串经 String() 强转;空 → false)。
 * @param {*} raw
 * @returns {boolean}
 */
function isWellFormedId(raw) {
  try {
    const rawText = String(raw == null ? '' : raw)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    if (!rawText) {
      return false;
    }
    // 原始串层面的噪声(空白 / CJK / 引号 / 括号 / URL …)—— 出现即证明它不是模型 ID。
    if (ID_NOISE_RE.test(rawText) || ID_URL_LIKE_RE.test(rawText)) {
      return false;
    }
    const id = normalizeId(rawText);
    if (!id || id.length < 3 || id.length > 96) {
      return false;
    }
    if (!ID_SHAPE_RE.test(id)) {
      return false;
    }
    if (ID_NOISE_RE.test(id) || ID_URL_LIKE_RE.test(id)) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * id 是否为某权威 id 的**结构性变体**:复合路由 `id::mode` 的基名命中权威集,
 * 或记录自带 `_baseModelId` 命中权威集。绝不抛。
 * @param {object} model
 * @param {string} id
 * @param {Set<string>} authoritative 已规范化的权威 id 集合
 */
function isStructuralVariantOfAuthoritative(model, id, authoritative) {
  try {
    if (!authoritative || authoritative.size === 0) {
      return false;
    }
    const base = String((model && model._baseModelId) || '').trim();
    if (base && authoritative.has(normalizeId(base))) {
      return true;
    }
    const sep = String(id).indexOf('::');
    if (sep > 0) {
      return authoritative.has(normalizeId(String(id).slice(0, sep)));
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 逐条判定一条模型记录是否可信(非权威来源 + 未被证伪)。绝不抛。
 * @param {object} model
 * @returns {boolean}
 */
function isTrustedEntry(model) {
  return !isUntrustedSource(sourceOf(model));
}

/** 收集该批记录里的权威(上游)id 集合(已规范化)。绝不抛。 */
function collectAuthoritativeIds(models) {
  const set = new Set();
  try {
    for (const m of Array.isArray(models) ? models : []) {
      if (!m || !isAuthoritativeSource(sourceOf(m))) {
        continue;
      }
      const id = String(m.id || '').trim();
      if (id) {
        set.add(normalizeId(id));
      }
    }
  } catch {
    /* 绝不抛:拿不到权威集 → 空集,下游客观地退化为「无权威」 */
  }
  return set;
}

/** 读一次探活状态。绝不抛(探活层故障 → 'unknown',即不剔除)。 */
function readVerifyStatus(verifyStatusOf, adapterKey, id) {
  if (typeof verifyStatusOf !== 'function') {
    return 'unknown';
  }
  try {
    return String(verifyStatusOf(adapterKey, id) || 'unknown').toLowerCase();
  } catch {
    return 'unknown';
  }
}

/**
 * 单条记录的判定。返回 { keep, reason, unverified }。
 * reason ∈ 'malformed' | 'unconfirmed' | 'verify-failed' | ''。绝不抛。
 */
function judgeEntry(model, ctx) {
  const id = String((model && model.id) || '').trim();
  // 形态律(恒定律):非法 ID 一律剔除,与有无上游证据无关。
  if (!isWellFormedId(id)) {
    return { keep: false, reason: 'malformed', unverified: false };
  }
  const untrusted = isUntrustedSource(sourceOf(model));
  // 上游权威覆盖律:有权威时,非权威来源只有作为上游 id 的结构性变体才可保留。
  const overridden = untrusted && ctx.authoritative.size > 0;
  if (overridden && !isStructuralVariantOfAuthoritative(model, id, ctx.authoritative)) {
    return { keep: false, reason: 'unconfirmed', unverified: false };
  }
  // 实测律:TTL 内已被判 failed 的模型是反证,剔除。
  if (readVerifyStatus(ctx.verifyStatusOf, ctx.adapterKey, id) === 'failed') {
    return { keep: false, reason: 'verify-failed', unverified: false };
  }
  // 未证实来源(无权威可用 / 结构性变体)→ 保留,但显式标注供 UI 提示。
  return { keep: true, reason: '', unverified: untrusted };
}

/** 逃生口(与既有可靠性过滤同族):全被剔除时至少留一条默认/权威,绝不把列表清成空。
 *  该条形态亦非法 → 宁可空也不展示垃圾(空列表是诚实的)。绝不抛。 */
function escapeHatch(models) {
  const source = Array.isArray(models) ? models : [];
  const fallback =
    source.find((m) => m && (m.isDefault || isAuthoritativeSource(sourceOf(m)))) || source[0];
  return fallback && isWellFormedId(fallback.id) ? [fallback] : [];
}

/** 按判定结果分拣:返回 { kept, dropped, reasons, unverifiedCount }。绝不抛。 */
function partitionByVerdict(source, ctx) {
  const kept = [];
  const reasons = new Set();
  let dropped = 0;
  let unverifiedCount = 0;
  for (const m of source) {
    const verdict = judgeEntry(m, ctx);
    if (!verdict.keep) {
      dropped += 1;
      reasons.add(verdict.reason);
      continue;
    }
    if (verdict.unverified) {
      unverifiedCount += 1;
      kept.push(m && m.unverified !== true ? { ...m, unverified: true } : m);
    } else {
      kept.push(m);
    }
  }
  return { kept, dropped, reasons, unverifiedCount };
}

/**
 * 应用真值律:返回 { models, dropped, reasons, authoritative, unverifiedCount, bypassed }。
 * reasons ∈ {'malformed','unconfirmed','verify-failed'} 去重。
 *
 * @param {Array} models   适配器产出的原始候选(经 curation 后可含 user 新增项)
 * @param {object} [opts]
 * @param {string} [opts.adapterKey]            仅用于探活查询
 * @param {function} [opts.verifyStatusOf]      (adapterKey, modelId) => 'verified'|'failed'|'unknown'
 * @param {object} [opts.env]
 * @returns {{models:Array, dropped:number, reasons:string[], authoritative:boolean, unverifiedCount:number, bypassed:boolean}}
 */
function filterByUpstreamAuthority(models, opts = {}) {
  const source = Array.isArray(models) ? models.filter(Boolean) : [];
  const passthrough = {
    models: source,
    dropped: 0,
    reasons: [],
    authoritative: false,
    unverifiedCount: 0,
    bypassed: true,
  };
  try {
    if (!isEnabled(opts && opts.env)) {
      return passthrough;
    }
    if (source.length === 0) {
      return { ...passthrough, bypassed: false };
    }
    const ctx = {
      adapterKey: String((opts && opts.adapterKey) || ''),
      verifyStatusOf:
        opts && typeof opts.verifyStatusOf === 'function' ? opts.verifyStatusOf : null,
      authoritative: collectAuthoritativeIds(source),
    };
    const { kept, dropped, reasons, unverifiedCount } = partitionByVerdict(source, ctx);
    return {
      models: kept.length === 0 ? escapeHatch(source) : kept,
      dropped,
      reasons: [...reasons],
      authoritative: ctx.authoritative.size > 0,
      unverifiedCount,
      bypassed: false,
    };
  } catch {
    return passthrough; // 绝不抛:任何异常回退为「零剔除」
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeModelListTruth() {
  return {
    gate: 'KHY_MODEL_LIST_TRUTH',
    defaultOn: true,
    untrustedSources: [...UNTRUSTED_SOURCES],
    authoritativeSources: [...AUTHORITATIVE_SOURCES],
    laws: {
      authority: '某适配器产出 ≥1 条 remote 记录时,该 remote 集即唯一权威;非权威来源除非是上游 id 的结构性变体(::mode / _baseModelId),一律剔除。无 remote → 一条不剔,仅打 unverified 标注。',
      shape: 'ID 必须匹配 [A-Za-z0-9][A-Za-z0-9._:/-]{2,95},不得含空白 / CJK / 引号 / 括号 / URL 形状。',
      verify: '探活 TTL 内判定 failed 的模型剔除(实测失败是对「存在」的反证)。',
      escape: '全被剔除时保留默认/权威一条作为逃生口;若该条形态亦非法,则返回空列表(空是诚实的)。',
    },
    summary:
      '把「候选池」收敛为「真值表」:上游亲口返回的 id 才是事实,静态目录 / 本机扫描 / env 逗号串只是猜测。' +
      '有上游证据时按上游裁剪;无上游证据时不臆造也不滥杀,只显式标注 unverified。',
  };
}

module.exports = {
  isEnabled,
  normalizeId,
  sourceOf,
  isUntrustedSource,
  isAuthoritativeSource,
  isWellFormedId,
  isTrustedEntry,
  isStructuralVariantOfAuthoritative,
  filterByUpstreamAuthority,
  describeModelListTruth,
  UNTRUSTED_SOURCES,
  AUTHORITATIVE_SOURCES,
};
