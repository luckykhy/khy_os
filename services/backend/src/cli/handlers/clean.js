'use strict';

/**
 * clean.js — 分级清理：构建产物 / 可重装依赖 / 运行时状态
 *
 * 为什么要有这条命令：实测这棵工作树 1481.5 MB / 107,556 个文件，而 git 真正跟踪
 * 的只有 7,543 个文件、打包 29.1 MB。也就是说 98% 是依赖、构建产物和运行时状态，
 * 全都可以重建。手工 rm 的问题在于「删错了没法还」，所以这里三条纪律：
 *
 *   1. 默认只预览。不给 --yes 就只打印「删什么、回收多少」，一个字节都不动。
 *   2. 每一项都必须带重建命令。清单里没有重建命令的目标不许进注册表 ——
 *      「删了装不回来」不叫清理，叫丢数据。
 *   3. 不可重建的历史不进任何默认档。--all 只覆盖 build + deps；运行时那一档要
 *      显式 --runtime；而 .khy/checkpoints（实测 49.7 MB 的工作区快照，即未提交
 *      的代码改动）连 --runtime 都碰不到，需要 --checkpoints 单独点名，并且每次
 *      都把这条豁免打印出来。
 *
 * 与 scripts/ci/check-build-artifacts.js 的分工：那个守卫拦「产物被提交进 git」，
 * 这条命令清「产物躺在工作树里占地方」，两者互不重叠。
 *
 * @module handlers/clean
 */

// ── Imports ──

const fs = require('fs');
const path = require('path');

const chalk = require('chalk').default || require('chalk');

// 拓展侧的产物按**服务名**解析而不是按拓展 id 点名：[DESIGN-ARCH-069] §1.3 第四条。
const { findProvider } = require('../../services/extensions/extensionRoots');
const dh = require('../../utils/dataHome');
const { printInfo, printError, printSuccess, printWarn } = require('../formatters');

// 复用 storage.js 已有的两个纯函数（递归统计 + 字节格式化走 ccFormat 单一真源），
// 不再抄一遍：同一个域里两份口径不一致的体积数字，比没有数字更坏。
const { _dirStats, _fmtBytes } = require('./storage');

// ── 常量与注册表 ──

/** 仓库根。handlers → cli → src → backend → services → root，共五层。 */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');

const TIERS = ['build', 'deps', 'tools', 'runtime'];

/** markdown 工作台的**服务名**。核说要哪个服务，不说要哪个拓展。 */
const MARKDOWN_WORKBENCH_SERVICE = 'markdown-workbench';

/** 依赖发现时不该下钻的目录名：生成物与外部环境，进去只会拖慢扫描。 */
const SCAN_SKIP = new Set([
  '.git', 'node_modules', 'dist', 'build', '.gradle', '.venv', 'coverage', '__pycache__', '.khy',
]);

/**
 * 构建产物注册表。rel 相对仓库根；rebuild 是被删之后照此原样恢复的命令。
 *
 * 刻意逐条列出而不是按通配符扫 dist/build：packaging/npm 下只有 bundled/ 是产物，
 * package.json 和 scripts/ 是被跟踪的源码，通配符会连它们一起端走。
 */
const BUILD_TARGETS = [
  {
    rel: 'dist/modules',
    why: 'esbuild 六个模块 bundle 的公共输出目录',
    rebuild: 'node packaging/build/esbuild-modules.js --prod',
  },
  {
    rel: 'dist/debug-symbols',
    why: '生产构建显式导出的 source map 留档',
    rebuild: 'node packaging/build/esbuild-modules.js --prod --debug-symbols',
  },
  {
    rel: 'build',
    why: 'setuptools 的中间目录（bdist / lib）',
    rebuild: 'python -m build',
  },
  {
    rel: 'platform/khy_platform/bundled',
    why: 'wheel 里的生产 bundle 组装结果',
    rebuild: 'node scripts/release/assemble-pip-runtime.js',
  },
  {
    rel: 'packaging/npm/bundled',
    why: 'npm 包的生产 bundle 组装结果',
    rebuild: 'npm run assemble --prefix packaging/npm',
  },
  {
    rel: 'apps/ai-frontend/dist',
    why: 'AI 管理前端的 Vite 产物',
    rebuild: 'npm run build --prefix apps/ai-frontend',
  },
  {
    rel: 'software/khyquant/frontend/dist',
    why: 'khyquant 前端的 Vite 产物',
    rebuild: 'npm run build --prefix software/khyquant/frontend',
  },
  {
    rel: 'docs/_assets/mermaid.min.js',
    why: '文档站离线 Mermaid 引擎（README 明写不跟踪、按需重建）',
    rebuild: 'npm run docs:mermaid',
  },
  {
    rel: 'apps/khy-mobile/android/build',
    why: 'Gradle 顶层构建目录',
    rebuild: 'cd apps/khy-mobile/android 后 gradlew assembleDebug',
  },
  {
    rel: 'apps/khy-mobile/android/app/build',
    why: 'Gradle app 模块构建目录（含 APK / 中间产物）',
    rebuild: 'cd apps/khy-mobile/android 后 gradlew assembleDebug',
  },
  {
    rel: 'apps/khy-mobile/android/.gradle',
    why: 'Gradle 本地缓存',
    rebuild: '下一次 gradlew 构建自动重建',
  },
  {
    rel: 'services/backend/coverage',
    why: 'jest 覆盖率报告',
    rebuild: 'npm run test:backend -- --coverage',
  },
];

/**
 * 打包产物（.whl / .tar.gz）。单独一组是因为它们是**发布凭据**：清掉不影响开发，
 * 但正在验签或准备上传时清掉就得重跑一遍完整发布构建，所以重建命令写全。
 */
const BUILD_GLOBS = [
  {
    dir: 'dist',
    match: /\.(whl|tar\.gz)$/,
    why: 'pip sdist / wheel 发布包',
    rebuild: 'bash scripts/release/build-and-audit-pip-purity.sh',
  },
];

/**
 * 运行时状态白名单。**只列日志、审计、缓存、临时目录**。
 *
 * 刻意用白名单而不是「.khy 下除了几个例外都清」：.khy 里还躺着 api_keys.json、
 * credentials/、permissions.json、memory/、sessions/、conversations/、receipts/、
 * goals/ 等八十多份配置与用户状态。黑名单模式下漏写一条就等于删掉用户的凭据，
 * 而白名单漏写一条只是少回收几 MB。两种漏法的代价差着量级。
 */
const TOOLS_TARGETS = [{ rel: 'tools/deepseek-eyes/.venv', why: 'DeepSeek Eyes 独立 Python 工具环境（可选）', rebuild: 'python -m venv tools/deepseek-eyes/.venv 后 pip install -e tools/deepseek-eyes' }];

const RUNTIME_TARGETS = [
  { rel: 'logs', why: '运行日志', rebuild: '下一次运行自动重建' },
  {
    rel: 'audit',
    why: '审计日志分片与归档',
    rebuild: '下一次运行自动重建；过期分片的 gz 归档一并删除，历史审计记录不可恢复',
  },
  { rel: 'tmp', why: '临时文件', rebuild: '下一次运行自动重建' },
  { rel: 'cache', why: '运行时缓存', rebuild: '下一次运行自动重建' },
  { rel: 'break-cache', why: '中断恢复缓存', rebuild: '下一次运行自动重建' },
  { rel: 'change-watch', why: '变更监视快照', rebuild: '下一次运行自动重建' },
];

/**
 * 工作区快照：连 --runtime 都不碰，需要 --checkpoints 显式点名。
 *
 * 实测 checkpoints 单目录 49.7 MB，里面是 workspace/checkpointService.js 存的
 * 工作区快照 —— git diff 补丁（.patch）与非 git 目录的 tar.gz。也就是**未提交的
 * 代码改动**，删掉就再也拿不回来了。对话存档在隔壁 .khy/sessions（实测 1.5 MB），
 * 同样不在任何默认档内。「顺手清出来的几十 MB」换「用户找不回上周那些改动」，
 * 这笔账不划算。
 *
 * 另外 .khy/audit-trajectory 也故意不在本文件的任何白名单里：那条通道是外部质检
 * 要逐行解析的审计记录，契约规定不压缩不裁剪，删除它必须是用户自己的显式动作。
 */
const CHECKPOINT_TARGET = {
  rel: 'checkpoints',
  why: '工作区快照（未提交改动的 git diff / tar.gz）',
  rebuild: '无法重建：删掉即永久丢失这些未提交的改动',
};

// ── 纯发现与规划（不写任何东西，--dry-run 与单测都走这条路） ──

/** 把绝对路径转成相对仓库根的 posix 形式，只用于显示。 */
function _rel(root, abs) {
  const r = path.relative(root, abs);
  return (r || '.').split(path.sep).join('/');
}

/**
 * 安全闸门：待删目标必须落在仓库根或数据家之内，且不能等于它们本身。
 *
 * 注册表是手写的常量，理论上不会越界；但 rm -rf 的错误代价是不可逆的，
 * 所以这道校验对每一条目标都跑，包括常量。
 */
function _withinRoots(abs, roots) {
  const target = path.resolve(abs);
  return roots.some((root) => {
    const base = path.resolve(root);
    if (target === base) {
      return false;
    }
    return target.startsWith(base + path.sep);
  });
}

/** 单个目标的体积。目录走递归统计，单文件直接取 size；不存在返回 null。 */
function _measure(abs, fsImpl = fs) {
  let st;
  try {
    st = fsImpl.lstatSync(abs);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) {
    return null; // 符号链接不清：删的是链接还是目标，语义不清就不动
  }
  if (st.isDirectory()) {
    return _dirStats(abs, fsImpl);
  }
  return { bytes: st.size, files: 1 };
}

// ── 拓展侧的产物：按服务名解析 ──

/**
 * markdown 工作台拓展在仓库里的相对目录，按**服务名**解析。
 *
 * 为什么不直接写 `extensions/tools/khy-markdown`：[DESIGN-ARCH-069] §1.3 第四条禁止
 * 核代码出现拓展 id 的分支 —— 拓展可以改名、可以被第三方实现顶替、可以挪进另一个分类
 * 目录，而这条命令要问的只是「那个提供 markdown-workbench 的东西，产物在哪」。于是
 * 换实现、改目录名，这里一行都不用动。
 *
 * 解析不到、或者解析到仓库外（用户装在数据家的那一份）都返回 null：这两种情况下仓库
 * 里本来就没有它的 vendor/ 和 muya-embed/ 可清，少报一项是正确结果，不是错误。
 *
 * @param {string} root 仓库根绝对路径
 * @returns {string|null} 形如 'extensions/tools/khy-markdown' 的仓库相对路径
 */
function _markdownWorkbenchRel(root) {
  let ext;
  try {
    ext = findProvider(MARKDOWN_WORKBENCH_SERVICE);
  } catch {
    return null; // 发现器是只读探测；它出问题不该让整条清理命令失败
  }
  if (!ext || !ext.dir) {
    return null;
  }
  const rel = path.relative(root, ext.dir).split(path.sep).join('/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/**
 * 拓展贡献的构建产物。目前只有 markdown 工作台的 muya 自打包产物一项（约 11 MB）。
 *
 * @param {string} [root] 仓库根
 * @returns {Array<{rel:string, why:string, rebuild:string}>}
 */
function _extensionBuildTargets(root = REPO_ROOT) {
  const rel = _markdownWorkbenchRel(root);
  if (!rel) {
    return [];
  }
  return [
    {
      rel: rel + '/vendor',
      why: 'muya 编辑器自打包产物（README 明写不跟踪、按需重建）',
      rebuild: 'node ' + rel + '/muya-embed/ensure-vendor.mjs',
    },
  ];
}

/**
 * 拓展贡献的依赖树重建命令覆盖项，与 _extensionBuildTargets 同源同解析。
 *
 * muya-embed 那棵树实测 181 MB，产出物只有 11 MB，`pnpm install` 装不回来 ——
 * 它有自己的 package-lock.json，只能由 ensure-vendor.mjs 重装并重建。
 *
 * @param {string} [root] 仓库根
 * @returns {Array<{matches:function, rebuild:string}>}
 */
function _extensionDepsOverrides(root = REPO_ROOT) {
  const rel = _markdownWorkbenchRel(root);
  if (!rel) {
    return [];
  }
  // 用整串相等而不是拼正则：仓库相对路径里可能有正则元字符（分类目录带点号之类），
  // 拼正则就得先转义，转义本身又是一处可能出错的地方。这里要判定的只是「就是这一棵树」。
  const target = rel + '/muya-embed/node_modules';
  return [
    {
      matches: (candidate) => candidate === target,
      rebuild: 'node ' + rel + '/muya-embed/ensure-vendor.mjs',
    },
  ];
}

/**
 * 依赖树需要特别对待的几处：不是 `pnpm install` 能装回来的。
 *
 * 这张表只放**横切层**的路径（scripts/ 下的嵌入式工具链）。拓展目录里的那些不写死在
 * 这儿，走 _extensionDepsOverrides() 按服务名解析 —— 理由同 _markdownWorkbenchRel。
 */
const DEPS_REBUILD_OVERRIDES = [
  {
    matches: (rel) => rel === 'scripts/docs/mermaid-embed/node_modules',
    rebuild: 'npm run docs:mermaid',
  },
];

/**
 * 依赖树的重建命令。默认走仓库声明的包管理器，特殊几处按覆盖表处理。
 *
 * @param {string} rel 仓库相对路径
 * @param {Array<{matches:function, rebuild:string}>} [overrides] 覆盖表（便于单测注入）
 */
function _depsRebuild(rel, overrides) {
  const table = overrides || DEPS_REBUILD_OVERRIDES.concat(_extensionDepsOverrides());
  const hit = table.find((o) => o.matches(rel));
  if (hit) {
    return hit.rebuild;
  }
  if (rel.endsWith('.venv')) {
    const dir = rel.slice(0, -'/.venv'.length);
    return 'python -m venv ' + rel + ' 后 pip install -e ' + dir;
  }
  return 'pnpm install（在仓库根执行，一次装回全部 workspace）';
}

/**
 * 发现可重装的依赖树：全部 node_modules 顶层目录 + 全部 .venv。
 *
 * 走真实遍历而不是维护一张候选路径表 —— 表跟不上目录改名就静默漏报，实测这个坑
 * 已经踩过一次：storage-baseline 的旧候选表里还写着改名前的 muya 路径，182 MB
 * 一直没被统计到。清理命令漏报的后果同样严重（用户以为清干净了）。
 *
 * @returns {Array<{rel:string, abs:string, kind:string}>}
 */
function _discoverDeps(root, fsImpl = fs) {
  const found = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fsImpl.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) {
        continue;
      }
      const abs = path.join(cur, e.name);
      if (e.name === 'node_modules' || (e.name === '.venv' && _rel(root, abs) !== 'tools/deepseek-eyes/.venv')) {
        found.push({ rel: _rel(root, abs), abs, kind: e.name });
        continue; // 整棵计入，不再下钻（嵌套的字节已算在父树里）
      }
      if (SCAN_SKIP.has(e.name)) {
        continue;
      }
      stack.push(abs);
    }
  }
  return found.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * 组装清理计划。纯函数：只读磁盘量体积，不删不写，供 --dry-run 与单测直接调用。
 *
 * @param {object} opts
 * @param {string[]} opts.tiers          要清的档位，取值 build|deps|runtime
 * @param {boolean} [opts.checkpoints]   是否连工作区快照一起清（必须显式点名）
 * @param {string}  [opts.root]          仓库根（测试注入）
 * @param {string}  [opts.dataHome]      数据家（测试注入）
 * @param {object}  [opts.fsImpl]        fs 注入
 * @returns {{ok:boolean, tiers:string[], items:Array, held:Array, missing:number,
 *            totalBytes:number, totalFiles:number, warnings:string[], message:string}}
 */
function buildCleanPlan(opts = {}) {
  const fsImpl = opts.fsImpl || fs;
  const root = opts.root || REPO_ROOT;
  let dataHome = opts.dataHome;
  if (!dataHome) {
    try {
      dataHome = dh.getProjectDataHome();
    } catch {
      dataHome = path.join(root, '.khy');
    }
  }
  const tiers = (Array.isArray(opts.tiers) ? opts.tiers : []).filter((t) => TIERS.includes(t));
  const roots = [root, dataHome];
  const items = [];
  const held = [];
  const warnings = [];
  let missing = 0;

  const push = (tier, abs, rel, why, rebuild) => {
    if (!_withinRoots(abs, roots)) {
      warnings.push('跳过 ' + rel + '：不在仓库根或数据家之内，拒绝删除');
      return;
    }
    const stats = _measure(abs, fsImpl);
    if (!stats) {
      missing += 1;
      return;
    }
    items.push({ tier, rel, abs, bytes: stats.bytes, files: stats.files, why, rebuild });
  };

  if (tiers.includes('build')) {
    for (const t of BUILD_TARGETS.concat(_extensionBuildTargets(root))) {
      push('build', path.join(root, t.rel), t.rel, t.why, t.rebuild);
    }
    for (const g of BUILD_GLOBS) {
      const dir = path.join(root, g.dir);
      let names = [];
      try {
        names = fsImpl.readdirSync(dir);
      } catch {
        names = [];
      }
      for (const name of names.filter((n) => g.match.test(n)).sort()) {
        push('build', path.join(dir, name), g.dir + '/' + name, g.why, g.rebuild);
      }
    }
  }

  if (tiers.includes('deps')) {
    for (const d of _discoverDeps(root, fsImpl)) {
      const label = d.kind === '.venv' ? 'Python 虚拟环境' : 'Node 依赖树';
      push('deps', d.abs, d.rel, label, _depsRebuild(d.rel));
    }
  }

  if (tiers.includes('tools')) {
    for (const t of TOOLS_TARGETS) {
      push('tools', path.join(root, t.rel), t.rel, t.why, t.rebuild);
    }
  }

  if (tiers.includes('runtime')) {
    for (const t of RUNTIME_TARGETS) {
      push('runtime', path.join(dataHome, t.rel), '.khy/' + t.rel, t.why, t.rebuild);
    }
    // 会话存档单独处理：不点名就只报「保留了多少」，让用户知道这块没被碰。
    const cpAbs = path.join(dataHome, CHECKPOINT_TARGET.rel);
    if (opts.checkpoints) {
      let checkpointPlan;
      try {
        checkpointPlan = require('../../services/cleanupService').planCheckpointStorage(opts.checkpointMaxMb, { root: dataHome });
      } catch (error) {
        warnings.push('检查点保留规划失败：' + error.message);
      }
      if (checkpointPlan && checkpointPlan.selected && checkpointPlan.selected.length > 0) {
        const bytes = checkpointPlan.selected.reduce((sum, item) => sum + item.bytes, 0);
        items.push({ tier: 'runtime', rel: '.khy/checkpoints', abs: cpAbs, bytes, files: checkpointPlan.selected.length, why: '检查点配额保留：全局按时间从旧到新回收', rebuild: CHECKPOINT_TARGET.rebuild, checkpointPlan });
      }
      if (checkpointPlan && checkpointPlan.held) {
        held.push(...checkpointPlan.held.map((item) => ({ rel: '.khy/checkpoints/' + item.rel, bytes: item.bytes, files: 0, reason: item.reason })));
      }
    } else {
      const stats = _measure(cpAbs, fsImpl);
      if (stats) held.push({ rel: '.khy/checkpoints', bytes: stats.bytes, files: stats.files, reason: '工作区快照（未提交的改动），--runtime 不清；确实要清用 khy clean --runtime --checkpoints' });
    }
  }

  items.sort((a, b) => b.bytes - a.bytes);
  const totalBytes = items.reduce((s, i) => s + i.bytes, 0);
  const totalFiles = items.reduce((s, i) => s + i.files, 0);

  return {
    ok: items.length > 0,
    tiers,
    items,
    held,
    missing,
    totalBytes,
    totalFiles,
    warnings,
    message:
      items.length === 0
        ? tiers.length === 0
          ? '没有选择任何档位（--build / --deps / --runtime / --all）'
          : '这些档位下没有找到可清理的目标，工作树已经是干净的'
        : '待清理 ' + items.length + ' 项，共 ' + totalBytes + ' 字节',
  };
}

/**
 * 执行删除。逐项独立 try/catch：一项删不掉（Windows 上常见的文件占用）不该
 * 让后面几十项全部放弃，而且要如实报出哪一项失败。
 *
 * @param {object} plan buildCleanPlan 的返回值
 * @param {object} [deps] { fsImpl }
 */
function executeClean(plan, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  const removed = [];
  const failed = [];
  for (const it of plan.items) {
    try {
      if (it.checkpointPlan) {
        const result = require('../../services/cleanupService').executeCheckpointPlan(it.checkpointPlan);
        removed.push({ ...it, bytes: result.reclaimedBytes, files: result.removed });
      } else {
        fsImpl.rmSync(it.abs, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed.push(it);
      }
    } catch (e) {
      failed.push({ ...it, error: e.message });
    }
  }
  const reclaimedBytes = removed.reduce((s, i) => s + i.bytes, 0);
  const reclaimedFiles = removed.reduce((s, i) => s + i.files, 0);
  return {
    ok: failed.length === 0,
    removed,
    failed,
    reclaimedBytes,
    reclaimedFiles,
  };
}

// ── 渲染 ──

/** 一档的表格。每行都带重建命令 —— 「删了装不回来」不叫清理。 */
function _printTier(tier, items, label) {
  const rows = items.filter((i) => i.tier === tier);
  if (rows.length === 0) {
    return 0;
  }
  const bytes = rows.reduce((s, i) => s + i.bytes, 0);
  console.log('');
  console.log(chalk.bold('  [' + tier + '] ' + label + '  ' + _fmtBytes(bytes) + ' / ' + rows.reduce((s, i) => s + i.files, 0) + ' 文件'));
  for (const r of rows) {
    console.log('    ' + r.rel + '  ' + chalk.yellow(_fmtBytes(r.bytes)) + ' / ' + r.files + ' 文件');
    console.log(chalk.dim('      ' + r.why + '；重建：' + r.rebuild));
  }
  return bytes;
}

/** 打印计划全文。返回 true 表示有东西可清。 */
function _printPlan(plan, opts = {}) {
  const verb = opts.preview ? '预览' : '清理';
  printInfo(
    '扫描' + verb + '目标：' + (plan.tiers.join(' + ') || '未选档位') + '，命中 ' + plan.items.length + ' 项，共 ' + _fmtBytes(plan.totalBytes)
  );
  _printTier('build', plan.items, '构建产物');
  _printTier('deps', plan.items, '可重装依赖');
  _printTier('tools', plan.items, '可选工具环境');
  _printTier('runtime', plan.items, '运行时状态');

  if (plan.held.length > 0) {
    console.log('');
    for (const h of plan.held) {
      printWarn('保留 ' + h.rel + '：' + _fmtBytes(h.bytes) + ' / ' + h.files + ' 文件 —— ' + h.reason);
    }
  }
  for (const w of plan.warnings) {
    console.log(chalk.dim('  · ' + w));
  }
  if (plan.missing > 0) {
    console.log(chalk.dim('  · 另有 ' + plan.missing + ' 个注册目标当前不存在，已跳过'));
  }
  console.log('');
  return plan.items.length > 0;
}

/** 不带档位时的只读清点：三档全扫一遍，只报数字不删。 */
function _printInventory() {
  const plan = buildCleanPlan({ tiers: TIERS });
  printInfo('清点可回收空间：build / deps / runtime 三档全扫，本次不删除任何文件');
  _printTier('build', plan.items, '构建产物');
  _printTier('deps', plan.items, '可重装依赖');
  _printTier('runtime', plan.items, '运行时状态');
  for (const h of plan.held) {
    printWarn('保留 ' + h.rel + '：' + _fmtBytes(h.bytes) + ' / ' + h.files + ' 文件 —— ' + h.reason);
  }
  console.log('');
  printInfo('合计可回收 ' + _fmtBytes(plan.totalBytes) + ' / ' + plan.totalFiles + ' 文件');
  console.log(chalk.dim('  选档位开始清理：khy clean --build / --deps / --tools / --runtime / --all'));
  console.log(chalk.dim('  --all 只含 build + deps；运行时状态永远要显式 --runtime'));
}

function _printHelp() {
  printInfo('khy clean — 分级清理构建产物、依赖与运行时状态');
  console.log('  clean                               只清点不删除，列出三档各能回收多少');
  console.log('  clean --build                       清构建产物（dist、build、各处 bundle 与前端产物）');
  console.log('  clean --deps                        清可重装依赖（全部 node_modules 与 .venv）');
  console.log('  clean --tools                       清可选工具环境（仅登记的独立环境）');
  console.log('  clean --runtime                     清运行时状态（日志、审计、缓存、临时目录）');
  console.log('  clean --all                         等于 --build --deps（刻意不含 runtime）');
  console.log('    --dry-run                         只预览，即使带了 --yes 也不删');
  console.log('    --yes                             跳过交互确认，直接删除');
  console.log('    --checkpoints                     连 .khy/checkpoints 工作区快照一起清（危险）');
  console.log(
    chalk.dim('  每一项都打印重建命令；会话历史不在任何默认档内，必须显式点名才会被删。')
  );
}

// ── 命令入口 ──

/** 从 options 解出要清的档位。--all 刻意只含 build + deps。 */
function resolveTiers(options = {}) {
  const on = (k) => options[k] === true || options[k] === 'true';
  const tiers = [];
  if (on('all') || on('build')) {
    tiers.push('build');
  }
  if (on('all') || on('deps')) {
    tiers.push('deps');
  }
  if (on('tools')) {
    tiers.push('tools');
  }
  if (on('runtime')) {
    tiers.push('runtime');
  }
  return tiers;
}

async function handleCleanCommand(subCommand, _args = [], options = {}) {
  if (subCommand === 'help' || options.help === true) {
    return _printHelp();
  }

  const tiers = resolveTiers(options);
  if (tiers.length === 0) {
    return _printInventory();
  }

  const dryRun = Boolean(options['dry-run'] || options.dryRun);
  const checkpoints = options.checkpoints === true || options.checkpoints === 'true';
  const capRaw = options['checkpoint-max-mb'];
  const checkpointMaxMb = capRaw === undefined ? undefined : Number(capRaw);
  if (capRaw !== undefined && (!Number.isFinite(checkpointMaxMb) || checkpointMaxMb <= 0)) { printError('--checkpoint-max-mb 必须是大于 0 的数字'); return; }
  const plan = buildCleanPlan({ tiers, checkpoints, checkpointMaxMb });

  if (!_printPlan(plan, { preview: dryRun })) {
    printInfo(plan.message);
    return;
  }

  if (dryRun) {
    printInfo('（--dry-run）仅预览，未删除任何文件。去掉 --dry-run 并加 --yes 才会真删。');
    return;
  }

  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      printError('非交互环境请加 --yes 确认删除');
      return;
    }
    let ok = false;
    try {
      const { promptCompat } = require('../uiPrompt');
      const ans = await promptCompat([
        {
          type: 'confirm',
          name: 'ok',
          default: false,
          message: '确认删除上述 ' + plan.items.length + ' 项、回收 ' + _fmtBytes(plan.totalBytes) + '？',
        },
      ]);
      ok = !!ans.ok;
    } catch {
      ok = false;
    }
    if (!ok) {
      printInfo('已取消，未删除任何文件。');
      return;
    }
  }

  const result = executeClean(plan);
  printSuccess(
    '清理完成：回收 ' + _fmtBytes(result.reclaimedBytes) + ' / ' + result.reclaimedFiles + ' 文件，共 ' + result.removed.length + ' 项'
  );
  if (result.failed.length > 0) {
    printWarn('有 ' + result.failed.length + ' 项未能删除（多半是文件被占用）：');
    for (const f of result.failed) {
      console.log('    ' + f.rel + '：' + f.error);
    }
  }
  printInfo('重建命令（按需执行）：');
  const seen = new Set();
  for (const r of result.removed) {
    if (seen.has(r.rebuild)) {
      continue;
    }
    seen.add(r.rebuild);
    console.log(chalk.dim('    ' + r.rebuild));
  }
}

module.exports = {
  handleCleanCommand,
  buildCleanPlan,
  executeClean,
  resolveTiers,
  // exported for tests
  TIERS,
  BUILD_TARGETS,
  BUILD_GLOBS,
  RUNTIME_TARGETS,
  CHECKPOINT_TARGET,
  _discoverDeps,
  _depsRebuild,
  _markdownWorkbenchRel,
  _extensionBuildTargets,
  _extensionDepsOverrides,
  _withinRoots,
  _measure,
  _rel,
};
