'use strict';

// [AI-弱模型·照抄] 本文件是**纯叶子**：零 IO、确定性、绝不抛（坏输入返安全默认）、可单测。
//   判定/文案全在叶子里；IO 与「关闭即字节回退」由接线处（toolUseLoopCore）施加。
//   本文件委托 goalStopGate（同为纯叶子，leaf→leaf 相对 require，契约允许）拿确定性完成/证据信号，
//   避免完成态判定在多个模块间漂移（单一真源）。

/**
 * taskClosure.js — 普通用户任务（非持久目标）的**单一权威收尾裁决器**。
 *
 * ── 根因（为什么 khy 老是无法「任务闭环」）──────────────────────────────
 * toolUseLoopCore 在「模型不再调用工具 = 该收尾」时，用一句脆弱散文正则判定回复是否算收尾
 * （hasConclusion：`/(完成|成功|done|completed|结果|summary|…)/i`）。它**只看有没有某个完成词**，
 * 完全不看两件事：
 *   1) 否定词：回复明说「尚未/还没/未完成」却仍可能因行内一个「完成」字被判收尾；
 *   2) 未来时计划主导：回复说「**已完成第一步**，接下来我将重构…」——这明明是阶段性小结、
 *      任务仍在推进，却因「已完成」三个字被判成整个任务完成 → **提前收尾**。
 * 反过来，真正的终态交付（「桌面已干净，无需操作」「审计通过，无阻塞项」）因没有命中那些
 * 模板词，反而被判「未收尾」→ 被 nudge 再驱动 → **永不完结**。
 *
 * ── 本叶子的解法（对照 CC 的 Stop hook / Cline 的 TodoList 收尾 / Hermes 的完成契约）────────
 *   收尾不再是「回复里出现某个词」，而是**确定性、证据感知的判定**：
 *   1. `isFinalDelivery(reply)`：回复是否是**终态交付**（含完成态、结果小结、无操作收尾），
 *      且未被否定词、未来时主导、阶段进度腔遮蔽。这是替代脆弱 hasConclusion 的权威信号。
 *   2. `decideClosure(...)`：给出有界的 `close / redrive / close_partial` 仲裁——在判定为完成态
 *      但「有未完成计划步骤 或 声称验证却无真实验证 或 无实质证据」时，有界再驱动一次；
 *      预算耗尽则**诚实降级 close_partial**（注明缺口），绝不无条件续跑。
 *
 * 偏置：误判「已收尾」→ 提前放行（违背 CC「达成前不停」，危害大）；误判「未收尾」→ 多推一次
 * （有界：one-shot nudge + redrive 预算，死不了循环）。故在**确有终态信号**时才判收尾，
 * 否则宁可再推一次 / 诚实标记为部分完成。
 */

const _str = require('../utils/toStr').toStr;

const goalStopGate = require('./goalStopGate');

// ── 终态交付信号（合并 toolUseLoopCore 两处 hasConclusion 的原始意图，并补齐 no-op 收尾）────────
const _FINAL_SIGNAL_RE =
  /(已完成|已全部完成|已达成|已实现|已交付|已整理|已创建|已修改|已启动|已打开|已执行|已运行|已验证|已发送|已部署|已安装|大功告成|完成|成功|无需|不需要|没有.*需要|已经.*整理|看起来.*整洁|桌面.*干净|结果|总结|结论|以上|如下|本次|done|completed|finished|accomplished|summary|result|launched|opened|executed|verified|started|no.*needed|already.*clean|organized)/i;

// 否定完成（优先级最高，出现即判「未收尾」）。
const _NEGATED_RE =
  /(尚未|还没|还未|仍未|未能完成|未完成|没(?:有)?完成|不能.*(?:确认|视为)|not\s+(?:yet\s+)?(?:done|complete(?:d)?|finished)|nothing\s+(?:left\s+)?is\s+(?:done|complete)|incomplete|still\s+(?:working|pending))/i;

// 未来时/计划腔 + 阶段进度信号 —— 与完成态并存时抑制「收尾」（表示只是推进中途、还有下一步）。
const _FUTURE_DOMINANT_RE =
  /(接下来|下一步|接下来我|下一步我|我(?:将|会|准备|打算|先|接下来|下一步)|即将|然后|之后|稍后|再(?:接|继)|还会|还需要|仍需|还有|剩余|待办|继续(?:推进|执行|处理)|go(?:ing)?\s+to\b|i\s*(?:'|’)ll\b|i\s+will\b|let\s+me\b|still\s+(?:need|to\s+do|working)|what\s+next|next\s+step|todo\s+step)/i;

// 阶段进度腔：已推进一部分（完成态的**阶段**版本），常与「接下来…」联用。
const _PROGRESS_MARKER_RE =
  /(已完成|已处理|已推进|已修复|已解决|已创建|已修改|已整理|finished|completed|done|fixed|patched|resolved|updated)/i;

// 裸「完成」孤立出现（无对象）不足以作终态交付证据的词；保守不作为强信号，交给上下文判定。
const _WEAK_DONE_RE = /(任务|工作|处理)完成/i;

const _DEFAULT_MAX_REDRIVES = 1;

// 委托 goalStopGate 的确定性完成态判定（相同完成态信号表，避免漂移）。
const _goalLooksDone = goalStopGate.looksLikeGoalSatisfied;
const _goalHasEvidence = goalStopGate.hasConcreteEvidence;
const _goalClaimsVerifyNoEvidence = goalStopGate.claimsVerificationWithoutEvidence;
const _goalVerifyRan = goalStopGate.verificationCommandRan;

/**
 * 回复是否是**终态交付**。纯函数、绝不抛。
 *
 * 判定优先级（从高到低）：
 *   1. 空回复 → false。
 *   2. 否定完成（尚未/还没/未完成/not done…）→ false（明说没完成）。
 *   3. 显式目标达成（goalStopGate.looksLikeGoalSatisfied 的强完成态）→ true。
 *   4. 出现终态交付信号 且 未被「未来时计划主导 + 阶段进度腔」遮蔽 → true。
 *      （「已完成第一步，接下来我将重构」→ 被遮蔽 → false；「桌面已干净，无需操作」→ true）
 *   5. 其余 → false。
 * @param {string} reply
 * @returns {boolean}
 */
function isFinalDelivery(reply) {
  const s = _str(reply).trim();
  if (!s) {
    return false;
  }
  if (_NEGATED_RE.test(s)) {
    return false;
  }
  if (_goalLooksDone(s)) {
    return true;
  }
  if (!_FINAL_SIGNAL_RE.test(s)) {
    return false;
  }
  // 未来时计划主导 且 带阶段进度腔 → 这是推进中途的阶段性小结，不是终态交付。
  if (_FUTURE_DOMINANT_RE.test(s) && _PROGRESS_MARKER_RE.test(s)) {
    return false;
  }
  return true;
}

/** 一条回复是否给出**具体证据**（真实命令输出/测试计数/文件摘录），而非空口声称。 */
function hasConcreteEvidence(reply) {
  return _goalHasEvidence(_str(reply));
}

/** 回复是否「声称验证/测试通过却拿不出任何具体证据」。 */
function claimsVerificationWithoutEvidence(reply) {
  return _goalClaimsVerifyNoEvidence(_str(reply));
}

/** 本轮工具执行记录里是否**真的运行过**验证/测试/检查命令。 */
function verificationCommandRan(toolCallLog) {
  return _goalVerifyRan(toolCallLog);
}

/**
 * 计划步骤中**未完成**的条目。step.status ∈ completed/skipped/n-a/pending…；
 * 判定为「已完成」的只有 completed；其余（含 pending/undefined/in_progress）都算未完成（保守）。
 * @param {Array<object>} planSteps
 * @returns {Array<object>} 未完成条目
 */
function incompleteSteps(planSteps) {
  if (!Array.isArray(planSteps)) {
    return [];
  }
  return planSteps.filter((s) => {
    const status = s && s.status;
    const completed =
      status === 'completed' || status === 'done' || status === 'complete' || status === 'finished';
    const skipped =
      status === 'skipped' || status === 'n-a' || status === 'na' || status === 'not-applicable';
    return !completed && !skipped;
  });
}

/**
 * 构建「尚未终态交付」的再驱动指令（注入下一轮 currentMessage）。有界、绝不抛。
 * @param {string} taskDescription
 * @param {object} [opts]
 * @param {Array<object>} [opts.incompleteSteps]
 * @param {boolean} [opts.unverified]
 * @returns {string}
 */
function buildRedriveMessage(taskDescription, { incompleteSteps: steps, unverified } = {}) {
  const list = (Array.isArray(steps) ? steps : []).slice(0, 6).map((s, i) => {
    const label = (s && (s.label || s.title || s.name)) || '';
    return `  ${i + 1}. ${_str(label).slice(0, 140)}`;
  });
  const lines = [
    '[SYSTEM: 你尚未给出任务的**终态交付结论** —— 现在还不能判定完成（对齐 Cline/CC 的收尾语义：做完并确认才对）。',
    '请按顺序：',
    '① 若任务**还有剩余步骤** —— 继续执行它们，并给出每一步结果；',
    '② 若任务**已全部完成** —— 给出一份明确的交付总结（做了什么 / 如何验证 / 最终结果），不要只停留在中间状态；',
    '③ 若你**确实无法完成** —— 如实说明已完成的部分、未完成的部分与阻塞原因，不要声称完成。',
    taskDescription ? `用户原始请求: ${_str(taskDescription).slice(0, 300)}` : '',
    ']',
  ];
  if (list.length > 0) {
    lines.splice(4, 0, '仍未标记完成的步骤:', ...list);
  }
  if (unverified) {
    lines.splice(4, 0, '你声称验证/测试通过，但本轮没有真实运行验证命令 —— 请实际跑一遍再总结结果。');
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * 构建「部分完成」的诚实标注（close_partial 时追加到最终回复之后）。纯函数、绝不抛。
 * @param {object} [opts]
 * @param {Array<object>} [opts.incompleteSteps]
 * @param {boolean} [opts.unverified]
 * @param {boolean} [opts.noEvidence]
 * @returns {string}
 */
function buildPartialDeliveryNote(input) {
  const { incompleteSteps: steps, unverified, noEvidence } = input || {};
  const note = [
    '⚠ 任务未能完整闭环（未全部确认完成）：',
  ];
  const list = (Array.isArray(steps) ? steps : []).slice(0, 6).map((s, i) => {
    const label = (s && (s.label || s.title || s.name)) || '';
    return `  ${i + 1}. ${_str(label).slice(0, 140)}`;
  });
  if (list.length > 0) {
    note.push('尚未确认完成的步骤:');
    note.push(list.join('\n'));
  }
  if (unverified) {
    note.push('· 声称验证通过但未真实运行验证命令，结果未经证实。');
  }
  if (noEvidence) {
    note.push('· 声称完成但未给出具体证据（命令输出/测试计数/文件摘录）。');
  }
  return note.join('\n');
}

/**
 * 解析再驱动预算：优先 maxRedrives 实参，其次 env KHY_TASK_CLOSURE_REDRIVE_MAX，
 * clamp [0,6]，非法回默认 1。纯函数。
 * @param {number|undefined} explicit
 * @param {object} [env]
 * @returns {number}
 */
function resolveMaxRedrives(explicit, env) {
  const e = env || process.env || {};
  let raw;
  if (explicit !== undefined && explicit !== null) {
    raw = explicit;
  } else {
    raw = e.KHY_TASK_CLOSURE_REDRIVE_MAX;
  }
  const n = Number.parseInt(_str(raw).trim(), 10);
  if (Number.isFinite(n) && n >= 0) {
    return Math.min(n, 6);
  }
  return _DEFAULT_MAX_REDRIVES;
}

/**
 * 单一权威收尾仲裁。纯函数、绝不抛。
 *
 * @param {object} args
 * @param {string} [args.reply]            - 本轮模型最终回复（strippedReply）
 * @param {Array<object>} [args.planSteps] - 执行计划步骤（用于核对未完成步骤）
 * @param {Array<object>} [args.toolCallLog]- 本轮工具执行记录（verify-ran 门用）
 * @param {number} [args.redriveCount]     - 本轮已再驱动次数
 * @param {number} [args.maxRedrives]      - 再驱动预算（缺省走 resolveMaxRedrives）
 * @param {string} [args.taskDescription]  - 用户原始请求（截断附于 redrive 文案）
 * @param {object} [args.env]
 * @returns {{action:'close'|'redrive'|'close_partial', reason:string, message?:string, note?:string}}
 */
function decideClosure({
  reply,
  planSteps,
  toolCallLog,
  redriveCount,
  maxRedrives,
  taskDescription,
  env,
} = {}) {
  const s = _str(reply);
  const max = resolveMaxRedrives(maxRedrives, env);
  const count = Number(redriveCount) || 0;
  const steps = incompleteSteps(planSteps);
  const exhausted = count >= max;

  let finalDelivery = false;
  try {
    finalDelivery = isFinalDelivery(s);
  } catch {
    finalDelivery = false;
  }

  if (!finalDelivery) {
    if (exhausted) {
      return {
        action: 'close_partial',
        reason: 'not-concluded-exhausted',
        note: buildPartialDeliveryNote({ incompleteSteps: steps, noEvidence: true }),
      };
    }
    return {
      action: 'redrive',
      reason: 'not-concluded',
      message: buildRedriveMessage(taskDescription, { incompleteSteps: steps }),
    };
  }

  // 完成态，但并非干净收尾：剩余步骤 / 声称验证却无真实验证。
  const claimsVerify = claimsVerificationWithoutEvidence(s);
  const ranVerify = toolCallLog ? verificationCommandRan(toolCallLog) : true;
  const unverified = claimsVerify && !ranVerify;

  if (steps.length > 0 || unverified) {
    if (exhausted) {
      return {
        action: 'close_partial',
        reason: 'established-but-unclean-exhausted',
        note: buildPartialDeliveryNote({ incompleteSteps: steps, unverified }),
      };
    }
    return {
      action: 'redrive',
      reason: steps.length > 0 ? 'steps-incomplete' : 'verification-missing',
      message: buildRedriveMessage(taskDescription, { incompleteSteps: steps, unverified }),
    };
  }

  return { action: 'close', reason: 'concluded' };
}

module.exports = {
  isFinalDelivery,
  hasConcreteEvidence,
  claimsVerificationWithoutEvidence,
  verificationCommandRan,
  incompleteSteps,
  resolveMaxRedrives,
  buildRedriveMessage,
  buildPartialDeliveryNote,
  decideClosure,
};
