'use strict';

/**
 * diskClean.js — `khy cleandisk`：系统盘（C 盘）大规模清理方法论。
 *
 * 与既有两条清理命令的分工（三者互不重叠）：
 *   · khy clean     — 仓库工作树：构建产物 / 可重装依赖 / 运行时状态（handlers/clean.js）
 *   · khy cleanup   — khy 自身数据保留：日志 / 快照 / 会话（services/cleanupService.js）
 *   · khy cleandisk — 本命令：整块系统盘的垃圾与用户空间大文件（本文件）
 *
 * 方法论三段式：
 *   1. 概览     — 盘容量 + 可用空间，先看清「还能回收多少」。
 *   2. 自动清   — 无需询问直接清公认安全位置：用户 Temp、Windows Temp、更新下载缓存、
 *                浏览器 HTTP 缓存、缩略图 / 崩溃转储、npm/pip/yarn/cargo 缓存、
 *                下载中断的 .crdownload/.part。全部经 diskCleanup 引擎执行：
 *                只清 junkCatalog 白名单 + 两道否决 fail-closed + TOCTOU 重检。
 *                其中 Windows Temp 与更新缓存属引擎 review 档，经 planner.includeIds
 *                精确点名纳入自动档（绝不 blanket includeReview —— 那会把回收站也带进来）。
 *   3. 分组确认 — Downloads / Desktop / AppData\Local 的大文件（默认 ≥50MB）按体积降序
 *                4-5 个一组，逐组显示完整路径 / 大小 / 用途，回答「删除 / 保留」（或输入
 *                序号只删组内几项）。这些是用户数据，引擎刻意保护 —— 删除闸门就是用户
 *                对每一组的显式确认；删除不经回收站，所以在开始前如实告知。
 *
 * @module cli/handlers/diskClean
 */

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chalk = require('chalk').default || require('chalk');

const { printInfo, printError, printSuccess, printWarn } = require('../formatters');
const { formatStatusMessage } = require('../statusMessageFormatter');
const { promptCompat } = require('../uiPrompt');
const { _fmtBytes } = require('./storage');
const diskCleanup = require('../../services/diskCleanup');

// ── 常量 ──────────────────────────────────────────────────────

/**
 * 方法论自动档点名纳入的两个引擎 review 条目：系统 Temp 与更新下载缓存。
 * 经 planner.includeIds 精确点名；回收站等其他 review 项保持默认不清。
 */
const AUTO_REVIEW_IDS = ['win-windows-temp', 'win-update-cache'];

/** 每组条数（方法论：4-5 个一组，默认取 5，--group 可调 1-20）。 */
const GROUP_SIZE_DEFAULT = 5;
const GROUP_SIZE_MAX = 20;

/** 大文件下限 MB（方法论「按大小从大到小」，默认 ≥50MB 才值得打扰用户，--min-mb 可调）。 */
const MIN_MB_DEFAULT = 50;

/**
 * 大文件扫描的墙钟预算。这是有界只读扫描的「部分结果预算」（与 diskAnalyze 同一模式），
 * 不是任务超时：耗尽即返回已收集的最大文件并如实标注 truncated，绝不丢弃已得结果。
 */
const SCAN_BUDGET_MS = 45_000;
const SCAN_MAX_DEPTH = 10;

/** 未完成下载的扩展名（方法论安全表：*.crdownload 可自动清，超过在用窗口才动）。 */
const UNFINISHED_EXTS = new Set(['.crdownload', '.part', '.download']);

/** 扩展名 → 用途说明（方法论第 3 条：每个文件都要带用途）。顺序即优先级。 */
const PURPOSE_TABLE = [
  [/\.(crdownload|part|download)$/i, '未完成的下载（下载中断的临时文件，可安全删）'],
  [/\.(msi|msix|appx|apk|msm)$/i, '安装包（装完即可删，需要时重新下载）'],
  [/\.(zip|rar|7z|tar|gz|bz2|xz|cab)$/i, '压缩包（确认已解压后原始包可删）'],
  [/\.(iso|img|vhd|vhdx|gho)$/i, '磁盘镜像 / 虚拟磁盘（确认不再需要后可删）'],
  [/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i, '视频文件'],
  [/\.(mp3|wav|flac|aac|ogg|m4a)$/i, '音频文件'],
  [/\.(pdf|docx?|pptx?|xlsx?|odt)$/i, '办公文档'],
  [/\.(psd|ai|sketch|xd|fig)$/i, '设计源文件'],
  [/\.(csv|jsonl?|db|sqlite)$/i, '数据文件（删前确认是否还有用）'],
  [/\.(log|tmp|temp|etl)$/i, '日志 / 临时文件'],
  [/\.(dll|sys|inf|cat)$/i, '系统 / 程序组件（建议保留）'],
];

const MB = 1024 * 1024;

/** .exe 文件名带这些特征才判「安装包」（对照 diskAnalyzeCatalog 的安装器命名口径）。 */
const INSTALLER_NAME_HINT_RE =
  /(^|[^a-z])(setup|install(er)?|update|patch|redist|deploy|unpack)([^a-z]|$)/i;

/** 驼峰粘连（OneDriveSetup）会骗过词边界正则；先在 aA 边界插空格再判。 */
function _looksLikeInstaller(basename) {
  const spaced = String(basename || '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return INSTALLER_NAME_HINT_RE.test(spaced);
}

let _storageRoots = null;
function storageRoots() {
  if (!_storageRoots) {
    _storageRoots = require('../../utils/storageRoots');
  }
  return _storageRoots;
}

// ── 纯函数（导出供单测） ──────────────────────────────────────

/** 扩展名 → 一句用途说明；无匹配回退「其他文件」。顺序即优先级。 */
function describeFile(filePath) {
  const s = String(filePath || '');
  // .exe 单独判：名字带 setup/install 等特征才是安装包；否则可能是程序本体
  // （如浏览器内核 chrome.exe），删了会坏装好的应用，措辞必须区分开。
  if (/\.exe$/i.test(s)) {
    return _looksLikeInstaller(path.basename(s))
      ? '安装包（装完即可删，需要时重新下载）'
      : '可执行程序（确认来源与用途后再决定）';
  }
  for (const [re, why] of PURPOSE_TABLE) {
    if (re.test(s)) {
      return why;
    }
  }
  return '其他文件';
}

/** mtimeMs → 「x 天前 / x 小时前 / x 分钟前」。 */
function _ageLabel(mtimeMs, nowMs) {
  const ms = Math.max(0, (nowMs || Date.now()) - (mtimeMs || 0));
  const min = Math.floor(ms / 60000);
  if (min < 1) {
    return '刚刚';
  }
  if (min < 60) {
    return `${min} 分钟前`;
  }
  const h = Math.floor(min / 60);
  if (h < 24) {
    return `${h} 小时前`;
  }
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 把一组的用户输入解析成删除决策。
 *   '' / n / 保留        → none   （本组全保留）
 *   y / 删除             → all    （本组全删）
 *   序号列表如 "1,3"     → subset （只删对应项，1-based）
 *   q / 退出             → quit   （停止询问，剩余组全部保留）
 *   其他                 → unknown（提示后重新询问）
 * @param {string} raw 用户输入
 * @param {number} count 组内条数
 */
function parseGroupAnswer(raw, count) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s || ['n', 'no', 'keep', 'skip', '保留', '跳过', '全留'].includes(s)) {
    return { mode: 'none' };
  }
  if (['q', 'quit', 'exit', 'stop', '退出', '结束', '停止'].includes(s)) {
    return { mode: 'quit' };
  }
  if (['y', 'yes', 'del', 'delete', 'all', '删除', '全删', '全部删除', '都删'].includes(s)) {
    return { mode: 'all' };
  }
  const indexes = [
    ...new Set(
      s
        .split(/[,，、\s]+/)
        .map((t) => parseInt(t, 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= count)
    ),
  ];
  if (indexes.length > 0) {
    return { mode: 'subset', indexes };
  }
  return { mode: 'unknown' };
}

/** 把有序列表切成 N 个一组（末组可不足）。 */
function chunkGroups(items, size) {
  const n = Math.max(1, Math.floor(size) || GROUP_SIZE_DEFAULT);
  const out = [];
  for (let i = 0; i < items.length; i += n) {
    out.push(items.slice(i, i + n));
  }
  return out;
}

/**
 * 有界遍历收集 ≥minBytes 的大文件（含每个文件的大小与修改时间）。
 *
 * 墙钟预算耗尽即停并返回 truncated:true（部分结果，如实上报）——这是扫描预算而非
 * 任务超时：已收集的文件全部保留，绝不静默丢弃。不跟随符号链接；fail-soft 逐项跳过。
 *
 * @param {string[]} roots 要扫描的绝对目录
 * @param {number} minBytes 文件下限（字节）
 * @param {object} [deps] {fsImpl, now}
 * @param {number} [budgetMs]
 * @returns {{files:Array<{path,sizeBytes,mtimeMs}>, truncated:boolean, elapsedMs:number}}
 */
function collectLargeFiles(roots, minBytes, deps = {}, budgetMs = SCAN_BUDGET_MS) {
  const fsImpl = deps.fsImpl || fs;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const started = now();
  const files = [];
  let truncated = false;

  for (const root of roots || []) {
    const stack = [{ dir: path.resolve(root), depth: 0 }];
    while (stack.length > 0) {
      // >= 而非 >：预算 0 = 调用方明确要求不扫，立即返回空结果（确定性，不赌时钟同跳）。
      if (now() - started >= budgetMs || files.length >= 400) {
        truncated = true;
        break;
      }
      const { dir, depth } = stack.pop();
      let entries;
      try {
        entries = fsImpl.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isSymbolicLink()) {
          continue; // 链接不跟随，避免越界与环
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth < SCAN_MAX_DEPTH) {
            stack.push({ dir: full, depth: depth + 1 });
          }
          continue;
        }
        if (!e.isFile()) {
          continue;
        }
        let st;
        try {
          st = fsImpl.statSync(full);
        } catch {
          continue;
        }
        if ((st.size || 0) >= minBytes) {
          files.push({ path: full, sizeBytes: st.size || 0, mtimeMs: st.mtimeMs || 0 });
        }
      }
    }
    if (truncated) {
      break;
    }
  }

  files.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return { files, truncated, elapsedMs: now() - started };
}

/**
 * 找「下载中断」的未完成文件（.crdownload 等）。只看目录顶层（下载器都写在下载根），
 * 且文件必须早于 keepRecentHours（默认 2h）——还在下载中的绝不碰。
 */
function findUnfinishedDownloads(dir, deps = {}, keepRecentHours) {
  const fsImpl = deps.fsImpl || fs;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const keepMs = (keepRecentHours != null ? keepRecentHours : 2) * 3600 * 1000;
  const out = [];
  let entries;
  try {
    entries = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (!e.isFile() || e.isSymbolicLink()) {
      continue;
    }
    if (!UNFINISHED_EXTS.has(path.extname(e.name).toLowerCase())) {
      continue;
    }
    const full = path.join(dir, e.name);
    let st;
    try {
      st = fsImpl.statSync(full);
    } catch {
      continue;
    }
    if (now() - (st.mtimeMs || 0) < keepMs) {
      continue;
    }
    out.push({ path: full, sizeBytes: st.size || 0, mtimeMs: st.mtimeMs || 0 });
  }
  return out;
}

/**
 * 删除单个文件（Windows 占用场景：rmSync 自带重试 + platformUtils.retryOnBusyAsync 兜底）。
 * @returns {Promise<number>} 回收字节数；文件已不存在返回 0；删除失败返回 null
 */
async function removeFile(full, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  let size = 0;
  try {
    size = fsImpl.statSync(full).size || 0;
  } catch {
    return 0; // 已经消失 = 目标已达成
  }
  const doRemove = async () => {
    fsImpl.rmSync(full, { force: true, maxRetries: 3, retryDelay: 200 });
  };
  try {
    let platformUtils = null;
    try {
      platformUtils = require('../../tools/platformUtils');
    } catch {
      platformUtils = null;
    }
    if (platformUtils && typeof platformUtils.retryOnBusyAsync === 'function') {
      await platformUtils.retryOnBusyAsync(doRemove);
    } else {
      await doRemove();
    }
    return size;
  } catch {
    return null;
  }
}

/** 解析盘符/目录参数：'C' / 'C:' / 'C:\\' / 绝对目录 → 规范根；非法返回 error。 */
function _resolveRoot(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) {
    return { root: '' };
  }
  if (/^[a-zA-Z]:?[\\/]?$/.test(s)) {
    return { root: s[0].toUpperCase() + ':\\' };
  }
  if (path.isAbsolute(s)) {
    return { root: s };
  }
  return { error: `无法识别的盘符或路径「${s}」；用法示例: cleandisk C: 或 cleandisk D:\\downloads` };
}

/** 默认根 = 系统盘根。SystemDrive 环境变量是 Windows 的单一真源（通常 C:）；
 * storageRoots 在部分环境返回「/」（当前盘语义模糊），只作末位回退。 */
function _defaultRoot(deps) {
  const sys = String((deps.env && deps.env.SystemDrive) || '').trim();
  if (/^[a-zA-Z]:$/.test(sys)) {
    return sys + '\\';
  }
  const homeRoot = path.parse(deps.homedir || os.homedir()).root;
  if (homeRoot) {
    return homeRoot;
  }
  try {
    return storageRoots().getSystemDriveRoot({
      platform: deps.platform,
      env: deps.env,
      homedir: deps.homedir,
    });
  } catch {
    return path.parse(process.cwd()).root;
  }
}

/** 盘容量（statfsSync；Node 不支持或失败返回 null，调用方如实跳过）。 */
function _driveCapacity(rootAbs, deps = {}) {
  const fsImpl = deps.fsImpl || fs;
  try {
    if (typeof fsImpl.statfsSync !== 'function') {
      return null;
    }
    const st = fsImpl.statfsSync(rootAbs);
    return {
      totalBytes: (st.blocks || 0) * (st.bsize || 0),
      freeBytes: (st.bavail || 0) * (st.bsize || 0),
    };
  } catch {
    return null;
  }
}

// ── 渲染 ──────────────────────────────────────────────────────

/** 打印一组的明细：完整路径 + 大小 + 用途 + 修改时间（方法论第 3 条）。 */
function _printGroup(no, totalGroups, group, preview) {
  const bytes = group.reduce((s, f) => s + f.sizeBytes, 0);
  console.log('');
  console.log(
    chalk.bold(
      `  第 ${no}/${totalGroups} 组 · ${group.length} 项 · 共 ${_fmtBytes(bytes)}` +
        (preview ? chalk.dim('（--dry-run 预览，不删除）') : '')
    )
  );
  group.forEach((f, i) => {
    console.log(`    [${i + 1}] ${chalk.yellow(_fmtBytes(f.sizeBytes))}  ${f.path}`);
    console.log(
      chalk.dim(`        ${describeFile(f.path)} · 最后修改 ${_ageLabel(f.mtimeMs)}`)
    );
  });
}

// ── 命令入口 ──────────────────────────────────────────────────

function _printHelp() {
  printInfo('khy cleandisk — 系统盘（C 盘）大规模清理：自动清安全垃圾 + 大文件分组确认');
  console.log('  cleandisk [盘符]                    默认 C:；全流程（概览 → 自动清 → 分组确认）');
  console.log('  cleandisk <绝对目录>                只针对某个大盘目录（如 D:\\downloads）');
  console.log('    --dry-run                         全程只预览，不删任何文件');
  console.log('    --min-mb N                        大文件下限（MB），默认 50');
  console.log('    --group N                         每组条数（1-20），默认 5');
  console.log('    --yes                             非交互环境（脚本/AI 子进程）确认自动档删除；交互终端无需');
  console.log(
    chalk.dim('  第 2 段自动清的是引擎白名单（Temp/浏览器缓存/包管理缓存等），无需询问；')
  );
  console.log(
    chalk.dim('  第 3 段是你的文件（下载/桌面/应用缓存大文件），4-5 个一组逐组确认后才删，不经回收站。')
  );
}

async function handleDiskClean(subCommand, args = [], options = {}) {
  if (subCommand === 'help' || options.help === true) {
    return _printHelp();
  }

  const deps = diskCleanup.catalog.defaultDeps();
  const fsImpl = deps.fsImpl;

  const dryRun = options['dry-run'] === true || options.dryRun === true;
  const interactive = !!(process.stdin.isTTY && process.stdout.isTTY);

  const minMbRaw = options['min-mb'] === undefined ? undefined : Number(options['min-mb']);
  if (minMbRaw !== undefined && (!Number.isFinite(minMbRaw) || minMbRaw <= 0)) {
    printError('--min-mb 必须是大于 0 的数字，例如 --min-mb 100');
    return;
  }
  const minBytes = (minMbRaw === undefined ? MIN_MB_DEFAULT : minMbRaw) * MB;

  const groupRaw = options.group === undefined ? undefined : Number(options.group);
  if (groupRaw !== undefined && (!Number.isFinite(groupRaw) || groupRaw < 1 || groupRaw > GROUP_SIZE_MAX)) {
    printError(`--group 必须是 1-${GROUP_SIZE_MAX} 的数字，例如 --group 4`);
    return;
  }
  const groupSize = groupRaw === undefined ? GROUP_SIZE_DEFAULT : Math.floor(groupRaw);

  const resolved = _resolveRoot(args[0]);
  if (resolved.error) {
    printError(resolved.error);
    return;
  }
  const root = resolved.root || _defaultRoot(deps);

  // ── 阶段 1/3：磁盘概览 ──────────────────────────────────────
  console.log('');
  printInfo(formatStatusMessage('阶段 1/3', '磁盘概览', root));
  const cap = _driveCapacity(root, deps);
  if (cap && cap.totalBytes > 0) {
    const usedPct = Math.round(((cap.totalBytes - cap.freeBytes) / cap.totalBytes) * 100);
    console.log(
      `    容量 ${chalk.bold(_fmtBytes(cap.totalBytes))} · 可用 ${chalk.bold.green(
        _fmtBytes(cap.freeBytes)
      )} · 已用 ${usedPct}%`
    );
  } else {
    console.log(chalk.dim('    （当前 Node 不支持 statfs，跳过容量统计；清理不受影响）'));
  }

  // ── 阶段 2/3：自动清理公认安全位置（方法论：无需询问） ──────
  console.log('');
  printInfo(formatStatusMessage('阶段 2/3', '自动清理安全位置', '引擎白名单 + 两道否决'));
  printInfo(
    formatStatusMessage(
      '扫描',
      '安全清理候选',
      `Temp/浏览器缓存/包管理缓存等（keepRecent=2h${dryRun ? ' · dry-run' : ''}）`
    )
  );
  const scan = diskCleanup.scan({ keepRecentHours: 2 });
  const plan = diskCleanup.planner.buildPlan(scan, {
    includeReview: false,
    includeIds: AUTO_REVIEW_IDS,
  });

  // 自动档里两个系统位置需要管理员写权限；无权限的提前分出来如实告知，不进执行队列。
  const writable = [];
  const needAdmin = [];
  for (const c of plan.selected) {
    if (!AUTO_REVIEW_IDS.includes(c.id)) {
      writable.push(c);
      continue;
    }
    try {
      fsImpl.accessSync(c.path, fsImpl.constants.W_OK);
      writable.push(c);
    } catch {
      needAdmin.push(c);
    }
  }
  plan.selected = writable;

  // 方法论的「无需询问」只在真人交互终端里成立。非交互环境（脚本、被 AI 派生的
  // `khy cleandisk` 子进程）沿 khy clean 的纪律：破坏性操作必须显式 --yes，
  // 否则只出计划不删 —— 没有人在终端盯着时，绝不默默动磁盘。
  const confirmedAuto = interactive || options.yes === true || options.yes === 'true';
  let autoFreed = 0; // 实际回收字节（executor 报告）；预览/未执行保持 0

  if (dryRun || !confirmedAuto) {
    console.log(diskCleanup.renderPlanReport(plan));
    if (dryRun) {
      printInfo('（--dry-run）自动档仅预览，未删除任何文件。');
    } else {
      printWarn('非交互环境：自动档未删除任何文件；确认后加 --yes 重新运行，或在终端交互运行 cleandisk');
    }
  } else {
    const report = await diskCleanup.executor.execute(plan, { apply: true, deps });
    const t = report.totals;
    autoFreed = t.freedBytes;
    printSuccess(
      formatStatusMessage(
        '自动清理完成',
        `${plan.selected.length} 个白名单位置`,
        `回收 ${t.freedHuman} / ${t.removedItems} 项`
      )
    );
    for (const item of report.items.slice(0, 15)) {
      const mark =
        item.status === 'cleaned'
          ? chalk.green('✓')
          : item.status === 'partial'
            ? chalk.yellow('◐')
            : item.status === 'vetoed'
              ? chalk.red('✗')
              : chalk.dim('·');
      console.log(`    ${mark} ${item.label}  ${chalk.dim(_fmtBytes(item.freedBytes))}`);
    }
    if (report.items.length > 15) {
      console.log(chalk.dim(`    … 另有 ${report.items.length - 15} 项已处理`));
    }
    if (t.failureCount > 0) {
      printWarn(
        `${t.failureCount} 个文件删除失败（多半被占用或需管理员）：关闭占用程序后重跑 cleandisk 即可重试`
      );
    }
  }
  if (needAdmin.length > 0) {
    for (const c of needAdmin) {
      console.log(
        chalk.dim(`    · 跳过 ${c.label}（${_fmtBytes(c.sizeBytes)}）：需要管理员写权限`)
      );
    }
  }

  // 下载中断文件（.crdownload/.part）：方法论安全表点名可自动清，同样过 2h 在用窗口。
  const downloadsDir = path.join(deps.homedir, 'Downloads');
  const unfinished = findUnfinishedDownloads(downloadsDir, deps, 2);
  if (unfinished.length > 0) {
    const unfinishedBytes = unfinished.reduce((s, f) => s + f.sizeBytes, 0);
    if (dryRun || !confirmedAuto) {
      printInfo(
        formatStatusMessage(
          '发现',
          '下载中断文件',
          `${unfinished.length} 个 · ${_fmtBytes(unfinishedBytes)}（${dryRun ? 'dry-run' : '非交互'}不删）`
        )
      );
    } else {
      let okCount = 0;
      let freedSum = 0;
      for (const f of unfinished) {
        const freed = await removeFile(f.path, deps);
        if (freed === null) {
          continue;
        }
        okCount += 1;
        freedSum += freed;
      }
      printSuccess(
        formatStatusMessage(
          '清理下载中断文件',
          downloadsDir,
          `删除 ${okCount}/${unfinished.length} 个 · 回收 ${_fmtBytes(freedSum)}`
        )
      );
    }
  }

  // ── 阶段 3/3：大文件分组确认（方法论核心交互） ──────────────
  console.log('');
  printInfo(formatStatusMessage('阶段 3/3', '大文件排查', `Downloads/Desktop/AppData\\Local ≥ ${Math.round(minBytes / MB)}MB`));
  const focusDirs = [
    { label: 'Downloads (下载)', dir: path.join(deps.homedir, 'Downloads') },
    { label: 'Desktop (桌面)', dir: path.join(deps.homedir, 'Desktop') },
    { label: 'AppData\\Local (应用缓存)', dir: path.join(deps.homedir, 'AppData', 'Local') },
  ].filter((d) => {
    try {
      return fsImpl.existsSync(d.dir);
    } catch {
      return false;
    }
  });

  const collected = collectLargeFiles(
    focusDirs.map((d) => d.dir),
    minBytes,
    deps
  );

  // 自动档刚清过的位置不再出现在确认清单里（避免同一批文件问两遍）。
  const cleanedPrefixes = dryRun
    ? []
    : plan.selected.map((c) => path.resolve(c.path).toLowerCase() + path.sep);
  const bigFiles = collected.files.filter(
    (f) => !cleanedPrefixes.some((p) => f.path.toLowerCase().startsWith(p))
  );

  if (collected.truncated) {
    printWarn(
      `大文件扫描在 ${Math.round(collected.elapsedMs / 1000)}s 预算内提前收工（列出的是已扫到的最大 ` +
        `${bigFiles.length} 个）；想扫更全可用 --min-mb 提高下限后重跑`
    );
  }
  if (bigFiles.length === 0) {
    printSuccess('没有发现达到下限的大文件，清理完成');
    return;
  }

  printWarn(
    `以下是你自己的文件（共 ${bigFiles.length} 个、${_fmtBytes(
      bigFiles.reduce((s, f) => s + f.sizeBytes, 0)
    )}）。删除=直接移除、不经回收站、不可恢复；每组都会请你确认。`
  );

  let manualFreed = 0;
  let manualDeleted = 0;
  const failedDeletes = [];

  // 逐组确认必须有真人应答；非交互一律全部保留（同自动档的 --yes 纪律）。
  if (!dryRun && !interactive) {
    printWarn('非交互环境：本段需要逐组应答确认，本次全部保留未删；请在终端交互运行 cleandisk');
  } else {
    const groups = chunkGroups(bigFiles, groupSize);
    let gi = 0;
    while (gi < groups.length) {
      const group = groups[gi];
      _printGroup(gi + 1, groups.length, group, dryRun);

      if (dryRun) {
        gi += 1;
        continue;
      }

      let decision = null;
      for (let attempt = 0; attempt < 3 && !decision; attempt += 1) {
        let res;
        try {
          res = await promptCompat([
            {
              type: 'input',
              name: 'ans',
              default: '',
              message: `第 ${gi + 1}/${groups.length} 组 · 回车=保留本组 | y=删除全部 ${group.length} 项 | 序号(如 1,3)=只删这些 | q=结束`,
            },
          ]);
        } catch {
          decision = { mode: 'quit' }; // Ctrl+C / 中断 → 保住剩余文件
          break;
        }
        if (!('ans' in res)) {
          decision = { mode: 'quit' }; // Esc（原生取消）→ 同样保住剩余文件
          break;
        }
        decision = parseGroupAnswer(res.ans, group.length);
        if (decision.mode === 'unknown') {
          printError('没看懂输入：回车=保留，y=删除本组全部，序号如 1,3 只删对应项，q 结束');
          decision = null;
        }
      }
      if (!decision || decision.mode === 'quit') {
        printInfo(`已停止询问，剩余 ${groups.length - gi} 组全部保留`);
        break;
      }
      if (decision.mode === 'none') {
        gi += 1;
        continue;
      }

      const picks = decision.mode === 'all' ? group : decision.indexes.map((i) => group[i - 1]);
      let groupFreed = 0;
      let groupDeleted = 0;
      for (const pick of picks) {
        const freed = await removeFile(pick.path, deps);
        if (freed === null) {
          failedDeletes.push(pick);
          continue;
        }
        groupDeleted += 1;
        groupFreed += freed;
        manualDeleted += 1;
        manualFreed += freed;
      }
      if (groupDeleted > 0) {
        printSuccess(
          formatStatusMessage(
            '已删除',
            `${groupDeleted} 个文件`,
            `回收 ${_fmtBytes(groupFreed)} · 累计 ${_fmtBytes(manualFreed)}`
          )
        );
      }
      for (const f of picks.filter((p) => failedDeletes.includes(p)).slice(0, 3)) {
        printWarn(`删除失败（占用或权限）：${f.path}`);
      }
      gi += 1;
    }
  }

  // ── 汇总 ────────────────────────────────────────────────────
  console.log('');
  const totalFreed = autoFreed + manualFreed;
  const after = _driveCapacity(root, deps);
  printSuccess(
    formatStatusMessage(
      '清理完成',
      root,
      `自动档 ${dryRun ? '预览' : confirmedAuto ? _fmtBytes(autoFreed) : '未执行'} + 手动确认 ${_fmtBytes(manualFreed)}（${manualDeleted} 项）`
    )
  );
  if (after && cap && cap.totalBytes > 0) {
    console.log(
      chalk.dim(
        `    可用空间 ${_fmtBytes(cap.freeBytes)} → ${_fmtBytes(after.freeBytes)}（本机总量还会随缓存回写小幅波动）`
      )
    );
  }
  if (failedDeletes.length > 0) {
    printWarn(`共 ${failedDeletes.length} 个大文件删除失败：关闭占用程序后重跑 cleandisk 即可重试`);
  }
  printInfo('回收站按设计保留（用户最后的后悔药）；确需清空可在 AI 对话里让 khy 执行磁盘清理 includeReview，或手动清空回收站');
}

module.exports = {
  handleDiskClean,
  // exported for tests
  AUTO_REVIEW_IDS,
  GROUP_SIZE_DEFAULT,
  MIN_MB_DEFAULT,
  SCAN_BUDGET_MS,
  UNFINISHED_EXTS,
  INSTALLER_NAME_HINT_RE,
  describeFile,
  parseGroupAnswer,
  chunkGroups,
  collectLargeFiles,
  findUnfinishedDownloads,
  removeFile,
  _resolveRoot,
  _defaultRoot,
  _driveCapacity,
  _ageLabel,
  [MANIFEST_EXPORT_KEY]: {
    name: 'cleandisk',
    description: 'cleandisk command (auto-migrated)',
    category: 'system',
    handler: async (parsed) => handleDiskClean(parsed.subCommand, parsed.args, parsed.options),
  },
};
