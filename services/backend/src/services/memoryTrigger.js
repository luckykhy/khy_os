'use strict';

/**
 * memoryTrigger.js — 记忆「捕获侧」分类器(纯叶子,单一真源)。
 *
 * memoryTier 拥有**保留模型**(short_term/cross_session/permanent + 更新/遗忘);
 * memoryEngine.addStructuredMemory 拥有**写入**(落盘/会话存储/decideUpdate);
 * 本模块只回答一个问题:**这条用户消息要不要捕获成记忆,落到哪一层?** 三种结果:
 *
 *   - explicit  用户明确要求记住(「记住…」「请记住」「remember this」)。
 *               **必须捕获**——这是用户的直接指令,权威,不打折扣(诉求点:客户明确
 *               提出请记住时需要记住)。
 *   - proactive 用户没明说要记,但这是一条**稳定的个人事实/偏好**,值得主动留存
 *               (诉求点:什么时候触发主动记忆)。**极度保守、零假阳性偏向**——只在
 *               一条很窄的高精度白名单上触发(身份声明、稳定偏好声明),绝不去猜
 *               一次性的任务陈述。
 *   - none      无需捕获。
 *
 * 保留层推断(单源自 memoryTier.TIERS):
 *   - 含「永久/永远/别忘/forever/permanently」或稳定身份事实 ⇒ permanent
 *   - 含「临时/暂时/这次/本次会话/just for now/temporarily」 ⇒ short_term(只活本会话)
 *   - 其余明确记忆                                            ⇒ cross_session
 *
 * 稳定 topic key(主动更新的关键):身份这类「同一主题、值会变」的记忆返回固定 name
 * (`user-name`),于是再次声明会经 addStructuredMemory 的 decideUpdate **原地 supersede
 * 而非堆叠**(诉求点:主动更新)。其余记忆 name 留 null,由调用方从正文派生 slug。
 *
 * 纯函数:零 IO、零状态、不读时钟。两道独立门控(均默认开,∈{0,false,off,no} 关):
 *   KHY_MEMORY_TRIGGER     —— 捕获侧总开关(关 ⇒ 一律 none,回退到「模型自行写记忆」)。
 *   KHY_PROACTIVE_CAPTURE  —— 仅主动子层开关(关 ⇒ 只保留显式「记住」路径,最保守)。
 */

const memoryTier = require('./memoryTier');

const OFF = new Set(['0', 'false', 'off', 'no']);
const NONE = Object.freeze({ kind: 'none' });

/** 捕获侧总开关。默认开,KHY_MEMORY_TRIGGER∈{0,false,off,no} 关。 */
function isEnabled() {
  return !OFF.has(String(process.env.KHY_MEMORY_TRIGGER || '').trim().toLowerCase());
}

/** 主动子层开关(独立于总开关)。默认开,KHY_PROACTIVE_CAPTURE∈{0,false,off,no} 关。 */
function isProactiveEnabled() {
  return !OFF.has(String(process.env.KHY_PROACTIVE_CAPTURE || '').trim().toLowerCase());
}

/**
 * 指令文件候选子层开关(独立于上面两个)。默认开,KHY_INSTRUCTION_CANDIDATE∈{0,false,off,no} 关。
 * 关 ⇒ instruction 分支恒不触发(逐字节退化到「不把项目约定路由到指令文件」的今日行为)。
 */
function isInstructionCandidateEnabled() {
  return !OFF.has(String(process.env.KHY_INSTRUCTION_CANDIDATE || '').trim().toLowerCase());
}

// ── 触发短语 ─────────────────────────────────────────────────────────
// 显式「请记住」意图。命中即必须捕获(用户直接指令)。
const EXPLICIT_RE = /(记住|记一下|记下来|帮我记|存一下|存下来|以后都|从现在起|别再|不要再|remember\s+(that|this)|my\s+(name|preference)\s+is|note\s+to\s+self|请记住)/i;

// 显式触发里偏「协作偏好/纠偏」语气的,归 feedback 类(对齐既有 _MEMORY_FEEDBACK_RE)。
const FEEDBACK_RE = /(以后|别再|不要再|from\s+now\s+on|don'?t\s+(ever\s+)?)/i;

// 保留层提示词。
const PERMANENT_HINT_RE = /(永久|永远|一直记|始终记|别忘|永远别忘|forever|permanently|never\s+forget)/i;
const SHORT_TERM_HINT_RE = /(临时|暂时|这次|本次会话|just\s+(for\s+)?now|temporar(y|ily)|for\s+this\s+session)/i;

// 稳定身份事实(高精度):姓名声明。命中 ⇒ permanent + user + 固定 topic key。
const IDENTITY_RE = /(我叫|我的名字(是|叫)|my\s+name\s+is)\s*\S/i;

// 稳定偏好声明(主动子层白名单,高精度):长期习惯而非一次性任务陈述。
const PREFERENCE_RE = /(我(习惯|一般|通常|总是|一直|默认)(用|使用)|我(喜欢|偏好)(用|使用)|i\s+(prefer|usually\s+use|always\s+use|generally\s+use))\s*\S/i;

// 指令文件候选(instruction 分支白名单,高精度·零假阳性偏向):**项目级长期约定 / 规范 /
// 构建命令 / 协作方式**——这类应写进指令文件(khy.md/agent.md)让它注入每回合系统提示,而非
// 落个人记忆库。只认确定形态,绝不去猜一次性任务陈述。
//   命中样例:「这个项目统一用 pnpm」「本项目约定接口都走 REST」「构建命令是 npm run build」
//            「提交前必须跑测试」「代码风格遵循 airbnb」「测试框架用 vitest」「本仓禁止直接改 main」
const INSTRUCTION_RE = new RegExp(
  [
    // 项目/本仓 + 约定/规范/统一用/规定/一律
    '(这个?|本)(项目|仓库|仓|repo|工程)[^\\n]{0,12}(统一(用|使用)?|约定|规范|规定|一律|禁止|不(要|准|得)|必须|默认(用|使用))',
    // 构建/打包/部署命令
    '(构建|编译|打包|部署|启动|测试)\\s*(命令|脚本)?\\s*(是|用|为|:|：)',
    // 提交前/合并前 必须/要/需
    '(提交|commit|合并|merge|推送|push|发布|release)前[^\\n]{0,6}(必须|要|需要|得|应)',
    // 代码风格/规范 遵循/用/是
    '(代码|编码)(风格|规范|约定)[^\\n]{0,6}(遵循|用|使用|是|为|:|：)',
    // 测试框架 / 用什么框架
    '(测试|单测)\\s*(框架|库)?\\s*(用|使用|是|为)',
    // 依赖/包管理器 统一用
    '(依赖|包管理器?|包管理工具)[^\\n]{0,6}(统一)?(用|使用)',
    // 英文:this project uses / always / never / must (团队级约定)
    '\\bthis\\s+(project|repo|codebase)\\s+(uses|always|never|must|should|requires)\\b',
    '\\b(build|test|lint)\\s+(command|script)\\s+(is|:)\\b',
  ].join('|'),
  'i',
);

// 疑问句 / 请求句(否决 instruction 触发):用户在**问**或**要求一次性动作**而非**确立约定**。
const _QUESTION_RE = /(吗[?？]?\s*$|怎么|如何|为什么|是不是|能不能|可不可以|帮我|请(帮|你|问)|\?\s*$|？\s*$)/;

// 去掉句首的显式触发前缀,留下干净正文(对齐 ai.js 既有 strip)。
function _stripTrigger(raw) {
  return String(raw)
    .replace(/^\s*(请\s*)?(帮我\s*)?(记住|记一下|记下来|帮我记|存一下|存下来|note\s+to\s+self|remember\s+(that|this))[:：,，\s]*/i, '')
    .trim();
}

/**
 * 推断显式记忆的保留层。短期提示优先(用户说「这次/临时」就别永久占盘),
 * 再看永久提示/身份,缺省落 cross_session。
 */
function _inferTier(raw) {
  if (SHORT_TERM_HINT_RE.test(raw)) return memoryTier.TIERS.SHORT_TERM;
  if (PERMANENT_HINT_RE.test(raw) || IDENTITY_RE.test(raw)) return memoryTier.TIERS.PERMANENT;
  return memoryTier.TIERS.CROSS_SESSION;
}

/** 推断语义种类:身份→user;纠偏/偏好语气→feedback;否则 user(用户想留的事实)。 */
function _inferType(raw) {
  if (IDENTITY_RE.test(raw)) return 'user';
  if (FEEDBACK_RE.test(raw)) return 'feedback';
  return 'user';
}

/**
 * 把一条用户消息分类成捕获决策。
 *
 * @param {string} message
 * @returns {{kind:'explicit'|'proactive'|'none', name?:string|null, note?:string, tier?:string, type?:string}}
 *   - name 非 null ⇒ 稳定 topic key,调用方应原样用作记忆名(令再次声明 supersede)。
 *   - name 为 null ⇒ 调用方自行从 note 派生 slug(每条独立,不合并)。
 */
function classify(message) {
  if (!isEnabled()) return NONE;
  const raw = String(message || '').trim();
  if (!raw || raw.length > 2000) return NONE;

  // ① 显式「请记住」:必须捕获。身份声明用固定 topic key 以便后续 supersede。
  if (EXPLICIT_RE.test(raw)) {
    const note = _stripTrigger(raw) || raw;
    if (IDENTITY_RE.test(note) || IDENTITY_RE.test(raw)) {
      return { kind: 'explicit', name: 'user-name', note, tier: memoryTier.TIERS.PERMANENT, type: 'user' };
    }
    return { kind: 'explicit', name: null, note, tier: _inferTier(raw), type: _inferType(raw) };
  }

  // ② 主动子层:仅在高精度白名单上触发,零假阳性偏向。
  if (isProactiveEnabled()) {
    if (IDENTITY_RE.test(raw)) {
      // 身份是「同一主题、值会变」的典型 → 固定 topic key,再次声明则更新而非堆叠。
      return { kind: 'proactive', name: 'user-name', note: raw, tier: memoryTier.TIERS.PERMANENT, type: 'user' };
    }
    if (PREFERENCE_RE.test(raw)) {
      // 不同偏好应共存(tab/空格…),故 name 留 null 按正文独立成条;同条复述经 decideUpdate skip。
      return { kind: 'proactive', name: null, note: raw, tier: memoryTier.TIERS.CROSS_SESSION, type: 'feedback' };
    }
  }

  // ③ 指令文件候选:项目级长期约定/规范 → 建议写进指令文件(khy.md/agent.md),经待审核队列。
  //    与 identity/preference 正交(那两支是个人事实,这支是项目约定)。零假阳性:命中约定
  //    白名单 且 非疑问/请求句 才成立。最保守默认 target='khy'、scope='project'(不猜 agent/global)。
  if (isInstructionCandidateEnabled()) {
    if (INSTRUCTION_RE.test(raw) && !_QUESTION_RE.test(raw)) {
      return { kind: 'instruction', target: 'khy', scope: 'project', note: raw };
    }
  }

  return NONE;
}

module.exports = {
  isEnabled,
  isProactiveEnabled,
  isInstructionCandidateEnabled,
  classify,
  _stripTrigger,
  // 暴露正则供测试与单源复用(ai.js 旧 _MEMORY_TRIGGER_RE 可逐步收敛到此)。
  EXPLICIT_RE,
  IDENTITY_RE,
  PREFERENCE_RE,
  INSTRUCTION_RE,
  PERMANENT_HINT_RE,
  SHORT_TERM_HINT_RE,
};
