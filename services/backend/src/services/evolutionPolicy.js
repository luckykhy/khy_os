'use strict';

/**
 * evolutionPolicy —— 纯叶子 (pure leaf):khyos「自动进化」的可变性策略单一真源 ——
 *   把「哪些代码可以变 / 哪些绝不能变 / 一个变了另一个要随之变」固化成确定性判定。
 *
 * 契约 (CONTRACT):零 IO(不碰 fs/网络/子进程,只做纯字符串/数组/正则/判定;真正的 git
 *   diff / 文件读 / 打印留在调用方 cli/handlers/evolve.js 与 selfRepair/primitives.js)、
 *   确定性、绝不抛、单一真源(可变性分级与级联规则只在本文件)、env 门控默认开
 *   (`KHY_EVOLUTION_POLICY`,仅 {0,false,off,no} 关闭即字节回退到「无进化策略」行为)。
 *   fail-soft:入参非法一律返回安全空评估(`blocked:false`,绝不因策略机器自身故障而误挡修复)。
 *
 * 为什么要这层(承接自修复事务):KHY 已能让自己的 fix/进化 agent 改自己的代码
 *   (见 [[selfRepairTransaction]]),但「能改」不等于「该改」。`.ai/GUARDS.md` 的红线是给人
 *   读的散文,自治进化闭环无从查询。本叶子是那套红线的**机器可读版**:
 *     · 可变性分级 classifyPath() —— IMMUTABLE(绝不自治改动)/ GUARDED(可改但需谨慎+联动)/
 *       EVOLVABLE(自由进化)/ UNKNOWN,按路径模式确定性归层,首条命中为准。
 *     · 级联规则 deriveCascades() —— 「改了 A 应随改 B」的声明式表(改命令表→同步 router;
 *       改某叶子→同步其 test;改 services/backend→须重建 wheel),让「一个变化带动另一个」可机器核对。
 *   接缝:自修复事务的 decideOutcome 读 `validation.evolution`,**触碰 IMMUTABLE → 回滚**、
 *   联动缺口 → 非阻断告警;CLI `khy evolve` 只读查询本策略。
 *
 * 规则的「明确陈述」(本叶子是规则正本):除可变性分级外,本文件还把以下规则元数据固化为单一真源,
 *   供 `khy evolve rules` 在系统内权威陈述、`.ai/GUARDS.md` 散文引用:
 *     · 适用范围 SCOPE —— 规则治理「自治进化」(自修复 / 进化 fix agent 改 khyos 自身代码),
 *       **不**限制人类维护者手工编辑(后者由 git review / pre-commit 守卫把关)。
 *     · 不变量 INVARIANTS —— 无论门控 / 越权如何配置都成立的安全性质。
 *     · 执行点 ENFORCEMENT —— 规则在哪里「咬」(decideOutcome 回滚 / CLI 只读查询)。
 *     · 有意识越权 KHY_EVOLUTION_OVERRIDE —— 当自治进化**确有合法必要**改某受保护区时的显式、
 *       按需、可审计的升级通道(**默认关**);`safety-machinery` / `secrets` / `legal-policy`
 *       **永不可越权**(刹车的刹车),即「全有 / 全无地关掉整个门控」之外的、精确而安全的例外路径。
 *
 * 维护红线:① 分级 / 级联判定留本叶子,IO(git/fs/打印)留调用方;② 只有 IMMUTABLE 触碰且**未获授权
 *   越权**才阻断(回滚),GUARDED/联动缺口一律非阻断(绝不误杀好修复);③ **安全守卫与本进化机器自身列为
 *   IMMUTABLE 且恒不可越权** —— 自治进化绝不能改弱自己的刹车;④ 别删门控,关门控即字节回退;
 *   ⑤ 越权默认关、关闭即字节回退,扩越权白名单**绝不**纳入 NON_OVERRIDABLE_RULES。
 */

/** 规则集版本(规则语义变更时递增 —— 让「规则」可被明确引用与审计)。 */
const POLICY_VERSION = '1.0.0';

/** 适用范围:这些规则治理「自治进化」,不限制人类维护者的手工编辑。 */
const SCOPE = Object.freeze({
  governs: '自治进化(自修复 / 进化 fix agent 改 khyos 自身代码)',
  notGoverns: '人类维护者的手工编辑 —— 由 git review / pre-commit 守卫把关,不受本策略阻断',
  bite: '仅当改动出自自治进化闭环(selfRepair 事务)时,本策略的「阻断 / 回滚」才生效',
});

/** 不变量(无论门控 / 越权如何配置都成立的安全性质)。 */
const INVARIANTS = Object.freeze([
  '自治进化绝不能改弱自己的刹车:safety-machinery(守卫 / 自修复 / 进化机器自身)恒不可越权',
  '机密凭据(secrets)与法律安全策略(legal-policy)恒不可越权,自治进化绝不自行写入',
  '越权(KHY_EVOLUTION_OVERRIDE)默认关、须显式人工授权、按规则 / 路径白名单、全程审计',
  '门控关闭(KHY_EVOLUTION_POLICY=off)即字节回退到「无进化策略」行为,绝不因策略自身故障误挡修复',
]);

/** 执行点(规则在哪里「咬」)。 */
const ENFORCEMENT = Object.freeze([
  'selfRepair 事务 decideOutcome:触碰不可变且未授权越权 → keep:false → 回滚',
  'selfRepair 事务 decideOutcome:授权越权 → 降级为审计告警(保留改动但留痕)',
  'selfRepair 事务 decideOutcome:联动缺口 → 非阻断审计告警',
  'CLI `khy evolve check/classify/cascades/rules`:只读查询与规则陈述,不改任何文件',
]);

/** 可变性分级。 */
const TIERS = Object.freeze({
  IMMUTABLE: 'immutable', // 绝不自治改动(红线):安全守卫/进化机器自身、内核、法律与安全策略、机密。
  GUARDED: 'guarded',     // 可改但需谨慎 + 联动:单一真源常量、打包/发布、CI、.ai 人工契约。
  EVOLVABLE: 'evolvable', // 自由进化:业务服务/应用/文档/测试。
  UNKNOWN: 'unknown',     // 未匹配任何规则:保守对待,但不阻断。
});

const OFF = ['0', 'false', 'off', 'no'];

/** 是否启用进化策略(门控关 → 评估恒为安全空、不阻断、无级联)。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_EVOLUTION_POLICY) != null ? env.KHY_EVOLUTION_POLICY : '')
    .trim().toLowerCase();
  return !OFF.includes(v);
}

/** 永不可越权的不可变规则(刹车的刹车):即便显式列入越权白名单也拒绝。 */
const NON_OVERRIDABLE_RULES = Object.freeze(['safety-machinery', 'secrets', 'legal-policy']);

/** 越权白名单关闭态(空 / 显式关)。 */
const OVERRIDE_OFF = ['', '0', 'false', 'off', 'no'];

/**
 * 解析「有意识越权」白名单(`KHY_EVOLUTION_OVERRIDE`)。**默认空 = 无越权**(默认关)。
 * 值为逗号 / 空白分隔的项:含 `/` 视为「路径片段」,否则视为「规则名」(如 kernel-abi)。
 * 纯字符串解析,确定性,fail-soft。
 * @param {Object} [env]
 * @returns {{rules:Set<string>, paths:string[]}}
 */
function overrideAllowlist(env = (typeof process !== 'undefined' ? process.env : {})) {
  const raw = String((env && env.KHY_EVOLUTION_OVERRIDE) != null ? env.KHY_EVOLUTION_OVERRIDE : '').trim();
  if (!raw || OVERRIDE_OFF.includes(raw.toLowerCase())) return { rules: new Set(), paths: [] };
  const rules = new Set();
  const paths = [];
  for (const tok of raw.split(/[\s,]+/)) {
    const t = tok.trim();
    if (!t) continue;
    if (t.includes('/')) paths.push(_norm(t));
    else rules.add(t.toLowerCase());
  }
  return { rules, paths };
}

/**
 * 判断一条不可变命中(rule + file)是否已获显式人工授权越权。
 * **非可越权规则(safety-machinery/secrets/legal-policy)永远返回 false** —— 刹车的刹车。
 * @param {string} rule  命中的规则名(classifyPath().rule)
 * @param {string} file  归一前的文件路径
 * @param {Object} [env]
 * @returns {boolean}
 */
function isOverrideAuthorized(rule, file, env) {
  const r = String(rule || '').toLowerCase();
  if (!r || NON_OVERRIDABLE_RULES.includes(r)) return false;
  const al = overrideAllowlist(env);
  if (al.rules.has(r)) return true;
  const f = _norm(file);
  return !!f && al.paths.some((p) => p && f.indexOf(p) >= 0);
}

/** 归一路径:trim、反斜杠→正斜杠、去开头 './'。保留大小写(LICENSE 等按原名匹配)。 */
function _norm(p) {
  return String(p == null ? '' : p).trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 取 basename(纯字符串,不碰 path 模块以守零依赖)。 */
function _base(p) {
  const s = _norm(p);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/** 取扩展名(小写,含点;无扩展名返回 '')。 */
function _ext(p) {
  const b = _base(p);
  const dot = b.lastIndexOf('.');
  return dot > 0 ? b.slice(dot).toLowerCase() : '';
}

/** 正则转义(用于按 basename 动态构造级联匹配)。 */
// 收敛到 utils/escapeRegExp 单一真源(逐字节委托,调用点不变)
const _escapeRe = require('../utils/escapeRegExp');

/**
 * 分级规则表(有序,首条命中为准)。每条:{ tier, rule, reason, test(norm)->bool }。
 * test 接收归一后的路径,用「段/后缀」匹配 → 绝对路径与仓库相对路径都能命中。
 */
const RULES = Object.freeze([
  // ── IMMUTABLE:安全守卫与进化机器自身(绝不能让进化改弱自己的刹车)──
  {
    tier: TIERS.IMMUTABLE, rule: 'safety-machinery',
    reason: '自修复/进化的安全守卫与刹车 —— 自治进化绝不能改弱自己的护栏',
    test: (p) =>
      /(^|\/)scripts\/check-[^/]+\.js$/.test(p) ||
      /(^|\/)scripts\/lib\/[^/]*[Gg]uard\.js$/.test(p) ||
      /(^|\/)\.githooks\//.test(p) ||
      /services\/backend\/src\/services\/selfRepair(\/|Transaction\.js$)/.test(p) ||
      _base(p) === 'evolutionPolicy.js',
  },
  // ── IMMUTABLE:法律 / 安全策略 ──
  {
    tier: TIERS.IMMUTABLE, rule: 'legal-policy',
    reason: '法律 / 安全策略文件',
    test: (p) => ['LICENSE', 'SECURITY.md', 'CODE_OF_CONDUCT.md'].includes(_base(p)),
  },
  // ── IMMUTABLE:操作系统内核 ABI / 引导 ──
  {
    tier: TIERS.IMMUTABLE, rule: 'kernel-abi',
    reason: '操作系统内核 ABI / 引导 —— 自治进化不得改写',
    test: (p) => /(^|\/)kernel\//.test(p),
  },
  // ── IMMUTABLE:机密 / 凭据 ──
  {
    tier: TIERS.IMMUTABLE, rule: 'secrets',
    reason: '机密 / 凭据',
    test: (p) => {
      const b = _base(p);
      if (b === '.env.example') return false; // 模板可变
      if (b === '.env' || /^\.env\./.test(b)) return true;
      if (['.pem', '.key', '.p12', '.pfx'].includes(_ext(p))) return true;
      return b === 'credentials.json' || /^secrets\./.test(b);
    },
  },

  // ── GUARDED:单一真源常量(改动会级联到消费点)──
  {
    tier: TIERS.GUARDED, rule: 'ssot-constants',
    reason: '单一真源常量 —— 改动会级联到消费点',
    test: (p) => /services\/backend\/src\/constants\/[^/]+\.js$/.test(p),
  },
  // ── GUARDED:打包 / 发布完整性 ──
  {
    tier: TIERS.GUARDED, rule: 'packaging',
    reason: '打包 / 发布完整性',
    test: (p) => ['setup.py', 'pyproject.toml', 'MANIFEST.in', 'package.json'].includes(_base(p)),
  },
  // ── GUARDED:CI / CD 流水线 ──
  {
    tier: TIERS.GUARDED, rule: 'ci-pipeline',
    reason: 'CI / CD 流水线定义',
    test: (p) => /(^|\/)\.github\/workflows\//.test(p),
  },
  // ── GUARDED:.ai 人工权威契约(机器只刷新派生 SKELETON)──
  {
    tier: TIERS.GUARDED, rule: 'ai-contracts',
    reason: '.ai 人工权威契约 —— 机器只刷新派生 SKELETON,正本改动须人工',
    test: (p) => /(^|\/)\.ai\/(GUARDS\.md|MAP\.md|CONTEXT\.yaml)$/.test(p),
  },

  // ── EVOLVABLE:机器派生骨架 ──
  {
    tier: TIERS.EVOLVABLE, rule: 'derived-skeleton',
    reason: '机器派生骨架(khy metadata refresh 重生成)',
    test: (p) => /(^|\/)\.ai\/SKELETON\.auto\.md$/.test(p),
  },
  // ── EVOLVABLE:测试 ──
  {
    tier: TIERS.EVOLVABLE, rule: 'tests',
    reason: '测试代码',
    test: (p) => /\.test\.[jt]sx?$/.test(p) || /(^|\/)tests?\//.test(p),
  },
  // ── EVOLVABLE:后端业务源 ──
  {
    tier: TIERS.EVOLVABLE, rule: 'backend-source',
    reason: '后端业务源 —— 自由进化',
    test: (p) => /services\/backend\/src\//.test(p),
  },
  // ── EVOLVABLE:应用 / 软件 / 文档 ──
  {
    tier: TIERS.EVOLVABLE, rule: 'apps-docs',
    reason: '应用 / 软件 / 文档 —— 自由进化',
    test: (p) => /(^|\/)(apps|software|docs)\//.test(p),
  },
]);

/**
 * 按路径把单个文件归到可变性分级。确定性、首条命中为准。
 * @param {string} relPath
 * @returns {{tier:string, rule:string, reason:string}}
 */
function classifyPath(relPath) {
  const p = _norm(relPath);
  if (!p) return { tier: TIERS.UNKNOWN, rule: 'empty', reason: '空路径' };
  for (const r of RULES) {
    let hit = false;
    try { hit = !!r.test(p); } catch { hit = false; }
    if (hit) return { tier: r.tier, rule: r.rule, reason: r.reason };
  }
  return { tier: TIERS.UNKNOWN, rule: 'unmatched', reason: '未匹配规则 —— 保守对待(不阻断)' };
}

/** 去重并归一(保序)。 */
function _uniqNorm(files) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(files) ? files : []) {
    const f = _norm(raw);
    if (!f || seen.has(f)) continue;
    seen.add(f);
    out.push(f);
  }
  return out;
}

/**
 * 由改动文件集推导「联动改动」义务(声明式,确定性)。
 *   kind:'co-change' —— 改了 A 应随改 B(satisfied 表示 B 是否也在改动集里);
 *   kind:'action'    —— 改了 A 后须执行的动作(satisfied 恒 false,作提醒,severity 'info')。
 * @param {string[]} changedFiles
 * @returns {Array<{id,kind,severity,trigger,expected,satisfied,message}>}
 */
function deriveCascades(changedFiles) {
  const files = _uniqNorm(changedFiles);
  const out = [];

  // 命令表 → router 分发。
  if (files.some((f) => /services\/backend\/src\/constants\/commandSchema\.js$/.test(f))) {
    const routerChanged = files.some((f) => /services\/backend\/src\/cli\/router\.js$/.test(f));
    out.push({
      id: 'command-wiring', kind: 'co-change', severity: 'warn',
      trigger: 'constants/commandSchema.js', expected: 'cli/router.js', satisfied: routerChanged,
      message: '改了命令表 commandSchema.js,应同步 cli/router.js 的 case 分发(否则新命令无入口)',
    });
  }

  // 业务叶子 → 其 node:test 同步演进。
  const srcLeaves = files.filter((f) =>
    /services\/backend\/src\/services\/[^/]*\.js$/.test(f) &&
    !/\.test\.js$/.test(f) &&
    classifyPath(f).tier !== TIERS.IMMUTABLE,
  );
  for (const f of srcLeaves.slice(0, 20)) {
    const base = _base(f).replace(/\.js$/, '');
    const hasTest = files.some((t) => new RegExp(`(^|/)${_escapeRe(base)}\\.test\\.js$`).test(t));
    out.push({
      id: 'leaf-test', kind: 'co-change', severity: 'warn',
      trigger: f, expected: `tests/${base}.test.js`, satisfied: hasTest,
      message: `改了 ${base}.js,应同步其 node:test(${base}.test.js)以锁定新行为`,
    });
  }

  // 后端源改动 → 须重建 wheel(动作提醒)。
  if (files.some((f) => /services\/backend\/src\//.test(f))) {
    out.push({
      id: 'wheel-rebuild', kind: 'action', severity: 'info',
      trigger: 'services/backend/src/**', expected: null, satisfied: false,
      message: '改了 services/backend/ 源 —— 须重建 wheel 重发布才能到 pip 用户(editable 本地已生效)',
    });
  }

  return out;
}

/**
 * 评估一个改动集:可变性分级 + 级联义务 + 是否触碰不可变区域(blocked)。
 * 门控关 → 安全空评估(`enabled:false, blocked:false`)。fail-soft,绝不抛。
 * @param {{changedFiles?:string[], env?:Object}} [opts]
 * @returns {{enabled:boolean, blocked:boolean, immutable:Array, guarded:Array, cascades:Array, tiers:Object}}
 */
function assessEvolution(opts = {}) {
  const env = (opts && opts.env) || (typeof process !== 'undefined' ? process.env : {});
  if (!isEnabled(env)) {
    return { enabled: false, blocked: false, immutable: [], guarded: [], cascades: [], tiers: {}, overrides: [] };
  }
  const files = _uniqNorm(opts && opts.changedFiles);
  const tiers = {};
  const immutable = [];
  const guarded = [];
  const overrides = [];
  for (const f of files) {
    const c = classifyPath(f);
    tiers[f] = c.tier;
    if (c.tier === TIERS.IMMUTABLE) {
      // 显式人工授权越权(KHY_EVOLUTION_OVERRIDE)→ 标注 overridden;非可越权规则恒 false。
      const overridden = isOverrideAuthorized(c.rule, f, env);
      const hit = { file: f, reason: c.reason, rule: c.rule, overridden };
      immutable.push(hit);
      if (overridden) overrides.push(hit);
    } else if (c.tier === TIERS.GUARDED) {
      guarded.push({ file: f, reason: c.reason, rule: c.rule });
    }
  }
  const cascades = deriveCascades(files);
  // blocked 只计**未授权越权**的不可变触碰 —— 已授权的降级为审计留痕,不阻断。
  const blocked = immutable.some((im) => !im.overridden);
  return { enabled: true, blocked, immutable, guarded, cascades, tiers, overrides };
}

/**
 * 反应式指令:给定一个评估,产出注入用 [SYSTEM:] 文本(无可说 → '')。
 * 用于自修复事务注解 / 可选系统提示词注入,让模型知道这次改动违反了哪条策略。
 * @param {Object} assessment  assessEvolution 的返回
 * @returns {string}
 */
function buildEvolutionDirective(assessment) {
  const a = assessment && typeof assessment === 'object' ? assessment : null;
  if (!a || !a.enabled) return '';
  const lines = [];
  if (Array.isArray(a.immutable) && a.immutable.length) {
    lines.push('禁止改动以下不可变区域(若已改动须撤销并征得人工同意):');
    for (const im of a.immutable.slice(0, 8)) lines.push(`  - ${im.file} —— ${im.reason}`);
  }
  const unmet = (Array.isArray(a.cascades) ? a.cascades : [])
    .filter((c) => c && c.satisfied === false && c.kind === 'co-change');
  if (unmet.length) {
    lines.push('以下「联动改动」尚未完成(改了 A 应随改 B):');
    for (const c of unmet.slice(0, 8)) lines.push(`  - ${c.message}`);
  }
  const actions = (Array.isArray(a.cascades) ? a.cascades : []).filter((c) => c && c.kind === 'action');
  if (actions.length) {
    lines.push('进化后须执行的动作:');
    for (const c of actions.slice(0, 4)) lines.push(`  - ${c.message}`);
  }
  if (!lines.length) return '';
  return '[SYSTEM:进化策略] ' + lines.join('\n');
}

/**
 * 主动式指令:进化前注入的「地形图」—— 告诉模型可变性分级与行为准则(不针对具体文件)。
 * 供未来 cli/ai.js 在「自我进化」语境注入;门控关 → ''。
 * @param {Object} [env]
 * @returns {string}
 */
function buildPolicyDirective(env) {
  if (!isEnabled(env)) return '';
  return [
    '[SYSTEM:进化策略] 你在自我进化(改 khyos 自身代码)时,先按可变性分级判断该不该改',
    '  (本规则只治自治进化,不限制人类维护者手改):',
    '  · 不可变(IMMUTABLE,绝不自治改动):安全守卫与自修复/进化机器自身、内核 ABI/引导、法律与安全策略、机密/凭据。',
    '  · 受护(GUARDED,可改但需谨慎+联动):单一真源常量、打包/发布、CI、.ai 人工契约。',
    '  · 可进化(EVOLVABLE):后端业务源/应用/文档/测试 —— 自由改进。',
    '  规则:改不可变区域前必须停下说明并征得人工同意;改受护或叶子时必须完成其联动改动',
    '  (改 commandSchema → 同步 router;改某叶子 → 同步其 test;改 services/backend → 须重建 wheel)。',
    '  例外:确有合法必要改某不可变区时,唯一通道是人工显式授权越权(KHY_EVOLUTION_OVERRIDE,默认关、可审计);',
    '  但 safety-machinery / secrets / legal-policy 永不可越权 —— 绝不能改弱自己的刹车,绝不自行写机密 / 法律文件。',
  ].join('\n');
}

/**
 * 规则正本(供 `khy evolve rules` / 文档展示)。纯数据,无 IO ——
 * 这是 khyos 自动进化规则在系统内的**明确、可查询的权威陈述**(版本 / 范围 / 不变量 /
 * 执行点 / 分级 / 级联 / 越权通道),与运行期实际生效的判定同出一源(本叶子),绝不漂移。
 */
function describePolicy() {
  return {
    version: POLICY_VERSION,
    gate: 'KHY_EVOLUTION_POLICY',
    scope: { ...SCOPE },
    invariants: [...INVARIANTS],
    enforcement: [...ENFORCEMENT],
    tiers: { ...TIERS },
    rules: RULES.map((r) => ({ tier: r.tier, rule: r.rule, reason: r.reason })),
    cascadeRules: ['command-wiring', 'leaf-test', 'wheel-rebuild'],
    override: {
      gate: 'KHY_EVOLUTION_OVERRIDE',
      default: 'off',
      nonOverridable: [...NON_OVERRIDABLE_RULES],
      howTo: 'KHY_EVOLUTION_OVERRIDE="<规则名|路径片段>[,…]" —— 显式、按需、可审计的升级通道;' +
        'safety-machinery / secrets / legal-policy 永不可越权(刹车的刹车)',
    },
  };
}

module.exports = {
  POLICY_VERSION,
  SCOPE,
  INVARIANTS,
  ENFORCEMENT,
  TIERS,
  NON_OVERRIDABLE_RULES,
  isEnabled,
  overrideAllowlist,
  isOverrideAuthorized,
  classifyPath,
  deriveCascades,
  assessEvolution,
  buildEvolutionDirective,
  buildPolicyDirective,
  describePolicy,
};
