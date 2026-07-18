'use strict';

/**
 * 响应防抖 / 抗抖动（Response debounce / anti-jitter）。
 *
 * 上游弱模型通道（例如 sensenova deepseek-v4-flash）在降级 / 被无关上下文带偏
 * 时，会对完全无害的请求吐出一句**模板化的套话拒绝**（「你好，我无法给到相关
 * 内容。」），有时甚至把这句拒绝**拼接在真实回答前面**：
 *
 *     "你好，我无法给到相关内容。哈哈，好的！讲个短笑话：……"
 *
 * 这层防抖只做两件**纯文本 / 纯信令**的事，绝不揣测语义、绝不调用模型：
 *
 *   1. stripLeadingRefusal —— 当回复以一句（或数句）**无具体原因**的套话拒绝
 *      开头、但紧跟着有实质内容时，剥掉这段前缀残留，把真实回答还给用户。
 *      只在「确有实质后文」时剥离：整段就是一句拒绝（真正的拒绝）原样保留，
 *      交给上层零静默失败归因。
 *
 *   2. buildResetChunk —— 当循环判定本轮已流式输出的内容是要被丢弃重试的
 *      （套话拒绝触发 nudge 重试）时，向流式消费端发一帧 `{type:'reset'}`，
 *      让按缓冲重渲染的消费端（web / mobile / 重渲染型 TUI）**丢弃**这段已流出
 *      的废稿，而不是把重试得到的好内容**追加**在废稿后面（拼接 bug 的信令侧根因）。
 *
 * 两个判别式（isCanned / statesReason）以**依赖注入**方式传入，保持本模块纯净、
 * 可独立测试，同时让套话拒绝的正则**单一真源**仍只留在 toolUseLoop。
 */

/** 归一空白，便于稳定比对。 */
function _normalize(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

/**
 * 取出开头第一句（含句末终止符），返回 {head, rest}。
 * 终止符覆盖中英文：。！？!? 以及换行。若无终止符，整段视为一句、rest 为空。
 */
function _splitLeadingSentence(text) {
  const s = String(text == null ? '' : text);
  const m = s.match(/^[\s\S]*?[。！？!?\n]+/);
  if (!m) return { head: s, rest: '' };
  return { head: m[0], rest: s.slice(m[0].length) };
}

/**
 * 纯问候 / 寒暄句（无信息量）。允许在**确认后续有套话拒绝**的前提下被一并剥离，
 * 这样「你好。我无法给到相关内容。<真实答案>」也能被还原。单独的问候（后面是
 * 真实内容、并无拒绝）不会被剥——见 stripLeadingRefusal 里的 refusalStrips 闸门。
 */
function _isPureGreeting(text) {
  const t = _normalize(text);
  if (!t || t.length > 12) return false;
  return /^(你好|您好|哈喽|嗨|hi|hello|hey)[\s,，.。!！~]*$/i.test(t);
}

/**
 * 剥离开头残留的**无理由套话拒绝**前缀，把后续真实内容还给用户。
 *
 * @param {string} text  待处理回复
 * @param {object} deps
 * @param {(s:string)=>boolean} deps.isCanned       是否模板化套话拒绝
 * @param {(s:string)=>boolean} deps.statesReason   拒绝是否自带具体原因（诚实拒绝）
 * @param {number} [deps.minRemainderChars=8]       后文实质字符下限（去空白）
 * @param {number} [deps.maxStrips=3]               最多剥离的拒绝句数（防失控）
 * @returns {{text:string, stripped:boolean, removed:string}}
 */
function stripLeadingRefusal(text, deps = {}) {
  const isCanned = typeof deps.isCanned === 'function' ? deps.isCanned : () => false;
  const statesReason = typeof deps.statesReason === 'function' ? deps.statesReason : () => false;
  const minRemainder = Number.isFinite(deps.minRemainderChars) ? deps.minRemainderChars : 8;
  const maxStrips = Number.isFinite(deps.maxStrips) ? deps.maxStrips : 3;

  const original = String(text == null ? '' : text);
  if (!original.trim()) return { text: original, stripped: false, removed: '' };

  let working = original.replace(/^\s+/, '');
  let removed = '';
  let refusalStrips = 0;     // 真正剥掉的「无理由套话拒绝」句数
  let peels = 0;             // 含问候在内的总剥离次数（防失控）
  const maxPeels = maxStrips + 2;

  while (peels < maxPeels) {
    const { head, rest } = _splitLeadingSentence(working);
    // 末句即唯一内容：绝不剥光。整段是拒绝→留给归因层。
    if (!rest.trim()) break;

    const headIsBareRefusal = isCanned(head) && !statesReason(head);
    const headIsGreeting = _isPureGreeting(head);
    if (!headIsBareRefusal && !headIsGreeting) break;

    // 后文必须有足够实质内容，才允许剥。
    const restClean = rest.replace(/\s/g, '');
    if (restClean.length < minRemainder) break;

    removed += head;
    working = rest.replace(/^\s+/, '');
    peels += 1;
    if (headIsBareRefusal) refusalStrips += 1;
    if (refusalStrips >= maxStrips) break;
  }

  // 一句拒绝都没真正剥到（例如只有问候、或开头本就是真实内容）→ 原样返回。
  if (refusalStrips === 0) return { text: original, stripped: false, removed: '' };

  // 终防呆：剩余为空、或剩余本身又是一句无理由套话拒绝（即整段都是拒绝）→ 放弃剥离，
  // 原样交给上层零静默失败归因，绝不把用户的回复抹空。
  if (!working.trim() || (isCanned(working) && !statesReason(working))) {
    return { text: original, stripped: false, removed: '' };
  }

  return { text: working.trim(), stripped: true, removed: removed.trim() };
}

/**
 * 构造一帧流式**重置**信令。消费端收到后应丢弃本轮已累积的流式文本（废稿），
 * 等待随后到来的修正内容，而不是把修正内容追加其后。对直接打印、无法回收的消费端
 * 是无害的 no-op（它们忽略未知类型即可）。
 *
 * @param {string} reason  机器可读原因（如 'bare-refusal-retry'）
 * @returns {{type:'reset', reason:string, retract:true}}
 */
function buildResetChunk(reason) {
  return { type: 'reset', reason: String(reason || 'retry'), retract: true };
}

/** 是否为重置帧（消费端判别用，集中一处避免散落字符串）。 */
function isResetChunk(chunk) {
  return !!chunk && typeof chunk === 'object' && chunk.type === 'reset';
}

// ── 过度泛化 safety guard 纠偏：良性闲聊检测 + 拒绝重复签名 ──────────────────
//
// 真实缺陷复盘（用户原话）：对「讲个笑话」这类**完全无害**的请求，弱模型/降级通道
// 会反射式吐一句模板化 safety 拒绝，并在多轮里**反复走同一条错误路径**——
//   · 缺少的检查：这个具体请求是否真有问题？→ 没有；
//   · 缺少的 break：第一次错了、被纠正后仍原样重复，没有跳出循环。
// 这两个纯文本助手分别补上「检查」与「break」的判据，逻辑仍由上层 toolUseLoop 编排。

// 明显有害 / 需要真正 safety 介入的信号。命中即**否决**良性判定——这层只为
// "明显无害"的请求松绑，绝不为任何可疑请求开绿灯（判断权交还真正的 safety 逻辑）。
const HARMFUL_MARKERS = /(违法|犯罪|攻击|入侵|黑客|木马|病毒|爆炸|炸弹|武器|枪支|毒品|制毒|自杀|自残|色情|裸|未成年|儿童|血腥|暴力|仇恨|歧视|诈骗|洗钱|窃取|盗取|隐私|身份证|银行卡|密码|信用卡|exploit|malware|ransomware|weapon|bomb|explosive|drug|suicide|self.?harm|porn|nsfw|csam|minor|hack|phishing|terror|illegal)/i;

// 无害的闲聊 / 常识 / 创作类信号——讲笑话、打招呼、闲谈、推荐、简单问答、写句子等。
// 这些请求既不需要工具，也无任何拒绝理由。
const BENIGN_MARKERS = /(讲(?:个|一个)?(?:笑话|故事|段子)|笑话|段子|猜谜|脑筋急转弯|聊聊|聊天|闲聊|陪我|打招呼|你好|早上好|晚上好|介绍(?:一下|下)?你自己|你是谁|推荐(?:个|一?些|一下)?|有什么.*推荐|说句|写(?:个|一?句|首)?(?:祝福|诗|打油诗|对联|句子)|鼓励|安慰|夸夸|彩虹屁|tell\s+(?:me\s+)?a\s+joke|joke|riddle|chat\s+with\s+me|say\s+hi|who\s+are\s+you|introduce\s+yourself|recommend|cheer\s+me\s+up|write\s+a\s+(?:poem|haiku|greeting|sentence))/i;

/**
 * 用户请求是否为「明显无害的闲聊/常识/创作」类——可直接作答、无需工具、绝无拒绝理由。
 *
 * 命中后，上层应改用「这就是无害请求、直接友好作答即可」的定向 nudge，纠正
 * 过度泛化的 safety guard；而不是给模型一个「要么调工具、要么给原因」的伪二选一
 * （那个二选一根本不覆盖"直接答"这条唯一正路）。
 *
 * 防呆顺序：先否决（任何有害信号 → false），再肯定（无害信号 → true）。长请求
 * （>200 字，多为真实任务）一律判否，避免把复杂任务误当闲聊放行。
 *
 * @param {string} text 用户原始请求
 * @returns {boolean}
 */
function looksLikeBenignConversational(text) {
  const t = _normalize(text);
  if (!t || t.length > 200) return false;
  if (HARMFUL_MARKERS.test(t)) return false; // 任何可疑信号 → 立即判否，绝不松绑
  return BENIGN_MARKERS.test(t);
}

/**
 * 拒绝文本的归一化签名，用于「同一句拒绝又原样重复」的死循环 break 检测。
 * 归一空白 + 去标点 + 转小写 + 截断，使「我无法给到相关内容。」与
 * 「我无法给到相关内容」「 我无法给到相关内容！ 」判为同一签名。
 *
 * @param {string} text
 * @returns {string} 稳定签名（空输入返回空串）
 */
function refusalSignature(text) {
  const t = _normalize(text).toLowerCase();
  if (!t) return '';
  // 去掉所有标点与符号（Unicode 属性类），只留可比对的实义字符。
  return t.replace(/[\p{P}\p{S}\s]+/gu, '').slice(0, 80);
}

module.exports = {
  stripLeadingRefusal,
  buildResetChunk,
  isResetChunk,
  looksLikeBenignConversational,
  refusalSignature,
  // 暴露内部助手供单测与上层复用（非主 API）。
  _normalize,
  _splitLeadingSentence,
  _isPureGreeting,
  HARMFUL_MARKERS,
  BENIGN_MARKERS,
};
