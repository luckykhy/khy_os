'use strict';

/**
 * restoreTraceJournal.js — 还原「轨迹日志 / trace journal」纯叶子（零 IO · 绝不抛）
 *
 * 还原家族第八层，是给整条链补上的**持久记忆（durable agent memory）**。
 *
 * ── 它补的是一道刺眼的真实缺口（不是臆想，是可复现的缺陷）─────────────────────────
 * restore-converge（082）的防死循环签名是
 *     verifyConvergence({ before, after, move, stallCount })
 * 其中 `stallCount`（连续无进展次数）**必须由调用方自己维护**。可是 restore 的真实场景是
 * 陌生机器上**一次次独立的 CLI 调用**：每次进程「起 → 判 → 退」。跨进程 `stallCount`
 * 每回都从 0 起——于是 agent 在同一个卡点上空转 100 次，每次都被判成「第 1/2 次 stall」，
 * **防死循环在进程边界上根本不生效**，永远升不了级、永远交不了人。这正是 khy 自己反复
 * 修的「卡住 / idle-watchdog 自续命」同一类自驱失败，只是搬到了还原层、且此前无人守。
 *
 * 本层用一条**追加式、可推导**的事件流消灭这道缝：
 *   · 每尝试一步还原（一次 converge 判定），就往轨迹里 append 一个事件；
 *   · 下次进程起来先**回放**整条轨迹，deriveJournalState → 派生出真实的 stallCount，
 *     再喂回 verifyConvergence({ stallCount })——跨进程的循环计数终于连上了。
 *
 * ── 三个受益人，一次兑现 ──────────────────────────────────────────────────────
 *   · **恢复中的 agent**：拿到真 stallCount，防死循环真正生效；还能读上次 move 接着干，
 *     不必从零重推状态（agent 创新：让链有记忆、可续跑）。
 *   · **回到卡死机器的维护者**：一条完整审计轨迹（"reprobe 试了 3 次无进展才升级"），
 *     一眼看清 agent 到底做过什么、卡在哪。
 *   · **使用者**：不再是"每次都像第一次"的失忆循环。
 *
 * ── 纯度边界（为什么这是纯叶子）─────────────────────────────────────────────────
 * 叶子是一个 **reducer + 事件构造器**，零 IO：
 *   · buildEvent({ move, verdict })   把一次 converge 判定压成一个可追加的最小事件（纯）；
 *   · deriveJournalState(events)       回放事件流 → 派生态（含跨进程 stallCount）（纯）。
 * 真正的落盘 / 读盘（append 到 ~/.khy/.restore-trace/<session>.jsonl）在 CLI
 * scripts/restore-trace.js 里做——刻意用 dot 前缀目录，正好被授权门（084）的
 * `_detectExistingUserData`（过滤 `!startsWith('.')`）排除：**操作轨迹不是用户数据**，
 * 不会误触 overwrite-risk，家族语义自洽。
 *
 * ── stallCount 回放规则（与 restore-converge 逐字对齐，改一处必同改）──────────────
 *   advanced   → 0      （消解了未决项：清零）
 *   converged  → 0      （全绿收敛：清零并终结）
 *   regressed  → 不变    （倒退：converge 保 prevStall 不增不减，随即升级 → 终结）
 *   stalled    → prev+1  （无进展：累加；达 STALL_LIMIT 升级 → 终结）
 * 终结（terminal）= 见到 converged，或任一 escalate（regressed / stalled 达阈值）。
 *
 * ── HOW-TO-EXTEND（抄写式）───────────────────────────────────────────────────
 * 新增一种 verdict 时：① 在 _STALL_RULE 里加一行它对 stallCount 的贡献（reset/keep/inc）；
 * ② 若它是终结态，在 _TERMINAL_STOPS / _isTerminalVerdict 里登记。**不要**在别处散落判定。
 *
 * 恒久红线：任何回传文本（move.action）先过 _DANGER_TOKENS 自检，命中即隐去——轨迹是
 * 要给人 / agent 看的，绝不把危险 shell 原样写进可读回执。
 */

// 危险令牌（与家族同款）：任何回传文本命中即隐去。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// verdict 词表（与 restore-converge 对齐）。
const VERDICT_ADVANCED = 'advanced';
const VERDICT_CONVERGED = 'converged';
const VERDICT_REGRESSED = 'regressed';
const VERDICT_STALLED = 'stalled';

// stop 词表（与 restore-converge 对齐）。
const STOP_CONTINUE = 'continue';
const STOP_CONVERGED = 'converged-stop';
const STOP_ESCALATE = 'escalate-human';

// 回放时每种 verdict 对 stallCount 的贡献：清零 / 保持 / 累加。
const _STALL_RESET = 'reset';
const _STALL_KEEP = 'keep';
const _STALL_INC = 'inc';
const _STALL_RULE = {
  [VERDICT_ADVANCED]: _STALL_RESET,
  [VERDICT_CONVERGED]: _STALL_RESET,
  [VERDICT_REGRESSED]: _STALL_KEEP,
  [VERDICT_STALLED]: _STALL_INC,
};

// 审计轨迹里最多保留多少条明细（防无界增长；派生态本身不受截断影响，见下）。
const MAX_HISTORY = 200;

function _actionIsSafe(text) {
  const s = String(text == null ? '' : text);
  if (!s) return true;
  for (const tok of _DANGER_TOKENS) {
    if (s.includes(tok)) return false;
  }
  return true;
}

function _redact(text) {
  return _actionIsSafe(text) ? String(text == null ? '' : text) : '[redacted: unsafe action]';
}

function _str(x) { return String(x == null ? '' : x).trim(); }

/**
 * 把一次 converge 判定压成一个**最小、可追加、已脱敏**的事件。纯函数，绝不抛。
 *
 * @param {object} params
 * @param {object} [params.verdict] - verifyConvergence 的返回（读 verdict/stop/afterCount…）
 * @param {object} [params.move]    - 刚尝试的 move（{action, strategy}），仅用于审计标注
 * @param {number} [params.seq]     - 序号（CLI 传 events.length；缺省 0）
 * @returns {{seq:number, verdict:string, stop:string, strategy:string, action:string,
 *            afterCount:number, resolvedCount:number, introducedCount:number}}
 */
function buildEvent(params) {
  const p = params && typeof params === 'object' ? params : {};
  const v = p.verdict && typeof p.verdict === 'object' ? p.verdict : {};
  const move = p.move && typeof p.move === 'object' ? p.move : {};
  const seq = Number.isFinite(p.seq) && p.seq >= 0 ? Math.floor(p.seq) : 0;
  return {
    seq,
    verdict: _str(v.verdict),
    stop: _str(v.stop),
    strategy: _str(move.strategy || v.strategy),
    action: _redact(move.action),          // 危险 shell 绝不原样落轨迹
    afterCount: Number.isFinite(v.afterCount) ? v.afterCount : 0,
    resolvedCount: Array.isArray(v.resolved) ? v.resolved.length : 0,
    introducedCount: Array.isArray(v.introduced) ? v.introduced.length : 0,
  };
}

function _isTerminalVerdict(verdict, stop) {
  if (verdict === VERDICT_CONVERGED) return true;
  if (stop === STOP_ESCALATE) return true;         // regressed / stalled-at-limit
  if (stop === STOP_CONVERGED) return true;
  return false;
}

/**
 * 回放整条事件流，派生出当前还原轨迹的状态。纯函数，绝不抛。
 *
 * 关键产出 `stallCount`：**跨进程**重建的连续无进展次数——正是 restore-converge 需要、
 * 却在进程边界上断掉的那个数。把它喂回 verifyConvergence({ stallCount }) 即闭合防死循环。
 *
 * @param {Array<object>} events - buildEvent 追加出的事件流（顺序即时间序）
 * @returns {{
 *   attempts:number, stallCount:number,
 *   lastVerdict:string, lastStop:string,
 *   converged:boolean, escalated:boolean, terminal:boolean,
 *   distinctStrategies:string[], lastAction:string,
 *   history:Array<object>, summary:string
 * }}
 *   空 / 畸形输入 → 干净初始态（attempts:0, stallCount:0, 非终结）；绝不抛、绝不假报终结。
 */
function deriveJournalState(events) {
  const empty = {
    attempts: 0, stallCount: 0,
    lastVerdict: '', lastStop: '',
    converged: false, escalated: false, terminal: false,
    distinctStrategies: [], lastAction: '',
    history: [], summary: '还原轨迹为空：尚未记录任何一步（stallCount 从 0 起）。',
  };
  try {
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) return empty;

    let stallCount = 0;
    let converged = false;
    let escalated = false;
    let lastVerdict = '';
    let lastStop = '';
    let lastAction = '';
    const strategies = new Set();
    const history = [];

    for (const raw of list) {
      const e = raw && typeof raw === 'object' ? raw : {};
      const verdict = _str(e.verdict);
      const stop = _str(e.stop);

      // stallCount 回放（唯一真源：_STALL_RULE）
      const rule = _STALL_RULE[verdict];
      if (rule === _STALL_RESET) stallCount = 0;
      else if (rule === _STALL_INC) stallCount += 1;
      // _STALL_KEEP 及未知 verdict：保持不变（保守：不虚增亦不清零）

      if (verdict === VERDICT_CONVERGED) converged = true;
      if (_isTerminalVerdict(verdict, stop)) {
        if (verdict !== VERDICT_CONVERGED) escalated = true;
      }

      lastVerdict = verdict || lastVerdict;
      lastStop = stop || lastStop;
      if (e.strategy) strategies.add(_str(e.strategy));
      if (e.action) lastAction = _redact(e.action);

      history.push({
        seq: Number.isFinite(e.seq) ? e.seq : history.length,
        verdict, stop,
        strategy: _str(e.strategy),
        stallAfter: stallCount,
      });
    }

    const terminal = converged || escalated;
    const trimmed = history.length > MAX_HISTORY
      ? history.slice(history.length - MAX_HISTORY)
      : history;

    let summary;
    if (converged) {
      summary = `轨迹 ${list.length} 步后已收敛（converged）：还原完成，无需再自驱。`;
    } else if (escalated) {
      summary = `轨迹 ${list.length} 步后升级交人（${lastVerdict || 'escalate'}）：`
        + `连续无进展累计 stallCount=${stallCount}，防死循环已跨进程生效。`;
    } else {
      summary = `轨迹 ${list.length} 步，未终结：当前跨进程 stallCount=${stallCount}`
        + `（下次 converge 应带上它，而非从 0 重置）。`;
    }

    return {
      attempts: list.length,
      stallCount,
      lastVerdict, lastStop,
      converged, escalated, terminal,
      distinctStrategies: Array.from(strategies).sort(),
      lastAction,
      history: trimmed,
      summary,
    };
  } catch {
    // 不确定即回到干净初始态：绝不假报终结、绝不虚构 stallCount。
    return empty;
  }
}

/**
 * 便捷器：直接给出下一次 converge 该带的 stallCount（= 回放后的累计值）。纯函数，绝不抛。
 * @param {Array<object>} events
 * @returns {number}
 */
function nextStallCountFor(events) {
  try { return deriveJournalState(events).stallCount; } catch { return 0; }
}

module.exports = {
  buildEvent,
  deriveJournalState,
  nextStallCountFor,
  // verdict / stop / 累计常量（与 restore-converge 对齐）
  VERDICT_ADVANCED, VERDICT_CONVERGED, VERDICT_REGRESSED, VERDICT_STALLED,
  STOP_CONTINUE, STOP_CONVERGED, STOP_ESCALATE,
  MAX_HISTORY,
  // 供测试锁定：
  _STALL_RULE, _isTerminalVerdict, _actionIsSafe, _redact, _DANGER_TOKENS,
};
