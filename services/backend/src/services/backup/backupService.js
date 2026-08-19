'use strict';

/**
 * backupService.js — 统一数据备份引擎(create / list / verify / prune)。
 *
 * **做 IO**(文件系统 + SQLite + 可选子进程 pg_dump)。规则真源在两个纯叶子里:
 * 资产分级与排除规则 → `backupAssetPlan.js`;清单结构与保留策略求解 → `backupManifest.js`。
 * 本文件只做「按规则搬字节 + 如实记账」,不内联任何路径/阈值字面量(默认值全部来自
 * `constants/serviceDefaults.js` 的 BACKUP,F5)。
 *
 * ── 域边界(不与既有机制重复覆盖)─────────────────────────────────────────
 * 本引擎只拥有「持久化数据」域。以下各有其主,一律不碰:
 *   - `.install-ledger.jsonl` + `khy uninstall`  安装副作用逆序回滚
 *   - `khy workspace save/restore`               源码快照(git diff / tar)
 *   - `khy undo` / `khy rewind`                  文件/会话级细粒度回滚
 *   - `khy restore` / `restore-source`           加密源码包恢复(与本命令同名不同域)
 *   - `khy vault`                                机密(默认不进备份集)
 *   - `khy storage migrate`                      数据家目录搬迁
 *
 * ── 备份集布局(restore 与演练测试都按 BACKUP.* 常量寻址,不猜)──────────────
 *   <root>/<id>/manifest.json          清单(先写,它要先算完所有 sha256)
 *   <root>/<id>/db/<name>.db           VACUUM INTO 产物
 *   <root>/<id>/db/postgres.dump       仅 DB_MODE=postgres
 *   <root>/<id>/home-<role>/<相对路径>  逐文件原子复制
 *   <root>/<id>/cold/<role>-<dir>.jsonl.gz  冷归档(可选,见 createBackup 的冷导出阶段)
 *   <root>/<id>/.complete              **最后**写。没有它 = 写到一半崩了 → BROKEN
 *
 * 契约:fail-soft 返回结构化结果,绝不把异常抛给 CLI;任何**部分成功**都必须在
 * warnings/excluded 里留下痕迹 —— 一份漏了主库却报「成功」的备份比没有备份更危险。
 *
 * @module services/backup/backupService
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { BACKUP, COLD_EXPORT } = require('../../constants/serviceDefaults');
const dh = require('../../utils/dataHome');
const sr = require('../../utils/storageRoots');
const atomicWriteJson = require('../../utils/atomicWriteJson');
const plan = require('./backupAssetPlan');
const mf = require('./backupManifest');
const { hotCopySqlite } = require('./sqliteHotCopy');
const cold = require('./coldExportService');

// ── 内部工具 ─────────────────────────────────────────────────────────────

/** 分块算 sha256,避免把一个几百 MB 的库整体读进内存。失败返 ''。 */
function _sha256File(filePath) {
  let fd = null;
  try {
    const hash = crypto.createHash('sha256');
    const buf = Buffer.allocUnsafe(1024 * 256);
    fd = fs.openSync(filePath, 'r');
    let read = 0;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
    return hash.digest('hex');
  } catch {
    return '';
  } finally {
    try {
      if (fd !== null) fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
}

/** 备份集内的相对路径统一用 POSIX 分隔符(manifest 要跨平台可读)。 */
function _posix(p) {
  return String(p).split(path.sep).join('/').split('\\').join('/');
}

function _readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function _sqliteDriverName() {
  try {
    const info = require('../../config/sqlite-adapter').__driverInfo;
    return String((info && info.type) || 'unknown');
  } catch {
    return 'unknown';
  }
}

function _khyVersion() {
  try {
    return String(require('../../../package.json').version || '');
  } catch {
    return '';
  }
}

/**
 * 备份根目录。BACKUP.ROOT 为空 → utils/dataHome.getDataDir('backups')
 * (bootstrap/migrations.js 已在建该目录)。此处不内联绝对路径(F5)。
 * @param {object} [opts]
 * @returns {string}
 */
function resolveBackupRoot(opts = {}) {
  if (opts.root) {
    return path.resolve(String(opts.root));
  }
  if (BACKUP.ROOT) {
    return path.resolve(BACKUP.ROOT);
  }
  return dh.getDataDir('backups');
}

/**
 * 参与备份的数据家目录集。去重(项目级与用户级在某些部署下会重合),并跳过不存在的。
 *
 * @param {object} [opts]
 * @param {Array<{role: string, dir: string}>} [opts.homes] 注入(测试用)
 * @returns {Array<{role: string, dir: string}>}
 */
function resolveHomes(opts = {}) {
  if (Array.isArray(opts.homes)) {
    return opts.homes.filter((h) => h && h.role && h.dir);
  }
  const out = [];
  const seen = new Set();
  const push = (role, dir) => {
    try {
      if (!dir) return;
      const abs = path.resolve(dir);
      const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
      if (seen.has(key) || !fs.existsSync(abs)) return;
      seen.add(key);
      out.push({ role, dir: abs });
    } catch {
      /* skip unresolvable home */
    }
  };
  try {
    push(plan.HOME_USER, dh.getDataHome());
  } catch {
    /* ignore */
  }
  try {
    push(plan.HOME_PROJECT, dh.getProjectDataHome());
  } catch {
    /* ignore */
  }
  try {
    push(plan.HOME_APP, dh.getAppHome());
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * 遍历一个数据家目录,按 backupAssetPlan 的规则产出收录/排除两张表。
 *
 * @param {string} homeDir
 * @param {string} role
 * @param {string} tier
 * @param {string} backupRootAbs 备份根(若落在家目录内必须整棵剪掉,防递归)
 * @returns {{files: Array<{abs: string, rel: string}>, excluded: Array<{path: string, reason: string}>}}
 */
function collectHomeFiles(homeDir, role, tier, backupRootAbs) {
  const files = [];
  const excluded = [];
  const rootKey = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
  const backupKey = backupRootAbs ? rootKey(path.resolve(backupRootAbs)) : '';
  const stack = [homeDir];

  while (stack.length) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (err) {
      excluded.push({
        path: _posix(path.relative(homeDir, cur)) || '.',
        reason: `目录不可读: ${String((err && err.code) || err)}`,
      });
      continue;
    }
    for (const e of entries) {
      const abs = path.join(cur, e.name);
      const rel = _posix(path.relative(homeDir, abs));

      // 符号链接一律不跟随:跟随会把备份集写成环,或把家目录外的东西吸进来。
      if (e.isSymbolicLink()) {
        excluded.push({ path: `${role}:${rel}`, reason: '符号链接,不跟随' });
        continue;
      }
      if (e.isDirectory()) {
        if (backupKey && rootKey(abs) === backupKey) {
          excluded.push({ path: `${role}:${rel}`, reason: '备份根目录自身(防递归)' });
          continue;
        }
        const d = plan.classifyDir(e.name, tier);
        if (d.prune) {
          excluded.push({ path: `${role}:${rel}`, reason: d.reason });
          continue;
        }
        stack.push(abs);
        continue;
      }
      if (!e.isFile()) {
        excluded.push({ path: `${role}:${rel}`, reason: '非普通文件' });
        continue;
      }
      const f = plan.classifyFile(e.name, tier);
      if (!f.include) {
        excluded.push({ path: `${role}:${rel}`, reason: f.reason });
        continue;
      }
      files.push({ abs, rel });
    }
  }

  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  excluded.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, excluded };
}

/**
 * PostgreSQL 分支。仅在 DB_MODE/DB_TYPE 明确为 postgres 时启用(auto 模式实际走 SQLite,
 * 见 platform/packages/shared/src/config/database.js 的 initDatabase)。
 *
 * pg_dump 带 --verbose:它正常情况下静默,而 spawnWithIdleTimeout 是**基于活动**的空闲
 * 超时(AGENTS 规则 3),没有输出就无从续命 —— 一个几 GB 的库会被误判为卡死。--verbose
 * 让它持续往 stderr 报进度,空闲计时器随之续期,绝不硬杀进行中的导出。
 *
 * @returns {Promise<{ok: boolean, skipped: boolean, reason: string, bytes: number}>}
 */
async function dumpPostgres(targetFile, opts = {}) {
  const env = opts.env || process.env;
  const mode = String(env.DB_MODE || env.DB_TYPE || 'auto').toLowerCase();
  if (mode !== 'postgres') {
    return { ok: true, skipped: true, reason: `DB_MODE=${mode},非 postgres,跳过 pg_dump`, bytes: 0 };
  }
  const { spawnWithIdleTimeout } = require('../../utils/spawnWithIdleTimeout');
  const bin = BACKUP.PG_DUMP_BIN;
  const args = [
    '--format=custom',
    '--verbose',
    `--file=${targetFile}`,
    `--host=${env.DB_HOST || 'localhost'}`,
    `--port=${env.DB_PORT || '5432'}`,
    `--username=${env.DB_USER || 'postgres'}`,
    env.DB_NAME || 'quant_trading',
  ];
  try {
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    const res = await spawnWithIdleTimeout(bin, args, {
      idleMs: BACKUP.PG_DUMP_IDLE_TIMEOUT_MS,
      label: 'pg_dump',
      spawnOpts: {
        env: { ...env, PGPASSWORD: env.DB_PASSWORD || '' },
        windowsHide: true,
      },
    });
    if (res.code !== 0) {
      return {
        ok: false,
        skipped: false,
        reason: `pg_dump 退出码 ${res.code}: ${String(res.stderr || '').split('\n').slice(-3).join(' ').trim()}`,
        bytes: 0,
      };
    }
    const bytes = fs.existsSync(targetFile) ? fs.statSync(targetFile).size : 0;
    if (bytes <= 0) {
      return { ok: false, skipped: false, reason: 'pg_dump 产出空文件', bytes: 0 };
    }
    return { ok: true, skipped: false, reason: '', bytes };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      reason: `pg_dump 不可用: ${String((err && err.message) || err).split('\n')[0]}`,
      bytes: 0,
    };
  }
}

// ── create ───────────────────────────────────────────────────────────────

/**
 * 创建一份备份。
 *
 * @param {object} [opts]
 * @param {string} [opts.tier] 'core' | 'full'(缺省取 BACKUP.TIER)
 * @param {string} [opts.note] 备注,写进 manifest
 * @param {string} [opts.root] 备份根覆盖
 * @param {Array}  [opts.homes] 注入家目录(测试用)
 * @param {Function} [opts.onProgress] (msg) => void,状态文本带动作+目标+进度
 * @param {boolean} [opts.allowPartial=false] 主库备份失败时是否仍产出备份集
 * @param {boolean} [opts.includeCold] 显式开启冷导出(不设则取 COLD_EXPORT.ENABLED);
 *   两种情况都**只在 full 级生效**,理由见冷导出阶段的注释
 * @param {number} [opts.nowMs] 注入时间(测试用)
 * @returns {Promise<{ok: boolean, id: string, dir: string, manifest: object|null,
 *                    warnings: string[], error: string|null}>}
 */
async function createBackup(opts = {}) {
  const out = { ok: false, id: '', dir: '', manifest: null, warnings: [], error: null };
  const report = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

  let setDir = '';
  try {
    const tier = plan.normalizeTier(opts.tier || BACKUP.TIER);
    const root = resolveBackupRoot(opts);
    fs.mkdirSync(root, { recursive: true, mode: BACKUP.DIR_MODE });

    // 起备前先看盘:宁可拒绝开始,也不要写一半把盘撑爆,让别的服务跟着一起挂。
    const free = sr.freeBytesFor(root);
    if (Number.isFinite(free) && free > 0 && free < BACKUP.MIN_FREE_BYTES) {
      out.error = `备份根所在卷可用空间不足:${free} B < 下限 ${BACKUP.MIN_FREE_BYTES} B(${root})`;
      return out;
    }

    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    const createdAt = new Date(nowMs).toISOString();
    const id = mf.makeBackupId(createdAt, crypto.randomBytes(3).toString('hex'));
    if (!id) {
      out.error = '备份集 id 生成失败';
      return out;
    }
    setDir = path.join(root, id);
    if (fs.existsSync(setDir)) {
      out.error = `备份集目录已存在,拒绝覆盖: ${setDir}`;
      return out;
    }
    fs.mkdirSync(setDir, { recursive: true, mode: BACKUP.DIR_MODE });
    out.id = id;
    out.dir = setDir;

    const homes = resolveHomes(opts);
    if (homes.length === 0) {
      out.error = '未解析到任何数据家目录,无可备份内容';
      return out;
    }
    report(`备份 ${id}:已解析 ${homes.length} 个数据家目录,分级 ${tier},开始盘点资产`);

    const entries = [];
    const excluded = [];

    // ── 1) SQLite 热备(F1:只走 VACUUM INTO,绝不拷正在写的 .db)──────────
    const dbDir = path.join(setDir, BACKUP.DB_SUBDIR);
    let sqliteFound = 0;
    for (const home of homes) {
      for (const asset of plan.SQLITE_ASSETS) {
        const src = path.join(home.dir, asset.rel);
        if (!fs.existsSync(src)) {
          continue;
        }
        sqliteFound++;
        // 目标名带家目录角色,避免两个家目录里同名库互相覆盖。
        const targetRel = _posix(path.join(BACKUP.DB_SUBDIR, `${home.role}-${path.basename(asset.rel)}`));
        const targetAbs = path.join(setDir, targetRel);
        report(`热备 SQLite ${asset.rel}(${home.role}):VACUUM INTO 进行中`);
        const res = hotCopySqlite(src, targetAbs);
        if (!res.ok) {
          const msg = `SQLite 热备失败 ${home.role}:${asset.rel} — ${res.error}`;
          if (opts.allowPartial) {
            out.warnings.push(msg);
            excluded.push({ path: `${home.role}:${asset.rel}`, reason: `热备失败: ${res.error}` });
            continue;
          }
          out.error = msg;
          return out;
        }
        entries.push(
          mf.makeEntry({
            kind: 'sqlite',
            home: home.role,
            source: src,
            target: targetRel,
            bytes: res.bytes,
            sha256: _sha256File(targetAbs),
            journalMode: res.journalMode,
          })
        );
        report(
          `热备 SQLite ${asset.rel}(${home.role}):完成 ${res.bytes} B,journal=${res.journalMode},完整性 ${res.integrity},耗时 ${res.durationMs} ms`
        );
      }
    }
    if (sqliteFound === 0) {
      out.warnings.push('未发现任何 SQLite 库(khy-quant.db / taskboard.db),该部署可能尚未初始化数据库');
    }

    // ── 2) PostgreSQL(仅 DB_MODE=postgres)────────────────────────────────
    const pgTarget = path.join(dbDir, BACKUP.PG_DUMP_FILENAME);
    const pg = await dumpPostgres(pgTarget, opts);
    if (pg.skipped) {
      excluded.push({ path: 'postgres', reason: pg.reason });
    } else if (!pg.ok) {
      // postgres 模式下 pg_dump 拿不到 = 主库根本没被备份。默认硬失败,不产出一份
      // 看起来成功却缺主库的备份集。
      const msg = `PostgreSQL 备份失败(主库未纳入): ${pg.reason}`;
      if (!opts.allowPartial) {
        out.error = msg;
        return out;
      }
      out.warnings.push(msg);
      excluded.push({ path: 'postgres', reason: pg.reason });
    } else {
      report(`pg_dump 完成:${pg.bytes} B`);
      entries.push(
        mf.makeEntry({
          kind: 'pgdump',
          home: '',
          source: `postgres://${process.env.DB_HOST || 'localhost'}/${process.env.DB_NAME || 'quant_trading'}`,
          target: _posix(path.join(BACKUP.DB_SUBDIR, BACKUP.PG_DUMP_FILENAME)),
          bytes: pg.bytes,
          sha256: _sha256File(pgTarget),
        })
      );
    }

    // ── 2.5) 冷导出(可选)────────────────────────────────────────────────
    //
    // 只在 full 级生效。core 级本来就把 audit/receipts/… 整个剪掉(见
    // backupAssetPlan.FULL_ONLY_DIR_REASONS),此时开冷导出会把 core 备份集
    // 悄悄变大 —— 那与"core = 权威且体积可控"的承诺正好相反。
    //
    // 产出的 coveredHome 是"已被归档、不必再逐文件复制"的家目录相对路径集合。
    // 粒度是**文件**不是目录:窗口过滤按记录判定,一个文件里可能既有冷记录也有
    // 今天刚追加的热记录,按目录短路会静默丢掉后者。详见 coldExportService 顶部。
    const coldOn =
      tier === plan.TIER_FULL &&
      (opts.includeCold === undefined ? COLD_EXPORT.ENABLED : Boolean(opts.includeCold));
    /** @type {Map<string, Set<string>>} role -> 已归档的家目录相对路径 */
    const coveredByRole = new Map();
    if (coldOn) {
      for (const home of homes) {
        let dirNames;
        try {
          dirNames = fs
            .readdirSync(home.dir, { withFileTypes: true })
            .filter((e) => e.isDirectory() && !e.isSymbolicLink())
            .map((e) => e.name);
        } catch {
          // 家目录读不动,后面的逐文件复制会各自记录原因,这里不重复报。
          continue;
        }
        for (const dirName of dirNames) {
          const c = plan.classifyColdDir(dirName, true);
          if (!c.cold) continue;
          report(`冷导出 ${home.role}:${dirName}:扫描中`);
          const res = cold.exportColdDir({
            sourceDir: path.join(home.dir, dirName),
            setDir,
            role: home.role,
            dirName,
            nowMs,
            windowDays: COLD_EXPORT.WINDOW_DAYS,
            dirMode: BACKUP.DIR_MODE,
            fileMode: BACKUP.FILE_MODE,
          });
          if (!res.ok) {
            // 冷导出失败**绝不**升级为整次备份失败:它是一条体积优化路径,
            // 退回逐文件复制就是完整的。但必须留痕,否则下次没人知道它没跑。
            out.warnings.push(`冷导出失败 ${home.role}:${dirName} — ${res.error}`);
            excluded.push({ path: `${home.role}:${dirName}`, reason: `冷导出失败: ${res.error}` });
            continue;
          }
          if (!res.exported) continue;

          entries.push(
            mf.makeEntry({
              kind: 'cold-export',
              home: home.role,
              source: path.join(home.dir, dirName),
              target: res.target,
              bytes: res.bytes,
              sha256: res.sha256,
              compression: 'gzip',
              records: res.records,
              sourceFiles: res.sourceFiles,
              window: { days: COLD_EXPORT.WINDOW_DAYS, untilMs: nowMs },
            })
          );

          let set = coveredByRole.get(home.role);
          if (!set) {
            set = new Set();
            coveredByRole.set(home.role, set);
          }
          for (const rel of res.coveredFiles) set.add(`${dirName}/${rel}`);
          report(
            `冷导出 ${home.role}:${dirName}:完成 ${res.records} 条 / ${res.bytes} B,` +
              `折叠 ${res.coveredFiles.length}/${res.sourceFiles} 个文件,热窗口内保留 ${res.skippedRecent} 条`
          );
        }
      }
    }

    // ── 3) 逐文件复制(JSON / JSONL / 其它状态文件)────────────────────────
    for (const home of homes) {
      const collected = collectHomeFiles(home.dir, home.role, tier, root);
      excluded.push(...collected.excluded);
      // 已整份进冷归档的文件不再复制一遍 —— 同一份数据收两次,备份集就白治了。
      // 留在 excluded 里而不是无声跳过:manifest 必须能解释每一个"没收"的文件。
      const covered = coveredByRole.get(home.role);
      const pending = covered
        ? collected.files.filter((f) => {
            if (!covered.has(f.rel)) return true;
            excluded.push({ path: `${home.role}:${f.rel}`, reason: '已整份并入冷归档(cold-export)' });
            return false;
          })
        : collected.files;
      const total = pending.length;
      report(`复制 ${home.role} 家目录:${total} 个文件待处理`);
      let done = 0;
      let failed = 0;
      for (const f of pending) {
        const targetRel = _posix(path.join(`${BACKUP.HOME_SUBDIR_PREFIX}${home.role}`, f.rel));
        const targetAbs = path.join(setDir, targetRel);
        try {
          fs.mkdirSync(path.dirname(targetAbs), { recursive: true, mode: BACKUP.DIR_MODE });
          // 先拷到临时名再 rename:与 atomicWriteJson 同一原子替换语义,中断不留半个文件。
          const tmp = `${targetAbs}.tmp-${process.pid}`;
          fs.copyFileSync(f.abs, tmp);
          fs.renameSync(tmp, targetAbs);
          const st = fs.statSync(targetAbs);
          entries.push(
            mf.makeEntry({
              kind: 'file',
              home: home.role,
              source: f.abs,
              target: targetRel,
              bytes: st.size,
              sha256: _sha256File(targetAbs),
            })
          );
        } catch (err) {
          // 单个文件拷不动(被独占/权限)不该毁掉整份备份,但必须留痕。
          failed++;
          excluded.push({
            path: `${home.role}:${f.rel}`,
            reason: `复制失败: ${String((err && err.code) || (err && err.message) || err)}`,
          });
        }
        done++;
        if (done % 200 === 0 || done === total) {
          report(`复制 ${home.role} 家目录:已完成 ${done}/${total}${failed ? `,失败 ${failed}` : ''}`);
        }
      }
      if (failed) {
        out.warnings.push(`${home.role} 家目录有 ${failed} 个文件复制失败(详见 manifest.excluded)`);
      }
    }

    // ── 4) manifest 先写,.complete 最后写 ────────────────────────────────
    const manifest = mf.buildManifest({
      schemaVersion: BACKUP.MANIFEST_SCHEMA_VERSION,
      id,
      createdAt,
      tier,
      note: opts.note || '',
      khyVersion: _khyVersion(),
      platform: `${process.platform}-${process.arch}`,
      nodeVersion: process.version,
      sqliteDriver: _sqliteDriverName(),
      dbMode: String(process.env.DB_MODE || process.env.DB_TYPE || 'auto'),
      dataHomes: homes.reduce((acc, h) => {
        acc[h.role] = h.dir;
        return acc;
      }, {}),
      entries,
      excluded,
      containsSecrets: true,
      restoreHints: plan.restoreHints(),
    });

    const check = mf.validateManifest(manifest);
    if (!check.ok) {
      out.error = `manifest 自校验失败: ${check.errors.join('; ')}`;
      return out;
    }
    const manifestPath = path.join(setDir, BACKUP.MANIFEST_FILENAME);
    if (!atomicWriteJson(manifestPath, manifest, { mode: BACKUP.FILE_MODE })) {
      out.error = `manifest 写入失败: ${manifestPath}`;
      return out;
    }
    // .complete 是「这份可用」的唯一判据,必须在 manifest 之后。
    const markerPath = path.join(setDir, BACKUP.COMPLETE_MARKER);
    if (!atomicWriteJson(markerPath, { id, completedAt: new Date(Date.now()).toISOString() }, { mode: BACKUP.FILE_MODE })) {
      out.error = `完成标记写入失败: ${markerPath}`;
      return out;
    }

    out.manifest = manifest;
    out.ok = true;
    report(
      `备份 ${id}:完成 ${entries.length} 项 / ${manifest.totalBytes} B,排除 ${excluded.length} 项,落盘 ${setDir}`
    );
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  } finally {
    // 失败即不留残骸:一个没有 .complete 的目录虽然会被 list 标 BROKEN,但主动清掉更干净。
    if (!out.ok && setDir) {
      try {
        fs.rmSync(setDir, { recursive: true, force: true });
      } catch {
        /* 清不掉就留给 prune,它会优先处理 BROKEN */
      }
    }
  }
}

// ── list ─────────────────────────────────────────────────────────────────

/**
 * 列出备份集,按时间倒序。
 * @param {object} [opts]
 * @returns {{root: string, sets: Array<object>}}
 */
function listBackups(opts = {}) {
  const root = resolveBackupRoot(opts);
  const sets = [];
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return { root, sets };
  }
  for (const name of names) {
    const parsed = mf.parseBackupId(name);
    if (!parsed.ok) {
      continue; // 不是备份集目录,别乱认
    }
    const dir = path.join(root, name);
    const complete = fs.existsSync(path.join(dir, BACKUP.COMPLETE_MARKER));
    const manifest = _readJson(path.join(dir, BACKUP.MANIFEST_FILENAME));
    sets.push({
      id: name,
      dir,
      complete,
      createdAt: manifest && manifest.createdAt ? manifest.createdAt : new Date(parsed.timeMs).toISOString(),
      timeMs: parsed.timeMs,
      tier: manifest && manifest.tier ? manifest.tier : 'unknown',
      note: manifest && manifest.note ? manifest.note : '',
      entryCount: manifest && Array.isArray(manifest.entries) ? manifest.entries.length : 0,
      totalBytes: manifest && Number.isFinite(Number(manifest.totalBytes)) ? Number(manifest.totalBytes) : 0,
      containsSecrets: !!(manifest && manifest.containsSecrets),
      manifest,
    });
  }
  sets.sort((a, b) => b.timeMs - a.timeMs || (a.id < b.id ? 1 : -1));
  return { root, sets };
}

/** 解析 id:'--latest' / 空 → 最新一份**完好**备份。 */
function resolveSetId(idOrLatest, opts = {}) {
  const { sets } = listBackups(opts);
  const wanted = String(idOrLatest || '').trim();
  if (!wanted || wanted === '--latest' || wanted === 'latest') {
    const newest = sets.find((s) => s.complete);
    return newest ? newest.id : '';
  }
  const hit = sets.find((s) => s.id === wanted);
  return hit ? hit.id : '';
}

// ── verify ───────────────────────────────────────────────────────────────

/**
 * 校验一份备份:`.complete` 存在 + manifest 结构合法 + 每个 entry 的 sha256 与字节数吻合。
 * @param {string} id
 * @param {object} [opts]
 * @returns {{ok: boolean, id: string, checked: number, problems: string[], error: string|null}}
 */
function verifyBackup(id, opts = {}) {
  const out = { ok: false, id: String(id || ''), checked: 0, problems: [], error: null };
  try {
    const root = resolveBackupRoot(opts);
    const setId = resolveSetId(id, opts);
    if (!setId) {
      out.error = `找不到备份集: ${String(id || '--latest')}`;
      return out;
    }
    out.id = setId;
    const dir = path.join(root, setId);

    if (!fs.existsSync(path.join(dir, BACKUP.COMPLETE_MARKER))) {
      out.problems.push('缺少 .complete 标记 —— 该备份写入未完成,不可用于恢复');
    }
    const manifest = _readJson(path.join(dir, BACKUP.MANIFEST_FILENAME));
    if (!manifest) {
      out.error = `manifest 缺失或不可解析: ${path.join(dir, BACKUP.MANIFEST_FILENAME)}`;
      return out;
    }
    const structural = mf.validateManifest(manifest);
    if (!structural.ok) {
      out.problems.push(...structural.errors.map((e) => `manifest 结构: ${e}`));
    }
    for (const e of Array.isArray(manifest.entries) ? manifest.entries : []) {
      const abs = path.join(dir, String((e && e.target) || '').split('/').join(path.sep));
      out.checked++;
      if (!fs.existsSync(abs)) {
        out.problems.push(`文件缺失: ${e.target}`);
        continue;
      }
      const size = fs.statSync(abs).size;
      if (size !== Number(e.bytes)) {
        out.problems.push(`字节数不符: ${e.target}(清单 ${e.bytes} B,实际 ${size} B)`);
        continue;
      }
      const digest = _sha256File(abs);
      if (digest !== String(e.sha256)) {
        out.problems.push(`sha256 不符: ${e.target}`);
      }
    }
    out.ok = out.problems.length === 0;
    return out;
  } catch (err) {
    out.error = String((err && err.message) || err || '未知错误').split('\n')[0];
    return out;
  }
}

// ── prune ────────────────────────────────────────────────────────────────

/**
 * 按保留策略清理。求解在 backupManifest.planRetention(纯叶子,可单测);本函数只删。
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun]
 * @returns {{root: string, kept: string[], dropped: Array<{id: string, reason: string, removed: boolean}>}}
 */
function pruneBackups(opts = {}) {
  const { root, sets } = listBackups(opts);
  const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
  const decision = mf.planRetention(
    sets.map((s) => ({ id: s.id, complete: s.complete })),
    {
      keepCount: Number.isFinite(Number(opts.keepCount)) ? Number(opts.keepCount) : BACKUP.KEEP_COUNT,
      keepDays: Number.isFinite(Number(opts.keepDays)) ? Number(opts.keepDays) : BACKUP.KEEP_DAYS,
      nowMs,
    }
  );
  const dropped = [];
  for (const d of decision.drop) {
    if (opts.dryRun) {
      dropped.push({ ...d, removed: false });
      continue;
    }
    let removed = false;
    try {
      fs.rmSync(path.join(root, d.id), { recursive: true, force: true });
      removed = true;
    } catch {
      removed = false;
    }
    dropped.push({ ...d, removed });
  }
  return { root, kept: decision.keep, dropped };
}

module.exports = {
  resolveBackupRoot,
  resolveHomes,
  collectHomeFiles,
  dumpPostgres,
  createBackup,
  listBackups,
  resolveSetId,
  verifyBackup,
  pruneBackups,
  _sha256File,
};
