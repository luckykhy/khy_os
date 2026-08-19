'use strict';

/**
 * backup.js — `khy backup` 命令族的 CLI 层(create / list / verify / restore / prune / status)。
 *
 * 本文件只做「解析参数 → 调服务 → 排版输出」,不含任何备份逻辑与路径/阈值字面量:
 * 规则在 services/backup/backupAssetPlan.js,执行在 backupService/restoreService,
 * 默认值在 constants/serviceDefaults.js 的 BACKUP(F5)。
 *
 * ── 为什么是 `khy backup restore` 而不是 `khy restore` ──────────────────
 * `khy restore` / `khy restore-source` **已被占用**:它恢复的是加密源码包
 * (handlers/publish.handleRestore,中文别名 还原/完整还原/还原项目)。劫持它会
 * 破坏源码恢复这条既有链路,故数据恢复挂在 `khy backup restore` 下,并额外提供
 * 中文别名 恢复数据/数据恢复/还原数据 直达。
 *
 * @module cli/handlers/backup
 */

// ── Imports ──
const chalk = require('chalk').default || require('chalk');
const fs = require('fs');
const path = require('path');

const { BACKUP } = require('../../constants/serviceDefaults');
const plan = require('../../services/backup/backupAssetPlan');
const backupService = require('../../services/backup/backupService');
const restoreService = require('../../services/backup/restoreService');
const { printInfo, printError, printSuccess, printWarn, printTable } = require('../formatters');

// ── Helpers ──

function _fmtBytes(n) {
  const b = Number(n) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function _fmtWhen(iso) {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso || '');
    return d.toLocaleString();
  } catch {
    return String(iso || '');
  }
}

/** 进度回调:每条状态都带「动作 + 目标 + 进度」,不打不透明的「处理中…」。 */
function _progress(quiet) {
  if (quiet) {
    return () => {};
  }
  return (msg) => {
    process.stdout.write(`${chalk.gray('  ·')} ${msg}\n`);
  };
}

function _bool(options, ...names) {
  for (const n of names) {
    if (options && options[n]) return true;
  }
  return false;
}

function _num(options, name) {
  const raw = options && options[name];
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) ? n : undefined;
}

function _commonOpts(options) {
  return {
    root: (options && options.root) || undefined,
    tier: (options && options.tier) || undefined,
  };
}

// ── create ──

async function _create(args, options) {
  const quiet = _bool(options, 'quiet', 'q');
  const tier = plan.normalizeTier((options && options.tier) || (args && args[0]) || BACKUP.TIER);
  printInfo(`创建备份:分级 ${tier},备份根 ${backupService.resolveBackupRoot(_commonOpts(options))}`);

  const res = await backupService.createBackup({
    ..._commonOpts(options),
    tier,
    note: (options && options.note) || '',
    allowPartial: _bool(options, 'allow-partial', 'allowPartial'),
    onProgress: _progress(quiet),
  });

  for (const w of res.warnings) {
    printWarn(w);
  }
  if (!res.ok) {
    printError(`备份失败:${res.error}`);
    return false;
  }
  const m = res.manifest;
  printSuccess(
    `备份 ${res.id} 已完成:${m.entries.length} 项 / ${_fmtBytes(m.totalBytes)},排除 ${m.excluded.length} 项`
  );
  printInfo(`落盘位置:${res.dir}`);
  if (m.containsSecrets) {
    printWarn('该备份含机密(API 密钥 / 会话令牌),目录权限 0700,请勿放入公共存储或版本库');
  }
  printInfo(`校验:khy backup verify ${res.id}    恢复:khy backup restore ${res.id}`);
  return true;
}

// ── list ──

function _list(args, options) {
  const { root, sets } = backupService.listBackups(_commonOpts(options));
  printInfo(`备份根:${root}`);
  if (sets.length === 0) {
    printWarn('还没有任何备份。执行 `khy backup` 创建第一份。');
    return true;
  }
  const rows = sets.map((s) => [
    s.complete ? s.id : chalk.red(s.id),
    s.complete ? chalk.green('OK') : chalk.red('BROKEN'),
    s.tier,
    _fmtWhen(s.createdAt),
    String(s.entryCount),
    _fmtBytes(s.totalBytes),
    s.note || '',
  ]);
  printTable(['ID', '状态', '分级', '创建时间', '项数', '大小', '备注'], rows);

  const broken = sets.filter((s) => !s.complete).length;
  if (broken) {
    printWarn(`${broken} 份备份缺少 .complete 标记(写入未完成,不可用于恢复);\`khy backup prune\` 会优先清理它们`);
  }
  printInfo(
    `保留策略:同时超过 ${BACKUP.KEEP_COUNT} 份且早于 ${BACKUP.KEEP_DAYS} 天才会被清理,最新一份永不删除`
  );
  return true;
}

// ── verify ──

function _verify(args, options) {
  const id = (args && args[0]) || '--latest';
  const res = backupService.verifyBackup(id, _commonOpts(options));
  if (res.error) {
    printError(`校验失败:${res.error}`);
    return false;
  }
  if (res.ok) {
    printSuccess(`备份 ${res.id} 校验通过:${res.checked} 项全部字节数与 sha256 一致`);
    return true;
  }
  printError(`备份 ${res.id} 校验不通过:${res.problems.length} 项有问题(已检查 ${res.checked} 项)`);
  for (const p of res.problems.slice(0, 20)) {
    process.stdout.write(`  ${chalk.red('✗')} ${p}\n`);
  }
  if (res.problems.length > 20) {
    printWarn(`另有 ${res.problems.length - 20} 项未列出`);
  }
  return false;
}

// ── restore ──

async function _restore(args, options) {
  const id = (args && args[0]) || '--latest';
  const quiet = _bool(options, 'quiet', 'q');
  const dryRun = _bool(options, 'dry-run', 'dryRun', 'n');

  const res = await restoreService.restoreBackup(id, {
    ..._commonOpts(options),
    dryRun,
    remap: _bool(options, 'remap'),
    force: _bool(options, 'force', 'f'),
    skipPreBackup: _bool(options, 'skip-pre-backup', 'skipPreBackup'),
    skipReindex: _bool(options, 'skip-reindex', 'skipReindex'),
    onProgress: _progress(quiet),
  });

  for (const b of res.blockers) {
    printError(b);
  }
  for (const w of res.warnings) {
    printWarn(w);
  }
  for (const step of res.manualSteps) {
    printInfo(`需人工执行:${step}`);
  }
  if (!res.ok) {
    printError(`恢复未完成:${res.error}`);
    for (const f of res.failed.slice(0, 20)) {
      process.stdout.write(`  ${chalk.red('✗')} ${f.target} — ${f.reason}\n`);
    }
    return false;
  }
  if (res.dryRun) {
    printSuccess(`预演通过:备份 ${res.id} 可用于恢复,本次未改动任何文件(去掉 --dry-run 即真正执行)`);
    return true;
  }
  printSuccess(
    `恢复完成:从 ${res.id} 写回 ${res.restored.sqlite} 个库 / ${res.restored.file} 个文件` +
      (res.restored.cold ? `,冷归档摊回 ${res.restored.cold} 个文件` : '')
  );
  if (res.preBackupId) {
    printInfo(`回退备份(恢复前的现状):${res.preBackupId} — 若恢复选错了,可用它退回`);
  }
  printInfo('若守护进程之前在运行,请执行 `khy daemon start` 重新启动以加载新数据');
  return true;
}

// ── prune ──

function _prune(args, options) {
  const dryRun = _bool(options, 'dry-run', 'dryRun', 'n');
  const res = backupService.pruneBackups({
    ..._commonOpts(options),
    dryRun,
    keepCount: _num(options, 'keep-count') ?? _num(options, 'keepCount'),
    keepDays: _num(options, 'keep-days') ?? _num(options, 'keepDays'),
  });
  printInfo(`备份根:${res.root}`);
  if (res.dropped.length === 0) {
    printSuccess(`无需清理:${res.kept.length} 份备份全部在保留范围内`);
    return true;
  }
  for (const d of res.dropped) {
    const mark = dryRun ? chalk.yellow('将删除') : d.removed ? chalk.green('已删除') : chalk.red('删除失败');
    process.stdout.write(`  ${mark} ${d.id} — ${d.reason}\n`);
  }
  if (dryRun) {
    printInfo(`预演:将清理 ${res.dropped.length} 份,保留 ${res.kept.length} 份(去掉 --dry-run 即执行)`);
  } else {
    printSuccess(`清理完成:删除 ${res.dropped.filter((d) => d.removed).length} 份,保留 ${res.kept.length} 份`);
  }
  return true;
}

// ── status ──

function _status(args, options) {
  const { root, sets } = backupService.listBackups(_commonOpts(options));
  const homes = backupService.resolveHomes({});
  const newest = sets.find((s) => s.complete);

  printInfo(`备份根:${root}`);
  printInfo(`数据家目录:${homes.map((h) => `${h.role}=${h.dir}`).join('  ') || '(未解析到)'}`);
  printInfo(
    `默认分级 ${BACKUP.TIER} · 保留 ${BACKUP.KEEP_COUNT} 份 / ${BACKUP.KEEP_DAYS} 天 · 起备最小可用空间 ${_fmtBytes(BACKUP.MIN_FREE_BYTES)}`
  );

  const dbMode = String(process.env.DB_MODE || process.env.DB_TYPE || 'auto');
  printInfo(`数据库模式 ${dbMode}${dbMode === 'postgres' ? `(将调用 ${BACKUP.PG_DUMP_BIN})` : '(SQLite 走 VACUUM INTO 热备)'}`);

  for (const h of homes) {
    const found = plan.SQLITE_ASSETS.filter((a) => {
      try {
        return fs.existsSync(path.join(h.dir, a.rel));
      } catch {
        return false;
      }
    });
    if (found.length) {
      printInfo(`  ${h.role} 待热备的库:${found.map((a) => a.rel).join(', ')}`);
    }
  }

  if (!newest) {
    printWarn(`共 ${sets.length} 个目录,但没有一份可用备份。执行 \`khy backup\` 创建。`);
    return true;
  }
  const ageDays = Math.floor((Date.now() - newest.timeMs) / 86400000);
  printSuccess(
    `最近一份可用备份:${newest.id}(${_fmtWhen(newest.createdAt)},${ageDays} 天前,${_fmtBytes(newest.totalBytes)})`
  );
  if (ageDays >= BACKUP.KEEP_DAYS) {
    printWarn(`最近备份已 ${ageDays} 天,超过保留窗口 ${BACKUP.KEEP_DAYS} 天,建议立刻 \`khy backup\``);
  }
  return true;
}

// ── help ──

function _help() {
  process.stdout.write(
    `
${chalk.bold('khy backup')} — 统一数据备份与恢复

${chalk.bold('用法')}
  khy backup [create]            创建备份(默认子命令)
  khy backup list                列出所有备份
  khy backup status              备份概览(备份根、家目录、待热备的库、最近一份)
  khy backup verify [<id>]       逐项校验字节数与 sha256(缺省 --latest)
  khy backup restore [<id>]      从备份恢复(缺省 --latest)
  khy backup prune               按保留策略清理

${chalk.bold('中文直达')}
  khy 备份 / 数据备份 · khy 备份列表 · khy 备份检查 · khy 恢复数据 · khy 清理备份

${chalk.bold('选项')}
  --tier core|full        core(默认)=权威且体积可控;full 追加审计/凭据/事件等历史流水
  --note <文本>           备注,写进 manifest
  --root <目录>           覆盖备份根(默认 ${BACKUP.ROOT || '<数据家目录>/backups'})
  --allow-partial         create:主库备份失败时仍产出备份集(默认硬失败)
  --dry-run, -n           restore/prune:只预演,不改动任何文件
  --remap                 restore:数据家目录路径已变化(换机/换用户),按当前路径恢复
  --force                 restore:忽略 sha256 校验问题(缺 .complete 永不放行)
  --skip-pre-backup       restore:跳过「恢复前先备份现状」(不可撤销,不建议)
  --keep-count / --keep-days   prune:覆盖保留策略

${chalk.bold('注意')}
  · SQLite 一律经 VACUUM INTO 热备,绝不复制正在写入的 .db 文件
  · 恢复前请先 ${chalk.cyan('khy daemon stop')};恢复会自动先给现状拍一份回退备份
  · 备份含 API 密钥与会话令牌(manifest.containsSecrets),目录权限 0700,勿入版本库
  · ${chalk.yellow('khy restore')} 是另一件事(加密源码包恢复),数据恢复请用 ${chalk.cyan('khy backup restore')}
`
  );
  return true;
}

// ── Entry ──

/**
 * `khy backup` 命令入口(三步注册模式的 handler 层)。
 *
 * @param {string} subCommand
 * @param {string[]} args
 * @param {object} options
 * @returns {Promise<boolean>}
 */
async function handleBackupCommand(subCommand, args = [], options = {}) {
  // 总闸(flagRegistry:KHY_BACKUP,default-on)。关掉时命令仍可被发现,但明确拒绝执行
  // 而不是静默空跑 —— 用户必须知道「什么都没备份」这件事。
  try {
    const { isFlagEnabled } = require('../../services/flagRegistry');
    if (!isFlagEnabled('KHY_BACKUP')) {
      printWarn('备份功能已被 KHY_BACKUP 关闭:未执行任何备份/恢复动作。删除该环境变量即可恢复。');
      return false;
    }
  } catch {
    /* 注册表不可用时不阻断备份 —— 备份可用性优先于门控 */
  }

  const sub = String(subCommand || 'create').toLowerCase();
  switch (sub) {
    case 'create':
    case 'new':
      return _create(args, options);
    case 'list':
    case 'ls':
      return _list(args, options);
    case 'verify':
    case 'check':
      return _verify(args, options);
    case 'restore':
      return _restore(args, options);
    case 'prune':
    case 'clean':
      return _prune(args, options);
    case 'status':
      return _status(args, options);
    case 'help':
      return _help();
    default:
      // 无法识别的子命令很可能是「khy backup <tier>」或误拼;明确说清而不是静默当 create。
      if (plan.TIERS.includes(sub)) {
        return _create(args, { ...options, tier: sub });
      }
      printError(`未知子命令:backup ${sub}`);
      return _help();
  }
}

module.exports = { handleBackupCommand };
