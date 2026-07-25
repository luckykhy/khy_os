'use strict';

/**
 * modelExistenceEvidence — 纯叶子:当有证据表明模型**确实存在(已送达上游)**时,为
 * `model_not_found` 的「真实失败原因」行追加一句纠偏注解,不再自相矛盾地只报「找不到模型」。
 *
 * 背景(用户反馈,逐字):
 *   「glm-4.6v-flash 是可以用的,之前出现过复合 id 错误,后面又说 token 太大了,既然存在就不应该
 *    显示为找不到模型」。
 *   token 超限(GLM code 1210/1211、max_tokens/context 类 400)证明请求**已到达该模型**——模型存在;
 *   同轮里却又把某次 model_not_found(多为复合 id 未剥裸名 / 临时路由)顶到「真实失败原因」头条,
 *   显示成「模型不存在」,与「刚刚还嫌 token 太大」直接矛盾。
 *
 * 定性:model_not_found 的**分类不改**(仍是那次尝试的真实 errorType),本叶子只在**显示层**追加
 *   一句注解,点明「本轮该模型曾送达上游(有参数/token 类报错为证),多为复合 id 未剥裸名或临时路由,
 *   非模型真的不存在」;并对**复合 id 形状**(送错字符串)单独点名。行为层(是否放行冷却/重试)由
 *   sibling modelNotFoundCooldownScope 负责,本叶子零副作用。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 env 门控;不碰 fs / 网络 / 子进程 / 时钟 / 随机)。
 *   - 确定性:同输入恒同输出(纯正则 + 数组扫描)。
 *   - 绝不抛:任何异常路径原样返回入参 line(逐字节回退,绝不吞行)。
 *   - 门控 KHY_MNF_EXISTENCE_NOTE 默认开(parent KHY_MODEL_NOT_FOUND_RECOVERY);关或无证据 →
 *     原样返回入参 line。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_MNF_EXISTENCE_NOTE 是否启用。flagRegistry 优先(集中真源,含 parent 门联动),
 * 失败/不可用再退本地 CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_MNF_EXISTENCE_NOTE', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_MNF_EXISTENCE_NOTE;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// 「已送达上游」的信号:上游对参数/token 的拒绝证明请求到了模型(模型存在),这类**不是** 404 不存在。
//   GLM code 1210(max_tokens 过大)/1211(视觉参数超限)、max_tokens/context length/too large/too long、
//   以及泛化的参数类 invalid_request/parameter 报错。
const _REACHED_MSG_RE = /(?:\b|code\s*)(?:1210|1211)\b|max[_\s-]?tokens|context[_\s-]?length|too\s+(?:large|long|many\s+tokens)|invalid[_\s-]?request|parameter/i;

// 「已送达上游」的 errorType:凡非「不存在/鉴权/不可用」类的失败,都意味着请求到达了模型。
const _ABSENCE_OR_PREFLIGHT_TYPES = new Set([
  'model_not_found', 'auth', 'auth_permanent', 'permission', 'unavailable', 'cancelled', 'empty',
]);

function _norm(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

/**
 * 本轮尝试里是否有证据表明模型已送达上游(即「模型存在」)。跨 attempts 扫描,不依赖 per-attempt
 * 模型串(cascade 里模型可能多个,这里取保守的「本轮任一尝试触达过上游」信号)。绝不抛。
 * @param {Array} attempts  allAttempts(每项含 errorType / error / statusCode)
 * @returns {boolean}
 */
function hasReachedEvidence(attempts) {
  try {
    const list = Array.isArray(attempts) ? attempts : [];
    for (const a of list) {
      if (!a || a.success === true) continue;
      const type = _norm(a.errorType);
      if (type && !_ABSENCE_OR_PREFLIGHT_TYPES.has(type)) return true;
      const msg = String(a.error || a.rawError || a.message || '');
      if (_REACHED_MSG_RE.test(msg)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// 复合路由 id(`api:<pool>:<model>`,三段式)——上游只认裸名,这是**送错字符串**而非模型不存在。
// 与 modelNotFoundRecovery.classifyModelNameShape 的 _COMPOSITE_ROUTE_RE 同源(纯结构判定)。
const _COMPOSITE_ROUTE_RE = /^[a-z0-9_-]+[:/][a-z0-9_-]+[:/].+$/i;

// 从错误消息里粗取模型串(用于复合 id 形状判定)。取不到 → ''。
const _MODEL_IN_MSG_RE = /model[_\s-]?not[_\s-]?found[:\s]+[`'"]?([\w./:\-]+)|the\s+model\s+[`'"]?([\w./:\-]+)[`'"]?\s+does\s+not\s+exist/i;

function _looksComposite(model, message) {
  try {
    const explicit = String(model == null ? '' : model).trim();
    if (explicit) return _COMPOSITE_ROUTE_RE.test(explicit);
    const m = String(message == null ? '' : message).match(_MODEL_IN_MSG_RE);
    const found = m && (m[1] || m[2]);
    return found ? _COMPOSITE_ROUTE_RE.test(found.trim()) : false;
  } catch {
    return false;
  }
}

/**
 * 为一条 model_not_found 的「真实失败原因」行追加存在性纠偏注解。
 * 门关 / 非 model_not_found / 无任何存在性证据 → 原样返回 line(逐字节回退)。绝不抛。
 *
 * @param {object} [opts]
 * @param {string} [opts.line]       原始行(如 `- api [model_not_found]: recent ... cached (cooldown 28s)`)
 * @param {*}      [opts.errorType]  该行对应的 errorType
 * @param {*}      [opts.message]    该行对应的错误消息(用于复合 id 形状判定)
 * @param {*}      [opts.model]      该行对应的模型串(若上游可提供)
 * @param {Array}  [opts.attempts]   本轮全部 attempts(用于跨尝试的「已送达」证据)
 * @param {object} [opts.env]
 * @returns {string} 追加注解后的行,或原样入参 line
 */
function annotateModelNotFoundLine(opts = {}) {
  const line = String((opts && opts.line) == null ? '' : opts.line);
  try {
    if (!isEnabled(opts && opts.env)) return line;
    if (_norm(opts.errorType) !== 'model_not_found') return line;
    const composite = _looksComposite(opts.model, opts.message);
    const reached = hasReachedEvidence(opts.attempts);
    if (!composite && !reached) return line;
    if (composite) {
      return line + '（注:送出的是复合路由 id[api:<pool>:<model>],上游只认裸模型名——属送错字符串,'
        + '剥成裸名即可,非模型不存在）';
    }
    return line + '（注:本轮该模型曾送达上游[有参数/token 类报错为证],此 model_not_found 多为复合 id 未剥裸名'
      + '或临时路由所致,非模型真的不存在——剥裸名/重试通常即可成功）';
  } catch {
    return line;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeModelExistenceEvidence() {
  return {
    gate: 'KHY_MNF_EXISTENCE_NOTE',
    parent: 'KHY_MODEL_NOT_FOUND_RECOVERY',
    defaultOn: true,
    summary: '当有证据表明模型已送达上游(参数/token 类报错、或送出串为复合路由 id)时,为 model_not_found 的'
      + '「真实失败原因」行追加纠偏注解(复合 id → 送错字符串;已送达 → 非模型不存在),消解「刚嫌 token 太大、'
      + '转头又说找不到模型」的自相矛盾。只改显示、不改分类,门控关或无证据则逐字节回退。',
  };
}

module.exports = {
  isEnabled,
  hasReachedEvidence,
  annotateModelNotFoundLine,
  describeModelExistenceEvidence,
};
