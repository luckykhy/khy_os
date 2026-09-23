'use strict';

/**
 * check-prompt-taxonomy.js — 系统提示词「静态 / 动态」分层一致性守卫
 *
 *   node scripts/ci/check-prompt-taxonomy.js
 *
 * 目的：把 `constants/promptSectionTaxonomy.js`（规范声明）与
 * `constants/prompts.js` + `constants/promptCacheOrder.js`（运行时实现）钉死在一起。
 *
 * 被消灭的漂移形态（历史上全部靠人工记忆维持，无人拦截）：
 *   - 新增 section 直接塞进 getSystemPrompt，不声明它属于哪一层；
 *   - 易变段清单（promptCacheOrder.VOLATILE_SECTION_IDS）与动态区实际声明漂移；
 *   - 按需胶囊清单（prompts.js.ON_DEMAND_PROMPT_SECTION_IDS）与文档/规范漂移；
 *   - 声明为「易变」的段，cacheKey 却只含会话级常量 → 会话内被永远冻结（git_status 现况）。
 *
 * 判定分两级：
 *   [ERROR] 结构一致性（完整性 / 集合相等 / 顺序相等 / 无幽灵声明 / boundary 顺序）→ exit 1。
 *   [WARN]  分层可疑（静态段带非空依赖、易变段的键不含易变输入）→ 仅打印，exit 0。
 *
 * 契约：确定性、纯读盘 + 一次 require，不联网、不写盘、不跑生成器。
 * prompts.js 无法 require 时（依赖缺失等）降级为正则提取并记 WARN，绝不因环境问题误红。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROMPTS_PATH = path.join(ROOT, 'services', 'backend', 'src', 'constants', 'prompts.js');
const CACHE_ORDER_PATH = path.join(ROOT, 'services', 'backend', 'src', 'constants', 'promptCacheOrder.js');
const TAXONOMY_PATH = path.join(ROOT, 'services', 'backend', 'src', 'constants', 'promptSectionTaxonomy.js');

const findings = [];

function error(rule, message) {
  findings.push({ level: 'ERROR', rule, message });
}

function warn(rule, message) {
  findings.push({ level: 'WARN', rule, message });
}

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

/** 有序数组相等判定，返回首个差异的可读描述（null 表示相等）。 */
function diffOrdered(expected, actual) {
  const n = Math.max(expected.length, actual.length);
  for (let i = 0; i < n; i += 1) {
    if (expected[i] !== actual[i]) {
      return `位置 ${i}: 规范=${String(expected[i])} 实现=${String(actual[i])}`;
    }
  }
  return null;
}

function setDiff(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

// ── 0. 载入规范 ────────────────────────────────────────────────────────────────

let taxonomy;
try {
  taxonomy = require(TAXONOMY_PATH);
} catch (e) {
  console.error(`[ERROR] PTX-000 无法载入规范 ${rel(TAXONOMY_PATH)}: ${e.message}`);
  process.exit(1);
}

const {
  TIERS,
  SLOTS,
  MECHANISMS,
  REALTIME_CACHE_KEY_SOURCES,
  TIME_VARYING_CACHE_KEY_SOURCES,
  SECTIONS,
  ON_DEMAND_SECTION_IDS,
  BUILDER_TIERS,
  CONCERNS,
  idsByTier,
  idsBySlot,
  idsByMechanism,
} = taxonomy;

// ── 1. 规范内部自洽（先证明规范自身没毛病，再拿它去判实现）──────────────────────

(function checkTaxonomySelfConsistency() {
  const ids = SECTIONS.map((s) => s.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    error('PTX-001', `规范内 section id 重复: ${[...new Set(dupes)].join(', ')}`);
  }

  const validTiers = new Set(Object.values(TIERS).map((t) => t.id));
  const validSlots = new Set(Object.values(SLOTS));
  const validMechanisms = new Set(Object.values(MECHANISMS));

  for (const s of SECTIONS) {
    if (!validTiers.has(s.tier)) error('PTX-002', `section "${s.id}" 的 tier 非法: ${s.tier}`);
    if (!validSlots.has(s.slot)) error('PTX-003', `section "${s.id}" 的 slot 非法: ${s.slot}`);
    if (!validMechanisms.has(s.mechanism)) {
      error('PTX-004', `section "${s.id}" 的 mechanism 非法: ${s.mechanism}`);
    }
    if (!Array.isArray(s.dependsOn)) {
      error('PTX-005', `section "${s.id}" 的 dependsOn 必须是数组`);
    }
    if (s.builder) {
      if (!Object.prototype.hasOwnProperty.call(BUILDER_TIERS, s.builder)) {
        error('PTX-006', `section "${s.id}" 引用了未登记的 builder: ${s.builder}`);
      } else if (
        s.builder !== 'getOnDemandPromptSections' &&
        BUILDER_TIERS[s.builder] !== s.tier
      ) {
        error(
          'PTX-007',
          `builder 归类冲突: ${s.builder} 在 BUILDER_TIERS 中为 ${BUILDER_TIERS[s.builder]}，` +
            `但 section "${s.id}" 声明为 ${s.tier}`
        );
      }
    }
    // slot 必须落在 tier 允许的落点内（on_demand 只允许尾部）。
    if (s.tier === TIERS.ON_DEMAND.id && s.slot !== SLOTS.TAIL) {
      error('PTX-008', `on_demand section "${s.id}" 必须落在 tail 槽`);
    }
    if (s.tier === TIERS.DYNAMIC_VOLATILE.id && s.slot !== SLOTS.TAIL) {
      error('PTX-009', `dynamic_volatile section "${s.id}" 必须落在 tail 槽`);
    }
    if (s.tier === TIERS.STATIC.id && s.slot !== SLOTS.PREFIX) {
      error('PTX-010', `static section "${s.id}" 必须落在 prefix 槽（boundary 之前）`);
    }
  }

  // 合并 CONCERNS 引用的 id 必须真实存在。
  for (const key of Object.keys(CONCERNS)) {
    for (const id of CONCERNS[key].sections) {
      if (!SECTIONS.some((s) => s.id === id)) {
        error('PTX-011', `CONCERNS.${key} 引用了不存在的 section: ${id}`);
      }
    }
  }
})();

// ── 2. 从 prompts.js 静态提取实现侧事实 ────────────────────────────────────────

let promptsSource;
try {
  promptsSource = fs.readFileSync(PROMPTS_PATH, 'utf8');
} catch (e) {
  error('PTX-020', `无法读取 ${rel(PROMPTS_PATH)}: ${e.message}`);
  promptsSource = '';
}

/** 去掉行注释/块注释后的源码切片（避免注释里的函数名被误判为真实调用）。 */
function stripCommentLines(source) {
  return source
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');
}

/** getSystemPrompt 函数体的源码切片。 */
function sliceGetSystemPrompt(source) {
  const start = source.indexOf('async function getSystemPrompt(');
  if (start < 0) return '';
  const end = source.indexOf('\nfunction assembleSystemPrompt(', start);
  return source.slice(start, end > 0 ? end : undefined);
}

const promptBody = stripCommentLines(sliceGetSystemPrompt(promptsSource));

/** 实现侧：以 systemPromptSection/DANGEROUS_uncachedSystemPromptSection 声明的段 id（按声明序）。 */
const declaredSectionIds = (() => {
  const re = /(?:DANGEROUS_uncachedSystemPromptSection|systemPromptSection)\(\s*'([A-Za-z0-9_]+)'/g;
  const out = [];
  let m;
  while ((m = re.exec(promptsSource)) !== null) out.push(m[1]);
  return out;
})();

/**
 * getSystemPrompt 体内实际调用的 section 构造函数。
 * 覆盖三种命名:`getXxxSection(` / `getXxxSections(`(按需胶囊的聚合旧名) /
 * `getXxxSectionEntries(`(P0 起为打锚点新增的「带 id 版」聚合名)。
 */
const calledBuilders = (() => {
  const re = /\b(get[A-Za-z0-9]+(?:Sections?|SectionEntries))\s*\(/g;
  const out = [];
  let m;
  while ((m = re.exec(promptBody)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
})();

// ── 3. 核对：dynamic 段声明（集合 + 顺序）─────────────────────────────────────

(function checkDynamicSectionIds() {
  const expected = idsByMechanism(MECHANISMS.SECTION);
  const diff = diffOrdered(expected, declaredSectionIds);
  if (diff) {
    error(
      'PTX-030',
      `动态段的 systemPromptSection 声明与规范不一致（${rel(PROMPTS_PATH)} vs ${rel(TAXONOMY_PATH)}）: ${diff}\n` +
        `    规范: ${expected.join(', ')}\n    实现: ${declaredSectionIds.join(', ')}`
    );
  }
  const missing = setDiff(expected, declaredSectionIds);
  const extra = setDiff(declaredSectionIds, expected);
  if (missing.length || extra.length) {
    error(
      'PTX-031',
      `动态段集合不一致: 规范独有=[${missing.join(', ')}] 实现独有=[${extra.join(', ')}]`
    );
  }
})();

// ── 4. 核对：易变段清单（promptCacheOrder 运行时导出）─────────────────────────

(function checkVolatileSet() {
  let runtimeVolatile;
  try {
    runtimeVolatile = require(CACHE_ORDER_PATH).VOLATILE_SECTION_IDS;
  } catch (e) {
    error('PTX-040', `无法从 ${rel(CACHE_ORDER_PATH)} 读取 VOLATILE_SECTION_IDS: ${e.message}`);
    return;
  }
  const declared = idsByTier(TIERS.DYNAMIC_VOLATILE.id);
  const diff = diffOrdered(declared, runtimeVolatile);
  if (diff) {
    error(
      'PTX-041',
      `易变段清单漂移（promptCacheOrder.VOLATILE_SECTION_IDS vs 规范 dynamic_volatile）: ${diff}\n` +
        `    规范: ${declared.join(', ')}\n    实现: ${runtimeVolatile.join(', ')}`
    );
  }
})();

// ── 5. 核对：按需胶囊清单（用运行时导出作权威，重排逻辑可随之验证）────────────

(function checkOnDemandIds() {
  const declared = [...ON_DEMAND_SECTION_IDS];
  let runtime = null;
  try {
    const prompts = require(PROMPTS_PATH);
    if (typeof prompts.listOnDemandPromptSectionIds === 'function') {
      runtime = prompts.listOnDemandPromptSectionIds({ forceAllPromptSections: true });
    }
  } catch (e) {
    warn('PTX-050', `无法 require prompts.js 取按需清单运行时真值（降级为仅校验规范自身）: ${e.message}`);
  }

  if (!Array.isArray(runtime)) {
    // 正则兜底：直接抓 ON_DEMAND_PROMPT_SECTION_IDS 数组字面量。
    const m = promptsSource.match(/const ON_DEMAND_PROMPT_SECTION_IDS\s*=\s*\[([\s\S]*?)\];/);
    if (m) {
      runtime = m[1].match(/'([A-Za-z0-9_]+)'/g)?.map((s) => s.replace(/'/g, '')) || [];
    }
  }
  if (!Array.isArray(runtime)) {
    warn('PTX-051', '既无法取得运行时按需清单，也未匹配到 ON_DEMAND_PROMPT_SECTION_IDS 数组字面量。');
    return;
  }

  const diff = diffOrdered(declared, runtime);
  if (diff) {
    error(
      'PTX-052',
      `按需胶囊清单漂移（prompts.js.ON_DEMAND_PROMPT_SECTION_IDS vs 规范 ON_DEMAND_SECTION_IDS）: ${diff}\n` +
        `    规范: ${declared.join(', ')}\n    实现: ${runtime.join(', ')}`
    );
  }
})();

// ── 6. 核对：builder 白名单（拦截「新增段忘了声明分层」）────────────────────────

(function checkBuilderWhitelist() {
  const declared = Object.keys(BUILDER_TIERS);
  const undeclared = setDiff(calledBuilders, declared);
  const unused = setDiff(declared, calledBuilders);

  if (undeclared.length > 0) {
    error(
      'PTX-060',
      `getSystemPrompt 里出现了未声明分层的 section 构造函数: ${undeclared.join(', ')}\n` +
        `    请在 ${rel(TAXONOMY_PATH)} 的 SECTIONS 中登记其 tier，并同步 BUILDER_TIERS。`
    );
  }
  if (unused.length > 0) {
    error(
      'PTX-061',
      `规范登记了但代码里从未调用的 builder（幽灵声明，请删除）: ${unused.join(', ')}`
    );
  }
})();

// ── 7. 核对：boundary 在描述符序列中的落点 ─────────────────────────────────────
//
// [DESIGN-ARCH-098] P0 起，装配改为「描述符(_push) → 锚点」结构，不再有
// `...resolvedStable` / `...resolvedVolatile` 这类展开元素。故这里核验的是**源码里 _push
// 的先后**:最后一个 prefix 段 → boundary → 第一个 dynamic 段。

(function checkSlotOrdering() {
  if (!promptBody) {
    warn('PTX-070', '无法取得 getSystemPrompt 函数体,跳过 boundary 落点核验。');
    return;
  }
  const idxBoundary = promptBody.indexOf('_push(null, null, SYSTEM_PROMPT_DYNAMIC_BOUNDARY)');
  if (idxBoundary < 0) {
    error(
      'PTX-070',
      'getSystemPrompt 中找不到 boundary 的 _push 调用，无法核验落点顺序。' +
        'boundary 必须以 _push(null, null, SYSTEM_PROMPT_DYNAMIC_BOUNDARY) 形式出现。'
    );
    return;
  }
  const lastPrefixPush = Math.max(
    promptBody.lastIndexOf("_push('prefix'"),
    promptBody.lastIndexOf("_push('prefix',")
  );
  const firstDynamicPush = promptBody.indexOf("_push('dynamic'");
  if (lastPrefixPush >= 0 && !(lastPrefixPush < idxBoundary)) {
    error('PTX-071', '落点顺序被破坏: 存在位于 boundary 之后的 prefix 槽段。');
  }
  if (firstDynamicPush >= 0 && !(idxBoundary < firstDynamicPush)) {
    error('PTX-071', '落点顺序被破坏: 存在位于 boundary 之前的 dynamic 槽段。');
  }
})();

// ── 8. WARN：静态段带非空依赖 / 易变段的键不含易变输入 / 实时键落在稳定槽 ────────
//
// 已登记在 CONCERNS 里的缺陷不在此重复报警（它们由第 9 节的「仍然存在」断言单独把关）。
// 这样本节的 WARN 只表示「新增的、尚未登记的分层卫生问题」——CI 一旦出现 WARN 就说明
// 有人引入了新的漂移，而不是在重复播报历史欠债。

const CONCERNED_IDS = new Set(
  Object.values(CONCERNS).flatMap((c) => (Array.isArray(c.sections) ? c.sections : []))
);

(function checkLayerHygiene() {
  for (const s of SECTIONS) {
    if (CONCERNED_IDS.has(s.id)) continue;

    if (s.tier === TIERS.STATIC.id && Array.isArray(s.dependsOn) && s.dependsOn.length > 0) {
      warn(
        'PTX-080',
        `[静态段带非空依赖] "${s.id}" 位于 boundary 之前却依赖 ${s.dependsOn.join(' / ')}` +
          `——该输入一变即击穿静态前缀。请改为纯字面量段，或把它移入动态区并登记到 CONCERNS。`
      );
    }
    if (
      s.tier === TIERS.DYNAMIC_VOLATILE.id &&
      !TIME_VARYING_CACHE_KEY_SOURCES.includes(s.cacheKeySource)
    ) {
      warn(
        'PTX-081',
        `[易变段的键不含易变输入] "${s.id}" 归为 dynamic_volatile，cacheKeySource 却是 ` +
          `"${s.cacheKeySource}" → 段缓存在会话内永不失效。请折入真实输入，或降级为 dynamic_stable。`
      );
    }
    if (
      s.tier === TIERS.DYNAMIC_STABLE.id &&
      s.slot !== SLOTS.PREFIX &&
      REALTIME_CACHE_KEY_SOURCES.includes(s.cacheKeySource)
    ) {
      warn(
        'PTX-082',
        `[实时键落在稳定槽] "${s.id}" 归为 dynamic_stable，键却是每轮必然变化的 ` +
          `"${s.cacheKeySource}" —— 它实际上应归入 dynamic_volatile 的尾部组。`
      );
    }
  }
})();

// ── 9. 核对：CONCERNS 里的缺陷必须仍然存在（修好即须删条目，防清单腐化）────────

(function checkConcernsStillOpen() {
  // staleKey：P1 已修复并移出 CONCERNS（2026-09-15）。若它又被加回来,说明键退回了会话常量,
  // 此处按「条目存在才校验」处理,避免清单移除后留下死代码。
  if (CONCERNS.staleKey) {
    for (const id of CONCERNS.staleKey.sections) {
      const s = SECTIONS.find((x) => x.id === id);
      if (s && TIME_VARYING_CACHE_KEY_SOURCES.includes(s.cacheKeySource)) {
        error(
          'PTX-090',
          `CONCERNS.staleKey 已过期："${id}" 的键已变为随时间变化的值（${s.cacheKeySource}），` +
            `请从 ${rel(TAXONOMY_PATH)} 的 CONCERNS.staleKey.sections 中移除它。`
        );
      }
    }
  }

  // P1 反向断言(修复不可回退):三处新鲜度键仍必须折入真实输入。若有人把键改回裸会话常量
  // (git_status/project_instructions → cwd;skill_catalog → contextWindowTokens),这里立刻变红。
  const FRESH_KEY_SITES = [
    { id: 'git_status', re: /systemPromptSection\(\s*'git_status'[\s\S]{0,200}?,\s*([^,\n]+)\s*\)/ },
    {
      id: 'project_instructions',
      re: /systemPromptSection\(\s*'project_instructions'[\s\S]{0,300}?,\s*([^,\n]+)\s*\)/,
    },
    { id: 'skill_catalog', re: /skillCatalogSectionCacheKey\(\s*([^)]*)\)/ },
  ];
  for (const site of FRESH_KEY_SITES) {
    const m = promptsSource.match(site.re);
    if (!m) {
      warn('PTX-091', `无法定位 ${site.id} 的 cacheKey 站点,跳过新鲜度核验。`);
      continue;
    }
    const arg = m[1].trim();
    const stale = arg === 'cwd' || arg === "String(opts.contextWindowTokens ?? '')" || arg === '';
    if (stale) {
      error(
        'PTX-091',
        `${site.id} 的 cacheKey 退回会话常量("${arg}") → 段缓存会再次被冻结在会话首轮。` +
          'P1 的修复不可回退;如需回退请显式关闭 KHY_PROMPT_FRESH_KEYS。'
      );
    }
  }

  // parametrizedStatic / volatileInPrefix：相关段必须仍在 prefix 槽且依赖非空。
  for (const id of CONCERNS.parametrizedStatic.sections) {
    const s = SECTIONS.find((x) => x.id === id);
    if (s && (s.slot !== SLOTS.PREFIX || !(s.dependsOn || []).length)) {
      error(
        'PTX-092',
        `CONCERNS.parametrizedStatic 已过期："${id}" 已不再是「带依赖的静态段」，请删除该条目。`
      );
    }
  }
  for (const id of CONCERNS.volatileInPrefix.sections) {
    const s = SECTIONS.find((x) => x.id === id);
    if (s && s.slot !== SLOTS.PREFIX) {
      error(
        'PTX-093',
        `CONCERNS.volatileInPrefix 已过期："${id}" 已移出静态前缀，请删除该条目。`
      );
    }
  }
  const ks = SECTIONS.find((x) => x.id === 'khy_specific');
  if (CONCERNS.misfiledTaskScale.sections.includes('khy_specific') && ks) {
    if (!(ks.dependsOn || []).includes('taskScale')) {
      error(
        'PTX-094',
        'CONCERNS.misfiledTaskScale 已过期：khy_specific 的 dependsOn 已不含 taskScale，请删除该条目。'
      );
    }
  }
})();

// ── 10. P0/P1 接线守卫([DESIGN-ARCH-098] §9 的静态形式)────────────────────────
//
// 这四条对应实现期真实踩到的坑,全部**静态可判**(不跑装配,不依赖运行时环境):
//   PTX-100  描述符里的 slot 字面量必须与规范声明的 slot 一致(否则「分层」名不副实)
//   PTX-101  扁平化必须显式过滤锚点元素(否则锚点会进入模型可见的扁平产物)
//   PTX-102  静态层段的 dependsOn 必须为空(或已登记在 CONCERNS)
//   PTX-103  新门控必须已登记在 flagRegistry —— 未登记的 flag 会被 isFlagEnabled 保守放行
//            为 true,「以为默认关其实默认开」是最隐蔽的一类接线错误

const PROMPTS_PATH_P0 = path.join(
  ROOT,
  'services',
  'backend',
  'src',
  'constants',
  'prompts.js'
);
const FLAG_REGISTRY_PATH = path.join(ROOT, 'services', 'backend', 'src', 'services', 'flagRegistry.js');

(function checkDescriptorSlots() {
  if (!promptsSource) {
    return;
  }
  // 收集实现侧「id → slot」:两种写法都要覆盖
  //   ① _push('prefix', 'simple_intro', ...)
  //   ② { slot: 'prefix', id: 'doing_tasks', text: ... }
  const pairs = new Map();
  const rePush = /_push\(\s*'([a-z_]+)'\s*,\s*'([A-Za-z0-9_]+)'/g;
  let m;
  while ((m = rePush.exec(promptsSource)) !== null) {
    pairs.set(m[2], m[1]);
  }
  const reObj = /slot:\s*'([a-z_]+)'\s*,\s*\n?\s*id:\s*'([A-Za-z0-9_]+)'/g;
  while ((m = reObj.exec(promptsSource)) !== null) {
    pairs.set(m[2], m[1]);
  }

  if (pairs.size === 0) {
    warn('PTX-100', '未在 prompts.js 中匹配到任何描述符 slot 字面量,无法核验槽位一致性。');
    return;
  }

  const mismatched = [];
  for (const [id, slot] of pairs) {
    const decl = SECTIONS.find((s) => s.id === id);
    if (!decl) {
      mismatched.push(`${id}(未在规范中登记,实现侧标注为 ${slot})`);
      continue;
    }
    if (decl.slot !== slot) {
      mismatched.push(`${id}(实现=${slot} 规范=${decl.slot})`);
    }
  }
  if (mismatched.length > 0) {
    error(
      'PTX-100',
      `描述符槽位与规范不一致: ${mismatched.join(', ')}\n` +
        `    请同步 ${rel(TAXONOMY_PATH)} 的 SECTIONS[].slot,或修正 prompts.js 的 _push/_descriptor 字面量。`
    );
  }
})();

(function checkAnchorStrippingOnFlatPath() {
  if (!promptsSource) {
    return;
  }
  // 扁平路径必须剔除锚点元素,否则锚点会进入模型可见产物(破坏「P0 零产物变更」)。
  if (!/isAnchorMarker/.test(promptsSource)) {
    error(
      'PTX-101',
      'assembleSystemPrompt 未见 isAnchorMarker 过滤 —— 锚点会混入扁平产物。' +
        '开锚点时的扁平输出必须与关闭时逐字节相同。'
    );
  }
})();

(function checkStaticLayerPurity() {
  const concerned = new Set(
    Object.values(CONCERNS).flatMap((c) => (Array.isArray(c.sections) ? c.sections : []))
  );
  const offenders = SECTIONS.filter(
    (s) =>
      s.tier === TIERS.STATIC.id &&
      Array.isArray(s.dependsOn) &&
      s.dependsOn.length > 0 &&
      !concerned.has(s.id)
  ).map((s) => `${s.id}(${s.dependsOn.join('/')})`);
  if (offenders.length > 0) {
    error(
      'PTX-102',
      `静态层段带运行时依赖且未登记 CONCERNS: ${offenders.join(', ')}\n` +
        '    静态段必须只由源码字面量决定;若确属已知欠债,请登记到 CONCERNS。'
    );
  }
})();

(function checkNewFlagsRegistered() {
  let registrySource;
  try {
    registrySource = fs.readFileSync(FLAG_REGISTRY_PATH, 'utf8');
  } catch (e) {
    warn('PTX-103', `无法读取 flagRegistry.js,跳过门控登记核验: ${e.message}`);
    return;
  }
  // P0/P1 门控 + 期望的默认值(与代码注释里的意图一致)
  const EXPECTED = [
    { name: 'KHY_PROMPT_ANCHORS', def: false, why: '锚点会进入模型可见文本,须默认关' },
    { name: 'KHY_PROMPT_FRESH_KEYS', def: true, why: '新鲜度键属缺陷修复,须默认开' },
  ];
  let registry;
  try {
    registry = require(FLAG_REGISTRY_PATH);
  } catch (e) {
    warn('PTX-103', `无法 require flagRegistry,跳过默认值核验: ${e.message}`);
    return;
  }
  for (const { name, def, why } of EXPECTED) {
    if (!registrySource.includes(`${name}:`)) {
      error(
        'PTX-103',
        `${name} 未登记在 flagRegistry —— 未登记的 flag 会被 isFlagEnabled 保守放行为 true。` +
          `这会让「默认关」变成「默认开」(${why})。`
      );
      continue;
    }
    const actual = registry.isFlagEnabled(name, {});
    if (actual !== def) {
      error(
        'PTX-103',
        `${name} 默认值不符: 期望 ${def},实测 ${actual}(${why})。` +
          'opt-in 只认 true/1;default-on 需 off 词表且 default:true。'
      );
    }
  }
})();

// ── 输出 ───────────────────────────────────────────────────────────────────────

const errors = findings.filter((f) => f.level === 'ERROR');
const warns = findings.filter((f) => f.level === 'WARN');

const summary =
  `分层快照: static=${idsBySlot(SLOTS.PREFIX).length} ` +
  `dynamic_stable=${idsBySlot(SLOTS.DYNAMIC).length + idsBySlot(SLOTS.TRAILING).length} ` +
  `dynamic_volatile=${idsByTier(TIERS.DYNAMIC_VOLATILE.id).length} ` +
  `on_demand=${ON_DEMAND_SECTION_IDS.length}`;

for (const w of warns) console.warn(`[WARN]  ${w.rule} ${w.message}`);
for (const e of errors) console.error(`[ERROR] ${e.rule} ${e.message}`);

if (errors.length === 0) {
  console.log(`提示词分层检查通过：规范与实现一致（${summary}）。`);
  if (warns.length > 0) {
    console.log(`注意：另有 ${warns.length} 条分层可疑项（WARN，不阻塞），见上方。`);
  }
  process.exit(0);
}

console.error(`\n提示词分层检查失败：${errors.length} 个错误。${summary}`);
process.exit(1);
