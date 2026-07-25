'use strict';

/**
 * firstResponseAckVoice — 纯叶子:补住「用户提交提示词 → 首个模型 token」之间的**静默窗口**,
 * 让 khy 在这段空窗里及时甩一句「还在等模型响应」的确定性短句,用户第一时间知道 khy 收到了、
 * 正在处理,而不是对着一个不动的终端怀疑卡死。
 *
 * 背景(2026-07-12 用户 /goal「当我向 Khy 输入提示词时,khy 要及时回应」):
 *   - 交互 raw-mode 终端里 spinner 被 render-suppress(spinner.js:122 `if (isRaw && blockInRawMode) return`),
 *     提交那刻到首个模型 chunk 之间**看不到任何动静**;
 *   - 现有 turnAckVoice 只在**本轮首个工具即将派发**时才出(那已是模型跑起来、chunk 已到之后),
 *     覆盖不到「首 token 迟迟不来」这段最容易让人以为卡死的窗口。
 *   本叶补这条正交层:一个**基于计时器**的调度器,arm 于请求发出;若 delay(默认 1200ms)内
 *   **一个 chunk 都没到**,就 emit 一句 wait-aware 回应;首个 chunk 一到即 disarm(取消,不多话)。
 *
 * 契约:
 *   - 纯函数产句(computeFirstResponseAck / firstResponseAckDelayMs)+ **DI 计时器调度器**
 *     (setTimeout/clearTimeout/emit/now 全经 deps 注入,可用假计时器单测,零真实副作用);
 *   - 确定性(无随机·按 turnIndex 轮换)、绝不抛(一切异常吞成 no-op / '');
 *   - 门控 KHY_FIRST_RESPONSE_ACK 默认开,仅 CANON 4 词({0,false,off,no})关 → arm() no-op、
 *     逐字节回退到「无提示」;flagRegistry 优先,本地 CANON 回退;
 *   - 窗口阈值 KHY_FIRST_RESPONSE_ACK_MS(numeric,默认 1200,clamp [200,60000])。
 *
 * 与 turnAckVoice 的分工(正交,不重叠):
 *   turnAckVoice = 首个**工具**即将派发时的 turn 级确认(模型已开口之后);
 *   firstResponseAckVoice = 首个**模型 token 到来之前**的静默窗口守护(模型还没开口)。
 *   接线方在本叶 emit 时置 _turnAckEmitted=true,避免同一回合两处叠话。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

const _DEFAULT_DELAY_MS = 1200;
const _MIN_DELAY_MS = 200;
const _MAX_DELAY_MS = 60000;

/** 门控:KHY_FIRST_RESPONSE_ACK 默认开,仅 {0,false,off,no} 关。flagRegistry 优先,本地 CANON 回退。 */
function isEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_FIRST_RESPONSE_ACK', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_FIRST_RESPONSE_ACK;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * selection 变体子门:KHY_FIRST_RESPONSE_ACK_SELECTION(default-on,父门 KHY_FIRST_RESPONSE_ACK)。
 * 覆盖「中途选项 → 用户已作出选择 → 模型即将据此恢复」这段静默窗口(和提交→首 token 同构)。
 * 父门关则整体关(先判 isEnabled);子门单独 CANON 4 词({0,false,off,no})关。
 * flagRegistry 优先,本地 CANON 回退。绝不抛。
 */
function isSelectionEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  if (!isEnabled(e)) return false; // 父门关 → 整体关
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_FIRST_RESPONSE_ACK_SELECTION', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_FIRST_RESPONSE_ACK_SELECTION;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * resume 变体子门:KHY_FIRST_RESPONSE_ACK_RESUME(default-on,父门 KHY_FIRST_RESPONSE_ACK)。
 * 覆盖「一个工具刚返回 → 模型将据此续跑 → 首个恢复 chunk」这段静默窗口(和提交→首 token 同构,
 * 只是发生在工具循环迭代之间)。本回合最初的「提交守护」早被首 chunk markChunk 消费掉、
 * turnAck 也一回合至多一次 → 工具返回后模型迟迟不出下一 chunk 时又是一段像卡死的死寂。
 * 父门关则整体关(先判 isEnabled);子门单独 CANON 4 词({0,false,off,no})关。
 * flagRegistry 优先,本地 CANON 回退。绝不抛。
 */
function isResumeEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  if (!isEnabled(e)) return false; // 父门关 → 整体关
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_FIRST_RESPONSE_ACK_RESUME', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_FIRST_RESPONSE_ACK_RESUME;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * image 变体子门:KHY_FIRST_RESPONSE_ACK_IMAGE(default-on,父门 KHY_FIRST_RESPONSE_ACK)。
 * 覆盖「用户发出图片分析提示词 → 完整答复落地」之间那段**非流式** await 静默窗口:图片分析子流
 * (剪贴板/文件/粘贴)走 `await ai().chat(prompt,{images})`,**无 onChunk 流、无 markChunk**——
 * 只有一个长 await,期间终端全静默;视觉级联(vision→OCR)最耗时、最像卡死,且模型偶尔谎称
 * 「没收到图片」。一句「收到你的图片,正在识别分析…」既补窗口又即时确认「图片确已收到」。
 * 父门关则整体关(先判 isEnabled);子门单独 CANON 4 词({0,false,off,no})关。
 * flagRegistry 优先,本地 CANON 回退。绝不抛。
 */
function isImageEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  if (!isEnabled(e)) return false; // 父门关 → 整体关
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_FIRST_RESPONSE_ACK_IMAGE', e);
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const v = e.KHY_FIRST_RESPONSE_ACK_IMAGE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 首 token 静默窗口阈值(ms):超过它还没任何 chunk → 出提示。
 * 优先经 flagRegistry.resolveNumeric(已按 spec clamp [200,60000]、default 1200);
 * 注册表不可用时本地读 env + clamp。畸形/缺失 → 默认 1200。绝不抛。
 */
function firstResponseAckDelayMs(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (reg && typeof reg.resolveNumeric === 'function'
      && reg.FLAGS && reg.FLAGS.KHY_FIRST_RESPONSE_ACK_MS) {
      const n = reg.resolveNumeric('KHY_FIRST_RESPONSE_ACK_MS', e);
      if (Number.isFinite(n)) return n; // spec 已 clamp [200,60000]、default 1200
    }
  } catch { /* 注册表不可用 → 本地回退 */ }
  const raw = e.KHY_FIRST_RESPONSE_ACK_MS;
  const n = Number.parseInt(String(raw == null ? '' : raw).trim(), 10);
  if (!Number.isFinite(n)) return _DEFAULT_DELAY_MS;
  if (n < _MIN_DELAY_MS) return _MIN_DELAY_MS;
  if (n > _MAX_DELAY_MS) return _MAX_DELAY_MS;
  return n;
}

// wait-aware 短句(纯中文、单行、不复述用户原话)。按 turnIndex 轮换,治相邻回合字面重复。
// ≥2 条即保证相邻两轮不同;满一轮才回头。措辞刻意口语、都在传达「收到了·正在等模型·别急」。
const _ACK_LINES = [
  '收到，正在为你连接模型，请稍候…',
  '好的，khy 已收到，正在等模型开口…',
  '明白，正在处理你的请求，模型还在思考…',
  '收到了，稍等一下，模型马上就来…',
  '好，仍在等待模型响应，这就为你处理…',
];

// selection 变体短句:用户在中途选项里作出选择后、模型据此恢复流式前的静默窗口用。
// 措辞刻意传达「收到了你的选择·正在据此继续」,不复述用户选了什么(那由 qaEchoLines 静态回显)。
// 按 turnIndex 轮换,治相邻回合字面重复;≥2 条即保证相邻两轮不同。
const _SELECTION_ACK_LINES = [
  '收到你的选择，正在据此继续…',
  '好的，已按你的选择处理，请稍候…',
  '明白，正在依据你刚才的选择往下走…',
  '收到，正在据你的选择恢复处理…',
  '好，已记下你的选择，模型正在据此响应…',
];

// resume 变体短句:工具循环迭代之间——一个工具刚返回、模型据此续跑前的静默窗口用。
// 措辞刻意传达「工具已收到结果·正在继续处理·别急」,不复述工具结果内容(那已由 step 行渲染)。
// 按 turnIndex 轮换,治相邻回合字面重复;≥2 条即保证相邻两轮不同;与 submit/selection 句不重叠。
const _RESUME_ACK_LINES = [
  '工具已返回，正在继续处理…',
  '好的，收到工具结果，正在接着往下做…',
  '明白，正在根据刚才的结果继续推进…',
  '收到工具反馈，仍在为你处理，请稍候…',
  '好，正在消化工具结果并继续，马上就好…',
];

// image 变体短句:非流式图片分析子流——用户发出图片提示词、模型据此识别期间的静默窗口用。
// 措辞刻意先确认「图片确已收到」(反驳视觉级联偶发的「没收到图片」假阴性)再传达「正在识别·别急」,
// 不复述用户提示词原话。按 turnIndex 轮换,治相邻回合字面重复;≥2 条即保证相邻两轮不同;
// 与 submit/selection/resume 句均不重叠。
const _IMAGE_ACK_LINES = [
  '收到你的图片，正在识别分析，请稍候…',
  '好的，图片已收到，正在为你识别内容…',
  '明白，正在读取并分析这张图片，稍等…',
  '图片已接收，视觉识别进行中，马上就好…',
  '好，已拿到你的图片，正在据此分析…',
];

/**
 * 产出静默窗口内的等待回应句。
 *   { turnIndex, elapsedMs, env, variant } →
 *     ''      门控关 / 异常 → 不注入(逐字节回退无提示)
 *     短句    否则按 turnIndex 轮换取一句;elapsedMs ≥ 1000 时附「(已等待约 Ns)」
 * variant='selection' → 走 _SELECTION_ACK_LINES + selection 子门(isSelectionEnabled);
 * variant='resume' → 走 _RESUME_ACK_LINES + resume 子门(isResumeEnabled);
 * variant='image' → 走 _IMAGE_ACK_LINES + image 子门(isImageEnabled);
 * variant 缺省/'submit' → 走 _ACK_LINES + 父门(isEnabled),与历史行为逐字节一致。
 * turnIndex 非有效整数 → 钉为 0;elapsedMs 非有效 → 视作 0(不附后缀)。
 */
function computeFirstResponseAck(opts) {
  try {
    const { turnIndex, elapsedMs, env, variant } = opts || {};
    const v = (variant === 'selection' || variant === 'resume' || variant === 'image') ? variant : 'submit';
    const enabled = v === 'selection' ? isSelectionEnabled(env)
      : v === 'resume' ? isResumeEnabled(env)
        : v === 'image' ? isImageEnabled(env)
          : isEnabled(env);
    if (!enabled) return '';
    const lines = v === 'selection' ? _SELECTION_ACK_LINES
      : v === 'resume' ? _RESUME_ACK_LINES
        : v === 'image' ? _IMAGE_ACK_LINES
          : _ACK_LINES;
    const n = (Number.isInteger(turnIndex) && turnIndex >= 0) ? turnIndex : 0;
    let line = lines[n % lines.length];
    const ms = (Number.isFinite(elapsedMs) && elapsedMs >= 0) ? elapsedMs : 0;
    if (ms >= 1000) {
      const secs = Math.round(ms / 1000);
      line += `（已等待约 ${secs}s）`;
    }
    return line;
  } catch {
    return '';
  }
}

/**
 * 创建首响应静默窗口守护调度器(DI 计时器,可测)。
 *
 * opts:
 *   { turnIndex, env, variant, deps: { setTimeout, clearTimeout, emit, now } }
 *   - variant:'submit'(缺省)守护「提交 → 首 token」;'selection' 守护「中途选项已选 →
 *     模型据此恢复」;'resume' 守护「工具返回 → 模型据此续跑」;'image' 守护「图片提示词 →
 *     非流式 ai().chat 完整答复落地」的静默窗口(各走对应子门 + 句子表)。
 *   - emit(line):计时器到点且仍无 chunk 时的回调(接线方用它渲染 + 置 _turnAckEmitted)。
 *   - now():取当前毫秒(默认 Date.now);deps 缺省时回退到全局 setTimeout/clearTimeout/Date.now。
 *
 * 返回句柄:
 *   arm()       → 请求发出那刻调用。门控关 / 缺 emit / 缺 setTimeout / 已 arm / 已 done
 *                 → no-op 返回 false(逐字节回退无提示);否则挂计时器返回 true。
 *   markChunk() → 首个 chunk 到达(模型已开始响应)→ 取消未决提示。幂等。
 *   disarm()    → 请求边界(finally)兜底取消。幂等。
 *   get fired   → 是否真的 emit 过。
 *   get armed   → 是否成功挂过计时器。
 *
 * 绝不抛:所有方法 try/catch 吞异常。
 */
function createFirstResponseAckScheduler(opts) {
  const o = opts || {};
  const env = o.env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  const deps = o.deps || {};
  const _setTimeout = typeof deps.setTimeout === 'function'
    ? deps.setTimeout
    : (typeof setTimeout !== 'undefined' ? setTimeout : null);
  const _clearTimeout = typeof deps.clearTimeout === 'function'
    ? deps.clearTimeout
    : (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
  const _emit = typeof deps.emit === 'function' ? deps.emit : null;
  const _now = typeof deps.now === 'function'
    ? deps.now
    : (() => { try { return Date.now(); } catch { return 0; } });
  const turnIndex = (Number.isInteger(o.turnIndex) && o.turnIndex >= 0) ? o.turnIndex : 0;
  const variant = (o.variant === 'selection' || o.variant === 'resume' || o.variant === 'image') ? o.variant : 'submit';

  let _timer = null;
  let _armed = false;
  let _fired = false;
  let _done = false; // chunk 已到 / 已 disarm → 未来不再 emit
  let _startAt = 0;

  function _cancelTimer() {
    if (_timer != null && _clearTimeout) {
      try { _clearTimeout(_timer); } catch { /* ignore */ }
    }
    _timer = null;
  }

  return {
    arm() {
      try {
        if (_armed || _done) return false;
        const _gateOk = variant === 'selection' ? isSelectionEnabled(env)
          : variant === 'resume' ? isResumeEnabled(env)
            : variant === 'image' ? isImageEnabled(env)
              : isEnabled(env);
        if (!_gateOk) return false;
        if (!_setTimeout || !_emit) return false;
        _armed = true;
        _startAt = _now();
        const delay = firstResponseAckDelayMs(env);
        _timer = _setTimeout(() => {
          _timer = null;
          if (_done || _fired) return;
          let line = '';
          try {
            const elapsed = Math.max(0, _now() - _startAt);
            line = computeFirstResponseAck({ turnIndex, elapsedMs: elapsed, env, variant });
          } catch { line = ''; }
          if (!line) return;
          _fired = true;
          try { _emit(line); } catch { /* emit 失败不影响主流程 */ }
        }, delay);
        return true;
      } catch {
        return false;
      }
    },
    markChunk() {
      try {
        if (_done) return;
        _done = true;
        _cancelTimer();
      } catch { /* ignore */ }
    },
    disarm() {
      try {
        _done = true;
        _cancelTimer();
      } catch { /* ignore */ }
    },
    get fired() { return _fired; },
    get armed() { return _armed; },
  };
}

module.exports = {
  isEnabled,
  isSelectionEnabled,
  isResumeEnabled,
  isImageEnabled,
  firstResponseAckDelayMs,
  computeFirstResponseAck,
  createFirstResponseAckScheduler,
  _ACK_LINES,
  _SELECTION_ACK_LINES,
  _RESUME_ACK_LINES,
  _IMAGE_ACK_LINES,
  _DEFAULT_DELAY_MS,
  _MIN_DELAY_MS,
  _MAX_DELAY_MS,
};
