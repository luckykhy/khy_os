'use strict';

/**
 * cleanup.js — khy 自身数据保留（日志 / 快照 / 会话 / 轨迹 / 审计 / 检查点）
 *
 * 为什么要有这条命令：`cleanupService`（20+ 个保留函数，覆盖 ~/.khyquant 与 .khy）
 * 此前只被 `khy clean --checkpoints` 借用了一个切面，其余能力**没有任何命令入口**
 * ——`aliases.js` 与 `diskClean.js` 的注释里都把 `khy cleanup` 当成已存在的命令来引述，
 * 实际敲下去会落到未知命令。本文件把这层「注释说有、实现没有」的分叉补上。
 *
 * 与相邻命令的边界（三者目标不重叠，别再混）：
 *   - `khy clean`      → **工作树**里的构建产物 / 可重装依赖 / 运行时目录
 *   - `khy cleandisk`  → **整盘**空间（C 盘大规模清理方法论）
 *   - `khy cleanup`    → **khy 自身数据**按已声明的保留策略收敛（本文件）
 *
 * 三条纪律（沿用 `clean` 的既有约定，不自造第二套）：
 *   1. **默认只预览**。不给 `--yes` 就只打印「各目标当前占用 + 它的保留策略」，
 *      一个字节都不动。
 *   2. **数值全部从单一真源读**（`constants/serviceDefaults` 的 LOGS / AUDIT /
 *      CHECKPOINT / RUNTIME_FOOTPRINT）。本文件不写死任何一个阈值——写死的那份
 *      迟早与服务里的那份漂移，而两个不一致的保留期比没有保留期更坏。
 *   3. **不做激进删除**。`.khy` 里躺着会话历史与凭据，自动清理的错误代价不可逆；
 *      本命令只按已声明的策略收敛。
 *
 * @module handlers/cleanup
 */

// ── Imports ──

const { MANIFEST_EXPORT_KEY } = require('../commandManifest');
const cleanupService = require('../../services/cleanupService');

/**
 * 打印函数：ctx 里带了就用 ctx 的（自注册分派会注入），否则回落到 formatters。
 * 两种调用方式（`(parsed, ctx)` 与旧的 `(subCommand, args, options)`）都能跑。
 */
function prints(ctx = {}) {
  const f = require('../formatters');
  return {
    printInfo: ctx.printInfo || f.printInfo,
    printError: ctx.printError || f.printError,
    printSuccess: ctx.printSuccess || f.printSuccess,
    printWarn: ctx.printWarn || f.printWarn,
  };
}

/** 判断布尔型选项是否命中（`--x` 解析成 `options.x === true`，`--x=true` 解析成字符串）。 */
function has(options, ...keys) {
  return keys.some((k) => options[k] === true || options[k] === 'true');
}

/** 字节数转人类可读字符串。走 cleanupService 的单一实现，不另起一套口径。 */
function mb(bytes) {
  return cleanupService.humanSize(Number(bytes) || 0);
}

/**
 * 保留策略文本。**所有数字都取自 `cleanupService.getRetentionPolicy()`**，命令侧一个
 * 阈值都不写死——写死的那份迟早与服务里的那份漂移（[RUNTIME-001] 零硬编码）。
 */
function policyText(key, pol = {}) {
  const b = (v) => mb(Number(v) || 0);
  switch (key) {
    case 'securityLog':
      return `轮转上限 ${b(pol.maxBytes)}，保留 ${pol.keepArchives} 份 .gz 归档`;
    case 'securityLogArchives':
      return '安全日志归档（随主日志轮转）';
    case 'growthSnapshots':
      return `快照最多保留 ${pol.maxKeep} 份`;
    case 'trainingData':
      return `裁剪至 ${pol.maxLines} 行 / ${b(pol.maxBytes)}`;
    case 'telemetry':
      return `导出最多保留 ${pol.maxFiles} 份`;
    case 'traceAudit':
      return (
        `留存 ${pol.keepDays} 天，过期先归档为 .jsonl.gz` +
        `${pol.archive ? '' : '（归档已关闭：过期直接删）'}；` +
        `归档总量超 ${b(pol.maxTotalBytes)} 才从最旧删`
      );
    case 'scanLog':
    case 'skillAudit':
    case 'telemetryAudit':
      return `轮转上限 ${b(pol.maxBytes)}`;
    case 'quarantine':
      return `裁剪至 ${pol.maxLines} 行 / ${b(pol.maxBytes)}`;
    case 'dailyLogs':
      return `保留 ${pol.keepDays} 天`;
    case 'sessions':
      return `保留 ${pol.keepDays} 天（活跃会话因 mtime 持续刷新，天然不被回收）`;
    case 'trajectories':
      return `保留 ${pol.keepDays} 天（KHY_TRAJECTORY_MAX_AGE_D 可调）`;
    case 'taskOutputs':
      return `保留 ${pol.keepHours} 小时`;
    case 'checkpoints':
      return `总量封顶 ${b(pol.maxTotalBytes)}（每项目）`;
    case 'runtimeLogs':
      return `保留 ${pol.keepDays} 天 / ${pol.maxFiles} 个文件 / ${b(pol.maxBytes)}`;
    default:
      return '策略真源见 cleanupService.getRetentionPolicy()';
  }
}

/** 报告里不逐个展示的聚合键。 */
const NON_TARGET_KEYS = new Set(['total', 'totalHuman']);

/**
 * 把 `getStorageReport()` 的结果转成「按体积降序排列」的展示行。
 * 键名与策略文案一一对应，报告里新增目标时自动出现，不需要改这里。
 */
function targetRows(report, policy = {}) {
  return Object.keys(report)
    .filter((k) => !NON_TARGET_KEYS.has(k))
    .map((k) => {
      const v = report[k] || {};
      return {
        key: k,
        size: Number(v.size) || 0,
        policy: policyText(k, policy[k]),
      };
    })
    .sort((a, b) => b.size - a.size);
}

/** 等宽补齐，用于终端里的列对齐（中文按 1 计，够用且不引依赖）。 */
function pad(s, width) {
  const str = String(s);
  return str + ' '.repeat(Math.max(0, width - str.length));
}

/** 周期清理的可见性——这是「防止清理完后又膨胀」的第一道机制，必须让人看得见。 */
function periodicStatus() {
  const optedOut = String(process.env.KHY_ENABLE_PERIODIC_SCAN || '').toLowerCase() === 'false';
  const interval = parseInt(process.env.KHY_CLEANUP_INTERVAL_MS, 10) || 2 * 60 * 60 * 1000;
  return {
    enabled: !optedOut,
    intervalHuman: `${Math.round(interval / 60000)} 分钟`,
  };
}

/** 预览表格：目标 / 当前占用 / 保留策略 + 合计 + 数据根与提示阈值。只打印，不写盘。 */
function renderPreview(report, footprint, policy) {
  const rows = targetRows(report, policy);
  const keyW = Math.max(20, ...rows.map((r) => r.key.length));
  console.log('');
  console.log('  ' + pad('目标', keyW + 2) + pad('当前占用', 12) + '保留策略');
  console.log('  ' + '─'.repeat(keyW + 2 + 12 + 30));
  for (const r of rows) {
    if (r.size === 0) continue;
    console.log('  ' + pad(r.key, keyW + 2) + pad(r.size ? mb(r.size) : '0 B', 12) + r.policy);
  }
  console.log('  ' + '─'.repeat(keyW + 2 + 12 + 30));
  console.log('  ' + pad('合计', keyW + 2) + pad(report.totalHuman || '0 B', 12));
  console.log('');
  if (footprint) {
    console.log(`  khy 数据根：${footprint.root}`);
    console.log(`  提示阈值：${footprint.totalHuman} / ${mb(footprint.thresholdBytes)}` +
      (footprint.overThreshold ? '（已超过）' : '（未超过）'));
  }
}

/** `--report`：回显上次清理（触发源、释放量、逐条动作）。无记录时给出下一步命令。 */
async function runReport(print) {
  const last = cleanupService.getLastCleanupReport();
  if (!last) {
    print.printInfo('还没有清理报告。先跑 `khy cleanup --yes`，之后这里会显示上次清理的明细。');
    return true;
  }
  console.log('');
  console.log(`  上次清理：${last.trigger || 'manual'} @ ${new Date(last.at || Date.now()).toLocaleString()}`);
  const summary = last.summary || {};
  console.log(`  释放：${summary.freedHuman || '0 B'}　目标数：${summary.targetCount || 0}　耗时：${summary.elapsedMs || 0} ms`);
  if (Array.isArray(summary.actions) && summary.actions.length) {
    console.log('  动作：');
    for (const a of summary.actions) {
      console.log(`    · ${a}`);
    }
  }
  console.log('');
  return true;
}

/** `--yes`：真跑 `runCleanup()`，前后各取一次占用以便如实报出「释放了多少」。 */
async function applyCleanup(print) {
  const before = cleanupService.getStorageReport();
  console.log('');
  print.printWarn(`按保留策略执行清理。清理前 khy 数据合计 ${before.totalHuman || '0 B'}。`);
  const result = cleanupService.runCleanup({ trigger: 'cli' });
  const summary = (result && result.summary) || {};
  const after = cleanupService.getStorageReport();

  console.log('');
  print.printSuccess(
    `清理完成：释放 ${summary.freedHuman || '0 B'}，共 ${summary.targetCount || 0} 个目标，` +
      `失败 ${summary.failureCount || 0} 项，耗时 ${summary.elapsedMs || 0} ms。`
  );
  if (Array.isArray(summary.actions) && summary.actions.length) {
    console.log('  实际动作：');
    for (const a of summary.actions) {
      console.log(`    · ${a}`);
    }
  } else {
    print.printInfo('本次没有任何目标超出保留策略——数据本来就处在阈值内。');
  }
  console.log('');
  console.log(`  清理后 khy 数据合计 ${after.totalHuman || '0 B'}（清理前 ${before.totalHuman || '0 B'}）。`);
  console.log('');
  return true;
}

/**
 * 帮助文本。刻意写清与 `clean` / `cleandisk` 的边界——三条命令目标不重叠，
 * 混用会导致「以为清过了其实没清」。
 */
function renderHelp(print) {
  console.log('');
  console.log('  khy cleanup —— khy 自身数据保留（日志 / 快照 / 会话 / 轨迹 / 审计 / 检查点）');
  console.log('');
  console.log('    khy cleanup              预览：列出各目标当前占用与保留策略（默认，不动数据）');
  console.log('    khy cleanup --yes        按保留策略执行清理');
  console.log('    khy cleanup --report     查看上次清理报告');
  console.log('    khy cleanup --json       预览结果以 JSON 输出（供脚本消费）');
  console.log('    khy cleanup --help       显示本帮助');
  console.log('');
  console.log('  与相邻命令的边界：');
  console.log('    khy clean      清理「工作树」里的构建产物 / 可重装依赖 / 运行时目录');
  console.log('    khy cleandisk  清理「整盘」空间');
  console.log('    khy cleanup    收敛「khy 自身数据」的历史留存（本命令）');
  console.log('');
  console.log('  khy 数据目录里的会话历史与凭据不会被激进删除，只按已声明的保留期收敛。');
  console.log('');
  return true;
}

/**
 * 命令入口。兼容两种分派签名：
 *   - 自注册分派：handleCleanup(parsed, ctx)
 *   - 旧式直接调用：handleCleanup(subCommand, args, options)
 */
async function handleCleanup(parsed = {}, ctx = {}) {
  let options = {};
  let subCommand = '';
  let args = [];

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    options = parsed.options || {};
    subCommand = String(parsed.subCommand || '').toLowerCase();
    args = Array.isArray(parsed.args) ? parsed.args : [];
  } else {
    // 旧式：第一个参数是 subCommand 字符串
    subCommand = String(parsed || '').toLowerCase();
    args = Array.isArray(ctx) ? ctx : [];
    options = (arguments[2] && typeof arguments[2] === 'object') ? arguments[2] : {};
    ctx = {};
  }

  const print = prints(ctx);
  const json = has(options, 'json');
  const dryRun = has(options, 'dry-run', 'dryRun');
  const wantReport = has(options, 'report') || subCommand === 'report';
  const wantHelp = has(options, 'help') || subCommand === 'help' || subCommand === '--help';

  if (wantHelp) return renderHelp(print);
  if (wantReport) return runReport(print);

  const report = cleanupService.getStorageReport();
  let footprint = null;
  try {
    footprint = cleanupService.assessRuntimeFootprint();
  } catch {
    /* 足迹评估是尽力而为，失败不阻断主流程 */
  }
  const periodic = periodicStatus();
  const policy = cleanupService.getRetentionPolicy();

  if (json) {
    console.log(
      JSON.stringify(
        {
          mode: options.yes && !dryRun ? 'apply' : 'preview',
          totalBytes: report.total,
          totalHuman: report.totalHuman,
          targets: targetRows(report, policy).map((r) => ({
            key: r.key,
            bytes: r.size,
            human: mb(r.size),
            policy: r.policy,
          })),
          footprint: footprint
            ? {
                root: footprint.root,
                totalHuman: footprint.totalHuman,
                thresholdHuman: mb(footprint.thresholdBytes),
                overThreshold: footprint.overThreshold,
              }
            : null,
          periodic,
        },
        null,
        2
      )
    );
    return true;
  }

  // 执行分支：要求 --yes 且未显式 --dry-run（与 clean 的纪律一致）
  if (options.yes && !dryRun) {
    return applyCleanup(print);
  }

  renderPreview(report, footprint, policy);
  if (dryRun) {
    print.printInfo('（--dry-run）仅预览，未触碰任何数据。');
  } else if (!options.yes) {
    print.printInfo('以上为预览。确认后加 --yes 执行：khy cleanup --yes');
  }
  console.log(
    `  周期清理：${periodic.enabled ? `已启用，每 ${periodic.intervalHuman} 一次（后端运行时生效）` : '已关闭（KHY_ENABLE_PERIODIC_SCAN=false）'}`
  );
  console.log('');
  return true;
}

module.exports = {
  handleCleanup,
  [MANIFEST_EXPORT_KEY]: {
    name: 'cleanup',
    aliases: ['数据保留', '保留清理', 'khycleanup'],
    description: '按保留策略收敛 khy 自身数据（日志/快照/会话/轨迹/审计/检查点），默认只预览',
    usage: 'cleanup [--yes] [--report] [--json] [--dry-run]',
    category: 'system',
    handler: handleCleanup,
  },
};
