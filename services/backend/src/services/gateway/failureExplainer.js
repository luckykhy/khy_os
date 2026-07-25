'use strict';

/**
 * failureExplainer.js — 纯叶子：确定性失败解释器（零 IO / 确定性 / 绝不抛 / env 门控默认开）。
 *
 * 背景：网关请求失败后，既有出口（aiGateway 的 _buildFailureReasonSection /
 * buildPreferredAdapterRecoveryHint）只做**纯字符串模板**拼接，没有任何模型参与，
 * 也从不解释「为什么失败」；而 404/能力错配又会让整条通道进 cooldown，连「找个
 * 文本模型来分析」的机会都被缓存挡掉。
 *
 * 本叶子对**有唯一确定答案**的失败（模型能力错配、模型不存在、上游 404 /
 * model_not_found）直接确定性地给出原因与纠正动作——**不调任何模型去「猜」原因**，
 * 契合 KHY 哲学「确定性真值优先于模型猜测」（见 deterministicFacts）。无法确定时
 * 返回 null，交由既有模板兜底，绝不臆测。
 *
 * 单一真源：模型能力事实集中在 MODEL_CAPABILITY_FACTS；「备选是否为视觉模型」复用
 * visionCapability.isVisionCapableModel，避免两处各写一份能力判断。注意 chatAlternative
 * 只是「能正常对话的纯文本回退」，并不保证能识图——是否对带图场景给「图像识别请改用」由
 * isVisionCapableModel 现场判定（SenseNova 通道目前没有可信赖的识图模型 → 退回本地 OCR）。
 *
 * 门控 KHY_FAILURE_EXPLAINER（默认开；取 0/false/off/no 关闭→返回 null，字节回退到
 * 原模板）。env 经 opts 注入可测。纯叶子：零外部 IO、无副作用、绝不抛。
 */

const { isVisionCapableModel } = require('./visionCapability');

/**
 * 策展的「模型能力事实」表（精确小写 key）。只收录那些**用它本身就必然失败**、
 * 因而有唯一确定原因的型号；普通可用模型不入表。
 *   - infographic-gen：信息图生成模型，走独立端点、不能当通用 chat、也不收图。
 *   - nonexistent：该通道根本不存在的（伪）模型名。
 *   - text-only：明确纯文本（仅在带图时才构成失败主因）。
 * chatAlternative = 「能正常对话的纯文本回退」。flash-lite 是 SenseNova 通道里可用的
 * 文本对话模型，但**不收图像输入**（实测带图它当作没收到）；故它只作文本回退,带图场景
 * 由 buildFailureExplanation 现场判定不再谎称它能识图（退回本地 OCR / 提示换真视觉模型）。
 */
const MODEL_CAPABILITY_FACTS = Object.freeze({
  'sensenova-u1-fast': {
    kind: 'infographic-gen',
    chatAlternative: 'sensenova-6.7-flash-lite',
    reason:
      'sensenova-u1-fast 是「信息图生成」模型，走独立端点 /v1/images/generations，'
      + '既不能用于通用对话、也不接受图像输入',
  },
  'sensenova-6.7-flash-image': {
    kind: 'nonexistent',
    chatAlternative: 'sensenova-6.7-flash-lite',
    reason: 'sensenova-6.7-flash-image 在 SenseNova Token Plan 中并不存在（伪模型名）',
  },
});

function _enabled(env) {
  const v = String((env && env.KHY_FAILURE_EXPLAINER) || '').trim().toLowerCase();
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

/**
 * 把 model + 各失败 attempt 的可辨识字段拼成一个小写检索串，用于在其中定位
 * 已知问题模型 id / 404 信号（适配器有时把模型名只写进通道 key 或错误消息里）。
 */
function _collectHaystack(model, attempts) {
  const parts = [];
  if (model) parts.push(String(model));
  if (Array.isArray(attempts)) {
    for (const a of attempts) {
      if (!a) continue;
      if (a.adapterKey) parts.push(String(a.adapterKey));
      if (a.provider) parts.push(String(a.provider));
      if (a.error) parts.push(String(a.error));
      if (a.message) parts.push(String(a.message));
    }
  }
  return parts.join(' \n ').toLowerCase();
}

/**
 * 单条失败 attempt/result 是否带「模型被拒绝」类的结构化信号（404 / 400 /
 * model_not_found / bad_request）。这是「什么算模型拒绝」判定的**单一真源**——
 * visionOcrFallback 等也复用它，避免两处各写一份 404/model_not_found 集合。
 * 瞬时类（网络/超时/限流/取消）刻意不计入，避免把能力错配硬安到一次网络抖动上。
 * @param {{success?:boolean, statusCode?:number, status?:number, code?:number, errorType?:string}} attemptLike
 * @returns {boolean}
 */
function isModelRejection(attemptLike) {
  if (!attemptLike || attemptLike.success !== false) return false;
  const code = Number(attemptLike.statusCode || attemptLike.status || attemptLike.code);
  if (code === 404 || code === 400) return true;
  const t = String(attemptLike.errorType || '').toLowerCase();
  return t === 'model_not_found' || t === 'bad_request';
}

/**
 * 是否存在「模型被拒绝」类的明确失败信号。逐条复用 isModelRejection（单一真源），
 * 再加文本兜底：适配器把 404 揉进消息却无结构化 code 时。
 */
function _hasModelRejectionSignal(attempts, haystack) {
  if (Array.isArray(attempts)) {
    for (const a of attempts) {
      if (isModelRejection(a)) return true;
    }
  }
  // 文本兜底：适配器把 404 揉进消息却无结构化 code 时。
  return /\b404\b|model_not_found|no such model|model does not exist|unknown model|model not found/
    .test(String(haystack || ''));
}

function _concreteModelName(model) {
  const m = String(model == null ? '' : model).trim();
  if (!m || m.toLowerCase() === 'auto') return '';
  return m;
}

/**
 * 对一次失败做确定性诊断。返回结构化结论或 null（无唯一确定答案→不下结论）。
 *
 * @param {object} input
 * @param {string} [input.model]    本次请求/实际尝试的模型 id
 * @param {Array}  [input.attempts] 失败 attempt 列表（含 statusCode/errorType/error 等）
 * @param {boolean}[input.hasImage] 本次是否带图像输入
 * @param {object} [input.env]
 * @returns {{matched:true, kind:string, model:string, reason:string,
 *            alternative:string, hasImage:boolean}|null}
 */
function diagnoseFailure(input = {}) {
  const model = input.model;
  const attempts = Array.isArray(input.attempts) ? input.attempts : [];
  const hasImage = !!input.hasImage;
  const haystack = _collectHaystack(model, attempts);
  const rejection = _hasModelRejectionSignal(attempts, haystack);

  // 1) 命中策展能力事实——最确定。能力错配只在「被拒类」失败或带图时下结论，
  //    避免把网络/超时误归因到模型能力上。
  for (const key of Object.keys(MODEL_CAPABILITY_FACTS)) {
    if (!haystack.includes(key)) continue;
    const fact = MODEL_CAPABILITY_FACTS[key];
    if (fact.kind === 'text-only' && !hasImage) continue; // 纯文本仅带图时才是主因
    if (!rejection && !hasImage) continue; // 无失败信号且未带图→不臆测能力错配
    return {
      matched: true,
      kind: fact.kind,
      model: key,
      reason: fact.reason,
      alternative: fact.chatAlternative || '',
      hasImage,
    };
  }

  // 2) 通用「模型不存在/未启用」——仅在有 404/model_not_found 明确信号时下结论。
  if (rejection) {
    const named = _concreteModelName(model);
    return {
      matched: true,
      kind: 'model-not-found',
      model: named,
      reason: named
        ? `目标模型 ${named} 在该通道不存在或未启用（上游返回 404 / model_not_found）`
        : '目标模型在该通道不存在或未启用（上游返回 404 / model_not_found）',
      alternative: '',
      hasImage,
    };
  }

  return null;
}

/**
 * 把诊断结论格式化为可直接前置到失败正文的「诊断（确定性）」块。
 * 门控关闭或无确定结论→返回 null（调用方据此不改动原内容）。
 *
 * @param {object} input 同 diagnoseFailure
 * @returns {string|null}
 */
function buildFailureExplanation(input = {}) {
  const env = (input && input.env) || process.env;
  if (!_enabled(env)) return null;

  const d = diagnoseFailure({ ...input, env });
  if (!d || !d.matched) return null;

  const lines = ['诊断（确定性）:', `  原因: ${d.reason}`];
  if (d.alternative) {
    const altIsVision = isVisionCapableModel(d.alternative, { env });
    if (d.hasImage && altIsVision) {
      lines.push(`  纠正: 图像识别请改用 ${d.alternative}`);
      lines.push('         运行 `khy gateway model` 选择该模型；或设 GATEWAY_PREFERRED_MODEL 固定它');
    } else if (d.hasImage) {
      // 带图,但已知备选并非视觉模型——绝不谎称它能识图。给诚实的图像指引,
      // 备选仅作纯文本对话回退提及。khy 会自动退回本地 OCR 提取图中文字。
      lines.push('  纠正: 当前通道没有可直接识图的模型；khy 会自动退回本地 OCR 提取图中文字,');
      lines.push('         若需真正的视觉理解请改用支持图像输入的模型(运行 `khy gateway model` 选择);');
      lines.push(`         纯文本对话可改用 ${d.alternative}`);
    } else {
      lines.push(`  纠正: 改用 ${d.alternative}`);
      lines.push('         运行 `khy gateway model` 选择该模型；或设 GATEWAY_PREFERRED_MODEL 固定它');
    }
  } else {
    lines.push('  纠正: 运行 `khy gateway model` 选择「可执行」的模型');
    if (d.hasImage) lines.push('         图像识别需选择支持图像输入的模型');
  }
  return lines.join('\n');
}

module.exports = {
  MODEL_CAPABILITY_FACTS,
  isModelRejection,
  diagnoseFailure,
  buildFailureExplanation,
};
