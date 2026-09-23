'use strict';

/**
 * @pattern Strategy, Chain of Responsibility
 *
 * buildRootGuard.js — 「构建产物单一根」([DESIGN-LAY-004] / LAYOUT-005) 的判定层。
 *
 * 纯叶子：零 IO、确定性、绝不抛、可单测。走盘与读登记表留在
 * scripts/ci/check-build-root.js；反例矩阵留在 _产物/build-root-demo.js。
 *
 * ## 它守的不是「产物干不干净」，而是三条不变量
 *
 *   I1 可删除性   —— 登记表每条都必须有一条能把它变回来的 rebuild 命令
 *   I2 零越界     —— 产物不得落在 `entries/` 之外的未登记路径
 *   I3 非寄生棘轮 —— 无法重定向的寄生条目必须带 hook + sunset，且总数只减不增
 *
 * ## 为什么判定输入是「路径 + 登记表」而不是「路径 + 硬编码白名单」
 *
 * 仓库原有三份手写清单（`.gitignore` / `.dockerignore` / `clean.js` TARGETS）互不同步，
 * 实测 `clean.js` 漏登记 17 条、`.gitignore` 漏覆盖 5 个产物目录、`check-build-artifacts`
 * 绿着放行 10 个已跟踪产物（[DESIGN-LAY-004] §1）。根因不是清单写错了，而是
 * **白名单没有机制保证与磁盘同步**。所以这里把真源收敛成一份登记表，本叶子只做
 * 「路径 ↔ 登记表」的差异判定——登记表变了，判定跟着变，不需要改代码。
 *
 * ## 为什么源码同名目录必须显式排除
 *
 * `packaging/build/` 是 CI 构建**脚本源码**（根 `.gitignore` 专门 `!` 放行过），
 * `scripts/release/` 是发布脚本。它们的名字与产物目录名重合。误杀一个源码目录，
 * 比漏掉几 MB 产物严重得多——所以 SOURCE_DIR_ALLOWLIST 是**精确路径**而非模式，
 * 新增一条都要有人签名。
 *
 * env 门控 KHY_BUILD_ROOT_GUARD（默认开，仅显式 0/false/off/no 关闭）。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** 仓库唯一产物根。真源 [DESIGN-LAY-004] §4。 */
const BUILD_ROOT = 'entries';

/** 登记表位置。与 RULES-REGISTRY.json 同址，符合 [DESIGN-LAY-002] 对 docs/10_规范/ 的定位。 */
const REGISTRY_REL = 'docs/10_规范/registry/BUILD-OUTPUTS.json';

/** `entries/` 下的深度上限：`entries/<producer>` 或 `entries/<producer>/<variant>`。 */
const MAX_ROOT_DEPTH = 2;

/** 门控判定。纯字符串运算。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_BUILD_ROOT_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

/**
 * 产物目录名签名（高精度，宁窄勿宽）。
 *
 * 只认「构建 / 测试 / 打包工具默认吐东西的地方」。刻意**不含** `src` / `lib` /
 * `assets` / `vendor` 这类源码目录名——`vendor/` 在本仓既有「第三方 vendored 源码」
 * 也有「自打包产物」两种含义，靠名字判会误杀，所以寄生产物走显式登记（DEFAULT_PARASITIC）。
 */
const ARTIFACT_DIR_NAMES = Object.freeze([
  'dist',
  'build',
  'out',
  'release',
  'coverage',
  '.cache',
  '.nyc_output',
  'dist-electron',
  'tmp-cov',
  '.dart_tool',
  'publish',
]);

/** 走盘时整棵跳过的顶层路径：第三方检出、依赖树、git 内部、机器本地工具状态。 */
const SKIP_TOP = Object.freeze([
  'node_modules',
  '.git',
  '.research-tmp',
  '.khy',
  '.khyos',
  '.claude',
  '.commandcode',
  '.zcode',
  '.zcode-tmp',
  '.workbuddy',
  '.workbuddy-ai',
  '.ai',
  '.portable',
]);

/**
 * 目录名恰好叫 `build` / `publish` / `release` 的**源码**目录。
 *
 * 每一条都已人工核实「它是源码不是产物」。新增须附理由：
 *   packaging/build                                 CI 构建脚本，根 .gitignore 专门 `!` 放行
 *   scripts/release, scripts/release/publish         发布脚本
 *   services/backend/src/services/.../build          后端业务模块（domain/build）
 *   services/backend/src/services/.../deploy/publish 后端业务模块
 *   services/backend/vendor, kernel/vendor           构建期镜像的源码副本（[DESIGN-LAY-002] §2）
 */
const SOURCE_DIR_ALLOWLIST = Object.freeze([
  'packaging/build',
  'scripts/release',
  'scripts/release/publish',
  'services/backend/src/services/domain/build',
  'services/backend/src/services/domain/deploy/publish',
  'services/backend/src/services/publish',
  'services/backend/vendor',
  'kernel/vendor',
]);

/**
 * 默认寄生产物清单：`路径 → 它为什么必须在源码树内`。
 *
 * 「寄生」= 工具强制路径或必须被源码树引用的产物，无法重定向进 `entries/`。
 * 本清单只用于**走盘探针**（这些目录名不在 ARTIFACT_DIR_NAMES 里，扫不到）；
 * 权威的 `hook` / `sunset` 以 BUILD-OUTPUTS.json 为准，本清单是它的走盘投影。
 */
const DEFAULT_PARASITIC = Object.freeze({
  'apps/ai-frontend/public/vendor': '必须被 Vite dev server 与 build 直接服务',
  'extensions/tools/khy-markdown/vendor': '必须在拓展包内被 prepack 打进产物',
  'extensions/tools/khy-dsh-compat/vendor': '必须在拓展包内被 prepack 打进产物',
  'docs/19_资产/site/mermaid.min.js': '必须被文档站以相对路径引用',
  'kernel/moonbit/_build': 'moon build 写死路径，不可重定向',
  'tools/deepseek-eyes/deepseek_eyes.egg-info': '机器本地 vendored 检出，不参与 CI',
});

/** 统一成 posix，去掉前缀 `./` 与尾部 `/`。绝不抛。 */
function norm(value) {
  let s = String(value == null ? '' : value).split('\\').join('/').trim();
  while (s.startsWith('./')) s = s.slice(2);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

/** 路径是否位于产物根之下。 */
function isUnderRoot(rel) {
  const p = norm(rel);
  return p === BUILD_ROOT || p.startsWith(BUILD_ROOT + '/');
}

/** `entries/` 下的深度：`entries` = 0，`entries/a` = 1，`entries/a/b` = 2。 */
function rootDepth(rel) {
  const p = norm(rel);
  if (!isUnderRoot(p)) return 0;
  return p.split('/').length - 1;
}

/**
 * 单条路径判定。
 *
 * @param {string} rel        相对仓库根的 posix 路径
 * @param {object} registry   BUILD-OUTPUTS.json 的内容（{meta, outputs}）
 * @param {object} [opts]     { parasitic, today }
 * @returns {Array<{id,severity,path,message}>}
 */
function classifyPath(rel, registry, opts) {
  const p = norm(rel);
  const findings = [];
  if (!p) return findings;

  const parasitic = (opts && opts.parasitic) || DEFAULT_PARASITIC;
  const today = (opts && opts.today) || null;
  const outputs = (registry && registry.outputs) || [];
  const byLegacy = new Map(
    outputs.filter((o) => o.legacyPath).map((o) => [norm(o.legacyPath), o])
  );

  // ① 产物根之下 —— 必须已登记，且深度不得超限。
  if (isUnderRoot(p)) {
    const depth = rootDepth(p);
    if (depth === 0) return findings;
    // 深度超限只报这一条：更深的结构不是本规则的管辖对象，再报 unregistered 只是噪声。
    if (depth > MAX_ROOT_DEPTH) {
      findings.push({
        id: 'depth-exceeded',
        severity: 'warning',
        path: p,
        message:
          `产物根下嵌套 ${depth} 层（上限 ${MAX_ROOT_DEPTH}：${BUILD_ROOT}/<producer>[/<variant>]）` +
          ' —— 深了就等于没收敛。',
      });
      return findings;
    }
    // 登记口径：`entries/<producer>` 与 `entries/<producer>/<variant>` 两者之一被登记即算已登记。
    const registered = outputs.some((o) => {
      const op = norm(o.path);
      return op === p || op.startsWith(p + '/') || p.startsWith(op + '/');
    });
    if (!registered) {
      findings.push({
        id: 'unregistered',
        severity: 'warning',
        path: p,
        message: '落在产物根下但未登记 —— 未登记的产物等于「删了不知道能不能回来」。',
      });
    }
    return findings;
  }

  // ② 寄生产物（工具强制路径）—— 有钩子、有到期日，且不过期。
  if (parasitic[p]) {
    const entry = byLegacy.get(p);
    if (!entry) {
      findings.push({
        id: 'parasitic-unregistered',
        severity: 'error',
        path: p,
        message:
          '寄生产物（工具强制路径）必须显式登记 —— 未登记的寄生等于永久豁免，棘轮无从收紧。',
      });
    } else {
      if (!entry.hook || !String(entry.hook).trim()) {
        findings.push({
          id: 'parasitic-no-hook',
          severity: 'error',
          path: p,
          message: '寄生条目未声明 hook（哪个钩子重建它）—— 删了就回不来，违反 I1。',
        });
      }
      if (!entry.sunset) {
        findings.push({
          id: 'parasitic-no-sunset',
          severity: 'warning',
          path: p,
          message: '寄生条目未设 sunset 到期日 —— 棘轮会失去收紧动力。',
        });
      } else if (today && entry.sunset < today) {
        findings.push({
          id: 'parasitic-expired',
          severity: 'error',
          path: p,
          message: `寄生豁免已于 ${entry.sunset} 到期（今日 ${today}）—— 要么迁移，要么续期并写明理由。`,
        });
      }
    }
    return findings;
  }

  // ③ 已登记的历史遗留路径（迁移中）—— 允许存在，但必须带迁移截止。
  if (byLegacy.has(p)) {
    const entry = byLegacy.get(p);
    if (entry.status === 'migrated') {
      findings.push({
        id: 'legacy-not-removed',
        severity: 'error',
        path: p,
        message: '登记状态已是 migrated，但旧路径仍在磁盘 —— 迁移没做完，或构建又写回了旧位置。',
      });
    } else if (today && entry.sunset && entry.sunset < today) {
      findings.push({
        id: 'legacy-expired',
        severity: 'error',
        path: p,
        message: `历史遗留产物路径已于 ${entry.sunset} 到期仍未迁入 ${BUILD_ROOT}/。`,
      });
    } else {
      findings.push({
        id: 'legacy-path',
        severity: 'warning',
        path: p,
        message: `仍落在源码树内（应迁入 ${BUILD_ROOT}/），登记为迁移中。`,
      });
    }
    return findings;
  }

  // ④ 源码树内的产物目录，且既非寄生也非登记遗留 —— 违规。
  if (SOURCE_DIR_ALLOWLIST.includes(p)) return findings;
  const base = p.slice(p.lastIndexOf('/') + 1);
  if (ARTIFACT_DIR_NAMES.includes(base) || /\.egg-info$/.test(base)) {
    findings.push({
      id: 'outside-root',
      severity: 'error',
      path: p,
      message:
        `构建产物落在 ${BUILD_ROOT}/ 之外（违反 I2 零越界）—— ` +
        '散落的产物是「找不到、删不掉、重建不了」的根源。',
    });
  }
  return findings;
}

/** 批量判定。任何非字符串条目跳过而不抛——门禁绝不因一条脏输入中断整次检查。 */
function inspect(paths, registry, opts) {
  const list = Array.isArray(paths) ? paths : [];
  const findings = [];
  let checked = 0;
  for (const item of list) {
    if (typeof item !== 'string' || !item) continue;
    checked++;
    findings.push(...classifyPath(item, registry, opts));
  }
  return { checked, findings };
}

/**
 * 登记表自身完整性（I1 + I3 的棘轮）。与磁盘无关，纯数据判定。
 *
 * 这条判据是整套设计的支点：**没有 rebuild 命令就不许登记**。写不出
 * 「怎么把它变回来」的东西，删掉就是永久损失，那它就不该被当成产物。
 */
function inspectRegistry(registry) {
  const findings = [];
  let parasiticCount = 0;

  if (!registry || !Array.isArray(registry.outputs)) {
    findings.push({
      id: 'registry-missing',
      severity: 'error',
      path: REGISTRY_REL,
      message: '登记表不存在或结构非法（须为 {meta, outputs:[...]}）。',
    });
    return { findings, parasiticCount };
  }

  const outputs = registry.outputs;
  const seen = new Set();

  for (const [i, o] of outputs.entries()) {
    const where = `${REGISTRY_REL}#outputs[${i}]`;
    if (!o || typeof o !== 'object') {
      findings.push({ id: 'entry-not-object', severity: 'error', path: where, message: '条目不是对象。' });
      continue;
    }
    const id = norm(o.id);
    if (!id) {
      findings.push({ id: 'entry-no-id', severity: 'error', path: where, message: '缺 id。' });
    } else if (seen.has(id)) {
      findings.push({ id: 'entry-duplicate-id', severity: 'error', path: where, message: `id 重复：${id}` });
    } else {
      seen.add(id);
    }

    const outPath = norm(o.path) || where;
    if (!norm(o.path)) {
      findings.push({ id: 'entry-no-path', severity: 'error', path: where, message: '缺 path。' });
    }

    // I1：可删除性的唯一硬判据。
    if (!o.rebuild || !String(o.rebuild).trim()) {
      findings.push({
        id: 'missing-rebuild',
        severity: 'error',
        path: outPath,
        message:
          '缺 rebuild（一条能把它变回来的命令）—— 不可重建的东西不允许进入产物根（违反 I1）。',
      });
    }

    if (o.parasitic) {
      parasiticCount++;
      if (isUnderRoot(outPath)) {
        findings.push({
          id: 'parasitic-in-root',
          severity: 'warning',
          path: outPath,
          message: '标了 parasitic 却已经在产物根下 —— 标记该撤了，棘轮应收紧。',
        });
      }
    } else if (!isUnderRoot(outPath)) {
      findings.push({
        id: 'entry-outside-root',
        severity: 'error',
        path: outPath,
        message: `正式条目不在 ${BUILD_ROOT}/ 之下 —— 非寄生条目必须落产物根。`,
      });
    }

    if (o.legacyPath && !o.parasitic && o.status !== 'migrating') {
      findings.push({
        id: 'legacy-without-status',
        severity: 'warning',
        path: outPath,
        message: '声明了 legacyPath 但 status 不是 migrating —— 迁移状态不明，棘轮无从判定。',
      });
    }

    // 「随时能删」要求一条命令全量重建，漏一条就不成立。
    if (o.inBuildAll !== true && !o.parasitic) {
      findings.push({
        id: 'not-in-build-all',
        severity: 'error',
        path: outPath,
        message: '未被 build:all 覆盖 —— 「随时能删」要求一条命令全量重建，漏一条就不成立（违反 I1）。',
      });
    }
  }

  const budget = registry.meta && registry.meta.parasiticBudget;
  if (typeof budget === 'number' && parasiticCount > budget) {
    findings.push({
      id: 'parasitic-budget-exceeded',
      severity: 'error',
      path: REGISTRY_REL,
      message: `寄生条目 ${parasiticCount} 条 > 预算 ${budget} 条 —— 棘轮只降不升（违反 I3）。`,
    });
  }
  return { findings, parasiticCount };
}

/** 文本呈现。纯字符串拼接，供 CLI 直接打印。 */
function render(result, label) {
  const lines = [];
  const findings = (result && result.findings) || [];
  const errors = findings.filter((f) => f.severity === 'error');
  const warnings = findings.filter((f) => f.severity === 'warning');
  if (label) lines.push(`── ${label}`);
  if (findings.length === 0) lines.push('  ✓ 无 finding');
  for (const f of errors) {
    lines.push(`  [ERROR] ${String(f.id).padEnd(24)} ${f.path}`);
    lines.push(`            ${f.message}`);
  }
  for (const f of warnings) {
    lines.push(`  [WARN ] ${String(f.id).padEnd(24)} ${f.path}`);
    lines.push(`            ${f.message}`);
  }
  lines.push(`  Summary: ${errors.length} error(s), ${warnings.length} warning(s).`);
  return lines.join('\n');
}

/** 汇总计数，供 CLI 决定退出码。 */
function summarize(findings) {
  const list = Array.isArray(findings) ? findings : [];
  return {
    errors: list.filter((f) => f.severity === 'error').length,
    warnings: list.filter((f) => f.severity === 'warning').length,
  };
}

module.exports = {
  BUILD_ROOT,
  REGISTRY_REL,
  MAX_ROOT_DEPTH,
  ARTIFACT_DIR_NAMES,
  SKIP_TOP,
  SOURCE_DIR_ALLOWLIST,
  DEFAULT_PARASITIC,
  isEnabled,
  norm,
  isUnderRoot,
  rootDepth,
  classifyPath,
  inspect,
  inspectRegistry,
  render,
  summarize,
};
