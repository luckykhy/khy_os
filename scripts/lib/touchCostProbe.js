'use strict';

/**
 * touchCostProbe.js — 纯叶子：「改一处的实际代价」计算。
 *
 * ## 为什么需要它
 *
 * 「khy-os 难以维护」长期是**主观抱怨** —— 抱怨无法排序、无法验收、无法证伪。
 * `[DESIGN-ARCH-127]` 的出发点是把这句话换成**可复现的数字**：
 * 对 N 类典型维护动作，数出「必须同步改动的触点」到底有几处。
 *
 * 本叶子负责**纯计算**：输入调用方采集好的事实，输出结构化读数。
 * 采集（git、文件系统、spawn）由 `scripts/ci/check-touch-cost.js` 负责。
 *
 * ## 校准原则（比数字本身更重要）
 *
 * 触点清单里的每一项都必须是**真会变红的机制**，而不是「感觉上要做」：
 * - 「真源标记行」会红，因为 `check-rules-registry` 校验双向可达；
 * - 「规则卡 .html」会红，因为 `verify_docs_site` 强制孪生件存在；
 * - 「发布门阶段表」标为**可选**，因为只有 `tier=must` 的规则才被它引用。
 *
 * 虚高的数字会污染「该先修哪个」的判断。因此 `TOUCH_RULE` 每项都带 `why`，
 * 且 `required=false` 的项**不计入硬触点合计**。
 *
 * ## 设计约束（对齐 `scripts/lib/` 既有叶子契约）
 *
 * 零外部依赖（只 `path`）、确定性、绝不抛、零 IO。
 */

/** 触点类别，与 `ruleScaffold.js` 保持同一套词表。 */
const KIND = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

/**
 * 「新增一条规则」必须同步的触点清单 —— 本文件的**唯一真源**。
 *
 * 字段：
 * - `name`     人类可读的触点名
 * - `required` 是否**硬**触点（计入合计）
 * - `why`      为什么会红/为什么需要（可复核的机制名，不是形容词）
 * - `kind`     可由工具派生（auto）还是必须人写（manual）
 */
const TOUCH_RULE = Object.freeze([
  { name: '规范正文 .md', required: true, why: '写新规范（语义所在）', kind: KIND.MANUAL },
  { name: '规范 .html 孪生件', required: true, why: 'verify_docs_site：缺即 error', kind: KIND.AUTO },
  { name: '就近 00_INDEX_*.md', required: true, why: 'CP-3 要求回写索引', kind: KIND.MANUAL },
  { name: '就近 00_INDEX_*.html', required: true, why: '孪生件', kind: KIND.AUTO },
  {
    name: '主索引（仅 01–09 阶段目录）',
    required: false,
    why: '10_规范 不在 docs-index-complete 扫描范围',
    kind: KIND.MANUAL,
  },
  { name: 'registry/RULES-REGISTRY.json', required: true, why: 'ssot/exec/paths/gate + meta.ruleCount', kind: KIND.MANUAL },
  { name: '真源标记行 <!-- RULES-REGISTRY: -->', required: true, why: 'check-rules-registry 校验双向可达', kind: KIND.MANUAL },
  { name: '规则卡 .md（生成物）', required: true, why: 'npm run docs:rules-cards', kind: KIND.AUTO },
  { name: '规则卡 .html（生成物）', required: true, why: 'build_docs_site 出，非卡片生成器', kind: KIND.AUTO },
  { name: 'AGENTS.md 标记行 + 规则正文', required: true, why: '改代码的人不必跳文件（MGMT-STD-008 §4.6）', kind: KIND.MANUAL },
  { name: 'AGENTS.html 孪生件', required: true, why: '孪生件', kind: KIND.AUTO },
  { name: 'package.json 别名', required: true, why: 'check-wiring：零接线判 error', kind: KIND.AUTO },
  { name: '执行器 scripts/ci/*.js 本体', required: true, why: '规则真正被 spawn 的东西', kind: KIND.MANUAL },
  { name: '纯叶子 scripts/lib/*.js', required: false, why: '可选：判定逻辑与 IO 分层', kind: KIND.MANUAL },
  { name: '发布门阶段表', required: false, why: '仅 tier=must 的规则被它引用', kind: KIND.MANUAL },
  { name: '测试用例', required: true, why: '防空转断言：须有反向验证', kind: KIND.MANUAL },
]);

/** 硬触点 = `required === true` 的项。 */
const REQUIRED_TOUCH_RULE = Object.freeze(TOUCH_RULE.filter((t) => t.required));

/** 可由工具派生的硬触点（这部分的同步成本理论上可归零）。 */
const DERIVABLE_TOUCH_RULE = Object.freeze(
  REQUIRED_TOUCH_RULE.filter((t) => t.kind === KIND.AUTO)
);

/**
 * 计算「新增一条规则」的触点压缩空间。
 *
 * @param {object} [facts] 可选实测事实（缺省时只用声明清单）
 * @returns {{required:number, optional:number, total:number,
 *            derivable:number, manual:number,
 *            compressionTarget:number, detail:Array}}
 */
function measureRuleTouchCost(facts) {
  const required = REQUIRED_TOUCH_RULE.length;
  const derivable = DERIVABLE_TOUCH_RULE.length;
  return {
    required,
    optional: TOUCH_RULE.length - required,
    total: TOUCH_RULE.length,
    derivable,
    manual: required - derivable,
    // 目标态：人只需写「1 处语义声明」，其余 12 处由派生得到
    compressionTarget: 1,
    detail: TOUCH_RULE.map((t) => ({ ...t })),
    measured: facts && typeof facts === 'object' ? facts : null,
  };
}

/**
 * 计算文档孪生件负担：`.md` 与 `.html` 的强制配对比率。
 *
 * `[DESIGN-ARCH-127]` 实测该比率为 1:1（906 md ↔ 895 html），
 * 意味着**任何一句话的规范改动都要动至少 2 个文件**，而 `.html` 是生成物——
 * 「改生成物」在逐字节契约下是禁忌 ⇒ 必须先改生成器再重跑。
 *
 * @param {{docMd:number, docHtml:number, ruleCards:number}} counts
 */
function measureTwinBurden(counts) {
  const c = counts && typeof counts === 'object' ? counts : {};
  const md = num(c.docMd);
  const html = num(c.docHtml);
  return {
    mdFiles: md,
    htmlFiles: html,
    ratio: md > 0 ? +(html / md).toFixed(3) : null,
    ruleCardPairs: num(c.ruleCards),
    // 每改动一句规范文字，至少要碰的文件数（md + 其孪生 html）
    filesPerSentenceEdit: 2,
  };
}

/**
 * 计算「改一条既有规则的判据」的波及面：同一条执行器名被多少文件引用。
 *
 * 读数越大，「改判据」这件事越容易漏改 —— 因为引用点分散在
 * `package.json` / workflows / hooks / docs 里，没有单一真源。
 *
 * @param {{sample:string, referencingFiles:number, samplePaths?:string[]}} input
 */
function measureChangeBlast(input) {
  const i = input && typeof input === 'object' ? input : {};
  return {
    sample: typeof i.sample === 'string' ? i.sample : '',
    referencingFiles: num(i.referencingFiles),
    samplePaths: Array.isArray(i.samplePaths) ? i.samplePaths.slice(0, 20) : [],
  };
}

/**
 * 阻断强度实况：把 `gate` 分布与「永不执行」条数列出来。
 *
 * ⚠ `GATE_ORDER.advisory = 4` > 门档 max(2) ⇒ `gate='advisory'` 的规则
 * **执行器根本不被 spawn**。这是 M2 的结构性判据。
 *
 * @param {Array<{id?:string, gate?:string, priority?:string}>} rules
 */
function measureGateReality(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const distribution = {};
  for (const r of list) {
    const g = (r && r.gate) || 'unknown';
    distribution[g] = (distribution[g] || 0) + 1;
  }
  const neverExecute = list
    .filter((r) => r && r.gate === 'advisory')
    .map((r) => ({ id: r.id || '', priority: r.priority || '' }))
    // 确定性排序：先按优先级（P1 更靠前），再按 id
    .sort((a, b) => {
      const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
      const ra = rank[a.priority] !== undefined ? rank[a.priority] : 9;
      const rb = rank[b.priority] !== undefined ? rank[b.priority] : 9;
      if (ra !== rb) return ra - rb;
      return a.id.localeCompare(b.id);
    });
  return {
    distribution,
    neverExecute,
    neverExecuteCount: neverExecute.length,
    ruleTotal: list.length,
  };
}

/**
 * 工作区积压读数 —— 维护成本最直白的一个数字。
 *
 * @param {Array<{status?:string}>|string} entries `git status --porcelain` 的行或对象数组
 */
function measureBacklog(entries) {
  const rows = Array.isArray(entries) ? entries : [];
  const codes = rows.map((e) =>
    typeof e === 'string' ? e.slice(0, 2) : String((e && e.status) || '').slice(0, 2)
  );
  // ⚠ `??` 与 `!!` 的首位是 `?`/`!` 而非状态字母，必须先摘出去，
  //    否则「出现 M」的口径不会误伤它们，但能让同一条规则覆盖 ` M` / `M ` / `MM`。
  const isSpecial = (c) => c === '??' || c === '!!';
  const modified = codes.filter((c) => !isSpecial(c) && c.includes('M')).length;
  const deleted = codes.filter((c) => !isSpecial(c) && c.includes('D')).length;
  const untracked = codes.filter((c) => c === '??').length;
  return {
    modified,
    deleted,
    untracked,
    total: rows.length,
    clean: rows.length === 0,
  };
}

/**
 * 汇总一次探针采集的全部读数，产出「该先修哪个」的排序建议。
 *
 * ⚠ 本函数**不做**「该不该修」的裁决 —— 它只把读数换算成可比较的严重度，
 * 裁决留给规范（`[DESIGN-ARCH-127]` §5 的措施表）。
 *
 * @param {object} readings
 */
function summarize(readings) {
  const r = readings && typeof readings === 'object' ? readings : {};
  const touch = r.ruleTouchCost || measureRuleTouchCost();
  const twin = r.twinBurden || measureTwinBurden();
  const gate = r.gateReality || measureGateReality([]);
  const backlog = r.worktreeBacklog || measureBacklog([]);

  const signals = [
    {
      id: 'M1',
      title: '新增规则触点过多',
      reading: `${touch.required} 处硬触点（其中 ${touch.derivable} 处可派生）`,
      severity: touch.required,
    },
    {
      id: 'M2',
      title: '规则登记了却永不执行',
      reading: `${gate.neverExecuteCount} / ${gate.ruleTotal} 条 gate=advisory`,
      severity: gate.neverExecuteCount,
    },
    {
      id: 'M3',
      title: '文档孪生件强制配对',
      reading: `md:html = ${twin.mdFiles}:${twin.htmlFiles}`,
      severity: twin.mdFiles,
    },
    {
      id: 'M4',
      title: '未提交积压',
      reading: `${backlog.total} 项（M ${backlog.modified} / D ${backlog.deleted} / ?? ${backlog.untracked}）`,
      severity: backlog.total,
    },
  ].sort((a, b) => b.severity - a.severity);

  return {
    signals,
    ruleTouchCost: touch,
    twinBurden: twin,
    gateReality: gate,
    worktreeBacklog: backlog,
  };
}

/** 把任意输入收敛成非负整数（绝不抛、绝不返回 NaN）。 */
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

module.exports = {
  KIND,
  TOUCH_RULE,
  REQUIRED_TOUCH_RULE,
  DERIVABLE_TOUCH_RULE,
  measureRuleTouchCost,
  measureTwinBurden,
  measureChangeBlast,
  measureGateReality,
  measureBacklog,
  summarize,
};
