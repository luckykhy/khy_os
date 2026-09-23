'use strict';

/**
 * discoverabilityGuard.js — 「层级可发现性」的机器强制单一真源。
 *
 * 背景：[DESIGN-LAY-005] 已经把「东西属于哪一层」讲清楚了（L0–L6 + 横切 + 根级例外），
 * 但**层内**的「找得到 / 找不到」一直是空白。实测证据（2026-09-18）：
 *   services/backend/src/services/        809 条目（661 文件 + 148 目录）平铺
 *   services/backend/tests/services/      638 条目平铺
 *   docs/07_OPS_运维/                     366 份 OPS-MAN-*.md 平铺
 *   docs/03_DESIGN_设计/                  222 份 DESIGN-ARCH-*.md 平铺
 *   services/backend/src/tools/           224 条目（122 文件 + 102 目录）平铺
 * 一个 809 条目的平铺目录里，「`a2a` 相关的东西在哪」只能靠 `ls | grep`；新人无法
 * 凭目录名预判内容。**布局守卫管不到这件事**——它只看顶层目录登没登记
 * （`layer-registry`），不看层内目录有多深多宽。
 *
 * 本守卫补的正是这一段：把「**读者能不能凭路径预判内容**」变成确定性的机器检查。
 * 判据只取**可客观测量、且经验证对现存仓库零误报**的不变量：
 *
 *   1. flat-overflow(error)：一个目录里的**直接条目数**超过该目录所属层级的阈值。
 *      平铺 809 个东西 = 没有分层，等价于「没有结构」。
 *   2. no-index(error,仅 docs/)：docs 目录里条目数超过阈值的，必须有 `00_INDEX_*`
 *      把条目编组。「有索引」不等于「有条目」，索引必须真的覆盖到（见 no-grouping）。
 *   3. no-grouping(error)：超阈目录的 `00_INDEX_*` 若**没有**任何分组标题
 *      （`##` 小节 / 表格分组列有非空值），说明索引只是平铺清单，没起到编组作用。
 *      ⚠ 2026-09-18 由 warning 升 error（[DESIGN-LAY-006] §7 步骤3）—— 文档索引
 *      编组**没有「+1 副作用」**，故可先行收紧；`flat-overflow` 的升级须待存量
 *      家族完成「迁移 + 清壳」，见下条。
 *   4. missing-inventory(error)：本守卫依赖的「层级容量基线」文件必须存在且可解析。
 *      基线缺失 = 守卫失去判据，静默放行一切。
 *
 * 阈值不是拍脑袋：它们是 [DESIGN-LAY-006] §2 的「可发现性预算」，按目录的**读取场景**
 * 分档（详见文档）。基线文件 `scripts/ci/discoverability-baseline.json` 记录每条
 * 存量违规数，只降不升。
 *
 * ⚠ **re-export 壳计入预算（2026-09-18 实测，[DESIGN-LAY-006] §1.3.1 缺陷 ②）**：
 * `classifyEntry` 只按**名字**分类，无法区分「壳」与「真实模块」——shell 与模块同名，
 * `EXEMPT_NAMES` 也没有 shell 概念。因此「整族迁移 + 留壳」会使父目录条目数 **+1**
 * （N 个文件 → N 个壳 + 1 个新目录），而非 −N。要真正降档必须**迁移 + 清壳**两步。
 * 这是**刻意保留**的行为：壳若被豁免，迁移者可以靠留壳「刷绿」预算，等于变相绕过。
 *
 * 纯叶子契约：零 IO、确定性、绝不抛、可单测。
 * env 门控 KHY_DISCOVERABILITY_GUARD（默认开，仅显式 0/false/off/no 关闭）。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_DISCOVERABILITY_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

// ── 可发现性预算（真源 [DESIGN-LAY-006] §2）────────────────────────────
// 判定的是「一个目录的直接子条目数」上限。分档依据是**读者面对它时的检索方式**：
//   - 顶层/分类目录：读者靠名字导航，容忍度高（50）
//   - 实现目录：读者靠 grep / IDE 跳转，容忍度中（40）
//   - 文档目录：读者靠人眼扫索引，容忍度最低（30）
// 数字是**预算不是禁令**：超了就拆组或建索引，不是「不许有文件」。
const BUDGETS = {
  top: 50,        // 仓库顶层 / 各层顶层
  category: 50,   // docs/NN_*/
  implementation: 40, // 代码实现目录（src/**、scripts/**）
  docs: 30,       // 单个文档目录（同一编号族成堆出现的地方）
};

// 这些目录名在任何层级都豁免：它们是外部工具 / 构建器的落点，不是本仓设计的层级。
// 依据 [DESIGN-LAY-004]（产物单一根）与 [DESIGN-LAY-002]（vendor 三义裁定）。
const EXEMPT_NAMES = new Set([
  'node_modules', '.git', '__pycache__', 'vendor', '.cache',
  'dist', 'build', 'out', 'release', 'coverage', '.nyc_output',
  'dist-electron', '_build', '.dart_tool', 'migrations', 'assets',
  // 已 gitignore 的工具暂存目录（实测 .zcode/tmp 有 175 个条目，是会话 scratch，
  // 不是本仓的层级设计 —— 对它报「平铺超预算」是误报，因为没有人靠目录名去那里找东西）。
  '.zcode', '.zcode-tmp', '.research-tmp', '.khy_orphan_sweep', 'tmp-cmp',
]);

// 以 `.` 开头的顶层目录（工具配置：.ai/.claude/.cursor/.github/.githooks…）——
// 它们按**工具约定**命名，不参与本仓的层级可发现性判定（改它们等于改工具契约）。
function isDotDir(name) {
  const n = String(name || '');
  return n.startsWith('.') && n.length > 1;
}

// 按路径判定所属档位。顺序敏感：先具体后一般。
function budgetFor(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!p) return { tier: 'top', limit: BUDGETS.top };
  const segs = p.split('/').filter(Boolean);
  // docs/NN_xxx/ 及其下 —— 文档目录按人眼扫读计
  if (segs[0] === 'docs') {
    if (segs.length >= 2 && /^\d\d_/.test(segs[1])) {
      return { tier: 'docs', limit: BUDGETS.docs };
    }
    return { tier: 'category', limit: BUDGETS.category };
  }
  // 代码层
  if (/^(kernel|platform|services|apps|software|extensions|tools)$/.test(segs[0] || '')) {
    // 层顶层容忍度高一点，进去就按实现目录算
    if (segs.length <= 1) return { tier: 'top', limit: BUDGETS.top };
    return { tier: 'implementation', limit: BUDGETS.implementation };
  }
  if (segs[0] === 'scripts' || segs[0] === 'packaging') {
    if (segs.length <= 1) return { tier: 'top', limit: BUDGETS.top };
    return { tier: 'implementation', limit: BUDGETS.implementation };
  }
  if (segs.length <= 1) return { tier: 'top', limit: BUDGETS.top };
  return { tier: 'implementation', limit: BUDGETS.implementation };
}

function isExemptName(name) {
  const n = String(name || '');
  if (EXEMPT_NAMES.has(n)) return true;
  if (isDotDir(n)) return true;
  return false;
}

// 条目是否是「本仓设计的层级内容」——只看名字，零 IO。
// 调用方（CLI）负责把真实条目名喂进来；本叶子不碰 fs。
function classifyEntry(name) {
  const n = String(name || '');
  if (!n) return 'invalid';
  if (isExemptName(n)) return 'exempt';
  return 'counted';
}

// ── 单目录判定（纯函数）──────────────────────────────────────────────
// entries: [{ name, kind:'file'|'dir' }]，relative dir relPath。
// 返回 findings 数组。绝不抛。
function inspectDir(relPath, entries, opts) {
  try {
    const o = opts || {};
    const list = Array.isArray(entries) ? entries : [];
    const budget = budgetFor(relPath);
    const limit = Number.isFinite(o.limit) ? o.limit : budget.limit;

    let counted = 0;
    const exempted = [];
    for (const e of list) {
      const name = e && typeof e === 'object' ? e.name : e;
      const cls = classifyEntry(name);
      if (cls === 'counted') counted += 1;
      else if (cls === 'exempt') exempted.push(String(name));
    }
    if (limit === Infinity || counted <= limit) return [];

    const hasIndex = list.some((e) => {
      const name = e && typeof e === 'object' ? e.name : e;
      return /^00_INDEX_/.test(String(name || ''));
    });
    const isDocs = /^docs(\/|$)/.test(String(relPath || '').replace(/\\/g, '/'));
    const out = [{
      id: 'flat-overflow',
      strength: 'error',
      path: String(relPath || '.'),
      tier: budget.tier,
      counted,
      limit,
      over: counted - limit,
      hasIndex,
      exempted: exempted.length,
      detail: `目录 "${relPath || '.'}" 直接条目 ${counted} 个，超过 ${budget.tier} 档预算 ${limit}（超出 ${counted - limit}）。`
        + (isDocs && !hasIndex ? ' 且无 00_INDEX_* 编组。' : ''),
    }];
    return out;
  } catch (err) {
    return []; // 绝不抛
  }
}

// ── 索引编组判定（纯函数）────────────────────────────────────────────
// 只吃索引文档的**纯文本**，不碰 IO。用于判断「索引是否真的编了组」。
//
// 关键实测教训（2026-09-18）：`##` 小节数量**不能**当编组信号。
// `docs/07_OPS_运维/00_INDEX_运维-分类索引.md` 有 4 个 `##`（分类边界/文件清单/关联指引），
// 但其中「二、文件清单」一个标题下平铺了 **366 条**文件链接 —— 索引有形无实。
// 正确判据是**最大分组块的大小**：一个分组块里塞超过块预算的条目，等于没分组。
const BLOCK_BUDGET = 80;

function inspectIndex(relPath, indexText) {
  try {
    const text = String(indexText || '');
    if (!text.trim()) {
      return [{
        id: 'empty-index', strength: 'error', path: String(relPath || ''),
        detail: `索引 "${relPath}" 内容为空。`,
      }];
    }
    // 把正文按标题切成块，统计每块里的「条目行」数。
    // 条目行 = 表格数据行（| 开头且不是分隔行）或列表项（- / * / 1.）。
    const lines = text.split(/\r?\n/);
    const blocks = [];
    let current = { head: '(前言)', count: 0 };
    for (const raw of lines) {
      const line = raw.trim();
      if (/^#{1,6}\s+/.test(line)) {
        blocks.push(current);
        current = { head: line.replace(/^#{1,6}\s+/, '').slice(0, 40), count: 0 };
        continue;
      }
      const isTableRow = /^\|/.test(line) && !/^\|[\s:|-]+\|?\s*$/.test(line);
      const isListItem = /^(?:[-*+]|\d+\.)\s+/.test(line);
      if (isTableRow || isListItem) current.count += 1;
    }
    blocks.push(current);

    const biggest = blocks.reduce((a, b) => (b.count > a.count ? b : a), { head: '-', count: 0 });
    if (biggest.count > BLOCK_BUDGET) {
      return [{
        id: 'no-grouping', strength: 'error', path: String(relPath || ''),
        detail: `索引 "${relPath}" 的「${biggest.head}」一块里平铺了 ${biggest.count} 条`
          + `（块预算 ${BLOCK_BUDGET}）—— 索引有形无实，读者仍要靠 Ctrl+F 找。`,
        block: biggest.head,
        count: biggest.count,
        limit: BLOCK_BUDGET,
      }];
    }
    return [];
  } catch (err) {
    return [];
  }
}

// ── 审查结果组装（纯函数）────────────────────────────────────────────
function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  let errors = 0; let warnings = 0;
  for (const f of list) {
    if (!f) continue;
    if (f.strength === 'error') errors += 1;
    else warnings += 1;
  }
  return { errors, warnings, total: errors + warnings, findings: list };
}

function render(findings) {
  const s = summarize(findings);
  const lines = [];
  for (const f of s.findings) {
    const tag = f.strength === 'error' ? 'error' : 'warning';
    lines.push(` - [${tag}] ${f.detail} (id: ${f.id})`);
  }
  lines.push(`Summary: ${s.errors} error(s), ${s.warnings} warning(s).`);
  return lines.join('\n');
}

module.exports = {
  isEnabled,
  BUDGETS,
  EXEMPT_NAMES,
  budgetFor,
  isExemptName,
  isDotDir,
  classifyEntry,
  inspectDir,
  inspectIndex,
  summarize,
  render,
};