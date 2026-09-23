'use strict';

/**
 * ruleScaffold.js — 纯叶子：计算「一条规则的接线是否完整」，并给出**幂等的**修复计划。
 *
 * ## 为什么需要它
 *
 * `[DESIGN-ARCH-127]` 实测：在 khy-os 新增一条规则，需要同步 **13 个文件**
 * （规范 `.md`/`.html`、就近索引 `.md`/`.html`、`RULES-REGISTRY.json`、
 * 真源标记行、规则卡 `.md`/`.html`、`AGENTS.md`/`.html`、`package.json` 别名、
 * 执行器、测试）。其中 **5 项是从登记表可派生的生成物**。
 *
 * 维护成本的上限不是「写第 1 处的难度」，而是「同步剩下 N−1 处的难度」——
 * 因为同一件事写 N 遍，就**一定**会在 N 个地方漂移（本方案公理 1）。
 *
 * 本叶子的职责是**只计算、不落盘**：输入「登记表条目 + 磁盘现状」，
 * 输出「哪些触点缺失/漂移」。落盘由 `scripts/ci/scaffold-rule.js` 负责。
 * 这样判定逻辑可以在测试里完全离线验证（对齐 `scripts/lib/` 既有叶子契约）。
 *
 * ## 设计约束（与 scripts/lib 下其余叶子一致）
 *
 * 零外部依赖（只 `path`）、确定性、绝不抛、零 IO。
 * 唯一的输入是调用方传进来的**事实对象**，本模块不读盘、不 spawn。
 */

const path = require('path');

/** 触点类别。`auto` = 可由本工具派生；`manual` = 必须人写（本工具只报缺口）。 */
const KIND = Object.freeze({
  AUTO: 'auto',
  MANUAL: 'manual',
});

/**
 * 13 处硬触点的**声明式清单**。
 *
 * 每一项的 `resolve(rule, ctx)` 返回 `{ path, present, note }`：
 * - `path`    相对仓库根的路径（用于打印与修复）
 * - `present` 该触点在**磁盘上是否已存在**
 * - `note`    缺失时的人类可读理由
 *
 * ⚠ 清单是**唯一真源**：新增触点只改这里，不散落到检查器里。
 * 这条约束本身就示范了本方案的公理 1（一处语义输入）。
 */
const TOUCHPOINTS = Object.freeze([
  {
    id: 'executor',
    kind: KIND.MANUAL,
    label: '执行器脚本',
    // exec.script 是登记表里声明的真正被 spawn 的文件
    resolve: (rule, ctx) => {
      const script = rule.exec && rule.exec.script;
      if (!script) return { path: null, present: null, note: '未声明 exec.script（纯规范规则，允许）' };
      return { path: script, present: ctx.exists(script), note: 'exec.script 指向的文件不存在' };
    },
  },
  {
    id: 'alias',
    kind: KIND.AUTO,
    label: 'package.json 别名',
    // check-wiring 判定「零接线」的口径：检查器集合 = scripts/ci/* ∪ 全部规则的 exec.script
    resolve: (rule, ctx) => {
      const script = rule.exec && rule.exec.script;
      if (!script) return { path: null, present: null, note: '无执行器，无需别名' };
      return {
        path: 'package.json',
        present: ctx.hasAliasFor(script),
        note: `package.json 缺少指向 ${script} 的 check:* 别名（check-wiring 会判零接线）`,
      };
    },
  },
  {
    id: 'registry-entry',
    kind: KIND.MANUAL,
    label: '登记表条目',
    resolve: (rule, ctx) => ({
      path: ctx.registryPath,
      present: Boolean(rule.id),
      note: '登记表里查不到该条目',
    }),
  },
  {
    id: 'ssot-marker',
    kind: KIND.MANUAL,
    label: '真源标记行',
    // <!-- RULES-REGISTRY: ID --> 的语义是「本文件是这些规则的 ssot」
    // ⚠ 只对**能摘出路径**的真源文件要求标记行：纯命令目标（`npm run x`）
    //   与纯锚点（`AGENTS.md` 的 `#工程规则-规则1`）不承载标记行。
    resolve: (rule, ctx) => {
      const files = ssotFilePaths(rule);
      if (files.length === 0) return { path: null, present: null, note: '未声明 ssot 文件路径（纯命令/锚点真源，允许）' };
      const missing = files.filter((f) => {
        const hit = ctx.hasRegistryMarker(f, rule.id);
        return hit === false; // null = 文件读不到，交由 executor/exists 触点报，不在此重复
      });
      return {
        path: missing[0] || files[0],
        present: missing.length === 0,
        note: missing.length
          ? `ssot 文件缺 <!-- RULES-REGISTRY: ${rule.id} --> 标记行：${missing.join(', ')}`
          : '',
      };
    },
  },
  {
    id: 'rule-card',
    kind: KIND.MANUAL,
    label: '规则卡（生成物）',
    // 规则卡禁止手改：真源是登记表，产物由 npm run docs:rules-cards 生成
    resolve: (rule, ctx) => {
      const p = `docs/10_规范/规则卡/[${rule.id}] ${rule.name}.md`;
      return { path: p, present: ctx.exists(p), note: '规则卡缺失（应重跑 npm run docs:rules-cards）' };
    },
  },
  {
    id: 'rule-card-html',
    kind: KIND.MANUAL,
    label: '规则卡 .html 孪生件',
    // ⚠ 规则卡的 .html 由 build_docs_site.js 出，不是规则卡生成器
    resolve: (rule, ctx) => {
      const p = `docs/10_规范/规则卡/[${rule.id}] ${rule.name}.html`;
      return { path: p, present: ctx.exists(p), note: '.html 孪生件缺失（应重跑 build_docs_site.js）' };
    },
  },
]);

/** 取规则声明的全部 ssot 文件（登记表里可能是字符串或数组）。 */
function ssotFiles(rule) {
  const s = rule && rule.ssot;
  if (!s) return [];
  return Array.isArray(s) ? s.filter(Boolean) : [s];
}

/**
 * 可识别的「真源目标」文件扩展名。
 * ⚠ 按长度降序：正则 alternation 从左到右尝试，`js` 必须排在 `json` 之后，
 * 否则 `package.json` 会被截断成 `package.js`。（沿用 `check-rules-registry.js` 的既有约定。）
 */
const HOME_EXTS = ['md', 'js', 'cjs', 'mjs', 'json', 'yml', 'yaml', 'py', 'vue', 'ts']
  .sort((a, b) => b.length - a.length);

const TARGET_PATH_RE = new RegExp('^(.*?\\.(?:' + HOME_EXTS.join('|') + '))\\b');

/**
 * 把 `ssot` / `enforcement` 字段拆成**目标列表**。
 *
 * ⚠⚠ 这是本仓最容易写错的一处解析，实测踩过：
 * `ssot` **不是路径**，而是「目标」——它有三层结构：
 *   1. 用 ` / `（**带空格**）分隔多个目标；
 *   2. 每个目标可带**段尾修饰**（`§1`、`#anchor`、函数名如 `isUnbypassableGate`、
 *      甚至 `npm run check:duplication` 这样的命令）；
 *   3. 只有以已知扩展名结尾的那一段才是**文件路径**。
 *
 * 真实样本（照抄登记表）：
 * ```
 * "CLAUDE.md#一红线-r1-r4（R4）"
 * "AGENTS.md#工程规则-规则1"
 * "docs/10_规范/其它规范/[DESIGN-ACP-001] ….md / scripts/ci/validate-json-schemas.js"
 * "services/backend/src/services/riskGate.js isUnbypassableGate"
 * "docs/…/[DESIGN-SOURCING-001] ….md §4 B-U2/B-U4 / npm run check:duplication"
 * ```
 * 初版把整个字符串当文件名 ⇒ **37 条全是误报**（「文件不存在」）。
 * 教训与 `[DESIGN-ARCH-127]` §5 的精度纪律一致：**低精度守卫比没有守卫更糟**。
 */
function splitTargets(value) {
  return String(value || '')
    .split(' / ')
    .map((part) => part.trim())
    .filter(Boolean);
}

/** 从一个目标里剥出文件路径；摘不出路径（纯命令/纯锚点）则返回 null。 */
function targetPath(target) {
  const match = String(target).match(TARGET_PATH_RE);
  return match ? match[1] : null;
}

/** 规则声明的真源**文件路径**清单（已剥离段尾修饰与命令项，去重、剔除不存在的格式）。 */
function ssotFilePaths(rule) {
  const out = [];
  for (const raw of ssotFiles(rule)) {
    for (const target of splitTargets(raw)) {
      const p = targetPath(target);
      if (p) out.push(p);
    }
  }
  return [...new Set(out)];
}

/**
 * 从登记表条目计算「哪条规则有接线缺口」。
 *
 * @param {object} rule    `RULES-REGISTRY.json` 里的一条规则对象
 * @param {object} ctx     事实提供器（由走盘层注入，便于离线单测）
 *   - `exists(relPath) -> boolean`
 *   - `hasAliasFor(scriptPath) -> boolean`
 *   - `hasRegistryMarker(relPath, ruleId) -> boolean`
 *   - `registryPath` 登记表自身的相对路径
 * @returns {{ruleId: string, ok: boolean, gaps: Array<{id,label,path,note,kind}>}}
 */
function auditRule(rule, ctx) {
  const safeCtx = normalizeCtx(ctx);
  if (!rule || typeof rule !== 'object' || !rule.id) {
    return { ruleId: '', ok: true, gaps: [] };
  }

  const gaps = [];
  for (const tp of TOUCHPOINTS) {
    let r;
    try {
      r = tp.resolve(rule, safeCtx);
    } catch (err) {
      // 绝不抛：单个触点解析失败不应让整条规则审计崩掉，降级为「未知」
      continue;
    }
    if (!r || r.present === null || r.present === true) continue;
    gaps.push({ id: tp.id, label: tp.label, path: r.path, note: r.note, kind: tp.kind });
  }

  return { ruleId: rule.id, ok: gaps.length === 0, gaps };
}

/** 把所有事实提供器收敛成一组安全默认值，缺失时不抛。 */
function normalizeCtx(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  return {
    registryPath: typeof c.registryPath === 'string' ? c.registryPath : '',
    exists: typeof c.exists === 'function' ? c.exists : () => null,
    hasAliasFor: typeof c.hasAliasFor === 'function' ? c.hasAliasFor : () => null,
    hasRegistryMarker: typeof c.hasRegistryMarker === 'function' ? c.hasRegistryMarker : () => null,
  };
}

/**
 * 审计整个登记表。返回 `{ total, okCount, withGaps, results }`。
 *
 * ⚠ 不接收任何「AI 自称」：全部结论来自 ctx 提供的客观事实。
 */
function auditRegistry(registry, ctx) {
  const rules = (registry && Array.isArray(registry.rules)) ? registry.rules : [];
  const results = rules.map((r) => auditRule(r, ctx));
  const withGaps = results.filter((r) => !r.ok);
  return {
    total: rules.length,
    okCount: results.length - withGaps.length,
    withGaps: withGaps.length,
    results,
  };
}

/**
 * 校验登记表自身的**内部一致性**（`meta.ruleCount` 与 `rules.length`）。
 * 这是「第一处会漂移的真源」（见项目记忆），值得单列。
 */
function checkRegistrySelfConsistency(registry) {
  const errors = [];
  const rules = (registry && Array.isArray(registry.rules)) ? registry.rules : [];
  const declared = registry && registry.meta ? registry.meta.ruleCount : undefined;
  if (declared !== undefined && declared !== rules.length) {
    errors.push(`meta.ruleCount=${declared} 与 rules.length=${rules.length} 不一致`);
  }
  const seen = new Set();
  for (const r of rules) {
    const id = r && r.id;
    if (!id) { errors.push('存在无 id 的规则条目'); continue; }
    if (seen.has(id)) errors.push(`规则 id 重复：${id}`);
    seen.add(id);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * M2 的结构性判据：列出 `gate='advisory'` 的规则。
 *
 * ⚠ `GATE_ORDER.advisory = 4` 而比较用的 `max` 最大是 2（release）
 * ⇒ `advisory <= max` 恒假 ⇒ **这些规则不会被任何门档选中，执行器根本不被 spawn**。
 * 这是「想先观察，却写成了永不执行」的语义陷阱——正确表达是
 * `gate='commit'` + `severity='advisory'`（见 `[DESIGN-ARCH-111]`）。
 *
 * 本函数只做**结构性枚举**，不代替人做「该降格成什么」的裁决。
 */
function findNeverExecuting(registry) {
  const rules = (registry && Array.isArray(registry.rules)) ? registry.rules : [];
  return rules
    .filter((r) => r && r.gate === 'advisory')
    .map((r) => ({
      id: r.id,
      name: r.name,
      priority: r.priority,
      domain: r.domain,
      hasExecutor: Boolean(r.exec && r.exec.script),
      hasChangedFlag: Boolean(
        r.exec && Array.isArray(r.exec.args) && r.exec.args.some((a) => String(a).includes('--changed'))
      ),
      fix: r.exec && r.exec.script
        ? "改 gate 为 'commit'（须支持 --changed）+ severity 为 'advisory'"
        : '本条无执行器：应保持 manual 并在规范里显式标注人工兜底',
    }));
}

/** 按优先级排序，方便「先看 P0/P1」。确定性排序，不依赖输入顺序。 */
function sortByPriority(items) {
  const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
  return [...items].sort((a, b) => {
    const ra = rank[a.priority] !== undefined ? rank[a.priority] : 9;
    const rb = rank[b.priority] !== undefined ? rank[b.priority] : 9;
    if (ra !== rb) return ra - rb;
    return String(a.id).localeCompare(String(b.id));
  });
}

module.exports = {
  KIND,
  TOUCHPOINTS,
  HOME_EXTS,
  ssotFiles,
  splitTargets,
  targetPath,
  ssotFilePaths,
  auditRule,
  auditRegistry,
  checkRegistrySelfConsistency,
  findNeverExecuting,
  sortByPriority,
};
