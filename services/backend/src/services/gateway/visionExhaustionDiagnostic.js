'use strict';

/**
 * visionExhaustionDiagnostic.js — 纯叶子:零 IO、确定性、绝不抛、可单测。
 *
 * 排障「识图反复失败却静默落 OCR/剪贴板兜底」收尾:generate 级联穷尽所有通道后
 * (aiGatewayGenerateMethod 末端 guidanceContent「所有 AI 通道均不可用」),对**带图**请求,
 * 若累计 attempts 里出现视觉专属的确定性失败信号,就把它翻译成**指名道姓**的可执行指引,
 * 供调用方前置到笼统兜底清单之前——而非让用户只看到「所有通道不可用」的墙:
 *
 *   ① model_not_found / 404 → 账号未领取该视觉新模型。glm-4.6v-flash 是 2025/12 才上的新模型,
 *      部分账号尚未实名/领取时官方端点回 404 model_not_found(端点/模型名/key 全对却调不通;
 *      见 glmVisionModel.js:28)。代码已有降级链(→ glm-4v-flash),但账号侧未领取代码改不动。
 *   ② rate_limit / 429 → bigmodel 账号被限流(智谱免费档 code 1302 并发/QPS 超限)。连久经考验
 *      的 glm-4v-flash 兜底也被限流打不通 → 级联耗尽。限流窗口是账号侧的事,代码只能提示降并发。
 *   ③ network → 视觉通道**网络不可达**(socket hang up / 连接被重置 / 代理隧道不通)。与 ①②正交:
 *      这是**传输层**故障——图确实收到,却因网络送不到视觉模型识别。用户实测第二发失败即此(「recent
 *      network failure cached: socket hang up」),历史上因本诊断只识 404/429 而落通用墙、丢失「图收
 *      到了、只是网络送不到」的诚实交代。独立子门 KHY_VISION_NETWORK_EXHAUSTION_DIAG(默认开)。
 *
 * 诚实边界:404(未领取)与 429(限流)都是用户 bigmodel 账号侧的事实,network 是传输层事实,代码
 * 无法代办;本叶子只把**已发生**的确定性信号翻译成可执行指引,不做任何写入 / 网络 / 重试 / 猜测,
 * 且**绝不谎称「没收到图」**(network 分支明确点出「图确实收到,只是网络送不到」)。
 *
 * 契约:纯叶子——零副作用、绝不抛(任何异常 → null)、只吃 { attempts, hasImageInput, env }。
 * 门控 KHY_VISION_EXHAUSTION_DIAG(parent KHY_GLM_VISION_MODEL,默认开);关门 → null(逐字节
 * 回退今日行为:直接落通用兜底墙,不前置任何诊断)。network 分支另受独立子门
 * KHY_VISION_NETWORK_EXHAUSTION_DIAG 约束(关 → 逐字节回退到只识 404/429)。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

// 门控 KHY_VISION_EXHAUSTION_DIAG:默认开;0/false/off/no → 关。异常 → 关门(false)。
function _enabled(env) {
  try {
    const raw = env && env.KHY_VISION_EXHAUSTION_DIAG;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

/**
 * 一条 attempt 是否命中「模型未领取 / 不存在」信号。
 * 判据(任一):errorType === 'model_not_found'、statusCode === 404、
 * 或 error 文本含 model_not_found / model not found / does not exist / code 1211(未开通)/ 未领取。
 * 绝不抛。
 * @param {object} att
 * @returns {boolean}
 */
function _isModelNotProvisioned(att) {
  try {
    if (!att) return false;
    if (att.errorType === 'model_not_found') return true;
    if (Number(att.statusCode) === 404) return true;
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /model_not_found|model not found|does not exist|code\s*1211|未开通|未领取/.test(msg);
  } catch {
    return false;
  }
}

/**
 * 一条 attempt 是否命中「限流」信号。
 * 判据(任一):errorType === 'rate_limit'、statusCode === 429、
 * 或 error 文本含 rate limit / too many requests / code 1302 / 429 / 请求过多 / 并发 / 限流。
 * 绝不抛。
 * @param {object} att
 * @returns {boolean}
 */
function _isRateLimited(att) {
  try {
    if (!att) return false;
    if (att.errorType === 'rate_limit') return true;
    if (Number(att.statusCode) === 429) return true;
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return /rate.?limit|too many requests|code\s*1302|(^|\D)429(\D|$)|请求过多|并发|限流/.test(msg);
  } catch {
    return false;
  }
}

// 网络不可达信号(socket hang up / 连接被重置 / 代理隧道不通 / DNS)。与 404(未领取)、429(限流)
// **正交**:前两者是账号侧事实,本条是**传输层**——图确实收到,却因网络送不到视觉模型识别。
// 刻意精确:只认具体网络故障串,**不含裸 timeout**(gateway idle timeout 等非视觉网络故障不误判,
// 保住既有「auth+timeout → null」契约)。用户实测第二发失败正是「recent network failure cached:
// socket hang up」,却因本诊断只识 404/429 而落通用兜底墙、丢失「图收到了、只是网络送不到」的诚实交代。
const _NETWORK_TEXT_RE =
  /socket hang up|econnreset|econnrefused|enetunreach|ehostunreach|etimedout|eai_again|getaddrinfo|socket disconnected|network (?:error|failure)|连接(?:被)?重置|连接超时|无法连接到|tunneling socket|proxy (?:error|tunnel)/i;

/**
 * 一条 attempt 是否命中「网络不可达 / 传输层失败」信号。
 * 判据(任一):errorType === 'network'、或 error 文本含 socket hang up / ECONNRESET / 代理隧道
 * 不通 等具体网络故障串。**刻意不认裸 timeout**(避免把 gateway idle timeout 误判为视觉网络故障)。
 * 绝不抛。
 * @param {object} att
 * @returns {boolean}
 */
function _isNetworkFailure(att) {
  try {
    if (!att) return false;
    if (att.errorType === 'network') return true;
    const msg = String(att.error == null ? '' : att.error).toLowerCase();
    return _NETWORK_TEXT_RE.test(msg);
  } catch {
    return false;
  }
}

// 网络不可达修复指引(查网络/代理、稍后重试,或粘贴图中文字)。
const _NETWORK_FIX = [
  '  → 检查网络/代理是否可达视觉端点(运行 `khy gateway status` 看实测状态;`/proxy` 配置代理),',
  '    稍后重试;或先把图中文字直接粘贴过来,我据此如实作答(绝不臆测或编造图中内容)。',
].join('\n');

// 网络不可达诊断的独立子门控 KHY_VISION_NETWORK_EXHAUSTION_DIAG(默认开)。与 parent
// KHY_VISION_EXHAUSTION_DIAG 正交:关(0/false/off/no)→ 本函数**看不见**网络信号,逐字节回退到
// 只识 404/429 的历史行为(网络-only 耗尽 → null 落通用墙;网络+429 → reason=rate_limited,与今日一致)。
function _networkEnabled(env) {
  try {
    const raw = env && env.KHY_VISION_NETWORK_EXHAUSTION_DIAG;
    const v = String(raw == null ? '' : raw).trim().toLowerCase();
    return !OFF_VALUES.includes(v);
  } catch {
    return false;
  }
}

// 未领取模型的修复指引(去 open.bigmodel.cn 实名领取,或改用 glm-4v-flash)。
const _NOT_PROVISIONED_FIX = [
  '  → 去 https://open.bigmodel.cn 完成实名认证,并在模型广场领取/开通 glm-4.6v-flash(永久免费);',
  '    或改用久经考验的 glm-4v-flash(多数账号默认即可调用)。',
].join('\n');
// 限流的修复指引(降并发、稍后重试)。
const _RATE_LIMITED_FIX = '  → 降低并发、别连发,稍等几分钟待限流窗口重置后重试。';

/**
 * 诊断视觉级联耗尽的确定性根因。绝不抛;不适用(门关 / 非带图 / 无 attempts / 无匹配信号 /
 * 任何异常)→ null。
 *
 * @param {object} a
 * @param {Array<object>} [a.attempts]   累计失败 attempts(带 errorType/statusCode/error)
 * @param {boolean} [a.hasImageInput]    本轮是否带图(仅带图请求才诊断——文本失败不适用)
 * @param {object} [a.env]               注入 env(可测;默认 process.env)
 * @returns {{ reason:'model_not_provisioned'|'rate_limited'|'both'|'network_unreachable'|'multiple', message:string } | null}
 */
function diagnoseVisionExhaustion({ attempts, hasImageInput, env } = {}) {
  try {
    const e = env || (typeof process !== 'undefined' ? process.env : {});
    if (!_enabled(e)) return null;
    if (!hasImageInput) return null;
    const list = Array.isArray(attempts) ? attempts : [];
    if (!list.length) return null;

    const netGateOn = _networkEnabled(e);
    let notProvisioned = false;
    let rateLimited = false;
    let networkFailed = false;
    for (const att of list) {
      if (!notProvisioned && _isModelNotProvisioned(att)) notProvisioned = true;
      if (!rateLimited && _isRateLimited(att)) rateLimited = true;
      // 网络信号仅在子门开时才可见 → 门关逐字节回退到只识 404/429 的历史行为。
      if (netGateOn && !networkFailed && _isNetworkFailure(att)) networkFailed = true;
      if (notProvisioned && rateLimited && (networkFailed || !netGateOn)) break;
    }
    if (!notProvisioned && !rateLimited && !networkFailed) return null;

    const lines = [];
    let reason;
    if (!networkFailed) {
      // 不含网络信号 → 原三分支逐字节不变(保住既有契约)。
      if (notProvisioned && rateLimited) {
        reason = 'both';
        lines.push('⚠ 识图失败叠加两因,均属账号侧(代码无法代办):');
        lines.push('① 未领取视觉新模型(404 model_not_found)。');
        lines.push(_NOT_PROVISIONED_FIX);
        lines.push('② 账号被限流(429 / code 1302)。');
        lines.push(_RATE_LIMITED_FIX);
      } else if (notProvisioned) {
        reason = 'model_not_provisioned';
        lines.push('⚠ 识图失败:当前账号未领取该视觉模型(官方端点回 404 model_not_found)。');
        lines.push(_NOT_PROVISIONED_FIX);
      } else {
        reason = 'rate_limited';
        lines.push('⚠ 识图失败:视觉模型所在账号被限流(429 / code 1302 并发或 QPS 超限)。');
        lines.push(_RATE_LIMITED_FIX);
      }
    } else {
      const causeCount = (notProvisioned ? 1 : 0) + (rateLimited ? 1 : 0) + 1;
      if (causeCount === 1) {
        // 纯网络不可达:传输层故障,图确实收到、只是送不到视觉模型。绝不谎称「没收到图」。
        reason = 'network_unreachable';
        lines.push('⚠ 识图失败:视觉通道网络不可达(如 socket hang up / 连接被重置 / 代理隧道不通)。');
        lines.push('  我确实收到了你的图片,但当前网络无法把它送达视觉模型识别 —— 这不是「没收到图」。');
        lines.push(_NETWORK_FIX);
      } else {
        // 网络 + 账号侧多因叠加:逐因列出(网络在先,因它是传输层、最直接可自查)。
        reason = 'multiple';
        lines.push('⚠ 识图失败叠加多因(图确实已收到,以下为各自根因):');
        lines.push('· 视觉通道网络不可达(socket hang up / 连接被重置 / 代理隧道不通)。');
        lines.push(_NETWORK_FIX);
        if (notProvisioned) {
          lines.push('· 未领取视觉新模型(404 model_not_found)。');
          lines.push(_NOT_PROVISIONED_FIX);
        }
        if (rateLimited) {
          lines.push('· 账号被限流(429 / code 1302)。');
          lines.push(_RATE_LIMITED_FIX);
        }
      }
    }
    return { reason, message: lines.join('\n') };
  } catch {
    return null;
  }
}

module.exports = {
  diagnoseVisionExhaustion,
  _isModelNotProvisioned,
  _isRateLimited,
  _isNetworkFailure,
};
