'use strict';

/**
 * modelNotFoundRecovery — 纯叶子:为 strict/钉选通道遇 `model_not_found`(404)硬失败时,
 * 生成一段可执行的恢复指引(追加到 buildPreferredAdapterRecoveryHint 的建议行末尾)。
 *
 * 背景(用户实测,/goal「驱动 khyos 解决这个错误」):
 *   auto 模式下模型串 `api:agnes:agnes-2.0-flash`(自定义 provider agnes,经 customProviderRegistrar
 *   写入 PROXY_MODEL_ROUTE_MAP 的 `strict:true` 路由)被 modelRouter 判为 strictPreferred + userPinned。
 *   上游返回 HTTP 404 `model_not_found`(该模型名在端点上根本不存在)时,strict 硬失败路径
 *   (aiGateway `_shouldRelaxStrictPreferredOnFailure` 只对 process/timeout/network 瞬时故障放宽,
 *   且 userPinned 一律不放宽)直接把裸 `Request failed with status code 404` 吐给用户;而
 *   buildPreferredAdapterRecoveryHint 的分支链里**没有 model_not_found 分支** → 只落最弱通用提示,
 *   用户看不出「模型名 / 端点配错」这个真实症结,每轮都撞同一堵墙。
 *
 * 定性:model_not_found 是**永久配置错误**——既非 auth(换 key 无用)、也非瞬时(重试同一模型必再 404)。
 *   在本通道内重试或放宽级联到用户未选通道都不合适(后者违背「钉选渠道绝不擅自替换模型」的既定设计)。
 *   故本叶子只做**指引**:点明性质 + 给出确定性下一步(改选该端点确有的模型 / 核对 provider 模型名与 base URL)。
 *
 * 契约(与全仓纯叶子一致):
 *   - 零 IO(只读 env 门控;不碰 fs / 网络 / 子进程 / 时钟 / 随机)。
 *   - 确定性:同输入恒同输出(纯正则 + 模板)。
 *   - 绝不抛:任何异常路径返回安全值(false / null)。
 *   - 门控 KHY_MODEL_NOT_FOUND_RECOVERY 默认开;关或非 model_not_found → 返回 null,
 *     调用方逐字节回退到今日通用 recovery hint。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']); // CANON off-words

/**
 * 门控 KHY_MODEL_NOT_FOUND_RECOVERY 是否启用。flagRegistry 优先(集中真源),
 * 失败/不可用再退本地 CANON 解析。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  try {
    return require('../flagRegistry').isFlagEnabled('KHY_MODEL_NOT_FOUND_RECOVERY', env || process.env);
  } catch { /* fall through to local */ }
  try {
    const raw = (env || process.env).KHY_MODEL_NOT_FOUND_RECOVERY;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// 404 model_not_found 的识别:errorType 优先(gateway errorClassifier 分类结果,最可靠),
// 否则退回消息文本正则。裸 `Request failed with status code 404` 不含类型词,故消费方须透传 errorType。
const _MNF_MSG_RE = /model[_\s-]?not[_\s-]?found|no\s+such\s+model|the\s+model\s+.{0,40}does\s+not\s+exist|model.{0,20}(unknown|unavailable)/i;

/**
 * 判定一次失败是否属于 model_not_found。errorType==='model_not_found' 直判;否则查消息文本。
 * 绝不抛。
 * @param {*} errorType
 * @param {*} message
 * @returns {boolean}
 */
function isModelNotFound(errorType, message) {
  try {
    if (String(errorType || '').trim().toLowerCase() === 'model_not_found') return true;
    return _MNF_MSG_RE.test(String(message || ''));
  } catch {
    return false;
  }
}

// 从「显式模型名」或「错误消息」里定位到底是哪个模型找不到。显式 model(调用方透传的
// options.model,最权威)优先;否则从上游 404 文案里正则提取常见模型名格式。取不到 → ''。
const _MODEL_IN_MSG_RES = [
  /the\s+model\s+[`'"]?([\w./:\-]+)[`'"]?\s+does\s+not\s+exist/i,
  /model[_\s-]?not[_\s-]?found[:\s]+[`'"]?([\w./:\-]+)/i,
  /(?:no\s+such\s+model|unknown\s+model|model\s+unavailable)[:\s]+[`'"]?([\w./:\-]+)/i,
  /model\s+[`'"]([\w./:\-]+)[`'"]\s+(?:not\s+found|does\s+not\s+exist|is\s+unknown|unavailable)/i,
];

function _extractModelName(model, message) {
  try {
    const explicit = String(model == null ? '' : model).trim();
    if (explicit) return explicit;
    const msg = String(message == null ? '' : message);
    for (const re of _MODEL_IN_MSG_RES) {
      const m = msg.match(re);
      if (m && m[1]) return m[1].trim();
    }
    return '';
  } catch {
    return '';
  }
}

// 送出模型串的「形状」判定——把 model_not_found 的**真实症结**说清:到底是「送错了字符串」
// 还是「模型确实不存在」(对应用户诉求「找不到模型需要考虑是否符合裸露模型名,还是采用了符合 id」)。
//   composite:khy 内部**三段式路由 id**(`api:<pool>:<model>`,如 `api:glm:glm-4.6v-flash`)漏到上游,
//             上游只认裸模型名 → 这是**送错字符串**,剥成裸名即可(见 KHY_RELAY_COMPOSITE_MODEL_STRIP);
//   prefixed :带**单段前缀**(`pool:model` / `provider:model`)—— 上游未必认这个前缀,须核对;
//   bare     :**裸模型名** —— 该端点确实不提供此模型(模型名或端点配置问题,非临时故障);
//   empty    :取不到模型名(退通用文案)。
// 与 normalizeModelForAdapter:1241 的剥前缀正则 `^api[:/]<pool>[:/]<model>` 同源判定(此处放宽 pool 段
// 的前缀词以覆盖非 api 代理),不做 IO、不查 canonical 表——纯**结构**判定,绝不抛。
const _COMPOSITE_ROUTE_RE = /^[a-z0-9_-]+[:/][a-z0-9_-]+[:/].+$/i;

function classifyModelNameShape(name) {
  try {
    const s = String(name == null ? '' : name).trim();
    if (!s) return 'empty';
    if (_COMPOSITE_ROUTE_RE.test(s)) return 'composite';
    if (/[:/]/.test(s)) return 'prefixed';
    return 'bare';
  } catch {
    return 'empty';
  }
}

// 形状 → 追加到「点名行」末尾的诊断短句。composite / prefixed 是真正需要区分的两类(送错字符串);
// bare / empty 无追加(既有文案已点明「模型名或端点配置问题」)。
const _SHAPE_HINT = {
  composite: '——注意:送出的是 khy 内部三段式路由 id(api:<pool>:<model>),上游只认裸模型名,'
    + '应剥成裸模型名后再发(门控 KHY_RELAY_COMPOSITE_MODEL_STRIP 默认已做此剥离,若仍漏出请核对该门是否被关)',
  prefixed: '——注意:送出的模型名带前缀,请确认上游端点是接受该前缀、还是只认裸模型名',
  bare: '',
  empty: '',
};

/**
 * 生成 model_not_found 专用恢复行(编号 3)/4),供 buildPreferredAdapterRecoveryHint 追加)。
 * 门关 / 非 model_not_found → null(逐字节回退)。绝不抛。
 * @param {object} [opts]
 * @param {string} [opts.adapterDisplay] 通道显示名(如「API」「Web Relay」)
 * @param {*} [opts.errorType] gateway 分类出的 errorType
 * @param {*} [opts.message] 原始错误消息
 * @param {*} [opts.model] 请求所用的模型串(options.model,最权威;用于点名到底哪个模型找不到)
 * @param {boolean} [opts.hasImage] 本次失败的请求是否携带图片输入(true 时给出视觉专属指引)
 * @param {object} [opts.env]
 * @returns {string[]|null}
 */
function buildModelNotFoundRecoveryLines(opts = {}) {
  try {
    const { adapterDisplay, errorType, message, model, hasImage, env } = opts || {};
    if (!isEnabled(env)) return null;
    if (!isModelNotFound(errorType, message)) return null;
    const where = String(adapterDisplay || '').trim() || '该';
    const name = _extractModelName(model, message);
    // 图片请求专属(dogfood:发送图片后直接 404)——本次请求携带图片却撞 model_not_found,
    // 直接症结是该端点当前没有可识图(视觉)模型;点明这才是 404 主因并给视觉专属下一步。
    // 门控同 KHY_MODEL_NOT_FOUND_RECOVERY;hasImage 非 true → 落下方原点名/通用分支(逐字节回退)。
    if (hasImage === true) {
      const target = name ? `模型「${name}」` : '当前模型';
      return [
        `  3) 本次请求包含图片,但「${where}」端点上${target}不具备识图(视觉)能力`
          + '(model_not_found / 404）——这才是失败的直接原因,反复重试同一模型不会成功',
        '  4) 配置 GLM 视觉 key(把 key 直接发我即可写入,绝不外泄),'
          + '或运行 `khy gateway model` 改选一个具备视觉能力的模型/端点',
      ];
    }
    if (name) {
      // 点名具体模型 + 给出替换该模型的解决方案。追加形状诊断:三段式路由 id / 带前缀 →
      // 「送错字符串」;裸名 → 「模型确实不存在」(shapeHint 为空串时不改变既有文案)。
      const shapeHint = _SHAPE_HINT[classifyModelNameShape(name)] || '';
      return [
        `  3) 模型「${name}」在「${where}」端点上不存在(model_not_found / 404）——`
          + '属模型名或端点配置问题，非临时故障，反复重试同一模型不会成功' + shapeHint,
        `  4) 运行 \`khy gateway model\` 改选一个该端点确实提供的模型来替换「${name}」，`
          + '或核对该自定义 provider 的模型名与 base URL 是否与上游一致',
        '  5) 若确认是该 provider 缺 key / key 失效导致落到了无凭据的模型，'
          + '把新 key 直接发我(绝不外泄），我就地帮你写入更新',
      ];
    }
    // 拿不到具体模型名时退回通用文案(仍点明性质与下一步)。
    return [
      `  3) 该模型在「${where}」端点上不存在(model_not_found / 404）——属模型名或端点配置问题，`
        + '非临时故障，反复重试同一模型不会成功',
      '  4) 运行 `khy gateway model` 改选一个该端点确实提供的模型，'
        + '或核对该自定义 provider 的模型名与 base URL 是否与上游一致',
      '  5) 若确认是该 provider 缺 key / key 失效导致落到了无凭据的模型，'
        + '把新 key 直接发我(绝不外泄），我就地帮你写入更新',
    ];
  } catch {
    return null;
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeModelNotFoundRecovery() {
  return {
    gate: 'KHY_MODEL_NOT_FOUND_RECOVERY',
    defaultOn: true,
    summary: 'strict/钉选通道遇 404 model_not_found 时，为 recovery hint 追加「模型名/端点配错、'
      + '非临时故障、改选该端点确有的模型」的可执行指引，并补一句「若是缺 key/key 失效导致，把新 key 发我写入更新」；'
      + '点名模型时按送出串的形状追加诊断(三段式路由 id / 带前缀 → 送错字符串;裸名 → 模型确实不存在)；'
      + '请求携带图片时改给视觉专属指引(配 GLM 视觉 key / 改选视觉模型)；'
      + '门控关或非 model_not_found 则逐字节回退今日通用提示。',
  };
}

module.exports = {
  isEnabled,
  isModelNotFound,
  classifyModelNameShape,
  buildModelNotFoundRecoveryLines,
  describeModelNotFoundRecovery,
};
