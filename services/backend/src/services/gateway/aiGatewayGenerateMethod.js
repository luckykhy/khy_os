'use strict';

/**
 * The core AIGateway#generate method (extracted from services/gateway/aiGateway.js).
 *
 * generate() is the single largest gateway method — it cascades a request through the ordered adapters
 * with the full production control surface: linked abort / idle watchdogs, streaming chunk forwarding +
 * status/activity pulses, per-attempt retry-budget accounting (with network-jitter auto-boost), cached
 * fast-fail inspection, strict-preferred relaxation, khy-protocol language-consistency recovery, vision
 * OCR rescue, and final result/trace completion.
 *
 * Relocated verbatim (byte-identical body) into a same-directory sibling and mixed back onto
 * AIGateway.prototype via Object.assign in the host. Object-shorthand `async generate(...)` is identical
 * to the class method form, so the only transform was appending a comma after the method close; `this`
 * binds at call time on the prototype and all of generate's inner closures capture their own locals, so
 * the body stays byte-identical. Stable module singletons the body references (path / retry helpers /
 * diagnostics / usageTracker / keySelector / failureExplainer) are re-required here by the same names
 * (require returns the cached singleton); the 32 host-internal helper functions plus the three load-time
 * set-once module lets (_advDiag, _modelSwitch, _traceAudit — nullable) are injected via
 * setAiGatewayGenerateMethodDeps to avoid a require cycle back into aiGateway.js. generate performs heavy
 * IO (adapter network calls, timers, spawns), so this is NOT a pure zero-IO leaf.
 */

const { diagnostics, generateTraceId: genDiagTraceId } = require('../diagnosticEvents');
const {
  isFlagEnabled: _isFlagEnabled,
  resolveNumeric: _resolveNumeric,
} = require('../flagRegistry');
const { isRetryableError, parseRetryAfter } = require('../retryWithBackoff');
const { usageTracker } = require('../usageTracker');

const failureExplainer = require('./failureExplainer');
const keySelector = require('./keySelector');
const { shouldSkipManualRelayInAutoCascade } = require('./manualRelayAutoFallbackPolicy');

// Declarative KHY_* env registry (defaults + off-word dialects) — used by the
// gateway retry/recovery enhancements (context-overflow adjust / bg fast-fail /
// auto credential refresh). All new switches default on per registry entries.

// Host-internal helpers injected once at host load (see setter). All 32 are hoisted function declarations
// on the host. The three module lets (_advDiag, _modelSwitch, _traceAudit) are set once at host load in
// top-level try/catch blocks and can legitimately be null, so they use `!== undefined` guards.
let _advDiag = null;
let _modelSwitch = null;
let _traceAudit = null;
let _appendVisionKeyOffer = null;
let _buildLanguageMismatchFailureMessage = null;
let _createCodexChineseChunkGate = null;
let _createKhyLanguageConsistencyTracker = null;
let _defaultModelForApiPoolProvider = null;
let _extractResultErrorMessage = null;
let _injectKhyChineseRecoveryPrompt = null;
let _injectKhyChineseRecoverySystem = null;
let _isDeadEndpointErrorType = null;
let _isHttpRelayAdapter = null;
let _isProcessSensitiveAdapter = null;
let _isRetryableResultErrorType = null;
let _isTransientGatewayTransportMessage = null;
let _mapApiPoolProviderToServiceProvider = null;
let _normalizeApiPoolProvider = null;
let _parseMs = null;
let _parsePositiveInt = null;
let _prependFailureReason = null;
let _resolveApiPoolProviderForRequest = null;
let _resolveCodexChineseRecoveryRetryBudget = null;
let _resolveResultErrorType = null;
let _shouldAutoRecoverCodexChineseMismatch = null;
let buildPreferredAdapterRecoveryHint = null;
let classifyError = null;
let collectProviderSiblingModels = null;
let createLinkedAbortController = null;
let extractImageOcrDetails = null;
let normalizeAbortReason = null;
let normalizeModelForAdapter = null;
let resolvePreferredModelForAdapter = null;
let throwIfAborted = null;
let tryRateLimitOcrRescue = null;

// ── 注入依赖语义分组(setter 契约的单一真源)─────────────────────────────────────────────
// 五组按职责划分:validation=入参解析/错误分类/适配器谓词;failover=级联恢复/中止/模型与池路由;
// languageRecovery=khy 中文一致性恢复;ocrRescue=视觉 OCR 兜底;diagnostics=三个 set-once 模块
// let(可合法为 null,方法体内全程 `if (x)` 守卫)。setter 同时接受分组形态(生产注入点
// aiGateway.js)与旧扁平形态(测试桩逐项增量覆盖)——两种形态到达模块 let 的绑定值逐项一致。
const DEP_GROUPS = {
  validation: [
    '_extractResultErrorMessage',
    '_isDeadEndpointErrorType',
    '_isHttpRelayAdapter',
    '_isProcessSensitiveAdapter',
    '_isRetryableResultErrorType',
    '_isTransientGatewayTransportMessage',
    '_parseMs',
    '_parsePositiveInt',
    '_resolveResultErrorType',
    'classifyError',
  ],
  failover: [
    '_defaultModelForApiPoolProvider',
    '_mapApiPoolProviderToServiceProvider',
    '_normalizeApiPoolProvider',
    '_prependFailureReason',
    '_resolveApiPoolProviderForRequest',
    'buildPreferredAdapterRecoveryHint',
    'collectProviderSiblingModels',
    'createLinkedAbortController',
    'normalizeAbortReason',
    'normalizeModelForAdapter',
    'resolvePreferredModelForAdapter',
    'throwIfAborted',
  ],
  languageRecovery: [
    '_buildLanguageMismatchFailureMessage',
    '_createCodexChineseChunkGate',
    '_createKhyLanguageConsistencyTracker',
    '_injectKhyChineseRecoveryPrompt',
    '_injectKhyChineseRecoverySystem',
    '_resolveCodexChineseRecoveryRetryBudget',
    '_shouldAutoRecoverCodexChineseMismatch',
  ],
  ocrRescue: ['_appendVisionKeyOffer', 'extractImageOcrDetails', 'tryRateLimitOcrRescue'],
  diagnostics: ['_advDiag', '_modelSwitch', '_traceAudit'],
};

// 可选项:diagnostics 三个 let 方法体内全程 `if (x)` 守卫、可合法为 null。其余 32 项在方法体内
// 均为裸调用(无 null 兜底)——缺失时改前会在对应路径静默崩坏,现由合并后校验在注入期立即
// 点名抛错。(遗留注入项 extractImageOcrTexts 已于 Batch 5 移除:方法体内零调用;源函数仍在
// aiGateway.js 供 rate-limit OCR 兜底内部使用。setter 对未知键静默忽略,旧测试桩传入不破。)
const OPTIONAL_DEP_NAMES = new Set(['_advDiag', '_modelSwitch', '_traceAudit']);

function setAiGatewayGenerateMethodDeps(deps = {}) {
  // 展平:分组键(值为普通对象)摊平一层;其余键按旧扁平形态直收(测试增量桩兼容)。
  const flat = {};
  for (const k of Object.keys(deps)) {
    const v = deps[k];
    if (DEP_GROUPS[k] && v && typeof v === 'object') {
      Object.assign(flat, v);
    } else {
      flat[k] = v;
    }
  }
  const bind = {
    _appendVisionKeyOffer: (v) => {
      _appendVisionKeyOffer = v;
    },
    _buildLanguageMismatchFailureMessage: (v) => {
      _buildLanguageMismatchFailureMessage = v;
    },
    _createCodexChineseChunkGate: (v) => {
      _createCodexChineseChunkGate = v;
    },
    _createKhyLanguageConsistencyTracker: (v) => {
      _createKhyLanguageConsistencyTracker = v;
    },
    _defaultModelForApiPoolProvider: (v) => {
      _defaultModelForApiPoolProvider = v;
    },
    _extractResultErrorMessage: (v) => {
      _extractResultErrorMessage = v;
    },
    _injectKhyChineseRecoveryPrompt: (v) => {
      _injectKhyChineseRecoveryPrompt = v;
    },
    _injectKhyChineseRecoverySystem: (v) => {
      _injectKhyChineseRecoverySystem = v;
    },
    _isDeadEndpointErrorType: (v) => {
      _isDeadEndpointErrorType = v;
    },
    _isHttpRelayAdapter: (v) => {
      _isHttpRelayAdapter = v;
    },
    _isProcessSensitiveAdapter: (v) => {
      _isProcessSensitiveAdapter = v;
    },
    _isRetryableResultErrorType: (v) => {
      _isRetryableResultErrorType = v;
    },
    _isTransientGatewayTransportMessage: (v) => {
      _isTransientGatewayTransportMessage = v;
    },
    _mapApiPoolProviderToServiceProvider: (v) => {
      _mapApiPoolProviderToServiceProvider = v;
    },
    _normalizeApiPoolProvider: (v) => {
      _normalizeApiPoolProvider = v;
    },
    _parseMs: (v) => {
      _parseMs = v;
    },
    _parsePositiveInt: (v) => {
      _parsePositiveInt = v;
    },
    _prependFailureReason: (v) => {
      _prependFailureReason = v;
    },
    _resolveApiPoolProviderForRequest: (v) => {
      _resolveApiPoolProviderForRequest = v;
    },
    _resolveCodexChineseRecoveryRetryBudget: (v) => {
      _resolveCodexChineseRecoveryRetryBudget = v;
    },
    _resolveResultErrorType: (v) => {
      _resolveResultErrorType = v;
    },
    _shouldAutoRecoverCodexChineseMismatch: (v) => {
      _shouldAutoRecoverCodexChineseMismatch = v;
    },
    buildPreferredAdapterRecoveryHint: (v) => {
      buildPreferredAdapterRecoveryHint = v;
    },
    classifyError: (v) => {
      classifyError = v;
    },
    collectProviderSiblingModels: (v) => {
      collectProviderSiblingModels = v;
    },
    createLinkedAbortController: (v) => {
      createLinkedAbortController = v;
    },
    extractImageOcrDetails: (v) => {
      extractImageOcrDetails = v;
    },
    normalizeAbortReason: (v) => {
      normalizeAbortReason = v;
    },
    normalizeModelForAdapter: (v) => {
      normalizeModelForAdapter = v;
    },
    resolvePreferredModelForAdapter: (v) => {
      resolvePreferredModelForAdapter = v;
    },
    throwIfAborted: (v) => {
      throwIfAborted = v;
    },
    tryRateLimitOcrRescue: (v) => {
      tryRateLimitOcrRescue = v;
    },
  };
  for (const n of Object.keys(bind)) {
    if (typeof flat[n] === 'function') {
      bind[n](flat[n]);
    }
  }
  if (flat._advDiag !== undefined) {
    _advDiag = flat._advDiag;
  }
  if (flat._modelSwitch !== undefined) {
    _modelSwitch = flat._modelSwitch;
  }
  if (flat._traceAudit !== undefined) {
    _traceAudit = flat._traceAudit;
  }

  // fail-fast:对**合并后**模块状态做一次性校验(增量注入语义下单次入参可只带子集,但合并结果
  // 必须覆盖全部必选项)。改前缺失必选项 → 对应路径 TypeError 被外层 try/catch 吞掉或直接炸级联,
  // 全部属「静默坏掉」;此处把失败提前到注入期并显式点名,不改变任何注入齐备时的行为。
  const merged = {
    _appendVisionKeyOffer,
    _buildLanguageMismatchFailureMessage,
    _createCodexChineseChunkGate,
    _createKhyLanguageConsistencyTracker,
    _defaultModelForApiPoolProvider,
    _extractResultErrorMessage,
    _injectKhyChineseRecoveryPrompt,
    _injectKhyChineseRecoverySystem,
    _isDeadEndpointErrorType,
    _isHttpRelayAdapter,
    _isProcessSensitiveAdapter,
    _isRetryableResultErrorType,
    _isTransientGatewayTransportMessage,
    _mapApiPoolProviderToServiceProvider,
    _normalizeApiPoolProvider,
    _parseMs,
    _parsePositiveInt,
    _prependFailureReason,
    _resolveApiPoolProviderForRequest,
    _resolveCodexChineseRecoveryRetryBudget,
    _resolveResultErrorType,
    _shouldAutoRecoverCodexChineseMismatch,
    buildPreferredAdapterRecoveryHint,
    classifyError,
    collectProviderSiblingModels,
    createLinkedAbortController,
    extractImageOcrDetails,
    normalizeAbortReason,
    normalizeModelForAdapter,
    resolvePreferredModelForAdapter,
    throwIfAborted,
    tryRateLimitOcrRescue,
  };
  const missing = [];
  let requiredTotal = 0;
  for (const g of Object.keys(DEP_GROUPS)) {
    for (const n of DEP_GROUPS[g]) {
      if (OPTIONAL_DEP_NAMES.has(n)) {
        continue;
      }
      requiredTotal += 1;
      if (typeof merged[n] !== 'function') {
        missing.push(`${g}.${n}`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `注入 aiGatewayGenerateMethod 依赖失败:必选 ${requiredTotal} 项中已注入 ${requiredTotal - missing.length} 项、` +
        `缺失 ${missing.length} 项(${missing.join(', ')})——这些项在 generate() 方法体内为裸调用,缺失会在对应路径` +
        '静默崩坏;请在 setAiGatewayGenerateMethodDeps 调用处补全注入'
    );
  }
}

// 低置信 OCR 兜底诚实告诫:prep 期把本地 OCR 文本作为「请据此作答」的权威依据注入 prompt 时,
// 若 OCR 引擎自评置信偏低(needsAiFallback 或 confidence∈(0,60)),在文本块后追加一句诚实告诫,
// 让纯文本模型知道这些字可能误识/漏识、别当铁定事实。单一真源 gateway/ocrConfidenceCaveat
// (门 KHY_OCR_LOW_CONFIDENCE_CAVEAT default-on)。ocrDetails 为 extractImageOcrDetails 明细数组;
// 无正向低置信信号 / 门关 / 叶子不可用 → 原样返回 prompt,逐字节回退。fail-soft:绝不抛。
function _appendOcrLowConfidenceCaveat(prompt, ocrDetails) {
  try {
    const cc = require('./ocrConfidenceCaveat');
    const low = cc.countLowConfidence(ocrDetails);
    const total = Array.isArray(ocrDetails) ? ocrDetails.length : 0;
    const caveat = cc.buildLowConfidenceCaveat({ count: low, total, env: process.env });
    if (caveat) {
      return `${prompt || ''}\n\n${caveat}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// OCR 兜底「覆盖率」诚实告诫:上述 OCR 文本可能并未覆盖全部输入图片 —— 超单次上限(maxImages)
// 被静默丢弃的图、或已尝试却读不出文字的图,都不在注入文本里。若有这种覆盖缺口,追加一句诚实
// 告诫,别让文本模型默认「已看到所有图片」。单一真源 gateway/ocrCoverageNotice(门
// KHY_OCR_COVERAGE_NOTICE default-on)。与 _appendOcrLowConfidenceCaveat(准确性)正交,本条管
// 完整性。totalImages=本次输入图片总数,ocrTextCount=成功提取到文字的图片数,maxImages=单次上限。
// 无覆盖缺口 / 门关 / 叶子不可用 → 原样返回 prompt,逐字节回退。fail-soft:绝不抛。
function _appendOcrCoverageNotice(prompt, { totalImages, ocrTextCount, maxImages } = {}) {
  try {
    const cn = require('./ocrCoverageNotice');
    const notice = cn.buildCoverageNotice({
      totalImages,
      ocrTextCount,
      maxImages,
      env: process.env,
    });
    if (notice) {
      return `${prompt || ''}\n\n${notice}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// OCR 兜底「单图内文本完整性」诚实告诫:某张稠密图片的 OCR 全文超过 maxChars 被截断(只保留前
// 一部分、尾部丢弃)时,追加一句诚实告诫,别让文本模型把残缺文本当完整依据。单一真源
// gateway/ocrTruncationNotice(门 KHY_OCR_TRUNCATION_NOTICE default-on)。与准确性(低置信)、
// 覆盖率(跨图完整性)两条正交,本条管单图内文本完整性。ocrDetails 为 extractImageOcrDetails
// 明细数组,据其 truncated 标志计数。无截断 / 门关 / 叶子不可用 → 原样返回 prompt。fail-soft:绝不抛。
function _appendOcrTruncationNotice(prompt, ocrDetails) {
  try {
    const tn = require('./ocrTruncationNotice');
    const count = tn.countTruncated(ocrDetails);
    const total = Array.isArray(ocrDetails) ? ocrDetails.length : 0;
    const notice = tn.buildTruncationNotice({ count, total, env: process.env });
    if (notice) {
      return `${prompt || ''}\n\n${notice}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// OCR 兜底「语言包可用性」诚实告诫:khy 请求的 OCR 语言(如 chi_sim+eng)在本机缺 traineddata 时被
// 静默窄化成子集,被丢弃语言的文字根本无法识别。若检测到有语言被丢弃(requestedLang 含、effective
// lang 不含),追加一句诚实告诫,别让文本模型把英文模型对中文图的乱码转写当权威。单一真源
// gateway/ocrLanguageNotice(门 KHY_OCR_LANGUAGE_NOTICE default-on)。与准确性、覆盖率、单图截断三条
// 正交,本条管语言包可用性——直击「没有识图模型下准确识别图片」。无丢弃 / 门关 / 叶子不可用 →
// 原样返回 prompt,逐字节回退。fail-soft:绝不抛。
function _appendOcrLanguageNotice(prompt, ocrDetails) {
  try {
    const ln = require('./ocrLanguageNotice');
    const dropped = ln.computeDroppedLangs(ocrDetails);
    const notice = ln.buildLanguageNotice({ dropped, env: process.env });
    if (notice) {
      return `${prompt || ''}\n\n${notice}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// OCR 兜底「图片方向自动校正」诚实告诫 —— 唯一的「纠正型」轴(与前四条「披露型」正交)。
// docHelper 侧:正向读取很弱(侧拍照片读出置信度不低的乱码)时暴力试 90/180/270 取最优,把文字
// 真正复原并盖 orientationCorrected=角度。本函数把「文本取自被自动旋正的图像」这一事实告知模型,
// 保持透明。单一真源 gateway/ocrOrientationNotice(门 KHY_OCR_AUTO_ORIENT default-on,同门同时控
// docHelper 纠正与本告诫)。门关 → docHelper 不旋转 → 无 orientationCorrected>0 数据 → 返回 null,
// 逐字节回退。fail-soft:绝不抛。直击「没有识图模型下准确识别图片」——尤其是被旋转的图。
function _appendOcrOrientationNotice(prompt, ocrDetails) {
  try {
    const on = require('./ocrOrientationNotice');
    const corrected = on.computeCorrectedOrientations(ocrDetails);
    const notice = on.buildOrientationNotice({ corrected, env: process.env });
    if (notice) {
      return `${prompt || ''}\n\n${notice}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// OCR 兜底第六条正交诚实轴(第二条「纠正型」)——低分辨率图片自动放大。docHelper 在纯文本模型 OCR
// 路径上,若图片过小/低分辨率导致原尺寸读取失败或低置信,会暴力尝试 2×/3×/4× 放大、取置信度最高的
// 可读结果真正复原文字并盖 upscaledFactor=倍数。本函数把「文本取自被自动放大的低分辨率图像」告知
// 模型,保持透明。单一真源 gateway/ocrResolutionNotice(门 KHY_OCR_UPSCALE default-on,同门同时控
// docHelper 放大与本告诫)。门关 → docHelper 不放大 → 无 upscaledFactor>1 数据 → 返回 null,逐字节
// 回退。fail-soft:绝不抛。直击「没有识图模型下准确识别图片」——尤其是分辨率过低的小图。
function _appendOcrResolutionNotice(prompt, ocrDetails) {
  try {
    const rn = require('./ocrResolutionNotice');
    const upscaled = rn.computeUpscaledFactors(ocrDetails);
    const notice = rn.buildResolutionNotice({ upscaled, env: process.env });
    if (notice) {
      return `${prompt || ''}\n\n${notice}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// OCR 兜底「使用 OCR 透明告知」—— OCR **成功路径**上的用户可见披露(与上面六条**条件型**诚实轴正交)。
// 上面六条只在 OCR 结果有缺陷(低置信/超上限/截断/语言窄化/旋正/放大)时才触发;OCR **干净成功**时
// 一条都不触发,注入 prompt 的只剩一个面向**模型**的「以下为图片 OCR 识别文本,请据此作答」头——它让
// 模型据 OCR 文本作答,却从不要求模型**告诉用户**这段内容经 OCR 读取而非原生看图 → 模型像亲眼看图般
// 作答,用户全程不知用了 OCR。本函数在 OCR 成功注入文本后**无条件**追加一句面向模型的指令,要求它用
// 一句自然、简短的话向用户明确说明「本次图片内容是通过 OCR 文字识别读取的」——无感但明显。单一真源
// gateway/ocrUsageNotice(门 KHY_OCR_USAGE_DISCLOSURE default-on)。门关/叶子不可用 → 原样返回 prompt,
// 逐字节回退历史「据 OCR 作答但不向用户披露」行为。fail-soft:绝不抛。count = 成功提取 OCR 文本的图片数。
function _appendOcrUsageDisclosure(prompt, { count } = {}) {
  try {
    const un = require('./ocrUsageNotice');
    const notice = un.buildUsageDisclosure({ count, env: process.env });
    if (notice) {
      return `${prompt || ''}\n\n${notice}`;
    }
  } catch {
    /* 叶子不可用 → 保持原 prompt */
  }
  return prompt;
}

// ── Race abort 臂门控(root cause C 修复)──────────────────────────────────────
// 门 KHY_GATEWAY_ABORT_RACE_ARM 默认 on。开 → 给两处 `Promise.race([adapter, idleTimeout])`
// 补第三条「attemptAbort.signal abort 时立即 reject」的臂,让 UI 的 Esc/Ctrl-C 能真正打断卡在
// 不响应 abort 的适配器上的请求。关 → 上游不挂臂,逐字节回退今日两臂行为。父门 KHY_GATEWAY_HARD_TIMEOUT
// 关时本子门也关(取消基础设施成对关闭,语义对齐)。绝不抛。
function _isAbortRaceArmEnabled() {
  try {
    const flagRegistry = require('../flagRegistry');
    if (!flagRegistry.isFlagEnabled('KHY_GATEWAY_HARD_TIMEOUT', process.env)) {
      return false;
    }
    return flagRegistry.isFlagEnabled('KHY_GATEWAY_ABORT_RACE_ARM', process.env);
  } catch {
    const raw = process.env && process.env.KHY_GATEWAY_ABORT_RACE_ARM;
    if (raw === undefined || raw === null) {
      return true;
    }
    const v = String(raw).trim().toLowerCase();
    return !(v === 'off' || v === 'false' || v === '0' || v === 'no');
  }
}

// 按门控构造 race 臂集合:门开 → [adapterPromise, timeoutPromise, abortArm.promise] + cleanup;
// 门关 → [adapterPromise, timeoutPromise] + no-op cleanup(逐字节等价今日行为)。绝不抛。
function _buildAdapterRaceArms(adapterPromise, timeoutPromise, attemptSignal) {
  if (!_isAbortRaceArmEnabled()) {
    return { arms: [adapterPromise, timeoutPromise], cleanup: () => {} };
  }
  let abortArm = null;
  try {
    const { createAbortRejectionArm } = require('./abortRaceArm');
    abortArm = createAbortRejectionArm(attemptSignal, 'gateway request aborted');
  } catch {
    return { arms: [adapterPromise, timeoutPromise], cleanup: () => {} };
  }
  return {
    arms: [adapterPromise, timeoutPromise, abortArm.promise],
    cleanup: () => {
      try {
        abortArm.cleanup();
      } catch {
        /* ignore */
      }
    },
  };
}

// ── Idle 看门狗「仅真实推进重置」门控(root cause D 修复)──────────────────────
// 门 KHY_GATEWAY_IDLE_PROGRESS_ONLY 默认 on。区分「真实推进」(适配器模型 token / 真正
// assistant 内容)与「网关自造心跳」(状态行 / 脉冲计时 / idle 预警)。开 → 仅真实推进
// 重置 idle,网关自言自语不再续命,卡死能在 gatewayIdleMs 内被兜底 abort。关 → 任何心跳
// 都重置(逐字节回退修复前行为:看门狗仍被自身输出续命)。判定委托纯叶子,绝不抛。
function _shouldResetIdleForProgress(isRealProgress) {
  try {
    const { shouldResetIdle } = require('./gatewayIdleProgressPolicy');
    return shouldResetIdle(isRealProgress, process.env);
  } catch {
    // 保守:异常 → 回退今日行为(重置 idle),绝不因本修复引入新的卡死。
    return true;
  }
}

/**
 * 调用 MCP 视觉工具（如 deepseek-eyes）识别图片，返回文字描述。
 * 将内存中的图片写入临时文件后传给支持文件路径的 MCP 工具。
 *
 * @param {string} mcpServerName - MCP 服务器名（.khy/mcp.json 中配置）
 * @param {Array<{base64: string, mimeType: string}>} images - 图片数组
 * @returns {Promise<string>} 拼接后的视觉描述文本
 */
async function _callMcpVisionTool(mcpServerName, images) {
  if (!mcpServerName || !Array.isArray(images) || images.length === 0) {
    return { text: '', errors: [] };
  }
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const tmpDir = os.tmpdir();
  const tempFiles = [];
  const descriptions = [];
  const _errors = [];
  const _UPSTREAM_ERROR_RE =
    /(?:authentication\s+fail|invalid\s+(?:api\s+)?(?:key|token)|401|403|forbidden|unauthorized|not\s+set|get\s+free\s+key|modelscope.*token|noneType.*subscriptable)/i;

  // ModelScope API 只认 JPEG，不认 PNG/WEBP/GIF。
  // 复用已有 _imageTranscode 的 ffmpeg 转码：任意格式 → JPEG。
  // 无 ffmpeg 时退化为直接写原格式（可能有兼容风险）。
  let _xcode;
  try {
    _xcode = require('./adapters/_imageTranscode');
  } catch {
    /* no ffmpeg */
  }
  const _ffmpeg =
    _xcode && typeof _xcode._resolveFfmpeg === 'function' ? _xcode._resolveFfmpeg() : null;

  try {
    const mcp = require('../mcp');
    for (let i = 0; i < images.length; i++) {
      const img = images[i];
      if (!img || !img.base64) {
        continue;
      }

      // 转 JPEG（对已经是 JPEG 的格式 _transcodeOne 会直接透传）
      let jpegBase64 = null;
      if (_ffmpeg && _xcode && typeof _xcode._transcodeOne === 'function') {
        try {
          const converted = await _xcode._transcodeOne(img, _ffmpeg);
          if (converted && converted.base64) {
            jpegBase64 = converted.base64;
          }
        } catch {
          /* transcode failed, fall through to raw write */
        }
      }

      // 写临时文件（统一 .jpg 扩展名，确保 deepseek-eyes 检测为 JPEG）
      const tmpPath = path.join(tmpDir, `khy-mcp-vision-${Date.now()}-${i}.jpg`);
      fs.writeFileSync(tmpPath, Buffer.from(jpegBase64 || img.base64, 'base64'));
      tempFiles.push(tmpPath);

      // 仅用 analyze_image（按当前图片磁盘路径识别）。
      // 不再回退 analyze_clipboard：剪贴板内容与本次请求的图片无关，
      // 旧截图会导致返回与当前图片无关的固定结果且不报错。
      let result = '';
      let _analyzeImageErr = null;
      try {
        result = await mcp.callTool(mcpServerName, 'analyze_image', { image_path: tmpPath });
      } catch (imgErr) {
        _analyzeImageErr = imgErr;
        const _reason = imgErr && imgErr.message ? imgErr.message : String(imgErr);
        _errors.push(
          `图片${i + 1}: deepseek-eyes analyze_image 识图失败（当前图片路径）- ${_reason}`
        );
      }
      if (result) {
        const raw =
          typeof result === 'string'
            ? result
            : result.content && result.content[0] && result.content[0].text;
        const text = (raw || '').trim();
        if (text) {
          // 检测文本是否实际是上游服务的错误（如认证失败、key 过期）→ 不视为识别结果
          if (_UPSTREAM_ERROR_RE.test(text)) {
            _errors.push(`图片${i + 1}: ${text}`);
          } else {
            descriptions.push(`【图片${i + 1} 视觉识别】\n${text}`);
          }
        }
      } else if (_analyzeImageErr) {
        _errors.push(
          `图片${i + 1}: analyze_image 无结果 (${_analyzeImageErr && _analyzeImageErr.message ? _analyzeImageErr.message : String(_analyzeImageErr)})`
        );
      }
    }
  } catch (outerErr) {
    _errors.push(
      `MCP 视觉整体异常: ${outerErr && outerErr.message ? outerErr.message : String(outerErr)}`
    );
  } finally {
    // 清理临时文件
    for (const f of tempFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  }

  // 如果全部失败，返回错误摘要供外层日志
  if (!descriptions.length && _errors.length) {
    const _verbose =
      String(process.env.KHY_STATUS_VERBOSITY || 'auto')
        .trim()
        .toLowerCase() === 'detailed';
    if (_verbose) {
      console.warn(`[MCP-Vision] ${mcpServerName} 全部图片识别失败: ${_errors.join('; ')}`);
    }
  }

  return { text: descriptions.join('\n\n'), errors: _errors };
}

const AIGatewayGenerateMethod = {
  /**
   * Generate a response by cascading through adapters.
   * Returns the same shape as MultiFreeService.generateResponse().
   */
  async generate(prompt, options = {}) {
    if (!this._initialized) {
      await this.init();
    }

    // ── Request deduplication ─────────────────────────────────────────────
    // Image requests skip dedup entirely: vision prompts are near-identical
    // text, so text-based dedup would treat a new image as a duplicate and
    // return the previous image's cached reply. When dedup is skipped dedupFp
    // stays null and no cache read/store happens for this request.
    const _hasImagesForDedup = Array.isArray(options.images) && options.images.length > 0;
    let dedupFp = null;
    let isNewRequest = true;
    if (!_hasImagesForDedup) {
      dedupFp = this._dedup.fingerprint({
        userId: options.userId || options.sessionId || 'anon',
        model: options.model || 'auto',
        prompt,
        sessionId: options.sessionId,
        // Fallback safety net: if any other path feeds images through here,
        // the digest keeps distinct images on distinct fingerprints.
        images: options.images,
      });
      isNewRequest = await this._dedup.tryAcquire(dedupFp);
      if (!isNewRequest) {
        const cached = await this._dedup.getCached(dedupFp);
        if (cached) {
          return { ...cached, deduplicated: true };
        }
        // Lock exists but no cached response yet — first request still in flight.
        // Fall through and let this request proceed (the lock holder will store the result).
      }
    }

    const startTime = Date.now();
    const promptSize = String(prompt || '').length;
    const explicitTaskScale = String(options.taskScale || '')
      .trim()
      .toLowerCase();
    const isLargeTask =
      explicitTaskScale === 'large' || (explicitTaskScale !== 'small' && promptSize >= 1200);
    const isSmallTask =
      explicitTaskScale === 'small' ||
      (explicitTaskScale !== 'large' && promptSize > 0 && promptSize <= 220);

    // ── Gateway retry/recovery enhancements (A/B/C) — per-request state ────
    // B: explicit request source classification. Only 'background' | 'internal'
    // are honored; anything else (including unset) falls back to 'foreground'.
    const _rawRequestSource = String(options.requestSource || '')
      .trim()
      .toLowerCase();
    const requestSource =
      _rawRequestSource === 'background' || _rawRequestSource === 'internal'
        ? _rawRequestSource
        : 'foreground';
    // KHY_BG_FAST_FAIL (default on): background-tagged requests fast-fail on
    // overloaded/rate_limit instead of retrying the same adapter / rotating keys.
    const bgFastFailEnabled =
      requestSource === 'background' && _isFlagEnabled('KHY_BG_FAST_FAIL', process.env);
    // A: KHY_CONTEXT_OVERFLOW_AUTO_ADJUST (default on; '0'/'false' disables) —
    // reactive maxTokens shrink when a context_length/413 failure carries
    // parseable token counts. At most one adjustment per request.
    const contextOverflowAutoAdjust = _isFlagEnabled(
      'KHY_CONTEXT_OVERFLOW_AUTO_ADJUST',
      process.env
    );
    let contextOverflowAdjusted = false;
    // Shrink-priority floor: once a context-overflow shrink lands, no later
    // preflight resolution in the SAME request may raise maxTokens above it
    // (shrink wins over the KHY_MAX_TOKENS_AUTO_RESOLVE preflight). 0 = no shrink yet.
    let _maxTokensShrunkTo = 0;
    // A: try an in-place maxTokens shrink for a context-overflow failure.
    // Returns { adjusted, tokenInfo }; tokenInfo is non-null whenever the error
    // message was parseable (callers attach it to diagnostics on no-space).
    const tryContextOverflowAdjust = (adapterOpts, message, attemptIndex, totalAttempts) => {
      if (!contextOverflowAutoAdjust || contextOverflowAdjusted) {
        return { adjusted: false, tokenInfo: null };
      }
      let tokenInfo = null;
      try {
        tokenInfo = require('../errorClassifier').parseContextOverflowTokens(message);
      } catch {
        tokenInfo = null;
      }
      if (!tokenInfo) {
        return { adjusted: false, tokenInfo: null };
      }
      // Safety buffer (default 512 tokens) and minimum completion floor (default 256).
      const buffer = _resolveNumeric('KHY_CONTEXT_SAFETY_BUFFER_TOKENS', process.env);
      const minCompletion = _resolveNumeric('KHY_CONTEXT_MIN_COMPLETION_TOKENS', process.env);
      const available = tokenInfo.limitTokens - tokenInfo.promptTokens - buffer;
      if (available < minCompletion) {
        return { adjusted: false, tokenInfo };
      }
      const prevMax = Number(adapterOpts.maxTokens) || 0;
      const newMax = prevMax > 0 ? Math.min(prevMax, available) : available;
      if (prevMax > 0 && newMax >= prevMax) {
        return { adjusted: false, tokenInfo };
      } // shrink only
      adapterOpts.maxTokens = newMax;
      contextOverflowAdjusted = true; // at most 1 adjustment per request
      _maxTokensShrunkTo = newMax; // shrink-priority: preflight may never re-raise past this
      if (adapterOpts._maxTokensPolicy) {
        adapterOpts._maxTokensPolicy.shrunk = true;
      }
      emitStatus(
        `上下文超长: 已将 max_tokens 从 ${prevMax > 0 ? prevMax : '未设置'} 调整为 ${newMax}，正在重试 ${Math.min(attemptIndex + 2, totalAttempts)}/${totalAttempts}`
      );
      return { adjusted: true, tokenInfo };
    };
    // C: KHY_AUTO_CREDENTIAL_REFRESH (default on) — single-flight refresh via
    // the adapter's optional refreshCredential(); at most 1 refresh per adapter
    // per request; failure always falls back to existing pool rotation.
    const autoCredentialRefresh = _isFlagEnabled('KHY_AUTO_CREDENTIAL_REFRESH', process.env);
    const credentialRefreshAttempted = new Set();
    const tryCredentialRefresh = async (adapterEntry, adapterName) => {
      if (!autoCredentialRefresh) {
        return false;
      }
      if (credentialRefreshAttempted.has(adapterEntry.key)) {
        return false;
      }
      if (!adapterEntry.adapter || typeof adapterEntry.adapter.refreshCredential !== 'function') {
        return false;
      }
      credentialRefreshAttempted.add(adapterEntry.key);
      emitStatus(`凭证已失效: 正在自动刷新 ${adapterName} 凭证并重试`);
      try {
        const coordinator = require('./credentialRefreshCoordinator');
        const refreshed = await coordinator.refreshCredential(adapterEntry.key, () =>
          adapterEntry.adapter.refreshCredential()
        );
        if (refreshed && refreshed.ok) {
          // BUG-1 fix: the auth failure recorded just before this call already
          // populated the adapter fast-fail cooldown cache; without clearing it,
          // inspectCachedFastFail() at the loop top would intercept the very
          // retry this refresh enables. Confined to the refresh-success path —
          // failure/off/no-refreshCredential paths remain byte-identical.
          try {
            await this._clearAdapterFailure(adapterEntry.key);
          } catch {
            /* fail-soft: retry may still hit cooldown */
          }
          emitStatus(`凭证刷新成功: ${adapterName} 正在原通道重试`);
          return true;
        }
        try {
          require('../../utils/logger').warn(
            `[gateway] credential refresh failed for ${adapterEntry.key}: ${(refreshed && refreshed.error) || 'refresh returned falsy'}`
          );
        } catch {
          /* best effort */
        }
      } catch (refreshErr) {
        try {
          require('../../utils/logger').warn(
            `[gateway] credential refresh error for ${adapterEntry.key}: ${refreshErr.message || refreshErr}`
          );
        } catch {
          /* best effort */
        }
      }
      emitStatus(`凭证刷新失败: ${adapterName} 回落账号池轮转`);
      return false;
    };

    // NOTE: exact-value match ('khy'), not a boolean flag — utils/envFlagEnabled does not apply (different semantics).
    const isKhyInteractiveRuntime =
      String(process.env.KHY_RUNTIME_MODE || '')
        .trim()
        .toLowerCase() === 'khy';
    const fastInteractiveRateLimit =
      isKhyInteractiveRuntime &&
      isSmallTask &&
      String(process.env.KHY_GATEWAY_FAST_RATE_LIMIT || 'true').toLowerCase() !== 'false';
    // Normalize images once at the gateway entry — all downstream adapters
    // receive a guaranteed { base64, mimeType, dataUrl, url? }[] shape.
    let hasImageInput = Array.isArray(options.images) && options.images.length > 0;
    if (hasImageInput) {
      const { normalizeImages } = require('./adapters/_imageCompat');
      options.images = normalizeImages(options.images);
      // Transcode model-unfriendly formats (HEIC/HEIF/TIFF/BMP/SVG) and
      // oversized images to JPEG via ffmpeg when available — a single chokepoint
      // so every downstream adapter (native + CLI bridge) gets model-safe bytes.
      // Transparent no-op when ffmpeg is absent or a conversion fails.
      try {
        const { transcodeImagesIfNeeded } = require('./adapters/_imageTranscode');
        options.images = await transcodeImagesIfNeeded(options.images);
      } catch {
        /* fail-safe: keep normalized images unchanged */
      }
      hasImageInput = options.images.length > 0;
    }
    const externalAbortSignal = options.abortSignal || null;
    const getAbortReason = () =>
      normalizeAbortReason(externalAbortSignal ? externalAbortSignal.reason : 'aborted');
    const throwIfCancelled = () => throwIfAborted(externalAbortSignal);
    const buildEarlyCancelledResult = (reasonText = getAbortReason()) => ({
      success: false,
      content: `请求已取消: ${reasonText}`,
      provider: 'none',
      adapter: 'none',
      attempts: [],
      errorType: 'cancelled',
      cancelled: true,
    });

    // ── Gateway-level idle watchdog ────────────────────────────────────────
    // Keep env compatibility with GATEWAY_WALL_CLOCK_TIMEOUT_MS, but treat it
    // as an idle timeout budget for the whole delivery chain rather than a hard
    // wall-clock kill. Active requests that keep making progress should survive.
    const gatewayIdleDefaults = { large: 300000, small: 60000, normal: 120000 };
    const gatewayIdleDefault = isLargeTask
      ? gatewayIdleDefaults.large
      : isSmallTask
        ? gatewayIdleDefaults.small
        : gatewayIdleDefaults.normal;
    const gatewayIdleOverride = parseInt(process.env.GATEWAY_WALL_CLOCK_TIMEOUT_MS);
    const gatewayIdleMs =
      Number.isFinite(gatewayIdleOverride) && gatewayIdleOverride > 0
        ? gatewayIdleOverride
        : gatewayIdleDefault;
    const gatewayAbort = createLinkedAbortController(externalAbortSignal);
    // ── Gateway hard wall-clock deadline (_gatewayHardDeadline) ─────────────
    // 与上面的 idle 看门狗正交:idle 计时被重试级联自己的状态输出永久重置 → 永不触发。这道硬死线
    // 基于一次性捕获的 startedAt(与 touch 无关),到点即 abort gatewayAbort,兜住「卡死 9 分钟」。
    // 门控关 → 返 null,逐字节回退今日无硬死线行为。级联总次数封顶同源,兜住 strict 放宽从头重走。
    let _gatewayHardDeadline = null;
    try {
      const { createGatewayDeadline } = require('./_gatewayHardDeadline');
      _gatewayHardDeadline = createGatewayDeadline({
        optionsTimeoutMs: Number(options.hardTimeoutMs || options.timeoutMs) || undefined,
        taskScale: { isLargeTask, isSmallTask },
        env: process.env,
      });
    } catch {
      _gatewayHardDeadline = null;
    }
    let _totalAdapterAttempts = 0;
    let _relaxRestartCount = 0;
    let _gatewayLastActivityAt = Date.now();
    let _gatewayIdleTimer = null;
    let _gatewayIdleWarningEmitted = false;
    const _touchGatewayActivity = () => {
      _gatewayLastActivityAt = Date.now();
      _gatewayIdleWarningEmitted = false;
    };
    const _stopGatewayIdleWatchdog = () => {
      if (_gatewayIdleTimer) {
        clearInterval(_gatewayIdleTimer);
        _gatewayIdleTimer = null;
      }
      gatewayAbort.cleanup();
    };
    const _startGatewayIdleWatchdog = () => {
      const warningMs = Math.max(15000, Math.floor(gatewayIdleMs * 0.5));
      _gatewayIdleTimer = setInterval(() => {
        if (gatewayAbort.signal.aborted) {
          return;
        }
        // 硬死线优先:基于一次性 startedAt,不受 touch 活动重置 → 免疫「状态输出刷新计时」的病根。
        if (_gatewayHardDeadline && _gatewayHardDeadline.exceeded(Date.now())) {
          const hardSec = Math.floor((_gatewayHardDeadline.deadlineMs || 0) / 1000);
          emitActivity(`✗ 网关已达硬超时上限 ${hardSec}s，强制终止本次请求`, true);
          _logGenerateDiagEvent('llm.hard_deadline', {
            deadlineMs: _gatewayHardDeadline.deadlineMs || 0,
            waitedMs: Date.now() - startTime,
          });
          gatewayAbort.abort(`gateway hard timeout (${_gatewayHardDeadline.deadlineMs}ms)`);
          return;
        }
        const idleMs = Date.now() - _gatewayLastActivityAt;
        if (!_gatewayIdleWarningEmitted && idleMs >= warningMs && idleMs < gatewayIdleMs) {
          _gatewayIdleWarningEmitted = true;
          const idleSec = Math.floor(idleMs / 1000);
          emitActivity(`⚠ 网关链路已 ${idleSec}s 无推进，正在等待下一个结果`, true);
        }
        if (idleMs >= gatewayIdleMs) {
          const idleSec = Math.floor(idleMs / 1000);
          emitActivity(`✗ 网关链路已 ${idleSec}s 无推进，终止本次请求`, true);
          _logGenerateDiagEvent('llm.idle_timeout', {
            idleMs,
            thresholdMs: gatewayIdleMs,
            firstChunkSeen: _firstChunkLogged,
            waitedMs: Date.now() - startTime,
          });
          gatewayAbort.abort(`gateway idle timeout (${gatewayIdleMs}ms)`);
        }
      }, 5000);
      _gatewayIdleTimer.unref?.();
    };
    const _statusDedupMs = (() => {
      const defaultMs = isKhyInteractiveRuntime ? 700 : 1500;
      const raw =
        process.env.GATEWAY_STATUS_DEDUP_MS ||
        process.env.KHY_AI_STATUS_DEDUP_MS ||
        String(defaultMs);
      const parsed = Number.parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 200) {
        return defaultMs;
      }
      return parsed;
    })();
    const _activityPulseMs = (() => {
      const defaultMs = isKhyInteractiveRuntime ? 4000 : 10000;
      const raw =
        process.env.GATEWAY_ACTIVITY_PULSE_MS ||
        process.env.KHY_AI_ACTIVITY_PULSE_MS ||
        String(defaultMs);
      const parsed = Number.parseInt(String(raw).trim(), 10);
      if (!Number.isFinite(parsed) || parsed < 2000) {
        return defaultMs;
      }
      return parsed;
    })();
    let _lastStatusText = '';
    let _lastStatusAt = 0;
    let _lastActivityText = '';
    let _lastActivityAt = 0;
    const originalOnChunk = typeof options.onChunk === 'function' ? options.onChunk : null;
    let languageTracker = null;
    let languageChunkGate = null;
    // P2 diagnostics: log the first real-progress chunk once per request so a
    // "headers arrived but zero chunks" hang is measurable (requestId + latency).
    let _firstChunkLogged = false;
    // Total visible text length already forwarded to the caller's onChunk since
    // the last stream reset. Used to decide whether a language-recovery retry
    // must first retract the already-streamed draft via a {type:'reset'} frame
    // (responseDebounce protocol) — otherwise append-only consumers render the
    // retry as a second full answer (duplicate-output bug).
    let _forwardedVisibleTextLen = 0;
    // Closure-level flag: once languageChunkGate detects mismatch and aborts,
    // block ALL subsequent chunks from reaching originalOnChunk even if they
    // arrive before the abort signal fully propagates through the SSE pipeline.
    let _attemptAborted = false;
    const _logGenerateDiagEvent = (event, data = {}) => {
      if (!_traceAudit) {
        return;
      }
      try {
        _traceAudit.logEvent(
          event,
          { requestId: options.requestId, ...data },
          {
            sessionId: options.sessionId || null,
            traceId: options._diagTraceId || null,
            requestId: options.requestId || null,
            source: 'ai-gateway',
            visibility: 'internal',
          }
        );
      } catch {
        /* non-critical */
      }
    };
    const forwardGatewayChunk = (chunk, isRealProgress = true) => {
      if (gatewayAbort.signal.aborted) {
        return;
      }
      if (_attemptAborted) {
        return;
      }
      if (!chunk) {
        return;
      }
      if (!_firstChunkLogged && isRealProgress) {
        _firstChunkLogged = true;
        _logGenerateDiagEvent('llm.first_chunk', {
          chunkType: String(chunk.type || 'unknown'),
          elapsedMs: Date.now() - startTime,
        });
      }
      // 单一 idle 重置 choke-point:仅「真实推进」(适配器 token / assistant 内容)重置 idle;
      // 网关自造心跳(status/activity 脉冲/预警)以 isRealProgress=false 传入,门开时不再续命。
      // 默认 true → options.onChunk 收到的真实适配器 chunk 逐字节保持「重置 idle」行为。
      if (_shouldResetIdleForProgress(isRealProgress)) {
        _touchGatewayActivity();
      }
      if (languageTracker) {
        try {
          languageTracker.captureChunk(chunk);
        } catch {
          /* best effort */
        }
      }
      if (languageChunkGate) {
        try {
          const decision = languageChunkGate.handleChunk(chunk);
          if (decision && decision.forward === false) {
            _attemptAborted = true;
            languageChunkGate = null;
            return;
          }
        } catch {
          /* best effort */
        }
      }
      if (!originalOnChunk) {
        return;
      }
      if (chunk.type === 'text' && chunk.text) {
        _forwardedVisibleTextLen += String(chunk.text).length;
      }
      try {
        originalOnChunk(chunk);
      } catch {
        /* best effort */
      }
    };
    // Retract the already-streamed draft BEFORE a cross-adapter cascade switch
    // (pool exhausted / language-mismatch fall-through). When an adapter streamed
    // visible text and the gateway then cascades to the next adapter, append-only
    // consumers would render the next adapter's answer as a second block
    // (duplicate-output bug). Mirrors beginLanguageRecoveryRetry's reset emission
    // and reuses the same responseDebounce reset-chunk protocol. Fail-soft: reset
    // emission must never block the fallback switch. Idempotent via the
    // _forwardedVisibleTextLen>0 guard — a reset already sent by language recovery
    // zeroes the counter, so no second frame is emitted for the same draft.
    const emitAdapterFallbackReset = () => {
      if (_forwardedVisibleTextLen > 0) {
        try {
          forwardGatewayChunk(
            require('../query/responseDebounce').buildResetChunk('adapter-fallback-retry'),
            false
          );
        } catch {
          /* best effort */
        }
        _forwardedVisibleTextLen = 0;
      }
    };
    const emitStatus = (text) => {
      if (gatewayAbort.signal.aborted) {
        return;
      }
      try {
        if (originalOnChunk && text) {
          const normalized = String(text).replace(/\s+/g, ' ').trim();
          if (!normalized) {
            return;
          }
          const now = Date.now();
          if (normalized === _lastStatusText && now - _lastStatusAt < _statusDedupMs) {
            return;
          }
          _lastStatusText = normalized;
          _lastStatusAt = now;
          // status = 网关自造心跳,非真实推进 → 门开时不重置 idle(交由 funnel 按门控判定)。
          forwardGatewayChunk({ type: 'status', text: normalized }, false);
        }
      } catch {
        /* best effort */
      }
    };
    const emitActivity = (text, force = false) => {
      if (gatewayAbort.signal.aborted) {
        return;
      }
      try {
        if (!originalOnChunk || !text) {
          return;
        }
        const normalized = String(text).replace(/\s+/g, ' ').trim();
        if (!normalized) {
          return;
        }
        const now = Date.now();
        if (
          !force &&
          normalized === _lastActivityText &&
          now - _lastActivityAt < _activityPulseMs
        ) {
          return;
        }
        _lastActivityText = normalized;
        _lastActivityAt = now;
        // activity(脉冲计时「已耗时 Xs」/ idle 预警)= 网关自造心跳,非真实推进 →
        // 门开时不重置 idle,否则看门狗会被自身脉冲永久续命(root cause D 病根)。
        forwardGatewayChunk({ type: 'status', text: normalized }, false);
      } catch {
        /* best effort */
      }
    };
    const emitAssistantMessage = (content) => {
      if (gatewayAbort.signal.aborted) {
        return;
      }
      try {
        if (!originalOnChunk || !content) {
          return;
        }
        const normalized = String(content).trim();
        if (!normalized) {
          return;
        }
        // assistant_message = 真正的模型内容 → 真实推进,重置 idle(isRealProgress 默认 true)。
        forwardGatewayChunk({ type: 'assistant_message', content: normalized });
      } catch {
        /* best effort */
      }
    };
    const startAdapterPulse = (adapterName, onPulse = null) => {
      const startedAt = Date.now();
      let pulseTimer = null;
      const tick = () => {
        const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        if (typeof onPulse === 'function') {
          try {
            onPulse();
          } catch {
            /* best effort */
          }
        }
        emitActivity(`${adapterName} 正在生成响应（已耗时 ${elapsedSec}s）`);
      };
      pulseTimer = setInterval(tick, _activityPulseMs);
      pulseTimer.unref?.();
      return () => {
        if (pulseTimer) {
          clearInterval(pulseTimer);
          pulseTimer = null;
        }
      };
    };
    const createAdapterIdleTimeout = (adapterKey, timeoutMs, attemptAbort) => {
      const resolvedTimeoutMs = Math.max(1000, _parseMs(timeoutMs, 60000, 1000));
      // Stale 分级检测（借鉴 Hermes Agent stale-call 检测器）
      // warning 阈值 = 超时的 50%，critical 阈值 = 超时的 100%
      const staleWarningMs = Math.max(15000, Math.floor(resolvedTimeoutMs * 0.5));
      const staleCriticalMs = resolvedTimeoutMs;
      let lastActivityAt = Date.now();
      let stopped = false;
      let timer = null;
      let staleWarningEmitted = false;
      const reason = `adapter ${adapterKey} idle timeout (${resolvedTimeoutMs}ms)`;
      const timeoutPromise = new Promise((_, reject) => {
        timer = setInterval(() => {
          if (stopped) {
            return;
          }
          const idleMs = Date.now() - lastActivityAt;

          // Stale warning: 闲置超过 50% 阈值但未到 critical
          if (!staleWarningEmitted && idleMs >= staleWarningMs && idleMs < staleCriticalMs) {
            staleWarningEmitted = true;
            const idleSec = Math.floor(idleMs / 1000);
            emitActivity(`⚠ ${adapterKey} 已 ${idleSec}s 无响应，可能 stale`, true);
          }

          // Critical: 闲置超过完整阈值 → abort + failover
          if (idleMs >= staleCriticalMs) {
            stopped = true;
            if (timer) {
              clearInterval(timer);
              timer = null;
            }
            const idleSec = Math.floor(idleMs / 1000);
            emitActivity(`✗ ${adapterKey} stale ${idleSec}s — 中断并尝试故障转移`, true);
            try {
              attemptAbort.abort(reason);
            } catch {
              /* best effort */
            }
            reject(new Error(reason));
          }
        }, 5000); // 5s 检查间隔（比 1s 更高效，stale 检测不需要秒级精度）
        timer.unref?.();
      });
      return {
        timeoutPromise,
        touch: () => {
          if (!stopped) {
            lastActivityAt = Date.now();
            staleWarningEmitted = false; // 收到活动后重置 warning 状态
          }
        },
        stop: () => {
          stopped = true;
          if (timer) {
            clearInterval(timer);
            timer = null;
          }
        },
      };
    };
    _startGatewayIdleWatchdog();
    if (externalAbortSignal && externalAbortSignal.aborted) {
      if (_modelSwitch) {
        _modelSwitch.generationCompleted();
      }
      _stopGatewayIdleWatchdog();
      return buildEarlyCancelledResult(getAbortReason());
    }

    // Live model switching: apply active model if no explicit model specified
    if (_modelSwitch && !options.model) {
      const activeModel = _modelSwitch.getActiveModel();
      if (activeModel && activeModel !== 'auto') {
        options.model = activeModel;
      }
    }
    if (_modelSwitch) {
      _modelSwitch.generationStarted();
    }

    // Diagnostic trace context
    options._diagTraceId = options._diagTraceId || genDiagTraceId();
    options.requestId =
      String(options.requestId || options._diagTraceId || '').trim() || options._diagTraceId;
    options.onChunk = forwardGatewayChunk;
    if (_traceAudit) {
      try {
        if (options.sessionId) {
          _traceAudit.attachTrace(options._diagTraceId, options.sessionId);
        }
        _traceAudit.logEvent(
          'llm.request',
          {
            requestId: options.requestId,
            requestedModel: options.model || 'auto',
            preferredAdapter: options.preferredAdapter || options.adapter || 'auto',
            prompt,
            hasTools: Array.isArray(options.tools) && options.tools.length > 0,
            messagesCount: Array.isArray(options.messages) ? options.messages.length : 0,
            strictPreferred: options.strictPreferred !== false,
          },
          {
            sessionId: options.sessionId || null,
            traceId: options._diagTraceId,
            requestId: options.requestId,
            source: 'ai-gateway',
            visibility: 'internal',
          }
        );
      } catch {
        /* non-critical */
      }
    }
    diagnostics.emitModelRequest(
      options.model || 'auto',
      options.adapter || 'auto',
      null, // token estimate not available here
      { traceId: options._diagTraceId, requestId: options.requestId }
    );

    // AI Monitor: start trace
    const monitor = require('../aiMonitor');
    const traceId = monitor.startTrace({
      prompt,
      model: options.model,
      adapter: options.adapter,
      options,
    });
    let traceClosed = false;
    let generationCompleted = false;
    const endTraceOnce = (response, meta = {}) => {
      if (traceClosed) {
        return;
      }
      traceClosed = true;
      monitor.endTrace(traceId, response || null, meta || {});
    };
    const completeGenerationOnce = () => {
      if (generationCompleted) {
        return;
      }
      generationCompleted = true;
      if (_modelSwitch) {
        _modelSwitch.generationCompleted();
      }
    };
    // ── Refusal auto-recovery seam ────────────────────────────────────────
    // Shared by every model-success return point (pooled + non-pooled). When a
    // model wrongly refuses a legitimate request with a canned refusal, rescue
    // it by decomposing + re-executing via recursive this.generate(). Mutates
    // `result` in place with ADDITIVE fields only. Fail-soft: any error (or the
    // KHY_REFUSAL_RECOVERY gate being off) leaves `result` byte-for-byte
    // unchanged. Only the pure-chat path (no tools, no toolUseBlocks) qualifies;
    // the injected `_refusalDecomposeDepth:1` on sub-calls guards recursion.
    const maybeRecoverFromRefusal = async (result) => {
      if (
        !result ||
        result.success !== true ||
        options._refusalDecomposeDepth ||
        (options.tools && options.tools.length > 0) ||
        result.toolUseBlocks
      ) {
        return result;
      }
      try {
        const rr = require('./refusalRecovery');
        if (!rr.isEnabled(process.env)) {
          return result;
        }
        // FIX 2 — 每请求链恢复次数上限:消费 KHY_REFUSAL_RECOVERY_MAX_RETRIES。
        // count>=maxRetries 即短路(原样返回 result);子调用携带 count+1。
        // 与 _refusalDecomposeDepth 递归护栏相互独立,互不影响。
        const maxRetries = rr._resolveMaxRetries(process.env);
        const recoveryCount = Number(options._refusalRecoveryCount) || 0;
        if (recoveryCount >= maxRetries) {
          return result;
        }
        const _mit = require('../modelIdentityTruth');
        const userText = _mit.pickUserText(prompt, options);
        if (!rr.detectFalseRefusal(result.content, userText, process.env).detected) {
          return result;
        }
        const streamActive = typeof originalOnChunk === 'function';
        const recovered = await rr.recover({
          originalPrompt: prompt,
          options,
          emitStatus,
          generate: (p, o) =>
            this.generate(p, {
              ...o,
              _refusalDecomposeDepth: 1,
              _refusalRecoveryCount: recoveryCount + 1,
            }),
          // Part 4 — streaming: forward each sub-step chunk live (step prefix is
          // carried by the emitStatus '第 i/N 步' lines) and retract the already
          // streamed refusal draft with a reset frame before re-streaming.
          forwardChunk: streamActive
            ? (chunk) => {
                try {
                  forwardGatewayChunk(chunk, true);
                } catch {
                  /* best effort */
                }
              }
            : null,
          emitReset: streamActive
            ? () => {
                try {
                  forwardGatewayChunk(
                    require('../query/responseDebounce').buildResetChunk('refusal-recovery'),
                    false
                  );
                } catch {
                  /* best effort */
                }
              }
            : null,
        });
        if (recovered && recovered.content) {
          result.content = recovered.content;
          result.refusalRecovered = true; // 附加元数据,老消费方忽略
          result.refusalRecoverySteps = recovered.stepCount;
          result.tokenUsage = rr.mergeTokenUsage(result.tokenUsage, recovered.tokenUsage);
        }
      } catch (e) {
        try {
          emitStatus(`误拒恢复跳过 (fail-soft): ${e && e.message}`);
        } catch {
          /* best effort */
        }
        // fail-soft: 任何异常都保留原始响应逐字节不变
      }
      return result;
    };
    const finishResult = (result, { response = null, error = null } = {}) => {
      _stopGatewayIdleWatchdog();
      languageChunkGate = null;
      const durationMs = Date.now() - startTime;
      const languageConsistency = languageTracker ? languageTracker.finalize(result) : null;
      if (_traceAudit) {
        try {
          _traceAudit.logEvent(
            'llm.response',
            {
              requestId: options.requestId,
              success: !!result?.success,
              model: result?.model || response?.model || options.model || 'unknown',
              provider: result?.provider || response?.provider || 'unknown',
              adapter:
                result?.adapter || result?.actualAdapter || options?.preferredAdapter || null,
              errorType: result?.errorType || null,
              error: result?.error || error || null,
              contentPreview: result?.content || response?.content || null,
              attempts: Array.isArray(result?.attempts) ? result.attempts : [],
              tokenUsage: result?.tokenUsage || response?.tokens || null,
              durationMs,
              languageConsistency,
            },
            {
              sessionId: options.sessionId || null,
              traceId: options._diagTraceId || null,
              requestId: options.requestId || null,
              source: 'ai-gateway',
              visibility: 'internal',
            }
          );
        } catch {
          /* non-critical */
        }
      }
      if (response) {
        endTraceOnce(response, { tokens: response.tokens || response.tokenUsage || null });
      } else if (error) {
        endTraceOnce(null, { error });
      } else {
        endTraceOnce(null, { error: 'Gateway finished without response' });
      }
      completeGenerationOnce();
      // Cache model context window on successful response
      if (result && result.success) {
        const usedModel = result.model || response?.model || options.model;
        if (usedModel && !this._contextWindowCache.has(usedModel)) {
          this._resolveContextWindowAsync(usedModel);
        }
        // 被动学习(仅正向晋升):真实回复带 native tool_calls 即确证该模型支持原生工具,
        // 写入实测缓存(toolCapabilityStore),供决策层 measured 入参覆盖按名字的启发。
        // 零额外成本、绝不抛;只晋升不降级(纯文本回复不代表不支持,降级只靠主动探测)。
        try {
          const _tub = result.toolUseBlocks;
          if (usedModel && Array.isArray(_tub) && _tub.length > 0) {
            require('./toolCapabilityStore').recordVerdict(usedModel, 'native', {
              source: 'passive',
            });
          }
        } catch {
          /* passive learning is best-effort */
        }
        // Persist the last VERIFIED (model, adapter) pair so the next startup
        // prefers a channel proven to complete a generation over the blind
        // first-available default (see lastVerifiedModelStore). Fail-soft.
        try {
          require('./lastVerifiedModelStore').recordLastVerifiedModel({
            model: usedModel || null,
            adapter: result.actualAdapter || result.adapter || null,
          });
        } catch {
          /* best-effort persistence — never affects the result */
        }
      }
      // Cache successful result for dedup (skipped for image requests: dedupFp is null)
      if (result && result.success && isNewRequest && dedupFp) {
        this._dedup
          .storeResponse(dedupFp, {
            success: result.success,
            content: result.content,
            thinking: result.thinking || null,
            provider: result.provider,
            adapter: result.adapter,
          })
          .catch(() => {});
      }
      // 确定性失败解释器:对有唯一确定答案的失败(模型能力错配/模型不存在/404)
      // 前置一段「诊断(确定性)」,直接给出确定原因与纠正动作,而非让模型「猜」。
      // 无法确定→不改动;门控 KHY_FAILURE_EXPLAINER(默认开)。fail-soft:绝不让
      // 解释器自身异常打断失败返回路径。
      if (result && result.success === false) {
        try {
          const explanation = failureExplainer.buildFailureExplanation({
            model: result.model || options.model,
            attempts: Array.isArray(result.attempts) ? result.attempts : [],
            hasImage: hasImageInput,
            env: process.env,
          });
          if (explanation && !/诊断（确定性）/.test(String(result.content || ''))) {
            const body = String(result.content || '').trim();
            result.content = body ? `${explanation}\n\n${body}` : explanation;
          }
        } catch {
          /* fail-soft */
        }
      }
      // 大方承认未知/不支持格式的附件:本次带附件、失败属「载荷级」(上游读不了该附件
      // 内容)、且未被图像 OCR 救回(_ocrFallbackApplied 为假)时,前置一段诚实的「我读
      // 不了这种格式 + 确定性解决方案」。绝不静默 400、绝不伪造文件内容。判据与文案同源
      // 于纯叶子 attachmentFailurePolicy(门控 KHY_ATTACHMENT_FAILURE_POLICY 关→null→不
      // 改动)。与上面的失败解释器并列、各自去重(UNREADABLE_MARKER)。fail-soft。
      if (result && result.success === false && !options._ocrFallbackApplied) {
        try {
          const afp = require('./attachmentFailurePolicy');
          const hasDocs = Array.isArray(options.documents) && options.documents.length > 0;
          if (
            (hasImageInput || hasDocs) &&
            afp.isPayloadScopedFailure({
              hasAttachment: true,
              errorType: result.errorType,
              error: result.error,
              statusCode: result.statusCode,
            })
          ) {
            const kinds = [];
            if (hasImageInput) {
              kinds.push('image');
            }
            if (hasDocs) {
              kinds.push('document');
            }
            const exts = [];
            const _collectExts = (arr) => {
              for (const it of Array.isArray(arr) ? arr : []) {
                const nm =
                  it && (it.filename || it.name || it.path || it.mimeType || it.mime || it.type);
                const m = String(nm || '').match(/\.([a-z0-9]{1,8})(?:$|[?#])/i);
                if (m) {
                  exts.push(m[1]);
                }
              }
            };
            _collectExts(options.documents);
            _collectExts(options.images);
            const notice = afp.buildUnreadableAttachmentMessage({ kinds, exts });
            if (notice && !String(result.content || '').includes(afp.UNREADABLE_MARKER)) {
              const body = String(result.content || '').trim();
              result.content = body ? `${notice}\n\n${body}` : notice;
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 网络中断不吞掉已识别的图片文字:prep 期非视觉模型已用本地 OCR 把图片文字提取到
      // _ocrFallbackText、塞进 prompt,但随后调远端模型作答时若遇网络/超时失败,原先只回
      // 「网络连接出现问题」——离线明明已识别的文字白丢了。这里在网络/超时失败时把已识别
      // 文字作为诚实降级内容前置,做到「有无视觉模型、甚至断网都能给出图片文字」。判据与
      // 文案同源于纯叶子 imageOcrFallbackPolicy(门控 KHY_OCR_TEXT_ON_NETFAIL 关→null→不
      // 改动)。OCR_NETFAIL_MARKER 去重。fail-soft。
      if (
        result &&
        result.success === false &&
        options._ocrFallbackApplied &&
        options._ocrFallbackText
      ) {
        try {
          const _iofp = require('./imageOcrFallbackPolicy');
          if (
            _iofp.shouldApplyOcrTextOnNetFail({
              ocrApplied: true,
              errorType: result.errorType,
              hasText: !!options._ocrFallbackText,
              env: process.env,
            })
          ) {
            const note = _iofp.buildOcrTextOnNetFailNote({
              text: options._ocrFallbackText,
              env: process.env,
            });
            if (note && !String(result.content || '').includes(_iofp.OCR_NETFAIL_MARKER)) {
              const body = String(result.content || '').trim();
              result.content = body ? `${note}\n\n${body}` : note;
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 不轻信模型自报(KHY_ANSWER_VERIFIER 默认开):纯聊天答复无工具上下文,只做算式
      // 真值复核——把模型在正文里写出的等式用精确有理数运算复核,写错处如实追加到末尾。
      // actions:false(此处无 toolCallLog)。APPEND + VERIFY_MARKER 去重。门控关→note=null
      // →result.content 逐字节不变。fail-soft。(agentic 答复的复核在 toolUseLoop 收尾处。)
      if (result && result.success === true) {
        try {
          const _av = require('../answerVerifier');
          if (
            _av.isEnabled(process.env) &&
            !String(result.content || '').includes(_av.VERIFY_MARKER)
          ) {
            const _verdict = _av.verifyAnswer({
              answer: result.content,
              actions: false,
              env: process.env,
            });
            if (_verdict && _verdict.note) {
              result.content = `${String(result.content || '')}${_verdict.note}`;
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 模型身份不可伪装(B 层, goal 2026-07-04):用户这句在问身份(你是什么模型/谁做的/供应
      // 商是谁),且模型答复伪装(自称冲突厂商)或隐瞒(避谈真实来源)时,用网关**实际路由**的
      // adapter/model 追加一段确定性真值脚注。真值(渠道+模型)全缺 → 降级不追加(零编造)。
      // IDENTITY_MARKER 去重。门控 KHY_MODEL_IDENTITY_TRUTH 关 → buildTruthFooter 返 null →
      // result.content 逐字节不变。fail-soft:绝不因此打断返回路径。
      if (result && result.success === true) {
        try {
          const _mit = require('../modelIdentityTruth');
          if (
            _mit.isEnabled(process.env) &&
            !String(result.content || '').includes(_mit.IDENTITY_MARKER)
          ) {
            const _userText = _mit.pickUserText(prompt, options);
            if (_mit.isIdentityQuestion(_userText)) {
              const _truth = _mit.resolveTruth({
                adapter: result.adapter || result.actualAdapter || options.preferredAdapter,
                provider: result.provider,
                model: result.model,
                requestedModel: options.model,
              });
              const _verdict = _mit.detectDisguise(result.content, _truth);
              if (_verdict && _verdict.disguised) {
                const _footer = _mit.buildTruthFooter(_truth, {
                  locale: _mit.pickLocale(_userText),
                  env: process.env,
                });
                if (_footer) {
                  result.content = `${String(result.content || '')}${_footer}`;
                }
              }
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 缓存命中率如实上报(B 层, goal 2026-07-04, 截图):用户这句在问缓存命中率(你的命中率
      // 是多少 / ai 模型的命中率),且模型答复搪塞(不确定 / 没有监控工具 / 取决于…)或通篇没给
      // 真实数字时,用网关**实际遥测**追加确定性真值脚注——本轮 usage 的即时命中率 + cacheEconomyStore
      // 各渠道累计命中率。无任何遥测 → 降级不追加(零编造)。METRICS_MARKER 去重。门控
      // KHY_CACHE_METRICS_TRUTH 关 → buildMetricsFooter 返 null → result.content 逐字节不变。fail-soft。
      if (result && result.success === true) {
        try {
          const _cmt = require('../cacheMetricsTruth');
          if (
            _cmt.isEnabled(process.env) &&
            !String(result.content || '').includes(_cmt.METRICS_MARKER)
          ) {
            const _userText = _cmt.pickUserText(prompt, options);
            if (_cmt.isCacheMetricsQuestion(_userText)) {
              let _report = null;
              try {
                _report = require('./cacheEconomyStore').getReport();
              } catch {
                /* 探针不可用 → 只用本轮 usage */
              }
              const _metrics = _cmt.resolveMetrics({
                turnUsage: result.tokenUsage,
                report: _report,
                activeAdapter: result.adapter || result.actualAdapter || options.preferredAdapter,
              });
              const _verdict = _cmt.detectDeflection(result.content, _metrics);
              if (_verdict && _verdict.deflected) {
                const _footer = _cmt.buildMetricsFooter(_metrics, {
                  locale: _cmt.pickLocale(_userText),
                  env: process.env,
                });
                if (_footer) {
                  result.content = `${String(result.content || '')}${_footer}`;
                }
              }
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // OCR「使用 OCR」确定性脚注(ocrUsageFootnote;OPS-MAN-126,承 OPS-124):本轮确有 OCR 文本被
      // 读出并注入(_ocrImageTextRead,仅 OCR-文本三站点置真,视觉描述/无文本剥图路径均不置)、模型
      // 也成功作答时,OPS-124 只在 prompt 里给了模型一条**披露 OCR**的指令——模型可能忽略 → 正文对
      // OCR 只字不提 → 「明显告知用户」失守。这里做确定性兜底:正文若**尚未**提到 OCR
      // (answerAlreadyDisclosesOcr 未命中 = 模型忽略了指令),在末尾确定性追加一句用户可见脚注;
      // 正文已提 OCR(模型合规)→ 不追加,保持无感、绝不重复披露。与 answerVerifier/modelIdentityTruth
      // 等成功侧确定性脚注同族。FOOTNOTE_MARKER 去重。门控 KHY_OCR_USAGE_FOOTNOTE 关 →
      // buildOcrUsageFootnote 返 null → result.content 逐字节不变。fail-soft。
      if (result && result.success === true && options._ocrImageTextRead) {
        try {
          // OPS-MAN-140(承 OPS-138):OCR 成功读出文本、模型正文**却仍否认收到图**这一格,普通「用了 OCR」
          // 脚注措辞「以上关于这张图片的内容」不成立且不纠正否认。此时改用 visionDenialCorrection 的 OCR-成功
          // 变体,做一句**否认感知**的确定性纠正取代普通脚注(不叠加、避免心灵噪音)。门
          // KHY_VISION_DENIAL_CORRECTION_OCR_READ 关 → _appended 恒 false → 落回下方普通 ocrUsageFootnote,
          // 逐字节回退历史行为;模型未否认(detectImageDenial 未命中)→ 同样落回普通脚注。fail-soft。
          let _appended = false;
          const _vdc = require('./visionDenialCorrection');
          if (
            _vdc.isOcrReadDenialEnabled(process.env) &&
            !String(result.content || '').includes(_vdc.DENIAL_CORRECTION_OCR_READ_MARKER) &&
            _vdc.detectImageDenial(result.content)
          ) {
            const _imgN = Array.isArray(options.images)
              ? options.images.length
              : options._ocrImageTextCount;
            const _footer = _vdc.buildDenialCorrectionNote({
              count: _imgN,
              env: process.env,
              ocrTextRead: true,
            });
            if (_footer) {
              result.content = `${String(result.content || '')}${_footer}`;
              _appended = true;
            }
          }
          if (!_appended) {
            const _ouf = require('./ocrUsageFootnote');
            if (
              _ouf.isFootnoteEnabled(process.env) &&
              !String(result.content || '').includes(_ouf.OCR_USAGE_FOOTNOTE_MARKER) &&
              !_ouf.answerAlreadyDisclosesOcr(result.content)
            ) {
              const _footer = _ouf.buildOcrUsageFootnote({
                count: options._ocrImageTextCount,
                env: process.env,
              });
              if (_footer) {
                result.content = `${String(result.content || '')}${_footer}`;
              }
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 空 OCR 剥图路径「模型仍谎称没收到图」的确定性纠正(visionDenialCorrection;OPS-MAN-138,承 OPS-118/
      // 120/122「剥图必留痕」+ OPS-126 确定性脚注哲学):本轮确实带图并被剥离(_ocrFallbackApplied)、但**未**
      // 走 OCR-文本注入(!_ocrImageTextRead,即空 OCR / 读不出路径)、模型却在正文里**否认收到图**
      // (detectImageDenial 命中「消息里没有附带图片 / 当前对话中没有任何图片附件」等)时,prep/救援网三处注入
      // 的诚实底线只是 prompt 指令、被模型无视了 → 这里做**答复侧最后一道确定性纠正**:在末尾追加一句用户可见
      // 脚注,把「你确实上传了图、只是当前通道读不了」这一真相无条件送达。模型正文已诚实承认「收到图但读不出」
      // (detectImageDenial 未命中)→ 不追加,保持无感。与 ocrUsageFootnote 正交(那条判据 _ocrImageTextRead=true)。
      // DENIAL_CORRECTION_MARKER 去重。门控 KHY_VISION_DENIAL_CORRECTION 关 → buildDenialCorrectionNote 返 null
      // → result.content 逐字节不变。fail-soft。
      if (
        result &&
        result.success === true &&
        options._ocrFallbackApplied &&
        !options._ocrImageTextRead
      ) {
        try {
          const _vdc = require('./visionDenialCorrection');
          if (
            _vdc.isEnabled(process.env) &&
            !String(result.content || '').includes(_vdc.DENIAL_CORRECTION_MARKER) &&
            _vdc.detectImageDenial(result.content)
          ) {
            const _imgN = Array.isArray(options.images)
              ? options.images.length
              : options._ocrImageTextCount;
            const _footer = _vdc.buildDenialCorrectionNote({ count: _imgN, env: process.env });
            if (_footer) {
              result.content = `${String(result.content || '')}${_footer}`;
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 视觉能力路由透明(B 层, 自审 #6):用户这句在问视觉能力(哪些模型支持图像识别/你能看图吗/
      // 你是多模态吗)时,用 visionCapability SSOT 过滤真实注册表,确定性列出具备视觉能力的真实模型,
      // 并回显本轮**实际路由**的模型能否收图。注册表空 + 实际模型未知 → 降级不追加(零编造)。
      // VISION_MARKER 去重。门控 KHY_VISION_ROUTING_TRUTH 关 → buildVisionFooter 返 null →
      // result.content 逐字节不变。fail-soft。
      if (result && result.success === true) {
        try {
          const _vrt = require('../visionRoutingTruth');
          if (
            _vrt.isEnabled(process.env) &&
            !String(result.content || '').includes(_vrt.VISION_MARKER)
          ) {
            const _userText = _vrt.pickUserText(prompt, options);
            if (_vrt.isVisionQuestion(_userText)) {
              let _candidates = [];
              try {
                const _mfs = require('../multiFreeService');
                if (typeof _mfs.enumerateKnownModels === 'function') {
                  _candidates = _mfs
                    .enumerateKnownModels()
                    .map((m) => ({ id: m.id, provider: m.provider }));
                }
              } catch {
                /* 注册表不可用 → 只回显实际模型 */
              }
              const _activeModel = result.model || result.servedModel || options.model || '';
              let _activeVision = false;
              try {
                const _vc = require('./visionCapability');
                _activeVision = !!(
                  _activeModel && _vc.isVisionCapableModel(_activeModel, { env: process.env })
                );
              } catch {
                _activeVision = false;
              }
              const _footer = _vrt.buildVisionFooter(
                {
                  candidates: _candidates,
                  activeModel: _activeModel,
                  activeSupportsVision: _activeVision,
                },
                { locale: _vrt.pickLocale(_userText), env: process.env }
              );
              if (_footer) {
                result.content = `${String(result.content || '')}${_footer}`;
              }
            }
          }
        } catch {
          /* fail-soft */
        }
      }
      // 缓存前缀击穿归因(承 constants/promptPrefixShape 叶子——此前零消费者):对本轮
      // 实际发往 wire 的 system+tools 拍「影响 provider 前缀缓存复用的部分」快照,挂到
      // result.prefixShape 上,供 REPL 在命中率跌破阈值时把「为什么没命中」从一个数字变成
      // 可定位(系统提示/工具集/工具顺序变了)。纯确定性哈希、零 IO、绝不抛;门控
      // KHY_CACHE_PREFIX_SHAPE 关 → captureShape 返 null → 不挂字段(逐字节回退)。
      // display-only:只是给返回对象加一个诊断字段,绝不影响生成/重试/内容。
      if (result && result.success === true && result.prefixShape == null) {
        try {
          const _pps = require('../../constants/promptPrefixShape');
          const _shape = _pps.captureShape(
            {
              system: options.system || '',
              tools: Array.isArray(options.tools) ? options.tools : [],
            },
            process.env
          );
          if (_shape) {
            result.prefixShape = _shape;
          }
        } catch {
          /* fail-soft:归因是装饰性,绝不打断返回 */
        }
      }
      return languageConsistency ? { ...result, languageConsistency } : result;
    };
    if (gatewayAbort.signal.aborted) {
      return finishResult(
        buildEarlyCancelledResult(
          normalizeAbortReason(gatewayAbort.signal.reason || getAbortReason())
        ),
        {
          error: `Cancelled: ${normalizeAbortReason(gatewayAbort.signal.reason || getAbortReason())}`,
        }
      );
    }

    // Plugin Chain: onBeforeRequest
    const pluginChain = require('./pluginChain');
    let pluginCtx;
    try {
      pluginCtx = await pluginChain.executeBeforeRequest({
        prompt,
        options,
        adapter: null,
        cancelled: false,
      });
    } catch (pluginErr) {
      return finishResult(
        {
          success: false,
          content: `Gateway plugin error: ${pluginErr.message || 'beforeRequest failed'}`,
          provider: 'plugin',
          adapter: 'plugin',
          attempts: [],
          errorType: 'plugin_error',
        },
        { error: `Gateway plugin beforeRequest error: ${pluginErr.message || 'unknown'}` }
      );
    }
    if (externalAbortSignal && externalAbortSignal.aborted) {
      return finishResult(buildEarlyCancelledResult(getAbortReason()), {
        error: `Cancelled: ${getAbortReason()}`,
      });
    }
    if (pluginCtx.cancelled) {
      return finishResult(
        {
          success: false,
          content: 'Request cancelled by gateway plugin',
          provider: 'plugin',
          attempts: [],
        },
        { error: 'Cancelled by plugin' }
      );
    }
    prompt = pluginCtx.prompt || prompt;
    options = pluginCtx.options || options;

    // Periodic adapter re-detection (every 30 minutes)
    const REFRESH_INTERVAL = 30 * 60 * 1000;
    if (Date.now() - this._lastRefreshTime > REFRESH_INTERVAL) {
      const nonBlockingRefresh =
        isKhyInteractiveRuntime &&
        isSmallTask &&
        String(process.env.KHY_GATEWAY_REFRESH_NON_BLOCKING || 'true').toLowerCase() !== 'false';
      if (nonBlockingRefresh) {
        this._lastRefreshTime = Date.now();
        emitStatus('通道状态刷新已切换为后台执行（本次请求不等待）');
        this.refreshAdapters().catch(() => {});
      } else {
        await this.refreshAdapters();
      }
      if (externalAbortSignal && externalAbortSignal.aborted) {
        return finishResult(buildEarlyCancelledResult(getAbortReason()), {
          error: `Cancelled: ${getAbortReason()}`,
        });
      }
    }

    // ── Gateway-level app launch interception ─────────────────────────
    // 在 adapter cascade 循环之前统一拦截 "打开/启动/open <app>" 意图，
    // 直接通过 KHY open_app 工具执行，跳过 AI 推理。
    // 所有渠道（codex/claude/ollama/kiro/relay/api/trae/windsurf/...）都经过此拦截点。
    try {
      const { tryAppLaunchIntent } = require('./appLaunchInterceptor');
      const appLaunchResult = await tryAppLaunchIntent(prompt, options);
      if (appLaunchResult) {
        return finishResult(appLaunchResult, { response: appLaunchResult });
      }
    } catch {
      /* interceptor load failure — continue to adapter cascade */
    }

    // ── Gateway-level desktop control interception ────────────────────
    // 识别 "关闭/激活/最小化 <应用> | 列出窗口" 这类窗口操控意图，直接走
    // DesktopControl 门面的窗口原语（受 KHY_DESKTOP_CONTROL 安全闸门裁决）。
    try {
      const { tryDesktopIntent } = require('./desktopIntentInterceptor');
      const desktopResult = await tryDesktopIntent(prompt, options);
      if (desktopResult) {
        return finishResult(desktopResult, { response: desktopResult });
      }
    } catch {
      /* interceptor load failure — continue to adapter cascade */
    }

    const allAttempts = [];
    const preferredAdapterFromOptions = options.preferredAdapter !== undefined;
    const preferredAdapterInput = String(
      preferredAdapterFromOptions
        ? options.preferredAdapter
        : process.env.GATEWAY_PREFERRED_ADAPTER || ''
    ).trim();
    const preferredAdapterLower = preferredAdapterInput.toLowerCase();
    let preferredAdapter = '';
    if (preferredAdapterLower) {
      if (preferredAdapterLower === 'localllm') {
        preferredAdapter = 'localLLM';
      } else {
        const matched = this._adapters.find(
          (a) => String(a.key || '').toLowerCase() === preferredAdapterLower
        );
        // Keep unknown preferred adapter values visible so strict mode can
        // fail fast with a clear "not registered" error instead of silently
        // dropping preference and falling through to other adapters.
        preferredAdapter = matched ? matched.key : preferredAdapterLower;
      }
    }
    // ── GLM 视觉外层请求:强制钉 `api` 适配器(glmVisionApiPin)──────────────
    // 背景/实测根因:模型本身就是 GLM 视觉模型(glm/glm-4.6v-flash、glm-4v-flash)时,
    // decideVisionRouting 走 `keep` 分支 → 不进 describe 级联 → 从不钉 api;且用户常有一个
    // 环境级 GATEWAY_PREFERRED_ADAPTER(如 codex,非本次显式 options.preferredAdapter)——请求
    // 原样流进该非-api 通道,拿裸视觉模型名打自己上游 → 裸 404(既非「智谱AI:」也非「OpenAI:」
    // 前缀 → 真错因被吞,从不达 callZhipu)。只有 api→智谱端点能真正服务 glm-4Xv,故此处:带图 +
    // 非 describe 透传 + 模型是 GLM 视觉模型 + glm 池有 key + 当前非 api → 覆盖钉 api(即便已有
    // 环境级/非-api 首选亦覆盖,因其对该模型必 404),让请求定向智谱端点(callZhipu,模型确实存在
    // 处),真错因得以浮现;仍失败则既有 post-failure OCR 兜底照旧救回。门控 KHY_GLM_VISION_API_PIN
    // (parent KHY_GLM_VISION_MODEL,默认开)。全程 fail-soft:任何叶子/池不可用 → 不介入,逐字节
    // 回退通用级联。仅 GLM 视觉模型触发(纯文本/非-glm 不受影响)。
    if (hasImageInput && !options._visionDescribePass && preferredAdapter !== 'api') {
      try {
        const { shouldPinApiForGlmVision } = require('./glmVisionApiPin');
        const _apiEntry = this._adapters.find((a) => a.key === 'api' && a.enabled);
        if (_apiEntry) {
          let _glmKeyReady = false;
          try {
            _glmKeyReady = require('../apiKeyPool').hasAvailableKeys('glm');
          } catch {
            /* ignore */
          }
          if (
            shouldPinApiForGlmVision({
              hasImage: true,
              model: options.model,
              hasGlmKey: _glmKeyReady,
              env: process.env,
            })
          ) {
            preferredAdapter = 'api';
          }
        }
      } catch {
        /* fail-soft: 逐字节回退通用级联 */
      }
    }
    const preferredStrictRaw =
      options.preferredStrict !== undefined
        ? options.preferredStrict
        : process.env.GATEWAY_PREFERRED_STRICT;
    const strictPreferredByEnv = !!(
      preferredAdapter &&
      preferredAdapter !== 'auto' &&
      String(preferredStrictRaw).toLowerCase() !== 'false'
    );
    let strictPreferredOnly = options.strictPreferred === false ? false : strictPreferredByEnv;
    // 用户「显式钉选」渠道的不可放宽信号。与 env 默认 strict 严格区分：env 默认 strict
    // 仍保留连续失败后的自动放宽/兜底弹性（不破坏正常重试逻辑）；而当用户显式钉选了渠道
    // （模型串 adapter/model、显式 strict 路由规则、或调用方对具体适配器强制 strictPreferred），
    // 重试绝不擅自级联到用户未选择的其它渠道（如 trae），只在所选渠道内重试，失败则明确报错。
    // 来源：proxyServer 透传 route.userPinned → options.userPinnedAdapter；或直接调用方
    // 同时指定了具体 preferredAdapter 且 strictPreferred === true。
    const userPinnedAdapter = !!(
      preferredAdapter &&
      preferredAdapter !== 'auto' &&
      (options.userPinnedAdapter === true ||
        (preferredAdapterFromOptions && options.strictPreferred === true))
    );
    let firstTriedAdapter = null;
    let failedPreferredReason = null;
    const defaultTotalAttemptsBudget = isLargeTask ? 12 : isSmallTask ? 3 : 6;
    const baseMaxTotalAttempts = _parsePositiveInt(
      options.maxTotalAttempts ??
        process.env.GATEWAY_MAX_TOTAL_ATTEMPTS ??
        String(defaultTotalAttemptsBudget),
      defaultTotalAttemptsBudget,
      1,
      64
    );
    const defaultRetryDelayBudgetMs = isLargeTask ? 45000 : isSmallTask ? 5000 : 15000;
    const baseMaxRetryDelayBudgetMs = _parseMs(
      options.maxRetryDelayBudgetMs ??
        process.env.GATEWAY_MAX_RETRY_DELAY_BUDGET_MS ??
        String(defaultRetryDelayBudgetMs),
      defaultRetryDelayBudgetMs,
      1000
    );
    let maxTotalAttempts = baseMaxTotalAttempts;
    let maxRetryDelayBudgetMs = baseMaxRetryDelayBudgetMs;
    const retryBudgetAutoBoostEnabled = (() => {
      if (options.retryBudgetJitterAutoBoost !== undefined) {
        return !!options.retryBudgetJitterAutoBoost;
      }
      const fallback = isKhyInteractiveRuntime ? 'true' : 'false';
      const raw = String(process.env.GATEWAY_RETRY_BUDGET_JITTER_AUTO_BOOST || fallback)
        .trim()
        .toLowerCase();
      return !['0', 'false', 'off', 'no'].includes(raw);
    })();
    const retryBudgetBoostExtraAttemptsDefault = isLargeTask ? 4 : isSmallTask ? 2 : 3;
    const retryBudgetBoostExtraAttempts = _parsePositiveInt(
      options.retryBudgetJitterExtraAttempts ??
        process.env.GATEWAY_RETRY_BUDGET_JITTER_EXTRA_ATTEMPTS ??
        String(retryBudgetBoostExtraAttemptsDefault),
      retryBudgetBoostExtraAttemptsDefault,
      1,
      24
    );
    const retryBudgetBoostExtraDelayMsDefault = isLargeTask ? 20000 : isSmallTask ? 6000 : 12000;
    const retryBudgetBoostExtraDelayMs = _parseMs(
      options.retryBudgetJitterExtraDelayMs ??
        process.env.GATEWAY_RETRY_BUDGET_JITTER_EXTRA_DELAY_MS ??
        String(retryBudgetBoostExtraDelayMsDefault),
      retryBudgetBoostExtraDelayMsDefault,
      1000
    );
    // 整轮级联瞬态自愈轮次(GATEWAY_CASCADE_JITTER_RETRY_ROUNDS,默认 4):网络抖动时若整轮
    // 级联均以非硬确定性错误终结,退避等待后清除相关通道的瞬态冷却并重跑整轮适配器级联,给网络恢复
    // 一个「几轮」机会,而非一轮耗尽直接甩「所有 AI 通道均不可用」墙。0/off/false/no → 关闭
    // (逐字节回退今日行为)。轮次上限本身受墙钟硬死线(KHY_GATEWAY_HARD_TIMEOUT)与级联总次数
    // 封顶(_gatewayHardDeadline)约束,杜绝病态 churn。
    const _cascadeJitterRaw = String(
      options.cascadeJitterRounds != null
        ? options.cascadeJitterRounds
        : process.env.GATEWAY_CASCADE_JITTER_RETRY_ROUNDS || '4'
    )
      .trim()
      .toLowerCase();
    const cascadeJitterRetryRounds = ['0', 'off', 'false', 'no'].includes(_cascadeJitterRaw)
      ? 0
      : _parsePositiveInt(_cascadeJitterRaw, 4, 0, 8);
    let _cascadeJitterRound = 0;
    // ── 断网自动续传配置 ──
    // 整轮自愈轮次用尽、网络仍未恢复时,挂起请求周期性轻探失败通道,一旦网络恢复即清除
    // 瞬态冷却并自动重跑级联,而不是立刻甩「所有 AI 通道均不可用」墙。门控
    // KHY_GATEWAY_NETWORK_RESUME(默认开);KHY_GATEWAY_NETWORK_RESUME_MAX_MS 等待上限
    // (默认 120000, clamp[10000, 600000]);KHY_GATEWAY_NETWORK_RESUME_POLL_MS 探活间隔
    // (默认 5000, clamp[2000, 30000]);KHY_GATEWAY_NETWORK_RESUME_PROBE_TIMEOUT_MS 单次
    // 探活超时(默认 8000, clamp[3000, 20000])。仅前台用户请求且重试预算 >1 时启用——内部
    // 探活/后台任务(maxTotalAttempts=1 / requestSource≠foreground)不参与,避免 status 探活
    // 被自身续传挂死。等待受既有墙钟硬死线与本上限双约束,用户 abort 立即退出。
    const _networkResumeEnabled = (() => {
      if (options.networkResume !== undefined) {
        return !!options.networkResume;
      }
      const raw = String(process.env.KHY_GATEWAY_NETWORK_RESUME || 'true')
        .trim()
        .toLowerCase();
      return !['0', 'false', 'off', 'no'].includes(raw);
    })();
    const _networkResumeMaxMs = Math.min(
      1800000,
      Math.max(60000, _parseMs(process.env.KHY_GATEWAY_NETWORK_RESUME_MAX_MS || '300000', 300000))
    );
    const _networkResumePollMs = Math.min(
      30000,
      Math.max(2000, _parseMs(process.env.KHY_GATEWAY_NETWORK_RESUME_POLL_MS || '5000', 5000))
    );
    const _networkResumeProbeTimeoutMs = Math.min(
      20000,
      Math.max(
        3000,
        _parseMs(process.env.KHY_GATEWAY_NETWORK_RESUME_PROBE_TIMEOUT_MS || '8000', 8000)
      )
    );
    let _resumeRecovered = false;
    let _resumeNote = '';
    // 断网续传的请求级单一截止锚点:恢复后重跑再次失败时,续传不会重新起算 120s,
    // 而是累计同一份预算,杜绝「恢复→再断→再等」的无限续传 churn。
    let _resumeWaitStartedAt = 0;
    // 请求级续传闸:整个请求最多经历 N 轮「等待网络恢复→自动重跑」,防无限循环。
    // 每轮上限由 _resumeCycleMax 控制(默认 2,环境变量 KHY_GATEWAY_RESUME_MAX_CYCLES 可调)。
    let _resumeCyclesUsed = 0;
    const _resumeCycleMax = (() => {
      const raw = String(process.env.KHY_GATEWAY_RESUME_MAX_CYCLES || '2').trim();
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 1 ? Math.min(n, 5) : 2;
    })();
    let retryBudgetBoostApplied = false;
    const _isNetworkJitterLikeFailure = (errorType, errorMessage, statusCode) => {
      const type = String(errorType || '')
        .trim()
        .toLowerCase();
      const msg = String(errorMessage || '').toLowerCase();
      const statusNum = Number(statusCode || 0);
      if ([502, 503, 504, 522, 524, 525, 526].includes(statusNum)) {
        return true;
      }
      if (
        /client network socket disconnected before secure tls connection was established/.test(msg)
      ) {
        return true;
      }
      if (
        /econnreset|socket hang up|eai_again|enotfound|tls|ssl|handshake|proxy error|upstream connect error|network .* disconnected|connection reset|temporarily unavailable/.test(
          msg
        )
      ) {
        return true;
      }
      if (
        (type === 'network' || type === 'timeout') &&
        /(socket|network|connection|tls|ssl|dns|proxy|upstream|disconnect|timeout)/.test(msg)
      ) {
        return true;
      }
      return false;
    };
    const _maybeBoostRetryBudgetForNetworkJitter = (
      errorType,
      errorMessage,
      statusCode,
      adapterKey = ''
    ) => {
      if (!retryBudgetAutoBoostEnabled || retryBudgetBoostApplied) {
        return false;
      }
      if (strictPreferredOnly && preferredAdapter && adapterKey === preferredAdapter) {
        return false;
      }
      if (!_isNetworkJitterLikeFailure(errorType, errorMessage, statusCode)) {
        return false;
      }
      const prevAttempts = maxTotalAttempts;
      const prevRetryDelay = maxRetryDelayBudgetMs;
      maxTotalAttempts = Math.max(
        prevAttempts,
        Math.min(20, prevAttempts + retryBudgetBoostExtraAttempts)
      );
      maxRetryDelayBudgetMs = Math.max(
        prevRetryDelay,
        Math.min(60000, prevRetryDelay + retryBudgetBoostExtraDelayMs)
      );
      retryBudgetBoostApplied = true;
      emitStatus(
        `检测到网络抖动，本次请求临时扩展重试预算: attempts ${prevAttempts}->${maxTotalAttempts}, retry-delay ${prevRetryDelay}ms->${maxRetryDelayBudgetMs}ms`
      );
      return true;
    };
    // 一次真实(非 virtual-skip)尝试是否属「硬确定性失败」:auth / permission /
    // model_not_found / bad_request / unsupported / config / token_format / cancelled,
    // 以及 4xx 客户端错误(除瞬态 408/409/425/429)都算——重跑也救不回,必须整体跳过
    // 自愈。process / unknown / unavailable / empty 等不算硬确定性:断网时进程桥(codex)
    // 常以 process/unknown 收尾,若仍要求「全部瞬态」会把这些混合失败整体挡在自愈之外
    // (这正是「断网后不自愈」的根因之一);放宽后只要存在至少一条网络抖动信号即可自愈。
    const _HARD_DETERMINISTIC_TYPES = new Set([
      'auth',
      'permission',
      'model_not_found',
      'bad_request',
      'unsupported',
      'config',
      'token_format',
      'cancelled',
    ]);
    const _isHardDeterministicAttempt = (a) => {
      if (!a || a.virtualSkip) {
        return true;
      }
      const _st = Number(a.statusCode || 0);
      const _ty = String(a.errorType || '')
        .trim()
        .toLowerCase();
      if (_HARD_DETERMINISTIC_TYPES.has(_ty)) {
        return true;
      }
      if (_st >= 400 && _st < 500 && ![408, 409, 425, 429].includes(_st)) {
        return true;
      }
      return false;
    };
    let totalAdapterAttempts = 0;
    let totalRetryDelayMs = 0;
    const buildCancelledResult = (reasonText = getAbortReason()) => ({
      success: false,
      content: `请求已取消: ${reasonText}`,
      provider: 'none',
      adapter: 'none',
      preferredAdapter,
      actualAdapter: firstTriedAdapter,
      fallbackReason: failedPreferredReason || null,
      attempts: allAttempts,
      errorType: 'cancelled',
      cancelled: true,
    });
    const buildRetryBudgetExceededContent = (reasonText) => {
      const lines = [
        `请求重试预算已用尽: ${reasonText}`,
        '',
        '建议下一步:',
        '  1) 运行 `khy gateway status` 查看各通道状态',
        '  2) 拆分任务后重试，减少单次请求跨度',
        '  3) 如确需更多预算，设置 `GATEWAY_MAX_TOTAL_ATTEMPTS` / `GATEWAY_MAX_RETRY_DELAY_BUDGET_MS`',
      ];
      if (retryBudgetBoostApplied) {
        lines.push(
          `  4) 本次已自动扩展网络抖动预算（attempts ${baseMaxTotalAttempts}->${maxTotalAttempts}, delay ${baseMaxRetryDelayBudgetMs}ms->${maxRetryDelayBudgetMs}ms）`
        );
      }
      return lines.join('\n');
    };
    const failRetryBudgetExceeded = (reasonText) =>
      finishResult(
        {
          success: false,
          content: _prependFailureReason(
            buildRetryBudgetExceededContent(reasonText),
            allAttempts,
            8
          ),
          provider: 'none',
          adapter: 'none',
          preferredAdapter,
          actualAdapter: firstTriedAdapter,
          fallbackReason: reasonText,
          attempts: allAttempts,
          errorType: 'retry_budget_exceeded',
        },
        { error: reasonText }
      );
    const reserveAttemptBudget = () => {
      const nextAttemptCount = totalAdapterAttempts + 1;
      if (nextAttemptCount > maxTotalAttempts) {
        const reason = `总尝试次数超限 (${nextAttemptCount}/${maxTotalAttempts})`;
        emitStatus(`停止重试: ${reason}`);
        return failRetryBudgetExceeded(reason);
      }
      totalAdapterAttempts = nextAttemptCount;
      return null;
    };
    const releaseAttemptBudget = () => {
      if (totalAdapterAttempts > 0) {
        totalAdapterAttempts -= 1;
      }
    };
    const waitWithRetryDelayBudget = async (delayMs) => {
      const waitMs = Math.max(0, Math.floor(Number(delayMs) || 0));
      if (waitMs <= 0) {
        return null;
      }
      const nextDelay = totalRetryDelayMs + waitMs;
      if (nextDelay > maxRetryDelayBudgetMs) {
        const reason = `重试等待预算超限 (${nextDelay}ms/${maxRetryDelayBudgetMs}ms)`;
        emitStatus(`停止重试: ${reason}`);
        return failRetryBudgetExceeded(reason);
      }
      totalRetryDelayMs = nextDelay;
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      return null;
    };

    // Use preferred adapter/model from env if set
    const preferredModel = String(
      options.preferredModel !== undefined
        ? options.preferredModel
        : process.env.GATEWAY_PREFERRED_MODEL || ''
    ).trim();

    const allowStrictAutoRelaxByEnv =
      options.strictAutoRelaxOnProcess !== undefined
        ? !!options.strictAutoRelaxOnProcess
        : String(process.env.GATEWAY_STRICT_AUTO_RELAX_ON_PROCESS || 'true').toLowerCase() !==
          'false';
    const strictAutoRelaxForLargeTasks =
      String(process.env.GATEWAY_STRICT_AUTO_RELAX_LARGE_TASKS || 'true').toLowerCase() !== 'false';
    const allowStrictAutoRelaxOnProcess =
      allowStrictAutoRelaxByEnv && (!isLargeTask || strictAutoRelaxForLargeTasks);
    const strictAutoRelaxMinFailures = Math.max(
      1,
      parseInt(process.env.GATEWAY_STRICT_AUTO_RELAX_MIN_FAILURES || '1', 10) || 1
    );
    // HTTP relay/api 首选通道遇「死端点」类失败（404/4xx/5xx）时自动放宽 strict，
    // 回退到可用通道，避免单个已死的 relay 端点拖垮整轮对话。默认开，可用
    // KHY_RELAY_DEADENDPOINT_RELAX={0|false|off|no} 关闭以逐字节回退旧行为。
    const relayDeadEndpointRelax = !['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_RELAY_DEADENDPOINT_RELAX || 'true')
        .trim()
        .toLowerCase()
    );
    if (
      strictPreferredOnly &&
      !userPinnedAdapter &&
      allowStrictAutoRelaxOnProcess &&
      preferredAdapter &&
      preferredAdapter !== 'auto' &&
      _isProcessSensitiveAdapter(preferredAdapter)
    ) {
      const recentPreferredFail = await this._getRecentFastFail(preferredAdapter);
      const recentIsProcess = !!(
        recentPreferredFail && recentPreferredFail.errorType === 'process'
      );
      const preferredFailureCount = Number(this._adapterFailures[preferredAdapter] || 0);
      if (recentIsProcess || preferredFailureCount >= strictAutoRelaxMinFailures) {
        strictPreferredOnly = false;
        emitStatus(
          `检测到 ${preferredAdapter} 通道连续 process 异常，本次请求临时放宽 strict 并启用兜底通道`
        );
      }
    }
    const _shouldRelaxStrictPreferredOnFailure = (entryKey, errorType, errorMessage) => {
      if (!strictPreferredOnly) {
        return false;
      }
      // 用户显式钉选的渠道绝不放宽——只在所选渠道内重试，失败明确报错，不级联到 trae 等未选渠道。
      if (userPinnedAdapter) {
        return false;
      }
      if (!preferredAdapter || preferredAdapter === 'auto') {
        return false;
      }
      if (entryKey !== preferredAdapter) {
        return false;
      }
      const normalizedType = String(errorType || '')
        .trim()
        .toLowerCase();
      const msg = String(errorMessage || '').toLowerCase();
      // HTTP relay/api 首选通道遇「死端点」类失败（404→model_not_found/unavailable /
      // 4xx→bad_request / 5xx→server_error）时放宽 strict，回退到可用通道。刻意排除
      // auth/rate_limit/unsupported：活着但被限流/鉴权失败的端点应就地重试或换 key，
      // 不该被级联甩掉（否则会掩盖 1302 之类）。注意网关 classifyError 把 404 归为
      // model_not_found（见 errorClassifier），这正是用户 trae 死端点的真实类型。
      if (
        relayDeadEndpointRelax &&
        _isHttpRelayAdapter(preferredAdapter) &&
        _isDeadEndpointErrorType(normalizedType) &&
        Number(this._adapterFailures[preferredAdapter] || 0) >= strictAutoRelaxMinFailures
      ) {
        return true;
      }
      // 既有 process-sensitive 通道（IDE 桥接类）放宽路径保持不变。
      if (!allowStrictAutoRelaxOnProcess) {
        return false;
      }
      if (!_isProcessSensitiveAdapter(preferredAdapter)) {
        return false;
      }
      if (
        normalizedType === 'process' ||
        normalizedType === 'timeout' ||
        normalizedType === 'network'
      ) {
        return true;
      }
      if (/adapter\s+\S+\s+queue timeout|queue task timeout/.test(msg)) {
        return true;
      }
      if (_isTransientGatewayTransportMessage(msg)) {
        return true;
      }
      return false;
    };
    let _relaxRestart = false;
    const _maybeRelaxStrictPreferredOnFailure = (entryKey, errorType, errorMessage) => {
      if (!_shouldRelaxStrictPreferredOnFailure(entryKey, errorType, errorMessage)) {
        return false;
      }
      strictPreferredOnly = false;
      const normalizedType = String(errorType || '')
        .trim()
        .toLowerCase();
      const msg = String(errorMessage || '').toLowerCase();
      const isDeadEndpointType = _isDeadEndpointErrorType(normalizedType);
      const reasonLabel =
        relayDeadEndpointRelax && _isHttpRelayAdapter(entryKey) && isDeadEndpointType
          ? '端点不可用'
          : /adapter\s+\S+\s+queue timeout|queue task timeout/.test(msg)
            ? '队列异常'
            : normalizedType === 'timeout'
              ? '超时异常'
              : normalizedType === 'network'
                ? '网络异常'
                : 'process 异常';
      emitStatus(`检测到 ${entryKey} 通道${reasonLabel}，本次请求临时放宽 strict 并启用兜底通道`);
      // 标记需要重启级联，让更高优先级的适配器（如 Kiro）也有机会被尝试
      _relaxRestart = true;
      return true;
    };
    // env 级钉选 fail-soft：钉选仅来自 .env（非本次显式 options、非用户显式钉选）且该通道
    // 不可用/处于快速失败冷却时，不让 stale 钉选劫持整轮请求——解除 strict 继续级联到可用
    // 通道（如 .env 残留 GATEWAY_PREFERRED_ADAPTER=codex 而 codex 已不可用）。用户显式钉选
    // 语义不变。KHY_ENV_PIN_UNAVAILABLE_RELAX={0|false|off|no} 关闭以逐字节回退旧行为。
    const envPinUnavailableRelax = !['0', 'false', 'off', 'no'].includes(
      String(process.env.KHY_ENV_PIN_UNAVAILABLE_RELAX || 'true')
        .trim()
        .toLowerCase()
    );
    const _maybeRelaxEnvPinnedUnavailable = (entryKey, reasonLabel) => {
      if (!envPinUnavailableRelax) {
        return false;
      }
      if (!strictPreferredOnly || userPinnedAdapter || preferredAdapterFromOptions) {
        return false;
      }
      if (!preferredAdapter || preferredAdapter === 'auto' || entryKey !== preferredAdapter) {
        return false;
      }
      strictPreferredOnly = false;
      emitStatus(`环境钉选通道 ${preferredAdapter} ${reasonLabel}，解除钉选并继续级联兜底通道`);
      return true;
    };

    // Auto mode: select best adapter for this task
    const defaultRouteOptions = {
      ...options,
      prompt,
      taskType: options.taskType || 'conversation',
    };
    let orderedAdapters = this._orderAdaptersByDefaultRoutePreference(
      this._adapters,
      defaultRouteOptions
    );
    if (!Array.isArray(orderedAdapters) || orderedAdapters.length === 0) {
      orderedAdapters = this._adapters;
    }
    let protocolHintLockedAdapter = '';
    if (preferredAdapter === 'auto') {
      const autoResult = this.autoSelectModel(options.taskType || 'conversation', options);
      if (autoResult.adapter !== 'relay') {
        options = { ...options, model: autoResult.model || options.model };
        protocolHintLockedAdapter = autoResult.adapter || '';
        // Reorder to try auto-selected first
        orderedAdapters = [
          ...orderedAdapters.filter((a) => a.key === autoResult.adapter),
          ...orderedAdapters.filter((a) => a.key !== autoResult.adapter),
        ];
      }
    } else if (preferredAdapter) {
      const preferredModelForAdapter = resolvePreferredModelForAdapter(
        preferredAdapter,
        preferredModel
      );
      if (!options.model && preferredModelForAdapter) {
        options = { ...options, model: preferredModelForAdapter };
      }
      protocolHintLockedAdapter = preferredAdapter;
      orderedAdapters = [
        ...orderedAdapters.filter((a) => a.key === preferredAdapter),
        ...orderedAdapters.filter((a) => a.key !== preferredAdapter),
      ];
    } else {
      // Habit-based preference: if no env override, use learned preference
      let habitPreferred = null;
      try {
        const { getPreferredModel } = require('../usageHabitService');
        habitPreferred = getPreferredModel('conversation');
      } catch {
        /* best effort */
      }

      if (habitPreferred && habitPreferred.adapter) {
        const habitEntry = this._adapters.find(
          (a) => a.key === habitPreferred.adapter && a.enabled
        );
        const habitAssessment = this._assessDefaultRouteCandidate(habitEntry, defaultRouteOptions);
        if (habitAssessment && habitAssessment.healthyDefault) {
          orderedAdapters = [
            ...orderedAdapters.filter((a) => a.key === habitPreferred.adapter),
            ...orderedAdapters.filter((a) => a.key !== habitPreferred.adapter),
          ];
          if (habitPreferred.model && !options.model) {
            options = { ...options, model: habitPreferred.model };
          }
        }
      }
    }

    const preserveLeadingKeys = protocolHintLockedAdapter ? [protocolHintLockedAdapter] : [];
    orderedAdapters = this._reorderAdaptersByModelProtocolHint(orderedAdapters, options, {
      preserveLeadingKeys,
    });

    // 工具调用能力实测:首次用到未实测渠道时,后台 fire-and-forget 探测一次。当前轮仍走
    // провизионально名字启发,下一轮起以实测缓存为准(「不硬编码,实测后才算」)。探测自身
    // (_toolCapProbe)绝不再触发,避免递归;绝不阻塞、绝不抛。
    if (!options._toolCapProbe) {
      try {
        this._maybeBackgroundProbeToolCalling(
          orderedAdapters[0] && orderedAdapters[0].key,
          options.model
        );
      } catch {
        /* best effort */
      }
    }

    orderedAdapters = await this._maybePromoteProcessFailoverAdapters(orderedAdapters, {
      preferredAdapter,
      strictPreferredOnly,
      emitStatus,
    });

    const _verbosity = String(process.env.KHY_STATUS_VERBOSITY || 'auto')
      .trim()
      .toLowerCase();
    const _isVerbose = _verbosity === 'detailed';

    // ── 纯文本模型多模态：带图自动改选视觉模型，无候选则 OCR 兜底 ──────────
    // 用户语义(Option A)：带图时优先在同 provider 候选里挑一个支持视觉的模型
    // (如 sensenova-u1)识图；候选中没有视觉模型才退回 OCR。决策由纯模块
    // decideVisionRouting 给出，本处只负责执行 keep / switch-model / ocr-fallback。
    if (
      hasImageInput &&
      !options._ocrFallbackApplied &&
      !options._visionDescribePass &&
      !options._visionCapProbe
    ) {
      // 首选/领先通道原生收图(如 codex direct 模式 → Responses API;实测 mindflow
      // gpt-5.3-codex-review 可真视觉读图)→ 不把图剥成 OCR,保留图让该通道真识别。
      // 单一真源 adapterVisionCapability.adapterHandlesImagesNatively(只此一处判定)。
      // 安全:若该通道实际拒图(404 / model_not_found / bad_request),下游 post-failure
      // OCR 网(shouldOcrRescue → extractImageOcrDetails → cascade)会兜底救回,不会毒会话。
      // 门控关 / 叶子不可用 → _nativeVisionAdapter=false → 走下方既有视觉路由,逐字节回退。
      const _leadAdapterKey =
        preferredAdapter && preferredAdapter !== 'auto'
          ? preferredAdapter
          : (orderedAdapters[0] && orderedAdapters[0].key) || '';
      let _nativeVisionAdapter = false;
      try {
        _nativeVisionAdapter = require('./adapterVisionCapability').adapterHandlesImagesNatively(
          _leadAdapterKey
        );
      } catch {
        /* 叶子不可用 → 保持既有视觉路由 */
      }

      // Probe the concrete route before trusting adapter-level native support. A
      // native image transport only proves that the payload can be sent; the
      // selected endpoint/model may still reject or ignore image input.
      let _visionMeasured = null;
      try {
        const _visionProbe = require('./visionCapabilityProbe');
        const _visionStore = require('./visionCapabilityStore');
        if (_visionProbe.isEnabled(process.env) && options.model) {
          const _route = {
            adapter: _leadAdapterKey,
            pool: options.apiPoolProvider || options.provider || '',
            endpoint: options.apiEndpoint || '',
            apiFormat: options.apiFormat || '',
            model: options.model,
            apiKey: options.apiKey || '',
          };
          _visionMeasured = _visionStore.getVerdict(_route, process.env);
          if (_visionMeasured === null) {
            const _probeResult = await this.verifyVisionCapability(_route);
            _visionMeasured = _probeResult.verdict === 'supported' || _probeResult.verdict === 'unsupported'
              ? _probeResult.verdict
              : null;
            if (_isVerbose && _probeResult.reason) {
              emitStatus(`视觉能力实测：${_leadAdapterKey}/${options.model} → ${_probeResult.verdict}（${_probeResult.reason}）`);
            }
          }
        }
      } catch {
        /* fail-soft: static capability prior remains authoritative for this request */
      }

      // An explicit runtime rejection overrides the adapter's static native flag.
      if (_visionMeasured === 'unsupported') {
        _nativeVisionAdapter = false;
      }
      if (_nativeVisionAdapter) {
        if (_isVerbose) {
          emitStatus(`检测到图片输入：首选通道 ${_leadAdapterKey} 原生支持视觉，保留图片直接识别`);
        }
      } else {
        try {
          const { decideVisionRouting } = require('./visionRouting');
          const siblings = collectProviderSiblingModels(options.model);
          // 默认视觉兜底 = GLM-4.6V-Flash(用户诉求「先以 GLM-4.6V-Flash」)。仅在:门开
          // (KHY_GLM_VISION_MODEL)+ 用户未自定义 KHY_VISION_FALLBACK_MODEL + GLM key 确实
          // 可用 时,才把该 pin 注入到 decideVisionRouting 的 env。诚实:无 GLM key 绝不路由
          // 到它(避免打到无凭据的模型),回退既有链(env-pin → sibling → OCR)。门关/异常 →
          // 不注入 → 逐字节回退。pin 带 glm/ 前缀 → poolHint='glm' → 定向 GLM 端点。
          let _routingEnv = process.env;
          // GLM 视觉就绪状态:同时供 ① 下面的 GLM pin 注入 ② 更下方 ocr-fallback 分支的
          // 「配 GLM 视觉 key」邀约 两处读取(单点求值,避免重复触 IO)。
          let _glmVisionOn = false;
          let _glmKeyReady = false;
          try {
            const glmVision = require('./glmVisionModel');
            _glmVisionOn = glmVision.glmVisionEnabled(process.env);
            if (_glmVisionOn) {
              try {
                _glmKeyReady = require('../apiKeyPool').hasAvailableKeys('glm');
              } catch {
                /* ignore */
              }
              if (!String(process.env.KHY_VISION_FALLBACK_MODEL || '').trim()) {
                const _pin = glmVision.glmVisionFallbackPin(process.env);
                if (_glmKeyReady && _pin) {
                  _routingEnv = { ...process.env, KHY_VISION_FALLBACK_MODEL: _pin };
                }
              }
            }
          } catch {
            /* fail-soft: 叶子/池不可用 → 用 process.env,逐字节回退 */
          }
          const decision = decideVisionRouting({
            hasImage: true,
            currentModel: options.model,
            candidateModels: siblings,
            env: _routingEnv,
            measured: _visionMeasured,
          });
          if (decision.action === 'switch-model' && decision.model) {
            // 视觉候选已定。两种执行方式(门控 KHY_VISION_DESCRIBE_RETURN,默认开):
            //   ① describe-and-return(门开):视觉模型**只描述**图片 → 描述文本注入 prompt →
            //      **原文本模型**据此作答(用户选定的强模型始终是回答者;视觉模型仅当「眼睛」)。
            //   ② switch-model 替换(门关 / 描述失败 / 叶子不可用):视觉模型直接接管整轮作答
            //      (逐字节回退到既有行为)。
            // 复用既有 poolHint→apiPoolProvider 覆盖逻辑(pinned 跨 pool 视觉兜底须定向端点)。
            const pinnedPool =
              decision.reason === 'switched_to_pinned_vision_model'
                ? _normalizeApiPoolProvider(decision.poolHint)
                : null;
            let _describeReturnOn = false;
            try {
              _describeReturnOn = require('./visionDescribeReturn').isVisionDescribeReturnEnabled(
                process.env
              );
            } catch {
              /* 叶子不可用 → 当门关处理,走下方 switch 替换,逐字节回退 */
            }

            let _describeDone = false;
            let _describeAttempted = false;
            if (_describeReturnOn) {
              // describe-and-return:嵌套调视觉模型识图(precedent:RecognizeImage 亦经
              // gateway.generate 识图)。_visionDescribePass 短路本视觉块防二次进入;嵌套模型
              // 本就视觉可用故 decideVisionRouting 也判 keep,无限递归双保险。绝不外抛:任何
              // 失败/空描述 → 试下一备用视觉候选;全部失败 → 诚实说明 + OCR 兜底(见下),
              // 不违反「非视觉模型永不收到裸图」不变量(始终由视觉模型收图,失败则剥图)。

              // 用户可见中间消息门控(KHY_VISION_INTERMEDIATE_MESSAGE)——单次求值,供每个候选复用。
              let _intermediateEnabled = false;
              try {
                const flagReg = require('../flagRegistry');
                _intermediateEnabled = flagReg.isFlagEnabled(
                  'KHY_VISION_INTERMEDIATE_MESSAGE',
                  process.env
                );
              } catch {
                /* 叶子不可用 → 当门关 */
              }

              // 有序描述尝试列表:主视觉模型 +(门开 KHY_VISION_FALLBACK_CASCADE)有 key 的备用视觉
              // 模型(GLM 优先,排除主模型)。门关 → 只含主模型 = 逐字节回退单次尝试。
              const _attempts = [{ model: decision.model, poolHint: pinnedPool || undefined }];
              try {
                const flagReg = require('../flagRegistry');
                if (flagReg.isFlagEnabled('KHY_VISION_FALLBACK_CASCADE', process.env)) {
                  const { collectVisionFallbackCandidates } = require('./visionFallbackCandidates');
                  const _cands = collectVisionFallbackCandidates({
                    failedModel: decision.model,
                    env: process.env,
                  });
                  for (const c of Array.isArray(_cands) ? _cands : []) {
                    if (c && c.model) {
                      _attempts.push({
                        model: c.model,
                        poolHint: _normalizeApiPoolProvider(c.poolHint) || undefined,
                      });
                    }
                  }
                }
              } catch {
                /* 叶子不可用 → 只试主模型,逐字节回退 */
              }

              const _primaryModel = decision.model;
              const vdr = require('./visionDescribeReturn');
              let _lastRawError = null;
              // OPS-MAN-145:级联候选索引 + 前一候选模型名,供 visionCascadeAttemptNotice 把候选 2..N 的
              // 冗余首句「我无法直接识别图片内容。」折成「<prev> 不可用，正在改用 <model> 继续识别...」。
              let _attIdx = 0;
              let _prevAttemptModel = null;
              for (const _att of _attempts) {
                _describeAttempted = true;
                if (_intermediateEnabled && _attIdx === 0) {
                  // A vision turn exposes one start message. Candidate failover remains
                  // internal progress and is summarized once when recognition completes.
                  try {
                    // OPS-MAN-150:仅在**显示边界**去 provider 路由前缀(glm/glm-4.6v-flash → glm-4.6v-flash,
                    // 保大小写)。首候选 = 被切换钉住的视觉模型带路由前缀,其余候选是裸 id → 不归一则 prose
                    // 前后不一致泄漏内部路由。门关/叶不可用 → 原样(逐字节回退,含前缀)。内部 _att.model /
                    // _prevAttemptModel 路由态完全不动(poolHint 解析仍靠原始带前缀 id)。
                    let _dispModel = _att.model;
                    let _dispPrev = _prevAttemptModel;
                    try {
                      const _vmdn = require('./visionModelDisplayName');
                      _dispModel = _vmdn.toDisplayModelName(_att.model, process.env);
                      _dispPrev =
                        _prevAttemptModel == null
                          ? _prevAttemptModel
                          : _vmdn.toDisplayModelName(_prevAttemptModel, process.env);
                    } catch {
                      /* 叶不可用 → 原样带前缀,逐字节回退 */
                    }
                    const _note = require('./visionCascadeAttemptNotice').buildCascadeAttemptNotice(
                      {
                        index: _attIdx,
                        model: _dispModel,
                        prevModel: _dispPrev,
                        env: process.env,
                      }
                    );
                    if (_note) {
                      emitAssistantMessage(_note);
                    }
                  } catch {
                    const visionModel = _att.model || '视觉模型';
                    emitAssistantMessage(
                      `我无法直接识别图片内容。正在调用 ${visionModel} 进行识别，请稍候...`
                    );
                  }
                }
                try {
                  // ⚠️ 关键:poolHint(如 'glm')只在 `api` 适配器内部被读取
                  // (_resolveApiPoolProviderForRequest → 仅 entry.key==='api' 时消费)。
                  // 若不同时把 preferredAdapter 钉到 'api',这个嵌套 generate() 会从头跑
                  // 完整适配器级联(kiro→cursor→trae→…→api),排在 api 前面的 OpenAI 兼容
                  // 通道会先接住请求、拿到裸视觉模型名(glm-4.6v-flash)打到自己的上游 →
                  // 那里没有此模型 → `OpenAI: 404 model_not_found`,识图永远失败(实测根因)。
                  // 故:有 poolHint → 强制钉 api 适配器 + strictPreferred(失败不擅自级联到
                  // 别的通道,而是返回失败结果,由本 _attempts 循环去试下一个 GLM 视觉候选)。
                  // 无 poolHint(裸候选,默认同池)→ 保持原样让级联自然解析(逐字节回退)。
                  const _pinApiAdapter = this._shouldPinApiAdapterForVisionDescribe(_att.poolHint);
                  const _r = await this.generate(vdr.buildDescribePrompt(), {
                    model: _att.model,
                    images: options.images,
                    maxTokens: 2048,
                    temperature: 0.2,
                    apiPoolProvider: _att.poolHint || undefined,
                    provider: undefined,
                    preferredAdapter: _pinApiAdapter ? 'api' : 'auto',
                    strictPreferred: _pinApiAdapter ? true : false,
                    _visionDescribePass: true,
                  });
                  if (_r && _r.success && _r.content) {
                    const _injection = vdr.buildDescriptionInjection([String(_r.content)], {
                      model: _att.model,
                    });
                    if (_injection) {
                      prompt = `${prompt || ''}\n\n${_injection}`;
                      // 复用 _ocrFallbackApplied 防重入 + _ocrFallbackText 供 finishResult 网络
                      // 中断时用已识别文本诚实兜底(等同 OCR 兜底的落盘语义)。剥图:原文本模型
                      // 是纯文本,只据描述作答。
                      options = {
                        ...options,
                        images: undefined,
                        _ocrFallbackApplied: true,
                        _ocrFallbackText: _injection,
                      };
                      hasImageInput = false;
                      _describeDone = true;
                      if (_intermediateEnabled) {
                        // Keep failover context and completion in one terminal notice so a
                        // vision turn has one start message and one result closure.
                        const _failoverNote =
                          _att.model !== _primaryModel
                            ? `主视觉模型 ${_primaryModel} 不可用，已自动改用 ${_att.model} 完成识别，`
                            : '';
                        emitAssistantMessage(
                          `${_failoverNote}视觉识别完成，正在根据识别结果为您作答。`
                        );
                      }
                      if (_isVerbose) {
                        emitStatus(
                          `检测到图片输入：已用视觉模型 ${_att.model} 描述图片并回传给当前文本模型作答`
                        );
                      }
                      break;
                    }
                  } else {
                    // 失败结果(非抛错):记录真因供后续诚实说明(脱敏在 buildVisionFailureMessage 内)。
                    _lastRawError = (_r && (_r.content || _r.error)) || _lastRawError;
                  }
                } catch (descErr) {
                  _lastRawError = (descErr && descErr.message) || _lastRawError;
                  /* 描述失败 → 试下一备用候选 / 落下方诚实兜底,绝不外抛保图 */
                }
                // OPS-145:本候选已失败(成功分支在上方 break),记下模型名供下一候选提示「<prev> 不可用」。
                _prevAttemptModel = _att.model || _prevAttemptModel;
                _attIdx += 1;
              }

              if (!_describeDone && _describeAttempted) {
                // 全部视觉候选失败。两件事必须**解耦**:
                //   ① 人可见失败说明(门 KHY_VISION_FAILURE_SUMMARY = _summaryOn,纯装饰);
                //   ② 剥图 + OCR 兜底 + 「图片确实收到但读不出」诚实底线(**安全不变量**)。
                // 历史缺陷(2026-07-12 用户实测「Khy 无法正确读图 / 没有附带图片」):底线代码被错误地
                // 嵌在 `if (_summaryOn)` 内 —— 当失败说明门关时,底线被一并跳过,控制流落到下方 switch
                // 替换,把读不出的图**留着**改投**刚刚 404 的视觉模型**,最终文本模型在**毫无「图片存在」
                // 说明**下作答 → 如实却荒谬地回「消息里没有附带图片」。故用独立 default-on 门
                // KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR(_floorOn)把底线与失败说明拆开:底线门开(默认)→
                // 无论是否展示失败说明,都剥图 + OCR + 底线;门关 → 逐字节回退旧行为(底线仅 _summaryOn
                // 触发,再落下方 switch 替换)。
                let _summaryOn = false;
                try {
                  _summaryOn = require('./visionFailureSummary').isVisionFailureSummaryEnabled(
                    process.env
                  );
                } catch {
                  /* 叶子不可用 → 当门关 */
                }
                let _floorOn = false;
                try {
                  _floorOn = require('./visionOcrFallback').isDescribeFailFloorEnabled(process.env);
                } catch {
                  /* 叶子不可用 → 当门关,逐字节回退到仅 _summaryOn 触发底线 */
                }
                // OPS-MAN-142(承 OPS-140「减少显示的心灵噪音」):失败墙(含「粘贴 API Key」)原本在
                // 此处 OCR 兜底**之前**无条件发射。当图是含字图、随后本地 OCR **成功读出**时,那块吓人
                // 失败墙已先甩给用户,与紧接着的「已用 OCR 成功识别」自相矛盾 = 最响噪音。门
                // KHY_VISION_FAILURE_SUMMARY_OCR_SUPPRESS default-on → 把失败墙**推迟**到 OCR 结果已知
                // 之后:OCR 成功 → 抑制(_deferredFailureMsg 永不发);OCR 读空 → 照发。门关 → 逐字节
                // 回退(墙在 OCR 之前无条件发射)。
                let _ocrSuppressOn = false;
                try {
                  _ocrSuppressOn =
                    require('./visionFailureSummary').isFailureSummaryOcrSuppressEnabled(
                      process.env
                    );
                } catch {
                  /* 叶子不可用 → 当门关,墙照旧于 OCR 前发射 */
                }
                let _deferredFailureMsg = null;
                if (_summaryOn) {
                  try {
                    const _msg = require('./visionFailureSummary').buildVisionFailureMessage({
                      rawError: _lastRawError,
                      model: _primaryModel,
                      env: process.env,
                    });
                    if (_msg) {
                      if (_ocrSuppressOn) {
                        _deferredFailureMsg = _msg;
                      } // 推迟到 OCR 结果已知后再决定
                      else {
                        emitAssistantMessage(_msg);
                      } // 门关 → 逐字节回退:OCR 前无条件发射
                    }
                  } catch {
                    /* fail-soft:说明失败不阻断兜底 */
                  }
                }
                if (_summaryOn || _floorOn) {
                  // 剥图 + OCR 兜底 + 保留原文本模型(与 ocr-fallback 分支同款不变量处理)。
                  let _ocrTexts = [];
                  let _ocrDetails = [];
                  try {
                    _ocrDetails = extractImageOcrDetails(options.images, {
                      maxImages: 3,
                      maxChars: 1200,
                    });
                    _ocrTexts = _ocrDetails.map((d) => d.text);
                  } catch {
                    _ocrDetails = [];
                    _ocrTexts = [];
                  }
                  if (_ocrTexts.length > 0) {
                    const _ocrBlock = _ocrTexts
                      .map((t, i) => `【图片${i + 1} OCR 文本】\n${t}`)
                      .join('\n\n');
                    prompt = `${prompt || ''}\n\n[视觉模型不可用，以下为图片 OCR 识别文本，请据此作答]\n${_ocrBlock}`;
                    prompt = _appendOcrLowConfidenceCaveat(prompt, _ocrDetails);
                    prompt = _appendOcrCoverageNotice(prompt, {
                      totalImages: Array.isArray(options.images) ? options.images.length : 0,
                      ocrTextCount: _ocrTexts.length,
                      maxImages: 3,
                    });
                    prompt = _appendOcrTruncationNotice(prompt, _ocrDetails);
                    prompt = _appendOcrLanguageNotice(prompt, _ocrDetails);
                    prompt = _appendOcrOrientationNotice(prompt, _ocrDetails);
                    prompt = _appendOcrResolutionNotice(prompt, _ocrDetails);
                    // OCR 成功路径「使用 OCR 透明告知」(无条件):上面六条告诫都是条件型,干净成功时全静默,
                    // 模型据 OCR 文本作答却从不告诉用户用了 OCR。本条要求模型无感但明显地向用户披露。门关回退。
                    prompt = _appendOcrUsageDisclosure(prompt, { count: _ocrTexts.length });
                    prompt = _appendVisionKeyOffer(prompt, _glmVisionOn, _glmKeyReady);
                    options = {
                      ...options,
                      images: undefined,
                      _ocrFallbackApplied: true,
                      _ocrFallbackText: _ocrBlock,
                      _ocrImageTextRead: true,
                      _ocrImageTextCount: _ocrTexts.length,
                    };
                    // OPS-MAN-132(承 OPS-127):把「已降级到 OCR」无条件实时状态从 Site3 扩到 prep 期 Site1。
                    // 下方 1618 的 emitStatus 仅 _isVerbose 时发 → 非 verbose 用户在 prep 期 OCR 降级时实时进度层
                    // 沉默。此处仅 !_isVerbose 时补一条(verbose 用户已有既有状态,避免重复)。门 KHY_OCR_RESCUE_STATUS_PREP
                    // 关 / 叶不可用 → 返 null 不 emit,逐字节回退历史「非 verbose prep 期静默」。
                    // OPS-MAN-148(承 OPS-132+OPS-144「减少心灵噪音」):下方 OPS-144 闭合(1675)在本 Site1 路径上
                    // 也会发一条同义「已改用本地 OCR 成功识别…据此作答」的 assistant_message,且 prep-status 含「成功」
                    // 被 emitRuntimeStatus 误分类为永久「模型已连接」行 → 两条永久行叠同一公告 = 冗余噪音。故:闭合确将
                    // 发射时(_intermediateEnabled && 闭合门开)抑制这条冗余 prep-status,只留更清晰的闭合。门
                    // KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP 关 / 叶不可用 → 不抑制 = 逐字节回退(prep+闭合并存)。仅 Site1;
                    // Site2(ocr-fallback 无级联无闭合,~1796)不调用本守卫,始终保留 prep-status。fail-soft。
                    if (!_isVerbose) {
                      try {
                        const _ors = require('./ocrRescueStatusNotice');
                        let _closureWillFire = false;
                        try {
                          _closureWillFire =
                            _intermediateEnabled &&
                            require('./visionOcrSuccessClosure').isVisionOcrSuccessClosureEnabled(
                              process.env
                            );
                        } catch {
                          _closureWillFire = false;
                        }
                        const _suppressPrep = _ors.shouldSuppressPrepForClosure({
                          intermediateEnabled: _intermediateEnabled === true,
                          closureEnabled: _closureWillFire === true,
                          env: process.env,
                        });
                        if (!_suppressPrep) {
                          const _prep = _ors.buildOcrRescuePrepStatus({
                            count: _ocrTexts.length,
                            modelName: _primaryModel,
                            env: process.env,
                          });
                          if (_prep) {
                            emitStatus(_prep);
                          }
                        }
                      } catch {
                        /* fail-soft:叶不可用则按历史静默 */
                      }
                    }
                    // OPS-MAN-144:describe-fail → OCR-成功的用户可见闭合。上面每个候选视觉模型识别前
                    // 都发过「正在调用 <模型>,请稍候...」(KHY_VISION_INTERMEDIATE_MESSAGE),但视觉全失败后
                    // 走 OCR 成功兜底时,那 N 条「请稍候」承诺无人闭合(describe-成功在 line 1554 有闭合,此处没有)。
                    // 补一条「视觉模型均不可用,已改用本地 OCR 成功识别<N 张>图片,正在据此作答」:闭合悬空承诺 +
                    // 中间消息层无感明显告知已降级到 OCR。共享 _intermediateEnabled 前提(中间消息门关则整体不发);
                    // 独立门 KHY_VISION_OCR_SUCCESS_CLOSURE 关 → 叶返 null → 逐字节回退(不发闭合)。fail-soft。
                    if (_intermediateEnabled) {
                      try {
                        const _closure =
                          require('./visionOcrSuccessClosure').buildOcrSuccessClosure({
                            count: _ocrTexts.length,
                            env: process.env,
                          });
                        if (_closure) {
                          emitAssistantMessage(_closure);
                        }
                      } catch {
                        /* fail-soft:叶不可用则不发闭合 */
                      }
                    }
                  } else {
                    // OPS-MAN-142:OCR 读空 = 真失败 → 补发被推迟的失败墙(门开时才有 _deferredFailureMsg;
                    // 门关时墙已在 OCR 前发过,此处 _deferredFailureMsg 恒 null 不重发 = 逐字节等价)。
                    if (_deferredFailureMsg) {
                      try {
                        emitAssistantMessage(_deferredFailureMsg);
                      } catch {
                        /* fail-soft */
                      }
                    }
                    const _imgCount = Array.isArray(options.images) ? options.images.length : 0;
                    let _unreadableNote = null;
                    try {
                      _unreadableNote = require('./visionOcrFallback').buildVisionUnreadableNote({
                        count: _imgCount,
                      });
                    } catch {
                      /* 叶子不可用 → 保持后续清图 */
                    }
                    // OPS-120(承 OPS-118「安全不变量绝不该由装饰门决定去留」):下面剥图是**无条件**的,
                    // 但上面的「收到图但读不出」说明 buildVisionUnreadableNote 受 KHY_VISION_OCR_FALLBACK
                    // (OCR **功能门**)约束——用户关掉 OCR 兜底功能时它返 null → 说明缺席、图却照样被剥 →
                    // 文本模型收到无图无说明的裸 prompt → 谎称「消息里没有附带图片」(2026-07-12 用户实测)。
                    // 故:说明缺席时退回**不提 OCR 的最小诚实底线**(独立 default-on 门 KHY_VISION_STRIP_IMAGE_FLOOR,
                    // 与 OCR 功能门正交),保住「剥图 ⟹ 必留『图收到但读不出』痕迹」不变量。门关/叶子不可用 →
                    // 底线返 null → 逐字节回退历史行为(剥图无痕)。
                    if (!_unreadableNote) {
                      try {
                        _unreadableNote =
                          require('./visionOcrFallback').buildStrippedImageFloorNote({
                            count: _imgCount,
                            env: process.env,
                          });
                      } catch {
                        /* 叶子不可用 → 门关等价,逐字节回退(剥图无痕) */
                      }
                    }
                    if (_unreadableNote) {
                      prompt = `${prompt || ''}\n\n${_unreadableNote}`;
                      prompt = _appendVisionKeyOffer(prompt, _glmVisionOn, _glmKeyReady);
                    }
                    options = { ...options, images: undefined, _ocrFallbackApplied: true };
                  }
                  hasImageInput = false;
                  _describeDone = true; // 已优雅兜底,勿再落下方 switch 替换
                  if (_isVerbose) {
                    emitStatus(
                      `检测到图片输入：视觉模型 ${_primaryModel} 及全部备用候选均失败，已诚实说明并剥图/OCR 兜底,由原文本模型作答`
                    );
                  }
                }
              }
            }

            if (!_describeDone) {
              // 门关(describe-return / failure-summary)/ 叶子不可用 → 既有 switch-model 替换(逐字节回退)。
              const prevModel = options.model;
              options = { ...options, model: decision.model };
              if (decision.reason === 'switched_to_pinned_vision_model') {
                // 跨 pool 视觉兜底(KHY_VISION_FALLBACK_MODEL):钉选模型可能不在当前 pool
                // (如当前 SenseNova、兜底 relay/gpt-4o-mini)。_resolveApiPoolProviderForRequest
                // 优先用 options.apiPoolProvider/provider,会把请求钉回旧 pool 端点 → 404。
                // 故用钉选模型自带的 provider 前缀(decision.poolHint,纯叶子解析)覆盖 scope;
                // 无前缀(裸名,默认同 pool)→ 清空 scope,交下游按模型名/默认解析,绝不钉回旧 pool。
                options = {
                  ...options,
                  apiPoolProvider: pinnedPool || undefined,
                  provider: undefined,
                };
              }
              if (_isVerbose) {
                emitStatus(
                  `检测到图片输入：当前模型不支持视觉，已自动改选视觉模型 ${decision.model}（原 ${prevModel || '默认'}）`
                );
              }
            }
          } else if (decision.action === 'mcp-vision') {
            // MCP 视觉工具：通过 deepseek-eyes 等 MCP 服务器识图，将描述注入 prompt
            // 由当前纯文本模型作答。失败则退到同 provider 视觉兄弟模型，再失败才 OCR。
            const mcpServerName = decision.mcpServer || process.env.KHY_MCP_VISION_SERVER;
            let mcpVisionText = '';
            emitStatus(`[MCP] 图片识别中：${mcpServerName}…`);
            emitAssistantMessage(`🔍 MCP识图（${mcpServerName}）正在识别图片，请稍候…`);
            try {
              const mcpResult = await _callMcpVisionTool(mcpServerName, options.images);
              const _mcpErrors = Array.isArray(mcpResult.errors) ? mcpResult.errors : [];
              if (mcpResult.text && mcpResult.text.trim()) {
                mcpVisionText = mcpResult.text.trim();
                prompt = `${prompt || ''}\n\n[用户发送了图片（当前模型不支持直接看图，已由视觉模型识别为以下描述，请据此作答）]\n${mcpVisionText}`;
                options = {
                  ...options,
                  images: undefined,
                  _ocrFallbackApplied: true,
                  _mcpVisionApplied: true,
                  _mcpVisionText: mcpVisionText,
                };
                hasImageInput = false;
                emitStatus(`[MCP] ${mcpServerName} 识别完成 ✓`);
                emitAssistantMessage(
                  `✅ MCP识图（${mcpServerName}）已完成，正在根据识别结果作答。`
                );
              } else if (_mcpErrors.length) {
                const errSummary = _mcpErrors.join('；');
                emitStatus(
                  `[MCP] ${mcpServerName} 识别失败：${errSummary}。将尝试其他视觉模型或 OCR 兜底。`
                );
                // MCP 失败属于转场状态，不单独插入助手消息；后续视觉候选或 OCR
                // 路径会发出唯一的结果闭合，避免用户看到断裂的双重进度块。
              }
            } catch (mcpErr) {
              emitStatus(
                `[MCP] ${mcpServerName} 识别失败(${mcpErr.message})，尝试同 provider 视觉模型…`
              );
            }
            // MCP 无结果：先在同 provider 兄弟里找视觉模型；auto 模式下还会扫描
            // 所有 provider 找跨 provider 视觉模型（如 step-3.7-flash）。
            if (!mcpVisionText) {
              const {
                pickVisionCandidate,
                _candidateModelId,
                isVisionCapableModel,
              } = require('./visionCapability');
              let visionModel = null;
              let poolHint = null;

              // 1) 同 provider 兄弟
              const others = (Array.isArray(siblings) ? siblings : []).filter((c) => {
                const id = String(_candidateModelId(c) || '')
                  .trim()
                  .toLowerCase();
                return (
                  id &&
                  id !==
                    String(options.model || '')
                      .trim()
                      .toLowerCase()
                );
              });
              const picked = pickVisionCandidate(others, { env });
              if (picked) {
                visionModel = String(_candidateModelId(picked) || '').trim();
              }

              // 2) 同 provider 没有 → 看 KHY_VISION_FALLBACK_MODEL
              //    - 具体模型名（如 step-3.7-flash）：直接用
              //    - 'auto'：扫描所有 provider 的模型池，找第一个支持视觉的
              if (!visionModel) {
                const fallback = String(env.KHY_VISION_FALLBACK_MODEL || '')
                  .trim()
                  .toLowerCase();
                if (fallback === 'auto') {
                  // 扫描所有 provider 的模型池，排除当前模型
                  const currentLower = String(options.model || '')
                    .trim()
                    .toLowerCase();
                  try {
                    const registry = require('../customProviderRegistry');
                    const allProviders = registry.listProviders();
                    for (const provider of allProviders) {
                      const models = Array.isArray(provider.models) ? provider.models : [];
                      for (const m of models) {
                        const mLower = String(m || '')
                          .trim()
                          .toLowerCase();
                        if (!mLower || mLower === currentLower) {
                          continue;
                        }
                        if (isVisionCapableModel(m, { env })) {
                          visionModel = String(m).trim();
                          poolHint = String(provider.poolKey || '').trim() || null;
                          break;
                        }
                      }
                      if (visionModel) {
                        break;
                      }
                    }
                  } catch {
                    /* 叶子不可用 → 跳过 auto 扫描 */
                  }
                } else if (fallback) {
                  const fallbackLower = fallback.toLowerCase();
                  if (
                    fallbackLower !==
                    String(options.model || '')
                      .trim()
                      .toLowerCase()
                  ) {
                    visionModel = fallback;
                    poolHint = require('./visionRouting')._modelProviderPrefix(fallback);
                  }
                }
              }

              if (visionModel) {
                const _pinnedPool = poolHint ? _normalizeApiPoolProvider(poolHint) : null;
                let _describeReturnOn = false;
                try {
                  _describeReturnOn =
                    require('./visionDescribeReturn').isVisionDescribeReturnEnabled(process.env);
                } catch {
                  /* 门关 */
                }
                let _describeDone = false;
                if (_describeReturnOn) {
                  const vdr = require('./visionDescribeReturn');
                  const _pinApiAdapter =
                    typeof this._shouldPinApiAdapterForVisionDescribe === 'function'
                      ? this._shouldPinApiAdapterForVisionDescribe(_pinnedPool)
                      : false;
                  const _r = await this.generate(vdr.buildDescribePrompt(), {
                    model: visionModel,
                    images: options.images,
                    maxTokens: 2048,
                    apiPoolProvider: _pinnedPool || undefined,
                    provider: undefined,
                    preferredAdapter: _pinApiAdapter ? 'api' : 'auto',
                    strictPreferred: _pinApiAdapter ? true : false,
                    _visionDescribePass: true,
                  });
                  if (_r && _r.success && _r.content) {
                    const _injection = vdr.buildDescriptionInjection([String(_r.content)], {
                      model: visionModel,
                    });
                    if (_injection) {
                      prompt = `${prompt || ''}\n\n${_injection}`;
                      options = {
                        ...options,
                        images: undefined,
                        _ocrFallbackApplied: true,
                        _visionDescribePass: true,
                      };
                      hasImageInput = false;
                      _describeDone = true;
                      emitStatus(`视觉模型 ${visionModel} 描述图片完成（MCP 不可用回退）`);
                    }
                  }
                }
                if (!_describeDone) {
                  options = { ...options, model: visionModel };
                  if (_pinnedPool) {
                    options = { ...options, apiPoolProvider: _pinnedPool, provider: undefined };
                  }
                  const source = poolHint ? '跨 provider' : '同 provider';
                  emitStatus(`已改选视觉模型 ${visionModel}（MCP 不可用，${source}切换）`);
                }
              }
              // 同 provider 和跨 provider 都找不到 → 自然落到下方 OCR fallback
            }
          } else if (decision.action === 'ocr-fallback') {
            // OCR 提取**绝不能**把异常抛到本块外层 catch(visionErr) —— 那条 catch 会「保持
            // 当前通道」即把原图**留下**,于是无视觉能力的模型收到读不懂的图,如实却荒谬地回
            // 「我没有收到图片」(用户实测)。此处 decideVisionRouting 已判定当前 provider 无
            // 任何视觉模型,故无论 OCR 成败,图都**必须**被剥离:成功 → 注入 OCR 文本;失败/抛错
            // /无文本 → 注入诚实「收到图但读不出」说明并清图。把提取包进本地 try,抛错等价于「无
            // 文本」,保证「非视觉模型永不收到裸图」这一不变量。
            let ocrTexts = [];
            let ocrDetails = [];
            try {
              ocrDetails = extractImageOcrDetails(options.images, { maxImages: 3, maxChars: 1200 });
              ocrTexts = ocrDetails.map((d) => d.text);
            } catch {
              ocrDetails = [];
              ocrTexts = []; /* 抛错 → 当作无文本,落下方诚实清图路径,绝不外抛保图 */
            }
            if (ocrTexts.length > 0) {
              const ocrBlock = ocrTexts
                .map((t, i) => `【图片${i + 1} OCR 文本】\n${t}`)
                .join('\n\n');
              prompt = `${prompt || ''}\n\n[当前模型不支持视觉，以下为图片 OCR 识别文本，请据此作答]\n${ocrBlock}`;
              // 若 OCR 引擎自评置信偏低,追加诚实告诫(别把误识文字当铁定事实)。门关/无低置信 →
              // 逐字节回退。必须在 _appendVisionKeyOffer 之前:告诫紧随 OCR 文本块,邀约收尾。
              prompt = _appendOcrLowConfidenceCaveat(prompt, ocrDetails);
              // 覆盖率诚实:上述文本可能没覆盖全部图片(超上限被丢 / 部分读不出)→ 追加告诫,别让
              // 模型默认已看到所有图片。与置信度告诫正交。无缺口/门关 → 逐字节回退。
              prompt = _appendOcrCoverageNotice(prompt, {
                totalImages: Array.isArray(options.images) ? options.images.length : 0,
                ocrTextCount: ocrTexts.length,
                maxImages: 3,
              });
              // 单图内文本完整性诚实:某张稠密图 OCR 全文超上限被截断 → 追加告诫,别把残缺文本当
              // 完整依据。与置信度、覆盖率两条正交。无截断/门关 → 逐字节回退。
              prompt = _appendOcrTruncationNotice(prompt, ocrDetails);
              // 语言包可用性诚实:请求的 OCR 语言被本机缺包窄化 → 被丢弃语言的文字未能识别,追加告诫。
              // 与置信度、覆盖率、截断三条正交。无丢弃/门关 → 逐字节回退。
              prompt = _appendOcrLanguageNotice(prompt, ocrDetails);
              // 方向自动校正诚实(纠正型轴):侧拍/旋转图经 docHelper 旋正后才识别成功,告知模型文本
              // 取自旋正后的图。门 KHY_OCR_AUTO_ORIENT 关 → docHelper 不旋转 → 无数据 → 逐字节回退。
              prompt = _appendOcrOrientationNotice(prompt, ocrDetails);
              // 低分辨率自动放大诚实(第二条纠正型轴):过小/低分辨率图经 docHelper 放大后才识别成功,
              // 告知模型文本取自放大后的图。门 KHY_OCR_UPSCALE 关 → docHelper 不放大 → 无数据 → 回退。
              prompt = _appendOcrResolutionNotice(prompt, ocrDetails);
              // OCR 成功路径「使用 OCR 透明告知」(无条件):上面六条告诫都是条件型,干净成功时全静默,模型
              // 据 OCR 文本作答却从不告诉用户用了 OCR。本条要求模型无感但明显地向用户披露。门关回退。
              prompt = _appendOcrUsageDisclosure(prompt, { count: ocrTexts.length });
              // 顺带:若 GLM 视觉门控开、但用户尚未配置 GLM key(_glmVisionOn && !_glmKeyReady),
              // 追加一句面向模型的邀约,让模型在末尾主动问「要不要配 GLM 视觉 key 让我直接看图」——
              // 统一「透明视觉降级」三种出路。门控关/无缺失 → 叶子返 null,不注入,逐字节回退。
              prompt = _appendVisionKeyOffer(prompt, _glmVisionOn, _glmKeyReady);
              // 同时记下已识别文本:若随后调远端模型遇网络中断,finishResult 会用它给诚实降级
              // 兜底,而不是把离线已能识别的文字丢掉(KHY_OCR_TEXT_ON_NETFAIL)。
              options = {
                ...options,
                images: undefined,
                _ocrFallbackApplied: true,
                _ocrFallbackText: ocrBlock,
                _ocrImageTextRead: true,
                _ocrImageTextCount: ocrTexts.length,
              };
              hasImageInput = false;
              // OPS-MAN-132(承 OPS-127):把「已降级到 OCR」无条件实时状态从 Site3 扩到 prep 期 Site2。
              // 下方 emitStatus 仅 _isVerbose 时发 → 非 verbose 用户在 prep 期 OCR 降级时实时进度层沉默。
              // 此处仅 !_isVerbose 时补一条(verbose 用户已有既有状态,避免重复)。门 KHY_OCR_RESCUE_STATUS_PREP
              // 关 / 叶不可用 → 返 null 不 emit,逐字节回退历史「非 verbose prep 期静默」。
              if (!_isVerbose) {
                try {
                  const _prep = require('./ocrRescueStatusNotice').buildOcrRescuePrepStatus({
                    count: ocrTexts.length,
                    env: process.env,
                  });
                  if (_prep) {
                    emitStatus(_prep);
                  }
                } catch {
                  /* fail-soft:叶不可用则按历史静默 */
                }
              }
              if (_isVerbose) {
                emitStatus(
                  `检测到图片输入：无可用视觉模型，已用 OCR 提取 ${ocrTexts.length} 张图片文本兜底`
                );
              }
            } else {
              // OCR 也取不到文字(常见:非文字类图像如照片/场景,或缺对应语言字库)。
              // 原先这里静默保留无法识别的图、什么都不告诉模型 → 模型收到一条没有图也没有
              // 任何说明的纯文本消息,于是如实却荒谬地回「我没有收到可识别的图片」。改为如实
              // 注入提示(单一真源 visionOcrFallback.buildVisionUnreadableNote)让模型大方承认
              // 「收到图但读不出」并给方案,并清掉无法消费的图。此处 decideVisionRouting 已判定
              // 当前 provider 无任何视觉模型,故清图不会误伤下游视觉适配器。门控关 → note 为 null
              // → 走下方原 verbose 分支,行为字节回退。
              const _imgCount = Array.isArray(options.images) ? options.images.length : 0;
              let _unreadableNote = null;
              try {
                _unreadableNote = require('./visionOcrFallback').buildVisionUnreadableNote({
                  count: _imgCount,
                });
              } catch {
                /* 叶子不可用则保持原行为 */
              }
              if (_unreadableNote) {
                prompt = `${prompt || ''}\n\n${_unreadableNote}`;
                prompt = _appendVisionKeyOffer(prompt, _glmVisionOn, _glmKeyReady);
                options = { ...options, images: undefined, _ocrFallbackApplied: true };
                hasImageInput = false;
                if (_isVerbose) {
                  emitStatus(
                    '检测到图片输入：无可用视觉模型且 OCR 未提取到文本，已如实告知模型并清除无法识别的图片'
                  );
                }
              } else {
                // 主底线(buildVisionUnreadableNote)因功能门关闭或叶子不可用而返回 null,
                // 图片仍无条件剥离——但用 buildStrippedImageFloorNote 作为独立门控的兜底底线,
                // 保住「剥图 ⟹ 必留痕」安全不变量。只有 KHY_VISION_STRIP_IMAGE_FLOOR 也关闭
                // 时才逐字节回退(图留着但不注入任何痕迹)。
                let _floorNote = null;
                try {
                  _floorNote = require('./visionOcrFallback').buildStrippedImageFloorNote({
                    count: _imgCount,
                  });
                } catch {
                  /* 叶子不可用 → 逐字节回退 */
                }
                if (_floorNote) {
                  prompt = `${prompt || ''}\n\n${_floorNote}`;
                  prompt = _appendVisionKeyOffer(prompt, _glmVisionOn, _glmKeyReady);
                  options = { ...options, images: undefined, _ocrFallbackApplied: true };
                  hasImageInput = false;
                  if (_isVerbose) {
                    emitStatus(
                      '检测到图片输入：无可用视觉模型且 OCR 未提取到文本，已用最低底线告知模型并清除无法识别的图片'
                    );
                  }
                } else if (_isVerbose) {
                  emitStatus('检测到图片输入：无可用视觉模型且 OCR 未提取到文本，保持当前通道');
                }
              }
            }
          } else if (_isVerbose) {
            emitStatus('检测到图片输入：当前模型支持视觉，保持当前通道');
          }
        } catch (visionErr) {
          if (_isVerbose) {
            emitStatus(
              `检测到图片输入：视觉路由判定失败（${visionErr.message}），保持当前通道并按适配器兜底`
            );
          }
        }
      }
    } else if (hasImageInput && _isVerbose) {
      emitStatus('检测到图片输入：保持当前通道，按适配器能力自动处理并兜底');
    }
    if (_isVerbose && preferredAdapter && preferredAdapter !== 'auto') {
      emitStatus(`首选通道: ${preferredAdapter}`);
    }
    if (_isVerbose) {
      if (isSmallTask) {
        emitStatus('任务模式: 快速（小任务，优先低延迟）');
      } else if (isLargeTask) {
        emitStatus('任务模式: 稳态（大任务，优先稳定性）');
      }
    }

    // 当前尝试实际要送出的模型串(每轮 adapterOptions 构建后刷新)。供 model_not_found 冷却按模型
    // 放行(modelNotFoundCooldownScope)与失败记录归因(_recordAdapterFailure 的 meta.model)共用。
    let _currentAttemptModel = String(options.model || '').trim();

    const inspectCachedFastFail = async (adapterKey, adapterDisplayName) => {
      const cached = await this._getRecentFastFail(adapterKey);
      if (!cached) {
        return null;
      }
      // model_not_found 是**按模型**的错误(某模型名对本账号不可用/未开通),而 fast-fail 缓存按
      // adapter 键控。视觉 describe 级联会在同一 GLM 池内从主视觉模型(如 glm-4.6v-flash,部分账号
      // 未实名/未领取 → 官方端点回 404 model_not_found)有序降级到次选(glm-4v-flash,几乎恒可用)。
      // 若让主模型的 model_not_found 冷却挡住次选,同一次 describe 里第二个候选会被首个候选刚写下的
      // 冷却直接跳过 → 级联永远救不回,用户只见「recent model_not_found failure cached (cooldown …)」。
      // 修:describe 透传(_visionDescribePass,恒带显式候选 model)遇 model_not_found 冷却不跳过,
      // 让这个**不同的**显式模型获得真实尝试(见 _shouldBypassCooldownForVisionDescribe)。
      if (this._shouldBypassCooldownForVisionDescribe(options, cached)) {
        return null;
      }
      // model_not_found 冷却按模型放行(modelNotFoundCooldownScope):当前请求模型串 ≠ 造成 404 的
      // 模型串(如复合 id 剥成裸名后)→ 该冷却与本模型无关,放行做真实尝试,当轮即可救回。相同模型串
      // 仍尊重冷却(不硬撞确实不存在的模型)。门关 / 缺模型串 → 逐字节回退今日按通道冷却。绝不抛。
      try {
        const _mnfScope = require('./modelNotFoundCooldownScope');
        if (
          _mnfScope.shouldBypassModelNotFoundCooldown({
            cached,
            currentModel: _currentAttemptModel,
            env: process.env,
          })
        ) {
          return null;
        }
      } catch {
        /* 叶子不可用 → 今日行为 */
      }
      // server_error 冷却按池放行(serverErrorCooldownScope):当前尝试的池段 ≠ 造成上游 5xx 的
      // 池段(冷却记录 model 字段归因)→ 该冷却与本池无关,放行真实尝试,后备池当轮即可救回。
      // 同池仍尊重冷却(不硬撞确实 5xx 的端点)。门关 / 缺模型串 → 逐字节回退今日按通道冷却。绝不抛。
      try {
        const _seScope = require('./serverErrorCooldownScope');
        if (
          _seScope.shouldBypassServerErrorCooldown({
            cached,
            currentModel: _currentAttemptModel,
            env: process.env,
          })
        ) {
          return null;
        }
      } catch {
        /* 叶子不可用 → 今日行为 */
      }
      // unknown/network 一次放行:长空闲后的死 keep-alive 连接错误(socket hang up /
      // ECONNRESET)会被记成 unknown/network 失败,但换新连接即可恢复——用户的新消息
      // 不该被这类瞬时性失败的冷却短路直接落本地兜底。放行状态存在独立的
      // _fastFailProbeMeta(不被 _recordAdapterFailure 的失败覆写影响):每个冷却
      // 时长(cooldownMs)窗口内最多放行一次真实探测——即使持续断网下失败记录
      // 被反复覆写也不会突破该频率,避免真实外网重试风暴。判定与写入同步完成
      // (JS 单线程下 check+set 即原子):并发请求只有首个能通过,其余仍短路。
      // 熔断开启(circuitOpen)与 auth/permission/model_not_found 等确定性错误不放行。
      // 真实尝试成功后由既有成功路径 _clearAdapterFailure 清除失败缓存与探测 meta。
      try {
        const _cachedType = String(cached.errorType || '').toLowerCase();
        const _probeTypes = String(
          process.env.KHY_FAST_FAIL_PROBE_TYPES || 'unknown,network,timeout'
        )
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean);
        if (_probeTypes.includes(_cachedType) && cached.circuitOpen !== true) {
          this._fastFailProbeMeta = this._fastFailProbeMeta || {};
          const _meta =
            this._fastFailProbeMeta[adapterKey] ||
            (this._fastFailProbeMeta[adapterKey] = { lastProbeAt: 0 });
          // cooldownMs 缺失/非法时保守不放行(窗口为 0 会退化成每次都放行)。
          const _probeWindowMs = Number(cached.cooldownMs);
          if (
            Number.isFinite(_probeWindowMs) &&
            _probeWindowMs > 0 &&
            Date.now() - (_meta.lastProbeAt || 0) >= _probeWindowMs
          ) {
            _meta.lastProbeAt = Date.now(); // 同步写入,封死同窗口并发放行
            emitStatus(
              `${adapterDisplayName} 冷却期内放行一次真实尝试（${_cachedType} 类失败可能来自已断开的空闲连接，每冷却窗口仅探测1次）`
            );
            return null;
          }
        }
      } catch {
        /* 放行判定绝不阻断原有短路路径 */
      }
      this._maybeScheduleCooldownSelfHealProbe(adapterKey, cached, {
        emitStatus,
        adapterDisplayName,
        source: 'generate_skip',
      });
      if (cached.remainingMs > 0) {
        emitStatus(
          `${adapterDisplayName} 重试中（等待冷却窗口，约 ${Math.max(1, Math.ceil(cached.remainingMs / 1000))}s）`
        );
      }
      const cooldownSuffix =
        cached.remainingMs > 0
          ? ` (cooldown ${Math.max(1, Math.ceil(cached.remainingMs / 1000))}s)`
          : '';
      const cachedMsg = `recent ${cached.errorType} failure cached: ${cached.error}${cooldownSuffix}`;
      emitStatus(`跳过不稳定通道 ${adapterDisplayName}: ${cachedMsg}`);
      return {
        error: cachedMsg,
        rawError: cached.error,
        errorType: cached.errorType || 'unknown',
      };
    };

    if (strictPreferredOnly && preferredAdapter && preferredAdapter !== 'auto') {
      const preferredEntry = orderedAdapters.find((a) => a.key === preferredAdapter);
      if (!preferredEntry) {
        const missingMsg = `preferred adapter "${preferredAdapter}" is not registered`;
        allAttempts.push({
          provider: preferredAdapter,
          adapterKey: preferredAdapter,
          success: false,
          error: missingMsg,
          statusCode: 0,
          errorType: 'unavailable',
        });
        return finishResult(
          {
            success: false,
            content: _prependFailureReason(
              buildPreferredAdapterRecoveryHint(preferredAdapter, missingMsg),
              allAttempts,
              4
            ),
            provider: 'none',
            adapter: 'none',
            preferredAdapter,
            actualAdapter: firstTriedAdapter,
            fallbackReason: missingMsg,
            attempts: allAttempts,
            errorType: 'unavailable',
          },
          { error: missingMsg }
        );
      }
      if (!preferredEntry.enabled) {
        const disabledMsg = `${preferredAdapter} disabled by configuration`;
        allAttempts.push({
          provider: preferredEntry.adapter.getStatus().name,
          adapterKey: preferredAdapter,
          success: false,
          error: disabledMsg,
          statusCode: 0,
          errorType: 'unavailable',
        });
        return finishResult(
          {
            success: false,
            content: _prependFailureReason(
              buildPreferredAdapterRecoveryHint(preferredAdapter, disabledMsg),
              allAttempts,
              4
            ),
            provider: 'none',
            adapter: 'none',
            preferredAdapter,
            actualAdapter: firstTriedAdapter,
            fallbackReason: disabledMsg,
            attempts: allAttempts,
            errorType: 'unavailable',
          },
          { error: disabledMsg }
        );
      }
    }

    // 每次失败记录都带上「本次请求是否带附件」:带附件且失败属于「上游读不了该附件」的
    // 模型拒绝/不支持格式类时,_recordAdapterFailure 会判其为载荷级失败,不毒化整条通道
    // (否则一个坏文件会让后续连纯文本请求都被熔断 fast-fail)。用 live hasImageInput——
    // 图像 OCR 降级后它已被置 false,届时不再算带附件,正确。
    const _recordAdapterFailureWithAttachment = (key, type, msg, m = null) =>
      this._recordAdapterFailure(key, type, msg, {
        ...(m || {}),
        model: (m && m.model != null && String(m.model).trim()) || _currentAttemptModel,
        attachmentPresent:
          hasImageInput || (Array.isArray(options.documents) && options.documents.length > 0),
      });

    // 用 index 循环代替 for-of，以支持 strict 放宽后从头重试更高优先级适配器。
    // 外层 cascadeLoop 包裹整轮级联:网络抖动使整轮耗尽且全为瞬态失败时,退避等待后清除
    // 相关通道的瞬态冷却并重跑整轮(上限 cascadeJitterRetryRounds),实现「自愈几轮」。
    let _triedAdapters = new Set();
    let _adapterIdx = 0;
    cascadeLoop: while (true) {
      if (process.env.KHY_DEBUG_TOOLS === '1') {
        console.error(
          `[DEBUG-ADAPTER] cascadeLoop START ordered=${orderedAdapters.map((a) => a.key).join(',')}`
        );
      }
      for (; _adapterIdx < orderedAdapters.length; _adapterIdx++) {
        // strict 放宽后从头遍历，让 Kiro 等高优先级适配器也有机会兜底
        if (_relaxRestart) {
          _relaxRestart = false;
          // 从头重走限次:杜绝 strict 反复放宽导致的无限从头重启(1437 次膨胀的元凶之一)。
          _relaxRestartCount += 1;
          try {
            const { resolveMaxTotalAttempts } = require('./_gatewayHardDeadline');
            const cap = resolveMaxTotalAttempts(process.env);
            const restartCap = Number.isFinite(cap)
              ? Math.max(1, Math.min(4, Math.floor(cap / 12)))
              : Infinity;
            if (_relaxRestartCount > restartCap) {
              emitStatus(`级联从头重启已达上限(${restartCap})，停止重走`);
              break;
            }
          } catch {
            /* 判定失败 → 不额外限制(今日行为) */
          }
          _adapterIdx = -1; // for 的 _adapterIdx++ 会使其变为 0
          continue;
        }
        const entry = orderedAdapters[_adapterIdx];
        // 硬死线命中:返回 timeout 结构化结果(先于通用 cancelled 分支识别真实原因)。
        if (
          gatewayAbort.signal.aborted &&
          /hard timeout/i.test(normalizeAbortReason(gatewayAbort.signal.reason || ''))
        ) {
          const hardReason = normalizeAbortReason(gatewayAbort.signal.reason);
          emitStatus(`网关硬超时，终止级联(${hardReason})`);
          return finishResult(
            {
              success: false,
              content: `请求超时: 已达网关硬超时上限(${hardReason})`,
              provider: 'none',
              adapter: 'none',
              attempts: [],
              errorType: 'timeout',
            },
            { error: hardReason }
          );
        }
        // 级联总次数封顶:跨所有重试维度的聚合上限,兜住病态 churn(门控关 → 不封顶,今日行为)。
        try {
          const { shouldStopForAttemptCap } = require('./_gatewayHardDeadline');
          if (shouldStopForAttemptCap(_totalAdapterAttempts, process.env)) {
            emitStatus(`级联尝试已达总次数上限(${_totalAdapterAttempts})，终止本次请求`);
            return finishResult(
              {
                success: false,
                content: `请求超时: 网关级联尝试已达总次数上限(${_totalAdapterAttempts})`,
                provider: 'none',
                adapter: 'none',
                attempts: [],
                errorType: 'timeout',
              },
              { error: `gateway attempt cap (${_totalAdapterAttempts})` }
            );
          }
        } catch {
          /* 判定失败 → 不封顶(今日行为) */
        }
        // Gateway idle watchdog: only terminates when the full chain stops making progress.
        // 必须先于下方的通用 abort 分支判定，否则空闲保护的专项提示永远不可达。
        if (
          gatewayAbort.signal.aborted &&
          /gateway idle timeout/i.test(normalizeAbortReason(gatewayAbort.signal.reason || ''))
        ) {
          const idleReason = normalizeAbortReason(gatewayAbort.signal.reason);
          emitStatus(`网关链路空闲保护触发(${idleReason})，终止级联`);
          return finishResult(
            {
              success: false,
              content: `请求超时: 网关链路空闲保护触发（${idleReason}）`,
              provider: 'none',
              adapter: 'none',
              attempts: [],
              errorType: 'timeout',
            },
            { error: idleReason }
          );
        }
        if (gatewayAbort.signal.aborted) {
          return finishResult(
            buildCancelledResult(
              normalizeAbortReason(gatewayAbort.signal.reason || getAbortReason())
            ),
            {
              error: `Cancelled: ${normalizeAbortReason(gatewayAbort.signal.reason || getAbortReason())}`,
            }
          );
        }
        if (strictPreferredOnly && entry.key !== preferredAdapter) {
          continue;
        }
        if (_triedAdapters.has(entry.key)) {
          continue;
        }
        if (!entry.enabled) {
          continue;
        }
        if (!firstTriedAdapter) {
          firstTriedAdapter = entry.key;
        }
        _triedAdapters.add(entry.key);
        _totalAdapterAttempts += 1; // 计入级联总次数封顶
        // Reset the shrink-priority floor when entering a NEW adapter: a
        // context-overflow shrink is specific to the adapter/model that
        // overflowed, so the floor must only constrain in-place retries of that
        // same adapter. Carrying it across the cascade would pollute later
        // adapters' preflight maxTokens resolution. contextOverflowAdjusted
        // intentionally stays request-level (at most 1 adjustment per request).
        _maxTokensShrunkTo = 0;
        const adapterDisplayName = entry.adapter.getStatus().name;
        if (process.env.KHY_DEBUG_TOOLS === '1') {
          console.error(
            `[DEBUG-ADAPTER] cascade: key=${entry.key} name=${adapterDisplayName} available=${entry.available}`
          );
        }
        // 自动切换透明化(AGENTS 规则 2:动作+目标+进度):上一个通道失败后切到下一个
        // 通道时,无条件向用户说明原通道、失败原因、新通道与级联进度,而非静默换道。
        {
          const _prevAttempt = allAttempts.length > 0 ? allAttempts[allAttempts.length - 1] : null;
          if (_prevAttempt && _prevAttempt.success === false) {
            const _prevWhy = String(_prevAttempt.error || _prevAttempt.errorType || 'unknown')
              .replace(/\s+/g, ' ')
              .slice(0, 120);
            emitStatus(
              `通道 ${_prevAttempt.provider} 不可用（${_prevWhy}），已切换到 ${adapterDisplayName}，第 ${_triedAdapters.size}/${orderedAdapters.length} 个适配器`
            );
          }
        }
        if (_isVerbose) {
          emitStatus(`尝试通道: ${adapterDisplayName}`);
        }
        // 人肉中转(relay/clipboard)需人在场复制粘贴,绝不作为自动兜底;仅用户显式指定时放行。
        // 跳过后让本地模式(ollama/localLLM)成为真正的自动终端兜底;云端+本地都不可用时走末尾
        // 失败引导而非静默进入 5 分钟等人的剪贴板循环。门控 KHY_MANUAL_RELAY_NO_AUTO_FALLBACK(默认开)。
        if (
          this._isManualFallbackOnlyKey(entry.key) &&
          shouldSkipManualRelayInAutoCascade(
            {
              isManualFallbackOnly: true,
              adapterKey: entry.key,
              preferredAdapter,
              forceAdapter: options.forceAdapter,
            },
            process.env
          )
        ) {
          emitStatus(`${adapterDisplayName} 需人工复制粘贴，自动级联跳过(如需请显式选择该通道)`);
          allAttempts.push({
            provider: adapterDisplayName,
            adapterKey: entry.key,
            success: false,
            error: `${adapterDisplayName} skipped: manual relay is not an automatic fallback`,
            statusCode: 0,
            errorType: 'manual_fallback_skipped',
            virtualSkip: true,
          });
          continue;
        }
        const allowOllamaOnDemand = entry.key === 'ollama' && preferredAdapter === 'ollama';
        // ── 级联模型作用域(KHY_CASCADE_MODEL_SCOPE,默认开)──────────────────
        // 回落到**非首选**通道时,不把只属于首选通道的模型名递过去(它对该通道多半不存在
        // → 必然 404 → 重试才答出话,白付一个往返)。丢弃 = null = 用该通道自有默认模型,
        // 与 normalizeModelForAdapter 的既定丢弃语义一致。门关则恒携带,逐字节回退今日行为。
        // 与下方既有的 `preferredAdapter === 'ollama' → null` 同源——那是本规则的单通道特例。
        let _carryPreferredModel = true;
        try {
          const _scope = require('./cascadeModelScope');
          _carryPreferredModel =
            !_scope.isEnabled(process.env) ||
            _scope.shouldCarryPreferredModel(entry.key, preferredAdapter);
        } catch {
          /* 叶子不可用 → 维持今日行为 */
        }
        const adapterOptions = {
          ...options,
          _khyVisibleUserStream: !!originalOnChunk,
          model:
            allowOllamaOnDemand || entry.key === 'ollama'
              ? normalizeModelForAdapter(entry.key, options.model)
              : preferredAdapter === 'ollama' || !_carryPreferredModel
                ? null
                : normalizeModelForAdapter(entry.key, options.model),
        };
        // ── Preflight dynamic max_tokens resolution (KHY_MAX_TOKENS_AUTO_RESOLVE,
        // default on) ── derive a safe completion budget from known model metadata
        // (context window cache + model output limit cache + prompt estimate)
        // instead of leaving small adapter fallbacks (e.g. 1024) to truncate the
        // answer. Only injects when the policy resolves a concrete value; unknown
        // metadata → abstain, adapter fallbacks stay authoritative (fail-soft).
        if (_isFlagEnabled('KHY_MAX_TOKENS_AUTO_RESOLVE', process.env)) {
          try {
            const _policy = require('./maxTokensPolicy');
            const { estimateTokens: _estTokens } = require('../tokenPricing');
            const _pfModel = String(adapterOptions.model || options.model || '').trim();
            let _pfPromptTokens =
              _estTokens(String(prompt || '')) + _estTokens(String(options.system || ''));
            if (Array.isArray(options.messages)) {
              for (const _m of options.messages) {
                const _c = _m && _m.content;
                _pfPromptTokens += _estTokens(
                  typeof _c === 'string' ? _c : JSON.stringify(_c || '')
                );
              }
            }
            const _pfDecision = _policy.resolveMaxTokens({
              explicitMaxTokens: options.maxTokens,
              promptTokenEstimate: _pfPromptTokens,
              contextWindow: _pfModel ? this.getModelContextWindow(_pfModel) : 0,
              maxOutputTokens:
                _pfModel && typeof this.getModelMaxOutputTokens === 'function'
                  ? this.getModelMaxOutputTokens(_pfModel)
                  : 0,
              safetyBuffer: _resolveNumeric('KHY_CONTEXT_SAFETY_BUFFER_TOKENS', process.env),
              minCompletion: _resolveNumeric('KHY_CONTEXT_MIN_COMPLETION_TOKENS', process.env),
              defaultFallback: _resolveNumeric('KHY_DEFAULT_MAX_TOKENS', process.env),
              reason: 'preflight',
            });
            if (_pfDecision && _pfDecision.maxTokens != null) {
              // Shrink-priority: after an in-request overflow shrink, never raise
              // maxTokens above the shrunk value again (shrink beats preflight).
              const _pfMax =
                _maxTokensShrunkTo > 0
                  ? Math.min(_pfDecision.maxTokens, _maxTokensShrunkTo)
                  : _pfDecision.maxTokens;
              adapterOptions.maxTokens = _pfMax;
              adapterOptions._maxTokensPolicy = {
                source: _pfDecision.source,
                preflightMax: _pfMax,
                shrunk: _maxTokensShrunkTo > 0,
              };
            }
          } catch {
            /* fail-soft: keep caller-supplied / adapter fallback maxTokens */
          }
        }
        // 刷新本轮实际送出的模型串(捕获复合 id 是否被剥:strip 关时此处即复合串,是 404 的真凶),
        // 供 model_not_found 冷却按模型放行与失败记录归因共用。
        _currentAttemptModel = String(adapterOptions.model || options.model || '').trim();
        const languageRecoveryState = {
          prompt,
          retriesUsed: 0,
          maxRetries: _resolveCodexChineseRecoveryRetryBudget(entry.key, prompt, adapterOptions),
        };

        // Re-check availability for api adapter (keys might have changed)
        if (entry.key === 'api') {
          entry.available = entry.adapter.detect();
        }

        if (
          !entry.available &&
          entry.key !== 'relay' &&
          !allowOllamaOnDemand &&
          !options.forceAdapter
        ) {
          emitStatus(`${adapterDisplayName} 不可用，跳过`);
          allAttempts.push({
            provider: adapterDisplayName,
            adapterKey: entry.key,
            success: false,
            error: `${adapterDisplayName} unavailable`,
            statusCode: 0,
            errorType: 'unavailable',
          });
          if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
            failedPreferredReason = `${preferredAdapter} unavailable`;
          }
          if (_maybeRelaxEnvPinnedUnavailable(entry.key, '不可用')) {
            continue;
          }
          if (strictPreferredOnly && entry.key === preferredAdapter) {
            const baseContent = [
              `已选择模型通道不可用: ${preferredAdapter}。`,
              '',
              '建议下一步:',
              '  1) 运行 `khy gateway status` 查看各通道实测状态',
              '  2) 运行 `khy gateway model` 仅选择”可执行”模型',
              '  3) 若仍失败，检查登录状态或网络',
              `  4) 运行 \`khy gateway reconnect ${preferredAdapter}\` 强制重新连接`,
            ].join('\n');
            return finishResult(
              {
                success: false,
                content: _prependFailureReason(baseContent, allAttempts, 6),
                provider: 'none',
                adapter: 'none',
                preferredAdapter,
                actualAdapter: firstTriedAdapter,
                fallbackReason:
                  failedPreferredReason || `preferred adapter ${preferredAdapter} unavailable`,
                attempts: allAttempts,
                errorType: 'unavailable',
              },
              {
                error: failedPreferredReason || `preferred adapter ${preferredAdapter} unavailable`,
              }
            );
          }
          continue;
        }

        const recentFailInfo = await inspectCachedFastFail(entry.key, adapterDisplayName);
        if (recentFailInfo) {
          allAttempts.push({
            provider: adapterDisplayName,
            adapterKey: entry.key,
            success: false,
            error: recentFailInfo.error,
            statusCode: 0,
            errorType: recentFailInfo.errorType,
            virtualSkip: true,
          });
          if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
            failedPreferredReason = recentFailInfo.rawError || recentFailInfo.error;
          }
          if (_maybeRelaxEnvPinnedUnavailable(entry.key, '处于失败冷却')) {
            continue;
          }
          if (strictPreferredOnly && entry.key === preferredAdapter) {
            // 限流终局 OCR 兜底:用户钉选的视觉通道正处于瞬态冷却(如 429),此刻重试无意义,
            // 但手里握着图 → 先退回本地 OCR 把图中文字读出来诚实作答,而非甩缓存的冷却消息。
            if (hasImageInput && Array.isArray(options.images) && options.images.length) {
              const _ocrRescued = tryRateLimitOcrRescue({
                images: options.images,
                prompt,
                errorType: recentFailInfo.errorType,
                finishResult,
                allAttempts,
                emitStatus,
                env: process.env,
              });
              if (_ocrRescued) {
                return _ocrRescued;
              }
            }
            return finishResult(
              {
                success: false,
                content: _prependFailureReason(
                  buildPreferredAdapterRecoveryHint(
                    preferredAdapter,
                    recentFailInfo.rawError || recentFailInfo.error,
                    recentFailInfo.errorType,
                    undefined,
                    hasImageInput
                  ),
                  allAttempts,
                  6
                ),
                provider: 'none',
                adapter: 'none',
                preferredAdapter,
                actualAdapter: firstTriedAdapter,
                fallbackReason:
                  failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                attempts: allAttempts,
                errorType: recentFailInfo.errorType || 'unavailable',
              },
              { error: failedPreferredReason || `preferred adapter ${preferredAdapter} failed` }
            );
          }
          continue;
        }

        // If user preferred adapter is unavailable/unstable, fail over quickly.
        // Skip anti-ban delay on non-preferred adapters during this failover window.
        const skipRateLimit = !!(
          preferredAdapter &&
          failedPreferredReason &&
          entry.key !== preferredAdapter
        );
        const defaultTimeoutByAdapter = {
          claude: 300000,
          codex: 180000,
          cli: 300000,
          localLLM: 120000,
          ollama: 180000,
        };
        let fallbackTimeout = defaultTimeoutByAdapter[entry.key] || 60000;
        if (isSmallTask) {
          const codexSmallTaskCap = _parseMs(
            process.env.GATEWAY_CODEX_SMALL_TASK_TIMEOUT_MS || '120000',
            120000,
            30000
          );
          const defaultGeneralSmallTaskCap = _parseMs(
            process.env.GATEWAY_GENERAL_SMALL_TASK_TIMEOUT_MS ||
              process.env.KHY_GENERAL_SMALL_TASK_TIMEOUT_MS ||
              '120000',
            120000,
            30000
          );
          const claudeSmallTaskCap = _parseMs(
            process.env.GATEWAY_CLAUDE_SMALL_TASK_TIMEOUT_MS ||
              process.env.KHY_CLAUDE_SMALL_TASK_TIMEOUT_MS ||
              '90000',
            90000,
            10000
          );
          const cliSmallTaskCap = _parseMs(
            process.env.GATEWAY_CLI_SMALL_TASK_TIMEOUT_MS || String(defaultGeneralSmallTaskCap),
            defaultGeneralSmallTaskCap,
            30000
          );
          const imageSmallTaskCap = _parseMs(
            process.env.GATEWAY_IMAGE_SMALL_TASK_TIMEOUT_MS ||
              process.env.KHY_IMAGE_SMALL_TASK_TIMEOUT_MS ||
              '120000',
            120000,
            30000
          );
          const localLlmSmallTaskCap = _parseMs(
            process.env.GATEWAY_LOCAL_LLM_SMALL_TASK_TIMEOUT_MS || '90000',
            90000,
            30000
          );
          const ollamaSmallTaskCap = _parseMs(
            process.env.GATEWAY_OLLAMA_SMALL_TASK_TIMEOUT_MS || '180000',
            180000,
            30000
          );
          // 通用兜底小任务上限(I1 修复:此前是**唯一**没有 env 覆盖、且最紧的裸 30000)。
          // relay/api/gemini/glm 等通道(最常见运行路径)的小任务(prompt ≤220 字符,如交互式
          // 短问 / /goal 单轮)全落这里,模型思考 >30s 即被 adapter 超时中断——而其余分支底线全 ≥90s。
          // 门 KHY_GENERIC_SMALL_TASK_RELAX(默认开)开 → 抬到 90s 且可经 env 覆盖;门关 → 裸 30000 字节等价。
          const _relaxOff = new Set(['0', 'false', 'off', 'no']);
          const genericRelaxOn = !_relaxOff.has(
            String(process.env.KHY_GENERIC_SMALL_TASK_RELAX || '')
              .trim()
              .toLowerCase()
          );
          const genericSmallTaskCap = genericRelaxOn
            ? _parseMs(process.env.GATEWAY_GENERIC_SMALL_TASK_TIMEOUT_MS || '90000', 90000, 30000)
            : 30000;
          let fastCap =
            entry.key === 'localLLM'
              ? localLlmSmallTaskCap
              : entry.key === 'ollama'
                ? ollamaSmallTaskCap
                : entry.key === 'codex'
                  ? codexSmallTaskCap
                  : entry.key === 'claude'
                    ? claudeSmallTaskCap
                    : entry.key === 'cli'
                      ? cliSmallTaskCap
                      : genericSmallTaskCap;

          // Image + execution tasks frequently exceed the generic 30s "small task"
          // cap (e.g. model reasoning + file writes). Relax timeout to avoid false
          // adapter timeout failures in these flows.
          if (hasImageInput) {
            if (entry.key === 'codex') {
              fastCap = Math.max(fastCap, imageSmallTaskCap);
            } else if (entry.key === 'localLLM' || entry.key === 'ollama') {
              fastCap = Math.max(fastCap, 120000);
            } else {
              fastCap = Math.max(fastCap, imageSmallTaskCap);
            }
          }
          fallbackTimeout = Math.min(fallbackTimeout, fastCap);
        } else if (isLargeTask) {
          const largeTaskFloor = _parseMs(
            process.env.GATEWAY_LARGE_TASK_ADAPTER_TIMEOUT_MS ||
              process.env.KHY_AI_REQUEST_TIMEOUT_LARGE_MS ||
              '900000',
            900000,
            90000
          );
          const steadyFloor =
            entry.key === 'localLLM' || entry.key === 'ollama'
              ? Math.max(240000, largeTaskFloor)
              : Math.max(90000, largeTaskFloor);
          fallbackTimeout = Math.max(fallbackTimeout, steadyFloor);
        }
        const PER_ADAPTER_TIMEOUT_MS = this._resolveAdapterTimeoutMs(entry.key, fallbackTimeout);
        const recordFailureEarly = async (rawResult) => {
          if (!rawResult || rawResult.success !== false) {
            return;
          }
          const sc = rawResult.statusCode || 0;
          const errType = rawResult.errorType || classifyError(sc, rawResult.error);
          await _recordAdapterFailureWithAttachment(
            entry.key,
            errType,
            rawResult.error || 'unknown'
          );
        };
        const recordThrownFailureEarly = async (err, abortSignal = null) => {
          if (!err) {
            return;
          }
          const sc = err.status || err.statusCode || err.response?.status || 0;
          let errorType = classifyError(sc, err.message);
          let errorMessage = err.message || 'unknown';
          if (abortSignal && abortSignal.aborted) {
            const abortReason = normalizeAbortReason(abortSignal.reason);
            // Anti-jitter: a language-mismatch abort is an INTENTIONAL internal correction
            // (the chunk gate aborted the attempt to re-issue it with a Chinese-recovery prompt),
            // NOT a channel fault. Recording it as a failure poisons the channel with a cooldown,
            // which then fast-fails the very recovery retry it is supposed to enable. Skip recording
            // entirely — the dedicated language-recovery path (resolveAttemptLanguageMismatch) owns it.
            if (
              /language mismatch/i.test(abortReason) ||
              /language mismatch/i.test(String(errorMessage))
            ) {
              return;
            }
            if (/idle timeout/i.test(abortReason)) {
              // When gateway-side idle timeout actively aborts the adapter process,
              // downstream bridges may surface a generic "canceled". Keep it as timeout.
              errorType = 'timeout';
              if (!errorMessage || /\bcancel(?:ed|led)\b/i.test(String(errorMessage))) {
                errorMessage = abortReason;
              }
            }
          }
          await _recordAdapterFailureWithAttachment(entry.key, errorType, errorMessage);
        };

        // API Key Pool integration: for relay/api adapters, try multiple keys
        let poolProvider = null;
        try {
          const pool = require('../apiKeyPool');
          pool.init();
          // Map adapter key to pool provider
          if (entry.key === 'relay_api' || entry.key === 'relay') {
            poolProvider = 'relay';
          } else if (entry.key === 'api') {
            // 默认模型兜底：无显式模型、无显式 pool/provider 提示、且 habit 偏好未注入（健康
            // 评估软降权/无习惯数据）时，消费用户在 model_overrides.json 为 api 适配器设定的
            // defaultModel。此前该配置仅用于 UI 列表 isDefault 标注、运行时无人消费 → 空 model
            // 解析不出 pool → 无 key 直连必「All providers failed」并污染 fast-fail 冷却缓存。
            // 调用方已显式指定 apiPoolProvider/provider 时不介入（那走池默认模型路径）。零硬
            // 编码：值全部来自用户配置文件；fail-soft：读取异常/未配置 → 保持原空 model 行为。
            if (
              !String(adapterOptions.model || '').trim() &&
              !String(adapterOptions.apiPoolProvider || '').trim() &&
              !String(adapterOptions.provider || '').trim()
            ) {
              try {
                const curated = require('./modelCuration').getAdapterOverride('api');
                const curatedDefault = String((curated && curated.defaultModel) || '').trim();
                if (curatedDefault) {
                  adapterOptions.model = curatedDefault;
                }
              } catch {
                /* 配置不可用 → 保持原行为 */
              }
            }
            poolProvider = _resolveApiPoolProviderForRequest(adapterOptions);
          }
          if (poolProvider) {
            // Determine pool providers to try: primary + fallbacks (if configured via GATEWAY_API_POOL_FALLBACK)
            // Format: "primary:fallback1,primary:fallback2" or "primary:fallback1,other:fallback2"
            const poolProvidersToTry = [poolProvider];
            try {
              const fallbackRaw = String(process.env.GATEWAY_API_POOL_FALLBACK || '').trim();
              if (fallbackRaw) {
                const entries = fallbackRaw
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                for (const fbEntry of entries) {
                  const parts = fbEntry
                    .split(':')
                    .map((s) => s.trim())
                    .filter(Boolean);
                  if (parts.length >= 2 && parts[0] === poolProvider) {
                    for (let fi = 1; fi < parts.length; fi++) {
                      if (parts[fi] && !poolProvidersToTry.includes(parts[fi])) {
                        poolProvidersToTry.push(parts[fi]);
                      }
                    }
                  }
                }
              }
            } catch {
              /* ignore fallback parse errors */
            }
            // Try each pool provider in order (primary first, then fallbacks)
            for (let pIdx = 0; pIdx < poolProvidersToTry.length; pIdx++) {
              poolProvider = poolProvidersToTry[pIdx];
              if (!pool.hasAvailableKeys(poolProvider)) {
                continue;
              }
              // 回退到后备 provider 时，自动切换模型为后备 provider 的默认模型
              if (pIdx > 0) {
                const fbDefaultModel = _defaultModelForApiPoolProvider(poolProvider);
                if (fbDefaultModel) {
                  adapterOptions.model = `api:${poolProvider}:${fbDefaultModel}`;
                  // 刷新本轮模型串:冷却按池放行与失败归因需据此识别已切到后备池,
                  // 否则仍拿着主池模型串比对 → 同池判定 → 后备池被主池冷却 virtualSkip。
                  _currentAttemptModel = String(adapterOptions.model || '').trim();
                }
              }
              // Pool-based multi-key retry loop
              const maxPoolRetries = Math.max(
                1,
                parseInt(process.env.GATEWAY_POOL_MAX_RETRIES || '5', 10) || 5
              );
              const poolStrategy = keySelector.resolveStrategy(poolProvider);
              const attemptedPoolKeyIds = new Set();
              const slots = require('../concurrencySlots');
              for (let pi = 0; pi < maxPoolRetries; pi++) {
                let candidates =
                  typeof pool.listAvailableKeys === 'function'
                    ? pool.listAvailableKeys(poolProvider)
                    : [];
                if (candidates.length === 0) {
                  break;
                }

                const freshCandidates = candidates.filter((c) => !attemptedPoolKeyIds.has(c.keyId));
                if (freshCandidates.length > 0) {
                  candidates = freshCandidates;
                }

                const selected = keySelector.selectCandidate(candidates, {
                  provider: poolProvider,
                  strategy: poolStrategy,
                });
                if (!selected) {
                  break;
                }
                attemptedPoolKeyIds.add(selected.keyId);

                const picked =
                  typeof pool.pickById === 'function'
                    ? pool.pickById(poolProvider, selected.keyId)
                    : pool.pick(poolProvider);
                if (!picked) {
                  continue;
                }

                // Acquire concurrency slot
                const releaseSlot = slots.acquire(picked.keyId);

                try {
                  const apiServiceProvider =
                    entry.key === 'api' ? _mapApiPoolProviderToServiceProvider(poolProvider) : null;
                  const apiDefaultModel =
                    entry.key === 'api' ? _defaultModelForApiPoolProvider(poolProvider) : null;
                  const cachedFastFail = await inspectCachedFastFail(entry.key, adapterDisplayName);
                  if (cachedFastFail) {
                    allAttempts.push({
                      provider: adapterDisplayName,
                      adapterKey: entry.key,
                      success: false,
                      error: cachedFastFail.error,
                      statusCode: 0,
                      errorType: cachedFastFail.errorType,
                      virtualSkip: true,
                    });
                    if (
                      preferredAdapter &&
                      entry.key === preferredAdapter &&
                      !failedPreferredReason
                    ) {
                      failedPreferredReason = cachedFastFail.rawError || cachedFastFail.error;
                    }
                    if (strictPreferredOnly && entry.key === preferredAdapter) {
                      return finishResult(
                        {
                          success: false,
                          content: _prependFailureReason(
                            buildPreferredAdapterRecoveryHint(
                              preferredAdapter,
                              cachedFastFail.rawError || cachedFastFail.error,
                              cachedFastFail.errorType,
                              undefined,
                              hasImageInput
                            ),
                            allAttempts,
                            6
                          ),
                          provider: 'none',
                          adapter: 'none',
                          preferredAdapter,
                          actualAdapter: firstTriedAdapter,
                          fallbackReason:
                            failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                          attempts: allAttempts,
                          errorType: cachedFastFail.errorType || 'unavailable',
                        },
                        {
                          error:
                            failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                        }
                      );
                    }
                    continue;
                  }
                  throwIfCancelled();
                  const attemptBudgetExceeded = reserveAttemptBudget();
                  if (attemptBudgetExceeded) {
                    return attemptBudgetExceeded;
                  }
                  if (!skipRateLimit) {
                    await this._enforceRateLimit(entry.key, {
                      onWait: options.onWait,
                      fastInteractive: fastInteractiveRateLimit,
                      attemptIndex: pi,
                    });
                  }
                  throwIfCancelled();

                  const attemptAbort = createLinkedAbortController(gatewayAbort.signal);
                  let idleTimeout = null;
                  let result;
                  let stopPulse = () => {};
                  try {
                    idleTimeout = createAdapterIdleTimeout(
                      entry.key,
                      PER_ADAPTER_TIMEOUT_MS,
                      attemptAbort
                    );
                    languageTracker = _createKhyLanguageConsistencyTracker(
                      entry,
                      adapterOptions,
                      languageRecoveryState.prompt
                    );
                    const touchActivity = () => {
                      _touchGatewayActivity();
                      if (idleTimeout) {
                        idleTimeout.touch();
                      }
                    };
                    // Nested vision-description requests are internal work. Their generic
                    // "generating response" pulse conflicts with the outer "recognizing image"
                    // phase, so keep the watchdog active but suppress that user-facing pulse.
                    stopPulse = options._visionDescribePass
                      ? () => {}
                      : startAdapterPulse(adapterDisplayName);
                    const adapterPromise = this._generateWithAdapterIsolation(
                      entry,
                      languageRecoveryState.prompt,
                      {
                        ...adapterOptions,
                        timeoutMs: PER_ADAPTER_TIMEOUT_MS,
                        provider: apiServiceProvider || adapterOptions.provider,
                        apiPoolProvider: poolProvider || adapterOptions.apiPoolProvider,
                        model: adapterOptions.model || apiDefaultModel || adapterOptions.model,
                        apiKey: picked.key,
                        apiEndpoint: picked.endpoint || undefined,
                        onChunk: (chunk) => {
                          touchActivity();
                          if (typeof adapterOptions.onChunk === 'function') {
                            try {
                              adapterOptions.onChunk(chunk);
                            } catch {
                              /* best effort */
                            }
                          }
                        },
                        abortSignal: attemptAbort.signal,
                        beforeRun: async () => {
                          const cached = await inspectCachedFastFail(entry.key, adapterDisplayName);
                          if (!cached) {
                            return null;
                          }
                          return {
                            skip: true,
                            error: cached.error,
                            errorType: cached.errorType,
                          };
                        },
                        afterRun: recordFailureEarly,
                        onRunError: async (err) => {
                          await recordThrownFailureEarly(err, attemptAbort.signal);
                        },
                      }
                    );
                    const _raceC = _buildAdapterRaceArms(
                      adapterPromise,
                      idleTimeout.timeoutPromise,
                      attemptAbort.signal
                    );
                    try {
                      result = await Promise.race(_raceC.arms);
                    } finally {
                      _raceC.cleanup();
                    }
                  } finally {
                    stopPulse();
                    if (idleTimeout) {
                      idleTimeout.stop();
                    }
                    attemptAbort.cleanup();
                    languageChunkGate = null;
                  }

                  throwIfCancelled();
                  if (releaseSlot) {
                    releaseSlot();
                  }
                  if (result.attempts) {
                    allAttempts.push(...result.attempts);
                  }
                  if (result && result.gatewaySkipFastFail) {
                    releaseAttemptBudget();
                    allAttempts.push({
                      provider: adapterDisplayName,
                      adapterKey: entry.key,
                      success: false,
                      error: result.error || 'adapter skipped',
                      statusCode: 0,
                      errorType: result.errorType || 'unavailable',
                      virtualSkip: true,
                    });
                    if (
                      preferredAdapter &&
                      entry.key === preferredAdapter &&
                      !failedPreferredReason
                    ) {
                      failedPreferredReason = result.error || 'preferred adapter skipped';
                    }
                    if (strictPreferredOnly && entry.key === preferredAdapter) {
                      return finishResult(
                        {
                          success: false,
                          content: _prependFailureReason(
                            buildPreferredAdapterRecoveryHint(
                              preferredAdapter,
                              result.error || 'adapter skipped',
                              result.errorType,
                              undefined,
                              hasImageInput
                            ),
                            allAttempts,
                            6
                          ),
                          provider: 'none',
                          adapter: 'none',
                          preferredAdapter,
                          actualAdapter: firstTriedAdapter,
                          fallbackReason:
                            failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                          attempts: allAttempts,
                          errorType: result.errorType || 'unavailable',
                        },
                        {
                          error:
                            failedPreferredReason ||
                            result.error ||
                            `preferred adapter ${preferredAdapter} failed`,
                        }
                      );
                    }
                    continue;
                  }

                  if (result.success) {
                    emitStatus(`${adapterDisplayName} 已连接并响应`);
                    pool.markSuccess(picked.keyId);
                    await this._clearAdapterFailure(entry.key);
                    if (_advDiag) {
                      _advDiag.recordLatency(`adapter:${entry.key}`, Date.now() - startTime);
                    }
                    try {
                      require('./routeLatencyStore').record(
                        `adapter:${entry.key}`,
                        Date.now() - startTime
                      );
                    } catch {
                      /* 延迟遥测 fail-soft */
                    }
                    try {
                      await pluginChain.executeAfterResponse({
                        prompt,
                        options,
                        response: result,
                        adapter: entry.key,
                      });
                    } catch (hookErr) {
                      emitStatus(
                        `Gateway plugin warning: ${hookErr.message || 'afterResponse failed'}`
                      );
                    }
                    const canonicalProvider = result.provider || entry.key;
                    const providerDisplay = picked.label
                      ? `${canonicalProvider} [${picked.label}]`
                      : canonicalProvider;
                    const pooledResult = {
                      success: true,
                      content: result.content,
                      thinking: result.thinking || null,
                      provider: canonicalProvider,
                      providerDisplay,
                      adapter: result.adapter,
                      preferredAdapter,
                      actualAdapter: entry.key,
                      fallbackReason:
                        preferredAdapter && entry.key !== preferredAdapter
                          ? failedPreferredReason || `preferred adapter ${preferredAdapter} failed`
                          : null,
                      model: result.model || null,
                      tokenUsage: result.tokenUsage || null,
                      // 这三个字段必须和下方非池化成功路径(successResult)保持一致。
                      // 漏掉 toolUseBlocks 的后果不是「少点元数据」而是**功能性失效**:
                      // 模型以纯 tool_calls 应答(content 为空)是完全正常的一轮 —— 恰恰是
                      // 「我的桌面上有什么」这类需要动手的请求的标准形态。丢了工具块,上层
                      // 只看到 content:'' → 报「AI 未返回有效回复 / 可能被 max_tokens 截断」,
                      // 把用户支去调 maxTokens,而真实原因是工具调用在网关里被丢掉了。
                      // 于是只有「你好」这种纯文本问答能通,凡是要用工具的一律哑火。
                      toolUseBlocks:
                        Array.isArray(result.toolUseBlocks) && result.toolUseBlocks.length > 0
                          ? result.toolUseBlocks
                          : undefined,
                      toolCallLog: result.toolCallLog || null,
                      toolSummary: result.toolSummary || null,
                      // 同理:没有 stopReason,toolUseLoop 的 max-tokens 自动续写永不触发。
                      stopReason:
                        result.stopReason || result.stop_reason || result.finishReason || null,
                      attempts: allAttempts,
                    };
                    await maybeRecoverFromRefusal(pooledResult);
                    return finishResult(pooledResult, {
                      response: {
                        // FIX 3 — trace/billing 元数据从恢复后的 pooledResult 取数,与实际
                        // 回复一致;未发生恢复时它逐字节等于原始值。
                        content: pooledResult.content,
                        model: pooledResult.model || result.model,
                        provider: canonicalProvider,
                        providerDisplay,
                        tokens: pooledResult.tokenUsage || null,
                      },
                    });
                  }

                  // Failed but no exception
                  const sc = result.statusCode || 0;
                  const resolvedErrMsg = _extractResultErrorMessage(result);
                  const errType = _resolveResultErrorType(sc, resolvedErrMsg, result.errorType);
                  const resHeaders = result.headers || null;
                  // OPS-MAN-164:视觉→OCR 兜底成功时,视觉池 404 是次级噪音 → 人话化(门关/非兜底/非视觉池逐字节回退)。
                  let _failStatus2589 = `${entry.adapter.getStatus().name} 失败: ${resolvedErrMsg}`;
                  try {
                    const _h = require('./visionPoolFailStatus').buildVisionPoolFailStatus({
                      poolName: entry.adapter.getStatus().name,
                      ocrRescued: options._ocrImageTextRead === true,
                      env: process.env,
                    });
                    if (_h) {
                      _failStatus2589 = _h;
                    }
                  } catch {
                    /* fail-soft → 原始诊断行 */
                  }
                  emitStatus(_failStatus2589);
                  pool.markFailure(picked.keyId, sc, resolvedErrMsg, resHeaders);
                  allAttempts.push({
                    provider: entry.adapter.getStatus().name,
                    adapterKey: entry.key,
                    success: false,
                    error: resolvedErrMsg,
                    statusCode: sc,
                    errorType: errType,
                  });
                  _maybeBoostRetryBudgetForNetworkJitter(errType, resolvedErrMsg, sc, entry.key);
                  await _recordAdapterFailureWithAttachment(entry.key, errType, resolvedErrMsg);
                  if (
                    preferredAdapter &&
                    entry.key === preferredAdapter &&
                    !failedPreferredReason
                  ) {
                    failedPreferredReason = resolvedErrMsg || 'preferred adapter failed';
                  }
                  monitor.addCascadeAttempt(traceId, {
                    adapter: entry.key,
                    success: false,
                    error: resolvedErrMsg,
                    model: options.model,
                  });
                  if (strictPreferredOnly && entry.key === preferredAdapter) {
                    if (_maybeRelaxStrictPreferredOnFailure(entry.key, errType, resolvedErrMsg)) {
                      continue;
                    }
                    return finishResult(
                      {
                        success: false,
                        content: _prependFailureReason(
                          buildPreferredAdapterRecoveryHint(
                            preferredAdapter,
                            resolvedErrMsg || 'unknown error',
                            errType,
                            options.model
                          ),
                          allAttempts,
                          6
                        ),
                        provider: 'none',
                        adapter: 'none',
                        preferredAdapter,
                        actualAdapter: firstTriedAdapter,
                        fallbackReason:
                          failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                        attempts: allAttempts,
                        errorType: errType,
                        diagnostics: result.diagnostics || null,
                      },
                      {
                        error:
                          failedPreferredReason || resolvedErrMsg || 'preferred adapter failed',
                      }
                    );
                  }
                  // 上游 5xx 快速切池:server_error 属「换通道比重试同通道更有价值」的错误类别 ——
                  // 同池换 key 重试大概率仍 5xx,原地重试只会耗尽整体预算。break 内层 key 循环,
                  // 立即推进到下一 pool provider(门控默认开,fail-soft 回退今日同池重试行为)。
                  try {
                    const _seScope = require('./serverErrorCooldownScope');
                    if (_seScope.shouldFastSwitchPoolOnServerError(errType, process.env)) {
                      emitStatus(
                        `切换通道: ${adapterDisplayName} 上游 5xx，跳过同池重试，立即推进下一池`
                      );
                      break;
                    }
                  } catch {
                    /* 叶子不可用 → 今日行为(继续同池下一 key) */
                  }
                  // Continue to next pool key
                } catch (err) {
                  if (releaseSlot) {
                    releaseSlot();
                  }
                  if (gatewayAbort.signal.aborted) {
                    const abortReason = normalizeAbortReason(
                      gatewayAbort.signal.reason || getAbortReason()
                    );
                    if (/gateway idle timeout/i.test(abortReason)) {
                      return finishResult(
                        {
                          success: false,
                          content: `请求超时: 网关链路空闲保护触发（${abortReason}）`,
                          provider: 'none',
                          adapter: 'none',
                          attempts: allAttempts,
                          errorType: 'timeout',
                        },
                        { error: abortReason }
                      );
                    }
                    return finishResult(buildCancelledResult(abortReason), {
                      error: `Cancelled: ${abortReason}`,
                    });
                  }
                  emitStatus(
                    `${entry.adapter.getStatus().name} 错误: ${err.message || '未知错误'}`
                  );
                  const sc = err.status || err.statusCode || err.response?.status || 0;
                  const errHeaders = err.response?.headers || null;
                  const errType = classifyError(sc, err.message);
                  pool.markFailure(picked.keyId, sc, err.message, errHeaders);
                  allAttempts.push({
                    provider: adapterDisplayName,
                    adapterKey: entry.key,
                    success: false,
                    error: err.message,
                    statusCode: sc,
                    errorType: errType,
                  });
                  _maybeBoostRetryBudgetForNetworkJitter(errType, err.message, sc, entry.key);
                  await _recordAdapterFailureWithAttachment(
                    entry.key,
                    errType,
                    err.message || 'unknown'
                  );
                  if (
                    preferredAdapter &&
                    entry.key === preferredAdapter &&
                    !failedPreferredReason
                  ) {
                    failedPreferredReason = err.message || 'preferred adapter failed';
                  }
                  if (strictPreferredOnly && entry.key === preferredAdapter) {
                    if (_maybeRelaxStrictPreferredOnFailure(entry.key, errType, err.message)) {
                      continue;
                    }
                    return finishResult(
                      {
                        success: false,
                        content: _prependFailureReason(
                          buildPreferredAdapterRecoveryHint(
                            preferredAdapter,
                            err.message,
                            errType,
                            options.model
                          ),
                          allAttempts,
                          6
                        ),
                        provider: 'none',
                        adapter: 'none',
                        preferredAdapter,
                        actualAdapter: firstTriedAdapter,
                        fallbackReason:
                          failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                        attempts: allAttempts,
                        errorType: errType,
                        diagnostics: err?.diagnostics || null,
                      },
                      { error: failedPreferredReason || err.message || 'preferred adapter failed' }
                    );
                  }
                  // B: background fast-fail — tagged background requests do not
                  // rotate pool keys on overload; cascade to the next adapter.
                  if (bgFastFailEnabled && (sc === 529 || errType === 'overloaded')) {
                    emitStatus('后台请求遇过载: 快速失败并切换通道（不重试）');
                    break;
                  }
                  // C: auto credential refresh — before rotating pool keys on 401/403,
                  // try the adapter's optional refreshCredential() once per request.
                  if ([401, 403].includes(sc)) {
                    const refreshedOk = await tryCredentialRefresh(entry, adapterDisplayName);
                    if (refreshedOk) {
                      continue;
                    } // retry pool loop with refreshed credential
                  }
                  // Turn-scoped credential recovery: use errorClassifier to decide
                  // whether to rotate to next pool key or break to next adapter
                  let shouldRotateKey =
                    [429, 403, 401, 529].includes(sc) ||
                    /rate.?limit|overloaded/i.test(err.message);
                  if (!shouldRotateKey) {
                    try {
                      const errorClassifierMod = require('../errorClassifier');
                      const recovery = errorClassifierMod.classifyError(sc, err.message);
                      shouldRotateKey = recovery.shouldRotateCredential;
                    } catch {
                      /* errorClassifier not available */
                    }
                  }
                  if (!shouldRotateKey) {
                    break; // Non-retryable and non-credential, move to next adapter
                  }
                }
              }
            } // end of outer pool provider for-loop (try next fallback provider)
            // All pool providers exhausted for this adapter
            if (!(externalAbortSignal && externalAbortSignal.aborted) && options.onFallback) {
              const nextEntry = orderedAdapters.find(
                (a) => a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
              );
              emitStatus(
                `密钥池耗尽，切换通道: ${adapterDisplayName}${nextEntry ? ` → ${nextEntry.adapter.getStatus().name}` : ''}`
              );
              // Retract any visible draft this adapter streamed before switching.
              emitAdapterFallbackReset();
              try {
                options.onFallback({
                  failedAdapter: adapterDisplayName,
                  failedError: 'all pool keys exhausted',
                  failedErrorType: 'pool_exhausted',
                  nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
                });
              } catch (fallbackErr) {
                emitStatus(
                  `Fallback callback warning: ${fallbackErr.message || 'onFallback failed'}`
                );
              }
            }
            continue; // Move to next adapter in cascade
          }
        } catch {
          /* pool not available, fall through to normal flow */
        }

        // Standard single-key flow (no pool or pool not applicable)
        // Retry budget is configurable for long/large tasks.
        const baseAttempts = isLargeTask
          ? 3
          : isSmallTask
            ? entry.key === 'relay_api' || entry.key === 'api'
              ? 2
              : 1
            : 2;
        const maxAdapterAttempts = _parsePositiveInt(
          options.maxAdapterAttempts ||
            process.env.GATEWAY_ADAPTER_MAX_ATTEMPTS ||
            String(baseAttempts),
          baseAttempts,
          1,
          8
        );
        const maxLanguageRecoveryRetries = Number(languageRecoveryState.maxRetries || 0);
        const maxLoopAttempts = maxAdapterAttempts + maxLanguageRecoveryRetries;
        const buildLanguageMismatchStatusPrefix = (languageConsistency = null) =>
          String(languageConsistency?.source || '')
            .trim()
            .toLowerCase() === 'final_response'
            ? '最终答复语言纠偏'
            : '首段语言纠偏';
        const beginLanguageRecoveryRetry = (languageConsistency = null, attemptIndex = 0) => {
          if (!languageConsistency) {
            return false;
          }
          if (languageRecoveryState.retriesUsed >= languageRecoveryState.maxRetries) {
            return false;
          }
          languageRecoveryState.retriesUsed += 1;
          // Retract the already-streamed draft BEFORE regenerating: without this
          // frame, buffer-based consumers append the retry to the discarded draft
          // and append-only consumers show two full answers. Reuses the existing
          // responseDebounce reset-chunk protocol (same shape as toolUseLoop's
          // _emitStreamReset). Fail-soft: reset emission must never block retry.
          if (_forwardedVisibleTextLen > 0) {
            try {
              forwardGatewayChunk(
                require('../query/responseDebounce').buildResetChunk('language-recovery-retry'),
                false
              );
            } catch {
              /* best effort */
            }
            _forwardedVisibleTextLen = 0;
          }
          languageRecoveryState.prompt = _injectKhyChineseRecoveryPrompt(
            languageRecoveryState.prompt
          );
          adapterOptions.system = _injectKhyChineseRecoverySystem(
            adapterOptions.system || options.system || ''
          );
          emitStatus(
            `${adapterDisplayName} ${buildLanguageMismatchStatusPrefix(languageConsistency)}：检测=${languageConsistency.detectedLanguage}，期望=${languageConsistency.expectedLanguage}，正在追加中文指令后重试 ${attemptIndex + 2}/${maxLoopAttempts}（纠偏 ${languageRecoveryState.retriesUsed}/${languageRecoveryState.maxRetries}）`
          );
          return true;
        };
        for (let attempt = 0; attempt < maxLoopAttempts; attempt++) {
          let attemptLanguageMismatch = null;
          const resolveAttemptLanguageMismatch = () => {
            if (!attemptLanguageMismatch) {
              return null;
            }
            const mismatchError = _buildLanguageMismatchFailureMessage(attemptLanguageMismatch);
            const mismatchStatusPrefix = buildLanguageMismatchStatusPrefix(attemptLanguageMismatch);
            allAttempts.push({
              provider: adapterDisplayName,
              adapterKey: entry.key,
              success: false,
              error: mismatchError,
              statusCode: 0,
              errorType: 'language_mismatch',
            });
            if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
              failedPreferredReason = mismatchError;
            }
            if (beginLanguageRecoveryRetry(attemptLanguageMismatch, attempt)) {
              return 'retry';
            }
            if (strictPreferredOnly && !userPinnedAdapter && entry.key === preferredAdapter) {
              strictPreferredOnly = false;
              _relaxRestart = true;
              emitStatus(
                `${adapterDisplayName} ${mismatchStatusPrefix}：检测=${attemptLanguageMismatch.detectedLanguage}，期望=${attemptLanguageMismatch.expectedLanguage}，本次请求临时放宽 strict 并启用中文兜底通道`
              );
            } else if (userPinnedAdapter && entry.key === preferredAdapter) {
              emitStatus(
                `${adapterDisplayName} ${mismatchStatusPrefix}：检测=${attemptLanguageMismatch.detectedLanguage}，期望=${attemptLanguageMismatch.expectedLanguage}，已钉选该渠道，按所选渠道结果处理（不切换到其它通道）`
              );
            } else {
              emitStatus(
                `${adapterDisplayName} ${mismatchStatusPrefix}：检测=${attemptLanguageMismatch.detectedLanguage}，期望=${attemptLanguageMismatch.expectedLanguage}，切换到下一通道继续生成`
              );
            }
            if (!(externalAbortSignal && externalAbortSignal.aborted) && options.onFallback) {
              const nextEntry = orderedAdapters.find(
                (a) => a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
              );
              // Retract any visible draft this adapter streamed before switching.
              emitAdapterFallbackReset();
              try {
                options.onFallback({
                  failedAdapter: adapterDisplayName,
                  failedError: mismatchError,
                  failedErrorType: 'language_mismatch',
                  failedStatusCode: 0,
                  nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
                });
              } catch (fallbackErr) {
                emitStatus(
                  `Fallback callback warning: ${fallbackErr.message || 'onFallback failed'}`
                );
              }
            }
            return 'next_adapter';
          };
          try {
            const cachedFastFail = await inspectCachedFastFail(entry.key, adapterDisplayName);
            if (cachedFastFail) {
              allAttempts.push({
                provider: adapterDisplayName,
                adapterKey: entry.key,
                success: false,
                error: cachedFastFail.error,
                statusCode: 0,
                errorType: cachedFastFail.errorType,
                virtualSkip: true,
              });
              if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
                failedPreferredReason = cachedFastFail.rawError || cachedFastFail.error;
              }
              if (strictPreferredOnly && entry.key === preferredAdapter) {
                return finishResult(
                  {
                    success: false,
                    content: _prependFailureReason(
                      buildPreferredAdapterRecoveryHint(
                        preferredAdapter,
                        cachedFastFail.rawError || cachedFastFail.error
                      ),
                      allAttempts,
                      6
                    ),
                    provider: 'none',
                    adapter: 'none',
                    preferredAdapter,
                    actualAdapter: firstTriedAdapter,
                    fallbackReason:
                      failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                    attempts: allAttempts,
                    errorType: cachedFastFail.errorType || 'unavailable',
                  },
                  { error: failedPreferredReason || `preferred adapter ${preferredAdapter} failed` }
                );
              }
              break;
            }
            const attemptBudgetExceeded = reserveAttemptBudget();
            if (attemptBudgetExceeded) {
              return attemptBudgetExceeded;
            }
            throwIfCancelled();
            if (attempt > 0) {
              emitStatus(`重试 ${adapterDisplayName} (${attempt + 1}/${maxLoopAttempts})`);
            }
            // Anti-ban: enforce per-adapter rate limit with jitter
            if (!skipRateLimit) {
              await this._enforceRateLimit(entry.key, {
                onWait: options.onWait,
                fastInteractive: fastInteractiveRateLimit,
                attemptIndex: attempt,
              });
            }
            throwIfCancelled();

            // Per-adapter idle-timeout: only timeout when no activity for timeout window.
            const attemptAbort = createLinkedAbortController(gatewayAbort.signal);
            let idleTimeout = null;
            let result;
            let stopPulse = () => {};
            try {
              idleTimeout = createAdapterIdleTimeout(
                entry.key,
                PER_ADAPTER_TIMEOUT_MS,
                attemptAbort
              );
              languageTracker = _createKhyLanguageConsistencyTracker(
                entry,
                adapterOptions,
                languageRecoveryState.prompt
              );
              languageChunkGate = _createCodexChineseChunkGate(
                entry.key,
                adapterDisplayName,
                languageRecoveryState.prompt,
                adapterOptions,
                attemptAbort,
                emitStatus
              );
              _attemptAborted = false;
              const touchActivity = () => {
                _touchGatewayActivity();
                if (idleTimeout) {
                  idleTimeout.touch();
                }
              };
              stopPulse = startAdapterPulse(adapterDisplayName);
              const adapterPromise = this._generateWithAdapterIsolation(
                entry,
                languageRecoveryState.prompt,
                {
                  ...adapterOptions,
                  timeoutMs: PER_ADAPTER_TIMEOUT_MS,
                  onChunk: (chunk) => {
                    touchActivity();
                    if (typeof adapterOptions.onChunk === 'function') {
                      try {
                        adapterOptions.onChunk(chunk);
                      } catch {
                        /* best effort */
                      }
                    }
                  },
                  abortSignal: attemptAbort.signal,
                  beforeRun: async () => {
                    const cached = await inspectCachedFastFail(entry.key, adapterDisplayName);
                    if (!cached) {
                      return null;
                    }
                    return {
                      skip: true,
                      error: cached.error,
                      errorType: cached.errorType,
                    };
                  },
                  afterRun: recordFailureEarly,
                  onRunError: async (err) => {
                    await recordThrownFailureEarly(err, attemptAbort.signal);
                  },
                }
              );
              const _raceC2 = _buildAdapterRaceArms(
                adapterPromise,
                idleTimeout.timeoutPromise,
                attemptAbort.signal
              );
              try {
                result = await Promise.race(_raceC2.arms);
              } finally {
                _raceC2.cleanup();
              }
            } finally {
              stopPulse();
              if (idleTimeout) {
                idleTimeout.stop();
              }
              attemptAbort.cleanup();
              attemptLanguageMismatch = languageChunkGate?.mismatchInfo || null;
              languageChunkGate = null;
            }

            throwIfCancelled();
            if (attemptLanguageMismatch) {
              const mismatchAction = resolveAttemptLanguageMismatch();
              if (mismatchAction === 'retry') {
                _forwardedVisibleTextLen = 0;
                continue;
              }
              break;
            }
            if (result.attempts) {
              allAttempts.push(...result.attempts);
            }
            if (result && result.gatewaySkipFastFail) {
              releaseAttemptBudget();
              allAttempts.push({
                provider: adapterDisplayName,
                adapterKey: entry.key,
                success: false,
                error: result.error || 'adapter skipped',
                statusCode: 0,
                errorType: result.errorType || 'unavailable',
                virtualSkip: true,
              });
              if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
                failedPreferredReason = result.error || 'preferred adapter skipped';
              }
              if (strictPreferredOnly && entry.key === preferredAdapter) {
                return finishResult(
                  {
                    success: false,
                    content: _prependFailureReason(
                      buildPreferredAdapterRecoveryHint(
                        preferredAdapter,
                        result.error || 'adapter skipped'
                      ),
                      allAttempts,
                      6
                    ),
                    provider: 'none',
                    adapter: 'none',
                    preferredAdapter,
                    actualAdapter: firstTriedAdapter,
                    fallbackReason:
                      failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                    attempts: allAttempts,
                    errorType: result.errorType || 'unavailable',
                  },
                  {
                    error:
                      failedPreferredReason ||
                      result.error ||
                      `preferred adapter ${preferredAdapter} failed`,
                  }
                );
              }
              continue;
            }

            // 给所有模型「装上眼睛」：带图请求在本适配器上以「模型拒绝 / 不支持图像」类
            // 错误（404 / model_not_found / bad_request）失败时，提升为 vision-fallback，
            // 触发下方既有的 OCR 辅助（把图转文本继续 cascade），而非把 404 直接甩给用户。
            // 「该不该退回 OCR」的判定收口在纯叶子 visionOcrFallback（门控
            // KHY_VISION_OCR_FALLBACK 默认开；复用 failureExplainer 的模型拒绝信号）。
            if (result && result.success === false && !result._visionFallback) {
              try {
                const { shouldOcrRescue } = require('./visionOcrFallback');
                const _imgPresent =
                  hasImageInput &&
                  Array.isArray(adapterOptions.images) &&
                  adapterOptions.images.length > 0;
                if (shouldOcrRescue({ result, hasImage: _imgPresent })) {
                  result._visionFallback = true;
                }
              } catch {
                /* 叶子不可用则按原失败路径处理 */
              }
            }

            // Vision fallback: 适配器不支持图像时，用 OCR 提取文本辅助，然后让 cascade 继续
            if (result && result._visionFallback) {
              releaseAttemptBudget();
              allAttempts.push({
                provider: adapterDisplayName,
                adapterKey: entry.key,
                success: false,
                error: result.error || 'adapter does not support vision',
                statusCode: 0,
                errorType: 'vision_unsupported',
                virtualSkip: true,
              });

              // OCR 辅助：将图像转为文本注入 prompt，使非视觉适配器也能理解图像内容
              if (
                !adapterOptions._ocrFallbackApplied &&
                Array.isArray(adapterOptions.images) &&
                adapterOptions.images.length > 0
              ) {
                try {
                  const ocrDetails = extractImageOcrDetails(adapterOptions.images, {
                    maxImages: 3,
                    maxChars: 1200,
                  });
                  const ocrTexts = ocrDetails.map((d) => d.text);
                  if (ocrTexts.length > 0) {
                    const ocrAugment = '\n\n[OCR 图像文本识别结果]\n' + ocrTexts.join('\n---\n');
                    prompt = prompt + ocrAugment;
                    // 低置信 OCR 追加诚实告诫(门 KHY_OCR_LOW_CONFIDENCE_CAVEAT;无低置信/门关 → 逐字节回退)。
                    prompt = _appendOcrLowConfidenceCaveat(prompt, ocrDetails);
                    // 覆盖率诚实:超上限被丢 / 部分读不出 → 追加告诫,别让模型默认已看到全部图片。
                    prompt = _appendOcrCoverageNotice(prompt, {
                      totalImages: Array.isArray(adapterOptions.images)
                        ? adapterOptions.images.length
                        : 0,
                      ocrTextCount: ocrTexts.length,
                      maxImages: 3,
                    });
                    // 单图内文本完整性诚实:某张稠密图 OCR 全文超上限被截断 → 追加告诫,别把残缺
                    // 文本当完整依据。与置信度、覆盖率两条正交。无截断/门关 → 逐字节回退。
                    prompt = _appendOcrTruncationNotice(prompt, ocrDetails);
                    // 语言包可用性诚实:请求的 OCR 语言被本机缺包窄化 → 被丢弃语言的文字未能识别,
                    // 追加告诫。与置信度、覆盖率、截断三条正交。无丢弃/门关 → 逐字节回退。
                    prompt = _appendOcrLanguageNotice(prompt, ocrDetails);
                    // 方向自动校正诚实(纠正型轴):旋转图经 docHelper 旋正后识别成功,告知模型文本取自
                    // 旋正后的图。门 KHY_OCR_AUTO_ORIENT 关 → 无 orientationCorrected 数据 → 逐字节回退。
                    prompt = _appendOcrOrientationNotice(prompt, ocrDetails);
                    // 低分辨率自动放大诚实(第二条纠正型轴):过小图经 docHelper 放大后识别成功,告知
                    // 模型文本取自放大后的图。门 KHY_OCR_UPSCALE 关 → 无 upscaledFactor 数据 → 逐字节回退。
                    prompt = _appendOcrResolutionNotice(prompt, ocrDetails);
                    // OCR 成功路径「使用 OCR 透明告知」(无条件):上面六条告诫都是条件型,干净成功时全静默,
                    // 模型据 OCR 文本作答却从不告诉用户用了 OCR。本条要求模型无感但明显地向用户披露。门关回退。
                    prompt = _appendOcrUsageDisclosure(prompt, { count: ocrTexts.length });
                    adapterOptions.images = []; // 清空图像，后续适配器用纯文本
                    adapterOptions._ocrFallbackApplied = true;
                    // 关键：adapterOptions 每个适配器都从 options 重建（见 ~4168），故必须也
                    // 清掉外层 options.images，否则 break 到下一适配器又会带图重蹈 404；prompt
                    // 已含 OCR 文本，下一适配器的 languageRecoveryState 会从更新后的 prompt 初始化。
                    options = {
                      ...options,
                      images: undefined,
                      _ocrFallbackApplied: true,
                      _ocrImageTextRead: true,
                      _ocrImageTextCount: ocrTexts.length,
                    };
                    // OPS-MAN-127(承 OPS-124/126):实时进度层透明告知。prep 期 Site1/Site2 的 OCR 成功
                    // 都发一条 emitStatus 当场告诉用户已降级到 OCR,唯独此处 post-failure 救援网(用户实测的
                    // gpt-4o keep→运行时 404→救援网路径)成功分支历史上从不 emitStatus → 实时进度层沉默。
                    // 补齐一条,与 Site1/Site2 对齐。门 KHY_OCR_RESCUE_STATUS 关 → 返 null 不 emit,逐字节回退。
                    try {
                      const _msg = require('./ocrRescueStatusNotice').buildOcrRescueStatus({
                        count: ocrTexts.length,
                        adapterName: adapterDisplayName,
                        env: process.env,
                      });
                      if (_msg) {
                        emitStatus(_msg);
                      }
                    } catch {
                      /* fail-soft:叶不可用则按历史静默 */
                    }
                  } else {
                    emitStatus(
                      `${adapterDisplayName} 不支持图像识别，OCR 未提取到文本，切换到视觉适配器`
                    );
                  }
                } catch (ocrErr) {
                  emitStatus(
                    `${adapterDisplayName} 不支持图像识别，OCR 辅助失败: ${ocrErr.message || 'unknown'}`
                  );
                }
              } else {
                emitStatus(`${adapterDisplayName} 不支持图像识别，切换到视觉适配器`);
              }
              // ── OPS-122(承 OPS-118/120,第三处「剥图 ⟹ 必留痕」断桥)────────────────
              // 上面 OCR 辅助只在**提取到文本**时剥图 + 注入;当 OCR **无文本 / 抛错**走到这里而图仍
              // 在(常见:照片/场景类无字图,或 OCR 引擎抛错),历史上只 emitStatus 就 break → 级联带着
              // **裸图**继续 → 下游纯文本适配器静默丢图、如实却荒谬地回「消息里没有附带图片」(2026-07-12
              // 用户实测,与 prep 期 Site1/Site2 同症,但此处 post-failure 救援网从未加固)。shouldOcrRescue
              // 已判定此适配器以模型拒绝类错误拒图、prep 期视觉路由亦已穷尽更优选项 → 应与上方 OCR-成功
              // 分支同款**无条件剥图**并留下诚实底线,而非把裸图交给神话中的下游视觉适配器。独立
              // default-on 门 KHY_VISION_RESCUE_STRIP_FLOOR;门关/叶子不可用 → 逐字节回退(图留着,仅状态
              // 提示),与今日行为完全一致。
              try {
                const _rescueFloorOn = require('./visionOcrFallback').isRescueStripFloorEnabled(
                  process.env
                );
                if (
                  _rescueFloorOn &&
                  hasImageInput &&
                  !adapterOptions._ocrFallbackApplied &&
                  Array.isArray(adapterOptions.images) &&
                  adapterOptions.images.length > 0
                ) {
                  const _imgCount = adapterOptions.images.length;
                  let _note = null;
                  try {
                    _note = require('./visionOcrFallback').buildVisionUnreadableNote({
                      count: _imgCount,
                    });
                  } catch {
                    /* 叶子不可用 → 试最小底线 */
                  }
                  if (!_note) {
                    try {
                      _note = require('./visionOcrFallback').buildStrippedImageFloorNote({
                        count: _imgCount,
                        env: process.env,
                      });
                    } catch {
                      /* 门关等价 → 剥图无痕 */
                    }
                  }
                  if (_note) {
                    prompt = `${prompt || ''}\n\n${_note}`;
                  }
                  adapterOptions.images = [];
                  adapterOptions._ocrFallbackApplied = true;
                  options = { ...options, images: undefined, _ocrFallbackApplied: true };
                  hasImageInput = false;
                  emitStatus(
                    '已剥离无法识别的图片并如实告知模型(OCR 未提取到文本,且无可用视觉通道)'
                  );
                }
              } catch {
                /* 叶子不可用 → 逐字节回退历史行为(图留着,仅上方状态提示) */
              }
              break; // 跳出重试循环，让外层 cascade 继续下一个适配器
            }

            if (result.success) {
              const languageConsistency = languageTracker ? languageTracker.finalize(result) : null;
              if (
                _shouldAutoRecoverCodexChineseMismatch(
                  entry.key,
                  languageConsistency,
                  languageRecoveryState.prompt,
                  adapterOptions,
                  languageRecoveryState
                )
              ) {
                const mismatchError = _buildLanguageMismatchFailureMessage(languageConsistency);
                const mismatchStatusPrefix = buildLanguageMismatchStatusPrefix(languageConsistency);
                allAttempts.push({
                  provider: adapterDisplayName,
                  adapterKey: entry.key,
                  success: false,
                  error: mismatchError,
                  statusCode: 0,
                  errorType: 'language_mismatch',
                });
                if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
                  failedPreferredReason = mismatchError;
                }
                if (beginLanguageRecoveryRetry(languageConsistency, attempt)) {
                  continue;
                }
                if (strictPreferredOnly && !userPinnedAdapter && entry.key === preferredAdapter) {
                  strictPreferredOnly = false;
                  _relaxRestart = true;
                  emitStatus(
                    `${adapterDisplayName} ${mismatchStatusPrefix}：检测=${languageConsistency.detectedLanguage}，期望=${languageConsistency.expectedLanguage}，本次请求临时放宽 strict 并启用中文兜底通道`
                  );
                } else if (userPinnedAdapter && entry.key === preferredAdapter) {
                  emitStatus(
                    `${adapterDisplayName} ${mismatchStatusPrefix}：检测=${languageConsistency.detectedLanguage}，期望=${languageConsistency.expectedLanguage}，已钉选该渠道，按所选渠道结果处理（不切换到其它通道）`
                  );
                } else {
                  emitStatus(
                    `${adapterDisplayName} ${mismatchStatusPrefix}：检测=${languageConsistency.detectedLanguage}，期望=${languageConsistency.expectedLanguage}，切换到下一通道继续生成`
                  );
                }
                if (!(externalAbortSignal && externalAbortSignal.aborted) && options.onFallback) {
                  const nextEntry = orderedAdapters.find(
                    (a) => a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
                  );
                  // Retract any visible draft this adapter streamed before switching.
                  emitAdapterFallbackReset();
                  try {
                    options.onFallback({
                      failedAdapter: adapterDisplayName,
                      failedError: mismatchError,
                      failedErrorType: 'language_mismatch',
                      failedStatusCode: 0,
                      nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
                    });
                  } catch (fallbackErr) {
                    emitStatus(
                      `Fallback callback warning: ${fallbackErr.message || 'onFallback failed'}`
                    );
                  }
                }
                break;
              }
              emitStatus(`${adapterDisplayName} 已连接并响应`);
              await this._clearAdapterFailure(entry.key);
              if (_advDiag) {
                _advDiag.recordLatency(`adapter:${entry.key}`, Date.now() - startTime);
              }
              try {
                require('./routeLatencyStore').record(
                  `adapter:${entry.key}`,
                  Date.now() - startTime
                );
              } catch {
                /* 延迟遥测 fail-soft */
              }
              try {
                await pluginChain.executeAfterResponse({
                  prompt,
                  options,
                  response: result,
                  adapter: entry.key,
                });
              } catch (hookErr) {
                emitStatus(`Gateway plugin warning: ${hookErr.message || 'afterResponse failed'}`);
              }

              let usageTrackErr = null;
              try {
                // Track usage and emit diagnostic
                const reqDuration = Date.now() - startTime;
                usageTracker.record({
                  sessionId: options.sessionId || 'default',
                  model: result.model || 'unknown',
                  provider: result.provider || entry.key,
                  inputTokens: result.tokenUsage?.inputTokens || 0,
                  outputTokens: result.tokenUsage?.outputTokens || 0,
                  durationMs: reqDuration,
                  cached: !!result.tokenUsage?.cached,
                  success: true,
                });
                diagnostics.emitModelResponse(
                  result.model || 'unknown',
                  result.provider || entry.key,
                  result.tokenUsage,
                  reqDuration,
                  { traceId: options._diagTraceId, requestId: options.requestId }
                );
                // Cache-economy probe (DESIGN-ARCH-047): record per-adapter cache
                // hit rate + whether this adapter discloses cache-billing fields,
                // so the default route can softly down-weight opaque relays that
                // never expose caching. Telemetry only — never affects this result.
                try {
                  require('./cacheEconomyStore').record(entry.key, {
                    tokenUsage: result.tokenUsage,
                    family: `${result.provider || ''} ${entry.key || ''}`,
                  });
                } catch {
                  /* probe is best-effort, must never break the request */
                }
              } catch (diagErr) {
                usageTrackErr = diagErr;
              }

              const successResult = {
                success: true,
                content: result.content,
                thinking: result.thinking || null,
                provider: result.provider,
                adapter: result.adapter,
                preferredAdapter,
                actualAdapter: entry.key,
                fallbackReason:
                  preferredAdapter && entry.key !== preferredAdapter
                    ? failedPreferredReason || `preferred adapter ${preferredAdapter} failed`
                    : null,
                model: result.model || null,
                tokenUsage: result.tokenUsage || null,
                toolUseBlocks:
                  Array.isArray(result.toolUseBlocks) && result.toolUseBlocks.length > 0
                    ? result.toolUseBlocks
                    : undefined,
                toolSummary: result.toolSummary || null,
                toolCallLog: result.toolCallLog || null,
                // `finishReason` is the canonical field SSE/streaming adapters set
                // (e.g. 'length' when the model is cut off at max_tokens). Without it
                // in this fallback chain a streamed truncation surfaces as a null stop
                // reason, so toolUseLoop's max-tokens auto-continue never fires and the
                // answer is silently left half-finished. Keep it last so explicit
                // stop_reason/stopReason still win.
                stopReason: result.stopReason || result.stop_reason || result.finishReason || null,
                attempts: allAttempts,
              };
              await maybeRecoverFromRefusal(successResult);
              const finalized = finishResult(successResult, {
                response: {
                  // FIX 3 — trace/billing 元数据从恢复后的 successResult 取数,与实际
                  // 回复一致;未发生恢复时它逐字节等于原始值。
                  content: successResult.content,
                  model: successResult.model || result.model,
                  provider: successResult.provider || result.provider,
                  tokens: successResult.tokenUsage || null,
                },
              });
              if (usageTrackErr) {
                emitStatus(
                  `Gateway telemetry warning: ${usageTrackErr.message || 'usage tracking failed'}`
                );
              }
              return finalized;
            }

            // Not success but no exception — extract error info if present
            const resolvedErrMsg = _extractResultErrorMessage(result);
            const errType = _resolveResultErrorType(
              result.statusCode,
              resolvedErrMsg,
              result.errorType
            );
            // OPS-MAN-164:视觉→OCR 兜底成功时,视觉池 404 是次级噪音 → 人话化(门关/非兜底/非视觉池逐字节回退)。
            let _failStatus3202 = `${entry.adapter.getStatus().name} 失败: ${resolvedErrMsg}`;
            try {
              const _h = require('./visionPoolFailStatus').buildVisionPoolFailStatus({
                poolName: entry.adapter.getStatus().name,
                ocrRescued: options._ocrImageTextRead === true,
                env: process.env,
              });
              if (_h) {
                _failStatus3202 = _h;
              }
            } catch {
              /* fail-soft → 原始诊断行 */
            }
            emitStatus(_failStatus3202);
            allAttempts.push({
              provider: entry.adapter.getStatus().name,
              adapterKey: entry.key,
              success: false,
              error: resolvedErrMsg,
              statusCode: result.statusCode,
              errorType: errType,
            });
            _maybeBoostRetryBudgetForNetworkJitter(
              errType,
              resolvedErrMsg,
              result.statusCode,
              entry.key
            );
            await _recordAdapterFailureWithAttachment(entry.key, errType, resolvedErrMsg, {
              stallFingerprint:
                result?.diagnostics?.stallFingerprint ||
                result?.diagnostics?.progressEvidence?.stallFingerprint ||
                '',
            });

            // A: reactive context-overflow auto-adjust (non-thrown failure path) —
            // shrink maxTokens in place and retry the same adapter once. The retry
            // skips the per-adapter loop budget (attempt--) but still counts
            // against the global attempt budget via reserveAttemptBudget, so it
            // remains bounded by maxTotalAttempts.
            if (errType === 'context_length' || result.statusCode === 413) {
              const overflowAdjust = tryContextOverflowAdjust(
                adapterOptions,
                resolvedErrMsg,
                attempt,
                maxLoopAttempts
              );
              if (overflowAdjust.adjusted) {
                attempt--; // guarded by contextOverflowAdjusted (max 1 per request)
                continue;
              }
              if (overflowAdjust.tokenInfo) {
                // No usable window — attach parsed token info for upstream compaction.
                result.diagnostics = {
                  ...(result.diagnostics || {}),
                  contextOverflowTokens: overflowAdjust.tokenInfo,
                };
              }
            }

            // Account-pool credential rotation: classify and route to ban or cooldown
            if (
              errType === 'auth' ||
              errType === 'auth_permanent' ||
              [401, 403].includes(result.statusCode) ||
              /suspended|banned|locked/i.test(resolvedErrMsg)
            ) {
              await this._handleAccountPoolAuthError(
                entry.key,
                errType,
                resolvedErrMsg,
                emitStatus
              );
            }
            if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
              failedPreferredReason = resolvedErrMsg || 'preferred adapter failed';
            }
            if (strictPreferredOnly && entry.key === preferredAdapter) {
              if (_maybeRelaxStrictPreferredOnFailure(entry.key, errType, resolvedErrMsg)) {
                continue;
              }
              return finishResult(
                {
                  success: false,
                  content: _prependFailureReason(
                    buildPreferredAdapterRecoveryHint(
                      preferredAdapter,
                      resolvedErrMsg || 'unknown error',
                      errType,
                      options.model
                    ),
                    allAttempts,
                    6
                  ),
                  provider: 'none',
                  adapter: 'none',
                  preferredAdapter,
                  actualAdapter: firstTriedAdapter,
                  fallbackReason:
                    failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                  attempts: allAttempts,
                  errorType: errType,
                  diagnostics: result.diagnostics || null,
                },
                { error: failedPreferredReason || resolvedErrMsg || 'preferred adapter failed' }
              );
            }

            // Retry non-throwing transient failures as well.
            if (attempt < maxAdapterAttempts - 1 && _isRetryableResultErrorType(errType)) {
              const baseDelay = errType === 'rate_limit' ? 3000 : 1200;
              const jitter = Math.random() * baseDelay * 0.5;
              const budgetExceeded = await waitWithRetryDelayBudget(baseDelay + jitter);
              if (budgetExceeded) {
                return budgetExceeded;
              }
              continue;
            }

            // Notify caller about fallback (don't silently switch)
            if (!(externalAbortSignal && externalAbortSignal.aborted) && options.onFallback) {
              const nextEntry = orderedAdapters.find(
                (a) => a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
              );
              emitStatus(
                `切换通道: ${entry.adapter.getStatus().name}${nextEntry ? ` → ${nextEntry.adapter.getStatus().name}` : ''}`
              );
              try {
                options.onFallback({
                  failedAdapter: entry.adapter.getStatus().name,
                  failedError: resolvedErrMsg,
                  failedErrorType: errType,
                  failedStatusCode: result.statusCode,
                  nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
                });
              } catch (fallbackErr) {
                emitStatus(
                  `Fallback callback warning: ${fallbackErr.message || 'onFallback failed'}`
                );
              }
            }
            break; // non-exception failure, move to next adapter
          } catch (err) {
            if (attemptLanguageMismatch && !gatewayAbort.signal.aborted) {
              const mismatchAction = resolveAttemptLanguageMismatch();
              if (mismatchAction === 'retry') {
                _forwardedVisibleTextLen = 0;
                continue;
              }
              break;
            }
            if (gatewayAbort.signal.aborted) {
              const abortReason = normalizeAbortReason(
                gatewayAbort.signal.reason || getAbortReason()
              );
              if (/gateway idle timeout/i.test(abortReason)) {
                return finishResult(
                  {
                    success: false,
                    content: `请求超时: 网关链路空闲保护触发（${abortReason}）`,
                    provider: 'none',
                    adapter: 'none',
                    attempts: allAttempts,
                    errorType: 'timeout',
                  },
                  { error: abortReason }
                );
              }
              return finishResult(buildCancelledResult(abortReason), {
                error: `Cancelled: ${abortReason}`,
              });
            }
            const status = err.status || err.statusCode || err.response?.status;
            const errorType = classifyError(status, err.message);
            emitStatus(`${entry.adapter.getStatus().name} 错误: ${err.message || '未知错误'}`);

            allAttempts.push({
              provider: entry.adapter.getStatus().name,
              adapterKey: entry.key,
              success: false,
              error: err.message,
              statusCode: status,
              errorType,
            });
            _maybeBoostRetryBudgetForNetworkJitter(errorType, err.message, status, entry.key);
            await _recordAdapterFailureWithAttachment(
              entry.key,
              errorType,
              err.message || 'unknown',
              {
                stallFingerprint:
                  err?.codexProgressFingerprint ||
                  err?.codexProgressEvidence?.stallFingerprint ||
                  '',
              }
            );

            // A: reactive context-overflow auto-adjust (KHY_CONTEXT_OVERFLOW_AUTO_ADJUST)
            // — shrink maxTokens in place and retry the same adapter once. The retry
            // skips the per-adapter loop budget (attempt--) but still counts
            // against the global attempt budget via reserveAttemptBudget, so it
            // remains bounded by maxTotalAttempts.
            if (errorType === 'context_length' || status === 413) {
              const overflowAdjust = tryContextOverflowAdjust(
                adapterOptions,
                err.message,
                attempt,
                maxLoopAttempts
              );
              if (overflowAdjust.adjusted) {
                attempt--; // guarded by contextOverflowAdjusted (max 1 per request)
                continue;
              }
              if (overflowAdjust.tokenInfo) {
                // No usable window — attach parsed token info for upstream compaction.
                err.diagnostics = {
                  ...(err.diagnostics || {}),
                  contextOverflowTokens: overflowAdjust.tokenInfo,
                };
              }
            }

            // C: auto credential refresh — try the adapter's optional
            // refreshCredential() before account-pool ban/cooldown; success retries
            // the same adapter once (consumes the regular attempt budget).
            if (errorType === 'auth' || [401, 403].includes(status)) {
              const credentialRefreshedOk = await tryCredentialRefresh(
                entry,
                entry.adapter.getStatus().name
              );
              if (credentialRefreshedOk) {
                continue;
              }
            }

            // Account-pool credential rotation on thrown auth errors (cooldown vs ban)
            if (
              errorType === 'auth' ||
              errorType === 'auth_permanent' ||
              [401, 403].includes(status) ||
              /suspended|banned|locked/i.test(err.message)
            ) {
              await this._handleAccountPoolAuthError(entry.key, errorType, err.message, emitStatus);
            }
            if (preferredAdapter && entry.key === preferredAdapter && !failedPreferredReason) {
              failedPreferredReason = err.message || 'preferred adapter failed';
            }
            if (strictPreferredOnly && entry.key === preferredAdapter) {
              if (_maybeRelaxStrictPreferredOnFailure(entry.key, errorType, err.message)) {
                continue;
              }
              return finishResult(
                {
                  success: false,
                  content: _prependFailureReason(
                    buildPreferredAdapterRecoveryHint(
                      preferredAdapter,
                      err.message,
                      errorType,
                      options.model
                    ),
                    allAttempts,
                    6
                  ),
                  provider: 'none',
                  adapter: 'none',
                  preferredAdapter,
                  actualAdapter: firstTriedAdapter,
                  fallbackReason:
                    failedPreferredReason || `preferred adapter ${preferredAdapter} failed`,
                  attempts: allAttempts,
                  errorType,
                  diagnostics: err?.diagnostics || null,
                },
                { error: failedPreferredReason || err.message || 'preferred adapter failed' }
              );
            }

            // B: background fast-fail (KHY_BG_FAST_FAIL) — explicitly tagged
            // background requests skip same-adapter retries on overloaded/rate_limit
            // and cascade straight to the next adapter (fall through to break below).
            const _bgSkipRetry =
              bgFastFailEnabled && (errorType === 'overloaded' || errorType === 'rate_limit');
            if (_bgSkipRetry) {
              emitStatus('后台请求遇过载: 快速失败并切换通道（不重试）');
            }

            // Auto-retry transient thrown errors within configured budget.
            if (!_bgSkipRetry && attempt < maxAdapterAttempts - 1 && isRetryableError(err)) {
              // Respect server Retry-After header if present
              const serverDelay = parseRetryAfter(err);
              const baseDelay = serverDelay || (errorType === 'rate_limit' ? 3000 : 1500);
              const jitter = Math.random() * baseDelay * 0.5;
              const budgetExceeded = await waitWithRetryDelayBudget(baseDelay + jitter);
              if (budgetExceeded) {
                return budgetExceeded;
              }
              continue; // retry same adapter
            }

            // Notify caller about fallback (don't silently switch)
            if (!(externalAbortSignal && externalAbortSignal.aborted) && options.onFallback) {
              const nextEntry = orderedAdapters.find(
                (a) => a.key !== entry.key && a.enabled && (a.available || a.key === 'relay')
              );
              emitStatus(
                `切换通道: ${entry.adapter.getStatus().name}${nextEntry ? ` → ${nextEntry.adapter.getStatus().name}` : ''}`
              );
              try {
                options.onFallback({
                  failedAdapter: entry.adapter.getStatus().name,
                  failedError: err.message,
                  failedErrorType: errorType,
                  failedStatusCode: status,
                  nextAdapter: nextEntry ? nextEntry.adapter.getStatus().name : null,
                });
              } catch (fallbackErr) {
                emitStatus(
                  `Fallback callback warning: ${fallbackErr.message || 'onFallback failed'}`
                );
              }
            }
            break; // non-retryable or already retried, move to next adapter
          }
        }
      }

      if (gatewayAbort.signal.aborted) {
        const abortReason = normalizeAbortReason(gatewayAbort.signal.reason || getAbortReason());
        if (/gateway idle timeout/i.test(abortReason)) {
          return finishResult(
            {
              success: false,
              content: `请求超时: 网关链路空闲保护触发（${abortReason}）`,
              provider: 'none',
              adapter: 'none',
              attempts: allAttempts,
              errorType: 'timeout',
            },
            { error: abortReason }
          );
        }
        return finishResult(buildCancelledResult(abortReason), {
          error: `Cancelled: ${abortReason}`,
        });
      }

      // ── Emergency bypass: pick adapter with shortest cooldown, clear & retry once ─
      // When ALL adapters are fast-fail skipped (all virtualSkip), pick the one with the
      // shortest remaining cooldown, clear its failure cache, and give it one real attempt.
      // This prevents empty-reply scenarios where every adapter is in cooldown.
      if (
        !gatewayAbort.signal.aborted &&
        allAttempts.length > 0 &&
        allAttempts.every((a) => a.virtualSkip)
      ) {
        try {
          let shortestEntry = null;
          let shortestRemainingMs = Infinity;
          for (const entry of orderedAdapters) {
            if (!entry.enabled || !entry.available) {
              continue;
            }
            const cached = await this._getRecentFastFail(entry.key);
            if (
              cached &&
              cached.remainingMs >= 0 &&
              cached.remainingMs < shortestRemainingMs &&
              cached.circuitOpen !== true
            ) {
              shortestRemainingMs = cached.remainingMs;
              shortestEntry = entry;
            }
          }
          if (shortestEntry) {
            const adapterDisplayName = shortestEntry.adapter
              ? typeof shortestEntry.adapter.getStatus === 'function'
                ? shortestEntry.adapter.getStatus().name
                : shortestEntry.key
              : shortestEntry.key;
            emitStatus(
              `紧急放行: 清除 ${adapterDisplayName} 冷却缓存并重试一次（剩余冷却 ${Math.max(1, Math.ceil(shortestRemainingMs / 1000))}s）`
            );
            await this._clearAdapterFailure(shortestEntry.key);
            // Single retry: call adapter directly with minimal options
            try {
              const emergencyResult = await this._generateWithAdapterIsolation(
                shortestEntry,
                prompt,
                {
                  ...options,
                  timeoutMs: 30000,
                  onChunk: forwardGatewayChunk,
                  abortSignal: gatewayAbort.signal,
                }
              );
              if (emergencyResult && emergencyResult.success) {
                return finishResult(emergencyResult);
              }
              if (emergencyResult) {
                allAttempts.push({
                  provider: adapterDisplayName,
                  adapterKey: shortestEntry.key,
                  success: false,
                  error: emergencyResult.error || 'emergency retry failed',
                  statusCode: emergencyResult.statusCode || 0,
                  errorType: emergencyResult.errorType || 'unknown',
                });
              }
            } catch (emergencyErr) {
              allAttempts.push({
                provider: adapterDisplayName,
                adapterKey: shortestEntry.key,
                success: false,
                error: emergencyErr.message || 'emergency retry exception',
                statusCode: 0,
                errorType: emergencyErr.errorType || 'unknown',
              });
            }
          }
        } catch {
          /* fail-soft: emergency bypass must never block original flow */
        }
      }

      // ── 瞬态网络抖动整轮自愈 ────────────────────────────────────────────────
      // 级联穷尽全部适配器后,若真实尝试均非「硬确定性失败」且至少一次属网络抖动类
      // (ECONNRESET / socket hang up / 502 / 503 / 504 / 超时等),退避等待后清除相关
      // 通道的瞬态冷却并重跑整轮级联,给网络恢复「几轮」机会,而非一轮耗尽直接甩
      // 「所有 AI 通道均不可用」墙。受轮次上限(cascadeJitterRetryRounds)、墙钟硬死线
      // (KHY_GATEWAY_HARD_TIMEOUT)与级联总次数封顶(_gatewayHardDeadline)约束,杜绝病态 churn。
      if (
        cascadeJitterRetryRounds > 0 &&
        _cascadeJitterRound < cascadeJitterRetryRounds &&
        !gatewayAbort.signal.aborted
      ) {
        const _realFailures = allAttempts.filter((a) => a && !a.virtualSkip);
        const _anyJitter = _realFailures.some((a) =>
          _isNetworkJitterLikeFailure(
            String(a.errorType || ''),
            a.error || '',
            Number(a.statusCode || 0)
          )
        );
        const _allRetryable =
          _realFailures.length > 0 && _realFailures.every((a) => !_isHardDeterministicAttempt(a));
        if (_anyJitter && _allRetryable) {
          _cascadeJitterRound += 1;
          const waitMs = Math.round(
            Math.min(12000, 1000 * Math.pow(2, _cascadeJitterRound - 1)) + Math.random() * 500
          );
          await new Promise((r) => setTimeout(r, waitMs));
          // 清除本轮真实失败通道的冷却缓存,让下一轮获得真实尝试而非 virtual-skip。
          // 仅清真实失败者;本轮 virtual-skip 的通道(冷却来自更早请求)继续由冷却自愈
          // ticker / fast-fail probe 放行,避免越权清除确定性的冷却状态。
          const _clearedKeys = new Set();
          for (const a of _realFailures) {
            if (a.adapterKey && !_clearedKeys.has(a.adapterKey)) {
              _clearedKeys.add(a.adapterKey);
              try {
                await this._clearAdapterFailure(a.adapterKey);
              } catch {
                /* fail-soft */
              }
            }
          }
          emitStatus(
            `检测到网络抖动(${_realFailures.length} 个通道失败)，第 ${_cascadeJitterRound}/${cascadeJitterRetryRounds} 轮整轮自愈重试（等待 ${waitMs}ms，已清除 ${_clearedKeys.size} 个通道的瞬态冷却）`
          );
          // 重置级联与预算计数后从头重跑本轮(轮次上限 + 硬死线约束总量)。
          totalAdapterAttempts = 0;
          totalRetryDelayMs = 0;
          _triedAdapters = new Set();
          _adapterIdx = 0;
          continue cascadeLoop;
        }
      }

      // ── 断网自动续传:等待网络恢复后自动重跑级联 ──────────────────────────────
      // 整轮自愈轮次用尽(或已关闭)后,若失败集合仍属「可恢复网络类」(至少一条抖动信号、
      // 无硬确定性失败),不立即甩墙,而是进入「等待网络恢复」状态:周期性轻探失败通道,
      // 一旦探活成功即清除瞬态冷却并从头重跑级联。受 KHY_GATEWAY_NETWORK_RESUME_MAX_MS
      // 与既有墙钟硬死线双约束;用户 abort 立即退出;每次探活视为网关活动(续命 idle
      // 看门狗),状态行持续上报「动作+目标+进度」。仅前台用户请求且重试预算 >1 参与。
      if (
        _networkResumeEnabled &&
        _resumeCyclesUsed < _resumeCycleMax &&
        requestSource === 'foreground' &&
        baseMaxTotalAttempts > 1 &&
        !gatewayAbort.signal.aborted
      ) {
        const _realFailures = allAttempts.filter((a) => a && !a.virtualSkip);
        const _anyJitter = _realFailures.some((a) =>
          _isNetworkJitterLikeFailure(
            String(a.errorType || ''),
            a.error || '',
            Number(a.statusCode || 0)
          )
        );
        const _allRetryable =
          _realFailures.length > 0 && _realFailures.every((a) => !_isHardDeterministicAttempt(a));
        if (_anyJitter && _allRetryable) {
          _resumeCyclesUsed += 1;
          const _probeCandidate = _realFailures.find((a) =>
            _isNetworkJitterLikeFailure(
              String(a.errorType || ''),
              a.error || '',
              Number(a.statusCode || 0)
            )
          );
          const _probeKeys =
            _probeCandidate && _probeCandidate.adapterKey
              ? [_probeCandidate.adapterKey]
              : _realFailures.map((a) => a.adapterKey).filter(Boolean);
          if (_resumeWaitStartedAt === 0) {
            _resumeWaitStartedAt = Date.now();
          }
          const _resumeStart = _resumeWaitStartedAt;
          while (!gatewayAbort.signal.aborted) {
            const _elapsed = Date.now() - _resumeStart;
            if (_elapsed >= _networkResumeMaxMs) {
              break;
            }
            if (_gatewayHardDeadline && _gatewayHardDeadline.exceeded(Date.now())) {
              break;
            }
            _touchGatewayActivity();
            const _remainingSec = Math.max(0, Math.floor((_networkResumeMaxMs - _elapsed) / 1000));
            emitStatus(
              `网络中断: 等待网络恢复后自动重试（已等待 ${Math.floor(_elapsed / 1000)}s，剩余上限 ${_remainingSec}s）`
            );
            let _recovered = false;
            for (const _pk of _probeKeys) {
              try {
                const _pr = await this.testAdapter(_pk, {
                  quick: true,
                  timeoutMs: _networkResumeProbeTimeoutMs,
                });
                if (this._isHealthyProbeResult(_pr)) {
                  _recovered = true;
                  break;
                }
              } catch {
                /* probe error → keep waiting */
              }
            }
            if (_recovered) {
              emitStatus('网络已恢复，正在自动重试全部通道');
              _logGenerateDiagEvent('llm.network_resume_recovered', {
                waitedMs: Date.now() - _resumeStart,
                recoveredVia: _probeKeys.join(','),
              });
              for (const a of _realFailures) {
                if (a.adapterKey) {
                  try {
                    await this._clearAdapterFailure(a.adapterKey);
                  } catch {
                    /* fail-soft */
                  }
                }
              }
              totalAdapterAttempts = 0;
              totalRetryDelayMs = 0;
              _triedAdapters = new Set();
              _adapterIdx = 0;
              _resumeRecovered = true;
              continue cascadeLoop;
            }
            await new Promise((resolve) => {
              const t = setTimeout(resolve, _networkResumePollMs);
              if (t.unref) {
                t.unref();
              }
              gatewayAbort.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(t);
                  resolve();
                },
                { once: true }
              );
            });
          }
          const _waitedSec = Math.floor((Date.now() - _resumeStart) / 1000);
          if (_waitedSec >= 1) {
            _resumeNote = `已等待网络恢复 ${_waitedSec}s 仍不可用，本次请求放弃。可修复网络/代理后说「继续」自动重试。\n\n`;
          }
        }
      }
      break;
    } // end cascadeLoop while

    // All adapters failed — increment failures via healthStore for attempted adapters
    const attemptedAdapterKeys = new Set(
      allAttempts
        .filter((a) => a && !a.virtualSkip)
        .map((a) => a.adapterKey)
        .filter(Boolean)
    );
    let totalFailures = 0;
    for (const entry of orderedAdapters) {
      if (entry.enabled && entry.available && attemptedAdapterKeys.has(entry.key)) {
        const newCount = await this._healthStore.incrFailure(entry.key);
        this._adapterFailures[entry.key] = newCount; // keep mirror in sync
        totalFailures += newCount;
      }
    }
    if (totalFailures >= 2) {
      // Force re-detect adapters on next call (IDE might have updated tokens)
      this.refreshAdapters().catch(() => {});
    }

    if (_advDiag) {
      _advDiag.recordError('gateway', 'All adapters failed');
    }

    // 限流终局 OCR 兜底:级联已穷尽所有通道,末条尝试若属瞬态类(如所有视觉通道都 429)、
    // 且本轮仍握图 → 退回本地 OCR 把图中文字读出来诚实作答,而非甩「所有通道不可用」。
    // OCR 无文本 → 返回 null 落回下方原失败报告(不谎报成功)。
    if (hasImageInput && Array.isArray(options.images) && options.images.length) {
      const _terminalErrorType =
        allAttempts.length > 0 ? allAttempts[allAttempts.length - 1].errorType : 'unknown';
      const _ocrRescued = tryRateLimitOcrRescue({
        images: options.images,
        prompt,
        errorType: _terminalErrorType,
        finishResult,
        allAttempts,
        emitStatus,
        env: process.env,
      });
      if (_ocrRescued) {
        return _ocrRescued;
      }
    }

    // 视觉级联耗尽的确定性根因诊断:带图请求穷尽所有通道、且 OCR 也救不回时,若 allAttempts 里
    // 出现视觉专属信号(404/model_not_found = 账号未领取模型;429/rate_limit = 账号限流),前置一段
    // 指名道姓的可执行指引到笼统兜底墙之前,替代「所有通道不可用」的沉默。门控 KHY_VISION_EXHAUSTION_DIAG
    // (默认开);null / 关门 / 任何异常 → 不前置(fail-soft:诊断绝不阻断兜底)。
    let _visionExhaustionNote = '';
    if (hasImageInput) {
      try {
        const { diagnoseVisionExhaustion } = require('./visionExhaustionDiagnostic');
        const _visDiag = diagnoseVisionExhaustion({
          attempts: allAttempts,
          hasImageInput,
          env: process.env,
        });
        if (_visDiag && _visDiag.message) {
          _visionExhaustionNote = `${_visDiag.message}\n\n`;
        }
      } catch {
        /* fail-soft */
      }
    }

    // 通用通道失败诊断(非带图 / 带图均可):把各通道高频确定性失败(5xx / auth / 限流 /
    // 网络 / 模型不存在)翻译成可操作指引,前置到笼统兜底墙之前。门控
    // KHY_CHANNEL_FAILURE_ADVICE(默认开);null / 关门 / 任何异常 → 不前置(fail-soft)。
    let _channelAdviceNote = '';
    try {
      const { buildChannelFailureAdvice } = require('./buildChannelFailureAdvice');
      const _adv = buildChannelFailureAdvice({ attempts: allAttempts, env: process.env });
      if (_adv && _adv.message) {
        _channelAdviceNote = `${_adv.message}\n\n`;
      }
    } catch {
      /* fail-soft */
    }

    // 自愈轮次诚实披露:若本轮请求已自动重跑整轮级联仍失败,先向用户说明自愈尝试过
    // 多少轮、当前处于第几轮上限,避免「所有通道不可用」墙被误读为一次都没试过。
    let _jitterRoundsNote = '';
    if (_cascadeJitterRound > 0) {
      _jitterRoundsNote = `已自动执行 ${_cascadeJitterRound}/${cascadeJitterRetryRounds} 轮网络抖动整轮自愈重试，网络仍未恢复。\n\n`;
    }
    // 断网自动续传诚实披露:等待过网络恢复仍失败,如实说明已等待的时长;若等待恢复后
    // 重试又失败,也如实说明「恢复过并自动重试,但重试未成功」。
    if (_resumeRecovered && !_resumeNote) {
      _resumeNote = `已等待网络恢复并自动重试（${_resumeCyclesUsed} 轮续传），重试仍未成功。\n\n`;
    }

    // Build detailed failure report
    const guidanceContent =
      _visionExhaustionNote +
      _channelAdviceNote +
      _jitterRoundsNote +
      _resumeNote +
      [
        '所有 AI 通道均不可用。',
        '',
        '🆓 免费方案 (推荐):',
        '  • Kiro IDE — 免费 Claude 4 额度: https://kiro.dev',
        '  • Trae IDE — 免费 Claude/GPT 额度: https://trae.ai',
        '  • Ollama 本地模型 — 无需网络，运行 /models 安装',
        '',
        '💰 付费订阅:',
        '  • Claude: https://claude.ai/pricing',
        '  • OpenAI: https://platform.openai.com',
        '  • Cursor: https://cursor.com/pricing',
        '  • 智谱AI (国内直连): https://open.bigmodel.cn',
        '  • 通义千问 (国内直连): https://dashscope.aliyun.com',
        '',
        '⚡ 快速配置:',
        '  • ai config — 配置 API 密钥',
        '  • /proxy — 配置代理 (Clash/VPN)',
        '  • khy gateway relay — 启动 Web 中转服务',
      ].join('\n');

    return finishResult(
      {
        success: false,
        content: _prependFailureReason(guidanceContent, allAttempts, 10),
        provider: 'none',
        adapter: 'none',
        preferredAdapter,
        actualAdapter: firstTriedAdapter,
        fallbackReason: preferredAdapter
          ? failedPreferredReason || `preferred adapter ${preferredAdapter} unavailable`
          : null,
        attempts: allAttempts,
        errorType:
          allAttempts.length > 0 ? allAttempts[allAttempts.length - 1].errorType : 'unknown',
      },
      { error: 'All adapters failed' }
    );
  },
};

module.exports = { AIGatewayGenerateMethod, setAiGatewayGenerateMethodDeps };
