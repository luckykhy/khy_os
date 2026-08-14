'use strict';

/**
 * referenceDisambiguation.js
 *
 * 「会话内代词/身份指代消歧」—— 当用户这句话依赖**前文才有意义**(含「它/这个/那个/上面…」
 * 等代词或「再来一个/换一个」等跟进语)、或在**询问自身身份**(「我是谁/我是不是…」)时,
 * 与其让模型凭空臆断某个指向、或泛泛而谈,不如确定性地据「会话上下文候选实体」「用户身份
 * 摘要」给模型注入一段消歧指令:
 *   - 指向**唯一可确定** → 直接展开、无需反问;
 *   - **0 或 ≥2 个候选**(歧义) → 提示模型调 AskUserQuestion 列出可能指代对象让用户选;
 *   - 身份信息**充足** → 据此作答;**不足** → 追问想了解身份的哪个方面;
 *   - **已连续澄清 ≥2 次** → 停止追问,改为「给出最可能推断 + 明确说明假设」,避免过度反问。
 *
 * 纯叶子:无 I/O、无随机、无时钟、单一真源。昂贵数据(会话上下文摘要 / 用户身份摘要)由
 * **调用方注入**,叶子保持纯净。产出一个结构化裁决 + 一段中文系统指令(由上层注入**系统
 * 提示词**而非用户消息,避免被模型当作 prompt injection)。
 *
 * 与既有件正交,且复用单一真源、绝不重复造判据:
 *  - 清晰度/具体指令判据**复用** multimodalIntentRouter.assessPromptClarity(其 reason
 *    === 'concrete-instruction' 即命中内部 CONCRETE_INSTRUCTION_RE——「有明确动作+对象」)。
 *    此处只读消费其结论,**不导入、不修改**该文件的判据/返回值。
 *  - CLEAR_MODES(goal/ultrawork/coding/…)活跃即视为「用户已给出明确指令」,本路由让位不注入,
 *    与 clarificationCards / multimodalIntentRouter 口径一致(零假阳性)。
 *
 * 门控 KHY_REFERENCE_DISAMBIGUATION 默认开;关闭 → route 返回 directive:null(系统提示词
 * 字节不变)。
 */

const { assessPromptClarity } = require('./multimodalIntentRouter');

// 与 multimodalIntentRouter / clarificationCards 保持一致:这些意图模式活跃即代表用户已给出
// 明确指令,本路由让位不注入。
const CLEAR_MODES = Object.freeze(['goal', 'ultrawork', 'coding', 'analyze', 'learn']);

// 让位阈值:文本长于此字数即视为「说得够多」,不属短促指代,不介入(零假阳性)。
const MAX_REFERENCE_LEN = 40;

// 代词/跟进短句判据(**参照** localBrainSessionContext 的 _PRONOUN_RE/_FOLLOWUP_RE,此处
// 保留独立副本,叶子不反向依赖会话模块的私有常量)。
const PRONOUN_RE =
  /(它|这个|那个|上面|刚才|之前|前面|上一个|上次|那|这|its?|that|the one|previous|last one|above)/i;
const FOLLOWUP_RE =
  /^(再来|再讲|再说|换一个|再给|还有|另一个|继续|下一个|more|another|next|again|one more)[\s一个吗呢？?!！]*$/i;

// 身份询问判据:「我是谁 / 我是不是… / 我叫什么 / 我的身份 / 你认识我吗 / 我是哪…」。
const IDENTITY_RE =
  /(我是谁|我是不是|我是什么|我叫什么|我的身份|我是哪|你(?:知道|认识)我|认识我吗|关于我)/;

// 设备/性能抱怨判据:「卡 / 卡顿 / 好慢 / 死机 / 转圈 / 发热 / 闪退 / 崩了 / 加载慢…」。
// 零假阳性:「卡」不单独匹配(避免误伤卡片/银行卡/卡通/卡路里),仅当以程度副词
// (好/很/太/这么/那么…)修饰、或与顿/机/成/得等性能语境搭配时才命中;「慢」同理
// (避免误伤「慢慢来/慢走」),仅程度副词修饰或与加载/反应搭配时命中。
const DEVICE_RE =
  /(卡顿|卡死|卡机|死机|转圈|(?:很|好|太|巨|贼|超|特别|非常)?发热|发烫|闪退|崩溃|崩了|(?:好|很|太|老|巨|贼|超|特别|非常|有点|有些|越来越|一直|总是|这么|那么|这样|那样)卡|卡(?:成|得|到|卡的)|电脑卡|手机卡|系统卡|运行卡|(?:好|很|太|巨|贼|超|特别|非常|有点|有些|越来越|这么|那么)慢|加载(?:好|很|太)?慢|反应(?:好|很|太)?慢|反应迟钝|响应(?:好|很|太)?慢|跑不动|带不动|风扇狂转|lag|laggy|freez(?:e|ing)|stuck)/i;

// 「已有明确对象」的性能抱怨:句中已点名代码/程序/某文件/接口等主体(如「这段代码有点慢」
// 「这个函数卡」),说明主体已清晰,**不属**「电脑还是项目」的设备歧义,让位不介入(零假阳性)。
const DEVICE_EXPLICIT_SUBJECT_RE =
  /(代码|程序|函数|方法|脚本|这段|那段|这个文件|那个文件|接口|算法|查询|循环|构建|编译|打包|页面|动画|视频|游戏|浏览器|网页|模型|数据库|sql|api|build|render)/i;

// 「项目/代码讨论上下文」判据:用于据 contextSummary(lastCategory/lastTopic/entities)判断
// 最近是否在聊项目/代码——若在,则卡顿更可能在「电脑 vs 当前项目」之间两难,澄清文案据此调整。
const PROJECT_CTX_RE =
  /(代码|项目|程序|函数|bug|编译|构建|部署|文件|仓库|repo|git|测试|test|npm|node|react|python|java|服务|接口|api|数据库|sql|脚本|算法)/i;

function _enabled(options = {}) {
  if (options && options.referenceDisambiguation !== undefined) {
    return !['0', 'false', 'off', 'no'].includes(
      String(options.referenceDisambiguation).trim().toLowerCase()
    );
  }
  const raw = String(process.env.KHY_REFERENCE_DISAMBIGUATION || 'true')
    .trim()
    .toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

// 去重候选实体(按 value),保留原顺序,截断过长值防噪声。
function _dedupeCandidates(entities) {
  const list = Array.isArray(entities) ? entities : [];
  const seen = new Set();
  const out = [];
  for (const e of list) {
    const value = String((e && e.value) || '').trim();
    if (!value) {
      continue;
    }
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    out.push({ type: String((e && e.type) || 'entity'), value: value.slice(0, 20) });
    if (out.length >= 6) {
      break;
    }
  }
  return out;
}

// ── 指令构建(确定性、中文、简洁 ≤300 字,风格对齐 buildClarificationDirective) ──────

function _buildPronounResolvedDirective(resolved) {
  const lines = [];
  lines.push('## 指代已可确定 —— 直接据上下文理解,无需反问');
  lines.push(
    `用户这句话含指代词,结合最近对话可确定其最可能指向:「${resolved}」。请直接按此理解并作答;不要就指代对象反复反问用户。若后续证据与此矛盾,再据实纠正。`
  );
  return lines.join('\n');
}

function _buildPronounClarifyDirective(candidates) {
  const names = candidates
    .map((c) => c.value)
    .slice(0, 4)
    .join('、');
  const lines = [];
  lines.push('## 指代不明 —— 先确认「它/这个/那个」指的是谁');
  lines.push(
    names
      ? `用户这句话含指代词,但从最近对话中无法唯一确定其指向(可能的候选:${names})。`
      : '用户这句话含指代词,但当前会话上下文里没有可锁定的指代对象。'
  );
  lines.push(
    '请**先用 AskUserQuestion** 列出可能的指代对象让用户选一个,再据此推进;不要凭空臆断某一个,也不要只反问而不给候选。系统会自动为每张卡补「可讨论」与「自由输入」,你无需自加。'
  );
  return lines.join('\n');
}

function _buildIdentityAnswerDirective(identity) {
  const parts = [];
  if (identity.osUser) {
    parts.push(`设备/系统用户: ${String(identity.osUser).slice(0, 40)}`);
  }
  if (identity.skillLevel) {
    parts.push(`技能等级: ${identity.skillLevel}`);
  }
  if (identity.language) {
    parts.push(`语言: ${identity.language}`);
  }
  const lines = [];
  lines.push('## 身份询问 —— 依已知用户信息作答');
  lines.push(
    '用户在询问自身身份/画像。以下是系统已掌握的信息,请据此直接、具体作答,不要泛泛而谈或反问已知项:'
  );
  if (parts.length) {
    lines.push('- ' + parts.join(' · '));
  }
  lines.push('信息有限就如实说明边界,**不要编造**未知的个人信息。');
  return lines.join('\n');
}

function _buildIdentityClarifyDirective() {
  const lines = [];
  lines.push('## 身份询问 —— 信息不足,先问清想了解哪方面');
  lines.push(
    '用户在问自身身份,但当前掌握的用户信息不足以直接作答。请**用 AskUserQuestion** 问清用户想了解身份的哪个方面(如:使用偏好 / 技能水平 / 设备环境 / 历史记录),再据此回答;不要编造个人信息。'
  );
  return lines.join('\n');
}

function _buildDowngradeDirective(type) {
  const what = type === 'identity' ? '身份' : type === 'device' ? '设备/环境' : '指代';
  const lines = [];
  lines.push('## 已多次澄清 —— 停止追问,给出最可能推断');
  lines.push(
    `本轮仍存在${what}歧义,但已连续多次向用户澄清。请**不要再反问**,而是基于现有上下文给出**最可能的推断**,并**明确说明你所做的假设**,据此直接推进;若假设有误,用户会纠正。`
  );
  return lines.join('\n');
}

// 将调用方注入的系统负载快照格式化为一行佐证(无则返回空串)。
function _formatSystemLoad(s) {
  if (!s || typeof s !== 'object') {
    return '';
  }
  const parts = [];
  if (Number.isFinite(s.cpuPercent)) {
    parts.push(`CPU 占用 ${s.cpuPercent}%`);
  }
  if (Number.isFinite(s.memPercent)) {
    parts.push(`内存占用 ${s.memPercent}%`);
  }
  if (Number.isFinite(s.freeMemMB)) {
    parts.push(`空闲内存 ${s.freeMemMB}MB`);
  }
  return parts.join(' · ');
}

function _buildDeviceClarifyDirective(hasProjectCtx, systemLoad) {
  const lines = [];
  lines.push('## 卡顿/变慢主体不明 —— 先确认「慢的是什么」');
  lines.push(
    hasProjectCtx
      ? '用户在反映卡顿/变慢/发热等现象。结合最近正在讨论的项目/代码,无法确定指的是**电脑本身**还是**当前项目·程序**。'
      : '用户在反映卡顿/变慢/发热等现象,但未指明主体——可能是**电脑硬件**、**当前项目·程序**,也可能是**网络**。'
  );
  const ev = _formatSystemLoad(systemLoad);
  if (ev) {
    lines.push(`当前系统负载快照(供参考,非结论):${ev}。`);
  }
  lines.push(
    '请**先用 AskUserQuestion** 让用户在 (A) 电脑/硬件 (B) 当前项目·程序 (C) 网络 之间选一个,再据此定位;不要凭空假定某一个。系统会自动为每张卡补「可讨论」与「自由输入」,你无需自加。'
  );
  return lines.join('\n');
}

// ── 分支裁决 ──────────────────────────────────────────────────────────

function _assessPronoun(text, contextSummary, consecutiveClarifyCount) {
  const candidates = _dedupeCandidates(contextSummary.entities);
  const resolvedHint = String(contextSummary.resolved || '').trim();

  // 连续澄清上限:即使歧义也不再追问,降级为「最可能推断 + 说明假设」。
  if (consecutiveClarifyCount >= 2) {
    return {
      need: false,
      type: 'pronoun',
      resolved: resolvedHint || null,
      directive: _buildDowngradeDirective('pronoun'),
      reason: 'clarify-cap',
    };
  }
  // 会话模块已展开(resolveFollowUp 命中) → 视为唯一可解析。
  if (resolvedHint) {
    return {
      need: false,
      type: 'pronoun',
      resolved: resolvedHint,
      directive: _buildPronounResolvedDirective(resolvedHint),
      reason: 'resolved-followup',
    };
  }
  // 唯一候选 → 展开建议。
  if (candidates.length === 1) {
    const only = candidates[0].value;
    return {
      need: false,
      type: 'pronoun',
      resolved: only,
      directive: _buildPronounResolvedDirective(only),
      reason: 'unique-candidate',
    };
  }
  // 0 或 ≥2 候选 → 歧义,让用户选。
  return {
    need: true,
    type: 'pronoun',
    resolved: null,
    directive: _buildPronounClarifyDirective(candidates),
    reason: candidates.length === 0 ? 'no-candidate' : 'multi-candidate',
  };
}

function _assessIdentity(identitySummary, consecutiveClarifyCount) {
  const hasInfo = !!(
    identitySummary &&
    (identitySummary.hasIdentity || identitySummary.osUser || identitySummary.deviceId)
  );

  if (consecutiveClarifyCount >= 2) {
    return {
      need: false,
      type: 'identity',
      resolved: null,
      directive: _buildDowngradeDirective('identity'),
      reason: 'clarify-cap',
    };
  }
  if (hasInfo) {
    return {
      need: false,
      type: 'identity',
      resolved: null,
      directive: _buildIdentityAnswerDirective(identitySummary),
      reason: 'identity-known',
    };
  }
  return {
    need: true,
    type: 'identity',
    resolved: null,
    directive: _buildIdentityClarifyDirective(),
    reason: 'identity-insufficient',
  };
}

// 据注入的会话摘要判定最近是否存在「项目/代码」讨论上下文。只读消费,不改摘要。
function _hasProjectContext(contextSummary) {
  const cs = contextSummary || {};
  if (PROJECT_CTX_RE.test(String(cs.lastCategory || ''))) {
    return true;
  }
  if (PROJECT_CTX_RE.test(String(cs.lastTopic || ''))) {
    return true;
  }
  const ents = Array.isArray(cs.entities) ? cs.entities : [];
  for (const e of ents) {
    // file 类实体(路径/文件名)本身即项目/代码信号;其余看 value 是否命中项目词。
    if (String((e && e.type) || '') === 'file') {
      return true;
    }
    if (PROJECT_CTX_RE.test(String((e && e.value) || ''))) {
      return true;
    }
  }
  return false;
}

function _assessDevice(contextSummary, systemLoad, consecutiveClarifyCount) {
  // 连续澄清上限:即使歧义也不再追问,降级为「最可能推断 + 说明假设」。
  if (consecutiveClarifyCount >= 2) {
    return {
      need: false,
      type: 'device',
      resolved: null,
      directive: _buildDowngradeDirective('device'),
      reason: 'clarify-cap',
    };
  }
  const hasProjectCtx = _hasProjectContext(contextSummary);
  return {
    need: true,
    type: 'device',
    resolved: null,
    directive: _buildDeviceClarifyDirective(hasProjectCtx, systemLoad),
    reason: hasProjectCtx ? 'device-with-project-context' : 'device-ambiguous',
  };
}

/**
 * 指代消歧路由主入口(单一真源)。
 *
 * @param {object} input
 * @param {string}  input.text                     用户原始消息
 * @param {string[]} [input.modes]                 intentGate.detectModes().modes
 * @param {object}  [input.contextSummary]         会话上下文摘要(由调用方注入):
 *        { entities:[{type,value}], lastTopic, lastCategory, resolved? }
 * @param {object}  [input.identitySummary]        用户身份摘要(由调用方注入)
 * @param {object}  [input.systemLoad]             系统负载快照(由调用方惰性采样后注入,仅 device 分支用作佐证)
 * @param {number}  [input.consecutiveClarifyCount] 连续澄清计数(≥2 触发降级;预留参数)
 * @param {object}  [input.options]                env 覆盖({referenceDisambiguation})
 * @returns {{ enabled:boolean, need:boolean, type:(string|null), resolved:(string|null),
 *            directive:(string|null), reason?:string }}
 */
function routeReferenceDisambiguation(input = {}) {
  const options = input.options || {};
  const enabled = _enabled(options);
  const base = { enabled, need: false, type: null, resolved: null, directive: null };
  if (!enabled) {
    return { ...base, reason: 'disabled' };
  }

  const text = String(input.text || '');
  const t = text.trim();
  const modes = (Array.isArray(input.modes) ? input.modes : [])
    .map((m) =>
      String(m || '')
        .trim()
        .toLowerCase()
    )
    .filter(Boolean);
  const contextSummary = input.contextSummary || {};
  const identitySummary = input.identitySummary || null;
  const consecutiveClarifyCount = Number(input.consecutiveClarifyCount) || 0;

  if (!t) {
    return { ...base, reason: 'empty' };
  }

  // 让位规则(零假阳性):
  // 1) CLEAR_MODES 活跃 → 用户已给出明确指令,不介入。
  if (modes.some((m) => CLEAR_MODES.includes(m))) {
    return { ...base, reason: 'mode-active' };
  }
  // 2) 有明确动作+对象(复用 assessPromptClarity 的 concrete-instruction 结论)→ 不介入。
  let concrete = false;
  try {
    concrete = assessPromptClarity(t).reason === 'concrete-instruction';
  } catch {
    /* fail-open to not-concrete */
  }
  if (concrete) {
    return { ...base, reason: 'concrete-instruction' };
  }
  // 3) 文本过长(说得够多)→ 不属短促指代,不介入。
  if (t.length > MAX_REFERENCE_LEN) {
    return { ...base, reason: 'too-long' };
  }

  // 分派(互斥、一次至多一条 directive):身份询问优先(最具体) → 设备/性能抱怨 → 代词/跟进。
  if (IDENTITY_RE.test(t)) {
    return { enabled, ..._assessIdentity(identitySummary, consecutiveClarifyCount) };
  }
  // 设备歧义:命中性能抱怨词,且句中未点名代码/程序等明确主体时才介入。
  if (DEVICE_RE.test(t)) {
    // 已有明确对象(如「这段代码有点慢」)→ 主体已清晰,不属设备歧义,让位。
    if (DEVICE_EXPLICIT_SUBJECT_RE.test(t)) {
      return { ...base, reason: 'device-explicit-subject' };
    }
    return { enabled, ..._assessDevice(contextSummary, input.systemLoad, consecutiveClarifyCount) };
  }
  if (PRONOUN_RE.test(t) || FOLLOWUP_RE.test(t)) {
    return { enabled, ..._assessPronoun(t, contextSummary, consecutiveClarifyCount) };
  }
  return { ...base, reason: 'no-reference' };
}

/**
 * 轻量设备/性能抱怨预判(纯字符串,无副作用)——供调用方(如 aiChatCore)在**惰性采样
 * 系统负载前**做预检:命中才采样(避免每轮 100ms 开销)。与 route 同口径:命中设备词
 * 且未点名代码/程序等明确主体。不涉及门控/让位规则(那些由 route 统一裁决)。
 * @param {string} text 用户原始消息
 * @returns {boolean}
 */
function mightBeDeviceQuery(text) {
  const t = String(text || '').trim();
  if (!t) {
    return false;
  }
  return DEVICE_RE.test(t) && !DEVICE_EXPLICIT_SUBJECT_RE.test(t);
}

module.exports = {
  CLEAR_MODES,
  MAX_REFERENCE_LEN,
  PRONOUN_RE,
  FOLLOWUP_RE,
  IDENTITY_RE,
  DEVICE_RE,
  DEVICE_EXPLICIT_SUBJECT_RE,
  routeReferenceDisambiguation,
  mightBeDeviceQuery,
};
