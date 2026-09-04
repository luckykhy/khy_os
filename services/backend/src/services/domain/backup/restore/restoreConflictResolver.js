'use strict';

/**
 * restoreConflictResolver.js — 三面镜子「矛盾冲突消解器」（纯叶子 · 零 IO · 绝不抛）
 *
 * 家族第四层。承接三面镜子与它们的两个上层：
 *   ①三面镜子   restoreReadiness / installIntegrity / hydrationHealth（各自诊断）
 *   ②restore-plan（OPS-MAN-075）  把三者**合成**为有序还原方案——默认三镜子一致
 *   ③restore-conflicts（OPS-MAN-076）  **检测**三镜子是否互相矛盾——发现硬矛盾即
 *       `safeToAutodrive:false`，且**每条冲突 autonomy 恒为 'human'**（一刀切「止步交人」）
 *   ④本层（OPS-MAN-079）  **消解**——把检测器那记「一律止步」的红灯，升级成一套
 *       *有原则、有序、安全优先*的走出矛盾的恢复程序，并**精确标出**自动化在哪一步
 *       必须交人。这正是「矛盾冲突解决」这一 agent 创新点：检测只回答「矛不矛盾」，
 *       消解回答「矛盾了，agent 该怎么安全地一步步解开，到哪必须停手」。
 *
 * ── 为什么需要「消解」这一层 ────────────────────────────────────────────────
 * 检测器出于安全，对任何硬矛盾都盖一句「止步交人」。但矛盾其实分层：
 *   · 有的矛盾是**瞬时/竞态读数**（装到一半时抢跑）→ 最便宜的解法是重探一次，可能直接消失；
 *   · 有的矛盾是**单面镜子自相矛盾**（顶层布尔与明细清单打架）→ 采信一手证据即当场化解，
 *     根本无需外部动作；
 *   · 有的矛盾是**跨镜子真分歧**（两面都自洽却结论互斥）→ 安全优先采信更悲观者并跑其补救；
 *   · 只有**重探不消失、且补救本身越界**（重装/查安装路径）的，才真正需要人。
 * 把这四类不加区分地全丢给人，等于让 agent 在本可自愈的场景下也干等——这既拖慢还原，
 * 也违背「让系统自己讲清如何自主恢复、并精确止步升级」的初衷。消解器给每条矛盾配一条
 * **有序恢复链**（reprobe → reconcile → trust-pessimistic → escalate），并逐条判定它是否
 * `autoResolvable`（终局落在 agent 且不含 escalate）。
 *
 * ── 四种消解策略（strategy）──────────────────────────────────────────────────
 *   reprobe            重探：重跑起分歧的探测器。最便宜、幂等、零风险，永远 agent。
 *   reconcile          自洽消解：单面镜子内部打架时，采信「明细清单」（一手证据）而非
 *                      「顶层布尔」（派生结论）。是一次安全的推理决策，无外部变更，agent。
 *   trust-pessimistic  安全优先：跨镜子真分歧时采信更悲观者并跑其补救。补救幂等（重新水合/
 *                      自愈标记）→ agent；补救越界（重装官方包/取源）→ human。
 *   escalate           升级交人：重探不消失、且无安全自动解法（如安装路径级互斥）→ 残留冲突。
 *
 * 恒久红线：任何 action 文本先过 `_DANGER_TOKENS` 自检；命中即强制 autonomy='human' 并隐去
 * 原文（消解器绝不诱导 agent 跑 commit/push/rm/curl/publish）。异常一律安全降级为
 * 「不可自动消解、须人工」（不确定即交人）。
 *
 * ── HOW-TO-EXTEND（抄写式）──────────────────────────────────────────────────
 * 新增一条冲突的消解方案（当检测器 `_CONFLICT_RULES` 加了新 id 时同步补此表）：
 *   1) 在 `_RESOLUTIONS` 加一项 `{ id:'<与检测器同款冲突 id>', build(m){ return [ ... ] } }`；
 *   2) build 返回**有序** move 数组，每个 move 用 `_move(strategy, autonomy, action, verify, rationale)`
 *      产出（`_move` 会自动过危险令牌、补 order）；
 *   3) 若补救 autonomy 依赖运行期事实（如 hydration blocker 类型），在 build 内用 mirrors 动态判；
 *   4) 未登记 id 会落 `_FALLBACK_RESOLUTION`（保守：单条 escalate/human，绝不漏判为可自动）。
 * 严禁把新逻辑塞进 `resolveRestoreConflicts` 主体；主体只做「查表 → 汇总」。
 */

// ── 策略常量与排序 ────────────────────────────────────────────────────────────
const STRATEGY_REPROBE = 'reprobe';
const STRATEGY_RECONCILE = 'reconcile';
const STRATEGY_TRUST_PESSIMISTIC = 'trust-pessimistic';
const STRATEGY_ESCALATE = 'escalate';

const AGENT = 'agent';
const HUMAN = 'human';

// move 的确定性排序键：先便宜后昂贵——重探(可能直接消解) < 自洽(纯推理) < 采信悲观(带补救) < 升级(交人)。
const _STRATEGY_ORDER = Object.freeze({
  [STRATEGY_REPROBE]: 10,
  [STRATEGY_RECONCILE]: 20,
  [STRATEGY_TRUST_PESSIMISTIC]: 30,
  [STRATEGY_ESCALATE]: 90,
});

// 与检测器同源的危险令牌黑名单（消解 action 绝不含这些）。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// 首启常态 hydration 拦路项（跑一次 khy 即自然收敛，非真矛盾）——与检测器同款集合。
const _FIRST_RUN_NORMAL_HYDRATION = new Set(['no-node-modules', 'modules-not-hydrated']);

// agent 可幂等自愈的 hydration 拦路项（重新水合 / 自愈标记即可）。此分类与 agentRestorePlan
// 的 _CONCERN_POLICY autonomy 取向保持一致：可水合/可自愈→agent；需取源→human。
const _AGENT_FIXABLE_HYDRATION = new Set([
  'no-node-modules', 'modules-not-hydrated', 'missing-critical-package',
  'optional-degraded', 'splitbrain-marker', 'shared-link-broken', 'portable-node-missing',
]);
// 结构性拦路项：需要人工提供官方包 / 种子，agent 无法凭空补。
const _STRUCTURAL_HYDRATION = new Set(['seed-missing']);

// ── 小工具（全 fail-soft，绝不抛）─────────────────────────────────────────────
function _arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 断言一段 action 文本不含危险动作。 */
function _actionIsSafe(text) {
  const s = String(text || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/** hydration 的 blocker 是否全落在首启正常态集合内（无 blocker → false）。 */
function _hydrationBlockersAllNormal(hydration) {
  const bs = _arr(hydration && hydration.blockers);
  if (bs.length === 0) return false;
  return bs.every((b) => b && _FIRST_RUN_NORMAL_HYDRATION.has(b.id));
}

/** hydration 的 blocker 是否**全部** agent 可自愈（含首启常态）。空 → true（无阻碍）。 */
function _hydrationAllAgentFixable(hydration) {
  const bs = _arr(hydration && hydration.blockers);
  return bs.every((b) =>
    b && (_AGENT_FIXABLE_HYDRATION.has(b.id) || _FIRST_RUN_NORMAL_HYDRATION.has(b.id))
    && !_STRUCTURAL_HYDRATION.has(b.id));
}

/**
 * 造一个消解 move。危险令牌自检：命中即强制 human 并隐去原文（防越界）。
 * @returns {{strategy,autonomy,action,verify,rationale,order}}
 */
function _move(strategy, autonomy, action, verify, rationale) {
  const safe = _actionIsSafe(action);
  return {
    strategy,
    autonomy: safe ? autonomy : HUMAN, // 危险动作一律交人
    action: safe
      ? String(action || '')
      : '（原消解动作含被禁令牌，已隐去）请查阅 khyos 官方还原文档人工处置。',
    verify: String(verify || ''),
    rationale: String(rationale || ''),
    order: _STRATEGY_ORDER[strategy] != null ? _STRATEGY_ORDER[strategy] : 99,
  };
}

// ── 消解方案表：冲突 id → 有序 move 链构造器 ─────────────────────────────────────
// 每条与检测器 `_CONFLICT_RULES` 的 id 一一对应。build(mirrors) 返回有序 move 数组。
const _RESOLUTIONS = [
  {
    id: 'ready-but-bundle-incomplete',
    resolvesTo: '收敛到「未就绪、需补齐缺失文件」的一致结论',
    build() {
      return [
        _move(STRATEGY_REPROBE, AGENT,
          '用同一 bundle 根重跑 verify-install 与 restore-check，排除装到一半时的瞬时/竞态读数',
          'node scripts/verify-install.js && node scripts/restore-check.js',
          '矛盾可能来自其一探到了装到一半的中间态；最便宜的消解是重探一次，可能直接消失'),
        _move(STRATEGY_TRUST_PESSIMISTIC, HUMAN,
          '若重探后仍矛盾：采信更悲观的完整性自检，按其缺失清单补齐（多为重装官方 khy-os 包），再重跑两条自检确认收敛',
          'node scripts/verify-install.js  # intact:true 且 missing 为空即收敛',
          '两面镜子不能同真时安全优先信更悲观者；补齐关键文件属重装/取源，越界须人工'),
      ];
    },
  },
  {
    id: 'ready-but-hydration-blocked',
    resolvesTo: '首启常态→跑一次 khy 收敛；真拦路项→收敛到「未就绪、按水合补救」',
    build(m) {
      // 首启常态：非真矛盾，跑一次 khy 即收敛（检测器已降级为 severity）。
      if (_hydrationBlockersAllNormal(m.hydration)) {
        return [
          _move(STRATEGY_REPROBE, AGENT,
            '联网跑一次 khy 触发首启水合，再跑 hydration-doctor 复核',
            'node scripts/hydration-doctor.js  # healthy:true 即收敛',
            '水合拦路项全属首启常态（node_modules 尚未水合），非真矛盾；跑一次即自然收敛'),
        ];
      }
      // 真拦路项：安全优先采信水合自检；补救 autonomy 依赖拦路项是否全可水合。
      const allAgent = _hydrationAllAgentFixable(m.hydration);
      return [
        _move(STRATEGY_REPROBE, AGENT,
          '重跑 hydration-doctor 复核，排除首启竞态',
          'node scripts/hydration-doctor.js',
          '先重探一次，排除首启抢跑造成的假阳'),
        _move(STRATEGY_TRUST_PESSIMISTIC, allAgent ? AGENT : HUMAN,
          allAgent
            ? '采信更悲观的水合自检：联网重跑 khy 重新水合缺失包、自愈裂脑/断链标记，再复核'
            : '采信更悲观的水合自检：其中含结构性拦路项（缺种子等），须人工提供官方包/种子后再复核',
          'node scripts/hydration-doctor.js  # healthy:true 即收敛',
          '安全优先信更悲观的水合自检；可水合项 agent 幂等自愈，需取源的结构性项须人工'),
      ];
    },
  },
  {
    id: 'intact-but-restore-bundle-missing',
    resolvesTo: '重探对齐则消解；仍互斥则残留为需人工排查安装路径的冲突',
    build() {
      return [
        _move(STRATEGY_REPROBE, AGENT,
          '用同一显式 bundle 根重跑 verify-install 与 restore-check，排除二者路径解析口径漂移',
          'node scripts/verify-install.js && node scripts/restore-check.js',
          '「同一 bundle 既完整又缺失」通常是两自检解析 bundle 根的口径不一致；对齐根后重探多能消解'),
        _move(STRATEGY_ESCALATE, HUMAN,
          '若对齐根后仍互斥：升级交人排查安装路径（机器可能处于装到一半的中间态），切勿自动还原',
          '人工确认 bundle 真实路径与内容后，两自检结论应对齐',
          '两传感器对同一实体给出互斥事实且重探不消解，超出安全自动化边界，须人工裁决'),
      ];
    },
  },
  // ── 单面镜子自相矛盾：一律 reconcile（采信明细一手证据，弃派生布尔）──
  {
    id: 'restore-internal-inconsistent',
    resolvesTo: '以明细拦路项为准（视为未就绪），自相矛盾当场消解',
    build() {
      return [
        _move(STRATEGY_RECONCILE, AGENT,
          '以明细为准：采信非空 blockers 清单（一手证据），不信顶层 ready:true（派生结论），按未就绪逐条处置拦路项',
          'node scripts/restore-check.js  # 修好底层后 ready 与 blockers 应一致',
          '顶层布尔是派生量、明细清单是一手证据；证据高于结论，采信明细即当场消解自相矛盾'),
      ];
    },
  },
  {
    id: 'integrity-internal-inconsistent',
    resolvesTo: '以明细缺失清单为准（视为不完整），自相矛盾当场消解',
    build() {
      return [
        _move(STRATEGY_RECONCILE, AGENT,
          '以明细为准：采信非空 missing 清单（一手证据），不信顶层 intact:true（派生结论），按不完整补齐缺失文件',
          'node scripts/verify-install.js  # 补齐后 intact 与 missing 应一致',
          '顶层布尔是派生量、明细清单是一手证据；证据高于结论，采信明细即当场消解自相矛盾'),
      ];
    },
  },
  {
    id: 'hydration-internal-inconsistent',
    resolvesTo: '以明细拦路项为准（视为不健康），自相矛盾当场消解',
    build() {
      return [
        _move(STRATEGY_RECONCILE, AGENT,
          '以明细为准：采信非空 blockers 清单（一手证据），不信顶层 healthy:true（派生结论），按不健康跑水合补救',
          'node scripts/hydration-doctor.js  # 补救后 healthy 与 blockers 应一致',
          '顶层布尔是派生量、明细清单是一手证据；证据高于结论，采信明细即当场消解自相矛盾'),
      ];
    },
  },
];

// 未登记冲突 id 的兜底：保守单条 escalate/human，绝不误判为可自动消解。
const _FALLBACK_RESOLUTION = Object.freeze({
  resolvesTo: '未登记的冲突类型：保守升级交人',
  build() {
    return [
      _move(STRATEGY_ESCALATE, HUMAN,
        '未登记的冲突类型：无既定安全消解路径，升级交人排查，切勿自动还原',
        '人工排查后补一条消解方案进 restoreConflictResolver._RESOLUTIONS',
        '未知即不确定；不确定不自动'),
    ];
  },
});

function _resolutionFor(id) {
  return _RESOLUTIONS.find((r) => r.id === id) || _FALLBACK_RESOLUTION;
}

/** 一条冲突是否可被 agent 自主消解：终局 move 落 agent 且全链不含 escalate。 */
function _conflictAutoResolvable(moves) {
  if (moves.length === 0) return false;
  if (moves.some((mv) => mv.strategy === STRATEGY_ESCALATE)) return false;
  const terminal = moves[moves.length - 1];
  return terminal.autonomy === AGENT;
}

/**
 * 消解三面镜子间的矛盾冲突。纯计算，绝不抛。
 *
 * @param {object} mirrors    三面镜子评估（restore/integrity/hydration，可空/部分）
 * @param {object} [detection] 检测器结果；不给则内部调用 detectRestoreConflicts(mirrors)
 * @returns {{
 *   resolvable:boolean, autoResolvable:boolean, humanRequired:boolean,
 *   safeAfterResolution:boolean,
 *   resolutions:Array<{conflictId,severity,trust,resolvesTo,autoResolvable,
 *                      terminalAutonomy,moves:Array}>,
 *   moves:Array<{strategy,autonomy,action,verify,rationale,order,covers:string[]}>,
 *   residualConflicts:string[], firstHumanMove:object|null,
 *   autoResolvableCount:number, humanRequiredCount:number, summary:string
 * }}
 *   autoResolvable=true 当且仅当**每条**冲突都 agent 可自主消解（无残留交人）。
 *   safeAfterResolution：执行完 agent 可自动的消解 move 后能否回到「可自动还原」——
 *   等于「无残留需人工的冲突」。
 */
function resolveRestoreConflicts(mirrors, detection) {
  try {
    const m = mirrors && typeof mirrors === 'object' ? mirrors : {};
    // 允许注入 detection（测试用）；否则惰性引入检测器自算（避免循环依赖只在此处 require）。
    let det = detection;
    if (!det || typeof det !== 'object') {
      // eslint-disable-next-line global-require
      const { detectRestoreConflicts } = require('./restoreConflictDetector');
      det = detectRestoreConflicts(m);
    }
    const conflicts = _arr(det.conflicts);

    if (conflicts.length === 0) {
      return {
        resolvable: true,
        autoResolvable: true,
        humanRequired: false,
        safeAfterResolution: true,
        resolutions: [],
        moves: [],
        residualConflicts: [],
        firstHumanMove: null,
        autoResolvableCount: 0,
        humanRequiredCount: 0,
        summary: '三面镜子无矛盾：无需消解，agent 可直接按合成方案自动还原。',
      };
    }

    const resolutions = [];
    for (const c of conflicts) {
      const spec = _resolutionFor(c.id);
      let moves;
      try {
        moves = _arr(spec.build(m));
      } catch {
        moves = _FALLBACK_RESOLUTION.build(m); // 构造器出错绝不冒泡→保守兜底
      }
      const auto = _conflictAutoResolvable(moves);
      const terminal = moves.length ? moves[moves.length - 1] : null;
      resolutions.push({
        conflictId: c.id,
        severity: c.severity,
        trust: c.trust,
        resolvesTo: spec.resolvesTo || '',
        autoResolvable: auto,
        terminalAutonomy: terminal ? terminal.autonomy : HUMAN,
        moves,
      });
    }

    // 汇总所有 move；按 (strategy+action) 去重合并（多条冲突常共用同一次重探）。
    const merged = new Map();
    for (const r of resolutions) {
      for (const mv of r.moves) {
        const key = `${mv.strategy}|${mv.action}`;
        if (merged.has(key)) {
          merged.get(key).covers.push(r.conflictId);
        } else {
          merged.set(key, Object.assign({}, mv, { covers: [r.conflictId] }));
        }
      }
    }
    const moves = Array.from(merged.values()).sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      const ka = a.covers[0] || '';
      const kb = b.covers[0] || '';
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });

    const residualConflicts = resolutions
      .filter((r) => !r.autoResolvable)
      .map((r) => r.conflictId);
    const autoResolvableCount = resolutions.filter((r) => r.autoResolvable).length;
    const humanRequiredCount = residualConflicts.length;
    const autoResolvable = humanRequiredCount === 0;
    const firstHumanMove =
      moves.find((mv) => mv.autonomy === HUMAN) || null;

    let summary;
    if (autoResolvable) {
      summary =
        `${resolutions.length} 处矛盾均可由 agent 自主消解（重探/采信明细/幂等补救）：` +
        '按 move 顺序执行并复核，收敛后即可继续自动还原。';
    } else {
      summary =
        `${resolutions.length} 处矛盾中 ${autoResolvableCount} 处可自动消解、` +
        `${humanRequiredCount} 处残留需人工（${residualConflicts.join('、')}）：` +
        'agent 先跑可自动的 move，遇 human 步即止步交人，绝不在残留矛盾上自动还原。';
    }

    return {
      resolvable: true,
      autoResolvable,
      humanRequired: humanRequiredCount > 0,
      safeAfterResolution: autoResolvable,
      resolutions,
      moves,
      residualConflicts,
      firstHumanMove,
      autoResolvableCount,
      humanRequiredCount,
      summary,
    };
  } catch {
    // 异常=不确定；不确定不自动消解（安全优先，交人）。
    return {
      resolvable: false,
      autoResolvable: false,
      humanRequired: true,
      safeAfterResolution: false,
      resolutions: [],
      moves: [],
      residualConflicts: [],
      firstHumanMove: null,
      autoResolvableCount: 0,
      humanRequiredCount: 0,
      summary: '无法消解三面镜子矛盾（消解器内部异常，已安全降级为「须人工」）。',
    };
  }
}

module.exports = {
  resolveRestoreConflicts,
  // 供测试 / 上层复用的内部件（子门族惯例）
  _RESOLUTIONS,
  _FALLBACK_RESOLUTION,
  _resolutionFor,
  _conflictAutoResolvable,
  _move,
  _actionIsSafe,
  _hydrationBlockersAllNormal,
  _hydrationAllAgentFixable,
  STRATEGY_REPROBE,
  STRATEGY_RECONCILE,
  STRATEGY_TRUST_PESSIMISTIC,
  STRATEGY_ESCALATE,
  AGENT,
  HUMAN,
  _STRATEGY_ORDER,
};
