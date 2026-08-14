'use strict';

/**
 * restoreConflictDetector.js — Khy-OS 三面镜子「矛盾冲突」检测器（确定性纯叶子）
 *
 * 送别礼 · agent 创新点（矛盾冲突角度）：
 *   上一件送别礼 agentRestorePlan 把三面还原镜子**合成**成一份有序方案——但它
 *   **默认三面镜子彼此一致**。现实里三面镜子探同一批事实却走**不同代码路径**：
 *     · restore-check   跑 `node --version` / 探 bundle 目录 / 读版本文件
 *     · verify-install  按 CRITICAL_BUNDLE_PATHS 逐个 existsSync
 *     · hydration-doctor 探 node_modules / marker / 软链 / 便携 node
 *   不同路径可能给出**互相矛盾的结论**（一个说就绪、一个说残缺；一个说完整、
 *   一个说缺关键包）。一个落地在陌生机器上的 agent 若拿着**自相矛盾的世界模型**
 *   去无人值守地自动还原，是危险的——它可能照着一面绿灯猛冲，无视另一面红灯。
 *
 *   khy 此前缺这一层：没有任何东西检测「我的三个传感器是否自相矛盾」。本文件补上
 *   这个**元诊断**——在 agent 信任合成方案、开始自动还原**之前**，先问一句
 *   「三面镜子彼此一致吗？」。若发现硬矛盾 → `safeToAutodrive:false`，agent
 *   **必须停下**：重新探测或升级交人，绝不在矛盾的世界模型上自动行动。
 *   这就是矛盾冲突角度的 agent 创新：让系统能识别并如实上报「自身认知的不一致」。
 *
 * 冲突分两级：
 *   'contradiction'（硬矛盾）：两面镜子对**重叠事实**给出逻辑不相容的结论，或某面
 *       镜子**自身**顶层判定与其明细自相矛盾。→ 世界模型不可信，禁止自动还原。
 *   'severity'（分级分歧）：两面镜子**认同同一事实**但**给了不同严重度**（一个当
 *       正常首启提醒、一个当拦路项）。→ 事实一致、可继续，但如实标注供 agent 权衡。
 *
 * 消解取向恒为「安全优先」：矛盾时一律信**更悲观**的那面镜子，且冲突步的 autonomy
 * 恒为 human（不确定就交人，绝不让 agent 替你赌）。
 *
 * 分层：纯核心——零 IO、无时钟、无随机、无网络、同输入恒同输出、绝不抛。三面镜子
 * 的评估对象由 CLI scripts/restore-conflicts.js 采集（复用 restore-plan 的
 * gatherAssessments，零重复）后喂进本文件。本文件只做纯比对。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 发现一类新的跨镜子矛盾 → 往 _CONFLICT_RULES 追加一条
 *      { id, severity, when(m), title, trust, mirrors, advice }。when(m) 是纯谓词，
 *      读 {restore, integrity, hydration} 返回真=命中；trust 填矛盾时该信哪面镜子
 *      （永远填更悲观那面）；advice 是照抄即用的安全处置（重探/升级，务必不含
 *      commit/push/rm/curl/publish）。
 *   2. 谨记「规则未命中 ≠ 事实为真」：镜子规则只在事实明确为坏时才 fire，缺席可能
 *      是「好」也可能是「未探测」。只在**双方都做出明确相反断言**时才判硬矛盾，
 *      拿不准就别报（宁可漏报矛盾，不可误伤正常首启）。
 *   3. 改完跑：node --test scripts/tests/restoreConflictDetector.test.js（必须绿）。
 */

const SEVERITY_CONTRADICTION = 'contradiction';
const SEVERITY_DISAGREEMENT = 'severity';

// 处置建议里绝不允许出现的危险动作（与手册同源红线，避免元诊断反教危险操作）。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// hydration 里「首启正常态」的 blocker id：node_modules 尚未水合本就是首次运行的
// 常态，restore-check 在联网时会把它降级成 warning。二者只是**分级分歧**而非事实
// 矛盾。除此之外的 hydration blocker（缺关键包 / 裂脑 marker / 断链 / 便携 node 缺）
// 都是 restore 没抓到的真问题 → restore 误判就绪 = 硬矛盾。
const _FIRST_RUN_NORMAL_HYDRATION = new Set(['no-node-modules', 'modules-not-hydrated']);

/** 安全取数组（非数组 → 空数组）。 */
function _arr(v) {
  return Array.isArray(v) ? v : [];
}

/** 某评估对象里是否含指定 id 的 blocker。缺失/异常 → false。 */
function _hasBlocker(assessment, id) {
  if (!assessment || typeof assessment !== 'object') return false;
  return _arr(assessment.blockers).some((b) => b && b.id === id);
}

/** hydration 的 blocker 是否**全部**落在首启正常态集合内。无 blocker → false（无冲突）。 */
function _hydrationBlockersAllNormal(hydration) {
  const bs = _arr(hydration && hydration.blockers);
  if (bs.length === 0) return false;
  return bs.every((b) => b && _FIRST_RUN_NORMAL_HYDRATION.has(b.id));
}

// 跨镜子冲突规则表：每条纯谓词 + 消解取向 + 安全处置。命中即产出一条冲突。
const _CONFLICT_RULES = [
  {
    id: 'ready-but-bundle-incomplete',
    severity: SEVERITY_CONTRADICTION,
    mirrors: ['restore', 'integrity'],
    when: (m) => m.restore && m.restore.ready === true &&
      m.integrity && m.integrity.intact === false,
    title: '还原自检说「就绪」，但完整性自检说「已装副本缺运行时关键文件」——两面镜子结论相悖',
    trust: 'integrity',
    advice: '信更悲观的完整性自检：先按 verify-install 的缺失清单补齐（多为重装官方包），再重跑 restore-check 确认；缺关键文件时切勿当作已就绪自动往下走。',
  },
  {
    id: 'ready-but-hydration-blocked',
    severity: SEVERITY_CONTRADICTION, // 运行期按 hydration blocker 内容动态降级
    mirrors: ['restore', 'hydration'],
    when: (m) => m.restore && m.restore.ready === true &&
      m.hydration && m.hydration.healthy === false,
    title: '还原自检说「就绪」，但水合自检说「不健康（有拦路项）」——两面镜子结论相悖',
    trust: 'hydration',
    advice: '信更悲观的水合自检：先跑 hydration-doctor 复核，若确有缺关键包/裂脑/断链则不可当就绪；若仅是 node_modules 尚未水合（首启常态），联网跑一次 khy 即收敛。',
  },
  {
    id: 'intact-but-restore-bundle-missing',
    severity: SEVERITY_CONTRADICTION,
    mirrors: ['integrity', 'restore'],
    when: (m) => m.integrity && m.integrity.intact === true &&
      _hasBlocker(m.restore, 'bundle-missing'),
    title: '完整性自检说「副本完整」，但还原自检说「bundled 源码缺失」——同一 bundle 既完整又缺失，传感器互斥',
    trust: 'restore',
    advice: '两面镜子对同一 bundle 给出互斥结论，说明其一探测口径已漂移或机器处于装到一半的中间态：先重新分别跑两条自检复核，仍矛盾则升级交人排查安装路径，切勿自动还原。',
  },
  // ── 自一致性（防单面镜子自身损坏/漂移）──
  {
    id: 'restore-internal-inconsistent',
    severity: SEVERITY_CONTRADICTION,
    mirrors: ['restore'],
    when: (m) => m.restore && m.restore.ready === true && _arr(m.restore.blockers).length > 0,
    title: '还原自检自相矛盾：顶层判「就绪」却带着非空拦路项清单',
    trust: 'blockers',
    advice: '该镜子自身判定与明细不符，多为版本损坏或被改坏：重装官方包后重跑 restore-check；在它自洽前不要信它的就绪结论。',
  },
  {
    id: 'integrity-internal-inconsistent',
    severity: SEVERITY_CONTRADICTION,
    mirrors: ['integrity'],
    when: (m) => m.integrity && m.integrity.intact === true && _arr(m.integrity.missing).length > 0,
    title: '完整性自检自相矛盾：顶层判「完整」却带着非空缺失清单',
    trust: 'missing',
    advice: '该镜子自身判定与明细不符：重装官方包后重跑 verify-install；在它自洽前不要信它的完整结论。',
  },
  {
    id: 'hydration-internal-inconsistent',
    severity: SEVERITY_CONTRADICTION,
    mirrors: ['hydration'],
    when: (m) => m.hydration && m.hydration.healthy === true && _arr(m.hydration.blockers).length > 0,
    title: '水合自检自相矛盾：顶层判「健康」却带着非空拦路项清单',
    trust: 'blockers',
    advice: '该镜子自身判定与明细不符：重跑 hydration-doctor 复核；在它自洽前不要信它的健康结论。',
  },
];

/** 断言一段处置文本不含危险动作（内部自检 / 防越界用）。 */
function _adviceIsSafe(text) {
  const s = String(text || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/**
 * 检测三面镜子间的矛盾冲突。纯计算，绝不抛：任何异常退化为「无冲突、但保守不放行
 * 自动还原」的安全结果（异常本身就是不确定，不确定不自动）。
 *
 * @param {object} mirrors
 *   mirrors.restore   restoreReadiness.assessRestoreReadiness 的返回（可空/部分）
 *   mirrors.integrity installIntegrity.assessInstallIntegrity 的返回（可空/部分）
 *   mirrors.hydration hydrationHealth.assessHydrationHealth 的返回（可空/部分）
 * @returns {{
 *   consistent:boolean, safeToAutodrive:boolean,
 *   conflicts:Array<{id,severity,title,mirrors:string[],trust,autonomy,advice}>,
 *   contradictions:number, disagreements:number, summary:string
 * }}
 *   safeToAutodrive=false 当且仅当存在 'contradiction' 级冲突（分级分歧不阻断自动还原）。
 *   每条冲突 autonomy 恒为 'human'（矛盾一律止步交人）。
 */
function detectRestoreConflicts(mirrors) {
  try {
    const m = mirrors && typeof mirrors === 'object' ? mirrors : {};
    const conflicts = [];
    for (const rule of _CONFLICT_RULES) {
      let hit = false;
      try {
        hit = rule.when(m) === true;
      } catch {
        hit = false; // 谓词自身出错绝不冒泡
      }
      if (!hit) continue;

      // ready-but-hydration-blocked 动态降级：hydration 的 blocker 若全是首启正常态
      // → 双方认同事实、仅分级不同 → 降为 'severity'（不阻断自动还原）。
      let severity = rule.severity;
      if (rule.id === 'ready-but-hydration-blocked' && _hydrationBlockersAllNormal(m.hydration)) {
        severity = SEVERITY_DISAGREEMENT;
      }

      const advice = _adviceIsSafe(rule.advice)
        ? rule.advice
        : '处置建议含被禁动作已隐去；请查阅 khyos 官方还原文档人工处置。';

      conflicts.push({
        id: rule.id,
        severity,
        title: rule.title,
        mirrors: Array.isArray(rule.mirrors) ? rule.mirrors.slice() : [],
        trust: rule.trust,
        autonomy: 'human', // 矛盾一律止步交人
        advice,
      });
    }

    // 确定性排序：硬矛盾在前、同级按 id 字典序。
    conflicts.sort((a, b) => {
      const ra = a.severity === SEVERITY_CONTRADICTION ? 0 : 1;
      const rb = b.severity === SEVERITY_CONTRADICTION ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const contradictions = conflicts.filter((c) => c.severity === SEVERITY_CONTRADICTION).length;
    const disagreements = conflicts.filter((c) => c.severity === SEVERITY_DISAGREEMENT).length;
    const consistent = conflicts.length === 0;
    const safeToAutodrive = contradictions === 0;

    let summary;
    if (consistent) {
      summary = '三面镜子一致：无矛盾，合成的还原方案可信，agent 可按方案自动还原。';
    } else if (contradictions === 0) {
      summary =
        `三面镜子事实一致但有 ${disagreements} 处分级分歧：不阻断自动还原，agent 按更悲观口径权衡即可。`;
    } else {
      summary =
        `发现 ${contradictions} 处硬矛盾（另有 ${disagreements} 处分级分歧）：` +
        '三面镜子世界模型不一致，禁止 agent 自动还原——先重探/升级交人，信更悲观的那面镜子。';
    }

    return {
      consistent,
      safeToAutodrive,
      conflicts,
      contradictions,
      disagreements,
      summary,
    };
  } catch {
    // 异常=不确定；不确定不放行自动还原（安全优先）。
    return {
      consistent: false,
      safeToAutodrive: false,
      conflicts: [],
      contradictions: 0,
      disagreements: 0,
      summary: '无法判断三面镜子是否矛盾（检测器内部异常，已安全降级为「不放行自动还原」）。',
    };
  }
}

module.exports = {
  detectRestoreConflicts,
  _CONFLICT_RULES,
  _adviceIsSafe,
  _hasBlocker,
  _hydrationBlockersAllNormal,
  _FIRST_RUN_NORMAL_HYDRATION,
  _DANGER_TOKENS,
  SEVERITY_CONTRADICTION,
  SEVERITY_DISAGREEMENT,
};
