'use strict';

/**
 * skeletonReconstructor.js — L2「骨相重构」坍缩器（DESIGN-ARCH-036 §3.2）。
 *
 * 面向极度混乱/长文/自相矛盾的输入：语义切片 → 每片重构为一个状态 → 串成转移矩阵，
 * 同时**标记**（不调和）矛盾点，交由 AnomalyHandler 决定拒损或降级（防呆④：绝不脑补调和）。
 *
 * 切片：按句末标点与显式转折/反悔词切分。
 * 状态：每片下沉到 L0 reduceClause 取动作语义，状态名 = 动作 + 目标指针。
 * 转移：相邻状态以 on:'next' 顺序连接；遇转折词（但是/改主意/算了/推翻）时，
 *       把前后两片标记为 contradiction，并将后继状态 status=CONFLICT。
 * 矛盾：同一目标实体上出现“做 X”与“不要/取消 X”的反向动作对 → markContradiction。
 *
 * 纯词法、零模型。
 */

const { EntityRegistry } = require('./entityRegistry');
const { StateMachine } = require('./stateMachine');
const { reduceClause, strategyForActions, _uid } = require('./dimensionReducer');

// 句子切片：句末标点 + 序列连接词 + 逗号。L2 面向混乱长文，切得细才能把
// 反悔/否定对分到相邻片，从而被矛盾检测捕获（粗切会把自相矛盾埋进同一片里漏掉）。
const SENTENCE_SPLIT_RE = /[。！？!?\n；;，,]+|然后|接着|之后|随后|再(?=[^，。])/;

// 转折/反悔标记：出现即表示其所在片与前文可能冲突。
const REVERSAL_RE = /(但是|可是|不过|然而|算了|改主意|改了主意|又不|还是不|推翻|取消|撤销|反悔|however|but|actually|never\s?mind|cancel|undo|scratch that)/i;

// 否定标记：用于检测“做 X”与“不做 X”的反向动作对。
const NEGATION_RE = /(不要|不用|别|无需|不需要|don't|do not|no need|without)/i;

function splitSlices(raw) {
  return String(raw || '')
    .split(SENTENCE_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * L2 主入口：混乱 NL → StateMachine payload。
 * @param {string} raw
 * @param {EntityRegistry} [registry]
 * @returns {object} StateMachine payload（待 forgeSchema.validateStateMachine 校验）
 */
function reconstruct(raw, registry = new EntityRegistry()) {
  const slices = splitSlices(raw);
  const sm = new StateMachine();
  const stateUids = [];
  const actions = [];
  // 目标实体 → 它上面已出现过的 (动作, 是否否定, stateUid)，用于反向动作对检测。
  const seenOnTarget = new Map();

  slices.forEach((slice, i) => {
    const reduced = reduceClause(slice, registry);
    const negated = NEGATION_RE.test(slice);
    const stateUid = _uid('st', `${i}:${slice}`);
    const reversal = i > 0 && REVERSAL_RE.test(slice);
    sm.addState({
      uid: stateUid,
      name: `${reduced.action}:${reduced.target.uid}`,
      status: reversal ? 'CONFLICT' : 'PENDING',
      slice: slice.slice(0, 80),
      confidence: reduced.confidence,
    });
    stateUids.push(stateUid);
    actions.push(reduced.action);

    // 转折词 → 与前一片标记矛盾（不调和，仅标记）。
    if (reversal) {
      sm.markContradiction(stateUids[i - 1], stateUid, 'reversal-marker');
    }

    // 反向动作对：同一目标上既有正向又有否定的同类动作。
    const tgt = reduced.target.uid;
    const prior = seenOnTarget.get(tgt);
    if (prior && prior.action === reduced.action && prior.negated !== negated) {
      sm.markContradiction(prior.stateUid, stateUid, 'contradictory-directive-on-entity');
      const cur = sm.states.get(stateUid);
      if (cur) cur.status = 'CONFLICT';
    }
    seenOnTarget.set(tgt, { action: reduced.action, negated, stateUid });
  });

  if (stateUids.length) sm.setInitial(stateUids[0]);
  for (let i = 1; i < stateUids.length; i++) {
    sm.addTransition(stateUids[i - 1], stateUids[i], 'next', {
      confidence: sm.states.get(stateUids[i]).confidence,
    });
  }

  const entities = {};
  for (const e of registry.list()) entities[e.uid] = e;

  // 含矛盾或含高风险动作 → 锁级在 L0 基线上由 chaosInterceptor/anomalyHandler 进一步 escalate；
  // 这里给出 L2 自身的基线建议。
  const baseStrategy = strategyForActions(actions);

  return {
    kind: 'StateMachine',
    uid: _uid('sm', raw),
    machine: sm.toJSON(),
    entities,
    strategy: baseStrategy,
    confidence: stateUids.length
      ? Math.min(...stateUids.map((u) => sm.states.get(u).confidence))
      : 1,
    hasContradictions: sm.hasContradictions(),
    contradictions: sm.contradictions.slice(),
  };
}

module.exports = { reconstruct, splitSlices, REVERSAL_RE, NEGATION_RE };
