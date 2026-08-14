'use strict';

/**
 * agentRestorePlan.js — Khy-OS 离机还原「可交给 agent 执行的有序方案」合成器（纯叶子）
 *
 * 送别礼 · agent 创新点：
 *   khyos 已有三面独立自检镜子——
 *     · restoreReadiness  「这台机器能不能还原？」   {ready, blockers, warnings}
 *     · installIntegrity  「已装副本完整吗？」        {intact, missing, present}
 *     · hydrationHealth   「首启水合成功了吗？」      {healthy, blockers, warnings}
 *   三面镜子各照一角、症状常重叠、级别互不排序，人要自己在脑内拼。
 *   本文件把三者**合成为一份有序、去重、每步带 autonomy 分类的还原方案**：
 *   一个落地在陌生机器上的 agent 读它就知道——哪些步骤它**可以自己幂等执行**
 *   （跑 khyos 自身命令即可，前提是已联网），到哪一步**必须停下交给人**
 *   （装/卸系统软件、改安装位置或权限、提供网络、重装官方包）。
 *   这就是 khy 此前缺的 agent 创新：系统主动向 agent 自述「如何自主还原、
 *   并在安全边界精确止步升级」。
 *
 * 分层：纯核心——零 IO、无时钟、无随机、无网络、同输入恒同输出、绝不抛
 * （任何异常退化为安全的空方案）。三面镜子的评估对象由 CLI
 * scripts/restore-plan.js 采集（复用三个已有探测器，全 fail-soft）后喂进本文件。
 * 本文件只做纯合成：不读机器、不做 IO。
 *
 * autonomy 判据（唯一真源在 _CONCERN_POLICY）：
 *   'agent' = 修法是跑 khyos 自身的幂等命令（khy / khy doctor / khy update /
 *             重跑首启水合），只依赖「网络已就绪」，无需人工决策 / 提权 /
 *             装系统软件。landing agent 可无人值守执行。
 *   'human' = 需装或卸系统软件、改安装位置 / 权限、提供网络、或重装官方包——
 *             涉及人的决策或宿主权限，agent 必须止步升级。保守合并：一个概念下
 *             只要掺入任一 human 项，整步判 human（宁可多喊人，不可越界代做）。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 三面镜子任一新增了规则 id → 在 _CONCERN_POLICY 里给该 id 补一行
 *      { concern, order, autonomy }。concern 是去重键（多个 id 同 concern 会合并
 *      成一步）；order 是依赖顺序（越小越先做）；autonomy 见上判据，拿不准填
 *      'human'（保守不越界）。未登记的 id 会自动落 _FALLBACK_POLICY（human、
 *      排最后），方案仍成立、绝不漏项。
 *   2. 新 concern 顺手在 _CONCERN_LABEL / _CONCERN_VERIFY 补人话标题与确认命令
 *      （确认命令务必安全：不得含 commit/push/rm/curl/publish）。
 *   3. 改完跑：node --test scripts/tests/agentRestorePlan.test.js（必须绿）。
 */

// 还原严重度（与三面镜子同义）：blocker=不解决还原会失败；warning=能还原但有隐患。
const LEVEL_BLOCKER = 'blocker';
const LEVEL_WARNING = 'warning';

// 步骤自主度：agent 可无人值守执行 / 必须止步交人。
const AUTONOMY_AGENT = 'agent';
const AUTONOMY_HUMAN = 'human';

// 修法/确认里绝不允许出现的危险动作（与 1000 条手册同源的红线基因，避免还原
// 方案反过来教弱模型做危险操作）。若某来源修法不慎命中，本文件会隐去它并强制
// 该步判 human（防越界）。
const _DANGER_TOKENS = [
  'git commit', 'git push', 'rm ', 'rm -', 'curl ', 'wget ',
  'npm publish', 'twine', 'sudo rm', '> /dev', 'mkfs',
];

// 概念策略表：把三面镜子的规则 id 归并到「还原概念」，并赋依赖顺序 + 自主度。
// 同 concern 的多个 id 会被合并成一步（去重）。这是 autonomy/order 的唯一真源。
const _CONCERN_POLICY = Object.freeze({
  // ── 运行时前置（最先，缺它连 khy 都跑不起来）──
  'node-missing':            { concern: 'node-runtime',      order: 10, autonomy: AUTONOMY_AGENT },
  'portable-node-missing':   { concern: 'node-runtime',      order: 10, autonomy: AUTONOMY_AGENT },
  'npm-missing':             { concern: 'npm-tool',          order: 15, autonomy: AUTONOMY_AGENT },
  // ── 包 / 源码完整性（缺源码得重装官方包=人工）──
  'bundle-missing':          { concern: 'bundle-source',     order: 20, autonomy: AUTONOMY_HUMAN },
  'bundle-file-missing':     { concern: 'bundle-source',     order: 20, autonomy: AUTONOMY_HUMAN },
  'bundle-unresolved':       { concern: 'bundle-source',     order: 20, autonomy: AUTONOMY_HUMAN },
  'seed-missing':            { concern: 'bundle-source',     order: 20, autonomy: AUTONOMY_HUMAN },
  // ── 联网水合前置（没网=人工提供网络）──
  'offline-no-modules':      { concern: 'network-hydrate',   order: 30, autonomy: AUTONOMY_HUMAN },
  // ── 依赖水合（跑 khyos 自身命令即可，前提已联网=agent）──
  'no-node-modules':         { concern: 'hydrate-modules',   order: 40, autonomy: AUTONOMY_AGENT },
  'modules-not-hydrated':    { concern: 'hydrate-modules',   order: 40, autonomy: AUTONOMY_AGENT },
  'missing-critical-package':{ concern: 'hydrate-modules',   order: 40, autonomy: AUTONOMY_AGENT },
  // ── 水合残留自愈（khy doctor 幂等重愈=agent）──
  'shared-link-broken':      { concern: 'heal-markers',      order: 45, autonomy: AUTONOMY_AGENT },
  'splitbrain-marker':       { concern: 'heal-markers',      order: 45, autonomy: AUTONOMY_AGENT },
  // ── 版本归一（khy update 幂等=agent）──
  'versions-drift':          { concern: 'version-sync',      order: 50, autonomy: AUTONOMY_AGENT },
  // ── 系统软件 / 权限 / 位置 / 冗余（涉及宿主决策=人工）──
  'tar-missing':             { concern: 'tar-tool',          order: 60, autonomy: AUTONOMY_HUMAN },
  'install-readonly':        { concern: 'writable-install',  order: 65, autonomy: AUTONOMY_HUMAN },
  'single-channel':          { concern: 'channel-redundancy',order: 70, autonomy: AUTONOMY_HUMAN },
  // ── 可选降级（不阻塞，khy doctor 兜底=agent）──
  'optional-degraded':       { concern: 'optional',          order: 80, autonomy: AUTONOMY_AGENT },
});

// 未登记 id 的兜底：保守判 human、排最后，保证方案仍成立、绝不漏项。
const _FALLBACK_POLICY = Object.freeze({
  concern: 'unclassified', order: 99, autonomy: AUTONOMY_HUMAN,
});

// concern → 人话步骤标题（合并多 id 后用它做统一抬头；缺则回退首个来源 title）。
const _CONCERN_LABEL = Object.freeze({
  'node-runtime':       'Node 运行时缺失或版本过低',
  'npm-tool':           'npm 工具缺失',
  'bundle-source':      'bundled 后端源码 / 源码快照不完整',
  'network-hydrate':    '离线，无法联网水合后端依赖',
  'hydrate-modules':    '后端依赖 node_modules 尚未水合',
  'heal-markers':       '水合残留标记 / 断链需修复',
  'version-sync':       'pip / npm / backend 版本不一致',
  'tar-tool':           '系统 tar 解包工具缺失',
  'writable-install':   '安装目录不可写',
  'channel-redundancy': '仅装了单条离机渠道',
  'optional':           '可选组件降级',
});

// concern → 确认命令（修完照跑一句核对是否解决；务必安全，不含被禁动作）。
const _CONCERN_VERIFY = Object.freeze({
  'node-runtime':       'node --version',
  'npm-tool':           'npm --version',
  'bundle-source':      'node scripts/verify-install.js',
  'network-hydrate':    'khy doctor',
  'hydrate-modules':    'node scripts/hydration-doctor.js',
  'heal-markers':       'node scripts/hydration-doctor.js',
  'version-sync':       'khy --version',
  'tar-tool':           'tar --version',
  'writable-install':   'node scripts/restore-check.js',
  'channel-redundancy': 'khy --version',
  'optional':           'node scripts/hydration-doctor.js',
});

/** 断言一段文本不含危险动作（内部自检 / 防越界用）。 */
function _actionIsSafe(text) {
  const s = String(text || '').toLowerCase();
  return !_DANGER_TOKENS.some((t) => s.includes(t.toLowerCase()));
}

/** 取一条策略；未登记 id 落保守兜底。 */
function _policyFor(id) {
  return _CONCERN_POLICY[id] || _FALLBACK_POLICY;
}

/**
 * 把三面镜子各自的原生形状规整成统一的「命中项」列表。
 * 每项 { id, level, title, action, source }；非法/缺失一律跳过（保守）。
 * 不改入参、不抛。
 */
function _collectItems(input) {
  const items = [];
  const src = input && typeof input === 'object' ? input : {};
  const push = (id, level, title, action, source) => {
    if (!id || typeof id !== 'string') return;
    items.push({
      id,
      level: level === LEVEL_BLOCKER ? LEVEL_BLOCKER : LEVEL_WARNING,
      title: typeof title === 'string' ? title : '',
      action: typeof action === 'string' ? action : '',
      source,
    });
  };
  const drain = (arr, level, source) => {
    if (!Array.isArray(arr)) return;
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      push(it.id, level, it.title, it.fix, source);
    }
  };

  // restoreReadiness: { blockers:[{id,level,title,fix}], warnings:[...] }
  const restore = src.restore && typeof src.restore === 'object' ? src.restore : {};
  drain(restore.blockers, LEVEL_BLOCKER, 'restore');
  drain(restore.warnings, LEVEL_WARNING, 'restore');

  // hydrationHealth: { blockers:[{id,...}], warnings:[...] }（同 restore 形状）
  const hydration = src.hydration && typeof src.hydration === 'object' ? src.hydration : {};
  drain(hydration.blockers, LEVEL_BLOCKER, 'hydration');
  drain(hydration.warnings, LEVEL_WARNING, 'hydration');

  // installIntegrity: { intact, missing:[{path,reason,fix}], present }
  //   —— 无 id，全部归入 bundle-source；整包无法定位则记 bundle-unresolved。
  const integrity = src.integrity && typeof src.integrity === 'object' ? src.integrity : {};
  const missing = Array.isArray(integrity.missing) ? integrity.missing : [];
  if (missing.length > 0) {
    for (const m of missing) {
      if (!m || typeof m !== 'object') continue;
      const p = typeof m.path === 'string' ? m.path : '';
      const title = p ? `关键运行时文件缺失：${p}` : (typeof m.reason === 'string' ? m.reason : '关键文件缺失');
      push('bundle-file-missing', LEVEL_BLOCKER, title, m.fix, 'integrity');
    }
  } else if (integrity.intact === false) {
    // 不完整但没列出缺失项 → 整包未能定位（严重不完整）。
    push('bundle-unresolved', LEVEL_BLOCKER,
      '无法定位已安装的 bundle 目录——包可能未装好或严重不完整',
      integrity.summary, 'integrity');
  }

  return items;
}

/**
 * 合成有序还原方案：三面镜子评估 → 命中项归并 → 按 concern 去重 → 依赖排序 →
 * 逐步标 autonomy → 找到第一处必须交人的边界。纯计算，绝不抛。
 *
 * @param {object} input
 *   input.restore   restoreReadiness.assessRestoreReadiness 的返回（可空/部分）
 *   input.integrity installIntegrity.assessInstallIntegrity 的返回（可空/部分）
 *   input.hydration hydrationHealth.assessHydrationHealth 的返回（可空/部分）
 * @returns {{
 *   ready:boolean, steps:Array, stepCount:number,
 *   agentActionable:number, humanRequired:number,
 *   firstHumanStep:(number|null), summary:string
 * }}
 *   steps[i] = { step, concern, level, autonomy, title, action, verify, sources:[], ids:[], depOrder }
 */
function buildRestorePlan(input) {
  try {
    const items = _collectItems(input);

    // 按 concern 归并成步。
    const byConcern = new Map();
    for (const it of items) {
      const pol = _policyFor(it.id);
      const key = pol.concern;
      let step = byConcern.get(key);
      if (!step) {
        step = {
          concern: key,
          depOrder: pol.order,
          level: LEVEL_WARNING,
          autonomy: AUTONOMY_AGENT,
          _items: [],
          sources: new Set(),
          ids: new Set(),
        };
        byConcern.set(key, step);
      }
      step.depOrder = Math.min(step.depOrder, pol.order);
      if (it.level === LEVEL_BLOCKER) step.level = LEVEL_BLOCKER;
      // 保守合并：任一 human → 整步 human。
      if (pol.autonomy === AUTONOMY_HUMAN) step.autonomy = AUTONOMY_HUMAN;
      step._items.push(it);
      step.sources.add(it.source);
      step.ids.add(it.id);
    }

    // 每步定标题 / 修法 / 确认，并做危险动作防越界。
    const steps = [];
    for (const step of byConcern.values()) {
      // 代表修法：优先取 blocker 项，其次首项。
      const rep =
        step._items.find((x) => x.level === LEVEL_BLOCKER) || step._items[0] || {};
      let action = rep.action || '';
      let autonomy = step.autonomy;
      if (!_actionIsSafe(action)) {
        // 来源修法不慎含被禁动作 → 隐去 + 强制交人（绝不把危险动作塞给 agent）。
        action = '该修法含被禁动作，已隐去；请查阅 khyos 官方还原文档人工处理。';
        autonomy = AUTONOMY_HUMAN;
      }
      const title = _CONCERN_LABEL[step.concern] || rep.title || step.concern;
      const verify = _CONCERN_VERIFY[step.concern] || 'khy doctor';
      steps.push({
        step: 0, // 排序后回填
        concern: step.concern,
        level: step.level,
        autonomy,
        title,
        action,
        verify: _actionIsSafe(verify) ? verify : 'khy doctor',
        sources: Array.from(step.sources).sort(),
        ids: Array.from(step.ids).sort(),
        depOrder: step.depOrder,
      });
    }

    // 排序：拦路项优先 → 依赖顺序 → concern 名（确定性，同输入恒同序）。
    const levelRank = (l) => (l === LEVEL_BLOCKER ? 0 : 1);
    steps.sort((a, b) => {
      if (levelRank(a.level) !== levelRank(b.level)) return levelRank(a.level) - levelRank(b.level);
      if (a.depOrder !== b.depOrder) return a.depOrder - b.depOrder;
      return a.concern < b.concern ? -1 : a.concern > b.concern ? 1 : 0;
    });
    steps.forEach((s, i) => { s.step = i + 1; });

    const blockerSteps = steps.filter((s) => s.level === LEVEL_BLOCKER);
    const agentActionable = steps.filter((s) => s.autonomy === AUTONOMY_AGENT).length;
    const humanRequired = steps.filter((s) => s.autonomy === AUTONOMY_HUMAN).length;
    const firstHuman = steps.find((s) => s.autonomy === AUTONOMY_HUMAN);
    const firstHumanStep = firstHuman ? firstHuman.step : null;
    const ready = blockerSteps.length === 0;

    let summary;
    if (steps.length === 0) {
      summary = '就绪：无需任何步骤，这台机器可直接完整还原 khyos。';
    } else if (ready) {
      summary =
        `基本就绪：无拦路步骤，另有 ${steps.length} 步优化项` +
        `（${agentActionable} 步 agent 可自动、${humanRequired} 步需人工）。`;
    } else {
      summary =
        `需 ${steps.length} 步还原（${blockerSteps.length} 步拦路）：` +
        `${agentActionable} 步 agent 可无人值守执行，${humanRequired} 步须人工介入` +
        (firstHumanStep ? `，agent 执行到第 ${firstHumanStep} 步须停下交人。` : '，全程 agent 可自动。');
    }

    return {
      ready,
      steps,
      stepCount: steps.length,
      agentActionable,
      humanRequired,
      firstHumanStep,
      summary,
    };
  } catch {
    return {
      ready: false,
      steps: [],
      stepCount: 0,
      agentActionable: 0,
      humanRequired: 0,
      firstHumanStep: null,
      summary: '无法合成还原方案（合成器内部异常，已安全降级）。',
    };
  }
}

module.exports = {
  buildRestorePlan,
  _collectItems,
  _policyFor,
  _actionIsSafe,
  _CONCERN_POLICY,
  _FALLBACK_POLICY,
  _CONCERN_LABEL,
  _CONCERN_VERIFY,
  _DANGER_TOKENS,
  LEVEL_BLOCKER,
  LEVEL_WARNING,
  AUTONOMY_AGENT,
  AUTONOMY_HUMAN,
};
