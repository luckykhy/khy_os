'use strict';

/**
 * cliFailureEnvelope.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 排障「CLI 失败墙看不懂」缺口:网关级联耗尽后,`aiChatCore.js` 把
 * `result.content`(一段已含真实诊断的散文)**截断 180 字符**当「失败信息」展示
 * (`.slice(0, 180)`),恰好把「⚠ 通道失败原因与下一步:」表头之后的机器码、通道名、
 * 钉选元原因全部切掉;再叠加 `_formatGatewayFailureDetails` +
 * `_buildRecoveryAttemptsNote` 两份近义散文,外加一张 12 行静态推广清单占据首屏。
 * 结果:用户知道「失败了」,但不知道**哪条通道、什么码、本轮路由是否被钉死**。
 *
 * 本叶子把同一份 `result` 翻译成**一个结构化信封**(见
 * `docs/03_DESIGN_设计/[DESIGN-ARCH-114] CLI 错误标准化规范.md` §2),供 CLI 直接渲染:
 *
 *   { ok:false, code, severity, title, cause, routing, hint[], attempts[], resumable?, traceId? }
 *
 * 三条硬约束(契约核心,不可放宽):
 *   ① `code` 单射互斥——自上而下首次命中即停,一次失败只落一个码;
 *   ② `PINNED_NO_FALLBACK` 是**元原因**,优先于 AUTH_FAILED / MODEL_NOT_FOUND 等表象
 *      (2026-09-13→15 连续三天把「strict 钉死」误诊为「密钥失效」,即因码序错);
 *   ③ `hint` 非空时,**静态推广清单不得进入首屏**——清单只在
 *      `code === 'CHANNEL_EXHAUSTED'` 且无更具体信号时出现。
 *
 * 诚实边界:只翻译**已发生**的信号(复用 gatewayErrorClassifier 的 errorType 与
 * buildChannelFailureAdvice 的既有判据),不做任何写入/网络/重试/猜测。
 *
 * 契约:纯叶子——零副作用、绝不抛(任何异常 → 返回 CHANNEL_EXHAUSTED 兜底信封)、
 * 只吃 { result, env }。门控 KHY_CLI_FAILURE_ENVELOPE(默认开);关门 →
 * `{ enabled:false }`,调用方逐字节回退今日的 `errorMsg` 拼接路径。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _enabled(env) {
  try {
    const raw = env && env.KHY_CLI_FAILURE_ENVELOPE;
    const v = String(raw == null ? '' : raw)
      .trim()
      .toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/** 归一化 errType:小写去空白。绝不抛。 */
function _normType(v) {
  try {
    return String(v == null ? '' : v)
      .trim()
      .toLowerCase();
  } catch {
    return '';
  }
}

/**
 * 从 attempts 抽出「主因」——按 failureReasonRanking 的 live-优先语义取首条非缓存记录。
 * 绝不抛;无 attempts → null。
 * @param {Array} attempts
 * @returns {object|null}
 */
function _pickPrimaryCause(attempts) {
  try {
    const list = Array.isArray(attempts) ? attempts.filter((a) => a && a.success === false) : [];
    if (!list.length) {
      return null;
    }
    // live 优先:virtualSkip / statusCode===0 且文本含 cached 的是陈旧缓存跳过,排后。
    let ranked = list;
    try {
      const { rankFailedAttempts } = require('./failureReasonRanking');
      const r = rankFailedAttempts(list, process.env);
      if (Array.isArray(r) && r.length) {
        ranked = r;
      }
    } catch {
      /* 排序不可用 → 原序 */
    }
    const a = ranked.find((x) => !(x && x.virtualSkip === true)) || ranked[0];
    return {
      adapter: String((a && (a.adapterKey || a.provider)) || 'unknown').trim() || 'unknown',
      statusCode: Number.isFinite(Number(a && a.statusCode)) ? Number(a.statusCode) : 0,
      errorType: _normType(a && a.errorType) || 'unknown',
      detail: String((a && (a.error || a.message)) || 'unknown error')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300),
      virtualSkip: !!(a && a.virtualSkip === true),
    };
  } catch {
    return null;
  }
}

/**
 * 判定本轮路由是否为「钉选且回退被抑制」——元原因判据。
 * 与 aiGatewayGenerateMethod 的 pin 语义保持一致:显式布尔用其值,
 * 其余情况「未显式 false 即视为开启」。绝不抛。
 *
 * **零尝试 ≠ 回退被抑制**(2026-09-23 修正,见 [DESIGN-ARCH-136])。
 * 旧判据把 `keys.size === 0`(一条失败记录都没有)也算作「钉选抑制了回退」,
 * 依据是「无 attempts 元信息时保守取真」。但那把**未知**伪装成了**已知**:
 * 「一次都没试过」与「试了被拦住」是两个不同的事实 —— 前者根本没走到回退那一步,
 * 说它「本轮不回退」是**编造因果**。实测(generate 末端在 `allAttempts.length === 0`
 * 时把 errorType 硬赋 'unknown'):
 *   ⚠本次请求未能完成 / [NONE] / 路由: 钉选 strict(GATEWAY_PREFERRED_ADAPTER=api),本轮不回退
 * 用户据此去解钉,而真相是通道级联压根没被进入。
 * ⇒ 零记录单独成一个 mode('unresolved')与一个字段(attempted:false)。
 *
 * @param {object} result
 * @returns {{mode: string, preferred: string, fallbackSuppressed: boolean,
 *            pinned: boolean, attempted: boolean}}
 */
function _resolveRouting(result) {
  const fallback = {
    mode: 'auto',
    preferred: '',
    fallbackSuppressed: false,
    pinned: false,
    attempted: true,
  };
  try {
    // 「有没有失败记录」必须**早于** preferred 判定 —— 否则「无钉选 + 零尝试」
    // 会直接走 fallback(attempted 默认 true),把同一个事实在另一条分支上丢掉。
    const attempts = Array.isArray(result && result.attempts)
      ? result.attempts.filter((a) => a && a.success === false)
      : [];
    const keys = new Set(
      attempts.map((a) => String((a && (a.adapterKey || a.adapter)) || '').trim()).filter(Boolean)
    );
    const attempted = keys.size > 0;
    const preferred = String((result && result.preferredAdapter) || '').trim();
    if (!preferred || preferred.toLowerCase() === 'auto') {
      return { ...fallback, attempted };
    }
    // 零尝试:一条失败记录都没有 → 既不声称「钉选抑制」(pinned:false),
    // 也不声称「已回退过」(mode 不是 preferred-with-fallback)。事实就是事实。
    if (!attempted) {
      return {
        mode: 'unresolved',
        preferred,
        fallbackSuppressed: false,
        pinned: false,
        attempted: false,
      };
    }
    // 本轮只试过被钉的那一个通道 → 回退确实被抑制(与 generate 末端判定同构)。
    const suppressed = keys.size === 1 && keys.has(preferred);
    if (!suppressed) {
      return { ...fallback, preferred, mode: 'preferred-with-fallback' };
    }
    return {
      mode: 'pinned-strict',
      preferred,
      fallbackSuppressed: true,
      pinned: true,
      attempted: true,
    };
  } catch {
    return fallback;
  }
}

const PIN_HINT = (adapter) => [
  `解除钉选:把 GATEWAY_PREFERRED_ADAPTER 清空或设为 auto(当前钉在 "${adapter}")`,
  '并设 GATEWAY_PREFERRED_STRICT=false(services/backend/.env 或 ~/.khy/.env)',
  '改完运行 `khy gateway status` 复核实测通道',
];

const HINTS = {
  AUTH_FAILED: ['运行 `ai config` 检查/更新该通道的 API key', '确认账号余额与权限后重试'],
  AUTH_FAILED_PINNED: [
    '运行 `ai config` 检查/更新该通道的 API key(401/403 是通道侧的真实拒绝)',
    '若该通道本就不该被钉:把 GATEWAY_PREFERRED_ADAPTER 清空或设为 auto 并设 GATEWAY_PREFERRED_STRICT=false',
  ],
  CHANNEL_ABSENT_PINNED: [
    '该通道在本机不存在或未启用,且 strict 抑制了回退',
    '把 GATEWAY_PREFERRED_ADAPTER 清空或设为 auto,并设 GATEWAY_PREFERRED_STRICT=false',
    '改完运行 `khy gateway status` 复核实测通道',
  ],
  RATE_LIMITED: ['降低并发、别连发', '稍等几分钟待限流窗口重置后重试'],
  UPSTREAM_ERROR: ['稍等片刻重试', '若持续:运行 `khy gateway status` 检查通道,或 `/proxy` 检查代理'],
  NETWORK_ERROR: ['运行 `/proxy` 配置代理,或检查网络连通性', '运行 `khy gateway status` 看实测状态'],
  TIMEOUT: ['稍后说「继续」自动重试', '检查网络/代理后重试'],
  MODEL_NOT_FOUND: ['运行 `/model` 查看可用模型并切换', '或在厂商控制台领取/开通该模型'],
  CONTEXT_TOO_LONG: ['运行 `/compact` 压缩上下文', '或新建会话后重试'],
  CHANNEL_UNAVAILABLE: ['运行 `khy gateway status` 查看各通道实测状态', '运行 `khy gateway model` 改选可用通道'],
  CANCELLED: [],
  CHANNEL_EXHAUSTED: [
    '运行 `khy gateway status` 查看各通道实测状态',
    '运行 `ai config` 配置一个可用通道的密钥',
  ],
  NO_ATTEMPT: [
    '本轮未进入任何通道级联:通道注册表为空,或全部通道未启用/未就绪',
    '运行 `khy gateway status` 确认各通道是否已注册且可用',
    '若 `.env` 里有 GATEWAY_PREFERRED_ADAPTER 钉选,清空或设为 auto 后重试',
  ],
  NONE: ['运行 `khy doctor` 自检', '运行 `khy gateway status` 查看通道状态'],
};

const TITLES = {
  PINNED_NO_FALLBACK: '本次请求未能完成 —— 首选通道被钉选,回退已抑制',
  AUTH_FAILED_PINNED: '本次请求未能完成 —— 认证失败(通道被钉选,回退已抑制)',
  CHANNEL_ABSENT_PINNED: '本次请求未能完成 —— 被钉选的通道不存在或未启用',
  CHANNEL_UNAVAILABLE: '本次请求未能完成 —— 目标通道不可用',
  AUTH_FAILED: '本次请求未能完成 —— 认证失败',
  RATE_LIMITED: '本次请求未能完成 —— 通道被限流',
  UPSTREAM_ERROR: '本次请求未能完成 —— 上游服务异常',
  NETWORK_ERROR: '本次请求未能完成 —— 网络不可达',
  TIMEOUT: '本次请求未能完成 —— 请求超时',
  MODEL_NOT_FOUND: '本次请求未能完成 —— 模型不存在',
  CONTEXT_TOO_LONG: '本次请求未能完成 —— 上下文超限',
  CANCELLED: '请求已取消',
  CHANNEL_EXHAUSTED: '本次请求未能完成 —— 所有 AI 通道均不可用',
  NO_ATTEMPT: '本次请求未能完成 —— 本轮未尝试任何通道',
  NONE: '本次请求未能完成',
};

/**
 * 判定一条 attempt 是否「通道根本不存在/未启用」——即钉选元原因的证据。
 * 判据:errorType==='unavailable' 且 statusCode 为 0/缺失(非 HTTP 拒绝,而是路由层直接判死),
 * 或消息文本命中 not registered / disabled by configuration / not installed。
 * 绝不抛。
 * @param {object} cause
 * @returns {boolean}
 */
function _isChannelAbsent(cause) {
  try {
    if (!cause) {
      return false;
    }
    const t = _normType(cause.errorType);
    const sc = Number(cause.statusCode) || 0;
    const msg = _normType(cause.detail);
    if (/not registered|disabled by configuration|not installed|is not registered/.test(msg)) {
      return true;
    }
    return t === 'unavailable' && sc === 0;
  } catch {
    return false;
  }
}

/**
 * 由 errorType 判定 CLI 机器码。**自上而下首次命中即停**(单射互斥)。
 *
 * 钉选优先的**严格边界**(2026-09-17 修正):只有当「通道本身不存在/未启用」被证实时,
 * 钉选才是解释性元原因(如 `windsurf disabled by configuration` → 解钉才对)。
 * 若被钉的通道给出了**真实的 HTTP 拒绝**(401/403/404/429/5xx),那是通道侧的事实,
 * 必须照实报 AUTH_FAILED 等,**不得**用「是钉选问题」掩盖 —— 否则会犯下与
 * 2026-09-13→15 相反的同类错误(那次是把钉选误诊为密钥,这次会是把密钥误诊为钉选)。
 * 两种情形都保留「回退被抑制」的披露,只是码与首条 hint 不同。
 *
 * **零尝试的兜底位置(2026-09-23,[DESIGN-ARCH-136])**:`NO_ATTEMPT` 刻意挂在
 * **兜底位**(替代 'NONE'),而**不是**挂在最前面当最高优先级。原因是本文件自身
 * 已有一批**不依赖 primaryCause** 的分支(auth / rate_limit / server_error / network /
 * timeout / model_not_found / context_length / unavailable)——它们只看顶层 errorType。
 * 若把 NO_ATTEMPT 提到最前,会把「零记录但 errorType 明说是认证失败」也压成
 * 「未尝试任何通道」,等于**用新误报换掉旧误报**(与契约②的教训同型)。
 * 正解:零记录 + 有已知类型信号 → 照实报该类型;零记录 + 无任何信号 → 才报 NO_ATTEMPT。
 *
 * 绝不抛。
 * @param {object} ctx { errorType, routing, primaryCause }
 * @returns {string}
 */
function _resolveCode(ctx) {
  try {
    const { routing, errorType, primaryCause } = ctx;
    const t = _normType(errorType);
    const sc = Number(primaryCause && primaryCause.statusCode) || 0;
    const msg = _normType(primaryCause && primaryCause.detail);
    const pinned = !!(routing && routing.pinned && routing.fallbackSuppressed);

    // ① 钉选 + 通道确实不存在 → 元原因是钉选,报可解钉的专项码。
    if (pinned && _isChannelAbsent(primaryCause)) {
      return 'CHANNEL_ABSENT_PINNED';
    }
    // ② 钉选 + 通道存在但真的拒绝了 → 照实报通道侧事实,但在标题披露回退被抑制。
    if (pinned && (t === 'auth' || t === 'permission' || sc === 401 || sc === 403)) {
      return 'AUTH_FAILED_PINNED';
    }
    if (t === 'cancelled') {
      return 'CANCELLED';
    }
    if (t === 'auth' || t === 'permission' || sc === 401 || sc === 403) {
      return 'AUTH_FAILED';
    }
    if (t === 'rate_limit' || sc === 429) {
      return 'RATE_LIMITED';
    }
    if (t === 'server_error' || (sc >= 500 && sc <= 599)) {
      return 'UPSTREAM_ERROR';
    }
    if (t === 'network') {
      return 'NETWORK_ERROR';
    }
    if (t === 'timeout') {
      return 'TIMEOUT';
    }
    if (t === 'model_not_found' || sc === 404) {
      return 'MODEL_NOT_FOUND';
    }
    if (t === 'context_length' || sc === 413) {
      return 'CONTEXT_TOO_LONG';
    }
    if (t === 'unavailable' || /not registered|disabled by configuration|not installed/.test(msg)) {
      return 'CHANNEL_UNAVAILABLE';
    }
    // 兜底:没有任何已知类型的失败信号。
    // 此时若一条失败记录都没有,那是**可自证的事实**(通道级联未被进入)→ 报 NO_ATTEMPT;
    // 否则维持 NONE(有尝试、但类型未知)。判据取 routing.attempted 而非 primaryCause:
    // 前者精确表达「零记录」,后者为 null 还可能是记录形状不符(同样无从定位,一并报零尝试)。
    return routing && routing.attempted === false ? 'NO_ATTEMPT' : 'NONE';
  } catch {
    return 'NONE';
  }
}

/**
 * 构造 CLI 失败信封。绝不抛:任何异常 → 返回 CHANNEL_EXHAUSTED 兜底信封。
 *
 * @param {object} input
 * @param {object} [input.result]  gateway 失败结果({success:false, errorType, attempts, preferredAdapter, resumable, …})
 * @param {object} [input.env]     注入 env(可测;默认 process.env)
 * @returns {{enabled:boolean, ok:boolean, code:string, severity:string, title:string,
 *            cause:object|null, routing:object, hint:string[], attempts:Array,
 *            resumable:boolean, showPromoPanel:boolean}}
 */
function buildCliFailureEnvelope(input) {
  try {
    const { result, env } = input && typeof input === 'object' ? input : {};
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!_enabled(e)) {
      return { enabled: false };
    }
    const r = result && typeof result === 'object' ? result : {};
    const attempts = Array.isArray(r.attempts) ? r.attempts : [];
    const primaryCause = _pickPrimaryCause(attempts);
    const routing = _resolveRouting(r);
    const code = _resolveCode({
      errorType: r.errorType,
      routing,
      primaryCause,
    });

    // hint:钉选类码 → 解钉三连;否则 → 该码的标准 hint。
    let hint;
    if (code === 'PINNED_NO_FALLBACK') {
      hint = PIN_HINT(routing.preferred);
    } else if (code === 'CHANNEL_ABSENT_PINNED') {
      hint = HINTS.CHANNEL_ABSENT_PINNED.slice();
    } else if (code === 'AUTH_FAILED_PINNED') {
      hint = HINTS.AUTH_FAILED_PINNED.slice();
    } else {
      hint = (HINTS[code] || HINTS.NONE).slice();
    }
    if (!Array.isArray(hint)) {
      hint = [];
    }
    // [DESIGN-ARCH-139] 一期:NO_ATTEMPT 的首条 hint 从猜测改为实数。generate 末端
    // 会在失败结果上附带 registryFacts(注册 N 条 / enabled M 条 / 钉选 X),有则
    // 用实况替换「注册表为空,或全部通道未启用/未就绪」的猜测行;无字段则原样回退。
    if (code === 'NO_ATTEMPT' && r.registryFacts && typeof r.registryFacts === 'object') {
      const f = r.registryFacts;
      const factLine =
        `通道注册表实况:注册 ${Number(f.registered) || 0} 条 / enabled ${Number(f.enabled) || 0} 条` +
        (f.strictPinned ? ` / strict 钉选 "${String(f.preferred || '')}"` : '');
      hint = [factLine, ...hint.slice(1)];
    }

    // 静态推广清单只在「确实没有任何可执行建议」时才允许占首屏(ARCH-114 §2.2 红线 R-GW-1)。
    const showPromoPanel = hint.length === 0 || code === 'CHANNEL_EXHAUSTED';

    return {
      enabled: true,
      ok: false,
      code,
      severity: code === 'CANCELLED' ? 'info' : 'error',
      title: TITLES[code] || TITLES.NONE,
      cause: primaryCause,
      routing,
      hint,
      attempts,
      resumable: r.resumable === true,
      showPromoPanel,
    };
  } catch {
    return {
      enabled: true,
      ok: false,
      code: 'CHANNEL_EXHAUSTED',
      severity: 'error',
      title: TITLES.CHANNEL_EXHAUSTED,
      cause: null,
      routing: { mode: 'auto', preferred: '', fallbackSuppressed: false, pinned: false },
      hint: HINTS.CHANNEL_EXHAUSTED.slice(),
      attempts: [],
      resumable: false,
      showPromoPanel: true,
    };
  }
}

/**
 * 渲染信封首屏(≤ 8 行,ARCH-114 §2.2)。绝不抛;空信封 → ''。
 *
 * @param {object} envelope buildCliFailureEnvelope 的产出
 * @returns {string}
 */
function renderCliFailureEnvelope(envelope) {
  try {
    const v = envelope && typeof envelope === 'object' ? envelope : {};
    if (!v.enabled || v.ok !== false) {
      return '';
    }
    const lines = [`⚠ ${v.title}`, `[${v.code}]`];
    if (v.cause) {
      const sc = v.cause.statusCode ? ` (${v.cause.statusCode})` : '';
      lines.push(`通道: ${v.cause.adapter}${sc} [${v.cause.errorType}] — ${v.cause.detail}`);
    }
    if (v.routing && v.routing.mode === 'pinned-strict') {
      lines.push(`路由: 钉选 strict(GATEWAY_PREFERRED_ADAPTER=${v.routing.preferred}),本轮不回退`);
    }
    for (const h of Array.isArray(v.hint) ? v.hint : []) {
      lines.push(`→ ${h}`);
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

/**
 * 诊断信息量的序 —— 供 [DESIGN-ARCH-136] 第 2 期的「诊断择优」使用。
 *
 * 唯一消费者是 `aiChatCore` 的**自动回退重试**分支:首次结果与重试结果都失败时,
 * 旧实现**无条件**用重试结果覆盖首次结果(其注释自述 *Always surface the retry
 * outcome*),于是「被钉通道未启用」这类可解钉、有明确下一步的诊断
 * (CHANNEL_ABSENT_PINNED,带 cause)会被「零尝试」或 NONE(零信息)覆盖 ——
 * 用户反而丢掉了唯一的线索。本函数只回答一个问题:**哪个信封能告诉用户更多**。
 *
 * 判据(强 → 弱):
 *   有 cause(能指名通道 / 状态码 / 错误类型 / 详情)= 100
 *   无 cause 且 code 是 NO_ATTEMPT(可自证的事实) = 2
 *   无 cause 的其余码(如 CANCELLED,语义确定但没有主因通道) = 1
 *   code 为 NONE(纯粹的未知) = 0
 * ⚠️ **只分档,不在码之间排序**:没有客观依据说「401 比 unavailable 更具体」,
 * 所以两个都带 cause 的信封视为同档。调用方按 `retry < first` 判定保留 ⇒
 * 同档时**不**触发保留,维持「照旧覆盖」的最小惊讶行为。
 * 不可比较(信封未启用 / 不是失败信封 / 任何异常)→ -1,调用方据此退回旧行为。
 *
 * 纯叶子:零 IO、确定性、绝不抛。
 * @param {object} envelope buildCliFailureEnvelope 的产出
 * @returns {number} -1 = 不可比较;否则越大信息量越高
 */
function _diagnosticRank(envelope) {
  try {
    const v = envelope && typeof envelope === 'object' ? envelope : {};
    if (!v.enabled || v.ok !== false) {
      return -1;
    }
    if (v.cause) {
      return 100;
    }
    if (v.code === 'NO_ATTEMPT') {
      return 2;
    }
    return v.code === 'NONE' ? 0 : 1;
  } catch {
    return -1;
  }
}

module.exports = {
  buildCliFailureEnvelope,
  renderCliFailureEnvelope,
  _diagnosticRank,
  _enabled,
  _resolveCode,
  _resolveRouting,
  _pickPrimaryCause,
};
