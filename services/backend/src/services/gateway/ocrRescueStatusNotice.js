'use strict';

/**
 * ocrRescueStatusNotice.js — OCR 兜底「实时状态」层的确定性透明告知(OPS-MAN-127,承 OPS-124/126)。
 *
 * 断桥(与 OPS-124 prompt 指令、OPS-126 答复脚注正交的第三层——**实时进度层**):
 *   vision→OCR 兜底有三处成功注入点。prep 期两处**成功时都发一条实时状态**告诉用户已降级到 OCR:
 *     - Site1(describe 级联全失败)  emitStatus('…已诚实说明并剥图/OCR 兜底…')
 *     - Site2(prep ocr-fallback)     emitStatus('…已用 OCR 提取 N 张图片文本兜底')
 *   唯独 **Site3(post-failure 救援网,即用户实测的 gpt-4o keep → 运行时 404 → 救援网路径)** 的
 *   OCR-**成功**分支**从不 emitStatus**——那里的 emitStatus 只覆盖 OCR **失败/无文本**(切视觉适配器)。
 *   于是恰在用户复现的那条路径上,OCR 成功降级发生时**实时进度层一片沉默**:用户只看到一墙视觉失败
 *   状态,看不到「已降级到本地 OCR 并成功识别」的当场告知。答复层由 OPS-124/126 兜住,但「明显告知」
 *   要求在交互当下也可见。本叶补齐 Site3 成功分支的实时状态,与 Site1/Site2 对齐。
 *
 * 设计:纯叶,零 IO,绝不抛。default-on 门 KHY_OCR_RESCUE_STATUS。门关 → 返 null → 不 emitStatus →
 *   逐字节回退历史「Site3 成功分支静默」行为。count<=0 / 畸形 → null(与既有 emitStatus 语义一致:
 *   只在确有文本读出时才announce)。
 */

const { isFlagEnabled } = require('../flagRegistry');

const FLAG = 'KHY_OCR_RESCUE_STATUS';

/** 门是否开启(default-on)。异常保守返回 false(不 announce),绝不抛。 */
function isRescueStatusEnabled(env) {
  try {
    return isFlagEnabled(FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 构造 Site3 救援网 OCR-成功的实时状态串;门关 / count 非正 / 畸形 → null(调用方据此决定是否 emitStatus)。
 * @param {{count?: number, adapterName?: string, env?: object}} [opts]
 * @returns {string|null}
 */
function buildOcrRescueStatus({ count, adapterName, env } = {}) {
  if (!isRescueStatusEnabled(env)) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const who = (typeof adapterName === 'string' && adapterName.trim()) ? adapterName.trim() : '当前适配器';
  const noun = n === 1 ? '1 张图片' : `${n} 张图片`;
  return `检测到图片输入：${who} 不支持图像识别，已降级用本地 OCR 成功提取 ${noun}文本并据此作答`;
}

// ── OPS-MAN-132(承 OPS-127):prep 期 Site1/Site2 的实时状态其实**只在 _isVerbose 时**发 ─────────
// OPS-127 修 Site3 时把它做成**无条件** emitStatus(不受 verbose 约束),理由是「明显告知」要求
// 交互当下也可见。但 prep 期两处 OCR-成功的既有 emitStatus(aiGatewayGenerateMethod Site1~1618 /
// Site2~1692)都嵌在 `if (_isVerbose)` 里 → **非 verbose 会话**在 prep 期发生 OCR 降级时,实时进度层
// 依旧一片沉默(答复层由 OPS-124/126 兜住,但当场不可见),与 OPS-127 已补齐的 Site3 形成不对称。
// 本条把「已降级到 OCR」的无条件实时状态扩到 prep 期 Site1/Site2,专门补**非 verbose** 用户的缺口
// (verbose 用户已有既有状态,调用点用 !_isVerbose 守卫避免重复)。独立 default-on 门,与 Site3
// 的 KHY_OCR_RESCUE_STATUS 分开,单独字节回退。
const PREP_FLAG = 'KHY_OCR_RESCUE_STATUS_PREP';

/** prep 期实时状态门是否开启(default-on)。异常保守返回 false,绝不抛。 */
function isRescuePrepStatusEnabled(env) {
  try {
    return isFlagEnabled(PREP_FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * 构造 prep 期(Site1 describe 级联全失败 / Site2 ocr-fallback)OCR-成功的实时状态串。
 * 与 buildOcrRescueStatus 同形,只是主语用「模型」而非「适配器」(prep 期尚未落到具体适配器)。
 * 门关 / count 非正 / 畸形 → null(调用方据此决定是否 emitStatus)。绝不抛。
 * @param {{count?: number, modelName?: string, env?: object}} [opts]
 * @returns {string|null}
 */
function buildOcrRescuePrepStatus({ count, modelName, env } = {}) {
  if (!isRescuePrepStatusEnabled(env)) return null;
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return null;
  const who = (typeof modelName === 'string' && modelName.trim()) ? modelName.trim() : '当前模型';
  const noun = n === 1 ? '1 张图片' : `${n} 张图片`;
  return `检测到图片输入：${who} 不支持图像识别，已降级用本地 OCR 成功提取 ${noun}文本并据此作答`;
}

// ── OPS-MAN-148(承 OPS-132 + OPS-144「减少显示的心灵噪音」):Site1 prep-status 与 OCR-成功闭合的跨层去重 ──
// 用户复现的**确切路径**(非 verbose · describe 级联全失败 → 本地 OCR 成功)上,同一条「已降级到 OCR
// 并成功识别」被**两层各发一遍、且都是永久行**:
//   - chunk[status]  OPS-132 prep(buildOcrRescuePrepStatus,line ~1663)——文本含「成功」→ emitRuntimeStatus
//     误分类为 _printTerminalStatus('done','模型已连接') → 永久行 **且标签错成「模型已连接」**;
//   - chunk[assistant_message] OPS-144 闭合(buildOcrSuccessClosure,line ~1677,门 _intermediateEnabled)——
//     干净的 bot 气泡「视觉模型均不可用,已改用本地 OCR 成功识别…据此作答」。
// OPS-132 当初补 prep-status 是为**非 verbose 用户在 prep 期看不到 OCR 降级**;但 OPS-144 闭合落地后,
// 恰在 Site1(级联失败)这条路径上闭合已经把「明显告知用了 OCR」交付了 → prep-status 沦为冗余且措辞更差
// 的第二遍公告。本谓词让调用方在**闭合确将发射时**(_intermediateEnabled 且闭合门开)抑制 Site1 的冗余
// prep-status,只留更清晰的闭合。★仅限 Site1:Site2(ocr-fallback,无级联 → 无悬空承诺 → 无闭合)必须
// 保留 prep-status,否则非 verbose 用户在那条路径又变回沉默。独立 default-on 门,门关/异常 → false(不抑制)
// = 逐字节回退(prep-status 与闭合并存,历史行为)。
const PREP_CLOSURE_DEDUP_FLAG = 'KHY_OCR_RESCUE_PREP_CLOSURE_DEDUP';

/** 跨层去重门是否开启(default-on)。异常保守返回 false(不抑制,byte-revert),绝不抛。 */
function isPrepClosureDedupEnabled(env) {
  try {
    return isFlagEnabled(PREP_CLOSURE_DEDUP_FLAG, env || process.env);
  } catch {
    return false;
  }
}

/**
 * Site1(describe 级联全失败 → OCR 成功)是否应**抑制** prep-status,因为 OCR-成功闭合将发同义公告。
 * 仅当:去重门开 && 闭合确将发(中间消息前提 intermediateEnabled 为真 && 闭合门 closureEnabled 为真)→ true。
 * 门关 / 闭合不会发 / 畸形 → false(不抑制,逐字节回退 prep-status 与闭合并存)。绝不抛。
 * 调用方只在 Site1 传入;Site2 绝不调用本谓词(须始终保留 prep-status)。
 * @param {{intermediateEnabled?: boolean, closureEnabled?: boolean, env?: object}} [opts]
 * @returns {boolean}
 */
function shouldSuppressPrepForClosure({ intermediateEnabled, closureEnabled, env } = {}) {
  try {
    if (!isPrepClosureDedupEnabled(env)) return false;
    return intermediateEnabled === true && closureEnabled === true;
  } catch {
    return false;
  }
}

module.exports = {
  isRescueStatusEnabled,
  buildOcrRescueStatus,
  FLAG,
  isRescuePrepStatusEnabled,
  buildOcrRescuePrepStatus,
  PREP_FLAG,
  isPrepClosureDedupEnabled,
  shouldSuppressPrepForClosure,
  PREP_CLOSURE_DEDUP_FLAG,
};
