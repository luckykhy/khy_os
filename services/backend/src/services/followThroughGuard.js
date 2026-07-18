'use strict';

// [AI-弱模型·照抄] 本文件是纯叶子:改动照 roundAdvanceAssessor.js / planModeDirective.js 的形状——
//   _isEnabled 委托 flagRegistry(注册表异常/关时逐字节回退 OFF_VALUES 手写判定);判定全在叶子、
//   零 I/O、确定性(无时钟/随机)、绝不抛、门关返 null;接线(toolUseLoop 收尾分支顶端)只做 IO、
//   包一层 try/catch fail-soft。别把检测逻辑写进接线处、别漏 try/catch、别让叶子抛。

/**
 * followThroughGuard.js — 纯叶子:识别「说了却没做就收场」的智能体纪律缺口。
 *
 * 诉求(goal 2026-07-06「修复智能体纪律」):khy 在弱模型(乃至被污染上下文带偏的强模型)驱动下
 * 的最高频翻车形态——**用叙述代替行动、承诺却不执行、虚构阻碍就放弃**。本会话的直接证据:khy 被
 * 要求做一处编辑,读对了文件、定位对了行号,却随后幻觉「你的指令被截断了」并拒绝编辑,做一半编个
 * 理由收场。既有的机械重复检测(toolLoopDetector.noProgress)、逐轮推进观测(roundAdvanceAssessor)、
 * 收尾静默截断守卫(resultGuard.assessClosure)、意图/错误覆盖回核(intentCoverage/errorCoverage)
 * 都照不到这类**零工具调用的中途放弃**——它们要么看工具调用间的重复,要么在「模型自认干完活之后」
 * 才回核。真缺口 = 一个动作任务里,模型**这一轮一次工具都没发起**,却:
 *   A) 虚构 / 未经核实的阻碍(fabricated-blocker):声称「指令被截断 / 内容不完整 / 无法继续」
 *      却从未用工具去核实这个阻碍是否真实;
 *   B) 空头承诺(bare-commitment):声明「我将编辑 / 让我修改」这类第一人称即时动作,却零执行就停下。
 *
 * 判决 → 一次性 [SYSTEM] 纪律回核指令,把模型逼回二选一:真的发起那次工具调用,或用**具体工具证据**
 * (真实报错 / 原始输出)证明阻碍确实存在——而不是凭感觉断言。这把既有的「观测类」信号升级成一次
 * 「闭环兜底」:确保它至少动一次手。
 *
 * 边界(刻意保守,零唠叨):
 *   - 只在**动作任务**(_looksLikeActionRequest)且**本轮零工具调用**时评估。
 *   - 只在**非实质交付**(concludeNow=false,即回复不是一段 >=400 字的完整答复)时评估——长答复
 *     在本循环处处被视作交付,尊重同一边界,不打扰。
 *   - 一次性(caller 持 _followThroughNudgeUsed),即便误判也至多多推一轮。
 *   - bare-commitment 若回复本身在向用户提问(含 ? / ?)→ 抑制(模型合法等待用户确认,不是放弃);
 *     fabricated-blocker 不受此抑制——「指令似乎被截断了,能否重发?」正是本该先用 Read 核实的 bug。
 *
 * 契约:纯叶子——零 I/O、确定性、绝不抛(fail-soft)。
 *
 * 门控(dogfood flagRegistry):
 *   KHY_FOLLOW_THROUGH_GUARD  默认 on,parent=KHY_WEAK_MODEL_GUIDANCE(父关→本门必关)。
 *     关 ⇒ assessFollowThrough 恒返 null(caller 不注入任何 nudge、逐字节回退到旧行为)。
 *
 * @module services/followThroughGuard
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

const _isEnabled = require('../utils/isEnabledDefaultOn');

/** 跟进纪律回核总开关。默认 on;parent=KHY_WEAK_MODEL_GUIDANCE。 */
function isFollowThroughGuardEnabled(env) {
  return _isEnabled('KHY_FOLLOW_THROUGH_GUARD', env);
}

// 虚构 / 未经核实的阻碍 —— 声称做不了却从未用工具去核实(单一真源·冻结)。
const FABRICATED_BLOCKER_RE = Object.freeze([
  // 中文:截断 / 不完整 / 无法继续
  /被?\s*截断/,
  /指令[^。\n]{0,6}(不完整|不全|缺失|被截断)/,
  /(内容|文件|信息)[^。\n]{0,6}(似乎)?[^。\n]{0,4}(不完整|不全|被截断|缺失)/,
  /似乎[^。\n]{0,6}(不完整|被截断|缺少|缺失)/,
  /无法\s*(继续|完成|进行|执行|读取|处理)/,
  /缺少[^。\n]{0,6}(必要|关键|足够)[^。\n]{0,4}(信息|内容|上下文)/,
  // English
  /\btruncat(ed|ion)\b/i,
  /\binstructions?\b[^.\n]{0,24}\b(incomplete|cut ?off|truncated|missing)\b/i,
  /\b(seems?|appears?)\b[^.\n]{0,16}\b(incomplete|truncated|cut ?off|to be missing)\b/i,
  /\b(cannot|can'?t|unable to)\b[^.\n]{0,8}\b(proceed|continue|complete)\b/i,
]);

// 空头承诺 —— 第一人称即时动作声明(单一真源·冻结)。刻意只匹配工具类动词,
// 「总结 / 解释 / 说明」这类纯叙述动词不命中,避免误伤合法收尾。
const BARE_COMMITMENT_RE = Object.freeze([
  // 中文:第一人称即时 + 工具类动词
  /(让我|我将|我会|我现在|我来|接下来我|下面我|现在我|我打算)[^。\n]{0,10}(编辑|修改|读取|查看|运行|执行|创建|写入|搜索|检查|打开|应用|删除|新建)/,
  // English:I'll / let me / I'm going to + 工具类动词
  /\b(i'?ll|i will|let me|i'?m going to|i am going to|next,? i'?ll|now i'?ll|i'?m about to)\b[^.\n]{0,24}\b(edit|modify|read|open|run|execute|create|write|search|check|apply|update|fix|delete)\b/i,
]);

function _matchAny(res, text) {
  for (const re of res) {
    try { if (re.test(text)) return re.source; } catch { /* defensive */ }
  }
  return null;
}

function _looksLikeUserQuestion(text) {
  // 结尾问句 / 显式征询用户输入 → 模型在合法等待,而非放弃。
  return /[?？]\s*$/.test(text)
    || /(请问|请确认|请提供|需要你|能否(帮我)?(提供|确认|重新发送)|你希望|你想要|do you want|would you like|could you (please )?(provide|confirm|resend|clarify))/i.test(text);
}

/**
 * 评估一个零工具调用的动作轮次是否属于「说了却没做就收场」。纯函数,绝不抛;
 * 门关 / 不适用 / 未命中 → null。
 *
 * @param {object} ctx
 *   reply {string}              本轮模型回复(已剥离工具调用块的纯文本)
 *   toolCallCount {number}      本轮实际发起的工具调用数(本守卫只在 ===0 时评估)
 *   isActionTask {boolean}      用户诉求是否为动作请求(由 caller 的 _looksLikeActionRequest 判定)
 *   substantiveDelivery {boolean} 本轮是否已构成实质长答复(caller 的 concludeNow)——true 则不打扰
 * @param {object} [env]
 * @returns {{shouldNudge:true, pattern:'fabricated-blocker'|'bare-commitment', marker:string}|null}
 */
function assessFollowThrough(ctx, env) {
  try {
    if (!isFollowThroughGuardEnabled(env)) return null;
    if (!ctx || typeof ctx !== 'object') return null;
    if (!ctx.isActionTask) return null;
    if (Number(ctx.toolCallCount) > 0) return null; // 只兜零工具调用的中途放弃
    if (ctx.substantiveDelivery) return null;        // 长答复=交付,尊重同一边界不唠叨

    const reply = typeof ctx.reply === 'string' ? ctx.reply : '';
    const text = reply.trim();
    if (!text) return null; // 空回复由既有「无感衔接保底」链处理,不重叠

    // A) 虚构 / 未经核实的阻碍(优先——更有害:它把「没核实的猜测」当既成事实放弃)
    const blockerMarker = _matchAny(FABRICATED_BLOCKER_RE, text);
    if (blockerMarker) {
      return { shouldNudge: true, pattern: 'fabricated-blocker', marker: blockerMarker };
    }

    // B) 空头承诺(排除合法向用户提问的等待态)
    if (!_looksLikeUserQuestion(text)) {
      const commitMarker = _matchAny(BARE_COMMITMENT_RE, text);
      if (commitMarker) {
        return { shouldNudge: true, pattern: 'bare-commitment', marker: commitMarker };
      }
    }

    return null;
  } catch {
    return null; // fail-soft:回核绝不反噬主循环
  }
}

const _NUDGE = Object.freeze({
  'fabricated-blocker':
    '[SYSTEM: 纪律回核] 你在**没有实际调用任何工具**的情况下,就以「指令被截断 / 内容不完整 / 无法继续」之类的理由准备收场。'
    + '这是智能体纪律缺口——你用「叙述一个阻碍」代替了「行动去核实它」。请立即二选一,不要再空谈:\n'
    + '1) 如果阻碍可能是**真实**的:先调用相应工具取回**具体证据**——把文件真的 Read 出来、把命令真的跑一遍,'
    + '用工具的原始输出 / 真实报错来证明它确实无法进行,再把证据贴出来;\n'
    + '2) 如果只是不确定:直接发起你本该做的那次工具调用(Read / Edit / Bash / …),用结果说话。\n'
    + '禁止在**一次工具都没尝试**的情况下,凭感觉断言「被截断 / 不完整 / 做不了」就放弃这一步。',
  'bare-commitment':
    '[SYSTEM: 纪律回核] 你声明了下一步动作(例如「我将编辑 / 让我修改」),但这一轮**没有实际发起任何工具调用**就停下了。'
    + '承诺不等于执行。请立即把你刚才所说的动作**真的做出来**——现在就发起对应的工具调用(Read / Edit / Bash / …),'
    + '而不是只描述你打算做什么。做完再向用户说明结果。',
});

/**
 * 构造一次性纪律回核 [SYSTEM] 指令。未知 pattern / 门关下 caller 不会调用它;防御性返 ''。
 * @param {string} pattern 'fabricated-blocker' | 'bare-commitment'
 * @returns {string}
 */
function buildFollowThroughNudge(pattern) {
  return _NUDGE[pattern] || '';
}

module.exports = {
  isFollowThroughGuardEnabled,
  assessFollowThrough,
  buildFollowThroughNudge,
  FABRICATED_BLOCKER_RE,
  BARE_COMMITMENT_RE,
};
