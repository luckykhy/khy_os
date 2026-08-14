'use strict';

/**
 * restoreStrategyLedger.js — 还原「策略台账 / cross-session learning」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第九层，给整条链补上**跨会话学习（machine-level durable learning）**。
 *
 * ── 它补的缺口：一个从不从自己过去失败中学习的 agent ──────────────────────────────
 * 轨迹日志（OPS-MAN-086）给了**单会话**记忆：一次自驱轮里跨进程重建 stallCount、防死循环。
 * 可它是**严格 per-session** 的——每个会话一个 `<session>.jsonl`，彼此不读。后果：
 *   · 会话 A 已用 5 步证明 `reprobe` 对当前这台机器的某类卡点是死胡同（次次 stalled → escalate）；
 *   · 会话 B 起来，对同一类卡点**从零把同一死胡同重走一遍**。
 * 这是安全 agent 里一个刺眼的缺陷：**它记得「这一轮」做过什么，却不记得「这台机器上历来」
 * 什么策略被证明没用**。人类维护者修一台反复出问题的机器时，第二次绝不会再试第一次证明
 * 无效的手段；agent 却会。本层让 agent 拥有同样的常识。
 *
 * ── 怎么补：跨会话回放 → 每策略记分卡 → 保守分类 ──────────────────────────────────
 * 输入是**多个会话**的事件流（每个会话一条 buildEvent 出的事件数组）。按 `strategy` 聚合每个
 * 策略历来的终局分布，产出一张记分卡，并给每个策略一个**保守**分类：
 *   productive  该策略在这台机器上**至少一次**真推进过（advanced / converged）→ 值得再试。
 *   dead        该策略跨 **≥ MIN_SAMPLES 个独立会话**、**每次**终局都是 escalate / stalled，
 *               **从未一次**推进 → 在这台机器上已被反复证明无用，建议跳过。
 *   unproven    样本不足（< MIN_SAMPLES）或信号不清 → 不下判语（保守：不建议跳过）。
 *
 * ── 安全优先的核心不变量（绝不误伤）────────────────────────────────────────────
 * · 只要某策略**哪怕一次** advanced/converged，就永远不判 dead（一次成功洗清所有失败）。
 * · dead 的门槛是「跨多个**独立会话**反复失败」，不是「某一会话里连着失败」——防止一次运气差
 *   就把一个本可用的策略永久拉黑。
 * · 台账只产出 `recommendedSkips`（建议跳过的死策略），**绝不重排 resolver 的安全恢复链顺序**：
 *   排序是安全属性（reprobe→reconcile→trust-pessimistic→escalate 由风险决定），学习只做减法、
 *   不做重排。这是诚实边界——学习优化的是「别再试已证死的」，不是「颠覆安全序」。
 *
 * ── 纯度边界 ─────────────────────────────────────────────────────────────────
 * 叶子是纯 reducer：deriveStrategyLedger(sessionStreams) 零 IO、绝不抛。真正读盘（遍历
 * ~/.khy/.restore-trace/*.jsonl 全会话）在 CLI scripts/restore-ledger.js 里做。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────
 * 新增一种终局判据时：① 在 _TERMINAL_OUTCOME 里把它归入 productive / unproductive；
 * ② 若引入新 verdict，先在 restore-converge 与 restoreTraceJournal._STALL_RULE 登记，再回来这里。
 * 分类阈值只有 MIN_SAMPLES 一个旋钮，改它即改「多保守才敢判 dead」。
 */

// 判 dead 至少需要跨多少个独立会话都失败（防单次运气差误伤）。
const MIN_SAMPLES = 2;

const CLASS_PRODUCTIVE = 'productive';
const CLASS_DEAD = 'dead';
const CLASS_UNPROVEN = 'unproven';

// verdict → 该次终局对策略是「推进」还是「无进展」。与 restore-converge 词表对齐。
const OUTCOME_PROGRESS = 'progress';       // advanced / converged
const OUTCOME_STUCK = 'stuck';             // stalled / regressed / escalate
const _TERMINAL_OUTCOME = {
  advanced: OUTCOME_PROGRESS,
  converged: OUTCOME_PROGRESS,
  stalled: OUTCOME_STUCK,
  regressed: OUTCOME_STUCK,
};

function _str(x) { return String(x == null ? '' : x).trim(); }
function _arr(x) { return Array.isArray(x) ? x : []; }

/**
 * 判一个事件是否代表「推进 / 无进展 / 中性」。
 * @returns {'progress'|'stuck'|''}  未知 verdict → ''（中性，不计入任一侧）
 */
function _outcomeOf(event) {
  const e = event && typeof event === 'object' ? event : {};
  const verdict = _str(e.verdict);
  const mapped = _TERMINAL_OUTCOME[verdict];
  if (mapped) return mapped;
  // 未映射：看 stop 兜底（escalate-human 视为 stuck），否则中性。
  if (_str(e.stop) === 'escalate-human') return OUTCOME_STUCK;
  return '';
}

/**
 * 跨会话派生策略台账。纯函数，绝不抛。
 *
 * @param {Array<Array<object>>} sessionStreams - 每个元素是一个会话的事件数组（buildEvent 出的）
 * @param {object} [opts]
 * @param {number} [opts.minSamples] - 覆盖 MIN_SAMPLES
 * @returns {{
 *   strategies: Array<{
 *     strategy:string, sessions:number, attempts:number,
 *     progress:number, stuck:number,
 *     classification:string, recommendSkip:boolean, rationale:string
 *   }>,
 *   recommendedSkips: string[],
 *   productive: string[],
 *   totalSessions: number,
 *   summary: string
 * }}
 *   空 / 畸形 → 空台账（无 skip 建议）；绝不抛、绝不凭空拉黑策略。
 */
function deriveStrategyLedger(sessionStreams, opts) {
  const minSamples = opts && Number.isFinite(opts.minSamples) && opts.minSamples > 0
    ? Math.floor(opts.minSamples) : MIN_SAMPLES;

  const empty = {
    strategies: [], recommendedSkips: [], productive: [],
    totalSessions: 0,
    summary: '策略台账为空：这台机器上尚无可学习的还原历史（不建议跳过任何策略）。',
  };

  try {
    const streams = _arr(sessionStreams).filter((s) => Array.isArray(s));
    if (streams.length === 0) return empty;

    // strategy → { sessionsWithProgress:Set, sessionsWithStuck:Set, progress, stuck, attempts }
    const agg = new Map();
    let sessionIdx = 0;
    for (const stream of streams) {
      const thisSession = sessionIdx;
      sessionIdx += 1;
      for (const ev of _arr(stream)) {
        const e = ev && typeof ev === 'object' ? ev : {};
        const strategy = _str(e.strategy);
        if (!strategy) continue;                 // 无策略标注的事件不计入学习
        const outcome = _outcomeOf(e);
        if (!outcome) continue;                  // 中性事件不计入任一侧

        let rec = agg.get(strategy);
        if (!rec) {
          rec = {
            progress: 0, stuck: 0, attempts: 0,
            progressSessions: new Set(), stuckSessions: new Set(),
          };
          agg.set(strategy, rec);
        }
        rec.attempts += 1;
        if (outcome === OUTCOME_PROGRESS) {
          rec.progress += 1;
          rec.progressSessions.add(thisSession);
        } else {
          rec.stuck += 1;
          rec.stuckSessions.add(thisSession);
        }
      }
    }

    const strategies = [];
    for (const [strategy, rec] of agg) {
      const sessions = new Set([...rec.progressSessions, ...rec.stuckSessions]).size;
      let classification;
      let rationale;
      if (rec.progress > 0) {
        // 一次成功洗清所有失败：安全优先绝不误伤。
        classification = CLASS_PRODUCTIVE;
        rationale = `曾 ${rec.progress} 次真推进（advanced/converged）：值得再试。`;
      } else if (rec.stuckSessions.size >= minSamples) {
        // 跨足够多独立会话、次次卡住、从未推进 → 反复证明无用。
        classification = CLASS_DEAD;
        rationale = `跨 ${rec.stuckSessions.size} 个独立会话次次无进展、从未推进：`
          + `在这台机器上已被反复证明无用，建议跳过。`;
      } else {
        classification = CLASS_UNPROVEN;
        rationale = `样本不足（仅 ${rec.stuckSessions.size} 个会话卡住，未达 ${minSamples}）：`
          + `暂不下判语，保守不建议跳过。`;
      }
      strategies.push({
        strategy, sessions, attempts: rec.attempts,
        progress: rec.progress, stuck: rec.stuck,
        classification,
        recommendSkip: classification === CLASS_DEAD,
        rationale,
      });
    }

    strategies.sort((a, b) => a.strategy.localeCompare(b.strategy));
    const recommendedSkips = strategies.filter((s) => s.recommendSkip).map((s) => s.strategy);
    const productive = strategies
      .filter((s) => s.classification === CLASS_PRODUCTIVE).map((s) => s.strategy);

    let summary;
    if (recommendedSkips.length > 0) {
      summary = `跨 ${streams.length} 个会话学到：${recommendedSkips.length} 个策略已被反复证明`
        + `无用（${recommendedSkips.join('、')}），建议下次跳过；余下按安全序照常尝试。`;
    } else {
      summary = `跨 ${streams.length} 个会话：尚无策略被反复证明无用，全部按安全序照常尝试。`;
    }

    return {
      strategies, recommendedSkips, productive,
      totalSessions: streams.length, summary,
    };
  } catch {
    // 不确定即回到空台账：绝不凭空拉黑任何策略。
    return empty;
  }
}

module.exports = {
  deriveStrategyLedger,
  MIN_SAMPLES,
  CLASS_PRODUCTIVE, CLASS_DEAD, CLASS_UNPROVEN,
  OUTCOME_PROGRESS, OUTCOME_STUCK,
  // 供测试锁定：
  _outcomeOf, _TERMINAL_OUTCOME,
};
