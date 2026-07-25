'use strict';

/**
 * visionOcrFallback.js — 「带图请求在某通道失败后，是否退回本地 OCR 把图转文本
 * 喂给模型」的确定性决策单一真源。
 *
 * 背景（用户目标 2026-06-27「给 khy 中使用的所有模型装上眼睛」）：khy 此前只要遇到
 * 图片就可能 404 —— 当前选中模型被「相信」支持视觉（如 sensenova-6.7-flash-lite 在
 * BUILTIN_VISION_MODELS 里），于是 decideVisionRouting 返回 keep、把图直接发给它，
 * 而该模型/通道实际不存在或不收图 → 上游 404（model_not_found）。prep 期的
 * decideVisionRouting 只在「模型被判定为纯文本且无视觉兄弟」时才退回 OCR，命中不了
 * 这种「以为能识图、实际 404」的情形；而 cascade 里早已设计好的 OCR 兜底消费者
 * （aiGateway 读 result._visionFallback）却从来没有任何代码去置位它 —— 兜底是死的。
 *
 * 本叶子补的就是那个缺失的「触发判定」：一次**带图**请求在某适配器上以**模型拒绝**
 * 类错误（404 / 400 / model_not_found / bad_request / 明确「不支持图像/视觉」）失败时，
 * 应当退回 OCR —— 用本仓既有的本地 Tesseract OCR（ocrSnippetService）把图转成文本，
 * 让**任何**模型（哪怕纯文本）也能「看见」图片内容，而不是把 404 直接甩给用户。
 * 这正是用户给的 deepseek-ocr 项目的方法论（「模型从不真的看图，它读 OCR 结果」），
 * 而 khy 已自带等价的 OCR 引擎，故复用引擎、只补这一处接线（懒人阶梯第 2 档：复用既有）。
 *
 * 「什么算模型拒绝信号」复用 failureExplainer.isModelRejection（单一真源），本叶子只
 * 另加一条针对适配器把错误只写进消息串（无结构化 code）时的文本兜底正则。
 *
 * 纯叶子：零 IO、确定性、绝不抛、单一真源（仅引用同目录纯叶子 failureExplainer）。
 * env 门控 KHY_VISION_OCR_FALLBACK（默认开，仅显式 0/false/off/no 关闭；关闭后
 * shouldOcrRescue 恒返回 false，行为字节回退到原 404 路径）。env 经 opts 注入可测。
 */

const { isModelRejection } = require('./failureExplainer');

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门控判定。默认开，仅显式 0/false/off/no 关闭。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_VISION_OCR_FALLBACK;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * describe-and-return 级联**全部失败**后,是否**无条件**执行「剥图 + OCR 兜底 +
 * 『图片确实收到但读不出』诚实底线」——**与人可见失败说明门 KHY_VISION_FAILURE_SUMMARY 解耦**。
 *
 * 背景(2026-07-12 用户实测「Khy 无法正确读图」失败现象):aiGatewayGenerateMethod 里视觉描述级联
 * 全失败后,那段「剥图 + OCR + 底线」的**安全不变量**代码被错误地嵌进 `if (_summaryOn)`
 * (_summaryOn = 失败说明门,纯装饰)。当用户把失败说明门关掉时,底线被一并跳过 → 控制流落到
 * switch 替换,把读不出的图**留着**改投**刚刚 404 的视觉模型**,最终文本模型在**毫无「图片存在」
 * 说明**下作答,于是如实却荒谬地回「消息里没有附带图片 / 当前对话中没有任何图片附件」。
 *
 * 本门把「底线」与「失败说明」拆开:default-on,仅显式 0/false/off/no 关闭。开(默认)→ 无论是否
 * 展示失败说明,描述级联全失败时都剥图 + OCR + 底线,保证「非视觉模型永不收到裸图」且「绝不谎称
 * 没收到图」两不变量;关 → 调用方逐字节回退历史行为(底线仅在 _summaryOn 触发)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isDescribeFailFloorEnabled(env) {
  const v = (env || process.env || {}).KHY_VISION_DESCRIBE_FAIL_OCR_FLOOR;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// 适配器有时把 404 / 不支持图像只写进 error/message 文本而无结构化 code/errorType。
// 这条正则只在结构化信号缺位时兜底；刻意精确，避免把普通错误误判成「该 OCR 兜底」。
const _REJECTION_TEXT_RE =
  /\b404\b|\b400\b|model_not_found|model not found|no such model|model does not exist|unknown model|(?:not|does not|cannot|can't)\s+(?:support|process|read|handle)\s+(?:image|images|vision|multimodal|picture)|unsupported\s+(?:image|vision|media|modality)|vision\s+not\s+supported|image\s+input\s+not\s+supported/i;

/**
 * 单个适配器失败结果是否属于「OCR 能救」的模型拒绝类失败。
 * 复用 failureExplainer.isModelRejection 判结构化信号，再加消息文本兜底。
 * @param {{success?:boolean, statusCode?:number, status?:number, code?:number,
 *          errorType?:string, error?:string, message?:string}} result
 * @returns {boolean}
 */
function isModelRejectionResult(result) {
  if (!result || result.success !== false) return false;
  if (isModelRejection(result)) return true; // 结构化 code/errorType（单一真源）
  const txt = `${result.error || ''} ${result.message || ''} ${result.errorType || ''}`;
  return _REJECTION_TEXT_RE.test(txt);
}

/**
 * 决策：这次失败是否应退回本地 OCR 给模型「装眼睛」。
 * 仅当 ① 门控开 ② 本次确实带图 ③ 失败结果带模型拒绝信号 三者皆真时为 true。
 * 纯决策，不做 OCR、不改任何状态——执行交回 aiGateway。
 * @param {object} input
 * @param {object} input.result     某适配器的失败结果
 * @param {boolean} input.hasImage  本次请求是否携带图像
 * @param {object} [input.env]
 * @returns {boolean}
 */
function shouldOcrRescue(input = {}) {
  const { result, hasImage } = input;
  if (!isEnabled(input.env)) return false;
  if (!hasImage) return false;
  return isModelRejectionResult(result);
}

// ── 限流(429/瞬态)终局 OCR 兜底 ────────────────────────────────────────────
// 背景(用户报 2026-07「一发送图片就 429、图片不会被正确识别」):既有 shouldOcrRescue
// 只对「模型拒绝」类错误(404/model_not_found/不支持图像)退回 OCR,**刻意不含 rate_limit**——
// 因为限流是瞬态的,别的视觉通道可能仍健康,中途从健康通道抢图去做 OCR 是错的。
// 但当**所有**视觉通道都被限流(429):级联穷尽 / 缓存冷却短路,此刻已无通道可走,用户手里
// 却握着一张(常含文字的)截图,而本仓自带本地 Tesseract OCR。此时最诚实、最有用的做法是
// 退回 OCR 把图中文字读出来据实作答,而不是甩一个 429 让用户干等冷却窗口。
//
// 故本判定与 shouldOcrRescue 正交:仅在**终局**(无健康通道)且**握图**且错误属瞬态类时为真。
// 独立门控 KHY_VISION_RATE_LIMIT_OCR(默认开,单独字节回退),不与 KHY_VISION_OCR_FALLBACK 混。
const _RATE_LIMIT_OCR_ERROR_TYPES = new Set(['rate_limit', 'overloaded', 'timeout', 'network']);

/**
 * 限流 OCR 兜底门控。默认开,仅显式 0/false/off/no 关闭。独立于 KHY_VISION_OCR_FALLBACK。
 * @param {object} [env]
 * @returns {boolean}
 */
function isRateLimitOcrEnabled(env) {
  const v = (env || process.env || {}).KHY_VISION_RATE_LIMIT_OCR;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 决策:视觉路径限流/瞬态失败的**终局**,是否退回本地 OCR 给用户读图中文字。
 * 仅当 ① 门控开 ② 本次握图 ③ 错误类型属瞬态类(rate_limit/overloaded/timeout/network)
 * 三者皆真时为 true。调用方须自行保证这是终局(无健康通道可走),本叶子只做纯类型判定。
 * @param {object} input
 * @param {string} input.errorType  终局错误类型(如 allAttempts 末条 / 缓存冷却的 errorType)
 * @param {boolean} input.hasImage  本次请求是否携带图像
 * @param {object} [input.env]
 * @returns {boolean}
 */
function shouldRateLimitOcrRescue(input = {}) {
  const { errorType, hasImage } = input;
  if (!isRateLimitOcrEnabled(input.env)) return false;
  if (!hasImage) return false;
  return _RATE_LIMIT_OCR_ERROR_TYPES.has(String(errorType || '').trim().toLowerCase());
}

// 限流 OCR 兜底注入文案首行标记,供调用方去重。
const RATE_LIMIT_OCR_NOTE_MARKER = '[视觉通道限流·本地 OCR 兜底]';

/**
 * 产出「视觉通道被限流、已退回本地 OCR」时前置给模型的诚实指令。
 * 与 buildVisionUnreadableNote 同哲学(诚实交代降级),但那条是「读不出」,这条是「限流故走 OCR」。
 * 门控关 → 返回 null(调用方据此字节回退)。纯字符串构造,绝不抛。
 * @param {object} [input]
 * @param {number} [input.count]  本次附带的图片张数(措辞用)
 * @param {object} [input.env]
 * @returns {string|null}
 */
function buildRateLimitOcrNote(input = {}) {
  try {
    if (!isRateLimitOcrEnabled(input.env)) return null;
    const n = Number.isFinite(input.count) && input.count > 0 ? Math.floor(input.count) : 0;
    const countPart = n > 0 ? `${n} 张图片` : '图片';
    return [
      `${RATE_LIMIT_OCR_NOTE_MARKER} 当前所有可用视觉模型都被上游限流(HTTP 429),暂时无法调用模型直接识图。`,
      `已用本地 OCR 从用户本轮上传的${countPart}中提取到以下文字,请据此如实作答,务必遵守:`,
      '  1) 明确告知用户「视觉通道当前被限流,以下内容来自本地 OCR 文字识别」——不要假装是模型看图的结果;',
      '  2) 只依据下方 OCR 文本作答,绝不臆测或编造图中未出现的内容;',
      '  3) 若 OCR 文本不足以回答,提示用户稍后重试(限流通常几十秒内自动恢复)或改用支持视觉的模型',
      '     (运行 `khy gateway model` 选择)。',
    ].join('\n');
  } catch {
    return null;
  }
}

// 注入文案首行标记,供调用方去重(prompt 已含本段则不重复注入)。
const UNREADABLE_NOTE_MARKER = '[图像无法读取]';

/**
 * 产出「带图、但既无视觉能力又 OCR 取不到文字」时注入 prompt 的诚实指令(面向模型)。
 *
 * 背景:非视觉模型走 OCR 兜底,而 OCR 也提取不到文本时(常见:非文字类图像如照片/场景,
 * 或缺对应语言字库),aiGateway 原先**静默丢图、什么都不告诉模型** → 模型收到一条没有图
 * 也没有任何说明的纯文本消息,于是如实却荒谬地回「我没有收到可识别的图片」。这条注入把
 * 「图收到了、但读不出」的事实如实交给模型,命令它大方承认 + 给方案,**绝不谎称没收到图**。
 *
 * 这与 attachmentFailurePolicy.buildUnreadableAttachmentMessage 同一「诚实承认载荷读不了」
 * 哲学,但那条是**请求失败后**前置给用户看的;本条是**请求仍会成功(模型照常作答)**时注入
 * prompt、让模型自己说对话——两个不同接缝,故文案分置各自接缝的单一真源。
 *
 * 纯字符串构造:零 IO、确定性、绝不抛。门控关 → 返回 null(调用方据此字节回退原行为)。
 *
 * @param {object} [input]
 * @param {number} [input.count]  本次附带且读不出的图片张数(用于措辞,缺省泛化)
 * @param {object} [input.env]
 * @returns {string|null}
 */
function buildVisionUnreadableNote(input = {}) {
  try {
    if (!isEnabled(input.env)) return null;
    const n = Number.isFinite(input.count) && input.count > 0 ? Math.floor(input.count) : 0;
    const countPart = n > 0 ? `${n} 张图片` : '图片';
    return [
      `${UNREADABLE_NOTE_MARKER} 用户本轮上传了${countPart},但当前模型不支持视觉,`,
      '且本地 OCR 未能从图中提取出任何文字(常见原因:这是非文字类图像如照片/截图/场景/图表,',
      '或缺少对应语言的 OCR 字库)。请基于这一事实如实回应,务必遵守:',
      '  1) 明确告诉用户「我收到了你的图片,但当前通道读不出它的内容」——绝不能说没有收到图片;',
      '  2) 给出可行方案:换用支持视觉的模型(运行 `khy gateway model` 选择),',
      '     或若图中是文字、确认已安装对应语言 OCR 字库后重发,或直接把图中文字粘贴过来;',
      '  3) 绝不臆测或编造图片里的内容。',
    ].join('\n');
  } catch {
    return null;
  }
}

// ── 剥图但 OCR 说明被功能门关掉时的最小诚实底线 ────────────────────────────
/**
 * describe-and-return 级联全失败、OCR 又取不到文字时,是否注入**不可再降的最小诚实底线**。
 *
 * 背景(2026-07-12 用户实测「Khy 无法正确读图 / 消息里没有附带图片」的**第二条断桥**):
 * 描述级联全失败的 else 分支(OCR 无文本)里,剥图是**无条件**的(images: undefined),但
 * 「收到图但读不出」的说明文案 buildVisionUnreadableNote 受 **KHY_VISION_OCR_FALLBACK**
 * (OCR **功能门**)约束——用户把 OCR 兜底功能关掉时,该文案返 null → 说明不注入,**图却照样
 * 被剥**。结果:文本模型收到一条既无图、又无任何说明的裸 prompt → 如实却荒谬地回「消息里没有
 * 附带图片 / 当前对话中没有任何图片附件。我无法描述不存在的内容」。
 *
 * 关键教训(承 OPS-118「安全不变量绝不该由装饰门决定去留」):安全不变量「剥图 ⟹ 必须留下
 * 『图确实收到但读不出』的痕迹」绝不能被一个**功能门**(要不要走 OCR)静默跳过。本底线是那条
 * 不变量的**不可再降**表达:它**不提 OCR**(因为 OCR 功能此刻可能正被关闭),只坚持「告诉模型
 * 图收到了、读不出、绝不能说没收到图」。受**独立** default-on 门 KHY_VISION_STRIP_IMAGE_FLOOR
 * 约束(与 KHY_VISION_OCR_FALLBACK 正交):开(默认)→ 当 buildVisionUnreadableNote 因 OCR
 * 功能门关/叶子不可用而返 null 时,退回本条最小底线,保住不变量;关(0/false/off/no)→ 返 null,
 * 调用方逐字节回退历史行为(剥图无痕)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isStripImageFloorEnabled(env) {
  const v = (env || process.env || {}).KHY_VISION_STRIP_IMAGE_FLOOR;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 产出「剥图但 OCR 说明被功能门关掉」时的**最小诚实底线**(面向模型,注入 prompt)。
 * 复用 UNREADABLE_NOTE_MARKER 首行标记(与 buildVisionUnreadableNote 视觉一致 + 供去重),但
 * **刻意不提 OCR**——本条恰在 OCR 功能门关闭时才登场,只坚守「图收到了、读不出、绝不能说没收到」。
 * 门控关(KHY_VISION_STRIP_IMAGE_FLOOR=0/false/off/no)→ 返 null(调用方逐字节回退)。
 * 纯字符串构造:零 IO、确定性、绝不抛。
 * @param {object} [input]
 * @param {number} [input.count]  本次附带且被剥离的图片张数(用于措辞,缺省泛化)
 * @param {object} [input.env]
 * @returns {string|null}
 */
function buildStrippedImageFloorNote(input = {}) {
  try {
    if (!isStripImageFloorEnabled(input.env)) return null;
    const n = Number.isFinite(input.count) && input.count > 0 ? Math.floor(input.count) : 0;
    const countPart = n > 0 ? `${n} 张图片` : '图片';
    return [
      `${UNREADABLE_NOTE_MARKER} 用户本轮上传了${countPart},但当前通道无法识别其内容。`,
      '请基于这一事实如实回应,务必遵守:',
      '  1) 明确告诉用户「我收到了你的图片,但当前通道读不出它的内容」——绝不能说没有收到图片;',
      '  2) 给出可行方案:换用支持视觉的模型(运行 `khy gateway model` 选择),或把图中文字直接粘贴过来;',
      '  3) 绝不臆测或编造图片里的内容。',
    ].join('\n');
  } catch {
    return null;
  }
}

// ── post-failure vision-fallback OCR 救援网的「剥图 ⟹ 必留痕」最小底线 ──────
/**
 * 一次带图请求在某适配器上以模型拒绝类错误(404/model_not_found/不支持图像)失败、被
 * shouldOcrRescue 提升为 _visionFallback 后,救援网退回本地 OCR。OCR **提取到文本**时会
 * 剥图 + 注入 OCR 文本(既有行为);但当 OCR **无文本 / 抛错**时,历史上救援网只 emitStatus
 * 就 break,**图不剥、痕不留** → 级联带着裸图继续 → 下游纯文本适配器静默丢图作答 → 如实却
 * 荒谬地回「消息里没有附带图片」(2026-07-12 用户实测,与 prep 期 Site1/Site2 同症,但此处
 * (post-failure 救援网)从未加固,是第三处「剥图 ⟹ 必留痕」断桥)。
 *
 * 关键教训(承 OPS-118/120「安全不变量绝不能被静默跳过」):OCR-成功分支已**无条件**剥图并
 * 转纯文本继续级联,故 OCR-无文本分支也应**同款**剥图并留下诚实底线 —— 而非把裸图交给一个
 * 神话中的下游视觉适配器(shouldOcrRescue 已判定此适配器拒图,prep 期视觉路由亦已穷尽更优选项)。
 * 独立 default-on 门 KHY_VISION_RESCUE_STRIP_FLOOR(与 OCR 功能门、Site1 底线门正交):开(默认)→
 * 救援网 OCR 无文本时剥图 + 注入底线,保住不变量;关(0/false/off/no)→ 调用方逐字节回退历史
 * 行为(图留着,仅状态提示)。
 * @param {object} [env]
 * @returns {boolean}
 */
function isRescueStripFloorEnabled(env) {
  const v = (env || process.env || {}).KHY_VISION_RESCUE_STRIP_FLOOR;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 透明视觉降级时的「配 GLM 视觉 key」邀约 ─────────────────────────────────
// 背景(用户目标 2026-07「上传照片给纯文本模型会发生什么」的收尾「接上」):透明视觉路
// (aiGateway prep 期 decideVisionRouting)在「GLM 视觉门控开、但用户尚未配置 GLM key」时,
// 无法把请求改道到 GLM 视觉端点(见 aiGateway 的 hasAvailableKeys('glm') 守卫「无 GLM key
// 绝不路由到它」),只能退回 OCR 文字 / 「读不出」提示。此刻用户其实**离能直接看图只差一个
// key**,却什么邀约都没有——三种降级出路(OCR 成功读字 / 读不出 / 换视觉兄弟)不统一。
// 本叶子补一句面向模型的指令:让模型在回应末尾主动、简短地问用户「要不要配 GLM 视觉 key,
// 配好后我就能直接看图」。仅在**门控开 且 调用方明确告知 GLM key 缺失**时产出。
//
// 与工具漏斗侧的 buildKeyConfigInvite(KHY_FAILURE_KEY_INVITE,失败后追加给用户看)不同接缝:
// 那是**请求失败后**的文案;本条是**请求仍成功(模型据 OCR 作答)**时注入 prompt 的指令。
// 纯叶子:零 IO(GLM key 是否可用由调用方经 glmKeyMissing 注入),门控关 → null 字节回退。
const VISION_KEY_INVITE_MARKER = '[配置视觉 Key 邀约]';

/**
 * 门控 KHY_VISION_OCR_KEY_INVITE 是否启用(parent=KHY_GLM_VISION_MODEL)。
 * flagRegistry 优先(能识别 parent 关联),不可用 → 本地 CANON 回退。绝不抛。
 * @param {object} [env]
 * @returns {boolean}
 */
function isVisionKeyInviteEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : {}) || {};
  try {
    const reg = require('../flagRegistry');
    if (reg && typeof reg.isRegistryEnabled === 'function' && reg.isRegistryEnabled(e)
      && typeof reg.isFlagEnabled === 'function') {
      return reg.isFlagEnabled('KHY_VISION_OCR_KEY_INVITE', e);
    }
  } catch { /* 注册表不可用 → 本地回退(父门控由调用方 _glmVisionOn 另行把关) */ }
  const v = e.KHY_VISION_OCR_KEY_INVITE;
  return !(v !== undefined && v !== null && _FALSY.has(String(v).trim().toLowerCase()));
}

/**
 * 产出「透明视觉降级时,顺带邀请用户配置 GLM 视觉 key」的面向模型指令(注入 prompt)。
 * 仅当 ① 调用方告知 GLM key 缺失(glmKeyMissing 为真)② 门控开 两者皆真时返字符串,
 * 否则返 null(调用方据此逐字节回退,不注入)。纯字符串构造:零 IO、绝不抛。
 * 绝不透露任何现有密钥;仅指示模型开口问一句。
 * @param {object} [input]
 * @param {boolean} [input.glmKeyMissing]  调用方(aiGateway)已确认「GLM 视觉门控开但无可用 GLM key」
 * @param {object} [input.env]
 * @returns {string|null}
 */
function buildVisionKeyConfigOffer(input = {}) {
  try {
    if (!input || !input.glmKeyMissing) return null;
    if (!isVisionKeyInviteEnabled(input.env)) return null;
    return [
      `${VISION_KEY_INVITE_MARKER} 补充事实:当前尚未配置 GLM(智谱)视觉模型的 API Key——`,
      '这正是我无法直接「看」这张图、只能退回上述方式的根因。请在本次回应的末尾,主动且简短地',
      '问用户一句:是否希望现在配置 GLM 视觉模型的 API Key,配好后再次上传图片我就能直接识别',
      '(把 key 发我即可写入,无需任何额外操作)。务必自然地一句带过,绝不透露任何现有密钥。',
    ].join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  isDescribeFailFloorEnabled,
  isModelRejectionResult,
  shouldOcrRescue,
  buildVisionUnreadableNote,
  UNREADABLE_NOTE_MARKER,
  // 剥图但 OCR 说明被功能门关掉时的最小诚实底线(独立门控 KHY_VISION_STRIP_IMAGE_FLOOR,
  // 与 KHY_VISION_OCR_FALLBACK 正交;保「剥图 ⟹ 必留『收到图但读不出』痕迹」不变量)。
  isStripImageFloorEnabled,
  buildStrippedImageFloorNote,
  // post-failure vision-fallback OCR 救援网:OCR 无文本时剥图 + 留诚实底线的门控
  // (独立门控 KHY_VISION_RESCUE_STRIP_FLOOR;第三处「剥图 ⟹ 必留痕」不变量,与 Site1/Site2 正交)。
  isRescueStripFloorEnabled,
  // 限流终局 OCR 兜底(独立门控 KHY_VISION_RATE_LIMIT_OCR)。
  isRateLimitOcrEnabled,
  shouldRateLimitOcrRescue,
  buildRateLimitOcrNote,
  RATE_LIMIT_OCR_NOTE_MARKER,
  // 透明视觉降级(OCR/读不出)时的「配 GLM 视觉 key」邀约(门控 KHY_VISION_OCR_KEY_INVITE)。
  isVisionKeyInviteEnabled,
  buildVisionKeyConfigOffer,
  VISION_KEY_INVITE_MARKER,
};
